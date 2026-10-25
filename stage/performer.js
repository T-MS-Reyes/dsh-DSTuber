// Live2D idle performer + lip sync.
//
// The stage owns rendering; this file owns "being alive": breathing, gaze,
// random looking around, small head motion while speaking, and the mouth
// envelope driven by the voice worker's real audio level. Every parameter name
// comes from the adapted model profile, so another model works without code
// changes as long as it exposes the same standard Cubism parameters.
(() => {
  'use strict'

  const DEFAULT_PARAMS = {
    mouth: 'ParamMouthOpenY',
    mouthRange: 1.1,
    breath: 'ParamBreath',
    eyeBallX: 'ParamEyeBallX',
    eyeBallY: 'ParamEyeBallY',
    angleX: 'ParamAngleX',
    angleY: 'ParamAngleY',
    angleZ: 'ParamAngleZ',
    bodyX: 'ParamBodyAngleX',
    bodyY: 'ParamBodyAngleY',
    eyeL: 'ParamEyeLOpen',
    eyeR: 'ParamEyeROpen',
  }

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/** Frame-rate independent exponential approach. */
  function approach(current, target, dt, tau) {
    const t = 1 - Math.exp(-Math.max(0, dt) / Math.max(0.001, tau))
    return current + (target - current) * t
  }

  function create(options = {}) {
    const params = { ...DEFAULT_PARAMS, ...(options.params || {}) }
    const state = {
      time: 0,
      breathPhase: Math.random() * Math.PI * 2,
      nodPhase: 0,
      mouth: 0,
      mouthTarget: 0,
      lastLevelAt: 0,
      talking: false,
      talkingUntil: 0,
      gazeX: 0,
      gazeY: 0,
      gazeTargetX: 0,
      gazeTargetY: 0,
      nextGazeAt: 0,
      reducedMotion: !!options.reducedMotion,
      speed: clamp(Number(options.speed) || 1, 0.2, 2),
    }

    // When the model ships .motion3 files, the stage plays them and the
    // performer only drives mouth + expression (no gaze/head writes).
    let motionMode = false

    // Pre-computed envelope replay: the voice worker publishes 10ms RMS chunks
    // ahead of playback; the stage samples them against its own clock so the
    // mouth follows syllables instead of network timing.
    const envelope = {
      id: null,
      windowMs: 10,
      samples: [],
      startAt: 0,
      active: false,
    }


    function resetEnvelope(id) {
      envelope.id = id || null
      envelope.windowMs = 10
      envelope.samples = []
      envelope.startAt = 0
      envelope.active = false
    }

    /** Append one published chunk at its sample offset (in 10ms windows). */
    function setEnvelope(payload = {}) {
      const id = payload.id || null
      const samples = Array.isArray(payload.samples) ? payload.samples : null
      if (!samples || samples.length === 0) return
      if (envelope.id !== id) resetEnvelope(id)
      const windowMs = clamp(Number(payload.windowMs) || 10, 4, 40)
      envelope.windowMs = windowMs
      const offset = Math.max(0, Math.round((Number(payload.offsetMs) || 0) / windowMs))
      for (let i = 0; i < samples.length; i += 1) {
        envelope.samples[offset + i] = clamp(Number(samples[i]) || 0, 0, 1)
      }
    }

    /** Mark the playback clock origin for one sentence. */
    function startSpeech(id) {
      if (id && envelope.id !== id) resetEnvelope(id)
      if (envelope.id === null) resetEnvelope(id)
      envelope.startAt = performance.now()
      envelope.active = true
    }

    function envelopeLevel(now) {
      if (!envelope.active || !envelope.startAt) return null
      const elapsed = now - envelope.startAt
      if (elapsed < 0) return 0
      const index = elapsed / envelope.windowMs
      const base = Math.floor(index)
      const frac = index - base
      if (base >= envelope.samples.length) {
        // Past the published end: close the mouth but keep the entry around so a
        // late chunk (normal with streaming) can still extend it.
        envelope.active = false
        return 0
      }
      const a = envelope.samples[base]
      const b = envelope.samples[base + 1]
      const va = a === undefined ? (b === undefined ? 0 : b) : a
      const vb = b === undefined ? va : b
      return va + (vb - va) * frac
    }

    // Emotion recipes come from the model profile: parameter targets plus an
    // optional artist switch expression. A short fade-in and a slow fade-out
    // keep expression changes from snapping.
    let emotions = options.emotions || {}
    const emotionState = {
      current: 'neutral',
      targets: new Map(),
      values: new Map(),
      effect: null,
      effectValue: 0,
      fading: false,
      fadeOutMs: 1680,
    }

    function setEmotion(name) {
      const key = String(name || 'neutral').trim().toLowerCase()
      const recipe = emotions[key] || emotions.neutral
      if (!recipe) return false
      emotionState.current = key
      emotionState.targets = new Map(Object.entries(recipe.params || {}))
      emotionState.effect = recipe.effect || null
      emotionState.fadeOutMs = Number(recipe.fadeOutMs) || 1680
      emotionState.fading = false
      return true
    }

    function endEmotion() {
      emotionState.fading = true
    }

    function applyEmotion(core, dt) {
      const tau = emotionState.fading
        ? Math.max(0.2, emotionState.fadeOutMs / 2600)
        : 0.12
      for (const [id, goalValue] of emotionState.targets) {
        if (!emotionState.values.has(id)) emotionState.values.set(id, 0)
      }
      for (const [id, current] of emotionState.values) {
        const goal = emotionState.fading ? 0 : (emotionState.targets.get(id) || 0)
        const next = approach(current, goal, dt, tau)
        emotionState.values.set(id, next)
        if (Math.abs(next) > 0.002) {
          try {
            core.setParameterValueById(id, next)
          } catch {}
        }
      }
      if (emotionState.effect) {
        const goal = emotionState.fading ? 0 : emotionState.effect.value
        const next = approach(emotionState.effectValue, goal, dt, tau)
        emotionState.effectValue = next
        if (Math.abs(next) > 0.002) {
          try {
            core.setParameterValueById(emotionState.effect.param, next)
          } catch {}
        }
      }
    }

    function setProfile(profile) {
      const detected = profile?.params || {}
      for (const key of Object.keys(DEFAULT_PARAMS)) {
        const value = detected[key]
        if (typeof value === 'string' && value) params[key] = value
      }
      if (Number.isFinite(detected.mouthRange) && detected.mouthRange > 0) {
        // Cap at 1.2: a larger multiplier pushes almost every syllable past the
        // parameter clamp and the mouth never closes between words.
        params.mouthRange = clamp(detected.mouthRange, 0.2, 1.2)
      }
      if (profile?.emotions && typeof profile.emotions === 'object') {
        emotions = profile.emotions
      }
    }

    /** Feed one audio level sample (0..1) from the voice worker. */
    function setMouth(value) {
      const level = Number(value)
      if (!Number.isFinite(level)) return
      state.mouthTarget = clamp(level, 0, 1)
      state.lastLevelAt = performance.now()
    }

    function setTalking(on) {
      state.talking = !!on
      if (on) state.talkingUntil = performance.now() + 420
    }

    function setReducedMotion(on) {
      state.reducedMotion = !!on
      if (on) state.mouthTarget = 0
    }

    function update(dt) {
      const step = Math.min(0.08, Math.max(0, dt)) * state.speed
      state.dt = step
      state.time += step
      const now = performance.now()

      // Mouth: replay the pre-computed envelope when available, otherwise fall
      // back to the coarse level events. Short attack/release keeps syllables.
      const envLevel = envelopeLevel(now)
      if (envLevel !== null) {
        state.mouthTarget = envLevel
        state.lastLevelAt = now
      } else if (now - state.lastLevelAt > 260) {
        state.mouthTarget = 0
      }
      const tau = state.mouthTarget > state.mouth ? 0.02 : 0.09
      state.mouth = clamp(approach(state.mouth, state.mouthTarget, step, tau), 0, 1)

      if (state.talking && now > state.talkingUntil) state.talking = false

      if (!state.reducedMotion) {
        state.breathPhase += step * 0.85
        if (state.talking) state.nodPhase += step * 2.4
      }

      // Gaze: random looking around while idle, centred while speaking.
      if (state.reducedMotion) {
        state.gazeX = approach(state.gazeX, 0, step, 0.5)
        state.gazeY = approach(state.gazeY, 0, step, 0.5)
      } else {
        if (state.talking) {
          state.gazeTargetX = approach(state.gazeTargetX, 0, step, 0.6)
          state.gazeTargetY = approach(state.gazeTargetY, 0, step, 0.6)
        } else if (now >= state.nextGazeAt) {
          state.gazeTargetX = (Math.random() * 2 - 1) * 0.85
          state.gazeTargetY = (Math.random() * 2 - 1) * 0.5
          state.nextGazeAt = now + 1800 + Math.random() * 3200
        }
        state.gazeX = approach(state.gazeX, state.gazeTargetX, step, 0.38)
        state.gazeY = approach(state.gazeY, state.gazeTargetY, step, 0.38)
      }
    }

    function apply(core) {
      const set = (id, value) => {
        if (!id) return
        try {
          core.setParameterValueById(id, value)
        } catch {}
      }
      set(params.mouth, state.mouth * params.mouthRange)
      applyEmotion(core, state.dt || 0.016)
      if (state.reducedMotion) return

      if (params.breath) set(params.breath, Math.sin(state.breathPhase) * 0.55)

      const sway = Math.sin(state.time * 0.33) * 0.8
      // When the model ships .motion3 files the stage plays them and owns the
      // head/body, so the performer only contributes mouth and expression.
      if (motionMode) {
        set(params.mouth, state.mouth * params.mouthRange)
        applyEmotion(core, state.dt || 0.016)
        return
      }
      set(params.eyeBallX, state.gazeX * 0.85)
      set(params.eyeBallY, state.gazeY * 0.65)
      set(params.angleX, state.gazeX * 18)
      set(params.angleZ, state.gazeX * 5 + sway)
      const nod = state.talking ? Math.sin(state.nodPhase) * 4.5 : 0
      set(params.angleY, state.gazeY * 9 - nod)
      set(params.bodyX, state.gazeX * 9)
    }

    return {
      params,
      state,
      envelope,
      get emotion() { return emotionState.current },
      get motionMode() { return motionMode },
      setProfile,
      setMotionMode(on) { motionMode = !!on },
      setMouth,
      setEnvelope,
      startSpeech,
      setEmotion,
      endEmotion,
      setTalking,
      setReducedMotion,
      update,
      apply,
    }
  }

  window.DSPerformer = { create, DEFAULT_PARAMS }
})()
