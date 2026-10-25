// Bottom input bar for the desktop pet. Replies are rendered by the subtitle
// window, not here. The page is served by the DSH Host so it can use /api.
(() => {
  const $ = (id) => document.getElementById(id)
  const tauri = window.__TAURI_INTERNALS__ ?? null
  const emit = (event, payload = null) => {
    if (!tauri?.invoke) return
    tauri.invoke('plugin:event|emit', { event, payload }).catch(() => {})
  }

  const input = $('input')
  const sendButton = $('send')
  const statusText = $('status')
  const statusDot = $('dot')
  const bar = document.querySelector('.bar')

  let sending = false
  let stream = null
  let pendingTimer = null
  let replyStreamText = ''
  let lastFinalText = ''

  function setStatus(text, kind) {
    statusText.textContent = text
    statusDot.className = `dot ${kind || ''}`.trim()
  }

  function setSending(value) {
    sending = value
    sendButton.disabled = value || input.value.trim().length === 0
  }

  function updateButton() {
    sendButton.disabled = sending || input.value.trim().length === 0
  }

  function forwardSubtitle(text) {
    if (!text) return
    emit('dsh-dstuber:subtitle-text', { text })
  }

  async function send() {
    const text = input.value.trim()
    if (!text || sending) return
    setSending(true)
    setStatus('深度思考中…', 'busy')
    input.value = ''

    try {
      const response = await fetch(new URL('../api/pet-chat', location.href), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || !result.ok) {
        setStatus(
          result.error === 'no-session'
            ? '没有活跃的 DSH 会话'
            : `发送失败：${result.error || `HTTP ${response.status}`}`,
          'error',
        )
        return
      }
      // Keep "深度思考中" until a pet.reply/pet.whisper arrives. If the brain
      // is slow, the user still sees the intentional status rather than an error.
      if (pendingTimer) clearTimeout(pendingTimer)
      pendingTimer = setTimeout(() => {
        setStatus('深度思考中…', 'busy')
      }, 2500)
    } catch (error) {
      setStatus('发送失败，请稍后再试', 'error')
    } finally {
      setSending(false)
      updateButton()
    }
  }

  input.addEventListener('input', updateButton)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void send()
    }
  })
  sendButton.addEventListener('click', () => void send())

  $('close').addEventListener('click', (event) => {
    event.stopPropagation()
    emit('dsh-dstuber:chat-hide')
  })

  // Right-click menu and width resize for the input bar.
  const EDGE = 8
  function resizeDirection(x) {
    if (x <= EDGE) return 'w'
    if (x >= window.innerWidth - EDGE) return 'e'
    return null
  }

  // Drag from anywhere on the bar except the input/buttons and resize edges.
  bar.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !tauri) return
    if (event.target.closest('input, button')) return
    if (resizeDirection(event.clientX)) return
    event.preventDefault()
    emit('dsh-dstuber:chat-drag')
  })

  window.addEventListener('mousemove', (event) => {
    if (!tauri) return
    document.body.style.cursor = resizeDirection(event.clientX) ? 'ew-resize' : 'default'
  })
  window.addEventListener('mouseleave', () => {
    if (tauri) document.body.style.cursor = 'default'
  })
  window.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return
    const direction = tauri ? resizeDirection(event.clientX) : null
    if (!direction) return
    event.preventDefault()
    emit('dsh-dstuber:chat-resize', direction)
  })
  window.addEventListener('contextmenu', (event) => {
    if (!tauri) return
    event.preventDefault()
    emit('dsh-dstuber:chat-menu')
  })

  function connect() {
    try {
      stream = new EventSource(new URL('../api/events', location.href))
      stream.onopen = () => {
        if (!sending) setStatus('已连接', 'online')
      }
      stream.onerror = () => {
        if (!sending) setStatus('连接重试中…', 'error')
      }
      stream.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          if (message.type === 'pet.reply.start') {
            if (pendingTimer) {
              clearTimeout(pendingTimer)
              pendingTimer = null
            }
            replyStreamText = ''
            lastFinalText = ''
            setStatus('准备说话…', 'busy')
          } else if (message.type === 'pet.reply.delta') {
            if (pendingTimer) {
              clearTimeout(pendingTimer)
              pendingTimer = null
            }
            replyStreamText = message.accumulated || `${replyStreamText}${message.text || ''}`
          } else if (message.type === 'pet.reply.end') {
            if (pendingTimer) {
              clearTimeout(pendingTimer)
              pendingTimer = null
            }
            lastFinalText = message.text || replyStreamText
            replyStreamText = ''
          } else if (message.type === 'pet.reply') {
            if (pendingTimer) {
              clearTimeout(pendingTimer)
              pendingTimer = null
            }
            lastFinalText = ''
            replyStreamText = ''
          } else if (message.type === 'pet.speech') {
            if (message.speechType === 'play') {
              forwardSubtitle(message.text || '')
              setStatus('说话中…', 'busy')
            } else if (message.speechType === 'start') {
              setStatus('说话中…', 'busy')
            } else if (message.speechType === 'end') {
              setStatus('已连接', 'online')
            }
          } else if (message.type === 'pet.speech.cancel') {
            setStatus('已连接', 'online')
          } else if (message.type === 'pet.whisper' || message.type === 'pet.quip') {
            // The subtitle is updated by the matching pet.speech.play event so
            // text and audio stay in sync; never show the quip on arrival.
            setStatus('工作中的碎碎念…', 'busy')
          } else if (message.type === 'pet.status') {
            setStatus(message.text || '已连接', message.state === 'error' ? 'error' : 'busy')
          }
        } catch {}
      }
    } catch {
      setStatus('连接失败', 'error')
    }
  }

  async function loadPersona() {
    // Persona file names belong in settings, not in the input bar.
  }

  setStatus('已连接', 'online')
  updateButton()
  loadPersona()
  connect()
})()
