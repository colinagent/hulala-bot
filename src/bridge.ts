/**
 * The Telegram peer.
 *
 * One bot serves one Host: inbound messages either change which session a
 * conversation is mounted to or become a prompt on the mounted session, and
 * every turn in that session streams back into the conversation. Approvals are
 * rendered as buttons; answering one settles the Host request, and the other
 * clients withdraw their own copies through the cancellation signal.
 *
 * @module dsh-telegram/bridge
 */
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SessionFollowFrame, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { expandHome, type BridgeConfig } from './config.ts'
import { attach, endpointPath, readEndpoint, type HostBackend } from './host/attach.ts'
import { TurnTracker } from './host/turn.ts'
import { Log } from './log.ts'
import { toMarkdownV2 } from './render/markdown.ts'
import { COMMANDS, HELP, parseCommand } from './router.ts'
import { keyOf, type Bindings, type ChatKey } from './store/bindings.ts'
import { TelegramApi, type InboundUpdate, type TelegramMessage } from './telegram/api.ts'
import { UpdateLedger } from './telegram/ledger.ts'
import { ReplyStream } from './telegram/reply.ts'

/** Approval outcomes the Host accepts. */
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** What a button press can decide. */
type Decision = 'allowed-once' | 'rejected' | 'cancelled'

/** Waterfall request as delivered to a peer. */
interface ApprovalRequest {
  readonly toolName: string
  readonly callId?: unknown
  readonly reason?: string
  readonly displayReason?: unknown
  readonly signal?: AbortSignal
}

/** Question request as delivered to a peer; the bridge only announces it. */
interface QuestionRequest {
  readonly questions: readonly { readonly question: string }[]
}

/** One conversation mounted to one session. */
interface Mount {
  readonly key: ChatKey
  readonly sessionId: string
  readonly tracker: TurnTracker
  readonly abort: AbortController
  reply: ReplyStream | undefined
  /** Whether a turn is in flight in this mounted session. */
  active: boolean
}

/** One approval waiting for a button press. */
interface Pending {
  readonly key: string
  readonly cards: { chatId: number; messageId: number }[]
  settled: boolean
  readonly resolve: (decision: Decision) => void
}

/** Terminal abstraction over Host RPC results. */
function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) {
    const failure = result.error as { message?: string; code?: string }
    throw new Error(failure.message ?? failure.code ?? 'Host request failed')
  }
  return result.value
}

/** Run on abort, including the already-aborted case. */
function whenAborted(signal: AbortSignal | undefined, run: () => void): () => void {
  if (signal === undefined) return () => undefined
  const listener = (): void => { run() }
  signal.addEventListener('abort', listener, { once: true })
  if (signal.aborted) run()
  return () => { signal.removeEventListener('abort', listener) }
}

/** Injectable host attach, so tests can supply a fake Host. */
export type HostConnect = () => Promise<HostBackend>

/** Everything the bridge needs. */
export interface BridgeOptions {
  readonly config: BridgeConfig
  readonly api: TelegramApi
  readonly ledger: UpdateLedger
  readonly bindings: Bindings
  readonly log: Log
  readonly connect?: HostConnect
}

/** The peer itself. */
export class Bridge {
  readonly #config: BridgeConfig
  readonly #api: TelegramApi
  readonly #ledger: UpdateLedger
  readonly #bindings: Bindings
  readonly #log: Log
  readonly #connect: HostConnect
  readonly #mounts = new Map<string, Mount>()
  readonly #pending = new Map<string, Pending>()
  readonly #recent = new Map<string, readonly string[]>()
  readonly #stopped = new AbortController()
  #backend: HostBackend | undefined
  #sequence = 0
  #defaultSession: string | undefined

  /** @param options - configuration and collaborators. */
  constructor(options: BridgeOptions) {
    this.#config = options.config
    this.#api = options.api
    this.#ledger = options.ledger
    this.#bindings = options.bindings
    this.#log = options.log
    this.#connect = options.connect ?? (async () => attach(await readEndpoint(endpointPath())))
  }

