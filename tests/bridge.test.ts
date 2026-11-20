import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
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
  continuedQuestions,
  FakeHost,
  FakeSurface,
  FakeTelegram,
  messageUpdate,
  photoUpdate,
  queuedReply,
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

/** The only chat a question test mounts. */
const QUESTION_CHAT = { channel: 'lark' as const, chatId: 'oc_1' }

/** One question with two options; overrides replace any field. */
function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'q1',
    question: '用哪个数据库？',
    options: [{ label: 'Postgres' }, { label: 'SQLite' }],
    ...overrides,
  }
}

/** A bridge whose only mounted conversation is a fake surface. */
async function questionHarness() {
  const surface = new FakeSurface()
  const context = await harness({}, surface)
  await surface.whenStarted()
  await context.telegram.until(() => context.host.controlStreams > 0, 4000)
  await surface.emit({
    kind: 'message',
    chat: QUESTION_CHAT,
    userId: 'ou_1',
    text: '跑一下',
    fromBot: false,
    messageId: 'om_1',
  })
  await context.telegram.until(() => context.host.prompts.length === 1)
  return { ...context, surface, sessionId: context.host.prompts[0]?.sessionId ?? 's1' }
}

/** The most recent question card that still carries buttons. */
function cardOf(surface: FakeSurface) {
  const withButtons = [...surface.sent, ...surface.edits].filter(message => (message.keyboard?.length ?? 0) > 0)
  const last = withButtons.at(-1)
  assert.ok(last !== undefined, 'no question card with buttons was sent')
  return last
}

/** The callback data of one button, matched by a fragment of its label. */
function buttonOf(surface: FakeSurface, label: string): string {
  const buttons = cardOf(surface).keyboard?.flat() ?? []
  const found = buttons.find(button => button.text.includes(label))
  assert.ok(found !== undefined, `no button ${label}; got ${buttons.map(button => button.text).join(', ')}`)
  return found.data
}

let callbackSequence = 100

/** Deliver one button press to the surface that owns the current card. */
async function press(surface: FakeSurface, data: string): Promise<void> {
  const card = cardOf(surface)
  callbackSequence += 1
  await surface.emit({
    kind: 'callback',
    chat: card.chat,
    userId: 'ou_1',
    callbackId: `cb${String(callbackSequence)}`,
    messageId: card.messageId,
    data,
  })
}

/** Wait until a card whose text contains `fragment` was sent or edited. */
async function untilCard(surface: FakeSurface, fragment: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (![...surface.sent, ...surface.edits].some(message => message.text.includes(fragment))) {
    if (Date.now() > deadline) throw new Error(`no card containing ${fragment}`)
    await new Promise(settle => setTimeout(settle, 10))
  }
}

/** Wait until the last edit of a surface dropped every button. */
async function untilSettled(surface: FakeSurface, fragment: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const last = surface.edits.at(-1)
    if (last?.text.includes(fragment) === true && (last.keyboard?.length ?? 0) === 0) return
    if (Date.now() > deadline) throw new Error(`no settled card containing ${fragment}`)
    await new Promise(settle => setTimeout(settle, 10))
  }
}

