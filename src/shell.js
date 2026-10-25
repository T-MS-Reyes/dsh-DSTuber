import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const MAX_RESTARTS = 5

/**
 * Owns the Tauri shell process.
 *
 * The shell is a child of the DSH Host, not an independent app: this
 * supervisor starts it when the plugin activates (so a DSH restart brings the
 * pet back), replaces an orphan from a previous Host generation through a pid
 * file, restarts it with backoff after a crash, and kills the process tree on
 * plugin disposal / DSH exit.
 */
export function createShellSupervisor({ getConfig, log = console, onClosed = null }) {
  const dataDir = join(packageRoot, '.webview2')
  const tempDir = join(packageRoot, '.tmp')
  const pidFile = join(dataDir, 'shell.pid')
  const closedFlag = join(dataDir, 'closed')
  const autostartFile = join(dataDir, 'autostart.json')

  let child = null
  let restartTimer = null
  let attempts = 0
  let disposed = false
  // Set while an owner-initiated stop kills the process: its exit must not be
  // mistaken for a crash and auto-restarted.
  let stopping = false
  let stageUrl = ''
  let lastError = null

  const shellConfig = () => getConfig()?.shell ?? {}

  // The settings window writes this flag; a missing file falls back to the
  // plugin config, so a fresh install still autostarts.
  function autoStartEnabled() {
    try {
      const value = JSON.parse(readFileSync(autostartFile, 'utf8'))
      if (typeof value.enabled === 'boolean') return value.enabled
    } catch {}
    return shellConfig().autoStart !== false
  }

  function executablePath() {
    const candidates = [
      shellConfig().executable,
      join(packageRoot, 'shell', 'src-tauri', 'target', 'release', 'dsh-dstuber-shell.exe'),
      join(packageRoot, 'shell', 'src-tauri', 'target', 'debug', 'dsh-dstuber-shell.exe'),
    ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0)
    return candidates.find((candidate) => existsSync(candidate)) ?? null
  }

  function alive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  function killTree(pid) {
    if (!pid) return
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch (error) {
      log.warn?.(`[dsh-dstuber] taskkill failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function readPid() {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      return Number.isFinite(pid) && pid > 0 ? pid : null
    } catch {
      return null
    }
  }

  function writePid(pid) {
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(pidFile, String(pid))
    } catch (error) {
      log.warn?.(`[dsh-dstuber] cannot write shell pid file: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function clearPid() {
    try {
      rmSync(pidFile, { force: true })
    } catch {}
  }

  async function clearOrphan() {
    const pid = readPid()
    if (!pid) return
    if (alive(pid)) {
      log.info?.(`[dsh-dstuber] replacing previous shell pid=${pid}`)
      killTree(pid)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    clearPid()
  }

  function scheduleRestart() {
    if (disposed || restartTimer || attempts >= MAX_RESTARTS) return
    if (shellConfig().restart === false) return
    const delay = Math.min(5000, 500 * 2 ** attempts)
    attempts += 1
    restartTimer = setTimeout(() => {
      restartTimer = null
      spawnShell()
    }, delay)
    restartTimer.unref?.()
    log.info?.(`[dsh-dstuber] shell restart in ${delay}ms (attempt ${attempts}/${MAX_RESTARTS})`)
  }

  function spawnShell() {
    if (disposed) return
    stopping = false
    const executable = executablePath()
    if (!executable) {
      lastError = 'shell executable not found'
      log.warn?.('[dsh-dstuber] shell executable not found; build it with scripts/build-shell.ps1')
      return
    }
    if (!stageUrl) {
      lastError = 'stage URL unavailable'
      log.warn?.('[dsh-dstuber] stage URL unavailable; shell not started')
      return
    }

    try {
      mkdirSync(dataDir, { recursive: true })
      mkdirSync(tempDir, { recursive: true })
    } catch (error) {
      lastError = `cannot create shell data dirs: ${error instanceof Error ? error.message : String(error)}`
      log.warn?.(`[dsh-dstuber] ${lastError}`)
      return
    }

    const env = {
      ...process.env,
      DSH_DSTUBER_STAGE_URL: stageUrl,
      DSH_DSTUBER_DATA_DIR: dataDir,
      WEBVIEW2_USER_DATA_FOLDER: dataDir,
      TEMP: tempDir,
      TMP: tempDir,
    }

    try {
      child = spawn(executable, [], {
        cwd: packageRoot,
        env,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      log.warn?.(`[dsh-dstuber] shell spawn failed: ${lastError}`)
      scheduleRestart()
      return
    }

    if (!child || !child.pid) {
      lastError = 'shell spawn returned no pid'
      child = null
      scheduleRestart()
      return
    }

    const pid = child.pid
    writePid(pid)
    lastError = null
    log.info?.(`[dsh-dstuber] shell started pid=${pid} exe=${executable}`)

    // A shell that stays alive for 30s resets the crash budget.
    const steady = setTimeout(() => {
      attempts = 0
    }, 30000)
    steady.unref?.()

    child.once('error', (error) => {
      lastError = error instanceof Error ? error.message : String(error)
      log.warn?.(`[dsh-dstuber] shell error: ${lastError}`)
    })

    child.once('exit', (code, signal) => {
      clearTimeout(steady)
      if (child?.pid === pid) child = null
      clearPid()
      log.info?.(`[dsh-dstuber] shell exited code=${code} signal=${signal}`)
      // The shell writes this flag when the user picks "本次关闭"; honor it
      // instead of immediately resurrecting the pet.
      if (existsSync(closedFlag)) {
        try {
          rmSync(closedFlag, { force: true })
        } catch {}
        log.info?.('[dsh-dstuber] shell closed by user; auto-restart suppressed')
        // Quitting the pet must stop its services (voice worker, GSV engine)
        // while keeping every data file on disk.
        try {
          onClosed?.()
        } catch (error) {
          log.warn?.(`[dsh-dstuber] shell close cleanup failed: ${String(error).slice(0, 120)}`)
        }
        return
      }
      // An owner-initiated stop killed this process on purpose; do not treat
      // that exit as a crash and resurrect the pet behind the owner's back.
      if (stopping) {
        stopping = false
        return
      }
      if (!disposed) scheduleRestart()
    })
  }

  function start({ url = '', manual = false } = {}) {
    if (disposed) return
    if (url) stageUrl = url
    if (!stageUrl) {
      log.warn?.('[dsh-dstuber] shell start skipped: no stage URL')
      return
    }
    // autoStart only governs automatic launches; an explicit "start the pet"
    // from the settings card must work even when autoStart is off.
    if (!manual && !autoStartEnabled()) {
      log.info?.('[dsh-dstuber] shell autoStart disabled')
      return
    }
    if (child) return
    // A new Host generation (DSH restart / plugin reload) clears the previous
    // "closed for this session" marker.
    try {
      rmSync(closedFlag, { force: true })
    } catch {}
    void clearOrphan().then(() => {
      if (!disposed && !child) spawnShell()
    })
  }

  /** Stop the running shell but stay startable (quit → start must work). */
  function stop() {
    stopping = true
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    attempts = 0
    if (child?.pid) killTree(child.pid)
    child = null
    clearPid()
  }

  /** Permanent teardown for plugin unload; a later start() is refused. */
  function dispose() {
    disposed = true
    stop()
  }

  function status() {
    return {
      autoStart: autoStartEnabled(),
      running: !!child,
      pid: child?.pid ?? null,
      exe: executablePath(),
      stageUrl,
      attempts,
      lastError,
    }
  }

  return { start, stop, dispose, status }
}
