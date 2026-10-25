import { randomUUID } from 'node:crypto'

/**
 * Relay a chat line into the DSH agent of a live session.
 *
 * This is deliberately the same message shape the DSH composer produces; the
 * pet is a remote input for the real session, never a second chatbot.
 */
export function sendChat(ctx, input, { active } = {}, log = console) {
  const text = typeof input?.text === 'string' ? input.text.trim() : ''
  if (!text) return { ok: false, status: 400, error: 'empty-text' }
  if (text.length > 20000) return { ok: false, status: 413, error: 'text-too-long' }

  const agents = ctx.get('agents')
  if (!agents) return { ok: false, status: 503, error: 'agents-unavailable' }

  const sessions = ctx.get('sessions')?.list?.() ?? []
  const live = new Map(agents.list?.().map((agent) => [agent.id, agent]) ?? [])
  const roots = sessions.filter((session) => session.header?.origin !== 'subagent' && live.has(session.id))

  let target = null
  if (typeof input?.targetSessionId === 'string' && input.targetSessionId) {
    target = live.get(input.targetSessionId) ?? null
    if (!target) return { ok: false, status: 409, error: 'no-session' }
  } else {
    target = (active && live.get(active)) || null
    if (!target) {
      // Most recently seen root session with a live agent.
      const own = sessions.filter((s) => s.header?.origin !== 'subagent' && live.has(s.id))
      const last = own[own.length - 1]
      target = last ? live.get(last.id) : null
    }
    if (!target) {
      const firstRoot = agents.roots?.()[0]
      target = firstRoot ?? null
    }
  }
  if (!target) return { ok: false, status: 409, error: 'no-session' }

  const sendMode = input?.sendMode === 'steer' ? 'steer' : 'followup'
  const requestId = typeof input?.requestId === 'string' && input.requestId ? input.requestId : randomUUID()
  const message = {
    id: requestId,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }

  const busy = target.status === 'running'
  try {
    if (sendMode === 'steer') target.steer(message)
    else target.followup(message)
  } catch (error) {
    log.warn?.(`[dsh-dstuber] chat.send failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, status: 500, error: 'send-failed', message: error instanceof Error ? error.message : String(error) }
  }

  return {
    ok: true,
    requestId,
    sessionId: target.id,
    sendMode,
    state: sendMode === 'steer' ? 'steered' : busy ? 'queued' : 'sent',
    chars: text.length,
    active: active ?? null,
    roots: roots.length,
  }
}