/** One waterfall request for the Session a question harness mounted. */
function requestFor(sessionId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { questions: [question()], agent: { session: { id: sessionId } }, ...overrides }
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
    const outcome = context.host.invoke('approval/request', {
      toolName: 'bash',
      reason: 'rm -rf /tmp/x',
      signal: new AbortController().signal,
      agent: { session: { id: 's1' } },
    })
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

test('full access answers once and switches the Session through the Host command', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '改一下那个仓库'))
    await context.telegram.until(() => context.host.followRequests.length === 1)
    context.host.emit(turnStart())
    await new Promise(settle => setTimeout(settle, 60))
    const outcome = context.host.invoke('approval/request', {
      toolName: 'bash',
      reason: 'escalate sandbox to workspace-write: the repo is outside the workspace',
      agent: { session: { id: 's1' } },
    })
    await context.telegram.until(() => context.telegram.of('sendMessage').some(call => call.body.reply_markup !== undefined))
    const card = context.telegram.of('sendMessage').find(call => call.body.reply_markup !== undefined)
    const keyboard = (card?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard
    const data = keyboard[0]?.find(button => button.callback_data.startsWith('full:'))?.callback_data ?? ''
    assert.match(data, /^full:a\d+$/)
    context.telegram.push(callbackUpdate(2, 10, 1, Number(card?.body.chat_id ?? 0), data))
    assert.equal(await outcome, 'allowed-once')
    assert.deepEqual(context.host.commands, [{ sessionId: 's1', line: '/permission danger-full-access' }])
    await context.telegram.until(() => context.telegram.texts(10).some(text => text.includes('已改为完全权限')))
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
    const outcome = context.host.invoke('approval/request', {
      toolName: 'bash',
      signal: controller.signal,
      agent: { session: { id: 's1' } },
    })
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

test('an approval for a Session no conversation watches is delegated, not broadcast', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '跑一下'))
    await context.telegram.until(() => context.host.followRequests.length === 1)
    context.host.emit(turnStart())
    await new Promise(settle => setTimeout(settle, 60))
    let delegated = false
    const outcome = await context.host.invoke('approval/request', {
      toolName: 'bash',
      reason: 'escalate sandbox to danger-full-access',
      agent: { session: { id: 'foreign-session' } },
    }, async () => {
      delegated = true
      return 'unavailable'
    })
    assert.equal(delegated, true)
    assert.equal(outcome, 'unavailable')
    assert.equal(context.telegram.of('sendMessage').filter(call => call.body.reply_markup !== undefined).length, 0)
  } finally {
    await context.stop()
  }
})

test('a question from a Session no conversation is mounted to is not announced', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '跑一下'))
    await context.telegram.until(() => context.host.followRequests.length === 1)
    let delegated = false
    const outcome = await context.host.invoke(
      'user-questions/request',
      { questions: [{ question: '这张图要做什么？', options: [{ label: '转 SVG' }] }], agent: { session: { id: 's9' } } },
      async () => {
        delegated = true
        return 'unavailable'
      },
    )
    assert.equal(delegated, true)
    assert.equal(outcome, 'unavailable')
    assert.equal(context.telegram.texts(10).some(text => text.includes('❓')), false)
  } finally {
    await context.stop()
  }
})

test('an unnamed question is delegated, never broadcast to a running conversation', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '跑一下'))
    await context.telegram.until(() => context.host.followRequests.length === 1)
    let delegated = false
    const outcome = await context.host.invoke('user-questions/request', {
      questions: [{ question: '要哪个？' }],
    }, async () => {
      delegated = true
      return 'unavailable'
    })
    assert.equal(delegated, true)
    assert.equal(outcome, 'unavailable')
    // A question with no owning Session must not be announced in whichever chat
    // happens to have a turn in flight — that is the misrouting approvals had.
    assert.equal(context.telegram.texts(10).some(text => text.includes('❓')), false)
  } finally {
    await context.stop()
  }
})

test('a question is answered on the conversation mounted to its Session, not on another one', async () => {
  const { surface, host, telegram, sessionId, stop } = await questionHarness()
  try {
    const outcome = host.invoke('user-questions/request', requestFor(sessionId), async () => 'downstream')
    await untilCard(surface, '用哪个数据库？')
    assert.equal(telegram.texts(10).some(text => text.includes('❓')), false)
    await press(surface, buttonOf(surface, 'Postgres'))
    await press(surface, buttonOf(surface, '提交'))
    // The bot is a real answerer: it returns a structured batch instead of next().
    assert.deepEqual(await outcome, { answers: [{ id: 'q1', selected: ['Postgres'] }] })
    await untilSettled(surface, '已在本端回答')
  } finally {
    await stop()
  }
})

