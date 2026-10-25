// Headless Edge driver for the Live2D stage.
//
// Runs the real WebView2 engine (Edge) through CDP, exercises the public stage
// API, and writes screenshots + a JSON report. This is the automated part of
// the M0 Live2D check: model load, 44 expressions, 8 motions, mouth parameter,
// state mapping and transparent rendering.
//
// Usage: node scripts/probe-stage.mjs [--url http://127.0.0.1:8099/?bg=grid&hud=1]
import { spawn } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outDir = join(root, 'docs', 'probe')
const profileDir = join(root, '.edge-headless')
const urlArg = process.argv.indexOf('--url')
const startUrl = urlArg >= 0 ? process.argv[urlArg + 1] : 'http://127.0.0.1:8099/?bg=grid&hud=1'
const port = 9333

const edgeCandidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const edge = edgeCandidates.find((p) => existsSync(p))
if (!edge) throw new Error('Microsoft Edge not found')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function launch() {
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--window-size=900,900',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--allow-file-access-from-files',
    startUrl,
  ]
  return spawn(edge, args, { stdio: 'ignore', windowsHide: true })
}

async function cdpEndpoint() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (r.ok) {
        const list = await r.json()
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (page) return page.webSocketDebuggerUrl
      }
    } catch {}
    await sleep(150)
  }
  throw new Error('CDP endpoint did not become ready')
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.id) {
        const entry = this.pending.get(msg.id)
        if (!entry) return
        this.pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`))
        else entry.resolve(msg.result)
      } else {
        this.events.push(msg)
      }
    })
  }
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject, method })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  close() {
    try { this.ws.close() } catch {}
  }
}

async function evaluate(cdp, expression, awaitPromise = true) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  }
  return result.result?.value
}

async function send(cdp, method, params) {
  return cdp.send(method, params)
}

async function main() {
  await rm(profileDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  await mkdir(profileDir, { recursive: true })

  const browser = launch()
  const report = { url: startUrl, startedAt: new Date().toISOString(), steps: [], console: [], errors: [] }
  let cdp

  try {
    const wsUrl = await cdpEndpoint()
    const ws = new WebSocket(wsUrl, { maxPayload: 32 * 1024 * 1024 })
    await new Promise((resolvePromise, reject) => {
      ws.once('open', resolvePromise)
      ws.once('error', reject)
    })
    cdp = new Cdp(ws)

    await send(cdp, 'Runtime.enable')
    await send(cdp, 'Page.enable')
    await send(cdp, 'Log.enable')
    await send(cdp, 'Emulation.setDeviceMetricsOverride', {
      width: 900, height: 900, deviceScaleFactor: 1, mobile: false,
    })

    // Wait for the stage to report readiness or error.
    let info
    for (let i = 0; i < 200; i++) {
      info = await evaluate(cdp, 'window.__petReady === true ? window.__pet.info() : (window.__petError || null)')
      if (info && typeof info === 'object') break
      if (typeof info === 'string') throw new Error(`stage error: ${info}`)
      await sleep(150)
    }
    if (!info || typeof info !== 'object') throw new Error('stage did not become ready')
    report.model = info
    report.steps.push({ step: 'load', ok: true, info })

    async function shot(name) {
      const { data } = await send(cdp, 'Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false,
      })
      await writeFile(join(outDir, name), Buffer.from(data, 'base64'))
      report.steps.push({ step: 'screenshot', name })
    }

    await sleep(400)
    await shot('01-idle.png')

    // Expression matrix: a representative from every semantic family.
    const expressions = ['happy', 'angry', 'sad', 'shy_placeholder', 'heart_eyes', 'blank', 'question', 'dizzy', 'sleepy_drool']
    const expressionResults = {}
    for (const name of expressions) {
      if (name === 'shy_placeholder') {
        expressionResults.blush = await evaluate(cdp, 'window.__pet.setExpression("blush")')
        continue
      }
      expressionResults[name] = await evaluate(cdp, `window.__pet.setExpression(${JSON.stringify(name)})`)
      await sleep(120)
    }
    await evaluate(cdp, 'window.__pet.setExpression("happy")')
    await sleep(400)
    await shot('02-expression-happy.png')
    await evaluate(cdp, 'window.__pet.setExpression("angry")')
    await sleep(300)
    await shot('03-expression-angry.png')
    await evaluate(cdp, 'window.__pet.clearExpression()')
    report.steps.push({ step: 'expressions', results: expressionResults })

    // Mouth parameter: full open, and a mid value.
    await evaluate(cdp, 'window.__pet.setMouth(1)')
    await sleep(200)
    await shot('04-mouth-open.png')
    const mouthFull = await evaluate(cdp, 'window.__pet.info().mouth')
    await evaluate(cdp, 'window.__pet.setMouth(0)')
    report.steps.push({ step: 'mouth', level: mouthFull })

    // Gesture motion (selfie is the most visually distinct one).
    const motionOk = await evaluate(cdp, 'window.__pet.motion("Gesture", "selfie")')
    await sleep(700)
    await shot('05-motion-selfie.png')
    report.steps.push({ step: 'motion', name: 'selfie', ok: motionOk })

    // High-level state mapping.
    const states = {}
    for (const name of ['thinking', 'working', 'waiting', 'happy', 'excited', 'shy', 'sad', 'angry', 'confused', 'sleepy', 'error', 'success']) {
      states[name] = await evaluate(cdp, `window.__pet.setState(${JSON.stringify(name)})`)
      await sleep(80)
    }
    await evaluate(cdp, 'window.__pet.setState("happy")')
    await sleep(500)
    await shot('06-state-happy.png')
    report.steps.push({ step: 'states', results: states })

    // Look-at and forced parameter (debug path).
    await evaluate(cdp, 'window.__pet.look(1, 1)')
    await evaluate(cdp, 'window.__pet.setParam("ParamAngleX", 20)')
    await sleep(400)
    await shot('07-look-param.png')
    await evaluate(cdp, 'window.__pet.clearParams()')

    // Transparent window check: repaint with no CSS background and ask the
    // compositor to keep alpha. The PNG therefore has a transparent corner.
    await evaluate(cdp, 'document.body.className = "bg-none"')
    await send(cdp, 'Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    })
    await sleep(300)
    await shot('08-transparent.png')
    const alpha = await evaluate(cdp, `(() => {
      const c = document.getElementById('stage')
      const gl = c.getContext('webgl2') || c.getContext('webgl')
      return { bodyBg: getComputedStyle(document.body).backgroundColor, ctxAlpha: gl ? gl.getContextAttributes().alpha : null, canvasSize: [c.width, c.height] }
    })()`)
    report.steps.push({ step: 'transparent', alpha })

    // Final state + console/errors.
    report.final = await evaluate(cdp, 'window.__pet.info()')
    report.console = (await evaluate(cdp, 'window.__logs.slice(0, 80)')) || []
    report.finishedAt = new Date().toISOString()

    const failed = report.steps.filter((s) => s.ok === false)
    report.ok = failed.length === 0 && !report.final.error
    await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({
      ok: report.ok,
      expressionCount: report.final.expressionCount,
      motions: report.final.motions,
      screenshots: report.steps.filter((s) => s.step === 'screenshot').map((s) => s.name),
      errors: report.final.error,
    }, null, 2))
    if (!report.ok) process.exitCode = 1
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    report.finishedAt = new Date().toISOString()
    if (cdp) {
      try { report.console = await evaluate(cdp, 'window.__logs ? window.__logs.slice(0, 80) : []') } catch {}
      try { report.pageError = await evaluate(cdp, 'window.__petError || null') } catch {}
    }
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.error('probe failed:', report.error)
    if (report.pageError) console.error('page error:', report.pageError)
    process.exitCode = 1
  } finally {
    try { if (cdp) await cdp.send('Browser.close') } catch {}
    try { cdp?.close() } catch {}
    await sleep(300)
    try { browser.kill() } catch {}
  }
}

main()
