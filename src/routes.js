import { createReadStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { stat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizePatch, resolveConfig } from './config.js'
import { resolveModel, stageDir } from './model.js'
import { sendChat } from './chat.js'
import {
  adaptModel,
  buildCustomEmotion,
  patchProfileSemantics,
  pendingSemantics,
  readProfile,
  writeProfile,
} from './adapt.js'

const API = '/plugins/dsh-dstuber'
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.moc3': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
}

function contentType(file) {
  if (file.endsWith('.motion3.json')) return 'application/json; charset=utf-8'
  if (file.endsWith('.exp3.json')) return 'application/json; charset=utf-8'
  if (file.endsWith('.physics3.json')) return 'application/json; charset=utf-8'
  if (file.endsWith('.cdi3.json')) return 'application/json; charset=utf-8'
  return MIME[extname(file).toLowerCase()] || 'application/octet-stream'
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  })
  res.end(data)
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  if (isAppOrigin(req)) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * The Tauri shell serves its settings page from its own origin, so the model
 * adapter API is called cross-origin from there. Only those exact origins are
 * accepted; every other cross-origin caller still needs a matching host.
 */
const APP_ORIGINS = new Set([
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
])

function isAppOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return false
  if (APP_ORIGINS.has(origin)) return true
  try {
    return new URL(origin).hostname === 'tauri.localhost'
  } catch {
    return false
  }
}

async function readJson(req, limit = 512 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('body-too-large'), { status: 413 })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('invalid-json'), { status: 400 })
  }
}

function inside(base, target) {
  const root = normalize(base + sep).toLowerCase()
  return normalize(target).toLowerCase().startsWith(root)
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Recursive merge used for nested config sections. */
function merge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? merge(out[key], value) : value
  }
  return out
}

/** Stable revision for one raw override layer (FNV-1a). */
function revisionOf(override) {
  const text = JSON.stringify(override ?? {})
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `r${(hash >>> 0).toString(16)}`
}

async function serveFile(res, baseDir, relative) {
  const cleaned = decodeURIComponent(relative).replace(/^\/+/, '')
  if (cleaned.split(/[\\/]/).includes('..')) {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }
  let file = join(baseDir, cleaned || 'index.html')
  if (!inside(baseDir, file)) {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }
  let info
  try {
    info = await stat(file)
  } catch {
    sendJson(res, 404, { error: 'not-found', path: cleaned })
    return
  }
  if (info.isDirectory()) {
    file = join(file, 'index.html')
    try {
      info = await stat(file)
    } catch {
      sendJson(res, 404, { error: 'not-found', path: cleaned })
      return
    }
  }
  res.writeHead(200, {
    'content-type': contentType(file),
    'content-length': info.size,
    'cache-control': cleaned.startsWith('vendor/') ? 'public, max-age=86400' : 'no-store',
  })
  createReadStream(file).pipe(res)
}

/**
 * Register one prefix route that owns every dsh-dstuber HTTP endpoint. All
 * handlers are loopback-only; writes additionally require a same-origin
 * browser request (the Tauri shell will use a one-time token later).
 */
