import test from 'node:test'
import assert from 'node:assert/strict'
import { createReplyStreamParser, parsePetReply } from '../src/stream-reply.js'

test('parses the header protocol', () => {
  const parsed = parsePetReply('MODE:chat\nEMOTION:happy\n你好呀')
  assert.deepEqual(parsed, { mode: 'chat', emotion: 'happy', reply: '你好呀' })
})

test('parses work mode without a reply', () => {
  const parsed = parsePetReply('MODE:work\n')
  assert.deepEqual(parsed, { mode: 'work', emotion: 'neutral', reply: '' })
})

test('keeps the legacy JSON reply protocol', () => {
  const parsed = parsePetReply('{"mode":"chat","emotion":"curious","reply":"在的"}')
  assert.deepEqual(parsed, { mode: 'chat', emotion: 'curious', reply: '在的' })
})

test('treats plain text as a chat reply and strips stage directions', () => {
  const parsed = parsePetReply('（摆尾）我在。')
  assert.equal(parsed.mode, 'chat')
  assert.equal(parsed.emotion, 'neutral')
  assert.equal(parsed.reply, '我在。')
})

test('strips parenthetical stage directions from replies', () => {
  const parsed = parsePetReply('MODE:chat\nEMOTION:happy\n你好（歪头）呀，(smile) 今天也一起加油。')
  assert.equal(parsed.reply, '你好呀， 今天也一起加油。')
})

test('stream parser emits only the body and strips stage directions', () => {
  const parser = createReplyStreamParser()
  let text = ''
  let first = null
  for (const chunk of ['MODE:', 'chat\nEMOTION:', 'happy\n（', '尾巴', '晃了晃）', '你好呀']) {
    const event = parser.push(chunk)
    if (event.delta) {
      if (!first) first = event
      text += event.delta
    }
  }
  assert.equal(first.mode, 'chat')
  assert.equal(first.emotion, 'happy')
  assert.equal(text, '你好呀')
  assert.deepEqual(parser.finish(), {
    mode: 'chat',
    emotion: 'happy',
    reply: '你好呀',
  })
})

test('stream parser waits for a one-character header prefix', () => {
  const parser = createReplyStreamParser()
  let text = ''
  let started = false
  for (const chunk of ['M', 'ODE:chat', '\n', 'EMOTION:', 'happy', '\n', '你好呀']) {
    const event = parser.push(chunk)
    if (event.delta) {
      started = true
      text += event.delta
    }
  }
  assert.equal(started, true)
  assert.equal(text, '你好呀')
  assert.deepEqual(parser.finish(), {
    mode: 'chat',
    emotion: 'happy',
    reply: '你好呀',
  })
})

test('stream parser does not speak JSON fallback', () => {
  const parser = createReplyStreamParser()
  let emitted = ''
  for (const chunk of ['{"mode":"chat",', '"reply":"你好"}']) {
    emitted += parser.push(chunk).delta
  }
  assert.equal(emitted, '')
  assert.equal(parser.finish().reply, '你好')
})

test('stream work mode stays silent', () => {
  const parser = createReplyStreamParser()
  const event = parser.push('MODE:work\n')
  assert.equal(event.mode, 'work')
  assert.equal(event.delta, '')
  assert.equal(parser.finish().mode, 'work')
})
