// Local settings window for the desktop pet. It talks to Rust through Tauri
// app commands; it never embeds the DSH web UI.
(() => {
  const invoke = window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke
  const $ = (id) => document.getElementById(id)
  const status = $('status')
  const scale = $('scale')
  const scaleValue = $('scaleValue')
  const reduced = $('reduced')
  const alwaysOnTop = $('alwaysOnTop')
  const autoStart = $('autoStart')
  const voiceEnabled = $('voiceEnabled')
  const voiceMurmurs = $('voiceMurmurs')
  const voiceProvider = $('voiceProvider')
  const voiceEdgePanel = $('voiceEdgePanel')
  const voiceGsvPanel = $('voiceGsvPanel')
  const voiceEdgeVoice = $('voiceEdgeVoice')
  const voiceEdgeRate = $('voiceEdgeRate')
  const voiceEdgeRateValue = $('voiceEdgeRateValue')
  const voiceEdgePitch = $('voiceEdgePitch')
  const voiceEdgePitchValue = $('voiceEdgePitchValue')
  const voiceFfmpeg = $('voiceFfmpeg')
  const voiceGsvUrl = $('voiceGsvUrl')
  const voiceGsvGpt = $('voiceGsvGpt')
  const voiceGsvSovits = $('voiceGsvSovits')
  const voiceGsvReference = $('voiceGsvReference')
  const voiceGsvPrompt = $('voiceGsvPrompt')
  const voiceGsvSpeed = $('voiceGsvSpeed')
  const voiceGsvSpeedValue = $('voiceGsvSpeedValue')
  const voiceGsvStreaming = $('voiceGsvStreaming')
  const voiceVolume = $('voiceVolume')
  const voiceVolumeValue = $('voiceVolumeValue')
  const saveVoice = $('saveVoice')

  function voiceLabels() {
    const rate = Number(voiceEdgeRate.value)
    voiceEdgeRateValue.textContent = `${rate >= 0 ? '+' : ''}${rate}%`
    const pitch = Number(voiceEdgePitch.value)
    voiceEdgePitchValue.textContent = `${pitch >= 0 ? '+' : ''}${pitch}Hz`
    voiceGsvSpeedValue.textContent = `${(Number(voiceGsvSpeed.value) / 100).toFixed(2)}x`
    voiceVolumeValue.textContent = `${Math.round(Number(voiceVolume.value))}%`
  }

  function updateVoicePanels() {
    const edge = voiceProvider.value !== 'gpt-sovits'
    voiceEdgePanel.hidden = !edge
    voiceGsvPanel.hidden = edge
  }

  voiceEdgeRate.addEventListener('input', voiceLabels)
  voiceEdgePitch.addEventListener('input', voiceLabels)
  voiceGsvSpeed.addEventListener('input', voiceLabels)
  voiceVolume.addEventListener('input', voiceLabels)
  voiceProvider.addEventListener('change', updateVoicePanels)

  function renderVoice(value) {
    voiceEnabled.checked = !!value.enabled
    voiceMurmurs.value = value.readMurmurs || 'important'
    voiceProvider.value = value.provider === 'gpt-sovits' ? 'gpt-sovits' : 'edge'
    voiceEdgeVoice.value = value.edgeVoice || 'zh-CN-XiaoyiNeural'
    voiceEdgeRate.value = String(Number.isFinite(value.edgeRate) ? value.edgeRate : 0)
    voiceEdgePitch.value = String(Number.isFinite(value.edgePitch) ? value.edgePitch : 0)
    voiceFfmpeg.value = value.ffmpegPath || ''
    voiceGsvUrl.value = value.gptSovitsUrl || 'http://127.0.0.1:9880'
    voiceGsvGpt.value = value.gptWeights || ''
    voiceGsvSovits.value = value.sovitsWeights || ''
    voiceGsvReference.value = value.referenceAudio || ''
    voiceGsvPrompt.value = value.promptText || ''
    voiceGsvSpeed.value = String(Math.round((Number.isFinite(value.gptSovitsSpeed) ? value.gptSovitsSpeed : 1) * 100))
    voiceGsvStreaming.value = String(Number.isFinite(value.gptSovitsStreaming) ? value.gptSovitsStreaming : 3)
    voiceVolume.value = String(Math.round((Number.isFinite(value.volume) ? value.volume : 0.8) * 100))
    updateVoicePanels()
    voiceLabels()
  }

  async function loadVoiceSettings() {
    const value = await call('get_voice_settings')
    if (value) renderVoice(value)
  }

  saveVoice.addEventListener('click', async () => {
    saveVoice.disabled = true
    try {
      const value = await call('save_voice_settings', {
        input: {
          enabled: voiceEnabled.checked,
          readMurmurs: voiceMurmurs.value,
          provider: voiceProvider.value,
          volume: Number(voiceVolume.value) / 100,
          edgeVoice: voiceEdgeVoice.value.trim(),
          edgeRate: Number(voiceEdgeRate.value),
          edgePitch: Number(voiceEdgePitch.value),
          ffmpegPath: voiceFfmpeg.value.trim(),
          gptSovitsUrl: voiceGsvUrl.value.trim(),
          gptWeights: voiceGsvGpt.value.trim(),
          sovitsWeights: voiceGsvSovits.value.trim(),
          referenceAudio: voiceGsvReference.value.trim(),
          promptText: voiceGsvPrompt.value.trim(),
          promptLang: 'zh',
          gptSovitsSpeed: Number(voiceGsvSpeed.value) / 100,
          gptSovitsStreaming: Number(voiceGsvStreaming.value),
        },
      })
      if (value) {
        renderVoice(value)
        setStatus(`语音设置已保存：${value.provider === 'gpt-sovits' ? 'GPT-SoVITS' : 'Edge TTS'}`)
      }
    } finally {
      saveVoice.disabled = false
    }
  })

  function setStatus(text, error = false) {
    status.textContent = text
    status.classList.toggle('error', error)
  }

  async function call(command, args) {
    if (typeof invoke !== 'function') {
      setStatus('Tauri IPC 不可用', true)
      return null
    }
    try {
      return await invoke(command, args)
    } catch (error) {
      setStatus(`错误：${error instanceof Error ? error.message : String(error)}`, true)
      return null
    }
  }

  // Tabs: 常规 / 字幕 / 对话
  const tabs = Array.from(document.querySelectorAll('.tab'))
  const pages = {
    general: $('page-general'),
    subtitle: $('page-subtitle'),
    chat: $('page-chat'),
    voice: $('page-voice'),
    model: $('page-model'),
  }

  function showPage(name) {
    for (const tab of tabs) {
      tab.classList.toggle('active', tab.dataset.page === name)
    }
    for (const [key, page] of Object.entries(pages)) {
      page.hidden = key !== name
    }
    if (name === 'subtitle') void loadSubtitleSettings()
    if (name === 'chat') void loadChatSettings()
    if (name === 'voice') {
      void loadVoiceSettings()
      void loadEngines()
    }
    if (name === 'model') void loadLive2dModel()
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => showPage(tab.dataset.page))
  }

  // Live2D model settings
  const characterName = $('characterName')
  const modelName = $('modelName')
  const modelKind = $('modelKind')
  const modelPath = $('modelPath')
  const modelSelect = $('modelSelect')
  const deleteSelect = $('deleteSelect')
  const deleteModel = $('deleteModel')

  function renderLive2dModel(value) {
    if (!value) return
    characterName.textContent = value.name
    modelName.textContent = value.name
    modelKind.textContent = value.kind === 'custom' ? '自定义' : '默认'
    modelPath.textContent = value.dir || '插件内置模型'
  }

  async function loadLive2dModel() {
    const current = await call('get_live2d_model')
    if (!current) return
    renderLive2dModel(current)
    const models = await call('list_live2d_models')
    const list = Array.isArray(models) ? models : []
    modelSelect.innerHTML = ''
    for (const model of list) {
      const option = document.createElement('option')
      option.value = `${model.kind}:${model.id}`
      option.textContent = `${model.name}${model.kind === 'builtin' ? '（默认）' : '（自定义）'}`
      modelSelect.append(option)
    }
    modelSelect.value = current.kind && current.id
      ? `${current.kind}:${current.id}`
      : 'builtin:ds-q'

    const customs = list.filter((model) => model.kind === 'custom')
    deleteSelect.innerHTML = ''
    if (customs.length === 0) {
      const option = document.createElement('option')
      option.value = ''
      option.textContent = '暂无自定义模型'
      deleteSelect.append(option)
      deleteSelect.disabled = true
      deleteModel.disabled = true
    } else {
      for (const model of customs) {
        const option = document.createElement('option')
        option.value = model.id
        option.textContent = model.name
        deleteSelect.append(option)
      }
      deleteSelect.disabled = false
      deleteModel.disabled = false
    }
  }

  // Model adaptation: the Host adapter derives a profile (parameters, artist
  // expressions, motion groups) from the active model. This page only asks for
  // it and lets the owner correct the semantic meaning of each expression.
  const adaptModelButton = $('adaptModel')
  const adaptStatus = $('adaptStatus')
  const adaptReport = $('adaptReport')
  const adaptCaps = $('adaptCaps')
  const adaptNotes = $('adaptNotes')
  const expressionMap = $('expressionMap')
  const saveSemantics = $('saveSemantics')
  const SEMANTIC_OPTIONS = [
    ['', '忽略'],
    ['happy', '开心'],
    ['shy', '害羞'],
    ['angry', '生气'],
    ['sad', '难过'],
    ['surprised', '惊讶'],
    ['worried', '担心'],
    ['proud', '得意'],
    ['silly', '呆萌'],
    ['awkward', '尴尬'],
    ['pout', '嘟嘴'],
    ['dizzy', '晕'],
    ['mouth', '嘴型'],
    ['cosmetic', '装饰'],
    ['__custom__', '自定义标签…'],
  ]
  let hostBase = ''

  async function hostOrigin() {
    if (hostBase) return hostBase
    const value = await call('get_host_origin')
    hostBase = typeof value === 'string' && value ? value : location.origin
    return hostBase
  }

  async function hostFetch(path, options) {
    const base = await hostOrigin()
    const response = await fetch(`${base}/plugins/dsh-dstuber${path}`, {
      cache: 'no-store',
      ...options,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(payload?.error || `HTTP ${response.status}`)
      error.payload = payload
      throw error
    }
    return payload
  }

  function semanticOf(expression) {
    if (expression.kind === 'mouth') return 'mouth'
    if (expression.kind === 'cosmetic') return 'cosmetic'
    if (expression.kind === 'ignored') return ''
    return expression.semantic || ''
  }

  function renderModelProfile(profile) {
    adaptReport.hidden = false
    const caps = profile.capabilities || {}
    const flags = []
    if (caps.hasMouth) flags.push('口型')
    if (caps.hasEyes) flags.push('眨眼')
    if (caps.hasEyeBall) flags.push('眼球')
    if (caps.hasBrows) flags.push('眉毛')
    if (caps.hasArms) flags.push('手臂')
    if (caps.hasBreath) flags.push('呼吸')
    flags.push(caps.hasMotions ? `动作×${(caps.motionGroups || []).length}` : '无动作文件')
    adaptCaps.textContent = flags.join(' · ')
    adaptNotes.textContent = Array.isArray(profile.notes) && profile.notes.length
      ? profile.notes.join('；')
      : '无'

    expressionMap.innerHTML = ''
    for (const expression of profile.expressions || []) {
      const row = document.createElement('div')
      row.className = 'expr-row'
      const name = document.createElement('span')
      name.textContent = expression.label || expression.name
      name.title = `${expression.name || ''}${expression.file ? ` · ${expression.file}` : ''}`
      const select = document.createElement('select')
      select.dataset.expression = expression.name
      for (const [value, text] of SEMANTIC_OPTIONS) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = text
        select.append(option)
      }
      if (expression.customTag) {
        const option = document.createElement('option')
        option.value = expression.customTag
        option.textContent = expression.customTag
        select.append(option)
      }
      select.value = expression.customTag || semanticOf(expression)
      const fallback = () => (expression.customTag || semanticOf(expression))
      select.addEventListener('change', () => {
        if (select.value !== '__custom__') return
        // Inline editor instead of window.prompt: the native dialog breaks the
        // settings style and reads like a Tauri warning.
        select.hidden = true
        const editor = document.createElement('input')
        editor.type = 'text'
        editor.className = 'expr-editor'
        editor.placeholder = '标签名'
        editor.maxLength = 20
        row.append(editor)
        editor.focus()
        let done = false
        const finish = (commit) => {
          if (done) return
          done = true
          const tag = commit ? editor.value.trim().slice(0, 20) : ''
          editor.remove()
          select.hidden = false
          if (!tag) {
            select.value = fallback()
            return
          }
          let option = [...select.options].find((item) => item.value === tag)
          if (!option) {
            option = document.createElement('option')
            option.value = tag
            option.textContent = tag
            select.append(option)
          }
          select.value = tag
        }
        editor.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            finish(true)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            finish(false)
          }
        })
        editor.addEventListener('blur', () => finish(true))
      })
      row.append(name, select)
      expressionMap.append(row)
    }
  }

  async function loadModelProfile() {
    try {
      const value = await hostFetch('/api/model/profile')
      if (value?.profile) {
        renderModelProfile(value.profile)
        const stats = value.profile.stats || {}
        adaptStatus.textContent = `已适配 · ${stats.emotionExpressions ?? 0} 个情绪表情 / ${stats.parameters ?? 0} 个参数`
        adaptStatus.classList.remove('error')
      }
    } catch (error) {
      if (error?.payload?.needsAdapt) {
        adaptStatus.textContent = '尚未适配，点左侧按钮识别当前模型'
        adaptReport.hidden = true
      } else {
        adaptStatus.textContent = `读取适配信息失败：${error.message}`
        adaptStatus.classList.add('error')
      }
    }
  }

  adaptModelButton.addEventListener('click', async () => {
    adaptModelButton.disabled = true
    adaptStatus.textContent = '正在适配…'
    adaptStatus.classList.remove('error')
    try {
      const value = await hostFetch('/api/model/adapt', { method: 'POST' })
      if (value?.profile) {
        renderModelProfile(value.profile)
        const stats = value.profile.stats || {}
        adaptStatus.textContent = `适配完成 · ${stats.emotionExpressions ?? 0} 个情绪表情 / ${stats.parameters ?? 0} 个参数`
        setStatus('模型适配完成')
      }
    } catch (error) {
      adaptStatus.textContent = `适配失败：${error.message}`
      adaptStatus.classList.add('error')
    } finally {
      adaptModelButton.disabled = false
    }
  })

  saveSemantics.addEventListener('click', async () => {
    const corrections = []
    for (const select of expressionMap.querySelectorAll('select[data-expression]')) {
      const value = select.value
      const isCustom = value && !SEMANTIC_OPTIONS.some(([option]) => option === value)
      corrections.push(
        isCustom
          ? { name: select.dataset.expression, customTag: value }
          : { name: select.dataset.expression, semantic: value },
      )
    }
    const hasCustom = corrections.some((item) => item.customTag)
    saveSemantics.disabled = true
    try {
      const value = await hostFetch('/api/model/semantics', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ corrections }),
      })
      if (value?.profile) renderModelProfile(value.profile)
      if (hasCustom) {
        setStatus('自定义标签已保存，正在分析语义…')
        window.setTimeout(() => { void loadModelProfile() }, 3500)
      } else {
        setStatus('表情映射已保存')
      }
    } catch (error) {
      setStatus(`保存失败：${error.message}`, true)
    } finally {
      saveSemantics.disabled = false
    }
  })

  $('openModel').addEventListener('click', () => showPage('model'))

  modelSelect.addEventListener('change', async () => {
    const [kind, ...rest] = modelSelect.value.split(':')
    const id = rest.join(':')
    const value = await call('select_live2d_model', { kind, id })
    if (value) {
      renderLive2dModel(value)
      await loadLive2dModel()
      setStatus(`已切换模型：${value.name}`)
    } else {
      await loadLive2dModel()
    }
    await loadModelProfile()
  })

  deleteModel.addEventListener('click', async () => {
    const id = deleteSelect.value
    if (!id) return
    const name = deleteSelect.selectedOptions[0]?.textContent || id
    if (!window.confirm(`确定删除自定义模型“${name}”？模型文件会从磁盘移除，此操作不可撤销。`)) {
      return
    }
    deleteModel.disabled = true
    const value = await call('delete_live2d_model', { id })
    if (value) {
      renderLive2dModel(value)
      await loadLive2dModel()
      setStatus(`已删除模型：${name}`)
    }
    deleteModel.disabled = false
  })

  $('importModel').addEventListener('click', async () => {
    if (typeof invoke !== 'function') {
      setStatus('Tauri IPC 不可用', true)
      return
    }
    const button = $('importModel')
    button.disabled = true
    setStatus('请选择 Live2D 模型文件…')
    try {
      const value = await invoke('import_live2d_model')
      if (!value) {
        setStatus('已取消导入')
        return
      }
      renderLive2dModel(value)
      await loadLive2dModel()
      setStatus('模型已导入，桌宠正在重载')
    } catch (error) {
      setStatus(`导入失败：${error instanceof Error ? error.message : String(error)}`, true)
    } finally {
      button.disabled = false
    }
  })

  $('resetModel').addEventListener('click', async () => {
    const value = await call('reset_live2d_model')
    if (value) {
      renderLive2dModel(value)
      await loadLive2dModel()
      setStatus('已恢复默认模型')
    }
  })

  // Pet settings
  const framing = $('framing')
  const doubleClickExpression = $('doubleClickExpression')
  let scaleTimer = null
  function applyScale() {
    scaleValue.textContent = `${scale.value}%`
    if (scaleTimer) clearTimeout(scaleTimer)
    scaleTimer = setTimeout(async () => {
      const result = await call('apply_pet_settings', {
        settings: { scale: Number(scale.value) / 100 },
      })
      if (result !== null) setStatus(`大小已设为 ${scale.value}%`)
    }, 120)
  }

  scale.addEventListener('input', applyScale)

  async function loadDisplay() {
    try {
      const value = await hostFetch('/api/display')
      const mode = value?.display?.framing
      if (mode === 'full' || mode === 'bust') framing.value = mode
      if (typeof value?.display?.doubleClickExpression === 'boolean') {
        doubleClickExpression.checked = value.display.doubleClickExpression
      }
    } catch {}
  }

  framing.addEventListener('change', async () => {
    try {
      await hostFetch('/api/display', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ framing: framing.value }),
      })
      setStatus(framing.value === 'bust' ? '已切换为半身显示' : '已切换为全身显示')
    } catch (error) {
      setStatus(`切换失败：${error.message}`, true)
    }
  })

  doubleClickExpression.addEventListener('change', async () => {
    try {
      await hostFetch('/api/display', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ doubleClickExpression: doubleClickExpression.checked }),
      })
      setStatus(doubleClickExpression.checked ? '已启用双击换表情' : '已关闭双击换表情')
    } catch (error) {
      doubleClickExpression.checked = !doubleClickExpression.checked
      setStatus(`切换失败：${error.message}`, true)
    }
  })

  reduced.addEventListener('change', async () => {
    const result = await call('apply_pet_settings', {
      settings: { reducedMotion: reduced.checked },
    })
    if (result !== null) setStatus(reduced.checked ? '已减少动态' : '已恢复动态')
  })

  alwaysOnTop?.addEventListener('change', async () => {
    // Tauri resolves a Rust `Result<(), String>` command with null on success,
    // so success must be judged by "no exception", not by the return value.
    try {
      await invoke('apply_pet_settings', {
        settings: { alwaysOnTop: alwaysOnTop.checked },
      })
      setStatus(alwaysOnTop.checked ? '桌宠已置顶' : '桌宠已取消置顶（随其他窗口下沉）')
    } catch (error) {
      alwaysOnTop.checked = !alwaysOnTop.checked
      setStatus(`切换失败：${error instanceof Error ? error.message : String(error)}`, true)
    }
  })

  // Subtitle settings
  const subtitleVisible = $('subtitleVisible')
  const subtitleSnap = $('subtitleSnap')
  const subtitleSemi = $('subtitleSemi')
  const subtitleSide = $('subtitleSide')
  const subtitleWidth = $('subtitleWidth')
  const subtitleWidthValue = $('subtitleWidthValue')
  const subtitleHeight = $('subtitleHeight')
  const subtitleHeightValue = $('subtitleHeightValue')
  const subtitleFont = $('subtitleFont')
  const subtitleFontValue = $('subtitleFontValue')
  const subtitleBg = $('subtitleBg')
  const subtitleBgValue = $('subtitleBgValue')
  const subtitleText = $('subtitleText')

  function applySubtitleLimits() {
    const maxWidth = Math.max(240, Math.floor((window.screen?.availWidth || 1707) * 0.8))
    const maxHeight = Math.max(60, Math.floor((window.screen?.availHeight || 1067) * 0.5))
    subtitleWidth.max = String(maxWidth)
    subtitleHeight.max = String(maxHeight)
    if (Number(subtitleWidth.value) > maxWidth) subtitleWidth.value = String(maxWidth)
    if (Number(subtitleHeight.value) > maxHeight) subtitleHeight.value = String(maxHeight)
  }

  function renderSubtitleSettings(settings) {
    if (!settings) return
    subtitleVisible.checked = !!settings.visible
    subtitleSnap.checked = !!settings.snap
    subtitleSemi.checked = settings.semiTransparent !== false
    subtitleBg.disabled = !subtitleSemi.checked
    subtitleSide.value = settings.side || 'auto'
    subtitleWidth.value = String(Math.round(settings.width || 640))
    subtitleWidthValue.textContent = `${subtitleWidth.value}px`
    subtitleHeight.value = String(Math.round(settings.height || 120))
    subtitleHeightValue.textContent = `${subtitleHeight.value}px`
    subtitleFont.value = String(Math.round(settings.fontSize || 16))
    subtitleFontValue.textContent = `${subtitleFont.value}px`
    subtitleBg.value = String(Math.round((settings.backgroundOpacity ?? 0.72) * 100))
    subtitleBgValue.textContent = `${subtitleBg.value}%`
    subtitleText.value = settings.text || ''
  }

  async function loadSubtitleSettings() {
    const settings = await call('get_subtitle_settings')
    if (settings) renderSubtitleSettings(settings)
  }

  async function patchSubtitle(patch, message) {
    const result = await call('apply_subtitle_settings', { settings: patch })
    if (result !== null) {
      if (message) setStatus(message)
      return true
    }
    return false
  }

  subtitleVisible.addEventListener('change', () => {
    void patchSubtitle(
      { visible: subtitleVisible.checked },
      subtitleVisible.checked ? '字幕已显示' : '字幕已隐藏（可在本页重新开启）',
    )
  })

  subtitleSnap.addEventListener('change', () => {
    void patchSubtitle(
      { snap: subtitleSnap.checked },
      subtitleSnap.checked ? '字幕已吸附桌宠' : '字幕已取消吸附，可拖动',
    )
  })

  subtitleSemi.addEventListener('change', () => {
    subtitleBg.disabled = !subtitleSemi.checked
    void patchSubtitle(
      { semiTransparent: subtitleSemi.checked },
      subtitleSemi.checked ? '字幕已启用半透明背景' : '字幕背景已透明',
    )
  })

  subtitleSide.addEventListener('change', () => {
    void patchSubtitle({ side: subtitleSide.value }, '字幕吸附方向已更新')
  })

  let widthTimer = null
  subtitleWidth.addEventListener('input', () => {
    subtitleWidthValue.textContent = `${subtitleWidth.value}px`
    if (widthTimer) clearTimeout(widthTimer)
    widthTimer = setTimeout(() => {
      void patchSubtitle({ width: Number(subtitleWidth.value) }, '字幕宽度已更新')
    }, 100)
  })

  let heightTimer = null
  subtitleHeight.addEventListener('input', () => {
    subtitleHeightValue.textContent = `${subtitleHeight.value}px`
    if (heightTimer) clearTimeout(heightTimer)
    heightTimer = setTimeout(() => {
      void patchSubtitle({ height: Number(subtitleHeight.value) }, '字幕高度已更新')
    }, 100)
  })

  let fontTimer = null
  subtitleFont.addEventListener('input', () => {
    subtitleFontValue.textContent = `${subtitleFont.value}px`
    if (fontTimer) clearTimeout(fontTimer)
    fontTimer = setTimeout(() => {
      void patchSubtitle({ fontSize: Number(subtitleFont.value) }, '字幕字号已更新')
    }, 100)
  })

  let bgTimer = null
  subtitleBg.addEventListener('input', () => {
    subtitleBgValue.textContent = `${subtitleBg.value}%`
    if (bgTimer) clearTimeout(bgTimer)
    bgTimer = setTimeout(() => {
      void patchSubtitle(
        { backgroundOpacity: Number(subtitleBg.value) / 100 },
        '字幕背景已更新',
      )
    }, 100)
  })

  let textTimer = null
  subtitleText.addEventListener('input', () => {
    if (textTimer) clearTimeout(textTimer)
    textTimer = setTimeout(() => {
      void patchSubtitle({ text: subtitleText.value }, '字幕预览文本已更新')
    }, 250)
  })

  // The subtitle menu can change visible/snap while this window is unfocused;
  // reload when the user returns.
  window.addEventListener('focus', () => {
    void loadSubtitleSettings()
    void loadChatSettings()
    void loadActivity()
    void loadPersona()
    void loadLive2dModel()
  })

  // Chat input bar settings
  const chatVisible = $('chatVisible')
  const chatSnap = $('chatSnap')
  const chatFollow = $('chatFollow')
  const chatSide = $('chatSide')
  const chatWidth = $('chatWidth')
  const chatWidthValue = $('chatWidthValue')
  const chatTopmost = $('chatTopmost')
  const activity = $('activity')
  const personaName = $('personaName')
  const personaFile = $('personaFile')

  function applyChatLimits() {
    const maxWidth = Math.max(360, Math.floor((window.screen?.availWidth || 1707) * 0.8))
    chatWidth.max = String(maxWidth)
    if (Number(chatWidth.value) > maxWidth) chatWidth.value = String(maxWidth)
  }

  function renderChatSettings(settings) {
    if (!settings) return
    chatVisible.checked = !!settings.visible
    chatSnap.checked = !!settings.snap
    chatFollow.checked = !!settings.followSubtitle
    chatSide.value = settings.side || 'auto'
    chatWidth.value = String(Math.round(settings.width || 560))
    chatWidthValue.textContent = `${chatWidth.value}px`
    chatTopmost.checked = !!settings.alwaysOnTop
  }

  async function loadChatSettings() {
    const settings = await call('get_chat_settings')
    if (settings) renderChatSettings(settings)
  }

  async function patchChat(patch, message) {
    const result = await call('apply_chat_settings', { settings: patch })
    if (result !== null) {
      if (message) setStatus(message)
      return true
    }
    return false
  }

  async function loadActivity() {
    const value = await call('get_behavior')
    if (value?.activity) activity.value = value.activity
  }

  async function loadPersona() {
    const value = await call('get_persona')
    if (value?.name) personaName.textContent = value.name
  }

  chatVisible.addEventListener('change', () => {
    void patchChat(
      { visible: chatVisible.checked },
      chatVisible.checked ? '输入条已显示' : '输入条已隐藏（托盘可恢复）',
    )
  })

  chatSnap.addEventListener('change', () => {
    void patchChat(
      { snap: chatSnap.checked },
      chatSnap.checked ? '输入条已自动吸附' : '输入条已取消吸附，可拖动',
    )
  })

  chatFollow.addEventListener('change', () => {
    void patchChat(
      { followSubtitle: chatFollow.checked },
      chatFollow.checked ? '字幕未吸附时输入条将跟随字幕' : '输入条不再跟随自由字幕',
    )
  })

  chatSide.addEventListener('change', () => {
    void patchChat({ side: chatSide.value }, '输入条吸附方向已更新')
  })

  chatTopmost.addEventListener('change', () => {
    void patchChat(
      { alwaysOnTop: chatTopmost.checked },
      chatTopmost.checked ? '输入条已置顶' : '输入条已取消置顶',
    )
  })

  let chatWidthTimer = null
  chatWidth.addEventListener('input', () => {
    chatWidthValue.textContent = `${chatWidth.value}px`
    if (chatWidthTimer) clearTimeout(chatWidthTimer)
    chatWidthTimer = setTimeout(() => {
      void patchChat({ width: Number(chatWidth.value) }, '输入条宽度已更新')
    }, 100)
  })

  activity.addEventListener('change', async () => {
    const result = await call('set_activity', { activity: activity.value })
    if (result !== null) {
      setStatus(`工作时活跃程度：${{ quiet: '安静', normal: '标准', active: '活跃' }[activity.value] || activity.value}`)
    }
  })

  $('uploadPersona').addEventListener('click', () => personaFile.click())
  personaFile.addEventListener('change', () => {
    const file = personaFile.files?.[0]
    if (!file) return
    if (!/\.md$/i.test(file.name)) {
      setStatus('人格文件必须是 .md', true)
      personaFile.value = ''
      return
    }
    if (file.size > 200 * 1024) {
      setStatus('人格文件不能超过 200KB', true)
      personaFile.value = ''
      return
    }
    const reader = new FileReader()
    reader.onload = async () => {
      const content = String(reader.result || '')
      const value = await call('save_persona', { name: file.name, content })
      if (value?.name) {
        personaName.textContent = value.name
        setStatus(`当前人格：${value.name}`)
      }
      personaFile.value = ''
    }
    reader.onerror = () => setStatus('读取人格文件失败', true)
    reader.readAsText(file, 'utf-8')
  })

  $('resetPersona').addEventListener('click', async () => {
    const value = await call('reset_persona')
    if (value?.name) {
      personaName.textContent = value.name
      setStatus('已恢复默认人格')
    }
  })

  $('openChat').addEventListener('click', async () => {
    if ((await call('open_chat_window')) !== null) setStatus('输入条已打开')
  })

  // Footer actions
  $('show').addEventListener('click', async () => {
    if ((await call('show_pet_command')) !== null) setStatus('已显示桌宠')
  })
  $('hidePet').addEventListener('click', async () => {
    if ((await call('hide_pet_command')) !== null) setStatus('已隐藏桌宠（托盘可恢复）')
  })
  $('openDsh').addEventListener('click', async () => {
    if ((await call('open_webui_command')) !== null) setStatus('已在浏览器打开 DSH')
  })
  $('quit').addEventListener('click', async () => {
    await call('quit_app_command')
  })

  autoStart.addEventListener('change', async () => {
    const enabled = autoStart.checked
    const value = await call('set_pet_autostart', { enabled })
    if (value === null) {
      autoStart.checked = !enabled
      return
    }
    setStatus(enabled ? 'DSH 启动时将自动启动桌宠' : '已关闭 DSH 启动自启动；当前桌宠不受影响')
  })

  // Double-click a slider's value label to type an exact integer for it.
  // Dragging still follows the slider's own step; a typed value wins over that
  // step, keeps the slider's range, and then runs the normal apply path.
  function editableNumber(display, slider) {
    if (!display || !slider) return
    display.classList.add('editable')
    display.title = '双击输入精确数值'
    display.addEventListener('dblclick', (event) => {
      event.preventDefault()
      if (display.querySelector('input')) return
      const original = display.textContent
      const editor = document.createElement('input')
      editor.type = 'number'
      editor.step = '1'
      editor.inputMode = 'numeric'
      editor.className = 'value-editor'
      editor.value = String(Math.round(Number(slider.value) || 0))
      display.textContent = ''
      display.append(editor)
      editor.focus()
      editor.select()

      let done = false
      const finish = (commit) => {
        if (done) return
        done = true
        const raw = editor.value.trim()
        const typed = Number(raw)
        editor.remove()
        if (!commit || raw === '' || !Number.isFinite(typed)) {
          display.textContent = original
          return
        }
        const min = Number(slider.min)
        const max = Number(slider.max)
        let next = Math.round(typed)
        if (Number.isFinite(min)) next = Math.max(min, next)
        if (Number.isFinite(max)) next = Math.min(max, next)
        // Every slider uses step=1 so an exact typed value is not snapped back
        // to a coarse grid (16 must stay 16, not become 15).
        slider.value = String(next)
        slider.dispatchEvent(new Event('input', { bubbles: true }))
        // Each slider's own input handler repaints the label; keep the old text
        // only if a control forgot to.
        if (!display.textContent) display.textContent = original
      }

      editor.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          finish(true)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          finish(false)
        }
      })
      editor.addEventListener('blur', () => finish(true))
    })
  }

  for (const [displayId, sliderId] of [
    ['scaleValue', 'scale'],
    ['subtitleWidthValue', 'subtitleWidth'],
    ['subtitleHeightValue', 'subtitleHeight'],
    ['subtitleFontValue', 'subtitleFont'],
    ['subtitleBgValue', 'subtitleBg'],
    ['chatWidthValue', 'chatWidth'],
    ['voiceEdgeRateValue', 'voiceEdgeRate'],
    ['voiceEdgePitchValue', 'voiceEdgePitch'],
    ['voiceGsvSpeedValue', 'voiceGsvSpeed'],
    ['voiceVolumeValue', 'voiceVolume'],
  ]) {
    editableNumber($(displayId), $(sliderId))
  }

  // GPT-SoVITS local service control: starts/stops the user's own engine.
  const gsvStatusText = $('gsvStatus')
  const gsvStartButton = $('gsvStart')
  const gsvStopButton = $('gsvStop')
  const gsvAppDirText = $('gsvAppDir')

  async function loadGsvStatus() {
    if (!gsvStatusText) return
    try {
      const value = await hostFetch('/api/gsv/status')
      const gsv = value?.gsv
      if (!gsv) {
        gsvStatusText.textContent = '服务不可用'
        return
      }
      if (gsvAppDirText) gsvAppDirText.textContent = gsv.appDir || '未找到安装目录'
      const parts = []
      if (gsv.running) parts.push('运行中')
      else if (gsv.starting) parts.push('启动中…')
      else parts.push('未启动')
      if (gsv.pid) parts.push(`pid ${gsv.pid}`)
      if (gsv.error) parts.push(gsv.error)
      gsvStatusText.textContent = parts.join(' · ')
      if (gsvStartButton) gsvStartButton.disabled = !!(gsv.running || gsv.starting)
      if (gsvStopButton) gsvStopButton.disabled = !(gsv.running || gsv.starting)
    } catch (error) {
      gsvStatusText.textContent = `读取失败：${error.message}`
    }
  }

  gsvStartButton?.addEventListener('click', async () => {
    gsvStartButton.disabled = true
    setStatus('正在启动 GPT-SoVITS…')
    try {
      const value = await hostFetch('/api/gsv/start', { method: 'POST' })
      if (value?.ok) {
        setStatus(value.alreadyRunning ? 'GPT-SoVITS 已在运行' : 'GPT-SoVITS 启动中，首次加载模型需要一会儿…')
      } else {
        setStatus(`启动失败：${value?.error || '未知错误'}`, true)
      }
      window.setTimeout(() => { void loadGsvStatus() }, 1500)
    } catch (error) {
      setStatus(`启动失败：${error.message}`, true)
    }
  })

  gsvStopButton?.addEventListener('click', async () => {
    gsvStopButton.disabled = true
    try {
      const value = await hostFetch('/api/gsv/stop', { method: 'POST' })
      setStatus(value?.stopped ? 'GPT-SoVITS 已停止' : 'GPT-SoVITS 未在运行')
      window.setTimeout(() => { void loadGsvStatus() }, 800)
    } catch (error) {
      setStatus(`停止失败：${error.message}`, true)
    }
  })

  // Engine inventory: which voice engines are usable and switching between them.
  async function loadEngines() {
    const list = $('engineList')
    if (!list) return
    try {
      const value = await hostFetch('/api/engines')
      const engines = Array.isArray(value?.engines) ? value.engines : []
      list.innerHTML = ''
      for (const engine of engines) {
        const row = document.createElement('div')
        row.className = 'expr-row'
        const label = document.createElement('span')
        const state = engine.current
          ? '当前'
          : engine.available
            ? '可用'
            : engine.installed
              ? '缺少权重/参考音'
              : '未安装'
        label.textContent = `${engine.name}（${state}）`
        label.title = [engine.detail, engine.appDir].filter(Boolean).join(' · ')
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'ghost'
        button.textContent = engine.current ? '已启用' : '切换'
        button.disabled = !!engine.current || !engine.available
        button.addEventListener('click', async () => {
          button.disabled = true
          try {
            const result = await hostFetch('/api/engines/select', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ engine: engine.id }),
            })
            if (result?.ok) {
              setStatus(`语音引擎已切换到 ${engine.name}`)
              await loadVoiceSettings()
              await loadEngines()
            } else {
              setStatus(`切换失败：${result?.error || '未知错误'}`, true)
            }
          } catch (error) {
            setStatus(`切换失败：${error.message}`, true)
          } finally {
            button.disabled = false
          }
        })
        row.append(label, button)
        list.append(row)
      }
    } catch (error) {
      list.textContent = `读取失败：${error.message}`
    }
  }

  window.setInterval(() => {
    const voicePage = $('page-voice')
    if (!voicePage || voicePage.hidden) return
    void loadGsvStatus()
    void loadEngines()
  }, 3000)

  // Initial load
  ;(async () => {
    applySubtitleLimits()
    applyChatLimits()
    const current = await call('get_pet_settings')
    if (current) {
      scale.value = String(Math.round(current.scale * 100))
      scaleValue.textContent = `${scale.value}%`
      reduced.checked = !!current.reducedMotion
      if (alwaysOnTop) alwaysOnTop.checked = current.alwaysOnTop !== false
    }
    const savedAutoStart = await call('get_pet_autostart')
    if (typeof savedAutoStart === 'boolean') autoStart.checked = savedAutoStart
    await loadSubtitleSettings()
    await loadChatSettings()
    await loadVoiceSettings()
    await loadActivity()
    await loadPersona()
    await loadLive2dModel()
    await loadModelProfile()
    await loadDisplay()
    setStatus('就绪')
    void call('settings_ui_ready')
  })()
})()
