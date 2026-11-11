import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Bridge } from '../src/bridge.ts'
import type { BridgeConfig } from '../src/config.ts'
import type { HostBackend } from '../src/host/attach.ts'
import { Log } from '../src/log.ts'
import { Bindings } from '../src/store/bindings.ts'
import { TelegramApi } from '../src/telegram/api.ts'
import { UpdateLedger } from '../src/telegram/ledger.ts'
import {
  assistantMessage,
  attemptStart,
  callbackUpdate,
  FakeHost,
  FakeTelegram,
  messageUpdate,
  textDelta,
  turnEnd,
  turnStart,
} from './fakes.ts'

/** Wire one bridge to a fake Host and a fake Bot API. */
async function harness(overrides: Partial<BridgeConfig> = {}) {
  const telegram = new FakeTelegram()
  const url = await telegram.start()
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-telegram-bridge-'))
  const defaultCwd = await mkdtemp(join(tmpdir(), 'dsh-telegram-cwd-'))
  const config: BridgeConfig = {
    baseUrl: url,
    token: 'test-token',
    allowedUsers: [1],
    allowedChats: [],
    defaultCwd,
    streamIntervalMs: 0,
    parseMode: 'plain',
    stateDir,
    pollTimeoutSeconds: 1,
    ...overrides,
  }
  const host = new FakeHost()
  const bridge = new Bridge({
    config,
    api: new TelegramApi({ token: config.token, baseUrl: url }),
    ledger: await UpdateLedger.open(join(stateDir, 'receipts.json')),
    bindings: await Bindings.open(stateDir),
    log: new Log(stateDir, config.token),
    connect: async () => host.backend as unknown as HostBackend,
  })
  void bridge.start()
  const stop = async (): Promise<void> => {
    await bridge.stop()
    await telegram.stop()
  }
  return { telegram, host, bridge, config, stateDir, defaultCwd, stop }
}

test('answers /help without touching the Host', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '/help'))
    await context.telegram.until(() => context.telegram.texts(10).length > 0)
    assert.ok(context.telegram.texts(10).some(text => text.includes('/cwd')))
    assert.equal(context.host.prompts.length, 0)
  } finally {
    await context.stop()
  }
})

test('refuses a chat outside the allowlist', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 99, 99, '你好'))
    await new Promise(settle => setTimeout(settle, 150))
    assert.equal(context.host.prompts.length, 0)
    assert.deepEqual(context.telegram.texts(99), [])
  } finally {
    await context.stop()
  }
})

test('prompts the default session on first use', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '你好'))
    await context.telegram.until(() => context.host.prompts.length === 1)
    assert.equal(context.host.prompts[0]?.text, '你好')
    assert.equal(context.host.followRequests.length, 1)
  } finally {
    await context.stop()
  }
})

test('streams one message and settles it with the durable text', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '数到三'))
    await context.telegram.until(() => context.host.followRequests.length === 1)
    context.host.emit(turnStart())
    context.host.emit(attemptStart('a1'))
    context.host.emit(textDelta('a1', '一'))
    context.host.emit(textDelta('a1', '二'))
    await context.telegram.until(() => context.telegram.of('editMessageText').length > 0)
    context.host.emit(assistantMessage('一 二 三'))
    context.host.emit(turnEnd())
    await context.telegram.until(() => context.telegram.texts(10).includes('一 二 三'))
    const sends = context.telegram.of('sendMessage')
    assert.equal(sends.length, 1)
    assert.match(String(sends[0]?.body.text), /正在思考/)
  } finally {
    await context.stop()
  }
})

test('renders an approval as buttons and settles it on press', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '删掉临时文件'))
    await context.telegram.until(() => context.host.followRequests.length === 1)
    context.host.emit(turnStart())
    await new Promise(settle => setTimeout(settle, 60))
    const outcome = context.host.invoke('approval/request', { toolName: 'bash', reason: 'rm -rf /tmp/x', signal: new AbortController().signal })
    await context.telegram.until(() => context.telegram.of('sendMessage').some(call => call.body.reply_markup !== undefined))
    const card = context.telegram.of('sendMessage').find(call => call.body.reply_markup !== undefined)
    const keyboard = (card?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard
    const data = keyboard[0]?.[0]?.callback_data ?? ''
    assert.match(data, /^approve:a\d+$/)
    context.telegram.push(callbackUpdate(2, 10, 1, Number(card?.body.chat_id ?? 0), data))
    assert.equal(await outcome, 'allowed-once')
    await context.telegram.until(() => context.telegram.texts(10).some(text => text.includes('已允许')))
  } finally {
    await context.stop()
  }
})

