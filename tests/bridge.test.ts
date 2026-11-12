import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Bridge } from '../src/bridge.ts'
import type { BridgeConfig, TelegramChannelConfig } from '../src/config.ts'
import type { HostBackend } from '../src/host/backend.ts'
import { Log } from '../src/log.ts'
import { COMMANDS } from '../src/router.ts'
import { Bindings } from '../src/store/bindings.ts'
import { UpdateLedger } from '../src/store/ledger.ts'
import { TelegramApi } from '../src/telegram/api.ts'
import { TelegramChannel } from '../src/telegram/channel.ts'
import {
  assistantMessage,
  attemptStart,
  callbackUpdate,
  FakeHost,
  FakeSurface,
  FakeTelegram,
  messageUpdate,
  type SurfaceMessage,
  textDelta,
  turnEnd,
  turnStart,
} from './fakes.ts'

/** Wire one bridge to a fake Host and a fake Bot API. */
async function harness(overrides: Partial<BridgeConfig> = {}, surface?: FakeSurface) {
  const telegram = new FakeTelegram()
  const url = await telegram.start()
  const stateDir = await mkdtemp(join(tmpdir(), 'hulala-bot-bridge-'))
  const defaultCwd = await mkdtemp(join(tmpdir(), 'hulala-bot-cwd-'))
  const telegramConfig: TelegramChannelConfig = {
    token: 'test-token',
    baseUrl: url,
    allowedUsers: [1],
    allowedChats: [],
    parseMode: 'plain',
    pollTimeoutSeconds: 1,
    proxy: undefined,
  }
  const config: BridgeConfig = {
    defaultCwd,
    streamIntervalMs: 0,
    stateDir,
    telegram: telegramConfig,
    lark: undefined,
    ...overrides,
  }
  const host = new FakeHost()
  const log = new Log(stateDir, ['test-token'])
  const channel = new TelegramChannel({
    api: new TelegramApi({ token: telegramConfig.token, baseUrl: url }),
    config: telegramConfig,
    ledger: await UpdateLedger.open(join(stateDir, 'receipts.json')),
    log,
    commands: COMMANDS,
  })
  const bridge = new Bridge({
    config,
    channels: surface === undefined ? [channel] : [channel, surface],
    bindings: await Bindings.open(stateDir),
    log,
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
    const placeholders = context.telegram.of('sendMessage').filter(call => String(call.body.text).includes('正在思考'))
    assert.equal(placeholders.length, 1)
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

test('pins a status message naming the mounted directory', async () => {
  const context = await harness()
  try {
    context.host.sessions.push({ sessionId: 'old', cwd: context.defaultCwd, updatedAt: 1, running: false })
    context.telegram.push(messageUpdate(1, 10, 1, `/cwd ${context.defaultCwd}`))
    await context.telegram.until(() => context.telegram.of('pinChatMessage').length > 0)
    const pinned = context.telegram.of('sendMessage').filter(call => String(call.body.text).includes('📍'))
    assert.ok(pinned.length > 0)
    assert.ok(String(pinned[0]?.body.text).includes(context.defaultCwd))
  } finally {
    await context.stop()
  }
})

test('/cwd without arguments offers recent directories as buttons', async () => {
  const context = await harness()
  try {
    context.host.sessions.push(
      { sessionId: 'a', cwd: '/tmp/alpha', updatedAt: 20, running: false },
      { sessionId: 'b', cwd: '/tmp/beta', updatedAt: 10, running: false },
    )
    context.telegram.push(messageUpdate(1, 10, 1, '/cwd'))
    await context.telegram.until(() => context.telegram.of('sendMessage').some(call => call.body.reply_markup !== undefined))
    const picker = context.telegram.of('sendMessage').find(call => call.body.reply_markup !== undefined)
    const rows = (picker?.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard
    assert.equal(rows.length, 2)
    assert.ok(rows[0]?.[0]?.text.includes('alpha'))
    assert.equal(rows[0]?.[0]?.callback_data, 'cwd:0')
    assert.equal(rows[1]?.[0]?.callback_data, 'cwd:1')
  } finally {
    await context.stop()
  }
})

test('a directory button mounts the chosen path', async () => {
  const context = await harness()
  try {
    const alpha = await mkdtemp(join(tmpdir(), 'dsh-cwd-alpha-'))
    const beta = await mkdtemp(join(tmpdir(), 'dsh-cwd-beta-'))
    context.host.sessions.push(
      { sessionId: 'a', cwd: alpha, updatedAt: 20, running: false },
      { sessionId: 'b', cwd: beta, updatedAt: 10, running: false },
    )
    context.telegram.push(messageUpdate(1, 10, 1, '/cwd'))
    await context.telegram.until(() => context.telegram.of('sendMessage').some(call => call.body.reply_markup !== undefined))
    const picker = context.telegram.of('sendMessage').find(call => call.body.reply_markup !== undefined)
    context.telegram.push(callbackUpdate(2, 10, 1, Number(picker?.body.message_id ?? 1), 'cwd:1'))
    await context.telegram.until(() => context.telegram.texts(10).some(text => text.includes(beta)))
    const last = context.host.followRequests.at(-1) as { address: { sessionId: string } }
    assert.equal(last.address.sessionId, 'b')
  } finally {
    await context.stop()
  }
})

test('a stale directory button says so instead of mounting', async () => {
  const context = await harness()
  try {
    context.telegram.push(callbackUpdate(1, 10, 1, 1, 'cwd:3'))
    await context.telegram.until(() => context.telegram.of('answerCallbackQuery').length > 0)
    assert.match(String(context.telegram.of('answerCallbackQuery')[0]?.body.text), /过期/)
    assert.equal(context.host.followRequests.length, 0)
  } finally {
    await context.stop()
  }
})

test('/status never creates a session just to look at one', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '/status'))
    await context.telegram.until(() => context.telegram.texts(10).length > 0)
    assert.match(String(context.telegram.texts(10)[0]), /还没有挂载会话/)
    assert.equal(context.host.created, 0)
    assert.equal(context.host.calls.some(call => call.method === 'workspace.create'), false)
  } finally {
    await context.stop()
  }
})