test('a question batch collects one answer item per question id', async () => {
  const { surface, host, sessionId, stop } = await questionHarness()
  try {
    const questions = [
      question(),
      question({ id: 'q2', question: '部署到哪里？', options: [{ label: '本机' }, { label: '云端' }] }),
    ]
    const outcome = host.invoke('user-questions/request', requestFor(sessionId, { questions }), async () => 'downstream')
    await untilCard(surface, '第 1/2 题')
    await press(surface, buttonOf(surface, '提交'))
    assert.ok(surface.toasts.some(toast => toast.includes('每道题都要选一个选项')))
    await press(surface, buttonOf(surface, 'Postgres'))
    await press(surface, buttonOf(surface, '下一题'))
    await untilCard(surface, '第 2/2 题')
    await press(surface, buttonOf(surface, '云端'))
    await press(surface, buttonOf(surface, '提交'))
    assert.deepEqual(await outcome, { answers: [
      { id: 'q1', selected: ['Postgres'] },
      { id: 'q2', selected: ['云端'] },
    ] })
  } finally {
    await stop()
  }
})

test('a multi-select question toggles its option labels in the answer batch', async () => {
  const { surface, host, sessionId, stop } = await questionHarness()
  try {
    const outcome = host.invoke('user-questions/request',
      requestFor(sessionId, { questions: [question({ multiSelect: true })] }), async () => 'downstream')
    await untilCard(surface, '可多选')
    await press(surface, buttonOf(surface, 'Postgres'))
    await press(surface, buttonOf(surface, 'SQLite'))
    await press(surface, buttonOf(surface, '提交'))
    assert.deepEqual(await outcome, { answers: [{ id: 'q1', selected: ['Postgres', 'SQLite'] }] })
  } finally {
    await stop()
  }
})

test('a custom answer typed in chat becomes the answer and never prompts the agent', async () => {
  const { surface, host, sessionId, stop } = await questionHarness()
  try {
    const outcome = host.invoke('user-questions/request', requestFor(sessionId), async () => 'downstream')
    await untilCard(surface, '用哪个数据库？')
    await press(surface, buttonOf(surface, '自定义答案'))
    await surface.emit({
      kind: 'message', chat: QUESTION_CHAT, userId: 'ou_1',
      text: '  MySQL  ', fromBot: false, messageId: 'om_custom',
    })
    assert.equal(host.prompts.length, 1) // only the mount prompt
    await untilCard(surface, 'MySQL')
    await press(surface, buttonOf(surface, '提交'))
    assert.deepEqual(await outcome, { answers: [{ id: 'q1', selected: [], custom: 'MySQL' }] })
  } finally {
    await stop()
  }
})

test('a Computer-Use approval question is decided by one button press', async () => {
  const { surface, host, sessionId, stop } = await questionHarness()
  try {
    const outcome = host.invoke('user-questions/request', requestFor(sessionId, {
      questions: [{
        id: 'q1',
        question: 'Allow the camera?',
        detail: 'example.com asks for the camera',
        options: [{ label: '允许' }, { label: '拒绝' }, { label: '一直允许' }],
        intent: {
          kind: 'approval',
          approve: '允许',
          reject: '拒绝',
          always: '一直允许',
          subject: { name: 'example.com' },
          display: {
            question: { en: 'Allow the camera?', zh: '允许使用摄像头吗？' },
            detail: { en: 'example.com asks for the camera', zh: 'example.com 请求使用摄像头' },
          },
        },
      }],
    }), async () => 'downstream')
    await untilCard(surface, '🛡')
    assert.match(cardOf(surface).text, /🛡 需要授权 · example\.com/)
    assert.match(cardOf(surface).text, /允许使用摄像头吗？/)
    assert.match(cardOf(surface).text, /✓ 允许/)
    // One press is the whole answer: there is no submit row on a fixed card.
    assert.equal(cardOf(surface).keyboard?.flat().some(button => button.text.includes('提交')), false)
    await press(surface, buttonOf(surface, '拒绝'))
    assert.deepEqual(await outcome, { answers: [{ id: 'q1', selected: ['拒绝'] }] })
  } finally {
    await stop()
  }
})

