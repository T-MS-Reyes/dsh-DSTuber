// dsh-dstuber Live2D stage.
//
// Rendered in a WebView2/Tauri window or a plain browser during development.
// It intentionally has no framework: the desktop shell owns the window, the
// Host owns state, and this file owns everything that touches Cubism.
(() => {
  'use strict'

  const params = new URLSearchParams(location.search)
  const bg = params.get('bg') || 'grid'
  // Kept on window: the streaming/diagnostic callbacks below ran in a scope
  // where the IIFE constant was not visible, and a hard failure there broke the
  // whole stage. A window property is always reachable.
  window.STAGE_BUILD = '2026-10-25-c'
  if (bg !== 'none') document.body.classList.add('bg-grid')

  const canvas = document.getElementById('stage')
  const hud = document.getElementById('hud')
  const hudState = document.getElementById('hud-state')
  const hudExpression = document.getElementById('hud-expression')
  const hudMotion = document.getElementById('hud-motion')
  const hudMouth = document.getElementById('hud-mouth')
  const hudFps = document.getElementById('hud-fps')
  const hudModel = document.getElementById('hud-model')
  const errorBox = document.getElementById('error')
  const hint = document.getElementById('hint')
  // The stage HUD is a development surface only. Production windows (page
  // overlay / desktop pet) pass no `hud` and therefore stay clean.
  if (params.get('hud') === '1') hud.hidden = false
  if (params.get('hud') !== '1' && hint) hint.hidden = true

  const state = {
    ready: false,
    error: null,
    manifest: null,
    model: null,
    expression: '-',
    motion: '-',
    mouth: 0,
    appliedMouth: 0,
    mouthParamIndex: -1,
    reducedMotion: false,
    viewport: null,
    tauriError: null,
    loadMs: null,
    report: null,
    forced: new Map(),
    mouthParam: 'ParamMouthOpenY',
    mouthRange: 2.1,
    framing: null,
    profileLoaded: false,
    doubleClickExpression: true,
    fps: 0,
  }
  window.__petState = state
  window.__logs = []

  // Idle performer + lip sync. Parameter names are filled from the model
  // profile once it loads; until then the standard Cubism names are assumed.
  const performer = window.DSPerformer
    ? window.DSPerformer.create({ reducedMotion: state.reducedMotion })
    : null
  window.__petPerformer = performer

  async function loadModelProfile() {
    try {
      const response = await fetch(new URL('../api/model/profile', location.href), { cache: 'no-store' })
      if (!response.ok) return null
      const value = await response.json().catch(() => null)
      return value?.profile || null
    } catch {
      return null
    }
  }

  const log = (...args) => {
    window.__logs.push(args.map((v) => (v instanceof Error ? `${v.name}: ${v.message}` : String(v))).join(' '))
    // Keep the diagnostic ring bounded; this window lives for days.
    if (window.__logs.length > 200) window.__logs.splice(0, window.__logs.length - 200)
    console.log('[stage]', ...args)
  }

  function showError(error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error)
    state.error = text
    window.__petError = text
    errorBox.hidden = false
    errorBox.textContent = `Live2D stage failed\n\n${text}`
    log('ERROR', error)
  }

  function setText(el, value) {
    if (el.textContent !== String(value)) el.textContent = String(value)
  }

  window.addEventListener('error', (event) => showError(event.error || event.message))
  window.addEventListener('unhandledrejection', (event) => showError(event.reason))

  async function main() {
    if (!window.PIXI || !PIXI.live2d || !PIXI.live2d.Live2DModel) {
      throw new Error('PIXI / pixi-live2d-display did not load (check vendor script order)')
    }
    if (typeof Live2DCubismCore === 'undefined') {
      throw new Error('Live2DCubismCore did not load (Cubism Core JS missing or too old)')
    }

    // Resolved against the stage directory so the same page works both from
    // the dev server (/) and from the Host (/plugins/dsh-dstuber/stage/).
    const modelUrl = params.get('model') || new URL('../model/model3.augmented.json', location.href).href
    const manifestUrl = new URL('manifest.json', new URL(modelUrl, location.href)).href
    const loadStart = performance.now()

    const app = new PIXI.Application({
      view: canvas,
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight),
      transparent: true,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoStart: true,
      preserveDrawingBuffer: true,
    })
    app.renderer.backgroundColor = 0x000000
    app.renderer.backgroundAlpha = 0
    app.renderer.resize(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight))

    const manifest = await fetch(manifestUrl, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    state.manifest = manifest
    if (manifest) {
      state.mouthParam = manifest.lipSyncParam || state.mouthParam
      state.mouthRange = Number(manifest.mouthRange) || state.mouthRange
      setText(hudModel, `${manifest.name || 'model'} · ${manifest.expressions?.length || 0} 表情 / ${manifest.motions?.Idle?.length + manifest.motions?.Gesture?.length || 8} 动作`)
    }

    let modelProfile = null
    // Temporary expression from a double click on the pet.
    let randomExpression = { switches: [], until: 0, name: null }
    if (performer) {
      const profile = await loadModelProfile()
      modelProfile = profile
      if (profile) {
        performer.setProfile(profile)
        state.profileLoaded = true
        state.mouthParam = performer.params.mouth || state.mouthParam
        state.mouthRange = performer.params.mouthRange || state.mouthRange
        if (profile.framing && typeof profile.framing === 'object') {
          state.framing = profile.framing
        }
        log('performer profile', profile.modelKey || profile.name, Object.keys(profile.capabilities || {}).join(','))
      }
      // A global display preference wins over the model default: the owner may
      // want a full-body pet even when the model is framed as a bust.
      try {
        const response = await fetch(new URL('../api/display', location.href), { cache: 'no-store' })
        if (response.ok) {
          const value = await response.json().catch(() => null)
          const mode = value?.display?.framing
          if (mode === 'full' || mode === 'bust') {
            state.framing = { ...(state.framing || {}), mode }
          }
          if (typeof value?.display?.doubleClickExpression === 'boolean') {
            state.doubleClickExpression = value.display.doubleClickExpression
          }
        }
      } catch {}
    }

    log('loading model', modelUrl)
    const model = await PIXI.live2d.Live2DModel.from(modelUrl, { autoInteract: false })
    state.model = model
    app.stage.addChild(model)

    // Keep the whole character visible and re-fit only after the renderer has
    // actually adopted the new window size. `resizeTo: window` races with
    // Tauri's set_size: fitting with the old screen size leaves the model
    // clipped or off-canvas after a shrink.
    let resizeTimer = null

    function fit() {
      if (!model) return
      const w = app.screen.width
      const h = app.screen.height
      if (!w || !h) return
      model.scale.set(1)
      const baseW = Number(model.width)
      const baseH = Number(model.height)
      if (!Number.isFinite(baseW) || !Number.isFinite(baseH) || baseW < 1 || baseH < 1) return
      const full = Math.min((w * 0.94) / baseW, (h * 0.94) / baseH)
      const framing = state.framing || { mode: 'full' }
      let scale = full
      let x = w / 2
      let y = h / 2
      if (framing.mode === 'bust') {
        // A full-body model keeps the face too small for lip sync or
        // expressions to read; the bust framing hugs the window top instead.
        scale = full * (Number(framing.zoom) || 2.7)
        const height = baseH * scale
        y = height / 2 - (Number(framing.topGap) || 10)
      }
      model.scale.set(scale)
      model.anchor.set(0.5, 0.5)
      model.position.set(x, y)
      state.viewport = { width: w, height: h, scale, framing: framing.mode }
    }

    function resizeStage() {
      const w = Math.max(1, Math.floor(window.innerWidth || document.documentElement.clientWidth || 1))
      const h = Math.max(1, Math.floor(window.innerHeight || document.documentElement.clientHeight || 1))
      try {
        app.renderer.resize(w, h)
      } catch (error) {
        log('renderer resize failed', error)
      }
      fit()
    }

    function scheduleResize() {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        requestAnimationFrame(resizeStage)
      }, 40)
    }

    resizeStage()
    window.addEventListener('resize', scheduleResize)

    // Models that ship .motion3 files get their own animation played by the
    // stage (idle loop, talk while speaking, occasional gestures); the performer
    // then only writes mouth + expression. Models without motions keep the
    // procedural idle (breathing, gaze, occasional glances).
    const motionPlan = modelProfile?.motionPlan || null
    if (performer && motionPlan) {
      performer.setMotionMode(true)
      const playGroup = (kind, priority) => {
        if (!state.model) return false
        let groupName = null
        if (kind === 'gestures') {
          const list = motionPlan.gestures || []
          if (list.length === 0) return false
          groupName = list[Math.floor(Math.random() * list.length)]
        } else {
          groupName = motionPlan[kind]
        }
        if (!groupName) return false
        const list = motionPlan.groups?.[groupName] || []
        if (list.length === 0) return false
        const index = Math.floor(Math.random() * list.length)
        state.model.motion(groupName, index, priority).catch(() => {})
        return true
      }
      window.__petMotion = { plan: motionPlan, play: playGroup }
      const idleEntries = motionPlan.groups?.[motionPlan.idle] || []
      if (idleEntries.length > 0) {
        void (async () => {
          let index = 0
          while (state.model) {
            let finished = false
            try {
              finished = await state.model.motion(motionPlan.idle, index, MotionPriority.IDLE)
            } catch {
              break
            }
            if (finished === false) break
            index = (index + 1) % idleEntries.length
          }
        })()
        log('motion idle loop', motionPlan.idle, idleEntries.length)
      }
      if (motionPlan.gestures.length > 0) {
        setInterval(() => {
          playGroup('gestures', MotionPriority.NORMAL)
        }, 14000 + Math.random() * 10000)
      }
    }

    // Let the host see what this window actually runs (framing, profile,
    // performer) so a framing regression is diagnosable without devtools.
    void fetch(new URL('../api/stage-report', location.href), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'boot',
        build: window.STAGE_BUILD,
        framing: state.framing,
        viewport: state.viewport,
        performer: !!performer,
        profileLoaded: !!state.profileLoaded,
        mouthParam: state.mouthParam,
        href: location.href,
        time: Date.now(),
      }),
    }).catch(() => {})
    if (typeof ResizeObserver !== 'undefined') {
      try {
        const observer = new ResizeObserver(() => scheduleResize())
        observer.observe(document.documentElement)
      } catch {}
    }

    // Mouth / forced parameters must win over motions and physics, so they are
    // written in the last event before the core model consumes parameters.
    const core = model.internalModel.coreModel
    const originalBlink = model.internalModel.eyeBlink
    const MotionPriority = PIXI.live2d.MotionPriority || { NONE: 0, IDLE: 1, NORMAL: 2, FORCE: 3 }
    state.mouthParamIndex = -1
    try {
      state.mouthParamIndex = typeof core.getParameterIndex === 'function' ? core.getParameterIndex(state.mouthParam) : -1
    } catch {}
    let lastFrameAt = performance.now()
    model.internalModel.on('beforeModelUpdate', () => {
      const now = performance.now()
      const dt = (now - lastFrameAt) / 1000
      lastFrameAt = now
      if (performer) {
        performer.update(dt)
        performer.apply(core)
        state.mouth = performer.state.mouth
      } else if (state.mouth > 0) {
        core.setParameterValueById(state.mouthParam, state.mouth * state.mouthRange)
      }
      // A double-click expression overrides the artist switches for a moment;
      // once it expires the frame simply stops writing them.
      if (randomExpression.until > Date.now()) {
        for (const sw of randomExpression.switches) {
          try {
            core.setParameterValueById(sw.id, sw.value)
          } catch {}
        }
      }
      state.appliedMouth = readParam(state.mouthParam)
      for (const [id, value] of state.forced) core.setParameterValueById(id, value)
    })

    // Idle must use IDLE priority; otherwise a NORMAL idle motion keeps the
    // manager's current priority at 2 and every later gesture is refused.
    await model.motion('Idle', 0, MotionPriority.IDLE).catch(() => false)

    app.ticker.add(() => {
      state.fps = Math.round(app.ticker.FPS || 0)
      setText(hudFps, state.fps)
      setText(hudMouth, state.mouth.toFixed(2))
    })

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    function readParam(id) {
      try {
        if (typeof core.getParameterValueById === 'function') return core.getParameterValueById(id)
        if (typeof core.getParameterIndex === 'function' && typeof core.getParameterValueByIndex === 'function') {
          return core.getParameterValueByIndex(core.getParameterIndex(id))
        }
      } catch {}
      return null
    }

    function samplePixels() {
      try {
        const gl = app.renderer.gl
        const width = gl.drawingBufferWidth
        const height = gl.drawingBufferHeight
        const pixels = new Uint8Array(width * height * 4)
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        let drawn = 0
        let minX = width
        let minY = height
        let maxX = -1
        let maxY = -1
        for (let y = 0; y < height; y += 2) {
          for (let x = 0; x < width; x += 2) {
            const alpha = pixels[(y * width + x) * 4 + 3]
            if (alpha > 8) {
              drawn += 1
              if (x < minX) minX = x
              if (y < minY) minY = y
              if (x > maxX) maxX = x
              if (y > maxY) maxY = y
            }
          }
        }
        return {
          drawn,
          sampled: Math.ceil(width / 2) * Math.ceil(height / 2),
          width,
          height,
          bounds: maxX >= 0 ? { minX, minY, maxX, maxY } : null,
        }
      } catch (error) {
        return { drawn: 0, error: String(error) }
      }
    }

    function webglInfo() {
      try {
        const gl = app.renderer.gl
        const debug = gl.getExtension('WEBGL_debug_renderer_info')
        return {
          version: gl.getParameter(gl.VERSION),
          vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
          renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          alpha: gl.getContextAttributes()?.alpha ?? null,
          maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        }
      } catch (error) {
        return { error: String(error) }
      }
    }

    function contextInfo() {
      try {
        const frame = window.frameElement
        const rect = frame?.getBoundingClientRect?.()
        const parent = frame?.parentElement
        const parentRect = parent?.getBoundingClientRect?.()
        return {
          href: location.href,
          inner: [window.innerWidth, window.innerHeight],
          dpr: window.devicePixelRatio,
          frame: frame
            ? {
                tag: frame.tagName,
                className: typeof frame.className === 'string' ? frame.className : '',
                src: frame.src || '',
                rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
              }
            : null,
          parent: parent
            ? {
                tag: parent.tagName,
                className: typeof parent.className === 'string' ? parent.className : '',
                rect: parentRect ? { x: parentRect.x, y: parentRect.y, width: parentRect.width, height: parentRect.height } : null,
              }
            : null,
        }
      } catch (error) {
        return { error: String(error) }
      }
    }

    async function runSelftest() {
      const started = Date.now()
      const report = {
        ok: false,
        time: Date.now(),
        durationMs: 0,
        loadMs: state.loadMs,
        ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        webgl: webglInfo(),
        model: {
          name: manifest?.name || null,
          width: model.width,
          height: model.height,
          expressions: manifest?.expressions?.length || 0,
          motions: manifest?.motions || {},
        },
        expressions: { total: 0, passed: 0, failed: [] },
        motions: { total: 0, passed: 0, failed: [], errors: [] },
        mouth: { param: state.mouthParam, before: null, after: null, applied: false, exists: false, index: -1, min: null, max: null },
        states: {},
        pixels: null,
        fps: 0,
        logs: [],
        error: null,
      }

      try {
        const names = manifest?.expressions?.map((entry) => entry.Name) || []
        report.expressions.total = names.length
        for (const name of names) {
          let ok = false
          try {
            ok = await model.expression(name)
          } catch {
            ok = false
          }
          if (ok) report.expressions.passed += 1
          else report.expressions.failed.push(name)
          await sleep(10)
        }
        model.internalModel.motionManager.expressionManager?.resetExpression()
        state.expression = '-'

        const gestures = manifest?.motions?.Gesture || []
        report.motions.total = gestures.length
        for (let index = 0; index < gestures.length; index++) {
          let ok = false
          try {
            ok = await model.motion('Gesture', index, MotionPriority.FORCE)
          } catch (error) {
            ok = false
            report.motions.errors.push(`${gestures[index]}: ${error instanceof Error ? error.message : String(error)}`)
          }
          if (ok) report.motions.passed += 1
          else {
            report.motions.failed.push(gestures[index])
            if (!report.motions.errors.some((entry) => entry.startsWith(`${gestures[index]}:`))) {
              report.motions.errors.push(`${gestures[index]}: startMotion returned false`)
            }
          }
          await sleep(250)
        }

        report.mouth.index = state.mouthParamIndex
        report.mouth.exists = typeof state.mouthParamIndex === 'number' && state.mouthParamIndex >= 0
        if (report.mouth.exists) {
          try {
            report.mouth.min = core.getParameterMinimumValue(state.mouthParamIndex)
            report.mouth.max = core.getParameterMaximumValue(state.mouthParamIndex)
          } catch {}
        }
        report.mouth.before = readParam(state.mouthParam)
        state.mouth = 1
        await sleep(220)
        report.mouth.after = state.appliedMouth
        state.mouth = 0
        report.mouth.applied = typeof report.mouth.after === 'number' && report.mouth.after > 0.5

        for (const name of Object.keys(manifest?.stateExpressions || {})) {
          try {
            report.states[name] = await window.__pet.setState(name)
          } catch {
            report.states[name] = false
          }
        }
        state.mouth = 0.35
        await window.__pet.setState('idle')
        await sleep(160)
        state.mouth = 0

        report.pixels = samplePixels()
        await sleep(700)
        report.fps = Math.round(app.ticker.FPS || 0)
        report.ok = report.expressions.failed.length === 0
          && report.motions.failed.length === 0
          && report.mouth.applied
          && !!report.pixels
          && report.pixels.drawn > 0
      } catch (error) {
        report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }

      report.durationMs = Date.now() - started
      report.time = Date.now()
      report.context = contextInfo()
      report.logs = window.__logs.slice(-80)
      state.report = report
      window.__petReport = report
      setText(hudState, report.ok ? 'selftest ok' : 'selftest fail')
      log('selftest', report)

      try {
        const target = new URL('../api/stage-report', location.href).href
        await fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(report),
        })
      } catch (error) {
        log('selftest report upload failed', error)
      }
      return report
    }

    const api = {
      get ready() { return state.ready },
      get error() { return state.error },
      info() {
        return {
          ready: state.ready,
          error: state.error,
          expressions: manifest?.expressions?.map((e) => e.Name) || [],
          expressionCount: manifest?.expressions?.length || 0,
          motions: manifest?.motions || {},
          modelWidth: model.width,
          modelHeight: model.height,
          screen: { width: app.screen.width, height: app.screen.height },
          viewport: state.viewport,
          fps: state.fps,
          loadMs: state.loadMs,
          expression: state.expression,
          motion: state.motion,
          mouth: state.mouth,
          appliedMouth: state.appliedMouth,
          mouthParam: state.mouthParam,
          mouthRange: state.mouthRange,
          coreParameters: typeof core.getParameterCount === 'function' ? core.getParameterCount() : null,
        }
      },
      async setExpression(name) {
        const ok = await model.expression(name)
        if (ok) {
          state.expression = name
          setText(hudExpression, name)
          log('expression', name, ok)
        }
        return ok
      },
      async clearExpression() {
        const manager = model.internalModel.motionManager.expressionManager
        if (manager) manager.resetExpression()
        state.expression = '-'
        setText(hudExpression, '-')
        return true
      },
      async motion(group, nameOrIndex, priority) {
        let index = Number(nameOrIndex)
        if (!Number.isFinite(index)) {
          const list = manifest?.motions?.[group] || []
          index = list.indexOf(String(nameOrIndex))
        }
        if (!Number.isFinite(index) || index < 0) return false
        const resolved = priority ?? (group === 'Idle' ? MotionPriority.IDLE : MotionPriority.NORMAL)
        const ok = await model.motion(group, index, resolved)
        if (ok) {
          state.motion = `${group}[${index}]`
          setText(hudMotion, `${group}[${index}]`)
          log('motion', group, index, ok)
        }
        return ok
      },
      setMouth(level) {
        const value = Math.min(1, Math.max(0, Number(level) || 0))
        state.mouth = value
        performer?.setMouth(value)
      },
      readParam(id) {
        return readParam(id)
      },
      selftest() {
        return runSelftest()
      },
      get report() {
        return state.report
      },
      setParam(id, value) {
        const number = Number(value)
        if (!id || !Number.isFinite(number)) return false
        state.forced.set(String(id), number)
        return true
      },
      clearParams() {
        state.forced.clear()
        return true
      },
      look(x, y) {
        model.focus(Number(x) || 0, Number(y) || 0, true)
        return true
      },
      blink(enabled) {
        model.internalModel.eyeBlink = enabled ? originalBlink : null
        return true
      },
      setReducedMotion(enabled) {
        const on = !!enabled
        state.reducedMotion = on
        performer?.setReducedMotion(on)
        try {
          model.internalModel.eyeBlink = on ? null : originalBlink
        } catch {}
        try {
          if (on) {
            model.internalModel.motionManager.stopAllMotions?.()
          } else {
            model.motion('Idle', 0, MotionPriority.IDLE).catch(() => {})
          }
        } catch {}
        return true
      },
      async setState(name) {
        setText(hudState, name)
        if (name === 'idle') {
          model.internalModel.motionManager.expressionManager?.resetExpression()
          state.expression = '-'
          setText(hudExpression, '-')
        }
        const expressions = manifest?.stateExpressions?.[name] || []
        for (const candidate of expressions) {
          if (await model.expression(candidate)) {
            state.expression = candidate
            setText(hudExpression, candidate)
            break
          }
        }
        const gestures = manifest?.stateGestures?.[name] || []
        if (gestures.length) {
          const list = manifest?.motions?.Gesture || []
          const index = list.indexOf(gestures[0])
          if (index >= 0 && await model.motion('Gesture', index, MotionPriority.NORMAL)) {
            state.motion = `Gesture[${index}]`
            setText(hudMotion, state.motion)
          }
        }
        return true
      },
      hud(visible) {
        hud.hidden = !visible
        return !hud.hidden
      },
      relayout() {
        resizeStage()
        setTimeout(resizeStage, 80)
        setTimeout(resizeStage, 250)
        if (params.get('diag') === '1') {
          try {
            postDiagnostic({
              ok: true,
              kind: 'relayout',
              time: Date.now(),
              viewport: state.viewport,
              screen: { width: app.screen.width, height: app.screen.height },
              model: { width: model.width, height: model.height },
              error: null,
            })
          } catch {}
        }
        return true
      },
      async playIdle() {
        return model.motion('Idle', 0, MotionPriority.IDLE)
      },
    }
    window.__pet = api
    state.loadMs = Math.round(performance.now() - loadStart)
    state.ready = true
    window.__petReady = true
    setText(hudState, 'idle')
    log('ready', api.info())

    // The Host's page overlay pushes the head-of-pet state here.
    window.addEventListener('message', (event) => {
      if (event.origin !== location.origin) return
      const data = event.data
      if (data && data.source === 'dsh-dstuber' && data.type === 'pet.state' && typeof data.state === 'string') {
        api.setState(data.state).catch(() => {})
      }
    })

    // Double click swaps a random expression; this works in any browser. The
    // window drag is Tauri-only and is delayed so a double click lands first.
    function triggerRandomExpression() {
      const list = (modelProfile?.expressions || []).filter(
        (expression) => Array.isArray(expression.switches) && expression.switches.length > 0,
      )
      if (list.length === 0) return false
      const pick = list[Math.floor(Math.random() * list.length)]
      randomExpression = {
        switches: pick.switches,
        until: Date.now() + 2600,
        name: pick.name,
      }
      log('random expression', pick.name, '->', pick.label || '')
      return true
    }

    // System window drag (works everywhere). A double click is two presses in
    // quick succession at the same spot and swaps a random expression instead
    // of starting a drag. Note: Windows pulls the window back inside the
    // monitor when it is dragged past the top edge — that is the OS drag loop,
    // not this code.
    let lastClickAt = 0
    let lastClickX = 0
    let lastClickY = 0

    window.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      const now = Date.now()
      const near = Math.abs(event.clientX - lastClickX) < 16 && Math.abs(event.clientY - lastClickY) < 16
      if (now - lastClickAt < 350 && near) {
        lastClickAt = 0
        if (state.doubleClickExpression) triggerRandomExpression()
        return
      }
      lastClickAt = now
      lastClickX = event.clientX
      lastClickY = event.clientY
      if (typeof window.__TAURI_INTERNALS__ === 'undefined') return
      window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
        event: 'dsh-dstuber:start-drag',
        payload: null,
      }).catch((error) => {
        state.tauriError = String(error)
        log('start_drag failed', error)
      })
    })

    // Desktop shell interaction. `__TAURI_INTERNALS__` exists only when this
    // page is hosted by the Tauri shell (and the remote IPC capability allows
    // the Host origin), so the same stage keeps working in a plain browser.
    const tauri = typeof window.__TAURI_INTERNALS__ !== 'undefined' ? window.__TAURI_INTERNALS__ : null
    const reportUrl = new URL('../api/stage-report', location.href).href
    const postDiagnostic = (payload) => {
      try {
        fetch(reportUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {})
      } catch {}
    }

    if (tauri?.invoke) {
      // Remote pages may not call app-defined commands, but the built-in
      // event plugin is allowed by the capability. Rust listens for these
      // events and performs the window work.
      const emitEvent = (event) => tauri.invoke('plugin:event|emit', { event, payload: null })
      window.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        emitEvent('dsh-dstuber:open-settings').catch((error) => {
          state.tauriError = String(error)
          log('open settings failed', error)
        })
      })

      // Test hook: `&settings=1` opens the local settings window.
      if (params.get('settings') === '1') {
        const probe = {
          ok: false,
          kind: 'settings-probe',
          time: Date.now(),
          debug: {
            href: location.href,
            hasInternals: true,
            hasInvoke: typeof tauri.invoke === 'function',
          },
          error: null,
        }
        postDiagnostic(probe)
        setTimeout(() => {
          emitEvent('dsh-dstuber:open-settings').then(() => {
            postDiagnostic({ ...probe, debug: { ...probe.debug, opened: true } })
          }).catch((error) => {
            state.tauriError = String(error)
            postDiagnostic({ ...probe, error: String(error) })
          })
        }, 800)
      }
    }

    // The page-corner overlay and the settings preview both ask for a
    // self-test; it runs in the real browser engine and reports to the Host.
    if (params.get('selftest') === '1') {
      setTimeout(() => {
        api.selftest().catch((error) => log('selftest failed', error))
      }, 500)
    }
  }

  main().catch((error) => {
    setText(hudState, 'error')
    showError(error)
  })
})()