test('remounting the same directory does not pile up pinned messages', async () => {
  const context = await harness()
  try {
    context.host.sessions.push({ sessionId: 'old', cwd: context.defaultCwd, updatedAt: 1, running: false })
    context.telegram.push(messageUpdate(1, 10, 1, `/cwd ${context.defaultCwd}`))
    await context.telegram.until(() => context.telegram.of('pinChatMessage').length === 1)
    context.telegram.push(messageUpdate(2, 10, 1, `/cwd ${context.defaultCwd}`))
    await context.telegram.until(() => context.telegram.texts(10).filter(text => text.includes('已挂载')).length >= 2)
    await new Promise(settle => setTimeout(settle, 80))
    assert.equal(context.telegram.of('pinChatMessage').length, 1)
  } finally {
    await context.stop()
  }
})

test('the pinned status says whether the turn is running', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '/new'))
    await context.telegram.until(() => context.telegram.texts(10).some(text => text.includes('已新建会话')))
    const pinned = () => context.telegram.of('editMessageText').map(call => String(call.body.text)).join('\n')
    context.host.emit(turnStart())
    await context.telegram.until(() => pinned().includes('运行中'))
    context.host.emit(turnEnd())
    await context.telegram.until(() => pinned().includes('空闲'))
  } finally {
    await context.stop()
  }
})

test('one approval reaches both surfaces and one answer closes both', async () => {
  const surface = new FakeSurface()
  const context = await harness({}, surface)
  try {
    await surface.whenStarted()
    await surface.emit({
      kind: 'message',
      chat: { channel: 'lark', chatId: 'oc_1' },
      userId: 'ou_1',
      text: '跑一下',
      fromBot: false,
      messageId: 'om_1',
    })
    context.telegram.push(messageUpdate(1, 10, 1, '跑一下'))
    await context.telegram.until(() => context.host.prompts.length === 2)

    const outcome = context.host.invoke('approval/request', { toolName: 'bash', reason: 'rm -rf /tmp/x' })
    await context.telegram.until(() => surface.sent.some(message => message.keyboard !== undefined))
    await context.telegram.until(() => context.telegram.of('sendMessage').some(call => call.body.reply_markup !== undefined))

    const card = surface.sent.find(message => message.keyboard !== undefined) as { messageId: string; keyboard: NonNullable<SurfaceMessage['keyboard']> }
    const data = card.keyboard[0]?.[0]?.data ?? ''
    assert.match(data, /^approve:a\d+$/)
    await surface.emit({
      kind: 'callback',
      chat: { channel: 'lark', chatId: 'oc_1' },
      userId: 'ou_1',
      callbackId: 'om_1',
      messageId: card.messageId,
      data,
    })
    assert.equal(await outcome, 'allowed-once')
    await context.telegram.until(() => surface.edits.some(edit => edit.text.includes('已允许')))
    await context.telegram.until(() => context.telegram.texts(10).some(text => text.includes('已允许')))
  } finally {
    await context.stop()
  }
})