  /** Connect, publish the command menu, and start long polling. */
  async start(): Promise<void> {
    // A Host that is down must not stop the bridge: the first message retries.
    await this.#ensureHost().catch(error => {
      this.#log.error(`Host is not reachable yet: ${error instanceof Error ? error.message : String(error)}`)
    })
    void this.#api
      .setMyCommands(COMMANDS.map(command => ({ command: command.command, description: command.description })))
      .catch(error => { this.#log.error(`setMyCommands failed: ${String(error)}`) })
    await this.#poll()
  }

  /** Stop polling, abort follows, and close the Host connection. */
  async stop(): Promise<void> {
    this.#stopped.abort()
    for (const mount of this.#mounts.values()) {
      mount.abort.abort()
      mount.reply?.dispose()
    }
    this.#mounts.clear()
    await this.#bindings.flush().catch(() => undefined)
    await this.#ledger.flush().catch(() => undefined)
    const backend = this.#backend
    this.#backend = undefined
    await backend?.close().catch(() => undefined)
  }

  /** Current backend or a fresh attachment, with every mount restored. */
  async #ensureHost(): Promise<HostBackend> {
    if (this.#backend !== undefined) return this.#backend
    const backend = await this.#connect()
    this.#backend = backend
    // The forwarded-event key map is a Host-side allowlist shipped as a type
    // augmentation; this client binds the two waterfall events it answers
    // through one narrow local signature instead of depending on that wiring.
    const events = backend.ctx.remote as unknown as {
      $on(
        name: 'approval/request' | 'user-questions/request',
        handler: (request: unknown, next: () => Promise<unknown>) => Promise<unknown>,
      ): () => void
    }
    events.$on('approval/request', (request, next) => this.#onApproval(request as ApprovalRequest, next as () => Promise<ApprovalOutcome>))
    events.$on('user-questions/request', (request, next) => this.#onQuestion(request as QuestionRequest, next))
    await this.#restore()
    return backend
  }

  /** Drop a dead connection so the next call re-attaches. */
  async #drop(reason: string): Promise<void> {
    this.#log.error(`host connection lost: ${reason}`)
    const backend = this.#backend
    this.#backend = undefined
    this.#defaultSession = undefined
    for (const key of [...this.#pending.keys()]) this.#settle(key, 'cancelled', '')
    for (const mount of this.#mounts.values()) mount.abort.abort()
    this.#mounts.clear()
    await backend?.close().catch(() => undefined)
  }

  /** Re-follow every persisted mount. */
  async #restore(): Promise<void> {
    for (const mount of this.#mounts.values()) mount.abort.abort()
    this.#mounts.clear()
    for (const key of this.#bindings.entries()) {
      const sessionId = this.#bindings.get(key)
      if (sessionId === undefined) continue
      await this.#mount(key, sessionId).catch(error => {
        this.#log.error(`cannot mount ${keyOf(key)}: ${String(error)}`)
      })
    }
  }

  /** Long-poll loop. */
  async #poll(): Promise<void> {
    let offset = this.#ledger.cursor === 0 ? 0 : this.#ledger.cursor + 1
    let failures = 0
    while (!this.#stopped.signal.aborted) {
      try {
        const updates = await this.#api.getUpdates(offset, this.#config.pollTimeoutSeconds, this.#stopped.signal)
        failures = 0
        for (const update of updates) {
          offset = update.updateId + 1
          if (this.#ledger.seen(update.updateId)) continue
          try {
            await this.#handle(update)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.#log.error(`update ${String(update.updateId)} failed: ${message}`)
            if (update.kind === 'message') {
              await this.#say(this.#keyOfMessage(update.message), 'Host 现在不可用，这次请求没有送出去。确认 Host 在运行后再发一次。')
            }
          }
        }
        await this.#ledger.flush().catch(() => undefined)
      } catch (error) {
        if (this.#stopped.signal.aborted) return
        failures += 1
        const wait = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))
        this.#log.error(`polling failed (${String(failures)}): ${error instanceof Error ? error.message : String(error)}`)
        await new Promise(settle => setTimeout(settle, wait))
      }
    }
  }

  /** Route one update. */
  async #handle(update: InboundUpdate): Promise<void> {
    if (update.kind === 'callback') {
      if (!this.#allowed(update.callback.chatId, update.callback.fromId)) return
      await this.#onCallback(update.callback)
      return
    }
    const message = update.message
    if (message.isBot || !this.#allowed(message.chat.id, message.fromId)) return
    const command = parseCommand(message.text)
    if (command !== undefined) {
      await this.#command(message, command.name, command.args)
      return
    }
    await this.#prompt(message)
  }

  /** Allowlist: either list may admit; both empty refuses everything. */
  #allowed(chatId: number, userId: number | undefined): boolean {
    const { allowedChats, allowedUsers } = this.#config
    if (allowedChats.length === 0 && allowedUsers.length === 0) return false
    if (allowedChats.length > 0 && allowedChats.includes(chatId)) return true
    if (allowedUsers.length > 0 && userId !== undefined && allowedUsers.includes(userId)) return true
    return false
  }

  /** Conversation key for one message. */
  #keyOfMessage(message: TelegramMessage): ChatKey {
    return { chatId: message.chat.id, ...(message.threadId === undefined ? {} : { threadId: message.threadId }) }
  }

  /** Send one reply in the same conversation, degrading to plain text. */
  async #say(key: ChatKey, text: string): Promise<void> {
    const thread = key.threadId === undefined ? {} : { threadId: key.threadId }
    if (this.#config.parseMode === 'plain') {
      await this.#api.sendMessage(key.chatId, text, { disablePreview: true, ...thread }).catch(() => undefined)
      return
    }
    try {
      await this.#api.sendMessage(key.chatId, toMarkdownV2(text), { disablePreview: true, parseMode: 'MarkdownV2', ...thread })
    } catch {
      await this.#api.sendMessage(key.chatId, text, { disablePreview: true, ...thread }).catch(() => undefined)
    }
  }

  /** Run one command. */
  async #command(message: TelegramMessage, name: string, args: string): Promise<void> {
    const key = this.#keyOfMessage(message)
    switch (name) {
      case 'start':
      case 'help': {
        await this.#say(key, HELP)
        return
      }
      case 'cwd': {
        if (args === '') {
          await this.#say(key, await this.#describe(key))
          return
        }
        await this.#switchDirectory(key, args)
        return
      }
      case 'new': {
        await this.#newSession(key)
        return
      }
      case 'sessions': {
        await this.#listSessions(key)
        return
      }
      case 'switch': {
        await this.#switchSession(key, args)
        return
      }
      case 'status': {
        await this.#say(key, await this.#describe(key))
        return
      }
      case 'stop': {
        await this.#stopTurn(key)
        return
      }
      default: {
        await this.#say(key, `未知命令 /${name}\n\n${HELP}`)
      }
    }
  }

  /** One mounted session's Host summary. */
  async #summary(sessionId: string): Promise<SessionSummary | undefined> {
    const backend = await this.#ensureHost()
    const items = unwrap(await backend.ctx.remote.session.list({})).items
    return items.find(item => item.sessionId === sessionId)
  }

  /** Human-readable state of one conversation's mount. */
  async #describe(key: ChatKey): Promise<string> {
    const sessionId = this.#bindings.get(key) ?? await this.#default()
    if (sessionId === undefined) return '还没有挂载会话。发一条消息，我会在默认目录里建一个。'
    const summary = await this.#summary(sessionId).catch(() => undefined)
    const mount = this.#mounts.get(keyOf(key))
    const title = this.#titleOf(summary) ?? sessionId.slice(0, 8)
    return [
      `会话 ${title}`,
      `目录 ${summary?.cwd ?? '(未知)'}`,
      `状态 ${mount?.active === true ? '运行中' : '空闲'}`,
      `id   ${sessionId}`,
    ].join('\n')
  }

  /** Title projection of one session. */
  #titleOf(summary: SessionSummary | undefined): string | undefined {
    const projections = summary?.projections as { title?: unknown } | undefined
    return typeof projections?.title === 'string' ? projections.title : undefined
  }

  /** Switch the mount to the newest session under a directory. */
  async #switchDirectory(key: ChatKey, raw: string): Promise<void> {
    const path = resolve(expandHome(raw))
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || !info.isDirectory()) {
      await this.#say(key, `目录不存在：${path}`)
      return
    }
    const backend = await this.#ensureHost()
    const remote = backend.ctx.remote
    const workspaceId = unwrap(await remote.workspace.create({ path })).workspace.workspaceId
    const items = unwrap(await remote.session.list({})).items
      .filter(item => item.origin !== 'subagent' && item.cwd === path)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const existing = items[0]
    const sessionId = existing === undefined
      ? unwrap(await remote.session.create({ workspaceId: workspaceId as never })).sessionId
      : existing.sessionId
    await this.#mount(key, sessionId)
    await this.#say(key, existing === undefined
      ? `已在 ${path} 新建并挂载会话。`
      : `已挂载 ${path} 下最近的会话。`)
  }

  /** Create a session in the mounted (or default) directory. */
  async #newSession(key: ChatKey): Promise<void> {
    const backend = await this.#ensureHost()
    const remote = backend.ctx.remote
    const current = this.#bindings.get(key)
    const summary = current === undefined ? undefined : await this.#summary(current).catch(() => undefined)
    const path = summary?.cwd ?? this.#config.defaultCwd
    const workspaceId = unwrap(await remote.workspace.create({ path })).workspace.workspaceId
    const sessionId = unwrap(await remote.session.create({ workspaceId: workspaceId as never })).sessionId
    await this.#mount(key, sessionId)
    await this.#say(key, `已新建会话，目录 ${path}。`)
  }

  /** List recent sessions and remember their order for `/switch`. */
  async #listSessions(key: ChatKey): Promise<void> {
    const backend = await this.#ensureHost()
    const items = unwrap(await backend.ctx.remote.session.list({})).items
      .filter(item => item.origin !== 'subagent')
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 10)
    if (items.length === 0) {
      await this.#say(key, '还没有会话。发一条消息就会新建一个。')
      return
    }
    this.#recent.set(keyOf(key), items.map(item => item.sessionId))
    const current = this.#bindings.get(key)
    const lines = items.map((item, index) => {
      const title = this.#titleOf(item) ?? item.cwd?.split('/').pop() ?? '(未命名)'
      const marker = item.sessionId === current ? '*' : ' '
      return `${marker}${String(index + 1)}. ${title}${item.running ? ' · 运行中' : ''}`
    })
    await this.#say(key, ['最近会话：', ...lines, '', '用 /switch <n> 切换。'].join('\n'))
  }

  /** Switch to one of the sessions `/sessions` listed. */
  async #switchSession(key: ChatKey, args: string): Promise<void> {
    const index = Number.parseInt(args, 10)
    const recent = this.#recent.get(keyOf(key))
    if (recent === undefined) {
      await this.#say(key, '先发 /sessions 看看有哪些会话。')
      return
    }
    const sessionId = Number.isSafeInteger(index) ? recent[index - 1] : undefined
    if (sessionId === undefined) {
      await this.#say(key, `没有第 ${args} 个会话。`)
      return
    }
    await this.#mount(key, sessionId)
    await this.#say(key, `已切换。\n\n${await this.#describe(key)}`)
  }

  /** Cancel the running turn of the mounted session. */
  async #stopTurn(key: ChatKey): Promise<void> {
    const sessionId = this.#bindings.get(key)
    if (sessionId === undefined) {
      await this.#say(key, '还没有挂载会话。')
      return
    }
    const backend = await this.#ensureHost()
    unwrap(await backend.ctx.remote.session.cancel({ sessionId: sessionId as never }))
    await this.#say(key, '已请求停止。')
  }

  /** Prompt the mounted session, auto-mounting the default on first use. */
  async #prompt(message: TelegramMessage): Promise<void> {
    const key = this.#keyOfMessage(message)
    const text = message.text.trim()
    if (text === '') return
    let sessionId = this.#bindings.get(key)
    if (sessionId === undefined) {
      sessionId = await this.#default()
      if (sessionId === undefined) {
        await this.#say(key, '无法创建会话：Host 里没有可用的工作区。')
        return
      }
      await this.#mount(key, sessionId)
    }
    const backend = await this.#ensureHost()
    try {
      unwrap(await backend.ctx.remote.session.prompt({
        requestId: randomUUID() as never,
        sessionId: sessionId as never,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }))
    } catch (error) {
      await this.#drop(error instanceof Error ? error.message : String(error))
      await this.#say(key, 'Host 没有接受这次请求，已重新连接；请再发一次。')
    }
  }

  /** First-use mount: newest session in the default directory, else a new one. */
  async #default(): Promise<string | undefined> {
    if (this.#defaultSession !== undefined) return this.#defaultSession
    const backend = await this.#ensureHost()
    const remote = backend.ctx.remote
    const path = this.#config.defaultCwd
    const workspaceId = unwrap(await remote.workspace.create({ path })).workspace.workspaceId
    const items = unwrap(await remote.session.list({})).items
      .filter(item => item.origin !== 'subagent' && item.cwd === path)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const sessionId = items[0]?.sessionId
      ?? unwrap(await remote.session.create({ workspaceId: workspaceId as never })).sessionId
    this.#defaultSession = sessionId
    return sessionId
  }

  /** Mount one conversation and start following its session. */
  async #mount(key: ChatKey, sessionId: string): Promise<void> {
    const existing = this.#mounts.get(keyOf(key))
    existing?.abort.abort()
    existing?.reply?.dispose()
    this.#mounts.set(keyOf(key), {
      key,
      sessionId,
      tracker: new TurnTracker(),
      abort: new AbortController(),
      reply: undefined,
      active: false,
    })
    this.#bindings.set(key, sessionId)
    await this.#bindings.flush().catch(() => undefined)
    void this.#follow(this.#mounts.get(keyOf(key)) as Mount)
  }

  /** Follow one mount until it is replaced or the connection dies. */
  async #follow(mount: Mount): Promise<void> {
    let backend: HostBackend
    try {
      backend = await this.#ensureHost()
    } catch (error) {
      this.#log.error(`follow failed: ${String(error)}`)
      return
    }
    try {
      const stream = backend.ctx.remote.session.follow({
        address: { kind: 'session', sessionId: mount.sessionId as never },
        maxMessages: 60,
        assistantStream: true,
        activate: true,
      }, mount.abort.signal)
      for await (const frame of stream as AsyncIterable<SessionFollowFrame>) {
        if (mount.abort.signal.aborted) return
        await this.#onFrame(mount, frame)
      }
    } catch (error) {
      if (mount.abort.signal.aborted) return
      await this.#drop(error instanceof Error ? error.message : String(error))
    }
  }

  /** Build a reply stream for one conversation. */
  #replyFor(mount: Mount): ReplyStream {
    return new ReplyStream(this.#api, mount.key.chatId, {
      intervalMs: this.#config.streamIntervalMs,
      parseMode: this.#config.parseMode,
      ...(mount.key.threadId === undefined ? {} : { threadId: mount.key.threadId }),
    })
  }

  /** Project one follow frame onto the conversation. */
  async #onFrame(mount: Mount, frame: SessionFollowFrame): Promise<void> {
    const effect = mount.tracker.apply(frame)
    if (effect === undefined) return
    if (effect === 'begin') {
      mount.active = true
      mount.reply?.dispose()
      mount.reply = this.#replyFor(mount)
      await mount.reply.begin()
      return
    }
    if (effect === 'delta') {
      if (mount.reply === undefined) {
        mount.active = true
        mount.reply = this.#replyFor(mount)
        await mount.reply.begin()
      }
      const preview = mount.tracker.preview
      if (preview !== '') await mount.reply.push(preview)
      return
    }
    if (effect === 'end') {
      const reply = mount.reply
      mount.reply = undefined
      mount.active = false
      await reply?.finish(mount.tracker.text)
    }
  }

  /** Render one approval as buttons in every watching conversation. */
  async #onApproval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const running = [...this.#mounts.values()].filter(mount => mount.active)
    const watchers = running.length > 0 ? running : [...this.#mounts.values()]
    if (watchers.length === 0) return await next()

    this.#sequence += 1
    const key = `a${String(this.#sequence)}`
    const reason = typeof request.displayReason === 'string' ? request.displayReason : request.reason
    const summary = `🛡 需要批准 · ${request.toolName}${reason === undefined ? '' : `\n${reason}`}`
    const body = this.#config.parseMode === 'plain' ? summary : toMarkdownV2(summary)
    const cards: { chatId: number; messageId: number }[] = []
    const outcome = new Promise<Decision>((resolve) => {
      this.#pending.set(key, { key, cards, settled: false, resolve })
    })
    for (const mount of watchers) {
      try {
        const messageId = await this.#api.sendMessage(mount.key.chatId, body, {
          disablePreview: true,
          ...(this.#config.parseMode === 'plain' ? {} : { parseMode: 'MarkdownV2' as const }),
          ...(mount.key.threadId === undefined ? {} : { threadId: mount.key.threadId }),
          keyboard: [[
            { text: '允许这一次', callback_data: `approve:${key}` },
            { text: '拒绝', callback_data: `reject:${key}` },
          ]],
        })
        cards.push({ chatId: mount.key.chatId, messageId })
      } catch (error) {
        this.#log.error(`approval card failed: ${String(error)}`)
      }
    }
    const pending = this.#pending.get(key)
    if (pending === undefined || cards.length === 0) {
      this.#pending.delete(key)
      return await next()
    }
    const removeAbort = whenAborted(request.signal, () => { this.#settle(key, 'cancelled', '') })
    try {
      return await outcome
    } finally {
      removeAbort()
      this.#pending.delete(key)
    }
  }

  /** Settle one pending approval and rewrite its cards. */
  #settle(key: string, decision: Decision, by: string): void {
    const pending = this.#pending.get(key)
    if (pending === undefined || pending.settled) return
    pending.settled = true
    this.#pending.delete(key)
    pending.resolve(decision)
    void this.#closeCards(pending.cards, decision, by)
  }

  /** Replace every card of one approval with its outcome and drop the buttons. */
  async #closeCards(cards: readonly { chatId: number; messageId: number }[], decision: Decision, by: string): Promise<void> {
    const text = decision === 'allowed-once'
      ? `✅ 已允许${by === '' ? '' : `（${by}）`}`
      : decision === 'rejected'
        ? `⛔ 已拒绝${by === '' ? '' : `（${by}）`}`
        : '☑️ 已在其他端处理'
    const body = this.#config.parseMode === 'plain' ? text : toMarkdownV2(text)
    for (const card of cards) {
      await this.#api.editMessageText(card.chatId, card.messageId, body, {
        ...(this.#config.parseMode === 'plain' ? {} : { parseMode: 'MarkdownV2' as const }),
        keyboard: [],
      }).catch(() => undefined)
    }
  }

  /** Announce a question so the phone is not left wondering why the turn stalled. */
  async #onQuestion(request: QuestionRequest, next: () => Promise<unknown>): Promise<unknown> {
    const lines = request.questions.map(question => `❓ ${question.question}`)
    for (const mount of this.#mounts.values()) {
      await this.#say(mount.key, [...lines, '', '请在这台机器的 TUI 或 Desktop 上回答。'].join('\n'))
    }
    return await next()
  }

  /** Handle one button press. */
  async #onCallback(callback: { id: string; chatId: number; messageId: number; data: string }): Promise<void> {
    const separator = callback.data.indexOf(':')
    const action = separator === -1 ? callback.data : callback.data.slice(0, separator)
    const key = separator === -1 ? '' : callback.data.slice(separator + 1)
    const pending = this.#pending.get(key)
    if (pending === undefined || pending.settled) {
      await this.#api.answerCallbackQuery(callback.id, '这条审批已经处理过了').catch(() => undefined)
      await this.#api.editMessageText(callback.chatId, callback.messageId, '☑️ 已处理', { keyboard: [] }).catch(() => undefined)
      return
    }
    await this.#api.answerCallbackQuery(callback.id).catch(() => undefined)
    this.#settle(key, action === 'approve' ? 'allowed-once' : 'rejected', '手机')
  }
}