// Voice playback: the Host synthesizes Azure audio per streamed sentence. The
// stage owns playback so a later Live2D mouth can use the same audio clock.
;(() => {
  const audio = new Audio()
  audio.preload = 'auto'
  const invoke = window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke
  const queue = []
  let playing = false

  function playNext() {
    if (playing) return
    const item = queue.shift()
    if (!item) return
    playing = true
    audio.pause()
    audio.src = item.audioUrl
    const volume = Number(item.volume)
    audio.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.8
    const finish = () => {
      playing = false
      playNext()
    }
    audio.onended = finish
    audio.onerror = finish
    audio.play().catch(() => {
      // WebView media autoplay can be blocked for a transparent pet window.
      // Fall back to the native WAV player; the shell validates the path.
      if (typeof invoke === 'function' && item.audioPath) {
        invoke('play_tts', { path: item.audioPath })
          .then(() => {
            const seconds = Number(item.duration)
            setTimeout(finish, (Number.isFinite(seconds) && seconds > 0 ? seconds : 2) * 1000 + 120)
          })
          .catch(() => finish())
      } else {
        finish()
      }
    })
  }

  function stop() {
    queue.length = 0
    playing = false
    audio.onended = null
    audio.onerror = null
    try {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    } catch {}
    if (typeof invoke === 'function') {
      invoke('stop_tts').catch(() => {})
    }
  }

  // Lip-sync diagnostics: count incoming level frames and report them so a
  // silent mouth can be traced to "no events", "bad values", or "write lost".
  const sseState = { open: false, error: false, messages: 0 }
  let levelProbe = { count: 0, last: 0, max: 0, messages: 0, types: {} }
  const mouthStats = { frames: 0, moves: 0, min: 1, max: 0, last: null }
  setInterval(() => {
    const value = window.__petPerformer?.state?.mouth
    if (typeof value === 'number') {
      mouthStats.frames += 1
      if (mouthStats.last !== null && Math.abs(value - mouthStats.last) > 0.04) mouthStats.moves += 1
      mouthStats.last = value
      mouthStats.min = Math.min(mouthStats.min, value)
      mouthStats.max = Math.max(mouthStats.max, value)
    }
  }, 50)
  setInterval(() => {
    const payload = {
      kind: 'heartbeat',
      build: window.STAGE_BUILD,
      sse: { ...sseState },
      count: levelProbe.count,
      last: levelProbe.last,
      max: levelProbe.max,
      messages: levelProbe.messages,
      types: levelProbe.types,
      mouth: window.__petPerformer?.state?.mouth ?? null,
      mouthStats: { ...mouthStats },
      emotion: window.__petPerformer?.emotion ?? null,
      applied: window.__petState.mouth,
      talking: window.__petPerformer?.state?.talking ?? null,
      time: Date.now(),
    }
    levelProbe = { count: 0, last: 0, max: 0, messages: 0, types: {} }
    mouthStats.frames = 0
    mouthStats.moves = 0
    mouthStats.min = 1
    mouthStats.max = 0
    void fetch(new URL('../api/stage-report', location.href), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {})
  }, 8000)

  try {
    const stream = new EventSource(new URL('../api/events', location.href))
    stream.onopen = () => {
      sseState.open = true
    }
    stream.onerror = () => {
      sseState.error = true
    }
    stream.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        sseState.messages += 1
        levelProbe.messages += 1
        levelProbe.types[message.type] = (levelProbe.types[message.type] || 0) + 1
        if (message.type === 'pet.speech.envelope') {
          window.__petPerformer?.setEnvelope(message)
        } else if (message.type === 'pet.speech.level') {
          const value = Number(message.value) || 0
          levelProbe.count += 1
          levelProbe.last = value
          levelProbe.max = Math.max(levelProbe.max, value)
          window.__petPerformer?.setMouth(value)
        } else if (message.type === 'pet.speech') {
          if (message.speechType === 'start' || message.speechType === 'play') {
            window.__petPerformer?.setTalking(true)
            window.__petPerformer?.startSpeech(message.id)
            if (message.emotion) window.__petPerformer?.setEmotion(message.emotion)
            // Models with a Talk motion group animate while speaking.
            window.__petMotion?.play?.('talk')
          } else if (message.speechType === 'end') {
            // Let the face ease back after the sentence instead of snapping.
            window.__petPerformer?.endEmotion()
          }
          if (message.audioUrl) {
            queue.push(message)
            playNext()
          }
        } else if (message.type === 'pet.speech.cancel') {
          window.__petPerformer?.setTalking(false)
          window.__petPerformer?.setMouth(0)
          stop()
        } else if (message.type === 'pet.reply.start') {
          window.__petPerformer?.setTalking(false)
          stop()
        }
      } catch {}
    }
  } catch {}

  // The settings window can flip full/bust at any time; re-fit when it changes.
  setInterval(async () => {
    try {
      const response = await fetch(new URL('../api/display', location.href), { cache: 'no-store' })
      if (!response.ok) return
      const value = await response.json().catch(() => null)
      const mode = value?.display?.framing
      if ((mode === 'full' || mode === 'bust') && mode !== (window.__petState.framing?.mode || 'full')) {
        window.__petState.framing = { ...(window.__petState.framing || {}), mode }
        window.__pet?.relayout?.()
      }
      if (typeof value?.display?.doubleClickExpression === 'boolean') {
        window.__petState.doubleClickExpression = value.display.doubleClickExpression
      }
    } catch {}
  }, 4000)
})()
