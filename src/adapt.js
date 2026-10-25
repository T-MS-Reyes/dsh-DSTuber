import { readFile, readdir, writeFile, mkdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/**
 * Live2D model adapter.
 *
 * A model does not describe what its pieces mean: `cdi3.json` only lists
 * parameter ids/names, and an `.exp3.json` only says which parameters it adds
 * to. This module inspects a prepared model directory and derives a portable
 * profile: which parameter is the mouth, which are brows/arms, which switch
 * parameters drive the artist's expressions, and what each expression probably
 * means. The renderer consumes the profile instead of hard-coded parameter
 * names, so a new model is a button press rather than a code change.
 */

const PROFILE_VERSION = 1

const STANDARD_GROUPS = {
  eyeBlink: ['ParamEyeLOpen', 'ParamEyeROpen'],
  lipSync: ['ParamMouthOpenY'],
}

/** Ordered semantic rules: first match wins. Names come from the artist. */
const SEMANTIC_RULES = [
  { semantic: 'blush', test: [/脸红/, /\bblush\b/i, /shy/i, /害羞/, /羞/, /红脸/], emotion: 'shy' },
  { semantic: 'angry', test: [/脸黑/, /生气/, /怒/, /黑脸/, /\banger\b/i, /\bangry\b/i], emotion: 'angry' },
  { semantic: 'sad', test: [/哭/, /泪/, /\bsad\b/i, /\bcry\b/i, /悲/, /委屈/], emotion: 'sad' },
  { semantic: 'happy', test: [/笑/, /\bsmile\b/i, /\bhappy\b/i, /开[心怀]/, /喜/], emotion: 'happy' },
  { semantic: 'dizzy', test: [/x[\s_-]*x/i, /晕/, /\bdizzy\b/i, /眼花/], emotion: 'dizzy' },
  { semantic: 'surprised', test: [/o[\s_-]*o/i, /惊/, /surprise/i, /震惊/, /吃[惊鲸]/], emotion: 'surprised' },
  { semantic: 'worried', test: [/担心/, /worry/i, /愁/, /忧/, /不安/], emotion: 'worried' },
  { semantic: 'proud', test: [/龇牙/, /\bgrin\b/i, /得意/, /自豪/], emotion: 'proud' },
  { semantic: 'silly', test: [/流口水/, /口水/, /drool/i, /呆/, /傻/], emotion: 'happy' },
  { semantic: 'awkward', test: [/》\s*《/, />\s*</, /尴尬/, /无语/], emotion: 'annoyed' },
  { semantic: 'pout', test: [/栗子/, /包子/, /嘟嘴/, /\bpout\b/i], emotion: 'annoyed' },
]

/** Names that are toggles/settings rather than emotional expressions. */
const NON_EMOTION_RULES = [
  { kind: 'mouth', test: [/口型/, /嘴巴/, /嘴/, /mouth/i] },
  { kind: 'cosmetic', test: [/尾巴/, /耳朵/, /水印/, /消失/, /hide/i, /remove/i] },
  { kind: 'overlay', test: [/眼罩/, /墨镜/, /面具/] },
]

const ARM_PATTERN = /arm|手臂|腕|肩/i
const BROW_PATTERN = /brow|眉/i

/**
 * Emotion recipes in profile-parameter terms. Every key is optional: the
 * adapter only emits the ones this model actually exposes, so a model without
 * brows still gets eyes/mouth acting. `effect` names an artist switch expression
 * from the model itself (blush/blush-style param toggle).
 */
const EMOTION_RECIPES = {
  neutral: {},
  happy: { eyeSmile: 0.8, browY: 0.15, mouthForm: 0.55 },
  shy: { eyeSmile: 0.45, browY: -0.1, mouthForm: 0.3, angleZ: 3, effect: 'blush' },
  angry: { eyeAnger: 0.7, browY: -0.35, browForm: -0.5, mouthForm: -0.5, effect: 'angry' },
  sad: { browY: -0.25, browForm: 0.45, mouthForm: -0.4 },
  surprised: { browY: 0.55, mouthForm: 0.1, effect: 'surprised' },
  worried: { browForm: 0.5, browY: -0.15, mouthForm: -0.25, effect: 'worried' },
  proud: { eyeSmile: 0.6, browY: 0.2, angleY: -3, mouthForm: 0.4, effect: 'proud' },
  silly: { eyeSmile: 0.35, mouthForm: 0.2, effect: 'silly' },
  awkward: { browForm: -0.35, mouthForm: -0.25, angleZ: -4, effect: 'awkward' },
  pout: { browY: -0.2, mouthForm: -0.55, effect: 'pout' },
  dizzy: { eyeOpen: 0.2, effect: 'dizzy' },
  focused: { browY: -0.25, browForm: -0.2, mouthForm: -0.1 },
  curious: { browY: 0.2, angleZ: 4, eyeSmile: 0.2 },
  annoyed: { browY: -0.3, mouthForm: -0.4 },
  sleepy: { eyeOpen: 0.3, browY: -0.15, angleY: 4 },
}

/** Map a recipe key onto the concrete parameter id this model exposes. */
function emotionParamId(params, key) {
  switch (key) {
    case 'eyeSmile': return params.eyeSmile
    case 'eyeAnger': return params.eyeAnger
    case 'browY': return params.browL || params.browR || null
    case 'browForm': return params.browFormL || params.browFormR || null
    case 'mouthForm': return params.mouthForm
    case 'angleY': return params.angleY
    case 'angleZ': return params.angleZ
    case 'eyeOpen': return params.eyeL
    default: return null
  }
}

function buildEmotions(params, expressions) {
  const switchByName = {}
  for (const expression of expressions) {
    if (expression.kind !== 'emotion' || !expression.semantic) continue
    const switchParam = (expression.switches || [])[0]
    if (!switchParam) continue
    switchByName[expression.semantic] = { param: switchParam.id, value: switchParam.value }
  }
  const emotions = {}
  for (const [emotion, recipe] of Object.entries(EMOTION_RECIPES)) {
    const values = {}
    for (const [key, value] of Object.entries(recipe)) {
      if (key === 'effect') continue
      const id = emotionParamId(params, key)
      if (id) values[id] = value
    }
    const effect = recipe.effect && switchByName[recipe.effect]
      ? { param: switchByName[recipe.effect].param, value: switchByName[recipe.effect].value }
      : null
    emotions[emotion] = { params: values, effect, fadeOutMs: 1680 }
  }
  return emotions
}


async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function safeRelative(dir, reference) {
  const normalized = String(reference || '').replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return null
  return join(dir, ...normalized.split('/'))
}

function modelFiles(dir) {
  return {
    augmented: join(dir, 'model3.augmented.json'),
    plain: join(dir, 'model3.json'),
    manifest: join(dir, 'manifest.json'),
    meta: join(dir, 'meta.json'),
  }
}

function semanticFor(...texts) {
  const joined = texts.filter(Boolean).map(String).join(' ')
  for (const rule of SEMANTIC_RULES) {
    if (rule.test.some((pattern) => pattern.test(joined))) {
      return { semantic: rule.semantic, emotion: rule.emotion, kind: 'emotion', confidence: 0.85, reason: 'rule' }
    }
  }
  for (const rule of NON_EMOTION_RULES) {
    if (rule.test.some((pattern) => pattern.test(joined))) {
      return { semantic: null, kind: rule.kind, confidence: 0.9, reason: `non-emotion:${rule.kind}` }
    }
  }
  return { semantic: null, kind: 'unknown', confidence: 0, reason: 'unmatched' }
}

function detectParams(parameters, groups) {
  const ids = new Set(parameters.map((param) => param.Id))
  const has = (id) => ids.has(id)
  const find = (...candidates) => candidates.find((id) => id && has(id)) || null
  const group = (name) => {
    const entry = (groups || []).find((item) => item?.Name === name)
    return Array.isArray(entry?.Ids) ? entry.Ids.filter(Boolean) : []
  }
  const lipSync = group('LipSync')
  const eyeBlink = group('EyeBlink')
  const armIds = parameters
    .map((param) => param.Id)
    .filter((id) => ARM_PATTERN.test(id) || ARM_PATTERN.test(String(parameters.find((p) => p.Id === id)?.Name || '')))
  const browIds = parameters
    .map((param) => param.Id)
    .filter((id) => BROW_PATTERN.test(id) || BROW_PATTERN.test(String(parameters.find((p) => p.Id === id)?.Name || '')))

  const params = {
    mouth: lipSync[0] || find(...STANDARD_GROUPS.lipSync) || null,
    mouthRange: 1,
    eyeL: eyeBlink[0] || find(...STANDARD_GROUPS.eyeBlink.slice(0, 1)) || find('ParamEyeLOpen') || null,
    eyeR: eyeBlink[1] || find(...STANDARD_GROUPS.eyeBlink.slice(1)) || find('ParamEyeROpen') || null,
    eyeBallX: find('ParamEyeBallX'),
    eyeBallY: find('ParamEyeBallY'),
    angleX: find('ParamAngleX'),
    angleY: find('ParamAngleY'),
    angleZ: find('ParamAngleZ'),
    bodyX: find('ParamBodyAngleX'),
    bodyY: find('ParamBodyAngleY'),
    breath: find('ParamBreath'),
    mouthForm: find('ParamMouthForm'),
    eyeSmile: find('ParamEyeSmile'),
    eyeAnger: find('ParamEyeAnger'),
    eyePuff: find('ParamEyePuff'),
    browL: browIds[0] || find('ParamBrowLY'),
    browR: browIds[1] || find('ParamBrowRY'),
    browFormL: find('ParamBrowLForm'),
    browFormR: find('ParamBrowRForm'),
    brows: browIds,
    arms: armIds.map((id) => id),
  }
  params.mouthRange = params.mouth === 'ParamMouthOpenY' ? 1 : 1
  return params
}

function capabilitiesOf(params, motions) {
  const motionGroups = Object.keys(motions || {})
  return {
    hasMouth: !!params.mouth,
    hasEyes: !!params.eyeL,
    hasEyeBall: !!(params.eyeBallX && params.eyeBallY),
    hasBrows: params.brows.length > 0,
    hasArms: params.arms.length > 0,
    hasBreath: !!params.breath,
    hasHead: !!(params.angleX || params.angleY),
    hasMotions: motionGroups.length > 0,
    motionGroups,
    lipSync: !!params.mouth,
  }
}

async function readExpressions(dir, refs) {
  const listed = Array.isArray(refs.Expressions) ? refs.Expressions : []
  const entries = []
  if (listed.length > 0) {
    for (const item of listed) entries.push({ Name: item.Name, File: item.File })
  }
  const expressions = []
  for (const entry of entries) {
    const file = safeRelative(dir, entry.File)
    if (!file || !(await exists(file))) {
      expressions.push({
        name: entry.Name,
        file: entry.File,
        error: 'file-missing',
      })
      continue
    }
    let payload = null
    try {
      payload = await readJson(file)
    } catch (error) {
      expressions.push({ name: entry.Name, file: entry.File, error: String(error).slice(0, 120) })
      continue
    }
    const parameters = Array.isArray(payload?.Parameters) ? payload.Parameters : []
    const switches = parameters
      .filter((param) => typeof param?.Id === 'string')
      .map((param) => ({
        id: param.Id,
        value: Number(param.Value) || 0,
        blend: param.Blend || 'Add',
      }))
    const displayName = String(basename(entry.File || entry.Name || '')).replace(/\.exp3\.json$/i, '')
    const meaning = semanticFor(entry.Name, displayName)
    expressions.push({
      name: entry.Name,
      label: displayName || entry.Name,
      file: entry.File,
      kind: meaning.kind,
      semantic: meaning.semantic,
      emotion: meaning.emotion || null,
      confidence: meaning.confidence,
      reason: meaning.reason,
      switches,
    })
  }
  return expressions
}

async function readMotions(dir, refs) {
  const groups = refs.Motions && typeof refs.Motions === 'object' ? refs.Motions : {}
  const output = {}
  for (const [group, list] of Object.entries(groups)) {
    if (!Array.isArray(list)) continue
    const entries = []
    for (const item of list) {
      const file = safeRelative(dir, item.File)
      let duration = null
      let loop = null
      if (file && (await exists(file))) {
        try {
          const payload = await readJson(file)
          const meta = payload?.Meta || {}
          duration = Number.isFinite(meta.Duration) ? meta.Duration : null
          loop = meta.Loop === true
        } catch {}
      }
      entries.push({ file: item.File, duration, loop })
    }
    output[group] = entries
  }
  return output
}

/**
 * Motion scheduling plan, modeled on Open-LLM-VTuber's model_dict: the artist's
 * motion groups are classified once (idle / talk / tap / gesture) so the stage
 * can loop idle motions, play talk motions while speaking, and trigger the rest
 * on its own. Models without motions simply get a null plan.
 */
export function buildMotionPlan(motions = {}) {
  const groups = {}
  for (const [name, entries] of Object.entries(motions || {})) {
    groups[name] = Array.isArray(entries) ? entries : []
  }
  const names = Object.keys(groups).filter((name) => groups[name].length > 0)
  if (names.length === 0) return null
  const pick = (patterns) => names.find((name) => patterns.some((pattern) => pattern.test(name))) || null
  const idle = pick([/^idle$/i, /idle|standby|wait/i, /待机|静止/i]) || names[0]
  const talk = pick([/^talk$/i, /talk|speak|speech/i, /说话|讲话/i])
  const tap = pick([/^tap/i, /tap|hit|touch|poke/i, /点击|戳/i])
  const gestures = names.filter((name) => name !== idle && name !== talk && name !== tap)
  return {
    idle,
    talk,
    tap,
    gestures,
    groups,
  }
}

/**
 * Turn an owner-defined tag's analysis into a runnable emotion recipe.
 * The analysis is produced by the default model (see routes): eyes/brows/mouth/
 * head tendencies, keywords and a one-line summary.
 */
export function buildCustomEmotion(params, analysis = {}) {
  const recipe = analysis?.recipe || {}
  const values = {}
  const set = (id, value) => {
    if (id) values[id] = value
  }
  if (recipe.eyes === 'half') {
    set(params.eyeL, 0.35)
    set(params.eyeR, 0.35)
  } else if (recipe.eyes === 'smile') {
    set(params.eyeSmile, 0.7)
  } else if (recipe.eyes === 'angry') {
    set(params.eyeAnger, 0.7)
  } else if (recipe.eyes === 'closed') {
    set(params.eyeL, 0.05)
    set(params.eyeR, 0.05)
  }
  if (recipe.brows === 'up') set(params.browL, 0.3)
  else if (recipe.brows === 'down') set(params.browL, -0.3)
  else if (recipe.brows === 'inner') set(params.browFormL, 0.45)
  else if (recipe.brows === 'outer') set(params.browFormL, -0.45)
  if (recipe.mouth === 'smile') set(params.mouthForm, 0.5)
  else if (recipe.mouth === 'frown') set(params.mouthForm, -0.45)
  else if (recipe.mouth === 'pout') set(params.mouthForm, -0.55)
  else if (recipe.mouth === 'open') set(params.mouthForm, 0.2)
  if (recipe.head === 'down') set(params.angleY, 4)
  else if (recipe.head === 'up') set(params.angleY, -4)
  else if (recipe.head === 'tilt_left') set(params.angleZ, -4)
  else if (recipe.head === 'tilt_right') set(params.angleZ, 4)

  return {
    params: values,
    effect: null,
    fadeOutMs: 1680,
    custom: true,
    keywords: Array.isArray(analysis?.keywords) ? analysis.keywords : [],
    summary: typeof analysis?.summary === 'string' ? analysis.summary : '',
  }
}

/**
 * Shipped default mappings: the owner's expression targets for the built-in
 * models, kept in dev/live2d/default-profiles so a fresh install starts
 * configured. A user's own edits still win (see mergeOwnerEdits).
 */
async function readDefaultProfile(dataDir, modelKey) {
  try {
    const path = join(dataDir, '..', 'dev', 'live2d', 'default-profiles', `${modelKey}.json`)
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

function applyDefaultProfile(profile, preset) {
  if (!preset || !Array.isArray(preset.expressions)) return profile
  const byName = new Map(preset.expressions.map((entry) => [entry.name, entry]))
  let applied = 0
  for (const expression of profile.expressions || []) {
    const entry = byName.get(expression.name)
    if (!entry) continue
    if (entry.customTag) {
      expression.kind = 'custom'
      expression.customTag = entry.customTag
      expression.semantic = null
      expression.emotion = null
      expression.confidence = 1
      expression.reason = 'preset'
      applied += 1
    } else if (entry.semantic) {
      const kind = entry.semantic === 'mouth'
        ? 'mouth'
        : entry.semantic === 'cosmetic'
          ? 'cosmetic'
          : 'emotion'
      expression.kind = kind
      expression.semantic = entry.semantic
      expression.emotion = kind === 'emotion' ? entry.semantic : null
      expression.confidence = 1
      expression.reason = 'preset'
      applied += 1
    }
  }
  const semantics = preset.customSemantics && typeof preset.customSemantics === 'object'
    ? preset.customSemantics
    : {}
  profile.customSemantics = { ...semantics }
  profile.emotions = profile.emotions || {}
  for (const [tag, analysis] of Object.entries(profile.customSemantics)) {
    if (!profile.emotions[tag]) {
      profile.emotions[tag] = buildCustomEmotion(profile.params, analysis)
    }
  }
  if (applied > 0) {
    profile.notes = [...(profile.notes || []), `应用了 ${applied} 项默认表情映射`]
  }
  return profile
}

/**
 * Keep the owner's edits when a model is adapted again: manual semantic
 * mappings, custom tags and their analysed recipes survive re-adaptation.
 */
function mergeOwnerEdits(profile, previous) {
  if (!previous || typeof previous !== 'object') return profile
  const previousExpressions = new Map(
    (previous.expressions || []).map((entry) => [entry.name, entry]),
  )
  let kept = 0
  for (const expression of profile.expressions || []) {
    const old = previousExpressions.get(expression.name)
    if (!old) continue
    if (old.customTag) {
      expression.kind = 'custom'
      expression.customTag = old.customTag
      expression.semantic = null
      expression.emotion = null
      expression.confidence = 1
      expression.reason = 'custom'
      kept += 1
    } else if (old.reason === 'manual') {
      expression.kind = old.kind
      expression.semantic = old.semantic ?? null
      expression.emotion = old.emotion ?? null
      expression.confidence = old.confidence ?? 1
      expression.reason = 'manual'
      kept += 1
    }
  }
  const usedTags = new Set(
    (profile.expressions || []).map((entry) => entry.customTag).filter(Boolean),
  )
  const previousSemantics = previous.customSemantics || {}
  profile.customSemantics = {}
  profile.emotions = profile.emotions || {}
  for (const tag of usedTags) {
    const analysis = previousSemantics[tag]
    if (!analysis) continue
    profile.customSemantics[tag] = analysis
    const recipe = previous.emotions?.[tag]
    if (recipe) profile.emotions[tag] = recipe
  }
  if (kept > 0) {
    profile.notes = [...(profile.notes || []), `保留了 ${kept} 项手动表情映射`]
  }
  return profile
}

/** Derive a runnable profile from one prepared model directory. */
export async function adaptModel({ dir, kind = 'builtin', id = 'model', name, dataDir = null, log = console } = {}) {
  if (!dir) throw new Error('model-directory-missing')
  const files = modelFiles(dir)
  const modelPath = (await exists(files.augmented)) ? files.augmented : files.plain
  if (!(await exists(modelPath))) throw new Error('model3.json missing')
  const model = await readJson(modelPath)
  const refs = model.FileReferences || {}

  let displayName = name
  let manifest = null
  for (const candidate of [files.manifest, files.meta]) {
    try {
      const value = await readJson(candidate)
      if (candidate === files.manifest) manifest = value
      if (!displayName && typeof value?.name === 'string' && value.name.trim()) {
        displayName = value.name.trim()
      }
    } catch {}
  }
  displayName = displayName || basename(dir)

  let parameters = []
  if (refs.DisplayInfo) {
    const displayInfo = safeRelative(dir, refs.DisplayInfo)
    if (displayInfo && (await exists(displayInfo))) {
      try {
        const payload = await readJson(displayInfo)
        parameters = Array.isArray(payload?.Parameters) ? payload.Parameters : []
      } catch (error) {
        log.warn?.(`[dsh-dstuber] display info unreadable: ${String(error).slice(0, 120)}`)
      }
    }
  }

  const params = detectParams(parameters, model.Groups)
  // ParamMouthOpenY is a 0..1 parameter on standard Cubism models. The old
  // manifest value (2.1) multiplied the envelope past the clamp, which made the
  // mouth sit fully open for a whole sentence, so the profile keeps the real
  // range instead of inheriting that hand-tuned number.
  if (manifest?.lipSyncParam && typeof manifest.lipSyncParam === 'string') {
    params.mouth = manifest.lipSyncParam
  }
  params.mouthRange = 1
  const expressions = await readExpressions(dir, refs)
  const motions = await readMotions(dir, refs)
  const capabilities = capabilitiesOf(params, motions)

  const userExpressions = expressions.filter((entry) => entry.kind === 'emotion')
  const unknown = expressions.filter((entry) => entry.kind === 'unknown').map((entry) => entry.name)
  const profile = {
    version: PROFILE_VERSION,
    modelKey: `${kind}-${id}`,
    kind,
    id,
    name: displayName,
    generatedAt: new Date().toISOString(),
    enriched: unknown.length === 0,
    params,
    capabilities,
    // Framing is a model-level concern: a full-body model shrinks the face until
    // lip sync is invisible, so the stage shows a bust by default. The zoom is a
    // multiplier over the full-body fit and is meant to be tuned per model.
    framing: {
      mode: 'bust',
      zoom: 2.7,
      topGap: 10,
    },
    // Runtime emotion recipes: parameter targets + an artist switch expression.
    emotions: buildEmotions(params, expressions),
    // Owner-defined tags analysed by the default model on save (see routes).
    customSemantics: {},
    expressions,
    motions,
    // Group classification the stage uses to play artist motions.
    motionPlan: buildMotionPlan(motions),
    stats: {
      parameters: parameters.length,
      expressions: expressions.length,
      emotionExpressions: userExpressions.length,
      unknownExpressions: unknown.length,
      motionGroups: capabilities.motionGroups.length,
    },
    unknownExpressions: unknown,
    notes: [],
  }

  if (!capabilities.hasMouth) {
    profile.notes.push('没有找到口型参数，说话时无法驱动嘴型')
  }
  if (!capabilities.hasMotions) {
    profile.notes.push('模型没有 motion 文件，动作将使用程序化关键帧')
  }
  if (!capabilities.hasBrows) {
    profile.notes.push('没有眉毛参数，情绪表达只能依赖眼睛与嘴型')
  }
  if (!capabilities.hasArms) {
    profile.notes.push('没有手臂参数，挥手类动作会被禁用')
  }

  // Re-adapting must not wipe what the owner configured by hand. Shipped
  // defaults are applied first so a fresh install is already configured.
  if (dataDir) {
    try {
      const preset = await readDefaultProfile(dataDir, profile.modelKey)
      applyDefaultProfile(profile, preset)
    } catch (error) {
      log.warn?.(`[dsh-dstuber] default profile apply failed: ${String(error).slice(0, 120)}`)
    }
    try {
      const previous = await readProfile(dataDir, profile.modelKey)
      mergeOwnerEdits(profile, previous)
    } catch (error) {
      log.warn?.(`[dsh-dstuber] keep previous profile edits failed: ${String(error).slice(0, 120)}`)
    }
  }

  return profile
}

export function profileRoot(dataDir) {
  return join(dataDir, 'live2d', 'profiles')
}

export function profilePath(dataDir, modelKey) {
  return join(profileRoot(dataDir), `${String(modelKey).replace(/[^\w-]+/g, '_')}.json`)
}

export async function readProfile(dataDir, modelKey) {
  try {
    return await readJson(profilePath(dataDir, modelKey))
  } catch {
    return null
  }
}

export async function writeProfile(dataDir, profile) {
  const target = profilePath(dataDir, profile.modelKey)
  await mkdir(profileRoot(dataDir), { recursive: true })
  profile.updatedAt = new Date().toISOString()
  await writeFile(target, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  return profile
}

/** Apply manual semantic corrections and persist them. */
export async function patchProfileSemantics(dataDir, modelKey, corrections) {
  const profile = await readProfile(dataDir, modelKey)
  if (!profile) throw new Error('profile-missing')
  const byName = new Map()
  for (const entry of Array.isArray(corrections) ? corrections : []) {
    if (typeof entry?.name === 'string') byName.set(entry.name, entry)
    if (typeof entry?.id === 'string') byName.set(entry.id, entry)
  }
  for (const expression of profile.expressions || []) {
    const correction = byName.get(expression.name)
    if (!correction) continue
    const customTag = typeof correction.customTag === 'string' ? correction.customTag.trim() : ''
    if (customTag) {
      // Owner-defined label: the expression becomes a custom emotion and the
      // default model analyses it on save (see routes).
      expression.kind = 'custom'
      expression.customTag = customTag
      expression.semantic = null
      expression.emotion = null
      expression.confidence = 1
      expression.reason = 'custom'
      continue
    }
    expression.customTag = null
    const semantic = typeof correction.semantic === 'string' ? correction.semantic.trim() : ''
    const kind = semantic === 'mouth'
      ? 'mouth'
      : semantic === 'cosmetic'
        ? 'cosmetic'
        : semantic
          ? 'emotion'
          : 'ignored'
    expression.kind = kind
    expression.semantic = semantic || null
    expression.emotion = kind === 'emotion' ? semantic : null
    expression.confidence = semantic ? 1 : 0
    expression.reason = 'manual'
  }
  // Drop analyses that no expression refers to any more.
  const usedTags = new Set(
    (profile.expressions || [])
      .map((entry) => entry.customTag)
      .filter(Boolean),
  )
  for (const tag of Object.keys(profile.customSemantics || {})) {
    if (!usedTags.has(tag)) delete profile.customSemantics[tag]
  }
  profile.enriched = !(profile.expressions || []).some((entry) => entry.kind === 'unknown')
  profile.unknownExpressions = (profile.expressions || [])
    .filter((entry) => entry.kind === 'unknown')
    .map((entry) => entry.name)
  await writeProfile(dataDir, profile)
  return profile
}

/** Names that still need a semantic label (for the optional LLM pass). */
export function pendingSemantics(profile) {
  return (profile?.expressions || [])
    .filter((entry) => entry.kind === 'unknown')
    .map((entry) => entry.name)
    .filter(Boolean)
}
