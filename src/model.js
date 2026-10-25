import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
export const stageDir = join(packageRoot, 'stage')
export const devModelDir = join(packageRoot, 'dev', 'live2d', 'ds-whale')
export const live2dRoot = join(packageRoot, '.webview2', 'live2d')
export const customModelRoot = join(live2dRoot, 'custom')
export const activeModelFile = join(live2dRoot, 'active.json')
const ACTIVE_ID = /^[A-Za-z0-9_-]{1,80}$/
export const builtinModels = [
  {
    id: 'ds-q',
    name: 'DS鲸鱼娘（桌面Q版）',
    dir: devModelDir,
  },
  {
    id: 'ds-full',
    name: 'DS鲸鱼娘',
    dir: join(packageRoot, 'dev', 'live2d', 'ds-full'),
  },
]

function builtinModel(id) {
  return builtinModels.find((model) => model.id === id) || builtinModels[0]
}

/** Candidate directories for the legacy/dev model configuration. */
export function modelCandidates(config = {}) {
  const id = config.live2d?.model || 'ds-whale'
  const list = []
  if (config.live2d?.modelDir) list.push(config.live2d.modelDir)
  list.push(join(live2dRoot, id))
  list.push(devModelDir)
  return [...new Set(list)]
}

export async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function readActiveModel() {
  try {
    const value = await readJson(activeModelFile)
    if (value?.kind === 'custom' && ACTIVE_ID.test(String(value.id || ''))) {
      return { kind: 'custom', id: String(value.id) }
    }
    if (value?.kind === 'builtin' && builtinModels.some((model) => model.id === value.id)) {
      return { kind: 'builtin', id: String(value.id) }
    }
  } catch {}
  return { kind: 'builtin', id: 'ds-q' }
}

async function loadPreparedModel(dir, extra = {}) {
  const augmented = join(dir, 'model3.augmented.json')
  if (!(await exists(augmented))) throw new Error('model3.augmented.json not found')
  let manifest = null
  try {
    manifest = await readJson(join(dir, 'manifest.json'))
  } catch {}
  return { dir, augmented, manifest, ...extra }
}

function inside(dir, ref) {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('empty asset reference')
  const normalized = ref.replace(/\\/g, '/')
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`unsafe asset reference: ${ref}`)
  }
  return join(dir, ...normalized.split('/'))
}

async function requireAsset(dir, ref, label) {
  const path = inside(dir, ref)
  if (!(await exists(path))) throw new Error(`${label} missing: ${ref}`)
  return path
}

async function listFiles(dir, suffix, max = 500) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (entry.name.toLowerCase().endsWith(suffix)) files.push(entry.name)
      if (files.length >= max) break
    }
    return files.sort()
  } catch {
    return []
  }
}

function stableName(value, fallback = 'extra') {
  const name = String(value || '')
    .replace(/\.(?:exp3|motion3)\.json$/i, '')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return name.slice(0, 48) || fallback
}

async function discoverExpressions(dir, refs, existing) {
  if (existing.length > 0) return existing
  const found = []
  const names = new Set()
  const roots = [
    { dir, prefix: '' },
    { dir: join(dir, 'expressions'), prefix: 'expressions/' },
    { dir: join(dir, 'EXP'), prefix: 'EXP/' },
  ]
  for (const root of roots) {
    for (const file of await listFiles(root.dir, '.exp3.json')) {
      const name = stableName(file)
      if (names.has(name)) continue
      names.add(name)
      found.push({ Name: name, File: `${root.prefix}${file}` })
    }
  }
  refs.Expressions = found
  return found
}

async function discoverMotions(dir, refs, existing) {
  if (existing && Object.keys(existing).length > 0) return existing
  const groups = {}
  const roots = [
    { dir, prefix: '' },
    { dir: join(dir, 'motions'), prefix: 'motions/' },
  ]
  for (const root of roots) {
    for (const file of await listFiles(root.dir, '.motion3.json')) {
      const group = /idle/i.test(file) ? 'Idle' : 'Gesture'
      const list = groups[group] || (groups[group] = [])
      list.push({ File: `${root.prefix}${file}`, FadeInTime: group === 'Idle' ? 0.4 : 0.2 })
    }
  }
  refs.Motions = groups
  return groups
}

/**
 * Create runtime files for an imported model. The source may be a plain Cubism
 * export with loose expressions/motions, so add the metadata the stage expects
 * without mutating the original model3.json.
 */
