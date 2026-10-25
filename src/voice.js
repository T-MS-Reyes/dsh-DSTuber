import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SENTENCE_END = /[。！？!?；;…\n]/
// A sentence made only of punctuation ("…", "——") is not worth a TTS round trip
// and used to be synthesized as a tiny clip between real sentences.
const SPEAKABLE = /[0-9A-Za-z\u3400-\u9fff]/

export function cleanSpeechText(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[（(][^（）()]*[）)]/g, ' ')
    .replace(/[#>*_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200)
}

export function splitSpeechSentences(buffer, final = false) {
  const parts = []
  let start = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (!SENTENCE_END.test(buffer[index])) continue
    const text = cleanSpeechText(buffer.slice(start, index + 1))
    if (text) parts.push(text)
    start = index + 1
  }
  let rest = buffer.slice(start)
  if (final) {
    const text = cleanSpeechText(rest)
    if (text) parts.push(text)
    rest = ''
  } else if (rest.length > 140) {
    const cut = Math.max(rest.lastIndexOf('，'), rest.lastIndexOf(','), 80)
    const text = cleanSpeechText(rest.slice(0, cut + 1))
    if (text) parts.push(text)
    rest = rest.slice(cut + 1)
  }
  return { parts, rest }
}

export function wavDuration(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return 0
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return 0
  const byteRate = buffer.readUInt32LE(28)
  const dataSize = buffer.readUInt32LE(40)
  if (!byteRate || !dataSize) return 0
  return Math.max(0, dataSize / byteRate)
}

/**
 * Host-side bridge to the persistent Python Azure Speech SDK worker.
 *
 * Node owns sentence splitting so speech starts as soon as the first complete
 * sentence of a streamed pet reply arrives. Python owns Azure synthesis,
 * pitch processing and playback; it reads the same local voice.json settings.
 */
