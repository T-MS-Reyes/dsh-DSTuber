// Transparent subtitle card. It is a local Tauri page: right-click opens the
// subtitle-only native menu, left drag detaches it from the pet. Long content
// scrolls inside the card with a custom draggable scrollbar.
(() => {
  const invoke = window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke
  const card = document.getElementById('card')
  const viewport = document.getElementById('viewport')
  const text = document.getElementById('text')
  const scrollbar = document.getElementById('scrollbar')
  const thumb = document.getElementById('thumb')
  const root = document.documentElement
  let thumbDrag = null

  function updateScrollbar() {
    const max = viewport.scrollHeight - viewport.clientHeight
    if (max <= 1) {
      scrollbar.classList.remove('visible')
      viewport.classList.remove('overflowing')
      viewport.scrollTop = 0
      return
    }
    scrollbar.classList.add('visible')
    viewport.classList.add('overflowing')
    const trackHeight = scrollbar.clientHeight
    const thumbHeight = Math.max(
      18,
      Math.round(trackHeight * viewport.clientHeight / viewport.scrollHeight),
    )
    thumb.style.height = `${thumbHeight}px`
    const range = Math.max(1, trackHeight - thumbHeight)
    const top = (viewport.scrollTop / max) * range
    thumb.style.transform = `translateY(${top}px)`
  }

  function setContent(value) {
    const next = value || ''
    if (text.textContent !== next) {
      text.textContent = next
      viewport.scrollTop = 0
    }
    requestAnimationFrame(updateScrollbar)
  }

  function apply(state) {
    if (!state) return
    card.classList.toggle('semi', !!state.semiTransparent)
    const size = Number(state.fontSize)
    const opacity = Number(state.backgroundOpacity)
    root.style.setProperty('--subtitle-font', `${Number.isFinite(size) ? size : 16}px`)
    root.style.setProperty(
      '--subtitle-bg',
      Number.isFinite(opacity) ? String(opacity) : '0.72',
    )
    setContent(state.text)
  }

  window.__subtitle = {
    apply,
    setText(value) {
      setContent(value)
    },
  }

  viewport.addEventListener('scroll', updateScrollbar, { passive: true })
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => requestAnimationFrame(updateScrollbar)).observe(viewport)
  }
  window.addEventListener('resize', () => requestAnimationFrame(updateScrollbar))

  function endThumbDrag() {
    thumbDrag = null
    document.body.style.cursor = 'default'
    window.removeEventListener('mousemove', onThumbMove)
    window.removeEventListener('mouseup', endThumbDrag)
  }

  function onThumbMove(event) {
    if (!thumbDrag) return
    event.preventDefault()
    const max = viewport.scrollHeight - viewport.clientHeight
    if (max <= 0) return
    const offset = event.clientY - thumbDrag.startY
    viewport.scrollTop = thumbDrag.startScroll + (offset / thumbDrag.range) * max
  }

  thumb.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const max = viewport.scrollHeight - viewport.clientHeight
    if (max <= 0) return
    const trackHeight = scrollbar.clientHeight
    const thumbHeight = thumb.offsetHeight
    thumbDrag = {
      startY: event.clientY,
      startScroll: viewport.scrollTop,
      range: Math.max(1, trackHeight - thumbHeight),
    }
    document.body.style.cursor = 'grabbing'
    window.addEventListener('mousemove', onThumbMove)
    window.addEventListener('mouseup', endThumbDrag)
  })

  // Clicking the track pages the text; dragging the thumb scrolls freely.
  scrollbar.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || event.target === thumb) return
    event.preventDefault()
    event.stopPropagation()
    const rect = scrollbar.getBoundingClientRect()
    const ratio = (event.clientY - rect.top) / Math.max(1, rect.height)
    const max = viewport.scrollHeight - viewport.clientHeight
    viewport.scrollTop = ratio * max
  })

  scrollbar.addEventListener('wheel', (event) => {
    event.preventDefault()
    viewport.scrollTop += event.deltaY
  }, { passive: false })

  window.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    if (typeof invoke === 'function') {
      invoke('show_subtitle_menu').catch(() => {})
    }
  })

  const resizeCursors = {
    n: 'ns-resize',
    s: 'ns-resize',
    e: 'ew-resize',
    w: 'ew-resize',
    ne: 'nesw-resize',
    sw: 'nesw-resize',
    nw: 'nwse-resize',
    se: 'nwse-resize',
  }
  const EDGE = 8

  function resizeDirection(x, y) {
    const width = window.innerWidth
    const height = window.innerHeight
    const nearLeft = x <= EDGE
    const nearRight = x >= width - EDGE
    const nearTop = y <= EDGE
    const nearBottom = y >= height - EDGE
    if (nearLeft && nearTop) return 'nw'
    if (nearRight && nearTop) return 'ne'
    if (nearLeft && nearBottom) return 'sw'
    if (nearRight && nearBottom) return 'se'
    if (nearLeft) return 'w'
    if (nearRight) return 'e'
    if (nearTop) return 'n'
    if (nearBottom) return 's'
    return null
  }

  window.addEventListener('mousemove', (event) => {
    if (thumbDrag) return
    const direction = resizeDirection(event.clientX, event.clientY)
    document.body.style.cursor = direction ? resizeCursors[direction] : 'default'
  })

  window.addEventListener('mouseleave', () => {
    if (!thumbDrag) document.body.style.cursor = 'default'
  })

  window.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    if (typeof invoke !== 'function') return
    const direction = resizeDirection(event.clientX, event.clientY)
    if (direction) {
      invoke('start_subtitle_resize', { direction }).catch(() => {})
      return
    }
    invoke('start_subtitle_drag').catch(() => {})
  })

  ;(async () => {
    if (typeof invoke !== 'function') {
      return
    }
    try {
      const settings = await invoke('get_subtitle_settings')
      apply(settings)
    } catch {}
  })()
})()