test('a continued approval row keeps its intent and shows the localized approve label', async () => {
  const { surface, host, sessionId, stop } = await questionHarness()
  try {
    host.baseline(sessionId, continuedQuestions('c7', [{
      id: 'q1',
      question: 'Allow the camera?',
      detail: 'example.com asks for the camera',
      options: [{ label: '允许' }, { label: '拒绝' }],
      intent: {
        kind: 'approval',
        approve: '允许',
        reject: '拒绝',
        subject: { name: 'example.com' },
        display: {
          question: { en: 'Allow the camera?', zh: '允许使用摄像头吗？' },
          approve: { en: 'Allow', zh: '同意使用' },
        },
      },
    }]))
    await untilCard(surface, '补答会在下一轮进入 agent')
    const card = cardOf(surface)
    // `questionItems()` must not strip a projection row's intent: without it a
    // CUA permission request would become an ordinary free-text question.
    assert.match(card.text, /🛡 需要授权 · example\.com/)
    assert.match(card.text, /允许使用摄像头吗？/)
    assert.match(card.text, /✓ 同意使用/)
    assert.doesNotMatch(card.text, /自定义答案/)
    assert.equal(card.keyboard?.flat().some(button => button.text.includes('提交')), false)
    // `display.approve` is presentation only. Buttons and the answer Remote
    // still carry the wire option labels.
    await press(surface, buttonOf(surface, '拒绝'))
    await untilCard(surface, '已提交')
    assert.deepEqual(host.answers[0]?.batch, { answers: [{ id: 'q1', selected: ['拒绝'] }] })
  } finally {
    await stop()
  }
})

test('a timed question holds the claim, rejects ASK_TIMED_OUT, then accepts a late answer', async () => {
  const { surface, host, sessionId, stop } = await questionHarness()
  host.waitRemainingMs = 150
  try {
    const outcome = host.invoke('user-questions/request', requestFor(sessionId, {
      questions: [question()], wait: { callId: 'c9', timed: true },
    }), async () => 'downstream')
    await untilCard(surface, '还剩')
    assert.equal(host.waits.length, 1)
    assert.equal(host.waits[0]?.callId, 'c9')
    // The Host stops its own timer while a client holds the claim, so the
    // client must settle the waterfall with the wire-preserved timeout code.
    await assert.rejects(outcome, (error: unknown) =>
      (error as { code?: unknown }).code === 'ASK_TIMED_OUT')
    await untilCard(surface, '回答窗口已关闭')
    assert.equal(host.waits[0]?.released, true)
    // The projection is the only source of a late answer: it flips the same
    // timed call to `continued` and gives its card the answer Remote path.
    host.projection(sessionId, continuedQuestions('c9', [question()]))
    await untilCard(surface, '补答会在下一轮进入 agent')
    assert.equal(surface.sent.filter(message => message.text.includes('❓')).length, 1)
    await press(surface, buttonOf(surface, 'Postgres'))
    await press(surface, buttonOf(surface, '提交'))
    await untilCard(surface, '已提交')
    assert.deepEqual(host.answers, [{
      sessionId, callId: 'c9', batch: { answers: [{ id: 'q1', selected: ['Postgres'] }] },
    }])
  } finally {
    await stop()
  }
})

test('a continued question from the control baseline becomes an answerable card', async () => {
  const { surface, host, sessionId, stop } = await questionHarness()
  try {
    host.baseline(sessionId, continuedQuestions('c7', [question()]))
    await untilCard(surface, '补答会在下一轮进入 agent')
    await press(surface, buttonOf(surface, 'SQLite'))
    await press(surface, buttonOf(surface, '提交'))
    await untilCard(surface, '已提交')
    assert.equal(host.answers[0]?.callId, 'c7')
    assert.deepEqual(host.answers[0]?.batch, { answers: [{ id: 'q1', selected: ['SQLite'] }] })
  } finally {
    await stop()
  }
})

test('a queued late reply withdraws the editable card until the projection closes the row', async () => {
  const { surface, host, sessionId, stop } = await questionHarness()
  try {
    host.baseline(sessionId, continuedQuestions('c7', [question()]))
    await untilCard(surface, '补答会在下一轮进入 agent')
    host.projection(sessionId, { ...continuedQuestions('c7', [question()]), ...queuedReply('c7') })
    await untilSettled(surface, '已结算')
    assert.equal(host.answers.length, 0)
  } finally {
    await stop()
  }
})

