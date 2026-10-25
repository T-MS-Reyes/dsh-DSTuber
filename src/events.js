/**
 * Subscribe to the DSH feeds the pet needs. Everything is observer-only:
 * no listener changes a session, an agent or a tool decision.
 */
export function bindEvents(ctx, store, log = console) {
  const disposers = []

  const on = (name, listener) => {
    try {
      disposers.push(ctx.on(name, listener, { global: true }))
    } catch (error) {
      log.warn?.(`[dsh-dstuber] cannot listen to ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  on('session/event', (session, event) => {
    store.noteEvent(session, event)
  })

  on('agent/status', (payload) => {
    store.noteAgentStatus(payload)
  })

  on('agent/assistant-stream', (payload) => {
    store.noteStream(payload)
  })

  // Seed the registry with sessions that already exist at activation time.
  try {
    store.noteSessionList(ctx.get('sessions')?.list?.() ?? [])
  } catch (error) {
    log.warn?.(`[dsh-dstuber] session seed failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {}
    }
  }
}
