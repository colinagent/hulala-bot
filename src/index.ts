/**
 * Entry point: one bridge process for one Host.
 *
 * Setup is deliberately boring: read configuration, open the Bot API client,
 * load the receipt ledger and the mount table, then hand the process to the
 * bridge. Shutdown is a signal away.
 *
 * @module dsh-telegram/index
 */
import { loadConfig } from './config.ts'
import { Bridge } from './bridge.ts'
import { attach, endpointPath, readEndpoint } from './host/attach.ts'
import { Log } from './log.ts'
import { Bindings } from './store/bindings.ts'
import { TelegramApi } from './telegram/api.ts'
import { UpdateLedger } from './telegram/ledger.ts'

/**
 * Prove this build can talk to the Host: attach, read the session list, and
 * register the two waterfall events. Needs no bot token and sends nothing.
 */
async function selfCheck(): Promise<void> {
  const backend = await attach(await readEndpoint(endpointPath()))
  try {
    const listed = await backend.ctx.remote.session.list({})
    if (!listed.ok) throw new Error(`session.list failed: ${JSON.stringify(listed.error)}`)
    const events = backend.ctx.remote as unknown as { $on(name: string, handler: () => Promise<string>): () => void }
    events.$on('approval/request', async () => 'unavailable')
    events.$on('user-questions/request', async () => 'unavailable')
    console.log(`ok: Host ${backend.endpoint.version}, ${String(listed.value.items.length)} sessions, interactions=answer`)
  } finally {
    await backend.close()
  }
}

if (process.argv.includes('--self-check')) {
  await selfCheck()
  process.exit(0)
}

/** Start the bridge and keep the process alive until a signal arrives. */
async function main(): Promise<void> {
  const config = await loadConfig()
  const log = new Log(config.stateDir, config.token)
  const api = new TelegramApi({ token: config.token, baseUrl: config.baseUrl })
  const bindings = await Bindings.open(config.stateDir)
  const ledger = await UpdateLedger.open(`${config.stateDir}/receipts/telegram_update_receipts.json`)
  const bridge = new Bridge({ config, api, ledger, bindings, log })

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal}: shutting down`)
    await bridge.stop()
    process.exit(0)
  }
  process.once('SIGINT', () => { void shutdown('SIGINT') })
  process.once('SIGTERM', () => { void shutdown('SIGTERM') })

  log.info(`bridge starting; state ${config.stateDir}`)
  await bridge.start()
}

await main()
