/**
 * Streaming pet-reply protocol.
 *
 * The pet brain child is asked to answer as:
 *
 *   MODE:chat
 *   EMOTION:happy
 *   正文……
 *
 * or just `MODE:work`.  Older children may still answer with the JSON protocol
 * `{"mode":"chat","reply":"..."}`; both are accepted.  The parser is deliberately
 * independent from the DSH stream so it can be unit-tested and reused by the
 * voice pipeline later.
 */

const EMOTIONS = new Set([
  'neutral',
  'curious',
  'happy',
  'proud',
  'worried',
  'annoyed',
  'focused',
  'surprised',
])

const MODE_LINE = /^MODE\s*:\s*(chat|work)\s*$/i
const EMOTION_LINE = /^EMOTION\s*:\s*([a-z_-]+)\s*$/i

// Inline emotion tag, e.g. "[joy]今天好开心！". Custom owner tags may be CJK.
const INLINE_TAG = /^[a-z0-9_\u4e00-\u9fff-]{1,20}$/i
const TAG_OPEN = '['
const TAG_CLOSE = ']'

/**
 * Remove inline emotion tags from a finished text and return the tag found
 * last (a later tag wins for the remaining text).
 */
export function stripInlineTags(value) {
  const text = String(value || '')
  let output = ''
  let emotion = null
  let index = 0
  while (index < text.length) {
    const open = text.indexOf(TAG_OPEN, index)
    if (open < 0) {
      output += text.slice(index)
      break
    }
    output += text.slice(index, open)
    const close = text.indexOf(TAG_CLOSE, open + 1)
    if (close < 0) {
      output += text.slice(open)
      break
    }
    const tag = text.slice(open + 1, close).trim().toLowerCase()
    if (INLINE_TAG.test(tag)) emotion = tag
    else output += text.slice(open, close + 1)
    index = close + 1
  }
  return { text: output, emotion }
}

/**
 * Incremental inline-tag filter. A tag may arrive split across deltas, so an
 * open bracket holds text until it closes (or is proven not to be a tag).
 */
export function createInlineTagFilter() {
  let inTag = false
  let buffer = ''
  let emotion = null
  function push(value) {
    const text = String(value || '')
    let visible = ''
    for (const character of text) {
      if (inTag) {
        buffer += character
        if (character === TAG_CLOSE) {
          inTag = false
          const tag = buffer.slice(1, -1).trim().toLowerCase()
          buffer = ''
          if (INLINE_TAG.test(tag)) emotion = tag
          else visible += `[${tag}]`
        } else if (buffer.length > 24) {
          // Not a tag after all: flush it as text and stop holding.
          visible += buffer
          buffer = ''
          inTag = false
        }
        continue
      }
      if (character === TAG_OPEN) {
        inTag = true
        buffer = TAG_OPEN
        continue
      }
      visible += character
    }
    return visible
  }
  function flush() {
    if (!inTag) return ''
    const pending = buffer
    buffer = ''
    inTag = false
    return pending
  }
  function reset() {
    inTag = false
    buffer = ''
    emotion = null
  }
  return {
    push,
    flush,
    reset,
    get emotion() { return emotion },
  }
}

function stripFence(value) {
  return String(value || '')
    .trim()
    .replace(/^```(?:json|text)?\s*/i, '')
    .replace(/```$/i, '')
    .trim()
}

function normalizeEmotion(value) {
  const emotion = String(value || '').trim().toLowerCase()
  return EMOTIONS.has(emotion) ? emotion : 'neutral'
}

const STAGE_OPEN = new Set(['（', '('])
const STAGE_CLOSE = new Set(['）', ')'])

/**
 * Remove parenthetical stage directions such as （摆尾） or (smile) from a
 * finished reply. Unclosed groups are dropped entirely.
 */
export function stripStageDirections(value) {
  const text = String(value || '')
  let output = ''
  let depth = 0
  for (const character of text) {
    if (depth === 0) {
      if (STAGE_OPEN.has(character)) {
        depth = 1
      } else {
        output += character
      }
      continue
    }
    if (STAGE_OPEN.has(character)) depth += 1
    else if (STAGE_CLOSE.has(character)) depth -= 1
  }
  return output
}

/**
 * Incremental version for streamed deltas. It emits text outside parentheses
 * immediately, holds an open group until it closes, and never emits the group.
 */
export function createStageDirectionFilter() {
  let depth = 0
  function push(value) {
    const text = String(value || '')
    let output = ''
    for (const character of text) {
      if (depth === 0) {
        if (STAGE_OPEN.has(character)) depth = 1
        else output += character
        continue
      }
      if (STAGE_OPEN.has(character)) depth += 1
      else if (STAGE_CLOSE.has(character)) depth -= 1
    }
    return output
  }
  function reset() {
    depth = 0
  }
  return { push, reset }
}

function parseJsonReply(raw) {
  const text = stripFence(raw)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1))
    if (value?.mode === 'work') return { mode: 'work', emotion: 'neutral', reply: '' }
    const reply = stripStageDirections(
      typeof value?.reply === 'string' ? value.reply : '',
    ).trim()
    if (!reply) return null
    return {
      mode: 'chat',
      emotion: normalizeEmotion(value?.emotion),
      reply,
    }
  } catch {
    return null
  }
}

