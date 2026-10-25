import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/store.js'

const quiet = { info() {}, warn() {}, debug() {} }

function session(id = 'session-1', cwd = 'D:\\projects\\demo') {
  return { id, header: { cwd, origin: undefined } }
}

test('folds turn/tool/assistant/turn-end into pet state', () => {
  const store = createStore({ log: quiet })
  const s = session()
  store.noteSessionList([s])

  store.noteEvent(s, { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })
  assert.equal(store.snapshot().pet.state, 'thinking')

  store.noteEvent(s, { type: 'tool/call', seq: 2, time: 2, data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: '{"path":"C:/secret.txt"}' } })
  assert.equal(store.snapshot().pet.state, 'working')
  assert.equal(store.snapshot().pet.lastTool, 'edit')

  store.noteEvent(s, { type: 'tool/result', seq: 3, time: 3, data: { turn: 1, step: 1, message: { toolCallId: 'c1', isError: false }, error: { name: 'Boom' } } })
  assert.equal(store.snapshot().pet.state, 'error')

  store.noteEvent(s, {
    type: 'assistant/message',
    seq: 4,
    time: 4,
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '好了。' }, { type: 'reasoning', text: 'secret' }] } },
  })
  assert.equal(store.snapshot().pet.caption, '好了。')

  store.noteEvent(s, { type: 'turn/end', seq: 5, time: 5, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(store.snapshot().pet.state, 'success')
})

test('event copies never carry tool arguments or results', () => {
  const store = createStore({ log: quiet })
  const messages = []
  store.subscribe((message) => messages.push(message))
  const s = session()
  store.noteEvent(s, {
    type: 'tool/call',
    seq: 1,
    time: 1,
    data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"cat C:/secret"}' },
  })
  const copy = messages.find((message) => message.type === 'session.event')
  assert.ok(copy)
  assert.equal(copy.event.data.arguments, undefined)
  assert.equal(copy.event.data.name, 'bash')
})

test('subagent sessions do not become active', () => {
  const store = createStore({ log: quiet })
  const root = session('root')
  const child = { id: 'child', header: { cwd: 'D:\\projects\\demo', origin: 'subagent' } }
  store.noteSessionList([root, child])
  store.noteEvent(root, { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } })
  assert.equal(store.snapshot().active, 'root')
  store.noteEvent(child, { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } })
  assert.equal(store.snapshot().active, 'root')
})

test('assistant stream accumulates text deltas', () => {
  const store = createStore({ log: quiet })
  const agent = { id: 'session-1', session: { header: { cwd: 'D:\\projects\\demo' } } }
  const events = []
  store.subscribe((message) => events.push(message))
  store.noteStream({ agent, frame: { type: 'start' } })
  store.noteStream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '唔，' } } })
  store.noteStream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '开工了。' } } })
  store.noteStream({ agent, frame: { type: 'end', outcome: { kind: 'committed' } } })
  assert.equal(store.snapshot().pet.caption, '唔，开工了。')
  assert.ok(events.some((message) => message.type === 'reply.delta'))
  assert.ok(events.some((message) => message.type === 'reply.end'))
})

test('stage report is kept and exposed', () => {
  const store = createStore({ log: quiet })
  store.noteStageReport({ ok: true, expressions: { passed: 44, total: 44 } })
  const snapshot = store.snapshot()
  assert.equal(snapshot.report.ok, true)
  assert.equal(store.report.expressions.passed, 44)
})
