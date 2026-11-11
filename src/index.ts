/**
 * Entry point: one bridge process for one Host.
 *
 * Setup is deliberately boring: read configuration, open the Bot API client,
 * load the receipt ledger and the mount table, then hand the process to the
 * bridge. Shutdown is a signal away.
 *
 * @module dsh-telegram/index
 */
import { loadConfig, loadToken } from './config.ts'
import { Bridge } from './bridge.ts'
import { attach, endpointPath, readEndpoint } from './host/attach.ts'
import { Log } from './log.ts'
import { Bindings } from './store/bindings.ts'
import { acquireLock } from './store/lock.ts'
import { TelegramApi } from './telegram/api.ts'
import { UpdateLedger } from './telegram/ledger.ts'

/**
 * Prove this build can talk to the Host: attach, read the session list, and
 * register the two waterfall events. Needs no bot token and sends nothing.
 */
async function selfCheck(): Promise<void> {
  // Telegram first: a blocked network is the failure that looks like nothing
  // happening, and it says nothing about the Host.
  try {
    const { token, baseUrl } = await loadToken()
    const api = new TelegramApi({ token, baseUrl })
    const me = await api.call<{ username?: string }>('getMe')
    console.log(`ok: bot @${me.username ?? '?'} reachable`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`warn: Telegram not reachable (${message})`)
    console.log('      if this machine needs a proxy, run with NODE_USE_ENV_PROXY=1')
  }
  const backend = await attach(await readEndpoint(endpointPath()))
  try {
    const listed = await backend.ctx.remote.session.list({})
    if (!listed.ok) throw new Error(`session.list failed: ${JSON.stringify(listed.error)}`)
    const events = backend.ctx.remote as unknown as { $on(name: string, handler: () => Promise<string>): () => void }
    events.$on('approval/request', async () => 'unavailable')
    events.$on('user-questions/request', async () => 'unavailable')
    console.log(`ok: Host ${backend.endpoint?.version ?? '?'}, ${String(listed.value.items.length)} sessions, interactions=answer`)
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
  const release = await acquireLock(config.stateDir)
  const log = new Log(config.stateDir, config.token)
  const api = new TelegramApi({ token: config.token, baseUrl: config.baseUrl })
  const bindings = await Bindings.open(config.stateDir)
  const ledger = await UpdateLedger.open(`${config.stateDir}/receipts/telegram_update_receipts.json`)
  const bridge = new Bridge({ config, api, ledger, bindings, log })

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal}: shutting down`)
    // Never let a stuck connection keep the process from exiting.
    await Promise.race([bridge.stop(), new Promise(settle => setTimeout(settle, 5000))])
    await release()
    process.exit(0)
  }
  process.once('SIGINT', () => { void shutdown('SIGINT') })
  process.once('SIGTERM', () => { void shutdown('SIGTERM') })

  log.info(`bridge starting; state ${config.stateDir}`)
  await bridge.start()
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
