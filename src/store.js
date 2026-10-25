import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

/**
 * Derived view of DSH activity for the pet.
 *
 * The session log is the only source of truth; this store is a bounded cache
 * for presentation. It never receives tool arguments, results, file contents
 * or full conversation text. Only the assistant's visible text (the same text
 * the subtitle already shows) is kept, capped per session.
 */
export function createStore({ log = console } = {}) {
  const serverId = randomUUID()
  const startedAt = Date.now()
  const sessions = new Map()
  const listeners = new Set()
  let seq = 0
  let activeId = null
  let reply = null
  let lastReport = null
  // Heartbeats arrive every few seconds and used to overwrite the one-off
  // self-check report, which made the DSH card read "self-check failed".
  let lastSelftest = null
  let petReply = null
  let petReplyStream = null
  let petWhisper = null
  let petQuip = null
  let pet = {
    state: 'idle',
    expression: 'idle',
    caption: '',
    sessionId: null,
    lastTool: null,
    updatedAt: startedAt,
  }

  function emit(type, payload) {
    seq += 1
    const message = { seq, time: Date.now(), type, ...payload }
    for (const listener of listeners) {
      try {
        listener(message)
      } catch (error) {
        log.warn?.(`[dsh-dstuber] store listener failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return message
  }

  function rank(session) {
    if (session.error) return 4
    if (session.status === 'running') return 3
    if (session.lastTurnReason === 'completed') return 2
    return 1
  }

  function refreshActive() {
    const roots = [...sessions.values()].filter((s) => !s.subagent)
    roots.sort((a, b) => rank(b) - rank(a) || b.lastEventAt - a.lastEventAt)
    activeId = roots[0]?.id ?? null
    return activeId
  }

  function ensureSession(session) {
    const id = session.id
    let record = sessions.get(id)
    if (!record) {
      record = {
        id,
        cwd: session.header?.cwd || '',
        title: session.header?.cwd ? basename(session.header.cwd) : id,
        subagent: session.header?.origin === 'subagent',
        status: 'idle',
        turn: 0,
        tool: null,
        error: false,
        lastTurnReason: null,
        lastEventAt: Date.now(),
        lastText: '',
        textChars: 0,
      }
      sessions.set(id, record)
      log.info?.(`[dsh-dstuber] session seen: ${record.title} (${id})`)
    }
    return record
  }

  function noteSessionList(list = []) {
    for (const session of list) ensureSession(session)
    pruneSessions()
    refreshActive()
  }

  /** Keep the session map bounded: stale records must not accumulate forever. */
  function pruneSessions() {
    const now = Date.now()
    const keep = new Set()
    const sorted = [...sessions.values()].sort((a, b) => b.lastEventAt - a.lastEventAt)
    for (const record of sorted.slice(0, 30)) keep.add(record.id)
    if (activeId) keep.add(activeId)
    for (const [id, record] of sessions) {
      if (keep.has(id)) continue
      if (now - record.lastEventAt > 30 * 60 * 1000) sessions.delete(id)
    }
  }

  function updatePet(patch) {
    pet = { ...pet, ...patch, updatedAt: Date.now() }
    emit('pet', { pet })
  }

  function trimText(text) {
    return typeof text === 'string' ? text.slice(0, 4000) : ''
  }

  function assistantTextFrom(message) {
    if (!message || !Array.isArray(message.content)) return ''
    let text = ''
    for (const block of message.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
    }
    return text
  }

  function noteEvent(session, event) {
    const record = ensureSession(session)
    record.lastEventAt = Date.now()
    const type = event?.type
    const data = event?.data || {}

    switch (type) {
      case 'turn/start':
        record.turn = Number(data.turn) || record.turn
        record.status = 'running'
        record.error = false
        record.lastTurnReason = null
        updatePet({ state: 'thinking', expression: 'thinking', sessionId: record.id })
        break
      case 'tool/call':
        record.tool = typeof data.name === 'string' ? data.name : record.tool
        updatePet({ state: 'working', expression: 'working', lastTool: record.tool, sessionId: record.id })
        break
      case 'tool/result':
        if (data.error) {
          record.error = true
          updatePet({ state: 'error', expression: 'error', lastTool: record.tool, sessionId: record.id })
        } else {
          updatePet({ state: 'working', expression: 'working', lastTool: record.tool, sessionId: record.id })
        }
        break
      case 'user/message':
        updatePet({ state: 'listening', expression: 'listening', sessionId: record.id })
        break
      case 'assistant/message': {
        const text = assistantTextFrom(data.message)
        if (text) {
          record.lastText = trimText(text)
          record.textChars = text.length
          updatePet({ caption: record.lastText, sessionId: record.id })
        }
        break
      }
      case 'turn/end': {
        const reason = data.reason?.kind || 'completed'
        record.lastTurnReason = reason
        record.status = 'idle'
        record.tool = null
        const next = reason === 'completed' ? 'success'
          : reason === 'error' ? 'error'
            : reason === 'blocked' ? 'waiting'
              : reason === 'aborted' || reason === 'interrupted' ? 'idle'
                : 'idle'
        updatePet({ state: next, expression: next, sessionId: record.id })
        break
      }
      default:
        break
    }

    refreshActive()
    emit('session.event', {
      sessionId: record.id,
      event: {
        type,
        seq: event?.seq,
        time: event?.time,
        data: trimEventData(type, data),
      },
    })
    emit('state', { active: activeId, pet })
  }

  function trimEventData(type, data) {
    switch (type) {
      case 'turn/start':
      case 'step/start':
      case 'step/end':
        return { turn: data.turn, step: data.step }
      case 'turn/end':
        return { turn: data.turn, reason: data.reason?.kind }
      case 'tool/call':
        return { turn: data.turn, step: data.step, callId: data.callId, name: data.name }
      case 'tool/result':
        return {
          turn: data.turn,
          step: data.step,
          callId: data.message?.toolCallId,
          isError: !!data.message?.isError || !!data.error,
          errorName: data.error?.name,
        }
      case 'user/message':
        return { length: assistantTextFrom(data).length }
      case 'assistant/message':
        return { turn: data.turn, step: data.step, chars: assistantTextFrom(data).length }
      default:
        return {}
    }
  }

  function noteAgentStatus({ agent, status } = {}) {
    if (!agent?.id) return
    const session = { id: agent.id, header: agent.session?.header }
    const record = ensureSession(session)
    record.status = status === 'running' ? 'running' : 'idle'
    record.lastEventAt = Date.now()
    refreshActive()
    emit('agent.status', { sessionId: agent.id, status: record.status, active: activeId })
  }

  function noteStream({ agent, frame } = {}) {
    if (!agent?.id || !frame) return
    const record = ensureSession({ id: agent.id, header: agent.session?.header })
    if (frame.type === 'start') {
      reply = { sessionId: agent.id, startedAt: Date.now(), text: '' }
      emit('reply.start', { sessionId: agent.id })
      return
    }
    if (frame.type === 'chunk' && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string') {
      if (!reply || reply.sessionId !== agent.id) reply = { sessionId: agent.id, startedAt: Date.now(), text: '' }
      reply.text += frame.chunk.text
      record.lastText = trimText(reply.text)
      record.textChars = reply.text.length
      pet = { ...pet, caption: record.lastText, sessionId: agent.id, updatedAt: Date.now() }
      emit('reply.delta', { sessionId: agent.id, text: frame.chunk.text, chars: reply.text.length })
      return
    }
    if (frame.type === 'end') {
      if (reply && reply.sessionId === agent.id) {
        emit('reply.end', { sessionId: agent.id, chars: reply.text.length, outcome: frame.outcome?.kind })
        reply = null
      }
    }
  }

  function noteStageReport(report) {
    if (!report || typeof report !== 'object') return null
    const value = { ...report, receivedAt: Date.now(), seq }
    if (report.kind === 'selftest') lastSelftest = value
    lastReport = value
    emit('stage.report', { report: value })
    return value
  }

  function notePetReply({ text, mode = 'chat', emotion = 'neutral' } = {}) {
    const value = trimText(text)
    if (!value) return null
    petReply = { text: value, mode, emotion, time: Date.now() }
    emit('pet.reply', petReply)
    return petReply
  }

  function notePetReplyStart({ mode = 'chat', emotion = 'neutral', source = 'chat' } = {}) {
    petReplyStream = {
      id: randomUUID(),
      text: '',
      mode,
      emotion,
      source,
      time: Date.now(),
    }
    emit('pet.reply.start', { ...petReplyStream })
    return petReplyStream
  }

  function notePetReplyDelta(text, accumulated = null, emotion = null) {
    if (!petReplyStream) notePetReplyStart()
    const value = typeof text === 'string' ? text : ''
    if (typeof accumulated === 'string') petReplyStream.text = accumulated
    else petReplyStream.text += value
    if (typeof emotion === 'string' && emotion.trim()) petReplyStream.emotion = emotion.trim().toLowerCase()
    if (!petReplyStream.text) return petReplyStream
    const payload = {
      id: petReplyStream.id,
      text: value,
      accumulated: petReplyStream.text,
      chars: petReplyStream.text.length,
      mode: petReplyStream.mode,
      emotion: petReplyStream.emotion,
    }
    emit('pet.reply.delta', payload)
    return petReplyStream
  }

  function notePetReplyEnd({ text, mode = 'chat', emotion = 'neutral', source = 'chat' } = {}) {
    const value = trimText(text || petReplyStream?.text || '')
    if (!value) {
      petReplyStream = null
      return null
    }
    petReply = { text: value, mode, emotion, source, time: Date.now() }
    emit('pet.reply.end', { ...petReply })
    // Keep the old final event for clients that only listen to pet.reply.
    emit('pet.reply', { ...petReply })
    petReplyStream = null
    return petReply
  }

  function notePetWhisper(text) {
    const value = trimText(text)
    if (!value) return null
    petWhisper = { text: value, time: Date.now() }
    emit('pet.whisper', petWhisper)
    return petWhisper
  }

  function notePetQuip({
    text,
    emotion = 'neutral',
    priority = 'low',
    source = 'local',
    ttl = 8000,
  } = {}) {
    const value = trimText(text)
    if (!value) return null
    petQuip = {
      kind: 'quip',
      text: value,
      emotion,
      priority,
      source,
      ttl,
      time: Date.now(),
    }
    emit('pet.quip', petQuip)
    return petQuip
  }

  function notePetStatus(text, state = 'busy') {
    emit('pet.status', { text: trimText(text), state })
  }

  function noteSpeech(payload) {
    const speechType = payload?.type || 'speech'
    const value = { ...payload, time: Date.now(), speechType }
    delete value.type
    emit('pet.speech', value)
    return value
  }

  function noteSpeechCancel(payload = {}) {
    emit('pet.speech.cancel', { ...payload, time: Date.now() })
  }

  function noteSpeechLevel(payload = {}) {
    const value = Number(payload?.value)
    if (!Number.isFinite(value)) return null
    const level = { value: Math.max(0, Math.min(1, value)), time: Date.now() }
    emit('pet.speech.level', level)
    return level
  }

  function noteSpeechEnvelope(payload = {}) {
    if (!Array.isArray(payload?.samples) || payload.samples.length === 0) return null
    const envelope = {
      id: payload.id ? String(payload.id) : null,
      offsetMs: Math.max(0, Number(payload.offsetMs) || 0),
      windowMs: Math.max(1, Number(payload.windowMs) || 10),
      samples: payload.samples.slice(0, 240).map((value) => Math.max(0, Math.min(1, Number(value) || 0))),
      time: Date.now(),
    }
    emit('pet.speech.envelope', envelope)
    return envelope
  }

  function snapshot() {
    return {
      serverId,
      seq,
      time: Date.now(),
      uptimeMs: Date.now() - startedAt,
      pet,
      active: activeId,
      reply: reply ? { sessionId: reply.sessionId, chars: reply.text.length } : null,
      petReply,
      petReplyStream,
      petWhisper,
      petQuip,
      sessions: [...sessions.values()].map((s) => ({
        id: s.id,
        title: s.title,
        cwd: s.cwd,
        subagent: s.subagent,
        status: s.status,
        turn: s.turn,
        tool: s.tool,
        error: s.error,
        chars: s.textChars,
        lastEventAt: s.lastEventAt,
      })),
      report: lastReport ? { ok: lastReport.ok, time: lastReport.time || lastReport.receivedAt } : null,
    }
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function dispose() {
    listeners.clear()
    sessions.clear()
    reply = null
    petQuip = null
  }

  return {
    noteSessionList,
    noteEvent,
    noteAgentStatus,
    noteStream,
    noteStageReport,
    notePetReply,
    notePetReplyStart,
    notePetReplyDelta,
    notePetReplyEnd,
    notePetWhisper,
    notePetQuip,
    notePetStatus,
    noteSpeech,
    noteSpeechCancel,
    noteSpeechLevel,
    noteSpeechEnvelope,
    snapshot,
    subscribe,
    dispose,
    get active() { return activeId },
    get pet() { return pet },
    get report() { return lastReport },
    get selftest() { return lastSelftest },
  }
}
