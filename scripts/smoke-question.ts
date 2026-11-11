/**
 * Live waterfall probe: does the Host deliver `user-questions/request` to this
 * peer? Approvals travel the same path, so a delivered question proves the
 * interaction channel works without touching the permission preset.
 *
 * @module dsh-telegram/scripts/smoke-question
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

const endpoint = await readEndpoint(endpointPath())
const telegram = new FakeTelegram()
const url = await telegram.start()
const stateDir = await mkdtemp(join(tmpdir(), 'dsh-telegram-question-'))
const workspace = await mkdtemp(join(tmpdir(), 'dsh-telegram-question-cwd-'))
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
let delivered = false
try {
  telegram.push(messageUpdate(1, 10, 1, '请立刻调用 ask_user_question 工具问我一个问题：要继续吗？只问这一个问题，不要做别的。'))
  await telegram.until(() => telegram.texts(10).some(text => text.includes('❓')), 90_000)
  delivered = true
} catch (error) {
  console.log('FAILED:', error instanceof Error ? error.message : String(error))
}
console.log('waterfall delivered:', delivered)
console.log('--- conversation ---')
for (const text of telegram.texts(10)) console.log(JSON.stringify(text))
await bridge.stop()
await telegram.stop()
process.exit(delivered ? 0 : 1)
