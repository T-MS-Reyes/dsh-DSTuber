// Tiny static server for the standalone Live2D stage (development only).
// The installed Host plugin serves the same files under /plugins/dsh-dstuber/stage.
import http from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const stageDir = join(root, 'stage')
const modelDir = join(root, 'dev', 'live2d', 'ds-whale')
const port = Number(process.env.PORT || 8099)
let lastReport = null

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.moc3': 'application/octet-stream',
  '.motion3.json': 'application/json; charset=utf-8',
  '.exp3.json': 'application/json; charset=utf-8',
  '.physics3.json': 'application/json; charset=utf-8',
  '.cdi3.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
}

function inside(base, target) {
  const b = normalize(base + sep)
  return normalize(target).startsWith(b)
}

async function resolveFile(pathname) {
  let path
  if (pathname === '/' || pathname === '') path = join(stageDir, 'index.html')
  else if (pathname.startsWith('/model/')) path = join(modelDir, pathname.slice('/model/'.length))
  else path = join(stageDir, pathname.replace(/^\/+/, ''))
  const base = pathname.startsWith('/model/') ? modelDir : stageDir
  if (!inside(base, path)) return null
  try {
    const info = await stat(path)
    if (info.isDirectory()) path = join(path, 'index.html')
    return path
  } catch {
    return null
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, root, modelDir, report: lastReport }))
      return
    }
    if (url.pathname === '/api/stage-report') {
      if (req.method === 'POST') {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        try {
          lastReport = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          console.log(`[dsh-dstuber] selftest report: ok=${lastReport.ok} expressions=${lastReport.expressions?.passed}/${lastReport.expressions?.total}`)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'invalid-json' }))
        }
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, report: lastReport }))
      return
    }
    const pathname = decodeURIComponent(url.pathname)
    const file = await resolveFile(pathname)
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`not found: ${pathname}`)
      return
    }
    const ext = extname(file).toLowerCase()
    const type = file.endsWith('.motion3.json') ? MIME['.motion3.json']
      : file.endsWith('.exp3.json') ? MIME['.exp3.json']
        : file.endsWith('.physics3.json') ? MIME['.physics3.json']
          : file.endsWith('.cdi3.json') ? MIME['.cdi3.json']
            : MIME[ext] || 'application/octet-stream'
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    createReadStream(file).pipe(res)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(String(error))
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[dsh-dstuber] stage: http://127.0.0.1:${port}/?bg=grid&hud=1`)
  console.log(`[dsh-dstuber] model: ${modelDir}`)
})
