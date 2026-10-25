import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { Config, resolveConfig } from './config.js'
import { createStore } from './store.js'
import { bindEvents } from './events.js'
import { createRoutes } from './routes.js'
import { createShellSupervisor } from './shell.js'
import { createPetBrain } from './pet-brain.js'
import { createVoiceService } from './voice.js'
import { createGsvService } from './gsv.js'
import { createEngineManager } from './engines.js'

export const name = 'dsh-dstuber'
export { Config }

const VERSION = '0.1.2'
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * Host half of dsh-dstuber.
 *
 * Activation is defensive on purpose: DSH treats a throwing plugin init as
 * fatal for the whole boot, so a pet defect must cost the pet, never the Host.
 * Everything registered here is an effect owned by this plugin's fiber.
 */
export function apply(ctx, config = {}) {
  try {
    const resolved = resolveConfig(config)
    const log = {
      info: (...args) => console.log('[dsh-dstuber]', ...args),
      warn: (...args) => console.warn('[dsh-dstuber]', ...args),
      debug: (...args) => {
        if (resolved.advanced?.logLevel === 'debug') console.debug('[dsh-dstuber]', ...args)
      },
    }

    const store = createStore({ log })
    const petBrain = createPetBrain({ ctx, store, log, root: packageRoot })
    const voice = createVoiceService({
      getConfig: () => config,
      dataDir: join(packageRoot, '.webview2'),
      log,
      onSpeech: (payload) => store.noteSpeech(payload),
      onCancel: (payload) => store.noteSpeechCancel(payload),
      onLevel: (payload) => store.noteSpeechLevel(payload),
      onEnvelope: (payload) => store.noteSpeechEnvelope(payload),
    })
    const stopVoiceFeed = store.subscribe((message) => voice.handle(message))
    // Closing the pet from its own menu/tray stops every pet service too.
    const shell = createShellSupervisor({
      getConfig: () => config,
      log,
      onClosed: () => {
        try { voice.stopWorker() } catch {}
        try { void gsv?.stop?.() } catch {}
      },
    })
    const dataDir = join(packageRoot, '.webview2')
    const gsv = createGsvService({
      dataDir,
      log,
      getVoiceSettings: () => {
        try {
          return JSON.parse(readFileSync(join(dataDir, 'voice.json'), 'utf8'))
        } catch {
          return {}
        }
      },
    })
    const engines = createEngineManager({ dataDir, gsv, log })
    const routes = createRoutes({
      ctx,
      store,
      getConfig: () => config,
      log,
      version: VERSION,
      shellStatus: () => shell.status(),
      shell,
      petBrain,
      voice,
      gsv,
      engines,
    })

    ctx.effect(() => bindEvents(ctx, store, log), 'dsh-dstuber DSH events')

    ctx.inject(['webServer'], (httpCtx) => {
      const server = httpCtx.webServer ?? httpCtx.get?.('webServer')
      if (!server?.register) {
        log.warn('webServer unavailable; HTTP routes are not mounted')
        return
      }
      httpCtx.effect(
        () => server.register({
          kind: 'prefix',
          path: '/plugins/dsh-dstuber',
          handler: routes.handler,
        }),
        'dsh-dstuber HTTP routes',
      )

      // Spawn the Tauri shell after the route is mounted. The effect cleanup
      // kills the process tree on plugin reload / DSH exit, so the pet follows
      // the DSH lifecycle instead of becoming an independent app.
      httpCtx.effect(() => {
        let origin = ''
        try {
          origin = server.getOrigin?.() ?? ''
        } catch (error) {
          log.warn?.(`[dsh-dstuber] webServer origin unavailable: ${error instanceof Error ? error.message : String(error)}`)
        }
        const stageUrl = origin
          ? `${origin}/plugins/dsh-dstuber/stage/index.html?bg=none`
          : ''
        const timer = setTimeout(() => shell.start({ url: stageUrl }), 1200)
        return () => {
          clearTimeout(timer)
          shell.dispose()
        }
      }, 'dsh-dstuber shell supervisor')
    })

    ctx.effect(() => () => store.dispose(), 'dsh-dstuber store')
    ctx.effect(() => () => {
      stopVoiceFeed()
      voice.dispose()
    }, 'dsh-dstuber voice')
    ctx.effect(() => () => petBrain.dispose(), 'dsh-dstuber pet brain')
    ctx.effect(() => () => gsv.dispose(), 'dsh-dstuber gsv service')

    log.info(`active v${VERSION}${resolved.enabled ? '' : ' (disabled by config)'}`)
  } catch (error) {
    console.error('[dsh-dstuber] activation failed; the pet stays inert and DSH keeps booting:', error)
  }
}