test('answer() returning false says the call is no longer answerable', async () => {
  const { surface, host, sessionId, stop } = await questionHarness()
  host.answerAccepted = false
  try {
    host.baseline(sessionId, continuedQuestions('c7', [question()]))
    await untilCard(surface, '补答会在下一轮进入 agent')
    await press(surface, buttonOf(surface, 'Postgres'))
    await press(surface, buttonOf(surface, '提交'))
    await untilCard(surface, '不可补答')
  } finally {
    await stop()
  }
})

test('REPLY_QUEUED is reported as a queued answer, not a generic failure', async () => {
  const { surface, host, sessionId, stop } = await questionHarness()
  host.answerFailure = { message: 'a reply is already queued for this question', code: 'REPLY_QUEUED' }
  try {
    host.baseline(sessionId, continuedQuestions('c7', [question()]))
    await untilCard(surface, '补答会在下一轮进入 agent')
    await press(surface, buttonOf(surface, 'Postgres'))
    await press(surface, buttonOf(surface, '提交'))
    await untilCard(surface, '答案已在排队')
    assert.equal(surface.toasts.some(toast => toast.includes('提交失败')), false)
  } finally {
    await stop()
  }
})

test('handing a question on delegates the waterfall, and the projection reveals the same card', async () => {
  const { surface, host, sessionId, stop } = await questionHarness()
  try {
    const outcome = host.invoke('user-questions/request', requestFor(sessionId, {
      questions: [question()], wait: { callId: 'c7' },
    }), async () => 'downstream')
    await untilCard(surface, '用哪个数据库？')
    await press(surface, buttonOf(surface, '交给他端'))
    assert.equal(await outcome, 'downstream')
    await untilSettled(surface, '已交给其他端')
    // The card is hidden, not duplicated: the continued row reuses it.
    host.projection(sessionId, continuedQuestions('c7', [question()]))
    await untilCard(surface, '补答会在下一轮进入 agent')
    assert.equal(surface.sent.filter(message => message.text.includes('❓')).length, 1)
    await press(surface, buttonOf(surface, 'Postgres'))
    await press(surface, buttonOf(surface, '提交'))
    await untilCard(surface, '已提交')
    assert.equal(host.answers[0]?.callId, 'c7')
  } finally {
    await stop()
  }
})

test('an open projection row does not create a second card for the same call', async () => {
  const { surface, host, sessionId, stop } = await questionHarness()
  try {
    const open = { userQuestions: { active: [{ callId: 'c7', questions: [question()], state: 'open' }], settled: [] } }
    host.baseline(sessionId, open)
    const outcome = host.invoke('user-questions/request', requestFor(sessionId, {
      questions: [question()], wait: { callId: 'c7' },
    }), async () => 'downstream')
    await untilCard(surface, '用哪个数据库？')
    assert.equal(surface.sent.filter(message => message.text.includes('❓')).length, 1)
    await press(surface, buttonOf(surface, 'Postgres'))
    await press(surface, buttonOf(surface, '提交'))
    assert.deepEqual(await outcome, { answers: [{ id: 'q1', selected: ['Postgres'] }] })
  } finally {
    await stop()
  }
})

test('a projection read before a chat mounted is reconciled when the mount appears', async () => {
  const surface = new FakeSurface()
  const context = await harness({}, surface)
  try {
    await surface.whenStarted()
    await context.telegram.until(() => context.host.controlStreams > 0, 4000)
    context.host.baseline('s1', continuedQuestions('c8', [question()]))
    await surface.emit({
      kind: 'message', chat: QUESTION_CHAT, userId: 'ou_1',
      text: '跑一下', fromBot: false, messageId: 'om_1',
    })
    await untilCard(surface, '补答会在下一轮进入 agent')
    await press(surface, buttonOf(surface, 'Postgres'))
    await press(surface, buttonOf(surface, '提交'))
    await untilCard(surface, '已提交')
    assert.equal(context.host.answers[0]?.callId, 'c8')
  } finally {
    await context.stop()
  }
})

