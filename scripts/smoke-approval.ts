/**
 * Live approval round trip.
 *
 * Prompts the agent to run a shell command, waits for the approval card, presses
 * "allow", and prints the whole conversation. No TUI is attached, so this also
 * proves a lone peer can settle a Host approval.
 *
 * @module dsh-telegram/scripts/smoke-approval
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
import { callbackUpdate, FakeTelegram, messageUpdate } from '../tests/fakes.ts'

const endpoint = await readEndpoint(endpointPath())
const telegram = new FakeTelegram()
const url = await telegram.start()
const stateDir = await mkdtemp(join(tmpdir(), 'dsh-telegram-approval-'))
const workspace = await mkdtemp(join(tmpdir(), 'dsh-telegram-approval-cwd-'))
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
  telegram.push(messageUpdate(1, 10, 1, '请执行 bash 命令：rm -rf /tmp/dsh-telegram-approval-probe，执行前不要问我，直接调用工具。'))
  await telegram.until(() => telegram.of('sendMessage').length > 0, 120_000)
  const card = telegram.of('sendMessage').find(call => call.body.reply_markup !== undefined)
  if (card === undefined) {
    console.log('no approval card; the preset allowed the call outright')
  } else {
    console.log('card:', JSON.stringify(card.body.text))
    const keyboard = (card.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard
    console.log('buttons:', keyboard.flat().map(button => button.text).join(' | '))
    telegram.push(callbackUpdate(2, 10, 1, Number(card.body.chat_id), keyboard[0]?.[0]?.callback_data ?? ''))
    await telegram.until(() => telegram.texts(10).some(text => text.includes('已允许')), 15000)
    console.log('after press:', JSON.stringify(telegram.texts(10).find(text => text.includes('已允许'))))
  }
  await telegram.until(() => telegram.texts(10).some(text => text.includes('已允许')), 120_000)
  console.log('\n--- conversation ---')
  for (const text of telegram.texts(10)) console.log(JSON.stringify(text))
} finally {
  await bridge.stop()
  await telegram.stop()
  process.exit(0)
}
