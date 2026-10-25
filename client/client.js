// dsh-dstuber Client half.
//
// Two contributions:
//  - settings.plugins.tab: a native React settings page for the plugin.
//  - shell.overlay: an opt-in Live2D stage in the page corner. The stage runs
//    the same URL the Tauri shell will load and reports its self-test back to
//    the Host, so Live2D is verified in the real browser engine.
//
// No Host page is embedded for settings (the Host serves only the Live2D
// stage, which is artwork, not a settings form). Theme colors come from
// --dsw-alias-* tokens so light/dark switch with the app.
window.__ModuleLoader__.load({
  id: 'dsh-dstuber',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/plugins/dsh-dstuber'
    // Production URLs intentionally carry no test HUD or self-test: the page
    // overlay and the desktop pet must look clean. The standalone studio URL
    // (opened explicitly from settings) still opts into `hud=1&selftest=1`.
    const STAGE = `${API}/stage/index.html?bg=none`

    const CSS = `
      .dsh-dstuber-root { color: var(--dsw-alias-label-primary); font: 13px/1.55 "Segoe UI", "Microsoft YaHei", sans-serif; }
      .dsh-dstuber-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 14px 16px; margin: 0 0 12px; }
      .dsh-dstuber-card h3 { margin: 0 0 2px; font-size: 13px; font-weight: 600; }
      .dsh-dstuber-card p.dsh-dstuber-desc { margin: 0 0 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
      .dsh-dstuber-row { display: grid; grid-template-columns: minmax(140px, 220px) 1fr; gap: 8px 16px; align-items: center; padding: 7px 0; border-top: 1px dashed color-mix(in srgb, var(--dsw-alias-border-l1) 65%, transparent); }
      .dsh-dstuber-row:first-of-type { border-top: 0; }
      .dsh-dstuber-label { font-size: 12.5px; }
      .dsh-dstuber-hint { display: block; color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
      .dsh-dstuber-input, .dsh-dstuber-select { width: 100%; box-sizing: border-box; padding: 6px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; }
      .dsh-dstuber-input:focus, .dsh-dstuber-select:focus { outline: 2px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent); outline-offset: 1px; }
      .dsh-dstuber-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
      .dsh-dstuber-switch input { inline-size: 16px; block-size: 16px; accent-color: var(--dsw-alias-brand-primary); }
      .dsh-dstuber-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .dsh-dstuber-btn { padding: 6px 13px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; cursor: pointer; }
      .dsh-dstuber-btn:hover { border-color: var(--dsw-alias-brand-primary); }
      .dsh-dstuber-btn.primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
      .dsh-dstuber-btn:disabled { opacity: .55; cursor: default; }
      .dsh-dstuber-pill { display: inline-flex; gap: 6px; align-items: center; padding: 2px 9px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
      .dsh-dstuber-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
      .dsh-dstuber-dot.ok { background: var(--dsw-alias-state-success-primary); }
      .dsh-dstuber-dot.bad { background: var(--dsw-alias-state-error-primary); }
      .dsh-dstuber-note { margin-top: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .dsh-dstuber-error { color: var(--dsw-alias-state-error-primary); }
      .dsh-dstuber-preview { display: grid; grid-template-columns: 360px 1fr; gap: 14px; align-items: start; }
      .dsh-dstuber-frame { width: 360px; height: 450px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-base); overflow: hidden; }
      .dsh-dstuber-mono { font-family: Consolas, "Cascadia Mono", monospace; font-size: 11.5px; overflow-wrap: anywhere; }
      .dsh-dstuber-overlay { position: fixed; right: 16px; bottom: 12px; z-index: 2147483000; pointer-events: none; }
      .dsh-dstuber-overlay-frame { width: 100%; height: 100%; border: 0; background: transparent; pointer-events: none; }
      .dsh-dstuber-overlay-chip { position: absolute; right: 2px; top: -26px; pointer-events: auto; display: inline-flex; gap: 6px; align-items: center; padding: 3px 9px; border-radius: 999px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font: 11.5px/1.4 "Segoe UI", "Microsoft YaHei", sans-serif; cursor: pointer; }
      .dsh-dstuber-overlay-close { position: absolute; right: 2px; top: 2px; pointer-events: auto; width: 22px; height: 22px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-secondary); cursor: pointer; line-height: 1; }
      @media (max-width: 760px) { .dsh-dstuber-row { grid-template-columns: 1fr; } .dsh-dstuber-preview { grid-template-columns: 1fr; } .dsh-dstuber-frame { width: 100%; } }
    `

    const SECTIONS = [
      {
        title: '桌宠',
        desc: '面板内的 Live2D 浮层用于阶段一验证；桌面壳会复用同一个 stage 页面。',
        fields: [
          { path: 'enabled', label: '启用 dsh-dstuber', type: 'bool', hint: '关闭后不注册事件桥与页面浮层' },
          { path: 'pet.webOverlay', label: '页面内 Live2D 浮层', type: 'bool', hint: '默认关闭；开启后显示在页面右下角（无测试 HUD）' },
          { path: 'pet.overlaySize', label: '浮层宽度', type: 'number', min: 240, max: 720, step: 20, hint: '像素' },
          { path: 'pet.scale', label: '桌宠缩放', type: 'number', min: 0.5, max: 1.5, step: 0.05 },
          { path: 'pet.opacity', label: '不透明度', type: 'number', min: 0.4, max: 1, step: 0.05 },
          { path: 'pet.alwaysOnTop', label: '桌面壳置顶', type: 'bool' },
          { path: 'pet.clickThrough', label: '桌面壳点击穿透', type: 'bool' },
          { path: 'pet.chatEnabled', label: '显示对话窗', type: 'bool' },
        ],
      },
      {
        title: '对话',
        desc: '对话窗是当前 DSH 会话的远程输入/输出，不另开人格聊天。',
        fields: [
          { path: 'chat.target', label: '目标会话', type: 'text', hint: 'auto，或某个 sessionId' },
          { path: 'chat.sendMode', label: '发送方式', type: 'select', options: [['followup', '排队（followup）'], ['steer', '插话（steer）']] },
          { path: 'chat.showReplies', label: '字幕显示回复', type: 'bool' },
          { path: 'chat.maxHeightRatio', label: '字幕最大高度比例', type: 'number', min: 0.15, max: 0.6, step: 0.05 },
          { path: 'chat.history', label: '输入历史条数', type: 'number', min: 0, max: 20, step: 1 },
          { path: 'chat.stopTtsOnSend', label: '发送时停止朗读', type: 'bool' },
        ],
      },
      {
        title: '语音',
        desc: '语音引擎在插件自己的设置窗口里配置（Edge TTS 免配置，或本地 GPT-SoVITS）。',
        fields: [
          { path: 'voice.provider', label: '语音通道', type: 'select', options: [['edge', 'Edge TTS'], ['gpt-sovits', 'GPT-SoVITS']] },
          { path: 'voice.readMurmurs', label: '碎碎念朗读', type: 'select', options: [['off', '不朗读'], ['important', '仅重要'], ['all', '全部']] },
          { path: 'voice.volume', label: '播放音量', type: 'number', min: 0, max: 1, step: 0.05 },
        ],
      },
      {
        title: 'Live2D',
        desc: '模型目录留空时依次使用数据目录与开发目录。',
        fields: [
          { path: 'live2d.model', label: '模型 id', type: 'text' },
          { path: 'live2d.modelDir', label: '模型目录', type: 'text', placeholder: '留空自动解析' },
          { path: 'live2d.lipSync', label: '口型灵敏度', type: 'number', min: 0, max: 1, step: 0.05 },
          { path: 'live2d.idleMotion', label: '空闲动作', type: 'bool' },
          { path: 'live2d.blink', label: '自动眨眼', type: 'bool' },
          { path: 'live2d.lookAtCursor', label: '看向鼠标', type: 'bool' },
        ],
      },
      {
        title: '桌面壳',
        desc: 'Host 在 DSH 启动/插件重载时自动拉起 Tauri 透明窗；关闭自动启动后需手动运行 scripts/run-shell.ps1。',
        fields: [
          { path: 'shell.autoStart', label: '自动启动桌面壳', type: 'bool', hint: 'DSH 重启后桌宠自动回来' },
          { path: 'shell.executable', label: '可执行文件', type: 'text', placeholder: '留空自动查找 release/debug' },
          { path: 'shell.restart', label: '崩溃后自动重启', type: 'bool' },
        ],
      },
      {
        title: '高级',
        desc: '自检报告来自页面内 stage 的真实运行结果。',
        fields: [
          { path: 'advanced.logLevel', label: '日志级别', type: 'select', options: [['info', 'info'], ['debug', 'debug']] },
          { path: 'advanced.stageSelftest', label: '浮层自动自检', type: 'bool' },
        ],
      },
    ]

    function getIn(object, path) {
      return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), object)
    }

    function setIn(object, path, value) {
      const clone = JSON.parse(JSON.stringify(object ?? {}))
      const keys = path.split('.')
      let node = clone
      for (let i = 0; i < keys.length - 1; i++) {
        if (node[keys[i]] == null || typeof node[keys[i]] !== 'object') node[keys[i]] = {}
        node = node[keys[i]]
      }
      node[keys[keys.length - 1]] = value
      return clone
    }

    async function request(path, options) {
      const response = await fetch(API + path, {
        cache: 'no-store',
        headers: options?.body ? { 'content-type': 'application/json' } : undefined,
        ...options,
      })
      const text = await response.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
      if (!response.ok) {
        const error = new Error(body?.error || `HTTP ${response.status}`)
        error.status = response.status
        error.body = body
        throw error
      }
      return body
    }

    function Card({ title, desc, children }) {
      return h('section', { className: 'dsh-dstuber-card' },
        h('h3', null, title),
        desc ? h('p', { className: 'dsh-dstuber-desc' }, desc) : null,
        children,
      )
    }

    function Field({ field, value, onChange, keySet }) {
      const set = (next) => onChange(field.path, next)
      let control
      if (field.type === 'bool') {
        control = h('label', { className: 'dsh-dstuber-switch' },
          h('input', { type: 'checkbox', checked: value === true, onChange: (e) => set(e.target.checked) }),
          h('span', null, value === true ? '开' : '关'),
        )
      } else if (field.type === 'number') {
        control = h('input', {
          className: 'dsh-dstuber-input', type: 'number', value: value ?? '', min: field.min, max: field.max, step: field.step,
          onChange: (e) => set(e.target.value === '' ? undefined : Number(e.target.value)),
        })
      } else if (field.type === 'select') {
        control = h('select', {
          className: 'dsh-dstuber-select', value: value ?? '', onChange: (e) => set(e.target.value),
        }, field.options.map(([optionValue, optionLabel]) => h('option', { key: optionValue, value: optionValue }, optionLabel)))
      } else if (field.type === 'secret') {
        control = h('input', {
          className: 'dsh-dstuber-input', type: 'password', value: value ?? '', autoComplete: 'new-password',
          placeholder: keySet ? '已配置（留空不修改）' : '未配置',
          onChange: (e) => set(e.target.value),
        })
      } else {
        control = h('input', {
          className: 'dsh-dstuber-input', type: 'text', value: value ?? '', placeholder: field.placeholder || '',
          onChange: (e) => set(e.target.value),
        })
      }
      return h('div', { className: 'dsh-dstuber-row' },
        h('div', { className: 'dsh-dstuber-label' }, field.label, field.hint ? h('span', { className: 'dsh-dstuber-hint' }, field.hint) : null),
        h('div', null, control),
      )
    }

    function SettingsPage() {
      const [value, setValue] = React.useState(null)
      const [revision, setRevision] = React.useState(0)
      const [keySet, setKeySet] = React.useState(false)
      const [source, setSource] = React.useState('loading')
      const [health, setHealth] = React.useState(null)
      const [report, setReport] = React.useState(null)
      const [selftest, setSelftest] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)

      const load = React.useCallback(async () => {
        setError(null)
        try {
          const config = await request('/api/config')
          setValue(config.value || {})
          setRevision(config.revision || 0)
          setKeySet(!!config.keySet)
          setSource(config.source || 'settings')
        } catch (err) {
          setError(err.message)
        }
        try { setHealth(await request('/api/health')) } catch {}
        try {
          const stage = await request('/api/stage-report')
          setReport(stage.report || null)
          setSelftest(stage.selftest || null)
        } catch {}
      }, [])

      React.useEffect(() => {
        load()
        const timer = setInterval(() => {
          request('/api/stage-report')
            .then((stage) => {
              setReport(stage.report || null)
              setSelftest(stage.selftest || null)
            })
            .catch(() => {})
        }, 4000)
        return () => clearInterval(timer)
      }, [load])

      const onChange = React.useCallback((path, next) => {
        setNotice(null)
        setValue((current) => setIn(current ?? {}, path, next))
      }, [])

      const save = React.useCallback(async () => {
        if (!value) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const result = await request('/api/config', {
            method: 'PATCH',
            body: JSON.stringify({ patch: value, revision }),
          })
          setValue(result.value || {})
          setRevision(result.revision || 0)
          setKeySet(!!result.keySet)
          setNotice('已保存，设置会即时生效（工作流结构变更需重启）。')
        } catch (err) {
          if (err.status === 409) setNotice('配置已被其它入口修改，正在刷新…')
          else setError(err.message)
          if (err.status === 409) load()
        } finally {
          setBusy(false)
        }
      }, [value, revision, load])

      const openStudio = React.useCallback(() => {
        window.open(`${API}/stage/index.html?bg=grid&hud=1&selftest=1`, '_blank', 'noopener')
      }, [])

      // Hooks must run on every render, before any conditional return below.
      const startPet = React.useCallback(async () => {
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const result = await request('/api/shell/start', { method: 'POST' })
          if (result?.ok) setNotice('桌宠已启动')
          else setError(result?.error || '启动失败')
          // The shell spawns asynchronously; refresh once it has had a moment.
          setTimeout(() => { void load() }, 1800)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }, [load])

      const quitPet = React.useCallback(async () => {
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const result = await request('/api/shell/quit', { method: 'POST' })
          if (result?.ok) setNotice('桌宠已退出，所有服务已停止（数据保留）')
          else setError(result?.error || '退出失败')
          setTimeout(() => { void load() }, 1200)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy(false)
        }
      }, [load])

      if (!value) {
        return h('div', { className: 'dsh-dstuber-root' },
          h('style', null, CSS),
          h(Card, { title: 'dsh-dstuber', desc: '正在读取 Host 配置…' },
            error ? h('div', { className: 'dsh-dstuber-error' }, error) : h('div', { className: 'dsh-dstuber-note' }, '加载中'),
            h('div', { className: 'dsh-dstuber-actions', style: { marginTop: 10 } },
              h('button', { className: 'dsh-dstuber-btn', onClick: load, disabled: busy }, '重试'),
            ),
          ),
        )
      }

      const model = health?.model
      // Only a real self-check report decides pass/fail; heartbeats must not
      // look like a failure.
      const reportOk = selftest?.ok === true
      const reportPill = selftest
        ? h('span', { className: 'dsh-dstuber-pill' },
            h('i', { className: `dsh-dstuber-dot ${reportOk ? 'ok' : 'bad'}` }),
            reportOk ? '自检通过' : '自检失败',
            selftest.expressions ? ` · 表情 ${selftest.expressions.passed}/${selftest.expressions.total}` : '',
            selftest.motions ? ` · 动作 ${selftest.motions.passed}/${selftest.motions.total}` : '',
            selftest.fps ? ` · ${selftest.fps} FPS` : '',
          )
        : h('span', { className: 'dsh-dstuber-pill' }, h('i', { className: 'dsh-dstuber-dot' }), '未运行自检')

      return h('div', { className: 'dsh-dstuber-root' },
        h('style', null, CSS),
        h(Card, {
          title: 'dsh-dstuber · Live2D 桌宠',
          desc: '阶段一：插件骨架与 Live2D 功能验证。配置由 Host 唯一保存，DSH 设置页与页面浮层共用。',
        },
          h('div', { className: 'dsh-dstuber-actions', style: { marginBottom: 8 } },
            h('button', { className: 'dsh-dstuber-btn primary', onClick: startPet, disabled: busy || health?.shell?.running }, health?.shell?.running ? '桌宠运行中' : '启动桌宠'),
            h('button', { className: 'dsh-dstuber-btn', onClick: quitPet, disabled: busy || !health?.shell?.running }, '退出桌宠'),
            notice ? h('span', { className: 'dsh-dstuber-note' }, notice) : null,
            error ? h('span', { className: 'dsh-dstuber-note dsh-dstuber-error' }, error) : null,
          ),
          h('div', { className: 'dsh-dstuber-actions' },
            h('span', { className: 'dsh-dstuber-pill' }, h('i', { className: 'dsh-dstuber-dot ok' }), `Host ${health?.version || ''}`),
            h('span', { className: 'dsh-dstuber-pill' },
              h('i', { className: `dsh-dstuber-dot ${health?.shell?.running ? 'ok' : 'bad'}` }),
              health?.shell?.running ? `桌面壳运行中 pid ${health.shell.pid}` : '桌面壳未运行',
            ),
            h('span', { className: 'dsh-dstuber-pill' }, `配置 ${source} · rev ${revision}`),
            model?.manifest ? h('span', { className: 'dsh-dstuber-pill' }, `${model.manifest.name} · ${model.manifest.expressions} 表情 · ${Object.values(model.manifest.motions || {}).reduce((a, b) => a + b, 0)} 动作`) : null,
          ),
          h('div', { style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            reportPill,
            h('button', { className: 'dsh-dstuber-btn', onClick: openStudio }, '打开独立测试台'),
            h('button', { className: 'dsh-dstuber-btn', onClick: load, disabled: busy }, '刷新'),
          ),
          model?.dir ? h('div', { className: 'dsh-dstuber-note dsh-dstuber-mono' }, `model: ${model.dir}`) : h('div', { className: 'dsh-dstuber-note dsh-dstuber-error' }, `model 未找到：${model?.error || '未知'}`),
          health?.shell?.exe ? h('div', { className: 'dsh-dstuber-note dsh-dstuber-mono' }, `shell: ${health.shell.exe}`) : h('div', { className: 'dsh-dstuber-note dsh-dstuber-error' }, 'shell 未构建：运行 scripts/build-shell.ps1'),
          health?.shell?.lastError ? h('div', { className: 'dsh-dstuber-note dsh-dstuber-error' }, `shell 错误：${health.shell.lastError}`) : null,
          selftest?.error ? h('div', { className: 'dsh-dstuber-note dsh-dstuber-error' }, `自检错误：${selftest.error}`) : null,
          selftest?.webgl ? h('div', { className: 'dsh-dstuber-note dsh-dstuber-mono' }, `webgl: ${selftest.webgl.renderer || selftest.webgl.vendor || 'unknown'} · canvas ${selftest.pixels?.drawn || 0} px`) : null,
        ),

        h(Card, { title: '与 DSH 事件联动', desc: 'Host 通过 SSE 推送会话状态；桌面端右键桌宠打开控制台，左键拖动移动。' },
          h('div', { className: 'dsh-dstuber-note' }, `会话 ${health?.store?.sessions ?? 0} 个 · 当前 ${health?.store?.active || '无'} · 状态 ${health?.store?.pet || 'idle'}`),
          h('div', { className: 'dsh-dstuber-note' }, '事件桥只读：turn/tool/status 与 assistant 文本增量，不含工具参数/结果/文件内容。'),
        ),
        h(Card, { title: '保存', desc: '修改后点击保存；revision 冲突会提示并自动刷新。' },
          h('div', { className: 'dsh-dstuber-actions' },
            h('button', { className: 'dsh-dstuber-btn primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存设置'),
            notice ? h('span', { className: 'dsh-dstuber-note' }, notice) : null,
            error ? h('span', { className: 'dsh-dstuber-note dsh-dstuber-error' }, error) : null,
          ),
        ),

        SECTIONS.map((section) => h(Card, { key: section.title, title: section.title, desc: section.desc },
          section.fields.map((field) => h(Field, {
            key: field.path,
            field,
            value: getIn(value, field.path),
            onChange,
            keySet,
          })),
        )),
      )
    }

    function PetOverlay() {
      const [config, setConfig] = React.useState(null)
      const [pet, setPet] = React.useState(null)
      const frameRef = React.useRef(null)

      React.useEffect(() => {
        let alive = true
        request('/api/config')
          .then((result) => { if (alive) setConfig(result.value || {}) })
          .catch(() => {})
        try {
          const source = new EventSource(`${API}/api/events`)
          source.onmessage = (event) => {
            try {
              const message = JSON.parse(event.data)
              if (message.type === 'snapshot') setPet(message.snapshot?.pet || null)
              if (message.type === 'pet') setPet(message.pet || null)
              if (message.type === 'state') setPet(message.pet || null)
            } catch {}
          }
          return () => {
            alive = false
            source.close()
          }
        } catch {
          return () => { alive = false }
        }
      }, [])

      React.useEffect(() => {
        const frame = frameRef.current
        if (!frame || !pet?.state) return
        try {
          frame.contentWindow?.postMessage({ source: 'dsh-dstuber', type: 'pet.state', state: pet.state }, location.origin)
        } catch {}
      }, [pet?.state])

      if (!config || config.enabled === false || config.pet?.webOverlay === false) return null
      const size = Number(config.pet?.overlaySize) || 380
      const height = Math.round(size * 1.28)
      return h('div', { className: 'dsh-dstuber-overlay', style: { width: size, height } },
        // The stylesheet lives in this component too: an iframe without these
        // rules renders as a default 300x150 bordered block at the layer's
        // top-left, which is not the page-corner pet.
        h('style', null, CSS),
        h('iframe', {
          ref: frameRef,
          className: 'dsh-dstuber-overlay-frame',
          title: 'dsh-dstuber Live2D',
          src: STAGE,
          allow: 'autoplay',
          tabIndex: -1,
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const register = (slot, options, Component) => {
          const install = () => {
            try {
              ctx.slots.register({ name: slot, ...options }, Component)
            } catch (error) {
              console.error(`[dsh-dstuber] slot ${slot} registration failed:`, error)
            }
          }
          try {
            ctx.slots.inject(slot, install)
          } catch (error) {
            console.error(`[dsh-dstuber] slot ${slot} injection failed:`, error)
          }
        }

        register('settings.plugins.tab', { id: 'dsh-dstuber', order: 60, label: '桌宠' }, SettingsPage)
        register('shell.overlay', { id: 'dsh-dstuber-overlay', order: 900 }, PetOverlay)
      },
    }
  },
})
