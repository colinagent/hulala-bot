/**
 * Live smoke test against the Host on this machine.
 *
 * Not part of the test suite: it needs a running Hulala Host and it really
 * prompts the agent. It drives the bridge through a fake Bot API so no bot
 * token and no Telegram account are involved.
 *
 * Usage: node scripts/smoke.ts ["prompt text"]
 *
 * @module dsh-telegram/scripts/smoke
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bridge } from '../src/bridge.ts'
import type { BridgeConfig } from '../src/config.ts'
import { attach, endpointPath, readEndpoint, type HostBackend } from '../src/host/attach.ts'
import { Log } from '../src/log.ts'
import { Bindings } from '../src/store/bindings.ts'
import { TelegramApi } from '../src/telegram/api.ts'
import { UpdateLedger } from '../src/telegram/ledger.ts'
import { FakeTelegram, messageUpdate } from '../tests/fakes.ts'

const prompt = process.argv[2] ?? '用一句话说明你现在在哪个目录，不要调用工具。'

const endpoint = await readEndpoint(endpointPath())
console.log(`host ${endpoint.descriptor.httpUrl} v${endpoint.version}`)

const telegram = new FakeTelegram()
const url = await telegram.start()
const stateDir = await mkdtemp(join(tmpdir(), 'dsh-telegram-smoke-'))
const workspace = await mkdtemp(join(tmpdir(), 'dsh-telegram-smoke-cwd-'))
const config: BridgeConfig = {
  baseUrl: url,
  token: 'smoke-token',
  allowedUsers: [1],
  allowedChats: [],
  defaultCwd: workspace,
  streamIntervalMs: 400,
  parseMode: 'plain',
  stateDir,
  pollTimeoutSeconds: 1,
}
const bridge = new Bridge({
  config,
  api: new TelegramApi({ token: config.token, baseUrl: url }),
  ledger: await UpdateLedger.open(join(stateDir, 'receipts.json')),
  bindings: await Bindings.open(stateDir),
  log: new Log(stateDir, config.token),
  connect: async () => attach(endpoint) as Promise<HostBackend>,
})

void bridge.start()
try {
  telegram.push(messageUpdate(1, 10, 1, '/status'))
  await telegram.until(() => telegram.texts(10).length > 0, 8000)
  console.log('status ->', JSON.stringify(telegram.texts(10).at(-1)))

  const before = telegram.calls.length
  telegram.push(messageUpdate(2, 10, 1, prompt))
  await telegram.until(
    () => telegram.calls.slice(before).some(call => call.method === 'editMessageText'),
    120_000,
  )
  telegram.push(messageUpdate(3, 10, 1, '/status'))
  await telegram.until(() => telegram.texts(10).at(-1)?.includes('id ') === true, 15000)
  console.log('\n--- conversation ---')
  for (const text of telegram.texts(10)) console.log(JSON.stringify(text))
  console.log('--- end ---')
} finally {
  await bridge.stop()
  await telegram.stop()
  process.exit(0)
}