test('stopping the bot hands every live waterfall back to the Host', async () => {
  const { surface, host, sessionId, stop } = await questionHarness()
  const outcome = host.invoke('user-questions/request', requestFor(sessionId), async () => 'downstream')
  await untilCard(surface, '用哪个数据库？')
  await stop()
  assert.equal(await outcome, 'downstream')
})

test('/cwd starts a new session even when that directory already has one', async () => {
  const context = await harness()
  try {
    context.host.sessions.push({ sessionId: 'old', cwd: context.defaultCwd, updatedAt: 1, running: false })
    context.telegram.push(messageUpdate(1, 10, 1, `/cwd ${context.defaultCwd}`))
    await context.telegram.until(() => context.telegram.texts(10).some(text => text.includes('新建会话')))
    const followed = (context.host.followRequests.at(-1) as { address: { sessionId: string } }).address.sessionId
    assert.notEqual(followed, 'old')
    assert.equal(context.host.created, 1)
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
    const followed = context.host.sessions.find(session => session.sessionId === last.address.sessionId)
    assert.equal(followed?.cwd, beta)
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

test('the published command menu only carries names Telegram accepts', async () => {
  const context = await harness()
  try {
    await context.telegram.until(() => context.telegram.of('setMyCommands').length > 0)
    const body = context.telegram.of('setMyCommands')[0]?.body as { commands?: readonly { command: string }[] }
    const names = (body.commands ?? []).map(entry => entry.command)
    for (const name of names) assert.match(name, /^[a-z0-9_]{1,32}$/)
    assert.ok(names.includes('create_auto_task'))
  } finally {
    await context.stop()
  }
})

test('/tasks lists Host tasks without creating a session', async () => {
  const context = await harness()
  try {
    context.host.schedule.push({
      id: 'schedule-1',
      title: 'BTC 日报',
      kind: 'daily',
      status: 'active',
      time: '06:00:00.000',
      timeZone: 'Asia/Shanghai',
      scheduledAt: '2026-11-16T22:00:00.000Z',
    })
    context.telegram.push(messageUpdate(1, 10, 1, '/tasks'))
    await context.telegram.until(() => context.telegram.texts(10).length > 0)
    const reply = String(context.telegram.texts(10)[0])
    assert.match(reply, /BTC 日报/)
    assert.match(reply, /每天 06:00 Asia\/Shanghai/)
    assert.match(reply, /下次 11-17 06:00/)
    assert.equal(context.host.created, 0)
  } finally {
    await context.stop()
  }
})

test('/tasks on an empty Host says how to create one', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '/tasks'))
    await context.telegram.until(() => context.telegram.texts(10).length > 0)
    assert.match(String(context.telegram.texts(10)[0]), /\/create-auto-task/)
  } finally {
    await context.stop()
  }
})

test('/create-auto-task sends the seed and the requirement as one prompt', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '/create-auto-task 每天早上 6 点把 BTC 日报发到 Telegram'))
    await context.telegram.until(() => context.host.prompts.length > 0)
    const prompt = String(context.host.prompts[0]?.text)
    assert.match(prompt, /请根据需求创建一个自动化任务。/)
    assert.match(prompt, /每天早上 6 点把 BTC 日报发到 Telegram/)
  } finally {
    await context.stop()
  }
})

test('/create_auto_task is the menu spelling of the same command', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '/create_auto_task 每周一早上 9 点提醒我复盘'))
    await context.telegram.until(() => context.host.prompts.length > 0)
    assert.match(String(context.host.prompts[0]?.text), /每周一早上 9 点提醒我复盘/)
  } finally {
    await context.stop()
  }
})

test('/create-auto-task without requirements answers with usage and sends nothing', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '/create-auto-task'))
    await context.telegram.until(() => context.telegram.texts(10).length > 0)
    assert.match(String(context.telegram.texts(10)[0]), /用法：\/create-auto-task/)
    assert.equal(context.host.prompts.length, 0)
    assert.equal(context.host.created, 0)
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
    await context.telegram.until(() => context.telegram.texts(10).filter(text => text.includes('新建会话')).length >= 2)
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