test('withdraws a card when another client answers first', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '跑一下'))
    await context.telegram.until(() => context.host.followRequests.length === 1)
    context.host.emit(turnStart())
    await new Promise(settle => setTimeout(settle, 60))
    const controller = new AbortController()
    const outcome = context.host.invoke('approval/request', { toolName: 'bash', signal: controller.signal })
    await context.telegram.until(() => context.telegram.of('sendMessage').some(call => call.body.reply_markup !== undefined))
    controller.abort()
    assert.equal(await outcome, 'cancelled')
    await context.telegram.until(() => context.telegram.texts(10).some(text => text.includes('已在其他端处理')))
  } finally {
    await context.stop()
  }
})

test('fails closed when no conversation is mounted', async () => {
  const context = await harness()
  try {
    let delegated = false
    const outcome = await context.host.invoke('approval/request', { toolName: 'bash' }, async () => {
      delegated = true
      return 'unavailable'
    })
    assert.equal(delegated, true)
    assert.equal(outcome, 'unavailable')
  } finally {
    await context.stop()
  }
})

test('/cwd mounts the newest session under an existing directory', async () => {
  const context = await harness()
  try {
    context.host.sessions.push({ sessionId: 'old', cwd: context.defaultCwd, updatedAt: 1, running: false })
    context.telegram.push(messageUpdate(1, 10, 1, `/cwd ${context.defaultCwd}`))
    await context.telegram.until(() => context.telegram.texts(10).some(text => text.includes('已挂载')))
    assert.deepEqual(context.host.followRequests.at(-1) && (context.host.followRequests.at(-1) as { address: { sessionId: string } }).address.sessionId, 'old')
  } finally {
    await context.stop()
  }
})

test('/cwd rejects a directory that does not exist', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '/cwd /definitely/not/here'))
    await context.telegram.until(() => context.telegram.texts(10).some(text => text.includes('目录不存在')))
    assert.equal(context.host.followRequests.length, 0)
  } finally {
    await context.stop()
  }
})

test('/sessions then /switch moves the mount', async () => {
  const context = await harness()
  try {
    context.host.sessions.push(
      { sessionId: 'a', cwd: '/tmp/a', updatedAt: 20, running: false },
      { sessionId: 'b', cwd: '/tmp/b', updatedAt: 10, running: false },
    )
    context.telegram.push(messageUpdate(1, 10, 1, '/sessions'))
    await context.telegram.until(() => context.telegram.texts(10).some(text => text.includes('最近会话')))
    context.telegram.push(messageUpdate(2, 10, 1, '/switch 2'))
    await context.telegram.until(() => context.telegram.texts(10).some(text => text.includes('已切换')))
    const last = context.host.followRequests.at(-1) as { address: { sessionId: string } }
    assert.equal(last.address.sessionId, 'b')
  } finally {
    await context.stop()
  }
})

test('a duplicate update is handled once', async () => {
  const context = await harness()
  try {
    const update = messageUpdate(1, 10, 1, '只说一次')
    context.telegram.push(update)
    await context.telegram.until(() => context.host.prompts.length === 1)
    context.telegram.push(update)
    await new Promise(settle => setTimeout(settle, 150))
    assert.equal(context.host.prompts.length, 1)
  } finally {
    await context.stop()
  }
})

test('keeps a message out of the agent when the bot messages itself', async () => {
  const context = await harness()
  try {
    const update = messageUpdate(1, 10, 1, '我是机器人')
    ;(update.message as { from: { is_bot: boolean } }).from.is_bot = true
    context.telegram.push(update)
    await new Promise(settle => setTimeout(settle, 150))
    assert.equal(context.host.prompts.length, 0)
  } finally {
    await context.stop()
  }
})
