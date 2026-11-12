/**
 * The bot as a Host plugin.
 *
 * In another process the bot had to discover a port, exchange a launch token
 * for a cookie and keep a WebSocket alive. Inside the Host none of that exists:
 * the session and workspace controllers are services on this context, and the
 * two waterfall events are ordinary Cordis events. Everything else lives in
 * `bridge.ts` and the channel modules; this file builds them and owns shutdown.
 *
 * Load it by listing the bundle in a profile:
 *
 *     dsh plugin --profile tui add @colinagent/hulala-bot
 *     hulala plugin --profile tui add @colinagent/hulala-bot
 *
 * @module hulala-bot/host/plugin
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Bridge, type HostConnect } from '../bridge.ts'
import type { Channel } from '../channel.ts'
import { botStateDir, loadConfig } from '../config.ts'
import { Log } from '../log.ts'
import { LarkApi } from '../lark/api.ts'
import { LarkChannel } from '../lark/channel.ts'
import { createSdkTransport } from '../lark/ws.ts'
import { COMMANDS } from '../router.ts'
import { Bindings } from '../store/bindings.ts'
import { UpdateLedger } from '../store/ledger.ts'
import { acquireLock } from '../store/lock.ts'
import { TelegramApi } from '../telegram/api.ts'
import { TelegramChannel } from '../telegram/channel.ts'
import type { HostBackend } from './backend.ts'
import { createLocalRemote } from './local-remote.ts'

/** Stable Cordis plugin name. */
export const name = 'hulala-bot'

/** Without both controllers there is no session to mount or prompt. */
export const inject = ['sessionController', 'workspaceController']

/** Profile-patch configuration. */
export interface Config {
  /**
   * Bot state directory: `bindings.json`, receipts, logs.
   *
   * Defaults to `$DSH_HOME/config/hulala-bot`, so a native DSH install keeps
   * these files inside its own home instead of a Hulala directory.
   */
  stateDir?: string
}

export const Config: z<Config> = z.object({
  stateDir: z.string(),
})

/** A bad state directory is a config problem, not a Host bug. */
export function apply(ctx: Context, config: Config = {}): void {
  const stateDir = config.stateDir ?? botStateDir()
  let stop: (() => Promise<void>) | undefined
  const starting = start(ctx, stateDir)
    .then(value => { stop = value })
    .catch((error: unknown) => {
      console.error(`hulala-bot: ${error instanceof Error ? error.message : String(error)}`)
    })
  ctx.effect(() => () => { void starting.then(async () => { await stop?.() }) }, 'hulala-bot: bridge')
}

/**
 * Build every configured channel, then start the bridge.
 * @param ctx - Host context.
 * @param stateDir - bot state directory.
 * @returns shutdown function.
 */
async function start(ctx: Context, stateDir: string): Promise<() => Promise<void>> {
  const config = await loadConfig(process.env, stateDir)
  const log = new Log(config.stateDir, [config.telegram?.token ?? '', config.lark?.appSecret ?? ''])
  const channels: Channel[] = []
  const releases: (() => Promise<void>)[] = []

  if (config.telegram !== undefined) {
    try {
      releases.push(await acquireLock(`telegram:${config.telegram.token}`))
      const api = new TelegramApi({
        token: config.telegram.token,
        baseUrl: config.telegram.baseUrl,
        proxy: config.telegram.proxy,
      })
      channels.push(new TelegramChannel({
        api,
        config: config.telegram,
        ledger: await UpdateLedger.open(join(config.stateDir, 'receipts', 'telegram.json')),
        log,
        commands: COMMANDS,
        inboxDir: join(config.stateDir, 'inbox'),
      }))
    } catch (error) {
      log.error(`telegram not started: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (config.lark !== undefined) {
    try {
      releases.push(await acquireLock(`lark:${config.lark.appId}`))
      const api = new LarkApi({
        appId: config.lark.appId,
        appSecret: config.lark.appSecret,
        baseUrl: config.lark.baseUrl,
      })
      channels.push(new LarkChannel({
        api,
        transport: createSdkTransport({
          appId: config.lark.appId,
          appSecret: config.lark.appSecret,
          domain: config.lark.domain,
          onError: error => { log.error(`lark connection: ${error.message}`) },
        }),
        config: config.lark,
        ledger: await UpdateLedger.open(join(config.stateDir, 'receipts', 'lark.json')),
        log,
      }))
    } catch (error) {
      log.error(`lark not started: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (channels.length === 0) {
    await releaseAll(releases)
    throw new Error(`no channel started (see ${join(config.stateDir, 'logs')})`)
  }

  const remote = createLocalRemote(ctx)
  const connect: HostConnect = async () => ({
    ctx: { remote } as unknown as HostBackend['ctx'],
    close: async () => undefined,
  })
  const bindings = await Bindings.open(config.stateDir)
  const bridge = new Bridge({ config, channels, bindings, log, connect })
  log.info(`bot starting inside the Host; channels ${channels.map(channel => channel.name).join(', ')}; state ${config.stateDir}`)
  await bridge.start()
  return async () => {
    await Promise.race([bridge.stop(), new Promise(settle => setTimeout(settle, 5000))])
    await releaseAll(releases)
  }
}

/**
 * Release every credential lock, even when one fails.
 * @param releases - release functions taken at startup.
 */
async function releaseAll(releases: readonly (() => Promise<void>)[]): Promise<void> {
  for (const release of releases) await release().catch(() => undefined)
}
