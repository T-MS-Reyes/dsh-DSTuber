import Schema from '@deepseek-ai/schemastery'

/**
 * Single source of truth for dsh-dstuber settings.
 *
 * The schema is exported as `Config` so the Loader validates the row and the
 * settings service can project an automatic form. Secrets use role('secret'),
 * which the settings service strips on every remote read.
 */
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用 dsh-dstuber（关闭后不提供舞台、事件桥与页面内桌宠）'),

  pet: Schema.object({
    scale: Schema.number().min(0.5).max(1.5).step(0.05).default(1).description('桌宠缩放'),
    opacity: Schema.number().min(0.4).max(1).step(0.05).default(1).description('桌宠不透明度'),
    alwaysOnTop: Schema.boolean().default(true).description('桌面壳置顶'),
    clickThrough: Schema.boolean().default(false).description('桌面壳点击穿透'),
    chatEnabled: Schema.boolean().default(true).description('显示对话窗'),
    webOverlay: Schema.boolean().default(false).description('在 DSH 页面右下角显示 Live2D 浮层（默认关闭）'),
    overlaySize: Schema.number().min(240).max(720).step(20).default(380).description('页面内浮层宽度（像素）'),
  }).description('桌宠外观'),

  chat: Schema.object({
    target: Schema.string().default('auto').description('目标会话：auto 或 sessionId'),
    sendMode: Schema.union([Schema.const('followup'), Schema.const('steer')]).default('followup').description('发送方式'),
    showReplies: Schema.boolean().default(true).description('字幕显示 DSH 回复'),
    maxHeightRatio: Schema.number().min(0.15).max(0.6).step(0.05).default(0.35).description('字幕卡最大高度比例'),
    history: Schema.number().min(0).max(20).step(1).default(6).description('输入历史条数'),
    stopTtsOnSend: Schema.boolean().default(true).description('发送新消息时停止朗读'),
  }).description('对话窗'),

  subtitle: Schema.object({
    markdown: Schema.boolean().default(true).description('渲染 Markdown 子集'),
    tables: Schema.boolean().default(true).description('渲染表格'),
    inlineCode: Schema.boolean().default(true).description('渲染行内代码'),
    codeBlocks: Schema.union([Schema.const('placeholder'), Schema.const('hide')]).default('placeholder').description('代码块处理'),
    attachments: Schema.union([Schema.const('hide'), Schema.const('placeholder')]).default('hide').description('附件处理'),
    maxChars: Schema.number().min(1000).max(200000).step(1000).default(20000).description('字幕最大字符数'),
    autoScroll: Schema.boolean().default(true).description('自动滚动'),
  }).description('字幕'),

  voice: Schema.object({
    provider: Schema.union([Schema.const('edge'), Schema.const('gpt-sovits')]).default('edge').description('语音通道'),
    readMurmurs: Schema.union([Schema.const('off'), Schema.const('important'), Schema.const('all')]).default('important').description('碎碎念朗读范围'),
    volume: Schema.number().min(0).max(1).step(0.05).default(0.8).description('播放音量'),
  }).description('语音'),

  live2d: Schema.object({
    model: Schema.string().default('ds-whale').description('模型 id'),
    modelDir: Schema.string().default('').description('模型目录；留空使用数据目录或开发目录'),
    lipSync: Schema.number().min(0).max(1).step(0.05).default(0.5).description('口型灵敏度'),
    idleMotion: Schema.boolean().default(true).description('空闲动作'),
    blink: Schema.boolean().default(true).description('自动眨眼'),
    lookAtCursor: Schema.boolean().default(true).description('看向鼠标'),
  }).description('Live2D'),

  stickers: Schema.object({
    enabled: Schema.boolean().default(true).description('启用贴纸'),
    mode: Schema.union([Schema.const('important'), Schema.const('all')]).default('important').description('触发频率'),
    textMemes: Schema.boolean().default(false).description('文字梗贴纸'),
    cooldownMs: Schema.number().min(0).max(60000).step(1000).default(8000).description('贴纸冷却（毫秒）'),
    index: Schema.string().default('ds-whale').description('贴纸包 id'),
  }).description('贴纸'),

  persona: Schema.object({
    id: Schema.string().default('whale').description('人格 id'),
    styleCard: Schema.string().default('').description('风格卡路径；留空使用内置'),
  }).description('人格'),

  murmur: Schema.object({
    mode: Schema.union([Schema.const('hybrid'), Schema.const('template'), Schema.const('llm'), Schema.const('off')]).default('hybrid').description('碎碎念模式'),
    minGapMs: Schema.number().min(1000).max(120000).step(1000).default(6000).description('任意两条最小间隔'),
    llmMinGapMs: Schema.number().min(5000).max(600000).step(1000).default(20000).description('两次 LLM 最小间隔'),
    llmMaxPerTurn: Schema.number().min(0).max(30).step(1).default(8).description('每轮 LLM 上限'),
    llmMaxPerMinute: Schema.number().min(0).max(30).step(1).default(3).description('每分钟 LLM 上限'),
    llmTimeoutMs: Schema.number().min(1000).max(60000).step(500).default(8000).description('LLM 超时'),
    maxChars: Schema.number().min(8).max(120).step(1).default(28).description('输出字符上限'),
    allowRecentLine: Schema.boolean().default(false).description('允许发送最近一句 assistant 文本'),
    voice: Schema.union([Schema.const('off'), Schema.const('important'), Schema.const('all')]).default('important').description('碎碎念朗读范围'),
    idleEnabled: Schema.boolean().default(false).description('空闲嘀咕'),
  }).description('碎碎念'),

  workflow: Schema.object({
    id: Schema.string().default('default').description('工作流 id'),
    reloadOnChange: Schema.boolean().default(true).description('YAML 变更热重载'),
  }).description('工作流'),

  shell: Schema.object({
    autoStart: Schema.boolean().default(true).description('DSH 启动或插件重载时自动拉起桌面壳'),
    executable: Schema.string().default('').description('桌面壳 exe 路径；留空自动查找 release/debug'),
    restart: Schema.boolean().default(true).description('壳退出后自动重启（最多 5 次）'),
  }).description('桌面壳'),

  advanced: Schema.object({
    logLevel: Schema.union([Schema.const('info'), Schema.const('debug')]).default('info').description('日志级别'),
    openDevTools: Schema.boolean().default(false).description('桌面壳打开 DevTools'),
    stageSelftest: Schema.boolean().default(true).description('页面内浮层自动运行 Live2D 自检并回传报告'),
  }).description('高级'),
})

