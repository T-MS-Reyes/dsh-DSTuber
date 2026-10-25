// Build the augmented model3.json that the Cubism runtime can actually load.
//
// The shipped VTube Studio package has no FileReferences.Expressions and no
// FileReferences.Motions, and its LipSync group is empty. Cubism SDK ignores
// loose *.exp3.json / *.motion3.json files, so we register them here under
// stable ASCII names and add the LipSync group used by the mouth driver.
//
// Usage: node scripts/build-model.mjs [modelDir]
import { readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const modelDir = process.argv[2] ?? join(here, '..', 'dev', 'live2d', 'ds-whale')

/** Chinese expression file stem -> stable ASCII name. */
const EXPRESSIONS = {
  'love': 'love',
  '兔兔贴纸': 'sticker_rabbit',
  '单边马尾': 'hairstyle_ponytail',
  '双手比耶': 'peace',
  '吐舌': 'tongue',
  '吐魂': 'soul',
  '呆呆眼': 'blank',
  '哭': 'cry',
  '喵喵手~喵~动画': 'cat_paws',
  '圆眼镜': 'glasses_round',
  '墨镜': 'sunglasses',
  '头箍': 'headband',
  '巴菲': 'parfait',
  '开心兴奋': 'happy',
  '心跳': 'heartbeat',
  '悲伤': 'sad',
  '情绪花花': 'flower',
  '感叹号': 'exclamation',
  '手机换色': 'phone_color',
  '挤': 'squeeze',
  '撤回': 'retract',
  '方眼镜': 'glasses_square',
  '星星眼': 'star_eyes',
  '晕晕': 'dizzy',
  '椭圆眼镜': 'glasses_oval',
  '橡皮': 'eraser',
  '流汗': 'sweat',
  '深色桌布': 'dark_tablecloth',
  '点菜按下': 'order_pressed',
  '爱心眼': 'heart_eyes',
  '猫猫贴纸': 'sticker_cat',
  '生气': 'angry',
  '画笔': 'paintbrush',
  '脸红': 'blush',
  '蛋包饭': 'omurice',
  '蝴蝶结贴纸': 'sticker_bow',
  '调皮': 'mischievous',
  '闭眼口水': 'sleepy_drool',
  '问号': 'question',
  '阴暗': 'gloomy',
  '魔爪': 'claw',
  '魔爪换色': 'claw_alt',
  '鲸鱼': 'whale',
  '鲸鱼放桌上': 'whale_on_desk',
}

/** Motion file stem -> { group, name }. The first Idle motion is the loop. */
const MOTIONS = {
  'motions/idle.motion3.json': { group: 'Idle', name: 'idle', loop: true },
  'motions/喷水.motion3.json': { group: 'Gesture', name: 'spray' },
  'motions/开盖.motion3.json': { group: 'Gesture', name: 'open_lid' },
  'motions/番茄酱.motion3.json': { group: 'Gesture', name: 'ketchup' },
  'motions/自拍.motion3.json': { group: 'Gesture', name: 'selfie' },
  'motions/自拍简单.motion3.json': { group: 'Gesture', name: 'selfie_simple' },
  'motions/chuipaopao.motion3.json': { group: 'Gesture', name: 'bubbles' },
  'aidale.motion3.json': { group: 'Gesture', name: 'aidale' },
}

/** High-level state -> candidate expressions, most specific first. */
const STATE_EXPRESSIONS = {
  idle: [],
  thinking: ['blank', 'question'],
  working: ['glasses_round'],
  waiting: ['question', 'sweat'],
  happy: ['happy', 'star_eyes'],
  excited: ['heart_eyes', 'star_eyes'],
  shy: ['blush'],
  sad: ['sad', 'cry'],
  angry: ['angry', 'claw'],
  confused: ['dizzy', 'sweat'],
  sleepy: ['sleepy_drool'],
  error: ['sweat', 'sad'],
  success: ['happy', 'peace'],
}

/** State -> candidate one-shot gesture motions. */
const STATE_GESTURES = {
  happy: ['peace', 'aidale'],
  excited: ['selfie', 'bubbles'],
  angry: ['spray'],
  success: ['peace'],
}

async function main() {
  const entries = await readdir(modelDir)

  const expFiles = entries.filter((n) => n.endsWith('.exp3.json'))
  const expressions = []
  const missing = []
  for (const [stem, name] of Object.entries(EXPRESSIONS)) {
    const file = `${stem}.exp3.json`
    if (entries.includes(file)) expressions.push({ Name: name, File: file })
    else missing.push(stem)
  }
  // Keep any expression the map did not know about, under a stable fallback.
  for (const file of expFiles) {
    const stem = basename(file, '.exp3.json')
    if (EXPRESSIONS[stem]) continue
    const name = `extra_${expressions.length + 1}`
    expressions.push({ Name: name, File: file })
  }

  const motions = { Idle: [], Gesture: [] }
  const motionNames = { Idle: [], Gesture: [] }
  for (const [rel, meta] of Object.entries(MOTIONS)) {
    try {
      await stat(join(modelDir, rel))
    } catch {
      missing.push(rel)
      continue
    }
    motions[meta.group].push({ File: rel, FadeInTime: meta.group === 'Idle' ? 0.4 : 0.2 })
    motionNames[meta.group].push(meta.name)
  }

  const model = {
    Version: 3,
    FileReferences: {
      Moc: 'c_0120.moc3',
      Textures: ['c_0120.2048/texture_00.png', 'c_0120.2048/texture_01.png'],
      Physics: 'c_0120.physics3.json',
      DisplayInfo: 'c_0120.cdi3.json',
      Expressions: expressions,
      Motions: motions,
    },
    Groups: [
      { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
      { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
    ],
  }

  const manifest = {
    id: 'ds-q',
    name: 'DS鲸鱼娘（桌面Q版）',
    version: 3,
    source: 'DS面捕版.zip',
    credits: {
      model: '@氵六青 (bilibili 11272072)',
      character: '@上善无形 / @ZipZipPin',
      license: 'CC BY-NC-SA 4.0',
      note: '用户自备、仅本地使用；不随插件分发。',
    },
    augmentedModel: 'model3.augmented.json',
    expressions,
    motions: motionNames,
    stateExpressions: STATE_EXPRESSIONS,
    stateGestures: STATE_GESTURES,
    lipSyncParam: 'ParamMouthOpenY',
    mouthRange: 2.1,
    missing,
    generatedAt: new Date().toISOString(),
  }

  await writeFile(join(modelDir, 'model3.augmented.json'), `${JSON.stringify(model, null, 2)}\n`, 'utf8')
  await writeFile(join(modelDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // Sanity: the moc3 and both textures must exist before we claim success.
  const present = new Set(entries)
  const required = ['c_0120.moc3', 'c_0120.physics3.json', 'c_0120.cdi3.json']
  for (const file of required) {
    if (!present.has(file)) throw new Error(`missing required model file: ${file}`)
  }
  const textures = await readdir(join(modelDir, 'c_0120.2048'))
  for (const tex of ['texture_00.png', 'texture_01.png']) {
    if (!textures.includes(tex)) throw new Error(`missing texture: ${tex}`)
  }

  console.log(`model: ${modelDir}`)
  console.log(`expressions: ${expressions.length}, motions: ${motions.Idle.length + motions.Gesture.length}`)
  if (missing.length) console.log(`not found (skipped): ${missing.join(', ')}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
