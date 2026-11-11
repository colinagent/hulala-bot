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
import { expandHome, type BridgeConfig } from './config.ts'
import type { HostBackend } from './host/backend.ts'
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
  readonly questions: readonly {
    readonly question: string
    readonly header?: string
    readonly options?: readonly { readonly label: string; readonly description?: string }[]
  }[]
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
  /** Working directory, cached so the pinned status costs no RPC. */
  path: string | undefined
  /** Session title, cached for the same reason. */
  title: string | undefined
}

/** One approval waiting for a button press. */
interface Pending {
  readonly key: string
  readonly cards: { chatId: number; messageId: number }[]
  settled: boolean
  readonly resolve: (decision: Decision) => void
}

/** Terminal abstraction over Host RPC results. */
/** Envelope every Remote call returns; only these fields matter here. */
type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message?: string; readonly code?: string } }

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
  readonly #cwdChoices = new Map<string, readonly string[]>()
  readonly #stopped = new AbortController()
  #backend: HostBackend | undefined
  #connecting: Promise<HostBackend> | undefined
  #sequence = 0
  #defaultSession: string | undefined

  /** @param options - configuration and collaborators. */
  constructor(options: BridgeOptions) {
    this.#config = options.config
    this.#api = options.api
    this.#ledger = options.ledger
    this.#bindings = options.bindings
    this.#log = options.log
    this.#connect = options.connect ?? (async () => {
      throw new Error('no Host backend: the bridge runs as a Host plugin, not as a separate process')
    })
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
    // Two callers racing here would open two connections, register two sets of
    // waterfalls and leak one of them.
    this.#connecting ??= this.#connect()
    let backend: HostBackend
    try {
      backend = await this.#connecting
    } finally {
      this.#connecting = undefined
    }
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
    const backend = this.#backend
    if (backend === undefined) return
    this.#log.error(`host connection lost: ${reason}`)
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
          this.#log.info(`update ${String(update.updateId)} ${this.#describeUpdate(update)}`)
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
    const send = async (body: string, parseMode?: 'MarkdownV2'): Promise<void> => {
      await this.#api.sendMessage(key.chatId, body, {
        disablePreview: true,
        ...(parseMode === undefined ? {} : { parseMode }),
        ...thread,
      })
    }
    try {
      if (this.#config.parseMode === 'plain') {
        await send(text)
        return
      }
      try {
        await send(toMarkdownV2(text), 'MarkdownV2')
      } catch (error) {
        this.#log.error(`markdown reply rejected, retrying plain: ${error instanceof Error ? error.message : String(error)}`)
        await send(text)
      }
    } catch (error) {
      this.#log.error(`reply to chat ${String(key.chatId)} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Loggable summary of one update. */
  #describeUpdate(update: InboundUpdate): string {
    if (update.kind === 'callback') return `callback chat=${String(update.callback.chatId)} data=${update.callback.data}`
    const message = update.message
    const command = parseCommand(message.text)
    const kind = command === undefined ? `prompt len=${String(message.text.length)}` : `command /${command.name}${command.args === '' ? '' : ' args'}`
    return `message chat=${String(message.chat.id)} from=${String(message.fromId ?? 0)} ${kind}`
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
          await this.#offerDirectories(key)
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
    const items = unwrap(await backend.ctx.remote.session.list({})) as { items: SessionSummary[] }
    return items.items.find(item => item.sessionId === sessionId)
  }

  /** Human-readable state of one conversation's mount. */
  async #describe(key: ChatKey): Promise<string> {
    const sessionId = this.#bindings.get(key)
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

  /** Recently used working directories, newest first. */
  async #recentDirectories(): Promise<readonly string[]> {
    const backend = await this.#ensureHost()
    const listed = unwrap(await backend.ctx.remote.session.list({})) as { items: SessionSummary[] }
    const items = listed.items
      .filter(item => item.origin !== 'subagent' && typeof item.cwd === 'string')
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const seen = new Set<string>()
    const paths: string[] = []
    for (const item of items) {
      const path = item.cwd as string
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
      if (paths.length === 8) break
    }
    return paths
  }

  /** Send the current mount plus one button per recent directory. */
  async #offerDirectories(key: ChatKey): Promise<void> {
    const currentId = this.#bindings.get(key)
    const current = currentId === undefined ? undefined : await this.#summary(currentId).catch(() => undefined)
    const currentPath = current?.cwd
    let paths: readonly string[]
    try {
      paths = await this.#recentDirectories()
    } catch (error) {
      await this.#say(key, `读不到目录列表：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (paths.length === 0) {
      await this.#say(key, '还没有用过任何目录。发 /cwd <path> 指定一个。')
      return
    }
    this.#cwdChoices.set(keyOf(key), paths)
    const header = currentPath === undefined ? '当前还没有挂载会话。' : `当前目录：${currentPath}`
    const keyboard = paths.map((path, index) => [{
      text: `${path === currentPath ? '✓ ' : ''}${this.#shortPath(path)}`,
      callback_data: `cwd:${String(index)}`,
    }])
    const body = `${header}\n\n选择要挂载的目录：`
    const thread = key.threadId === undefined ? {} : { threadId: key.threadId }
    const send = async (text: string, parseMode?: 'MarkdownV2'): Promise<void> => {
      await this.#api.sendMessage(key.chatId, text, {
        disablePreview: true,
        keyboard,
        ...(parseMode === undefined ? {} : { parseMode }),
        ...thread,
      })
    }
    try {
      if (this.#config.parseMode === 'plain') {
        await send(body)
        return
      }
      try {
        await send(toMarkdownV2(body), 'MarkdownV2')
      } catch {
        await send(body)
      }
    } catch (error) {
      this.#log.error(`cwd picker failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Last two path components, which is what distinguishes directories. */
  #shortPath(path: string): string {
    const parts = path.split('/').filter(part => part !== '')
    if (parts.length <= 2) return path
    return `…/${parts.slice(-2).join('/')}`
  }

  /** Rewrite the pinned status message for one conversation. */
  async #syncStatus(key: ChatKey): Promise<void> {
    const mount = this.#mounts.get(keyOf(key))
    const sessionId = this.#bindings.get(key)
    if (sessionId === undefined) return
    const path = mount?.path ?? '(未知目录)'
    const title = mount?.title ?? sessionId.slice(0, 8)
    const text = `📍 ${path}\n${title} · ${mount?.active === true ? '运行中' : '空闲'}`
    const thread = key.threadId === undefined ? {} : { threadId: key.threadId }
    const body = this.#config.parseMode === 'plain' ? text : toMarkdownV2(text)
    const format = this.#config.parseMode === 'plain' ? {} : { parseMode: 'MarkdownV2' as const }
    const existing = this.#bindings.statusMessageId(key)
    if (existing !== undefined) {
      try {
        await this.#api.editMessageText(key.chatId, existing, body, { disablePreview: true, ...format })
        return
      } catch (error) {
        // "not modified" means the pin is already right; anything else that is
        // not a missing message is worth a log, not a second pinned message.
        const description = error instanceof Error ? error.message : String(error)
        if (description.includes('not modified')) return
        if (!/not found|MESSAGE_ID_INVALID/i.test(description)) {
          this.#log.error(`status edit failed: ${description}`)
          return
        }
      }
    }
    try {
      const messageId = await this.#api.sendMessage(key.chatId, body, { disablePreview: true, ...format, ...thread })
      const previous = existing
      this.#bindings.setStatusMessageId(key, messageId)
      await this.#bindings.flush().catch(() => undefined)
      if (previous !== undefined) await this.#api.unpinChatMessage(key.chatId, previous).catch(() => undefined)
      await this.#api.pinChatMessage(key.chatId, messageId).catch(error => {
        this.#log.error(`pin failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    } catch (error) {
      this.#log.error(`status message failed: ${error instanceof Error ? error.message : String(error)}`)
    }
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
    const workspaceId = (unwrap(await remote.workspace.create({ path })) as { workspace: { workspaceId: string } }).workspace.workspaceId
    const listed = unwrap(await remote.session.list({})) as { items: SessionSummary[] }
    const items = listed.items
      .filter(item => item.origin !== 'subagent' && item.cwd === path)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const existing = items[0]
    const sessionId = existing === undefined
      ? (unwrap(await remote.session.create({ workspaceId: workspaceId as never })) as { sessionId: string }).sessionId
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
    const workspaceId = (unwrap(await remote.workspace.create({ path })) as { workspace: { workspaceId: string } }).workspace.workspaceId
    const sessionId = (unwrap(await remote.session.create({ workspaceId: workspaceId as never })) as { sessionId: string }).sessionId
    await this.#mount(key, sessionId)
    await this.#say(key, `已新建会话，目录 ${path}。`)
  }

  /** List recent sessions and remember their order for `/switch`. */
  async #listSessions(key: ChatKey): Promise<void> {
    const backend = await this.#ensureHost()
    const listed = unwrap(await backend.ctx.remote.session.list({})) as { items: SessionSummary[] }
    const items = listed.items
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
    const workspaceId = (unwrap(await remote.workspace.create({ path })) as { workspace: { workspaceId: string } }).workspace.workspaceId
    const listed = unwrap(await remote.session.list({})) as { items: SessionSummary[] }
    const items = listed.items
      .filter(item => item.origin !== 'subagent' && item.cwd === path)
      .sort((left, right) => right.updatedAt - left.updatedAt)
    const sessionId = items[0]?.sessionId
      ?? (unwrap(await remote.session.create({ workspaceId: workspaceId as never })) as { sessionId: string }).sessionId
    this.#defaultSession = sessionId
    return sessionId
  }

  /** Mount one conversation and start following its session. */
  async #mount(key: ChatKey, sessionId: string, known: { path?: string; title?: string } = {}): Promise<void> {
    const existing = this.#mounts.get(keyOf(key))
    existing?.abort.abort()
    existing?.reply?.dispose()
    let path = known.path
    let title = known.title
    if (path === undefined || title === undefined) {
      const summary = await this.#summary(sessionId).catch(() => undefined)
      path ??= summary?.cwd
      title ??= this.#titleOf(summary)
    }
    this.#mounts.set(keyOf(key), {
      key,
      sessionId,
      tracker: new TurnTracker(),
      abort: new AbortController(),
      reply: undefined,
      active: false,
      path,
      title,
    })
    this.#bindings.set(key, sessionId)
    await this.#bindings.flush().catch(() => undefined)
    void this.#follow(this.#mounts.get(keyOf(key)) as Mount)
    void this.#syncStatus(key)
  }

  /** Follow one mount, re-opening the stream when the Host closes it. */
  async #follow(mount: Mount): Promise<void> {
    let backend: HostBackend
    try {
      backend = await this.#ensureHost()
    } catch (error) {
      this.#log.error(`follow failed: ${String(error)}`)
      return
    }
    for (let attempt = 1; ; attempt += 1) {
      if (mount.abort.signal.aborted) return
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
        this.#log.error(`follow ended without an abort; reopening (attempt ${String(attempt)})`)
      } catch (error) {
        if (mount.abort.signal.aborted) return
        this.#log.error(`follow failed (attempt ${String(attempt)}): ${error instanceof Error ? error.message : String(error)}`)
      }
      if (attempt >= 3) {
        // Three failures in a row is a connection problem, not a session one.
        await this.#drop(`follow for ${mount.sessionId} gave up`)
        return
      }
      await new Promise(settle => setTimeout(settle, 1000 * attempt))
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
      void this.#syncStatus(mount.key)
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
      void this.#syncStatus(mount.key)
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
    const lines = request.questions.map(question => {
      const head = `❓ ${question.question}`
      const options = question.options ?? []
      if (options.length === 0) return head
      return [head, ...options.map(option => `  · ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`)].join('\n')
    })
    for (const mount of this.#mounts.values()) {
      await this.#say(mount.key, [...lines, '', '请在这台机器的 TUI 或 Desktop 上回答。'].join('\n'))
    }
    return await next()
  }

  /** Handle one button press. */
  async #onCallback(callback: { id: string; chatId: number; messageId: number; data: string; threadId?: number | undefined }): Promise<void> {
    if (callback.data.startsWith('cwd:')) {
      await this.#onDirectoryChoice(callback)
      return
    }
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

  /** Handle one directory button. */
  async #onDirectoryChoice(callback: { id: string; chatId: number; messageId: number; data: string; threadId?: number | undefined }): Promise<void> {
    const key: ChatKey = {
      chatId: callback.chatId,
      ...(callback.threadId === undefined ? {} : { threadId: callback.threadId }),
    }
    const choices = this.#cwdChoices.get(keyOf(key))
    const index = Number.parseInt(callback.data.slice('cwd:'.length), 10)
    const path = choices === undefined ? undefined : choices[index]
    if (path === undefined) {
      await this.#api.answerCallbackQuery(callback.id, '这个列表已过期，重新发 /cwd').catch(() => undefined)
      return
    }
    await this.#api.answerCallbackQuery(callback.id).catch(() => undefined)
    await this.#switchDirectory(key, path)
    await this.#api.editMessageText(callback.chatId, callback.messageId, `📍 ${path}`, { keyboard: [] }).catch(() => undefined)
  }
}