/** Resolve the effective config against the schema defaults. */
export function resolveConfig(value) {
  return Config(value ?? {})
}

/**
 * Whitelist + coerce a partial settings patch. Unknown keys are dropped, so a
 * stale or malicious client cannot write arbitrary fields into the profile.
 */
export function normalizePatch(input) {
  if (!isPlainObject(input)) return {}
  const out = {}
  const bool = (v) => (typeof v === 'boolean' ? v : undefined)
  const num = (v, min, max) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined
  }
  const str = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : undefined)
  const oneOf = (v, list) => (list.includes(v) ? v : undefined)
  const put = (obj, key, val) => { if (val !== undefined) obj[key] = val }

  const pet = isPlainObject(input.pet) ? input.pet : null
  if (pet) {
    const p = {}
    put(p, 'scale', num(pet.scale, 0.5, 1.5))
    put(p, 'opacity', num(pet.opacity, 0.4, 1))
    put(p, 'alwaysOnTop', bool(pet.alwaysOnTop))
    put(p, 'clickThrough', bool(pet.clickThrough))
    put(p, 'chatEnabled', bool(pet.chatEnabled))
    put(p, 'webOverlay', bool(pet.webOverlay))
    put(p, 'overlaySize', num(pet.overlaySize, 240, 720))
    if (Object.keys(p).length) out.pet = p
  }

  const chat = isPlainObject(input.chat) ? input.chat : null
  if (chat) {
    const p = {}
    put(p, 'target', str(chat.target, 200))
    put(p, 'sendMode', oneOf(chat.sendMode, ['followup', 'steer']))
    put(p, 'showReplies', bool(chat.showReplies))
    put(p, 'stopTtsOnSend', bool(chat.stopTtsOnSend))
    put(p, 'maxHeightRatio', num(chat.maxHeightRatio, 0.15, 0.6))
    put(p, 'history', num(chat.history, 0, 20))
    if (Object.keys(p).length) out.chat = p
  }

  const subtitle = isPlainObject(input.subtitle) ? input.subtitle : null
  if (subtitle) {
    const p = {}
    put(p, 'markdown', bool(subtitle.markdown))
    put(p, 'tables', bool(subtitle.tables))
    put(p, 'inlineCode', bool(subtitle.inlineCode))
    put(p, 'codeBlocks', oneOf(subtitle.codeBlocks, ['placeholder', 'hide']))
    put(p, 'attachments', oneOf(subtitle.attachments, ['hide', 'placeholder']))
    put(p, 'maxChars', num(subtitle.maxChars, 1000, 200000))
    put(p, 'autoScroll', bool(subtitle.autoScroll))
    if (Object.keys(p).length) out.subtitle = p
  }

  const voice = isPlainObject(input.voice) ? input.voice : null
  if (voice) {
    const p = {}
    put(p, 'provider', oneOf(voice.provider, ['edge', 'gpt-sovits']))
    put(p, 'readMurmurs', oneOf(voice.readMurmurs, ['off', 'important', 'all']))
    put(p, 'volume', num(voice.volume, 0, 1))
    if (Object.keys(p).length) out.voice = p
  }

  const live2d = isPlainObject(input.live2d) ? input.live2d : null
  if (live2d) {
    const p = {}
    put(p, 'model', str(live2d.model, 120))
    put(p, 'modelDir', str(live2d.modelDir, 1000))
    put(p, 'lipSync', num(live2d.lipSync, 0, 1))
    put(p, 'idleMotion', bool(live2d.idleMotion))
    put(p, 'blink', bool(live2d.blink))
    put(p, 'lookAtCursor', bool(live2d.lookAtCursor))
    if (Object.keys(p).length) out.live2d = p
  }

  const stickers = isPlainObject(input.stickers) ? input.stickers : null
  if (stickers) {
    const p = {}
    put(p, 'enabled', bool(stickers.enabled))
    put(p, 'mode', oneOf(stickers.mode, ['important', 'all']))
    put(p, 'textMemes', bool(stickers.textMemes))
    put(p, 'cooldownMs', num(stickers.cooldownMs, 0, 60000))
    put(p, 'index', str(stickers.index, 120))
    if (Object.keys(p).length) out.stickers = p
  }

  const persona = isPlainObject(input.persona) ? input.persona : null
  if (persona) {
    const p = {}
    put(p, 'id', str(persona.id, 120))
    put(p, 'styleCard', str(persona.styleCard, 1000))
    if (Object.keys(p).length) out.persona = p
  }

  const murmur = isPlainObject(input.murmur) ? input.murmur : null
  if (murmur) {
    const p = {}
    put(p, 'mode', oneOf(murmur.mode, ['hybrid', 'template', 'llm', 'off']))
    put(p, 'minGapMs', num(murmur.minGapMs, 1000, 120000))
    put(p, 'llmMinGapMs', num(murmur.llmMinGapMs, 5000, 600000))
    put(p, 'llmMaxPerTurn', num(murmur.llmMaxPerTurn, 0, 30))
    put(p, 'llmMaxPerMinute', num(murmur.llmMaxPerMinute, 0, 30))
    put(p, 'llmTimeoutMs', num(murmur.llmTimeoutMs, 1000, 60000))
    put(p, 'maxChars', num(murmur.maxChars, 8, 120))
    put(p, 'allowRecentLine', bool(murmur.allowRecentLine))
    put(p, 'voice', oneOf(murmur.voice, ['off', 'important', 'all']))
    put(p, 'idleEnabled', bool(murmur.idleEnabled))
    if (Object.keys(p).length) out.murmur = p
  }

  const workflow = isPlainObject(input.workflow) ? input.workflow : null
  if (workflow) {
    const p = {}
    put(p, 'id', str(workflow.id, 120))
    put(p, 'reloadOnChange', bool(workflow.reloadOnChange))
    if (Object.keys(p).length) out.workflow = p
  }

  const shell = isPlainObject(input.shell) ? input.shell : null
  if (shell) {
    const p = {}
    put(p, 'autoStart', bool(shell.autoStart))
    put(p, 'executable', str(shell.executable, 1000))
    put(p, 'restart', bool(shell.restart))
    if (Object.keys(p).length) out.shell = p
  }

  const advanced = isPlainObject(input.advanced) ? input.advanced : null
  if (advanced) {
    const p = {}
    put(p, 'logLevel', oneOf(advanced.logLevel, ['info', 'debug']))
    put(p, 'openDevTools', bool(advanced.openDevTools))
    put(p, 'stageSelftest', bool(advanced.stageSelftest))
    if (Object.keys(p).length) out.advanced = p
  }

  if (typeof input.enabled === 'boolean') out.enabled = input.enabled
  return out
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