export function createVoiceService({ getConfig = () => ({}), dataDir, log = console, onSpeech, onCancel, onLevel, onEnvelope }) {
  const settingsPath = join(dataDir, 'voice.json')
  const scriptPath = fileURLToPath(new URL('../voice/voice_service.py', import.meta.url))
  const candidates = [
    process.env.DSH_DSTUBER_PYTHON,
    process.platform === 'win32'
      ? join(dataDir, 'voice-venv2', 'Scripts', 'python.exe')
      : join(dataDir, 'voice-venv2', 'bin', 'python'),
    'python',
  ].filter((value) => typeof value === 'string' && value.length > 0)
  const python = candidates.find((value) => value === 'python' || existsSync(value)) || 'python'
  let child = null
  let disposed = false
  let activeReply = null
  let lastEnded = null
  let ready = false
  // sentence id -> emotion from the inline tag, attached to the matching
  // speech events so the stage can switch expressions per sentence.
  const pendingEmotion = new Map()

  function send(payload) {
    if (!child?.stdin?.writable) return false
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`)
      return true
    } catch (error) {
      log.warn?.(`[dsh-dstuber] voice worker write failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  function startWorker() {
    if (child || disposed) return
    try {
      child = spawn(python, [scriptPath], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: {
          ...process.env,
          DSH_DSTUBER_VOICE_FILE: settingsPath,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      log.warn?.(`[dsh-dstuber] cannot start voice worker: ${error instanceof Error ? error.message : String(error)}`)
      child = null
      return
    }
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        try {
          const event = JSON.parse(line)
          if (event.type === 'ready') {
            ready = true
            log.info?.(`[dsh-dstuber] voice worker ready (sdk=${event.sdk})`)
          } else if (event.type === 'error') {
            log.warn?.(`[dsh-dstuber] voice worker: ${event.message}`)
          } else if (event.type === 'start' || event.type === 'play' || event.type === 'end') {
            const emotion = pendingEmotion.get(String(event.id))
            if (event.type === 'end') pendingEmotion.delete(String(event.id))
            onSpeech?.(emotion ? { ...event, emotion } : event)
          } else if (event.type === 'level') {
            // 20Hz speech level drives the stage's mouth; it is intentionally
            // not speech state, so it never touches the subtitle queue.
            onLevel?.(event)
          } else if (event.type === 'envelope') {
            // Pre-computed 10ms RMS chunks: the stage replays them against its
            // own playback clock, so syllable detail survives the network.
            onEnvelope?.(event)
          }
        } catch {}
      }
    })
    child.stderr.on('data', (chunk) => {
      const line = chunk.toString('utf8').trim()
      if (line) log.info?.(line)
    })
    child.on('error', (error) => {
      log.warn?.(`[dsh-dstuber] voice worker error: ${error instanceof Error ? error.message : String(error)}`)
    })
    child.on('exit', (code) => {
      ready = false
      child = null
      if (!disposed) log.warn?.(`[dsh-dstuber] voice worker exited (${code ?? 'signal'})`)
    })
  }

  function cancel(reason = 'cancelled') {
    send({ type: 'cancel', reason })
    activeReply = null
    onCancel?.({ reason })
  }

  function speak(text, meta) {
    const clean = cleanSpeechText(text)
    if (!clean || !SPEAKABLE.test(clean)) return
    if (!child) startWorker()
    const ttl = Number(meta.ttl)
    const emotion = meta.emotion || 'neutral'
    if (meta.id) {
      pendingEmotion.set(String(meta.id), emotion)
      if (pendingEmotion.size > 96) {
        const oldest = pendingEmotion.keys().next().value
        pendingEmotion.delete(oldest)
      }
    }
    send({
      type: 'speak',
      id: meta.id,
      text: clean,
      emotion,
      source: meta.source || 'reply',
      priority: meta.priority || 'low',
      interrupt: meta.interrupt === true,
      // Murmurs are only worth saying while they are fresh; the worker drops an
      // expired job instead of speaking stale chatter after a long queue.
      ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : 0,
      queuedAt: Date.now(),
    })
  }

  function handleReplyText(text, meta, final) {
    if (!activeReply) {
      activeReply = {
        id: meta.replyId,
        emotion: meta.emotion,
        buffer: '',
        received: '',
        interrupt: meta.interrupt !== false,
      }
    }
    activeReply.buffer += text
    const { parts, rest } = splitSpeechSentences(activeReply.buffer, final)
    activeReply.buffer = rest
    for (const part of parts) {
      const interrupt = activeReply.interrupt === true
      speak(part, {
        id: `${activeReply.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        emotion: activeReply.emotion,
        source: 'reply',
        interrupt,
      })
      activeReply.interrupt = false
    }
  }

  function handle(message) {
    if (!message?.type) return
    if (message.type === 'pet.reply.start') {
      cancel('new-reply')
      activeReply = {
        id: message.id || String(message.time || Date.now()),
        emotion: message.emotion || 'neutral',
        buffer: '',
        received: '',
        interrupt: true,
      }
      return
    }
    if (message.type === 'pet.reply.delta' && activeReply) {
      if (message.text) {
        activeReply.received += message.text
        if (typeof message.emotion === 'string' && message.emotion.trim()) {
          activeReply.emotion = message.emotion.trim().toLowerCase()
        }
        handleReplyText(message.text, {
          replyId: activeReply.id,
          emotion: activeReply.emotion,
        }, false)
      }
      return
    }
    if (message.type === 'pet.reply.end' && activeReply) {
      const ended = message.text || activeReply.received
      const suffix = ended.startsWith(activeReply.received)
        ? ended.slice(activeReply.received.length)
        : ''
      handleReplyText(suffix, {
        replyId: activeReply.id,
        emotion: message.emotion || activeReply.emotion,
      }, true)
      lastEnded = { text: ended, time: Date.now() }
      activeReply = null
      return
    }
    if (message.type === 'pet.reply' && !activeReply) {
      if (lastEnded && lastEnded.text === message.text && Date.now() - lastEnded.time < 2000) {
        lastEnded = null
        return
      }
      lastEnded = null
      handleReplyText(message.text || '', {
        replyId: String(message.time || Date.now()),
        emotion: message.emotion || 'neutral',
        interrupt: true,
      }, true)
      return
    }
    if (message.type === 'pet.quip') {
      speak(message.text, {
        id: `quip-${message.time || Date.now()}`,
        emotion: message.emotion || 'neutral',
        source: 'quip',
        priority: message.priority || 'low',
        interrupt: false,
        ttl: message.ttl,
      })
    }
  }

  startWorker()

  return {
    handle,
    cancel,
    status() {
      return {
        python,
        ready,
        running: !!child,
      }
    },
    dispose() {
      disposed = true
      cancel('dispose')
      send({ type: 'shutdown' })
      if (child) {
        const running = child
        child = null
        setTimeout(() => {
          try { running.kill() } catch {}
        }, 1000).unref?.()
      }
    },
    /**
     * Stop the worker but stay usable: the next speak() spawns it again. This is
     * what "quit the pet" needs (all services down, data untouched).
     */
    stopWorker() {
      if (child) {
        try { send({ type: 'shutdown' }) } catch {}
        const running = child
        child = null
        setTimeout(() => {
          try { running.kill() } catch {}
        }, 800).unref?.()
      }
      ready = false
      activeReply = null
      pendingEmotion.clear()
      return { ok: true }
    },
  }
}
