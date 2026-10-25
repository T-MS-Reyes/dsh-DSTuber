import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePatch, resolveConfig } from '../src/config.js'

test('resolved defaults match the agreed P0 defaults', () => {
  const config = resolveConfig({})
  assert.equal(config.enabled, true)
  assert.equal(config.chat.enabled, undefined)
  assert.equal(config.pet.chatEnabled, true)
  assert.equal(config.pet.webOverlay, false)
  assert.equal(config.chat.sendMode, 'followup')
  assert.equal(config.voice.provider, 'edge')
  assert.equal(config.voice.volume, 0.8)
  assert.equal(config.chat.maxHeightRatio, 0.35)
  assert.equal(config.murmur.maxChars, 28)
  assert.equal(config.live2d.model, 'ds-whale')
  assert.equal(config.shell.autoStart, true)
  assert.equal(config.shell.restart, true)
  assert.equal(config.shell.executable, '')
})

test('normalizePatch clamps numbers and drops unknown fields', () => {
  const patch = normalizePatch({
    enabled: false,
    pet: { scale: 99, opacity: -1, evil: 'x' },
    voice: { provider: 'gpt-sovits', volume: 2 },
    unknown: { a: 1 },
  })
  assert.equal(patch.enabled, false)
  assert.equal(patch.pet.scale, 1.5)
  assert.equal(patch.pet.opacity, 0.4)
  assert.equal(patch.pet.evil, undefined)
  assert.equal(patch.voice.provider, 'gpt-sovits')
  assert.equal(patch.voice.volume, 1)
  assert.equal(patch.unknown, undefined)
})

test('normalizePatch rejects non-object input', () => {
  assert.deepEqual(normalizePatch(null), {})
  assert.deepEqual(normalizePatch('x'), {})
  assert.deepEqual(normalizePatch([]), {})
})

test('shell config is whitelisted', () => {
  const patch = normalizePatch({ shell: { autoStart: false, executable: 'C:\\pet\\shell.exe', restart: false } })
  assert.equal(patch.shell.autoStart, false)
  assert.equal(patch.shell.executable, 'C:\\pet\\shell.exe')
  assert.equal(patch.shell.restart, false)
})

test('enum values are whitelisted', () => {
  const patch = normalizePatch({
    chat: { sendMode: 'followup' },
    voice: { provider: 'sapi' },
  })
  assert.equal(patch.chat.sendMode, 'followup')
  assert.equal(patch.voice, undefined)
})