test('an approval is rendered only on the conversation mounted to its Session', async () => {
  const surface = new FakeSurface()
  const context = await harness({}, surface)
  try {
    await surface.whenStarted()
    context.telegram.push(messageUpdate(1, 10, 1, '跑一下'))
    await context.telegram.until(() => context.host.followRequests.length === 1)

    const outcome = context.host.invoke('approval/request', {
      toolName: 'bash',
      reason: 'rm -rf /tmp/x',
      agent: { session: { id: 's1' } },
    })
    await context.telegram.until(() => context.telegram.of('sendMessage').some(call => call.body.reply_markup !== undefined))
    const card = context.telegram.of('sendMessage').find(call => call.body.reply_markup !== undefined)
    const keyboard = (card?.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard
    const data = keyboard[0]?.[0]?.callback_data ?? ''
    assert.match(data, /^approve:a\d+$/)
    // The other channel is live but has no mount for s1: a permission request
    // for one Session must not be broadcast to unrelated conversations.
    assert.equal(surface.sent.filter(message => message.keyboard !== undefined).length, 0)

    context.telegram.push(callbackUpdate(2, 10, 1, Number(card?.body.chat_id ?? 0), data))
    assert.equal(await outcome, 'allowed-once')
    await context.telegram.until(() => context.telegram.texts(10).some(text => text.includes('已允许')))
  } finally {
    await context.stop()
  }
})

test('two conversations get their own session instead of sharing one', async () => {
  const context = await harness()
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '你好'))
    await context.telegram.until(() => context.host.prompts.length === 1)
    context.telegram.push(messageUpdate(2, 20, 1, '你好'))
    await context.telegram.until(() => context.host.prompts.length === 2)
    assert.notEqual(context.host.prompts[0]?.sessionId, context.host.prompts[1]?.sessionId)
    assert.equal(context.host.created, 2)
  } finally {
    await context.stop()
  }
})

test('a photo becomes a prompt image part, caption included', async () => {
  const context = await harness()
  try {
    context.telegram.push(photoUpdate(1, 10, 1, '看看这张'))
    await context.telegram.until(() => context.host.prompts.length === 1)
    const prompt = context.host.prompts[0]
    assert.match(prompt?.text ?? '', /看看这张/)
    assert.match(prompt?.text ?? '', /\[图片: .*\.jpg\]/)
  } finally {
    await context.stop()
  }
})

test('an unsupported message is answered instead of ignored', async () => {
  const context = await harness()
  try {
    context.telegram.push({
      update_id: 1,
      message: { message_id: 1, chat: { id: 10, type: 'private' }, from: { id: 1, is_bot: false }, sticker: { file_id: 'x' } },
    })
    await context.telegram.until(() => context.telegram.texts(10).some(text => text.includes('只支持文字和图片')))
  } finally {
    await context.stop()
  }
})

test('an image the reply references is sent as a photo and stripped from the text', async () => {
  const context = await harness()
  const dir = await mkdtemp(join(tmpdir(), 'hulala-bot-image-'))
  const file = join(dir, 'chart.png')
  await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  try {
    context.telegram.push(messageUpdate(1, 10, 1, '画个图'))
    await context.telegram.until(() => context.host.followRequests.length === 1)
    context.host.emit(turnStart())
    context.host.emit(attemptStart('a1'))
    const answer = `图在这里 ![chart](${file})`
    context.host.emit(assistantMessage(answer))
    context.host.emit(turnEnd())
    await context.telegram.until(() => context.telegram.of('sendPhoto').length === 1)
    const photo = context.telegram.of('sendPhoto')[0]
    assert.equal(photo?.body.multipart, true)
    assert.match(String(photo?.body.raw), /filename="image\.png"/)
    assert.match(String(photo?.body.raw), /chart/)
    await context.telegram.until(() => context.telegram.texts(10).includes('图在这里 chart'))
  } finally {
    await context.stop()
  }
})
