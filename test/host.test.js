import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { apply } from '../src/index.js'

function mockContext() {
  const routes = []
  const state = { override: {}, inherited: {}, edits: 0 }
  const entry = { options: { id: 'include:dsh-dstuber', name: 'dsh-dstuber' } }
  const editor = {
    configuration() {
      return [{ entry, inherited: state.inherited, override: state.override }]
    },
    async edit(target, change) {
      assert.equal(target, entry)
      state.edits += 1
      state.override = change(state.override, state.inherited)
    },
  }
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    get(name) {
      if (name === 'configEditor') return editor
      if (name === 'webServer') return webServer
      if (name === 'sessions') return { list: () => [] }
      return undefined
    },
    on() {
      return () => {}
    },
    effect(fn) {
      fn()
      return () => {}
    },
    inject(deps, callback) {
      callback(ctx)
      return {}
    },
  }
  return { ctx, routes, editor, state }
}

function mockReq({ method = 'GET', url, body, origin } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  return Object.assign(stream, {
    method,
    url,
    headers: origin ? { origin } : {},
    socket: { remoteAddress: '127.0.0.1' },
  })
}

function mockRes() {
  const chunks = []
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  res.status = 0
  res.headers = {}
  res.headersSent = false
  res.writeHead = function writeHead(status, headers = {}) {
    this.status = status
    this.headers = headers
    this.headersSent = true
  }
  Object.defineProperty(res, 'body', {
    get() {
      return Buffer.concat(chunks).toString('utf8')
    },
  })
  return res
}

async function call(routes, options) {
  const res = mockRes()
  await routes[0].handler(mockReq(options), res)
  let json = null
  try { json = JSON.parse(res.body) } catch {}
  return { status: res.status, json, text: res.body }
}

test('host plugin registers the prefix route and serves health', async () => {
  const { ctx, routes } = mockContext()
  apply(ctx, {})
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/plugins/dsh-dstuber')
  assert.equal(routes[0].kind, 'prefix')

  const health = await call(routes, { url: '/plugins/dsh-dstuber/api/health' })
  assert.equal(health.status, 200)
  assert.equal(health.json.ok, true)
  assert.equal(health.json.name, 'dsh-dstuber')
  assert.equal(health.json.settings.source, 'configEditor')
  assert.equal(health.json.settings.entry, 'include:dsh-dstuber')
  assert.ok(health.json.model.manifest.expressions > 0)
  assert.ok(
    ['DS鲸鱼娘', 'DS鲸鱼娘（桌面Q版）'].includes(health.json.model.manifest.name),
    `unexpected active model: ${health.json.model.manifest.name}`,
  )
})

test('GET config exposes the resolved voice provider', async () => {
  const { ctx, routes, state } = mockContext()
  state.inherited = { voice: { provider: 'gpt-sovits', readMurmurs: 'all', volume: 0.5 } }
  apply(ctx, {})
  const response = await call(routes, { url: '/plugins/dsh-dstuber/api/config' })
  assert.equal(response.status, 200)
  assert.equal(response.json.value.voice.provider, 'gpt-sovits')
  assert.equal(response.json.value.voice.readMurmurs, 'all')
  assert.equal(response.json.source, 'configEditor')
  assert.match(response.json.revision, /^r[0-9a-f]+$/)
})

test('PATCH config validates, persists through configEditor and returns fresh values', async () => {
  const { ctx, routes, state } = mockContext()
  apply(ctx, {})
  const before = await call(routes, { url: '/plugins/dsh-dstuber/api/config' })
  const patched = await call(routes, {
    method: 'PATCH',
    url: '/plugins/dsh-dstuber/api/config',
    body: { patch: { pet: { scale: 1.2, opacity: 0.9 } }, revision: before.json.revision },
  })
  assert.equal(patched.status, 200, patched.text)
  assert.equal(state.edits, 1)
  assert.equal(patched.json.value.pet.scale, 1.2)
  assert.equal(patched.json.value.pet.opacity, 0.9)
  assert.notEqual(patched.json.revision, before.json.revision)

  const conflict = await call(routes, {
    method: 'PATCH',
    url: '/plugins/dsh-dstuber/api/config',
    body: { patch: { pet: { scale: 0.8 } }, revision: before.json.revision },
  })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.json.error, 'revision-conflict')
})

test('PATCH ignores invalid or empty patches', async () => {
  const { ctx, routes, state } = mockContext()
  apply(ctx, {})
  const before = await call(routes, { url: '/plugins/dsh-dstuber/api/config' })
  const empty = await call(routes, {
    method: 'PATCH',
    url: '/plugins/dsh-dstuber/api/config',
    body: { patch: { nope: true }, revision: before.json.revision },
  })
  assert.equal(empty.status, 400)
  assert.equal(state.edits, 0)
})

test('chat without a live agent reports no-session instead of throwing', async () => {
  const { ctx, routes } = mockContext()
  apply(ctx, {})
  const response = await call(routes, {
    method: 'POST',
    url: '/plugins/dsh-dstuber/api/chat',
    body: { text: '你好' },
  })
  assert.equal(response.status, 503)
  assert.equal(response.json.error, 'agents-unavailable')
})

test('stage-report round-trips through the store', async () => {
  const { ctx, routes } = mockContext()
  apply(ctx, {})
  const sent = await call(routes, {
    method: 'POST',
    url: '/plugins/dsh-dstuber/api/stage-report',
    body: { ok: true, expressions: { passed: 44, total: 44 } },
  })
  assert.equal(sent.status, 200)
  const read = await call(routes, { url: '/plugins/dsh-dstuber/api/stage-report' })
  assert.equal(read.json.report.ok, true)
  assert.equal(read.json.report.expressions.total, 44)
})

test('non-loopback requests are refused', async () => {
  const { ctx, routes } = mockContext()
  apply(ctx, {})
  const res = mockRes()
  const req = Object.assign(Readable.from([]), {
    method: 'GET',
    url: '/plugins/dsh-dstuber/api/health',
    headers: {},
    socket: { remoteAddress: '10.1.2.3' },
  })
  await routes[0].handler(req, res)
  assert.equal(res.status, 403)
})

test('stage index is served directly (no redirect loop)', async () => {
  const { ctx, routes } = mockContext()
  apply(ctx, {})
  const res = mockRes()
  await routes[0].handler(
    mockReq({ url: '/plugins/dsh-dstuber/stage/?bg=none&hud=1&selftest=1' }),
    res,
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'] || '', /text\/html/)
  assert.match(res.body, /Live2D stage/)
})

test('bare /stage redirects to the directory form exactly once', async () => {
  const { ctx, routes } = mockContext()
  apply(ctx, {})
  const res = mockRes()
  await routes[0].handler(mockReq({ url: '/plugins/dsh-dstuber/stage' }), res)
  assert.equal(res.status, 302)
  assert.equal(res.headers.location, '/plugins/dsh-dstuber/stage/')
})