export function createRoutes({ ctx, store, getConfig, log = console, version = '0.0.0', shellStatus = null, shell = null, petBrain = null, voice = null, gsv = null, engines = null, authenticatedUrl = null }) {
  const dataDir = join(packageRoot, '.webview2')

  /** The active model identity used as the profile key. */
  async function activeModelKey() {
    const model = await resolveModel(getConfig())
    if (!model.dir) {
      return { model, modelKey: null, error: model.error || 'model-missing' }
    }
    const kind = model.kind === 'custom' ? 'custom' : model.kind === 'default' ? 'default' : 'builtin'
    const id = model.id || basename(model.dir)
    return { model, modelKey: `${kind}-${id}`, kind, id }
  }

  /**
   * Analysis pass for owner-defined expression tags: the default model turns
   * each tag into an emotion word, trigger keywords and a parameter tendency,
   * which becomes a normal emotion recipe the performer can play.
   */
  function pendingCustomTags(profile) {
    const tags = new Set()
    for (const expression of profile?.expressions || []) {
      if (expression.customTag) tags.add(expression.customTag)
    }
    const analyzed = profile?.customSemantics || {}
    return [...tags].filter((tag) => !analyzed[tag])
  }

  async function publishCustomTags(profile) {
    const tags = Object.keys(profile?.customSemantics || {})
    try {
      await mkdir(join(dataDir, 'live2d'), { recursive: true })
      await writeFile(
        join(dataDir, 'live2d', 'custom-tags.json'),
        `${JSON.stringify({ tags, updatedAt: new Date().toISOString() }, null, 2)}\n`,
        'utf8',
      )
    } catch {}
  }

  async function analyzeCustomTags(profile) {
    const pending = pendingCustomTags(profile)
    if (pending.length === 0) {
      await publishCustomTags(profile)
      return false
    }
    const llm = ctx.get('llm')
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (!llm?.stream || !selection?.provider || !selection?.model) return false
    const prompt = [
      '你是 Live2D 桌宠的表情标签分析器。把每个自定义表情标签分析成情绪配方。',
      '对每个标签输出：',
      '- emotion: 英文小写情绪词，例如 sleepy',
      '- keywords: 3-5 个会触发这个词的中文关键词',
      '- summary: 10 个字以内的中文解释',
      '- recipe: {"eyes":"normal|half|closed|smile|angry|wide","brows":"normal|up|down|inner|outer","mouth":"normal|smile|frown|pout|open","head":"normal|down|up|tilt_left|tilt_right"}',
      '只输出一个 JSON 对象，键是标签原文，不要解释、不要 Markdown。',
      '标签：',
      ...pending.map((tag) => `- ${tag}`),
    ].join('\n')
    try {
      let text = ''
      for await (const chunk of llm.stream({
        provider: selection.provider,
        model: selection.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 600,
        temperature: 0.2,
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      }
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start < 0 || end <= start) return false
      const mapping = JSON.parse(text.slice(start, end + 1))
      profile.customSemantics = profile.customSemantics || {}
      profile.emotions = profile.emotions || {}
      let changed = false
      for (const [tag, analysis] of Object.entries(mapping)) {
        if (!pending.includes(tag) || !analysis || typeof analysis !== 'object') continue
        profile.customSemantics[tag] = {
          emotion: String(analysis.emotion || tag).trim().toLowerCase(),
          keywords: Array.isArray(analysis.keywords)
            ? analysis.keywords.filter((word) => typeof word === 'string').slice(0, 6)
            : [],
          summary: typeof analysis.summary === 'string' ? analysis.summary.slice(0, 40) : '',
          recipe: analysis.recipe && typeof analysis.recipe === 'object' ? analysis.recipe : {},
          analyzedAt: new Date().toISOString(),
        }
        profile.emotions[tag] = buildCustomEmotion(profile.params, analysis)
        changed = true
      }
      if (changed) {
        await writeProfile(dataDir, profile)
        await publishCustomTags(profile)
        log.info?.('[dsh-dstuber] custom expression tags analysed')
      }
      return changed
    } catch (error) {
      log.warn?.(`[dsh-dstuber] custom tag analyse skipped: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Optional semantic pass: expressions whose names no rule matched are sent to
   * the default model once, so an artist's "01"/"05" still gets a meaning.
   * Everything stays local to the profile file; failures only skip the pass.
   */
  async function enrichProfile(profile) {
    const names = pendingSemantics(profile)
    if (names.length === 0) return
    const llm = ctx.get('llm')
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (!llm?.stream || !selection?.provider || !selection?.model) return
    const prompt = [
      '把下面这些 Live2D 表情名归类，只输出一个 JSON 对象，不要解释。',
      '值是以下之一：happy, shy, angry, sad, surprised, worried, proud, silly, awkward, pout, dizzy, mouth, cosmetic, unknown',
      '键是表情名本身：',
      ...names.map((name) => `- ${name}`),
    ].join('\n')
    try {
      let text = ''
      for await (const chunk of llm.stream({
        provider: selection.provider,
        model: selection.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 400,
        temperature: 0,
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      }
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start < 0 || end <= start) return
      const mapping = JSON.parse(text.slice(start, end + 1))
      let changed = false
      for (const expression of profile.expressions || []) {
        const label = mapping[expression.name] ?? mapping[expression.label]
        if (typeof label !== 'string') continue
        const semantic = label.trim().toLowerCase()
        if (!semantic || semantic === 'unknown') continue
        expression.semantic = semantic
        expression.kind = semantic === 'mouth' || semantic === 'cosmetic' ? semantic : 'emotion'
        expression.emotion = expression.kind === 'emotion' ? semantic : null
        expression.confidence = 0.6
        expression.reason = 'llm'
        changed = true
      }
      if (changed) {
        profile.enriched = true
        profile.unknownExpressions = pendingSemantics(profile)
        await writeProfile(dataDir, profile)
        log.info?.('[dsh-dstuber] model profile enriched by the default model')
      }
    } catch (error) {
      log.warn?.(`[dsh-dstuber] profile enrich skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Our row as the Loader sees it. In DSH 0.2.1 a bundle installs as an
   * `include:<name>` entry, which `settings.describe()` skips; `configEditor`
   * is the official write path for exactly these rows.
   */
  function configRow() {
    let editor
    try {
      editor = ctx.get('configEditor')
    } catch (error) {
      return { error: `ctx.get(configEditor): ${error instanceof Error ? error.message : String(error)}` }
    }
    if (!editor?.configuration || !editor?.edit) return { error: 'config-editor-unavailable' }
    try {
      const rows = editor.configuration()
      const row = rows.find(({ entry }) => {
        const id = String(entry?.options?.id ?? '')
        const name = String(entry?.options?.name ?? '')
        return id === 'dsh-dstuber' || id === 'include:dsh-dstuber' || id.endsWith(':dsh-dstuber') || id.endsWith('dsh-dstuber') || name === 'dsh-dstuber'
      })
      if (!row) {
        return {
          error: 'entry-not-found',
          ids: rows.map(({ entry }) => entry?.options?.id).filter(Boolean),
        }
      }
      return { row, editor }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  function currentValue(row) {
    return resolveConfig(merge(row?.inherited ?? {}, row?.override ?? {}))
  }

  function publicConfig() {
    const found = configRow()
    if (!found.row) {
      const value = resolveConfig(getConfig())
      const clone = JSON.parse(JSON.stringify(value ?? {}))
      return { source: 'memory', revision: 'r0', value: clone, error: found.error ?? null }
    }
    const clone = JSON.parse(JSON.stringify(currentValue(found.row)))
    return {
      source: 'configEditor',
      entry: found.row.entry?.options?.id ?? null,
      revision: revisionOf(found.row.override),
      value: clone,
    }
  }

  async function handler(req, res) {
    if (!isLoopback(req)) {
      sendJson(res, 403, { error: 'loopback-only' })
      return
    }
    if (isAppOrigin(req)) {
      res.setHeader('access-control-allow-origin', req.headers.origin)
      res.setHeader('access-control-allow-methods', 'GET,HEAD,POST,PATCH,OPTIONS')
      res.setHeader('access-control-allow-headers', 'content-type')
      res.setHeader('vary', 'origin')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      sendJson(res, 403, { error: 'cross-origin' })
      return
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname
    const method = req.method || 'GET'

    try {
      if (path === `${API}/api/health` && method === 'GET') {
        const model = await resolveModel(getConfig())
        sendJson(res, 200, {
          ok: true,
          name: 'dsh-dstuber',
          version,
          time: Date.now(),
          settings: (() => {
            const found = configRow()
            return {
              available: !!found.row,
              entry: found.row?.entry?.options?.id ?? null,
              revision: found.row ? revisionOf(found.row.override) : null,
              error: found.error ?? null,
              source: found.row ? 'configEditor' : 'memory',
            }
          })(),
          model: {
            dir: model.dir,
            augmented: model.augmented ?? null,
            error: model.error ?? null,
            manifest: model.manifest
              ? {
                  name: model.manifest.name,
                  expressions: model.manifest.expressions?.length ?? 0,
                  motions: model.manifest.motions
                    ? Object.fromEntries(Object.entries(model.manifest.motions).map(([group, names]) => [group, names.length]))
                    : {},
                  lipSyncParam: model.manifest.lipSyncParam,
                }
              : null,
          },
          stage: { dir: stageDir },
          shell: typeof shellStatus === 'function' ? shellStatus() : null,
          voice: voice?.status?.() ?? null,
          store: (() => {
            const snapshot = store.snapshot()
            return { sessions: snapshot.sessions.length, active: snapshot.active, pet: snapshot.pet.state }
          })(),
        })
        return
      }

      if (path === `${API}/api/config` && method === 'GET') {
        sendJson(res, 200, { ok: true, ...publicConfig() })
        return
      }

      if (path === `${API}/api/config` && method === 'PATCH') {
        const body = await readJson(req)
        const patch = normalizePatch(body?.patch ?? body)
        if (!Object.keys(patch).length) {
          sendJson(res, 400, { error: 'empty-patch' })
          return
        }
        const found = configRow()
        if (!found.row) {
          sendJson(res, 503, { error: 'settings-unavailable', detail: found.error ?? null })
          return
        }
        const currentRevision = revisionOf(found.row.override)
        if (body?.revision != null && String(body.revision) !== currentRevision) {
          sendJson(res, 409, { error: 'revision-conflict', actual: currentRevision, expected: String(body.revision) })
          return
        }
        const nextOverride = merge(found.row.override ?? {}, patch)
        try {
          await found.editor.edit(found.row.entry, (raw) => merge(raw ?? {}, patch))
        } catch (error) {
          log.warn?.(`[dsh-dstuber] config edit failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 400, { error: 'config-rejected', detail: error instanceof Error ? error.message : String(error) })
          return
        }
        const merged = resolveConfig(merge(found.row.inherited ?? {}, nextOverride))
        const clone = JSON.parse(JSON.stringify(merged))
        sendJson(res, 200, {
          ok: true,
          source: 'configEditor',
          entry: found.row.entry?.options?.id ?? null,
          revision: revisionOf(nextOverride),
          value: clone,
        })
        return
      }

      if (path === `${API}/api/state` && method === 'GET') {
        sendJson(res, 200, { ok: true, snapshot: store.snapshot() })
        return
      }

      if (path === `${API}/api/catalog` && method === 'GET') {
        const model = await resolveModel(getConfig())
        sendJson(res, 200, {
          ok: true,
          model,
          stage: { url: `${API}/stage/?bg=none&hud=1` },
          studio: { url: `${API}/stage/?bg=grid&hud=1&selftest=1` },
        })
        return
      }

      if (path === `${API}/api/events` && method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(`data: ${JSON.stringify({ type: 'snapshot', snapshot: store.snapshot() })}\n\n`)
        const off = store.subscribe((message) => {
          try {
            res.write(`data: ${JSON.stringify(message)}\n\n`)
          } catch {}
        })
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n')
          } catch {}
        }, 15000)
        const close = () => {
          clearInterval(ping)
          off()
          try { res.end() } catch {}
        }
        req.on('close', close)
        req.on('error', close)
        return
      }

      if (path.startsWith(`${API}/api/tts/`) && method === 'GET') {
        if (!voice?.audioDir) {
          sendJson(res, 404, { error: 'voice-unavailable' })
          return
        }
        await serveFile(res, voice.audioDir, path.slice(`${API}/api/tts/`.length))
        return
      }

      if (path === `${API}/api/stage-report` && method === 'POST') {
        const body = await readJson(req, 2 * 1024 * 1024)
        const report = store.noteStageReport(body)
        sendJson(res, 200, { ok: true, receivedAt: report.receivedAt })
        return
      }

      if (path === `${API}/api/stage-report` && method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          report: store.report,
          // The one-off self-check survives heartbeats overwriting `report`.
          selftest: store.selftest,
        })
        return
      }

      if (path === `${API}/api/chat` && method === 'POST') {
        const body = await readJson(req)
        const result = sendChat(ctx, body, { active: store.active }, log)
        sendJson(res, result.ok ? 200 : result.status || 500, result)
        return
      }

      if (path === `${API}/api/pet-chat` && method === 'POST') {
        const body = await readJson(req)
        const result = sendChat(ctx, body, { active: store.active }, log)
        if (!result.ok) {
          sendJson(res, result.status || 500, result)
          return
        }
        const text = typeof body?.text === 'string' ? body.text.trim() : ''
        // The line is relayed into the DSH session; the pet answers from that
        // session's user/message event, so there is only one reply path.
        if (petBrain && text) store.notePetStatus('深度思考中…', 'busy')
        sendJson(res, 200, { ...result, pet: !!petBrain })
        return
      }

      if (path === `${API}/api/persona` && method === 'GET') {
        const info = petBrain?.personaInfo?.() ?? { name: '人设原文.md', isDefault: true }
        sendJson(res, 200, { ok: true, ...info })
        return
      }

      if (path === `${API}/api/pet-capabilities` && method === 'GET') {
        const subagents = ctx.get('subagents')
        const agents = ctx.get('agents')?.list?.() ?? []
        sendJson(res, 200, {
          ok: true,
          subagents: !!subagents,
          spawn: !!subagents?.getProvider?.('spawn'),
          agents: agents.length,
          active: store.active ?? null,
        })
        return
      }

      if (path === `${API}/api/pet-brain-test` && method === 'POST') {
        const body = await readJson(req)
        const text = typeof body?.text === 'string' && body.text.trim()
          ? body.text.trim()
          : '你好呀，今天想和本鱼聊点什么？'
        const agent = ctx.get('agents')?.list?.().find((item) => item.id === store.active)
        if (!petBrain || !agent) {
          sendJson(res, 409, { ok: false, error: 'no-agent' })
          return
        }
        petBrain.onUserMessage({
          text,
          parent: agent,
          sessionId: store.active,
          state: 'sent',
        }).catch((error) => {
          log.warn?.(`[dsh-dstuber] pet-brain-test failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        sendJson(res, 200, { ok: true })
        return
      }

      if (path === `${API}/api/voice/setup` && method === 'POST') {
        const script = join(packageRoot, 'scripts', 'setup-voice.ps1')
        const result = await new Promise((resolve) => {
          let stdout = ''
          let stderr = ''
          const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
            { cwd: packageRoot, windowsHide: true },
          )
          child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
          child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
          child.on('error', (error) => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }))
          child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
        })
        sendJson(res, result.code === 0 ? 200 : 500, {
          ok: result.code === 0,
          ...result,
          tail: `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-12).join('\n'),
        })
        return
      }

      if (path === `${API}/stage`) {
        res.writeHead(302, { location: `${API}/stage/` })
        res.end()
        return
      }

      if (path.startsWith(`${API}/stage/`)) {
        await serveFile(res, stageDir, path.slice(`${API}/stage/`.length))
        return
      }

      // Global display preference shared by every model: how much of the
      // character the pet window shows.
      // Voice engine inventory: what is installed/usable and which one is active.
      if (path === `${API}/api/engines` && method === 'GET') {
        if (!engines) {
          sendJson(res, 503, { ok: false, error: 'engines-unavailable' })
          return
        }
        sendJson(res, 200, { ok: true, ...(await engines.status()) })
        return
      }

      if (path === `${API}/api/engines/select` && method === 'POST') {
        if (!engines) {
          sendJson(res, 503, { ok: false, error: 'engines-unavailable' })
          return
        }
        const body = await readJson(req)
        sendJson(res, 200, engines.select(body?.engine))
        return
      }

      // GPT-SoVITS service control: start/stop the user's local engine. The
      // plugin never bundles it; it only supervises the process.
      if (path === `${API}/api/gsv/status` && method === 'GET') {
        sendJson(res, 200, { ok: true, gsv: gsv ? await gsv.status() : null })
        return
      }

      if (path === `${API}/api/gsv/start` && method === 'POST') {
        if (!gsv) {
          sendJson(res, 503, { ok: false, error: 'gsv-unavailable' })
          return
        }
        sendJson(res, 200, await gsv.start())
        return
      }

      if (path === `${API}/api/gsv/stop` && method === 'POST') {
        if (!gsv) {
          sendJson(res, 503, { ok: false, error: 'gsv-unavailable' })
          return
        }
        sendJson(res, 200, await gsv.stop())
        return
      }

      if (path === `${API}/api/gsv/config` && method === 'PATCH') {
        if (!gsv) {
          sendJson(res, 503, { ok: false, error: 'gsv-unavailable' })
          return
        }
        const body = await readJson(req)
        const saved = gsv.saveConfig({
          appDir: body?.appDir,
          python: body?.python,
          autoStart: body?.autoStart,
        })
        sendJson(res, 200, { ok: true, config: { appDir: saved.appDir, python: saved.python, autoStart: saved.autoStart } })
        return
      }

      // Pet lifecycle: start/quit from the DSH plugin card (and the pet menu).
      // Quitting stops every pet service but keeps all data on disk.
      if (path === `${API}/api/shell/start` && method === 'POST') {
        if (!shell) {
          sendJson(res, 503, { ok: false, error: 'shell-unavailable' })
          return
        }
        try {
          const host = req.headers.host || '127.0.0.1:3080'
          shell.start({
            url: authenticatedUrl ? authenticatedUrl(`http://${host}/plugins/dsh-dstuber/stage/index.html?bg=none`) : `http://${host}/plugins/dsh-dstuber/stage/index.html?bg=none`,
            manual: true,
          })
          sendJson(res, 200, { ok: true, ...shell.status() })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error) })
        }
        return
      }

      if (path === `${API}/api/shell/quit` && method === 'POST') {
        const stopped = { shell: false, voice: false, gsv: false }
        try {
          shell?.stop()
          stopped.shell = true
        } catch {}
        try {
          voice?.stopWorker?.()
          stopped.voice = true
        } catch {}
        try {
          await gsv?.stop()
          stopped.gsv = true
        } catch {}
        sendJson(res, 200, { ok: true, stopped })
        return
      }

      if (path === `${API}/api/display` && method === 'GET') {
        let display = { framing: 'bust', activity: 'normal', doubleClickExpression: true }
        try {
          const stored = JSON.parse(await readFile(join(dataDir, 'display.json'), 'utf8'))
          if (stored && typeof stored === 'object') display = { ...display, ...stored }
        } catch {}
        sendJson(res, 200, { ok: true, display })
        return
      }

      if (path === `${API}/api/display` && method === 'PATCH') {
        const body = await readJson(req)
        const requestedFraming = body?.framing ?? body?.display?.framing
        const requestedActivity = body?.activity ?? body?.display?.activity
        const requestedDoubleClick = body?.doubleClickExpression ?? body?.display?.doubleClickExpression
        let display = { framing: 'bust', activity: 'normal', doubleClickExpression: true }
        try {
          const stored = JSON.parse(await readFile(join(dataDir, 'display.json'), 'utf8'))
          if (stored && typeof stored === 'object') display = { ...display, ...stored }
        } catch {}
        if (requestedFraming === 'full' || requestedFraming === 'bust') display.framing = requestedFraming
        if (requestedActivity === 'quiet' || requestedActivity === 'normal' || requestedActivity === 'lively') {
          display.activity = requestedActivity
        }
        if (typeof requestedDoubleClick === 'boolean') display.doubleClickExpression = requestedDoubleClick
        await mkdir(dataDir, { recursive: true })
        await writeFile(join(dataDir, 'display.json'), `${JSON.stringify(display, null, 2)}\n`, 'utf8')
        sendJson(res, 200, { ok: true, display })
        return
      }

      if (path === `${API}/api/model/profile` && method === 'GET') {        const active = await activeModelKey()
        if (!active.modelKey) {
          sendJson(res, 404, { ok: false, error: active.error })
          return
        }
        const profile = await readProfile(dataDir, active.modelKey)
        if (!profile) {
          sendJson(res, 404, {
            ok: false,
            error: 'profile-missing',
            modelKey: active.modelKey,
            needsAdapt: true,
          })
          return
        }
        sendJson(res, 200, { ok: true, modelKey: active.modelKey, profile })
        return
      }

      if (path === `${API}/api/model/adapt` && method === 'POST') {
        const active = await activeModelKey()
        if (!active.modelKey) {
          sendJson(res, 404, { ok: false, error: active.error })
          return
        }
        const profile = await adaptModel({
          dir: active.model.dir,
          kind: active.kind,
          id: active.id,
          name: active.model.manifest?.name,
          dataDir,
          log,
        })
        await writeProfile(dataDir, profile)
        void publishCustomTags(profile)
        void enrichProfile(profile)
        sendJson(res, 200, { ok: true, modelKey: active.modelKey, profile })
        return
      }

      if (path === `${API}/api/model/semantics` && method === 'PATCH') {
        const active = await activeModelKey()
        if (!active.modelKey) {
          sendJson(res, 404, { ok: false, error: active.error })
          return
        }
        const body = await readJson(req)
        const corrections = Array.isArray(body?.corrections) ? body.corrections : []
        const profile = await patchProfileSemantics(dataDir, active.modelKey, corrections)
        // Owner tags are analysed by the default model in the background; the
        // settings page can refresh the profile a moment later to see recipes.
        const hasCustomTag = (profile.expressions || []).some((entry) => entry.customTag)
        if (hasCustomTag) void analyzeCustomTags(profile)
        sendJson(res, 200, { ok: true, modelKey: active.modelKey, profile })
        return
      }

      if (path.startsWith(`${API}/model/`)) {
        const model = await resolveModel(getConfig())
        if (!model.dir) {
          sendJson(res, 404, { error: 'model-missing', detail: model.error })
          return
        }
        await serveFile(res, model.dir, path.slice(`${API}/model/`.length))
        return
      }

      sendJson(res, 404, { error: 'not-found', path })
    } catch (error) {
      const status = error?.status || 500
      log.warn?.(`[dsh-dstuber] route ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) sendJson(res, status, { error: error?.message || 'internal-error' })
      else try { res.end() } catch {}
    }
  }

  return { handler, publicConfig }
}
