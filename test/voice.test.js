import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanSpeechText, splitSpeechSentences, wavDuration } from '../src/voice.js'

test('cleans markdown and urls before speech', () => {
  const text = cleanSpeechText('**你好** [链接](https://example.com) `code`')
  assert.equal(text, '你好 链接 code')
})

test('splits streamed Chinese sentences and keeps the tail', () => {
  const first = splitSpeechSentences('你好呀。今天想聊点什么')
  assert.deepEqual(first.parts, ['你好呀。'])
  assert.equal(first.rest, '今天想聊点什么')
  const second = splitSpeechSentences(`${first.rest}？还有呢`, false)
  assert.deepEqual(second.parts, ['今天想聊点什么？'])
  assert.equal(second.rest, '还有呢')
})

test('flushes the unsplit tail on final', () => {
  const result = splitSpeechSentences('最后一句没有标点', true)
  assert.deepEqual(result.parts, ['最后一句没有标点'])
  assert.equal(result.rest, '')
})

test('reads a WAV duration from the RIFF header', () => {
  const buffer = Buffer.alloc(44)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(24000 * 2, 28)
  buffer.writeUInt32LE(48000, 40)
  assert.equal(wavDuration(buffer), 1)
  assert.equal(wavDuration(Buffer.alloc(10)), 0)
})