async function prepareCustomModel(dir) {
  const source = join(dir, 'model3.json')
  if (!(await exists(source))) throw new Error('model3.json not found')
  const augmented = join(dir, 'model3.augmented.json')
  const manifestPath = join(dir, 'manifest.json')
  if ((await exists(augmented)) && (await exists(manifestPath))) {
    const [sourceStat, augmentedStat, manifestStat] = await Promise.all([
      stat(source),
      stat(augmented),
      stat(manifestPath),
    ])
    if (augmentedStat.mtimeMs >= sourceStat.mtimeMs && manifestStat.mtimeMs >= sourceStat.mtimeMs) {
      return loadPreparedModel(dir, { kind: 'custom' })
    }
  }

  const model = await readJson(source)
  const refs = model.FileReferences || (model.FileReferences = {})
  await requireAsset(dir, refs.Moc, 'moc3')
  const textures = Array.isArray(refs.Textures) ? refs.Textures : []
  if (textures.length === 0) throw new Error('model has no textures')
  for (const texture of textures) await requireAsset(dir, texture, 'texture')

  const groups = Array.isArray(model.Groups) ? model.Groups : (model.Groups = [])
  const lipSync = groups.find((group) => group?.Name === 'LipSync')
  if (!lipSync) {
    groups.push({ Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] })
  } else if (!Array.isArray(lipSync.Ids) || lipSync.Ids.length === 0) {
    lipSync.Ids = ['ParamMouthOpenY']
  }
  const eyeBlink = groups.find((group) => group?.Name === 'EyeBlink')
  if (!eyeBlink) {
    groups.push({ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] })
  } else if (!Array.isArray(eyeBlink.Ids) || eyeBlink.Ids.length === 0) {
    eyeBlink.Ids = ['ParamEyeLOpen', 'ParamEyeROpen']
  }

  const existingExpressions = Array.isArray(refs.Expressions) ? refs.Expressions : []
  const expressions = await discoverExpressions(dir, refs, existingExpressions)
  const existingMotions = refs.Motions && typeof refs.Motions === 'object' ? refs.Motions : {}
  const motions = await discoverMotions(dir, refs, existingMotions)

  let meta = {}
  try {
    meta = await readJson(join(dir, 'meta.json'))
  } catch {}
  const name = String(meta.name || basename(dir)).trim() || basename(dir)
  const motionNames = {}
  for (const [group, list] of Object.entries(motions || {})) {
    motionNames[group] = Array.isArray(list)
      ? list.map((entry) => stableName(entry.File))
      : []
  }
  const manifest = {
    id: basename(dir),
    name,
    version: model.Version || 3,
    source: 'custom',
    augmentedModel: 'model3.augmented.json',
    expressions,
    motions: motionNames,
    stateExpressions: {},
    stateGestures: {},
    lipSyncParam: 'ParamMouthOpenY',
    mouthRange: 2.1,
    generatedAt: new Date().toISOString(),
  }

  await writeFile(augmented, `${JSON.stringify(model, null, 2)}\n`, 'utf8')
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return loadPreparedModel(dir, { kind: 'custom' })
}

async function resolveBuiltin(id) {
  const model = builtinModel(id)
  try {
    return await loadPreparedModel(model.dir, { kind: 'builtin', id: model.id })
  } catch (error) {
    if (model.id === 'ds-q') throw error
    try {
      const fallback = await loadPreparedModel(builtinModels[0].dir, {
        kind: 'builtin',
        id: builtinModels[0].id,
      })
      return {
        ...fallback,
        error: `builtin model ${model.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    } catch {
      throw error
    }
  }
}

/**
 * Resolve the active model. Explicit developer config wins, then the user's
 * active.json selection, then the shipped default. A broken custom selection
 * falls back to the default built-in and carries the error to health.
 */
export async function resolveModel(config = {}) {
  const explicit = config.live2d?.modelDir
  if (explicit) {
    try {
      return { ...(await loadPreparedModel(explicit, { kind: 'default' })), explicit: true }
    } catch {}
  }

  const active = await readActiveModel()
  if (active.kind === 'custom') {
    const dir = join(customModelRoot, active.id)
    try {
      return { ...(await prepareCustomModel(dir)), id: active.id, kind: 'custom' }
    } catch (error) {
      try {
        return {
          ...(await resolveBuiltin('ds-q')),
          error: `custom model ${active.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        }
      } catch {}
      return {
        dir: null,
        error: `custom model ${active.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  try {
    return await resolveBuiltin(active.id)
  } catch (error) {
    return {
      dir: null,
      error: `builtin model ${active.id} failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function readPackageMeta() {
  try {
    const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    return { name: pkg.name, version: pkg.version, description: pkg.description }
  } catch {
    return { name: 'dsh-dstuber', version: '0.0.0', description: '' }
  }
}
