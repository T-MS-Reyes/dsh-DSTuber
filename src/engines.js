import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Voice engine manager.
 *
 * The plugin bundles Edge TTS (zero setup) and only supervises a local
 * GPT-SoVITS installation. This module reports what is actually usable on this
 * machine (service, weights, reference audio) and switches the active provider,
 * so the owner never has to guess why a voice does not work.
 */
export const ENGINE_DOWNLOAD_URL = 'https://github.com/RVC-Boss/GPT-SoVITS/releases'

export function createEngineManager({ dataDir, log = console, gsv }) {
  const voicePath = join(dataDir, 'voice.json')

  function readVoice() {
    try {
      return JSON.parse(readFileSync(voicePath, 'utf8'))
    } catch {
      return {}
    }
  }

  function writeVoice(next) {
    try {
      writeFileSync(voicePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      return true
    } catch (error) {
      log.warn?.(`[dsh-dstuber] voice settings write failed: ${String(error).slice(0, 120)}`)
      return false
    }
  }

  async function status() {
    const voice = readVoice()
    const gsvStatus = gsv ? await gsv.status() : null
    const current = voice.provider === 'gpt-sovits' ? 'gpt-sovits' : 'edge'
    const weights = {
      gpt: typeof voice.gptWeights === 'string' && voice.gptWeights ? existsSync(voice.gptWeights) : false,
      sovits: typeof voice.sovitsWeights === 'string' && voice.sovitsWeights ? existsSync(voice.sovitsWeights) : false,
      reference: typeof voice.referenceAudio === 'string' && voice.referenceAudio ? existsSync(voice.referenceAudio) : false,
    }
    const installed = !!(gsvStatus?.appDir && existsSync(join(gsvStatus.appDir, 'api_v2.py')))
    return {
      current,
      engines: [
        {
          id: 'edge',
          name: 'Edge TTS',
          kind: 'builtin',
          available: true,
          current: current === 'edge',
          detail: '内置，无需安装',
          voice: String(voice.edgeVoice || 'zh-CN-XiaoyiNeural'),
        },
        {
          id: 'gpt-sovits',
          name: 'GPT-SoVITS',
          kind: 'external',
          installed,
          available: installed && weights.gpt && weights.sovits && weights.reference,
          current: current === 'gpt-sovits',
          running: !!gsvStatus?.running,
          starting: !!gsvStatus?.starting,
          appDir: gsvStatus?.appDir || '',
          port: gsvStatus?.port || 9880,
          weights,
          downloadUrl: ENGINE_DOWNLOAD_URL,
          detail: installed ? '已安装' : '未找到安装目录',
        },
      ],
    }
  }

  function select(engine) {
    const voice = readVoice()
    voice.provider = engine === 'gpt-sovits' ? 'gpt-sovits' : 'edge'
    if (!writeVoice(voice)) return { ok: false, error: 'write-failed' }
    return { ok: true, provider: voice.provider }
  }

  return { status, select, readVoice }
}
