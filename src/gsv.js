import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'

/**
 * GPT-SoVITS service launcher.
 *
 * The engine is a separate local Python service, so the plugin never bundles it:
 * this module starts and stops the user's own installation (with a writable
 * TEMP, which torch/dill need), reports readiness, and cleans the process tree
 * when the plugin unloads. Everything is best-effort: a missing installation
 * surfaces as a status error instead of breaking the pet.
 */
const DEFAULT_APP_CANDIDATES = [
  'D:/GPT-SoVITS-v2pro-20250604/GPT-SoVITS-v2pro-20250604',
  'D:/GPT-SoVITS-v2pro-20250604',
  'D:/GPT-SoVITS',
  'C:/GPT-SoVITS',
]

function portOpen(port, timeout = 700) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export function createGsvService({ dataDir, log = console, getVoiceSettings = () => ({}) }) {
  const configPath = join(dataDir, 'gsv.json')
  const tempDir = join(dataDir, 'gsv-temp')
  let child = null
  let starting = false
  let lastError = null
  let lastExit = null

  function readConfig() {
    let stored = {}
    try {
      stored = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {}
    const appDir = typeof stored.appDir === 'string' && stored.appDir
      ? stored.appDir
      : DEFAULT_APP_CANDIDATES.find((dir) => existsSync(join(dir, 'api_v2.py'))) || ''
    let port = 9880
    try {
      const url = new URL(getVoiceSettings()?.gptSovitsUrl || 'http://127.0.0.1:9880')
      port = Number(url.port) || 9880
    } catch {}
    return {
      appDir,
      port,
      python: typeof stored.python === 'string' ? stored.python : '',
      autoStart: stored.autoStart === true,
    }
  }

  function saveConfig(patch = {}) {
    const current = readConfig()
    const next = {
      ...current,
      ...(typeof patch.appDir === 'string' ? { appDir: patch.appDir.trim() } : {}),
      ...(typeof patch.python === 'string' ? { python: patch.python.trim() } : {}),
      ...(typeof patch.autoStart === 'boolean' ? { autoStart: patch.autoStart } : {}),
    }
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    } catch (error) {
      log.warn?.(`[dsh-dstuber] gsv config write failed: ${String(error).slice(0, 120)}`)
    }
    return next
  }

  function pythonPath(config) {
    if (config.python && existsSync(config.python)) return config.python
    if (config.appDir) {
      const bundled = join(config.appDir, 'runtime', 'python.exe')
      if (existsSync(bundled)) return bundled
    }
    return 'python'
  }

  async function status() {
    const config = readConfig()
    const running = await portOpen(config.port)
    return {
      appDir: config.appDir,
      python: pythonPath(config),
      port: config.port,
      url: `http://127.0.0.1:${config.port}`,
      running,
      starting,
      pid: child?.pid ?? null,
      tempDir,
      error: lastError,
      lastExit,
      autoStart: config.autoStart,
    }
  }

  async function start() {
    const config = readConfig()
    if (!config.appDir) {
      lastError = '未找到 GPT-SoVITS 安装目录'
      return { ok: false, error: 'app-dir-missing' }
    }
    const apiPath = join(config.appDir, 'api_v2.py')
    if (!existsSync(apiPath)) {
      lastError = `缺少 api_v2.py：${apiPath}`
      return { ok: false, error: 'api-missing' }
    }
    if (await portOpen(config.port)) {
      lastError = null
      return { ok: true, alreadyRunning: true, port: config.port }
    }
    if (child) return { ok: true, starting: true, pid: child.pid }

    try {
      mkdirSync(tempDir, { recursive: true })
    } catch (error) {
      lastError = `无法创建临时目录：${String(error).slice(0, 120)}`
      return { ok: false, error: 'temp-dir' }
    }
    const python = pythonPath(config)
    try {
      child = spawn(python, [apiPath, '-a', '127.0.0.1', '-p', String(config.port)], {
        cwd: config.appDir,
        env: {
          ...process.env,
          // torch/dill need a writable TEMP; the OS default is often read-only
          // for this process tree.
          TEMP: tempDir,
          TMP: tempDir,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      lastError = String(error)
      return { ok: false, error: 'spawn-failed' }
    }
    starting = true
    lastError = null
    lastExit = null
    child.stdout?.on('data', (chunk) => {
      const line = String(chunk).trim()
      if (line) log.info?.(`[gsv] ${line.slice(0, 240)}`)
    })
    child.stderr?.on('data', (chunk) => {
      const line = String(chunk).trim()
      if (line) log.info?.(`[gsv] ${line.slice(0, 240)}`)
    })
    child.on('exit', (code) => {
      starting = false
      lastExit = code
      child = null
      log.info?.(`[dsh-dstuber] gsv service exited (${code ?? 'signal'})`)
    })
    child.on('error', (error) => {
      starting = false
      lastError = String(error)
      child = null
    })
    return { ok: true, starting: true, port: config.port, pid: child.pid, python }
  }

  async function stop() {
    const current = child
    if (current?.pid) {
      try {
        spawn('taskkill', ['/PID', String(current.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch (error) {
        log.warn?.(`[dsh-dstuber] gsv taskkill failed: ${String(error).slice(0, 120)}`)
      }
      child = null
    }
    starting = false
    return { ok: true, stopped: !!current }
  }

  return { status, start, stop, readConfig, saveConfig, dispose: stop }
}
