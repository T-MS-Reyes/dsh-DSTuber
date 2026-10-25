import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { devModelDir, resolveModel } from '../src/model.js'

test('augmented model registers all 44 expressions and 8 motions', async () => {
  const model = await resolveModel({ live2d: { model: 'ds-whale', modelDir: devModelDir } })
  assert.ok(model.dir, model.error)
  assert.ok(model.manifest, 'manifest.json missing')
  assert.equal(model.manifest.expressions.length, 44)
  assert.equal(model.manifest.motions.Idle.length, 1)
  assert.equal(model.manifest.motions.Gesture.length, 7)
  assert.equal(model.manifest.lipSyncParam, 'ParamMouthOpenY')
  assert.equal(model.manifest.mouthRange, 2.1)

  const augmented = JSON.parse(await readFile(model.augmented, 'utf8'))
  assert.equal(augmented.Version, 3)
  assert.equal(augmented.FileReferences.Expressions.length, 44)
  assert.equal(augmented.FileReferences.Motions.Idle.length, 1)
  assert.equal(augmented.FileReferences.Motions.Gesture.length, 7)
  assert.ok(augmented.Groups.some((group) => group.Name === 'LipSync' && group.Ids.includes('ParamMouthOpenY')))

  for (const expression of augmented.FileReferences.Expressions) {
    const info = await stat(join(model.dir, expression.File))
    assert.ok(info.size > 0, `${expression.File} is empty`)
  }
  for (const motions of Object.values(augmented.FileReferences.Motions)) {
    for (const motion of motions) {
      const info = await stat(join(model.dir, motion.File))
      assert.ok(info.size > 0, `${motion.File} is empty`)
    }
  }
})

test('expression names are unique and ASCII', async () => {
  const model = await resolveModel({ live2d: { modelDir: devModelDir } })
  const names = model.manifest.expressions.map((expression) => expression.Name)
  assert.equal(new Set(names).size, names.length)
  assert.ok(names.every((name) => /^[a-z0-9_]+$/.test(name)), 'expression names must be ASCII ids')
})
