/**
 * The bridge as a Host plugin.
 *
 * In another process the bridge had to discover a port, exchange a launch token
 * for a cookie and keep a WebSocket alive. Inside the Host none of that exists:
 * the session and workspace controllers are services on this context, and the
 * two waterfall events are ordinary Cordis events. Every Telegram behaviour
 * lives in `bridge.ts`, untouched; this file supplies the same
 * `HostBackend` the attach path supplies and hands over to it.
 *
 * Load it by listing the bundle in a profile:
 *
 *     dsh plugin add dsh-telegram --profile desktop
 *
 * @module dsh-telegram/host/plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Bridge, type HostConnect } from '../bridge.ts'
import { bridgeStateDir, loadConfig } from '../config.ts'
import { Log } from '../log.ts'
import { Bindings } from '../store/bindings.ts'
import { acquireLock } from '../store/lock.ts'
import { TelegramApi } from '../telegram/api.ts'
import { UpdateLedger } from '../telegram/ledger.ts'
import { createLocalRemote } from './local-remote.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-telegram'

/** Without both controllers there is no session to mount or prompt. */
export const inject = ['sessionController', 'workspaceController']

/** Profile-patch configuration. */
export interface Config {
  /**
   * Bridge state directory: `bindings.json`, receipts, logs.
   *
   * Defaults to `$DSH_HOME/config/dsh-telegram`, so a native DSH install keeps
   * this bridge's files inside its own home instead of a Hulala directory.
   */
  stateDir?: string
}

export const Config: z<Config> = z.object({
  stateDir: z.string(),
})

/** Unix socket path collisions are a Host bug; a bad state dir is a config one. */
export function apply(ctx: Context, config: Config = {}): void {
  const stateDir = config.stateDir ?? bridgeStateDir()
  let stop: (() => Promise<void>) | undefined
  const starting = start(ctx, stateDir)
    .then(value => { stop = value })
    .catch((error: unknown) => {
      console.error(`dsh-telegram: ${error instanceof Error ? error.message : String(error)}`)
    })
  ctx.effect(() => () => { void starting.then(async () => { await stop?.() }) }, 'dsh-telegram: bridge')
}

/**
 * Build the bridge over this context and start polling.
 * @param ctx - Host context.
 * @param stateDir - bridge state directory.
 * @returns shutdown function.
 */
async function start(ctx: Context, stateDir: string): Promise<() => Promise<void>> {
  const config = await loadConfig(process.env, stateDir)
  const release = await acquireLock(config.token)
  const log = new Log(config.stateDir, config.token)
  const api = new TelegramApi({ token: config.token, baseUrl: config.baseUrl })
  const bindings = await Bindings.open(config.stateDir)
  const ledger = await UpdateLedger.open(`${config.stateDir}/receipts/telegram_update_receipts.json`)
  const remote = createLocalRemote(ctx)
  const connect: HostConnect = async () => ({
    ctx: { remote } as unknown as Context,
    close: async () => undefined,
  })
  const bridge = new Bridge({ config, api, ledger, bindings, log, connect })
  log.info(`bridge starting inside the Host; state ${config.stateDir}`)
  await bridge.start()
  return async () => {
    await Promise.race([bridge.stop(), new Promise(settle => setTimeout(settle, 5000))])
    await release()
  }
}