/** Parse one finished child message in either protocol. */
export function parsePetReply(text) {
  const raw = stripFence(text)
  if (!raw) return { mode: 'chat', emotion: 'neutral', reply: '' }
  if (raw.startsWith('{')) {
    const fromJson = parseJsonReply(raw)
    if (fromJson) return fromJson
  }

  const lines = raw.split(/\r?\n/)
  let mode = 'chat'
  let emotion = 'neutral'
  let index = 0
  let sawHeader = false
  for (; index < lines.length; index += 1) {
    const line = lines[index].trim()
    const modeMatch = line.match(MODE_LINE)
    if (modeMatch) {
      mode = modeMatch[1].toLowerCase() === 'work' ? 'work' : 'chat'
      sawHeader = true
      continue
    }
    const emotionMatch = line.match(EMOTION_LINE)
    if (emotionMatch) {
      emotion = normalizeEmotion(emotionMatch[1])
      sawHeader = true
      continue
    }
    if (!line && !sawHeader) continue
    break
  }
  if (mode === 'work') return { mode: 'work', emotion, reply: '' }
  const reply = stripStageDirections(lines.slice(index).join('\n'))
  const inline = stripInlineTags(reply)
  const finalEmotion = inline.emotion || emotion
  const cleaned = inline.text.trim()
  if (!sawHeader && !cleaned) return { mode: 'chat', emotion: finalEmotion, reply: '' }
  return { mode: 'chat', emotion: finalEmotion, reply: cleaned }
}

/**
 * Incremental parser for one assistant stream.  It emits only the reply body,
 * never the protocol header.  JSON fallback is intentionally not streamed: a
 * JSON object is only known after its closing brace.
 */
export function createReplyStreamParser() {
  let raw = ''
  let mode = null
  let emotion = 'neutral'
  let bodyStart = -1
  let bodyEmitted = 0
  let headerDone = false
  let jsonFallback = false
  let body = ''
  const stageFilter = createStageDirectionFilter()
  const tagFilter = createInlineTagFilter()

  function reset() {
    raw = ''
    mode = null
    emotion = 'neutral'
    bodyStart = -1
    bodyEmitted = 0
    headerDone = false
    jsonFallback = false
    body = ''
    stageFilter.reset()
    tagFilter.reset()
  }

  function consumeHeaders() {
    const trimmedStart = raw.trimStart()
    if (trimmedStart.startsWith('{') || trimmedStart.startsWith('```')) {
      jsonFallback = true
      headerDone = true
      return
    }
    let pos = 0
    while (!headerDone) {
      const newline = raw.indexOf('\n', pos)
      if (newline < 0) {
        const partial = raw.slice(pos).replace(/\r$/, '')
        const trimmed = partial.trim()
        if (!trimmed) return
        // The first chunk can be a single `M`/`E` or a partial `MODE:chat`.
        // Wait until we can tell a header from a plain reply.
        const lower = trimmed.toLowerCase()
        const headerPrefix = ['mode', 'emotion'].some(
          (word) => word.startsWith(lower) || lower.startsWith(word),
        )
        if (headerPrefix) return
        headerDone = true
        bodyStart = pos
        return
      }
      const line = raw.slice(pos, newline).replace(/\r$/, '')
      const trimmed = line.trim()
      const modeMatch = trimmed.match(MODE_LINE)
      if (modeMatch) {
        mode = modeMatch[1].toLowerCase() === 'work' ? 'work' : 'chat'
        pos = newline + 1
        continue
      }
      const emotionMatch = trimmed.match(EMOTION_LINE)
      if (emotionMatch) {
        emotion = normalizeEmotion(emotionMatch[1])
        pos = newline + 1
        continue
      }
      if (!trimmed) {
        pos = newline + 1
        continue
      }
      headerDone = true
      bodyStart = pos
    }
  }

  function push(chunk) {
    const delta = String(chunk || '')
    const currentEmotion = () => tagFilter.emotion || emotion
    if (!delta) return { mode, emotion: currentEmotion(), delta: '', text: body, bodyStarted: bodyStart >= 0 }
    raw += delta
    if (!headerDone) consumeHeaders()
    if (mode === 'work') {
      return { mode, emotion: currentEmotion(), delta: '', text: '', bodyStarted: false }
    }
    if (headerDone && !jsonFallback) {
      if (bodyStart < 0) bodyStart = raw.length
      if (mode === null) mode = 'chat'
      const current = raw.slice(bodyStart).replace(/^\r?\n/, '')
      if (current.length > bodyEmitted) {
        const emitted = current.slice(bodyEmitted)
        bodyEmitted = current.length
        const visible = stageFilter.push(emitted)
        const tagged = tagFilter.push(visible)
        body += tagged
        return {
          mode,
          emotion: currentEmotion(),
          delta: tagged,
          text: body,
          bodyStarted: true,
        }
      }
    }
    return { mode, emotion: currentEmotion(), delta: '', text: body, bodyStarted: bodyStart >= 0 }
  }

  function finish(finalText = '') {
    const parsed = parsePetReply(finalText || raw)
    return parsed
  }

  return { reset, push, finish }
}
