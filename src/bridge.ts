/**
 * The bot: one Host, several chat surfaces.
 *
 * Inbound messages either change which session a conversation is mounted to or
 * become a prompt on the mounted session, and every turn in that session
 * streams back into the conversation it came from. Approvals are rendered as
 * buttons on every surface that is watching the session; answering one settles
 * the Host request, and the other copies are withdrawn.
 *
 * Nothing here knows what Telegram or Lark is: transports, id shapes, markup
 * and callback plumbing are the channel's problem ({@link Channel}).
 *
 * @module hulala-bot/bridge
 */
import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { SessionFollowFrame, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type { Button, Channel, ChatKey, InboundCallback, InboundEvent, InboundMessage, Keyboard } from './channel.ts'
import { expandHome, type BridgeConfig } from './config.ts'
import type { HostBackend, QuestionAnswerBatch, QuestionAnswerItem } from './host/backend.ts'
import { TurnTracker } from './host/turn.ts'
import { Log } from './log.ts'
import { mediaTypeOf, takeImageLinks, type ImageLink } from './render/images.ts'
import { project, ReplyStream } from './reply.ts'
import { COMMANDS, HELP, parseCommand } from './router.ts'
import { keyOf, type Bindings } from './store/bindings.ts'
import { AUTO_TASK_SEED, formatTasks } from './tasks.ts'

/** Approval outcomes the Host accepts. */
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** What a button press can decide. `full-access` also widens the Session. */
type Decision = 'allowed-once' | 'rejected' | 'cancelled' | 'full-access'

/** The Host's live Agent facts; in-process, so its Session id is exact. */
interface AgentFacts {
  readonly session?: {
    readonly id?: string
  }
}

/** Waterfall request as delivered to a bot. */
interface ApprovalRequest {
  readonly toolName: string
  readonly callId?: unknown
  readonly reason?: string
  readonly displayReason?: unknown
  readonly signal?: AbortSignal
  readonly agent?: AgentFacts
}

/** One caller-authored sentence: `en` plus whatever locales the caller wrote. */
interface LocalizedText {
  readonly en: string
  readonly [locale: string]: string
}

/**
 * A caller-declared presentation intent (DSH `AskUserQuestionIntent`).
 *
 * It changes how the card reads, never how it is answered: the Harness answer
 * encoding is identical. `approval` is a Computer-Use agent asking for a
 * permission, so the subject and the caller's own wording carry the meaning.
 */
interface QuestionIntent {
  readonly kind: 'plan-review' | 'approval'
  readonly approve: string
  readonly reject?: string
  readonly always?: string
  readonly subject?: { readonly name: string }
  readonly display?: {
    readonly question?: LocalizedText
    readonly detail?: LocalizedText
    readonly approve?: LocalizedText
  }
}

/** One question item as the Host delivers it. */
interface QuestionItem {
  readonly id?: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly multiSelect?: boolean
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly intent?: QuestionIntent
}

/** Question request as delivered to a bot; the bot announces it and hands it on. */
interface QuestionRequest {
  readonly questions: readonly QuestionItem[]
  readonly signal?: AbortSignal
  readonly wait?: {
    readonly callId: string
    readonly timed?: boolean
  }
  readonly agent?: AgentFacts
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
  readonly cards: { chat: ChatKey; messageId: string }[]
  settled: boolean
  readonly resolve: (decision: Decision) => void
}

/** Rejection codes DSH's wire preserves across the answerer waterfall. */
type QuestionRejectionCode = 'ASK_ABORTED' | 'ASK_CANCELLED' | 'ASK_TIMED_OUT'

/** One question's draft while a card is being answered. */
interface QuestionDraft {
  selected: string[]
  custom?: string | undefined
}

/** One live Host waterfall a card can settle, reject, or hand to the next answerer. */
interface QuestionWaterfall {
  readonly result: Promise<QuestionAnswerBatch>
  resolve(answer: QuestionAnswerBatch): void
  reject(code: QuestionRejectionCode): void
  delegate(): void
  isDelegation(reason: unknown): boolean
}

/** One row of the `userQuestions` Session projection. */
interface ProjectedQuestion {
  readonly callId: string
  readonly questions: readonly QuestionItem[]
  readonly state: 'open' | 'continued'
}

/**
 * One answerable card, shared by the forwarded waterfall and the Session
 * projection. `key` is DSH's own `question:<sessionId>:<callId>` identity;
 * `token` is the short id the chat buttons carry. A card outlives its seat:
 * hiding it withdraws the buttons, the projection decides when it is gone.
 */
interface QuestionCard {
  readonly key: string
  readonly token: string
  readonly sessionId: string
  readonly callId: string | undefined
  readonly questions: readonly QuestionItem[]
  readonly chats: readonly ChatKey[]
  readonly messages: { chat: ChatKey; messageId: string }[]
  readonly drafts: QuestionDraft[]
  index: number
  state: 'open' | 'continued'
  answerable: boolean
  hidden: boolean
  settled: boolean
  status: string
  deadline?: number | undefined
  timer?: ReturnType<typeof setTimeout> | undefined
  ticker?: ReturnType<typeof setInterval> | undefined
  claim?: AbortController | undefined
  waterfall?: QuestionWaterfall | undefined
  awaitingCustom?: { chat: ChatKey; question: number } | undefined
}

/** Largest file the bot attaches as an image. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

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

/** Keep a countdown timer from holding the process open after a test or shutdown. */
function unref(timer: ReturnType<typeof setTimeout>): void {
  (timer as unknown as { unref?: () => void }).unref?.()
}

/** True for a plain object, the only shape a projection value may be read from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The one sentence a caller wrote in a locale this bot can show.
 *
 * The bot speaks Chinese, so `zh` wins and English is the fallback a caller
 * that wrote no Chinese gets; a locale key is never shown to a user.
 * @param text - the caller's localized text, if it wrote one.
 * @returns the sentence to render, or undefined when there is none.
 */
function localized(text: LocalizedText | undefined): string | undefined {
  if (text === undefined) return undefined
  return text.zh ?? text['zh-CN'] ?? text.en
}

/** A question id is part of the answer encoding; a caller that omitted one gets a stable local id. */
function questionId(question: QuestionItem, index: number): string {
  return typeof question.id === 'string' && question.id !== '' ? question.id : `q${String(index)}`
}

/** A wire-preserved user-question rejection, the same shape DSH's clients throw. */
function questionError(code: QuestionRejectionCode): Error {
  const messages: Record<QuestionRejectionCode, string> = {
    ASK_ABORTED: 'ask_user_question was aborted before the user answered',
    ASK_CANCELLED: 'the user cancelled ask_user_question',
    ASK_TIMED_OUT: 'ask_user_question timed out before the user answered',
  }
  const error = new Error(messages[code]) as Error & { code: string }
  error.name = 'UserQuestionError'
  error.code = code
  return error
}

/** One deferred waterfall request, settled through a card instead of `next()`. */
function createWaterfall(signal: AbortSignal | undefined): QuestionWaterfall {
  let resolveResult: ((answer: QuestionAnswerBatch) => void) | undefined
  let rejectResult: ((reason: unknown) => void) | undefined
  const result = new Promise<QuestionAnswerBatch>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const delegated = Symbol('question delegated')
  let settled = false
  const onAbort = (): void => { finish(() => { rejectResult?.(questionError('ASK_ABORTED')) }) }
  const finish = (settle: () => void): void => {
    if (settled) return
    settled = true
    signal?.removeEventListener('abort', onAbort)
    settle()
  }
  const channel: QuestionWaterfall = {
    result,
    resolve: answer => { finish(() => { resolveResult?.(answer) }) },
    reject: code => { finish(() => { rejectResult?.(questionError(code)) }) },
    delegate: () => { finish(() => { rejectResult?.(delegated) }) },
    isDelegation: reason => reason === delegated,
  }
  if (signal !== undefined) {
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  }
  return channel
}

/**
 * Read the `userQuestions` projection view. Only well-formed rows with at
 * least one question are answerable, so a malformed wire value is ignored
 * instead of producing a card nobody can submit.
 */
function projectedQuestions(value: unknown): readonly ProjectedQuestion[] {
  if (!isRecord(value) || !Array.isArray(value.active)) return []
  return value.active.flatMap((row: unknown): ProjectedQuestion[] => {
    if (!isRecord(row) || typeof row.callId !== 'string' || !Array.isArray(row.questions)) return []
    const questions = questionItems(row.questions)
    if (questions.length === 0) return []
    return [{
      callId: row.callId,
      questions,
      state: row.state === 'continued' ? 'continued' : 'open',
    }]
  })
}

/** One caller-authored localized sentence: `en` is the required fallback. */
function localizedText(value: unknown): LocalizedText | undefined {
  if (!isRecord(value) || typeof value.en !== 'string') return undefined
  const locales: Record<string, string> = { en: value.en }
  for (const [key, entry] of Object.entries(value)) {
    if (key !== 'en' && typeof entry === 'string') locales[key] = entry
  }
  // `en` was checked above; the index signature covers the other locales.
  return locales as LocalizedText
}

/** Narrow a caller-declared intent; unknown fields are caller-owned protocol. */
function questionIntent(value: unknown): QuestionIntent | undefined {
  // `AskUserQuestionIntent` requires `approve` for both kinds and `reject` for
  // `approval`. A row that omits them is malformed; rendering it as an
  // approval card would show actions that cannot be submitted.
  if (!isRecord(value) || (value.kind !== 'plan-review' && value.kind !== 'approval')) return undefined
  if (typeof value.approve !== 'string' || value.approve === '') return undefined
  if (value.kind === 'approval' && typeof value.reject !== 'string') return undefined
  const display = isRecord(value.display) ? value.display : undefined
  const displayCopy: { question?: LocalizedText; detail?: LocalizedText; approve?: LocalizedText } = {}
  if (display !== undefined) {
    for (const key of ['question', 'detail', 'approve'] as const) {
      const text = localizedText(display[key])
      if (text !== undefined) displayCopy[key] = text
    }
  }
  const subject = isRecord(value.subject) && typeof value.subject.name === 'string'
    ? { name: value.subject.name }
    : undefined
  return {
    kind: value.kind,
    approve: value.approve,
    ...(typeof value.reject === 'string' ? { reject: value.reject } : {}),
    ...(typeof value.always === 'string' ? { always: value.always } : {}),
    ...(subject === undefined ? {} : { subject }),
    ...(Object.keys(displayCopy).length === 0 ? {} : { display: displayCopy }),
  }
}

/** Read one projection row's question batch, dropping fields of the wrong type. */
function questionItems(value: readonly unknown[]): QuestionItem[] {
  return value.flatMap((raw: unknown): QuestionItem[] => {
    if (!isRecord(raw) || typeof raw.question !== 'string') return []
    const options = Array.isArray(raw.options)
      ? raw.options.flatMap((option: unknown) => {
        if (!isRecord(option) || typeof option.label !== 'string') return []
        return [{ label: option.label, ...(typeof option.description === 'string' ? { description: option.description } : {}) }]
      })
      : undefined
    const intent = questionIntent(raw.intent)
    return [{
      ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
      question: raw.question,
      ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
      ...(typeof raw.header === 'string' ? { header: raw.header } : {}),
      ...(options === undefined ? {} : { options }),
      ...(raw.multiSelect === true ? { multiSelect: true } : {}),
      ...(intent === undefined ? {} : { intent }),
    }]
  })
}

/** Call ids whose `user-question-reply` is already queued in the inbox projection. */
function queuedReplies(value: unknown): readonly string[] {
  if (!isRecord(value)) return []
  const calls: string[] = []
  for (const list of [value['next-step'], value['next-turn']]) {
    if (!Array.isArray(list)) continue
    for (const message of list) {
      if (!isRecord(message) || !isRecord(message.source)) continue
      const source = message.source
      if (source.kind === 'user-question-reply' && typeof source.callId === 'string') calls.push(source.callId)
    }
  }
  return calls
}

/**
 * One question card's body, including the draft so a button press is visible
 * on the message itself and not only in the next keyboard.
 *
 * A caller-declared `approval` intent is a Computer-Use permission request, so
 * it reads as one: who is asking, what they ask in their own words, and the
 * three actions the caller named. Every other question is the generic list.
 */
function questionBody(card: QuestionCard): string {
  return card.questions.map((question, index) => {
    const draft = card.drafts[index]
    const chosen = (label: string): string => draft?.selected.includes(label) === true ? '✓' : '·'
    if (question.intent?.kind === 'approval') {
      const intent = question.intent
      const approveText = localized(intent.display?.approve)
      const action = (mark: string, label: string | undefined, shown = label): string[] =>
        label === undefined || label === '' ? [] : [`  ${chosen(label)} ${mark} ${shown}`]
      return [
        `🛡 需要授权${intent.subject === undefined ? '' : ` · ${intent.subject.name}`}`,
        localized(intent.display?.question) ?? question.question,
        localized(intent.display?.detail) ?? question.detail ?? '',
        ...action('✓', intent.approve, approveText ?? intent.approve),
        ...action('✕', intent.reject),
        ...action('∞', intent.always),
      ].filter(line => line !== '').join('\n')
    }
    const head = `❓ ${question.header === undefined ? '' : `[${question.header}] `}${question.question}`
    const detail = question.detail === undefined || question.detail === '' ? [] : [question.detail]
    const options = (question.options ?? []).map(option =>
      `  ${chosen(option.label)} ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`)
    const multi = question.multiSelect === true ? ['  （可多选）'] : []
    const typed = draft?.custom === undefined ? [] : [`  ✎ ${draft.custom}`]
    return [head, ...detail, ...options, ...typed, ...multi].join('\n')
  }).join('\n\n')
}

/** The whole message a card shows: body plus the one line that says what it is doing. */
function questionText(card: QuestionCard): string {
  const notes: string[] = []
  if (card.questions.length > 1) notes.push(`第 ${String(card.index + 1)}/${String(card.questions.length)} 题`)
  if (card.deadline !== undefined) {
    notes.push(`⏳ 还剩 ${String(Math.max(0, Math.ceil((card.deadline - Date.now()) / 1000)))} 秒`)
  }
  if (card.state === 'continued') notes.push('窗口已关闭，补答会在下一轮进入 agent')
  if (card.awaitingCustom !== undefined) notes.push('请直接发一段文字作为自定义答案，或按「取消自定义」')
  if (card.status !== '') notes.push(card.status)
  return notes.length === 0 ? questionBody(card) : `${questionBody(card)}\n\n${notes.join(' · ')}`
}

/** Build the complete answer batch, or say which questions are still unanswered. */
function batchOf(card: QuestionCard): QuestionAnswerBatch | undefined {
  const answers: QuestionAnswerItem[] = []
  for (const [index, question] of card.questions.entries()) {
    const draft = card.drafts[index]
    if (draft === undefined || (draft.selected.length === 0 && draft.custom === undefined)) return undefined
    answers.push({
      id: questionId(question, index),
      selected: [...draft.selected],
      ...(draft.custom === undefined ? {} : { custom: draft.custom }),
    })
  }
  return { answers }
}

/**
 * Translate DSH's question flow into the buttons a chat surface can carry.
 *
 * One press picks an option; multi-select toggles. A batch with several
 * questions moves between them with the navigation row, and `自定义` is the
 * chat-surface stand-in for the Web composer's free-text input: the next
 * message in that conversation becomes the answer. An `approval` intent has
 * three fixed actions and one press decides, because it has no free text.
 */
function questionKeyboard(card: QuestionCard): Keyboard {
  if (card.settled || card.hidden || (card.waterfall === undefined && !card.answerable)) return []
  const question = card.questions[card.index]
  if (question === undefined) return []
  const token = card.token
  const draft = card.drafts[card.index]
  const rows: Button[][] = []
  for (const [index, option] of (question.options ?? []).entries()) {
    const picked = draft?.selected.includes(option.label) === true
    const mark = question.intent?.kind === 'approval'
      ? option.label === question.intent.approve ? '✓ '
        : option.label === question.intent.reject ? '✕ '
          : option.label === question.intent.always ? '∞ ' : ''
      : ''
    rows.push([{ text: `${picked ? '● ' : ''}${mark}${option.label}`, data: `qopt:${token}:${String(card.index)}:${String(index)}` }])
  }
  if (question.intent?.kind === 'approval') {
    rows.push([{ text: '交给他端', data: `delegate:${token}` }])
    return rows
  }
  const customRow: Button[] = [{
    text: draft?.custom === undefined ? '✎ 自定义答案' : '✎ 修改自定义答案',
    data: `qcustom:${token}:${String(card.index)}`,
  }]
  if (card.awaitingCustom !== undefined) customRow.push({ text: '取消自定义', data: `qcancel:${token}` })
  rows.push(customRow)
  if (card.questions.length > 1) {
    const previous = (card.index - 1 + card.questions.length) % card.questions.length
    const next = (card.index + 1) % card.questions.length
    rows.push([
      { text: '← 上一题', data: `qnav:${token}:${String(previous)}` },
      { text: '下一题 →', data: `qnav:${token}:${String(next)}` },
    ])
  }
  rows.push([
    { text: '✓ 提交', data: `qsubmit:${token}` },
    { text: '交给他端', data: `delegate:${token}` },
  ])
  return rows
}

/** Injectable host attach, so tests can supply a fake Host. */
export type HostConnect = () => Promise<HostBackend>

/** Everything the bot needs. */
export interface BridgeOptions {
  readonly config: BridgeConfig
  readonly channels: readonly Channel[]
  readonly bindings: Bindings
  readonly log: Log
  readonly connect?: HostConnect
}

/** The bot itself. */
export class Bridge {
  readonly #config: BridgeConfig
  readonly #channels: Map<string, Channel>
  readonly #bindings: Bindings
  readonly #log: Log
  readonly #connect: HostConnect
  readonly #mounts = new Map<string, Mount>()
  readonly #pending = new Map<string, Pending>()
  /** Cards keyed by their short chat token; one card per `(sessionId, callId)`. */
  readonly #cards = new Map<string, QuestionCard>()
  /** Last `userQuestions` / `inbox` projection values seen per Session. */
  readonly #projections = new Map<string, { questions: readonly ProjectedQuestion[] | undefined; queued: ReadonlySet<string> }>()
  readonly #recent = new Map<string, readonly string[]>()
  readonly #cwdChoices = new Map<string, readonly string[]>()
  readonly #stopped = new AbortController()
  #controlAbort: AbortController | undefined
  #backend: HostBackend | undefined
  #connecting: Promise<HostBackend> | undefined
  #sequence = 0

  /** @param options - configuration and collaborators. */
  constructor(options: BridgeOptions) {
    this.#config = options.config
    this.#channels = new Map(options.channels.map(channel => [channel.name, channel]))
    this.#bindings = options.bindings
    this.#log = options.log
    this.#connect = options.connect ?? (async () => {
      throw new Error('no Host backend: the bot runs as a Host plugin, not as a separate process')
    })
  }

  /** Connect, then run every configured channel until {@link stop}. */
  async start(): Promise<void> {
    // A Host that is down must not stop the bot: the first message retries.
    await this.#ensureHost().catch(error => {
      this.#log.error(`Host is not reachable yet: ${error instanceof Error ? error.message : String(error)}`)
    })
    const signal = this.#stopped.signal
    await Promise.all([...this.#channels.values()].map(async channel => {
      try {
        await channel.start(event => this.#dispatch(event), signal)
      } catch (error) {
        this.#log.error(`${channel.name} stopped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))
  }

  /** Stop every channel, abort follows, and close the Host connection. */
  async stop(): Promise<void> {
    this.#stopped.abort()
    this.#controlAbort?.abort()
    this.#controlAbort = undefined
    for (const mount of this.#mounts.values()) {
      mount.abort.abort()
      mount.reply?.dispose()
    }
    this.#mounts.clear()
    // A live waterfall that is never handed back would leave the Host waiting
    // for an answer from a client that has already gone away.
    this.#disposeQuestions('⌛️ 机器人已停止')
    await this.#bindings.flush().catch(() => undefined)
    const backend = this.#backend
    this.#backend = undefined
    await backend?.close().catch(() => undefined)
  }

  /** The channel that owns one conversation. */
  #channel(chat: ChatKey): Channel {
    const channel = this.#channels.get(chat.channel)
    if (channel === undefined) throw new Error(`channel ${chat.channel} is not running`)
    return channel
  }

  /** Route one allowlisted event. */
  async #dispatch(event: InboundEvent): Promise<void> {
    if (event.kind === 'callback') {
      await this.#onCallback(event)
      return
    }
    if (event.fromBot) return
    const command = parseCommand(event.text)
    if (command !== undefined) {
      await this.#command(event, command.name, command.args)
      return
    }
    // `自定义` has no inline text input on a chat surface: the next message in
    // that conversation is the answer, never a prompt for the agent.
    const card = [...this.#cards.values()].find(candidate =>
      candidate.awaitingCustom !== undefined && keyOf(candidate.awaitingCustom.chat) === keyOf(event.chat))
    if (card !== undefined && card.awaitingCustom !== undefined && event.text.trim() !== '') {
      const draft = card.drafts[card.awaitingCustom.question]
      if (draft !== undefined) {
        draft.custom = event.text.trim()
        draft.selected = []
      }
      card.awaitingCustom = undefined
      await this.#publishCard(card)
      return
    }
    await this.#prompt(event)
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
    // DSH's own client contract: one Host-wide baseline, then one frame per
    // committed event that changed `userQuestions` or `inbox`. The Web client
    // reads the same projections; only the presentation is different here.
    const abort = new AbortController()
    this.#controlAbort = abort
    void this.#control(backend, abort.signal)
    await this.#restore()
    return backend
  }

  /**
   * Consume the Host's projection control stream.
   *
   * The baseline is a complete cut over every Session, so a continued question
   * that outlived a reconnect can still be answered. Change frames carry only
   * the keys one event changed; anything omitted keeps its last value.
   */
  async #control(backend: HostBackend, signal: AbortSignal): Promise<void> {
    try {
      for await (const frame of backend.ctx.remote.session.control(signal)) {
        if (signal.aborted) return
        if (frame.type === 'baseline') {
          for (const [sessionId, baseline] of Object.entries(frame.value.projections)) {
            this.#applyProjections(sessionId, baseline.values as Record<string, unknown>)
          }
          continue
        }
        const values: Record<string, unknown> = {}
        for (const change of frame.changes) values[change.key] = change.val
        this.#applyProjections(frame.sessionId as string, values)
      }
    } catch (error) {
      if (!signal.aborted) this.#log.error(`projection control failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Merge one projection read into the per-Session cache, then reconcile its cards. */
  #applyProjections(sessionId: string, values: Record<string, unknown>): void {
    const previous = this.#projections.get(sessionId)
    const questions = 'userQuestions' in values
      ? projectedQuestions(values.userQuestions)
      : previous?.questions
    const queued = 'inbox' in values
      ? new Set(queuedReplies(values.inbox))
      : previous?.queued ?? new Set<string>()
    this.#projections.set(sessionId, { questions, queued })
    this.#reconcile(sessionId)
  }

  /**
   * Mirror the projection onto cards, the way DSH's
   * `publishContinuedQuestions()` does: `continued` rows get an answerable
   * card, `open` rows only change its state, and a call that is no longer
   * listed (or has a reply queued in the inbox) loses its card. A card with
   * a live waterfall is never removed by a projection frame.
   */
  #reconcile(sessionId: string): void {
    const view = this.#projections.get(sessionId)
    if (view?.questions === undefined) return
    const watchers = [...this.#mounts.values()].filter(mount => mount.sessionId === sessionId)
    if (watchers.length === 0) return
    const answerable = view.questions.filter(row => row.state === 'continued' && !view.queued.has(row.callId))
    for (const row of answerable) {
      const existing = this.#cardByCall(sessionId, row.callId)
      const card = existing ?? this.#ensureCard(sessionId, row.questions, row.callId, watchers)
      const changed = card.state !== 'continued' || card.hidden || !card.answerable
      card.state = 'continued'
      card.answerable = true
      card.hidden = false
      card.status = '选择后按「提交」，答案会在下一轮进入 agent'
      if (changed) void this.#publishCard(card)
    }
    const live = new Set(view.questions.filter(row => !view.queued.has(row.callId)).map(row => row.callId))
    for (const card of [...this.#cards.values()]) {
      if (card.sessionId !== sessionId || card.settled || card.callId === undefined) continue
      if (live.has(card.callId) || card.waterfall !== undefined) continue
      void this.#removeCard(card, '☑️ 这条问题已结算')
    }
  }

  /** Drop a dead connection so the next call re-attaches. */
  async #drop(reason: string): Promise<void> {
    const backend = this.#backend
    if (backend === undefined) return
    this.#log.error(`host connection lost: ${reason}`)
    this.#backend = undefined
    this.#controlAbort?.abort()
    this.#controlAbort = undefined
    for (const key of [...this.#pending.keys()]) this.#settle(key, 'cancelled', '')
    this.#disposeQuestions('⌛️ 主机连接已断开')
    this.#projections.clear()
    for (const mount of this.#mounts.values()) mount.abort.abort()
    this.#mounts.clear()
    await backend?.close().catch(() => undefined)
  }

  /** Hand every live waterfall back and withdraw every card at teardown. */
  #disposeQuestions(status: string): void {
    for (const card of [...this.#cards.values()]) {
      card.waterfall?.delegate()
      void this.#removeCard(card, status)
    }
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

  /** Send one reply in the same conversation. */
  async #say(chat: ChatKey, text: string): Promise<void> {
    const channel = this.#channel(chat)
    try {
      await channel.send(chat, project(channel, text), { preview: false })
    } catch (error) {
      this.#log.error(`reply to ${keyOf(chat)} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Run one command. */
  async #command(message: InboundMessage, name: string, args: string): Promise<void> {
    const chat = message.chat
    switch (name) {
      case 'start':
      case 'help': {
        await this.#say(chat, HELP)
        return
      }
      case 'cwd': {
        if (args === '') {
          await this.#offerDirectories(chat)
          return
        }
        await this.#switchDirectory(chat, args)
        return
      }
      case 'new': {
        await this.#newSession(chat)
        return
      }
      case 'sessions': {
        await this.#listSessions(chat)
        return
      }
      case 'switch': {
        await this.#switchSession(chat, args)
        return
      }
      case 'status': {
        await this.#say(chat, await this.#describe(chat))
        return
      }
      case 'tasks': {
        await this.#listTasks(chat)
        return
      }
      case 'create-auto-task':
      case 'create_auto_task': {
        await this.#createAutoTask(message, args)
        return
      }
      case 'stop': {
        await this.#stopTurn(chat)
        return
      }
      default: {
        await this.#say(chat, `未知命令 /${name}\n\n${HELP}`)
      }
    }
  }

  /** List Host scheduled tasks without mounting or creating a Session. */
  async #listTasks(chat: ChatKey): Promise<void> {
    const backend = await this.#ensureHost()
    try {
      await this.#say(chat, formatTasks(unwrap(await backend.ctx.remote.schedule.catalog())))
    } catch (error) {
      await this.#say(chat, `读取定时任务失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * One automation request as an ordinary turn.
   *
   * The seed sentence makes the intent explicit and the rest is the user's own
   * requirements; the agent owns `schedule_create` and reads the clock and the
   * client zone, so the bot needs no timing parser of its own.
   */
  async #createAutoTask(message: InboundMessage, args: string): Promise<void> {
    const requirement = args.trim()
    if (requirement === '') {
      await this.#say(message.chat, '用法：/create-auto-task <需求>\n例如：/create-auto-task 每天早上 6 点把 BTC 日报发到 Telegram')
      return
    }
    await this.#prompt({ ...message, text: `${AUTO_TASK_SEED}\n${requirement}` })
  }

  /** One mounted session's Host summary. */
  async #summary(sessionId: string): Promise<SessionSummary | undefined> {
    const backend = await this.#ensureHost()
    const items = unwrap(await backend.ctx.remote.session.list({})) as { items: SessionSummary[] }
    return items.items.find(item => item.sessionId === sessionId)
  }

  /** Human-readable state of one conversation's mount. */
  async #describe(chat: ChatKey): Promise<string> {
    const sessionId = this.#bindings.get(chat)
    if (sessionId === undefined) return '还没有挂载会话。发一条消息，我会在默认目录里建一个。'
    const summary = await this.#summary(sessionId).catch(() => undefined)
    const mount = this.#mounts.get(keyOf(chat))
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
  async #offerDirectories(chat: ChatKey): Promise<void> {
    const currentId = this.#bindings.get(chat)
    const current = currentId === undefined ? undefined : await this.#summary(currentId).catch(() => undefined)
    const currentPath = current?.cwd
    let paths: readonly string[]
    try {
      paths = await this.#recentDirectories()
    } catch (error) {
      await this.#say(chat, `读不到目录列表：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (paths.length === 0) {
      await this.#say(chat, '还没有用过任何目录。发 /cwd <path> 指定一个。')
      return
    }
    this.#cwdChoices.set(keyOf(chat), paths)
    const header = currentPath === undefined ? '当前还没有挂载会话。' : `当前目录：${currentPath}`
    const keyboard = paths.map((path, index) => [{
      text: `${path === currentPath ? '✓ ' : ''}${this.#shortPath(path)}`,
      data: `cwd:${String(index)}`,
    }])
    const channel = this.#channel(chat)
    try {
      await channel.send(chat, project(channel, `${header}\n\n选择要挂载的目录：`), { keyboard, preview: false })
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
  async #syncStatus(chat: ChatKey): Promise<void> {
    const channel = this.#channel(chat)
    if (!channel.pinnedStatus || channel.pin === undefined) return
    const mount = this.#mounts.get(keyOf(chat))
    const sessionId = this.#bindings.get(chat)
    if (sessionId === undefined) return
    const path = mount?.path ?? '(未知目录)'
    const title = mount?.title ?? sessionId.slice(0, 8)
    const text = `📍 ${path}\n${title} · ${mount?.active === true ? '运行中' : '空闲'}`
    const body = project(channel, text)
    const existing = this.#bindings.statusMessageId(chat)
    if (existing !== undefined) {
      try {
        await channel.edit(chat, existing, body, { preview: false })
        return
      } catch (error) {
        // A status message that is gone needs a new one; anything else is a
        // transient failure and must not leave two pins behind.
        if (channel.isMissing?.(error) !== true) {
          this.#log.error(`status edit failed: ${error instanceof Error ? error.message : String(error)}`)
          return
        }
      }
    }
    try {
      const messageId = await channel.send(chat, body, { preview: false })
      if (messageId === undefined) return
      const previous = existing
      this.#bindings.setStatusMessageId(chat, messageId)
      await this.#bindings.flush().catch(() => undefined)
      if (previous !== undefined) await channel.unpin?.(chat, previous).catch(() => undefined)
      await channel.pin(chat, messageId).catch(error => {
        this.#log.error(`pin failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    } catch (error) {
      this.#log.error(`status message failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Move this conversation to a directory with a new session.
   *
   * `/cwd` deliberately does not resume the newest session under that directory:
   * resuming is `/sessions` + `/switch`, and doing it implicitly is how two
   * unrelated conversations ended up sharing one session. A directory change is
   * a new conversation.
   */
  async #switchDirectory(chat: ChatKey, raw: string): Promise<void> {
    const path = resolve(expandHome(raw))
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || !info.isDirectory()) {
      await this.#say(chat, `目录不存在：${path}`)
      return
    }
    const backend = await this.#ensureHost()
    const remote = backend.ctx.remote
    const workspaceId = (unwrap(await remote.workspace.create({ path })) as { workspace: { workspaceId: string } }).workspace.workspaceId
    const sessionId = (unwrap(await remote.session.create({ workspaceId: workspaceId as never })) as { sessionId: string }).sessionId
    await this.#mount(chat, sessionId)
    await this.#say(chat, `已在 ${path} 新建会话。`)
  }

  /** Create a session in the mounted (or default) directory. */
  async #newSession(chat: ChatKey): Promise<void> {
    const backend = await this.#ensureHost()
    const remote = backend.ctx.remote
    const current = this.#bindings.get(chat)
    const summary = current === undefined ? undefined : await this.#summary(current).catch(() => undefined)
    const path = summary?.cwd ?? this.#config.defaultCwd
    const workspaceId = (unwrap(await remote.workspace.create({ path })) as { workspace: { workspaceId: string } }).workspace.workspaceId
    const sessionId = (unwrap(await remote.session.create({ workspaceId: workspaceId as never })) as { sessionId: string }).sessionId
    await this.#mount(chat, sessionId)
    await this.#say(chat, `已新建会话，目录 ${path}。`)
  }

  /** List recent sessions and remember their order for `/switch`. */
  async #listSessions(chat: ChatKey): Promise<void> {
    const backend = await this.#ensureHost()
    const listed = unwrap(await backend.ctx.remote.session.list({})) as { items: SessionSummary[] }
    const items = listed.items
      .filter(item => item.origin !== 'subagent')
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 10)
    if (items.length === 0) {
      await this.#say(chat, '还没有会话。发一条消息就会新建一个。')
      return
    }
    this.#recent.set(keyOf(chat), items.map(item => item.sessionId))
    const current = this.#bindings.get(chat)
    const lines = items.map((item, index) => {
      const title = this.#titleOf(item) ?? item.cwd?.split('/').pop() ?? '(未命名)'
      const marker = item.sessionId === current ? '*' : ' '
      return `${marker}${String(index + 1)}. ${title}${item.running ? ' · 运行中' : ''}`
    })
    await this.#say(chat, ['最近会话：', ...lines, '', '用 /switch <n> 切换。'].join('\n'))
  }

  /** Switch to one of the sessions `/sessions` listed. */
  async #switchSession(chat: ChatKey, args: string): Promise<void> {
    const index = Number.parseInt(args, 10)
    const recent = this.#recent.get(keyOf(chat))
    if (recent === undefined) {
      await this.#say(chat, '先发 /sessions 看看有哪些会话。')
      return
    }
    const sessionId = Number.isSafeInteger(index) ? recent[index - 1] : undefined
    if (sessionId === undefined) {
      await this.#say(chat, `没有第 ${args} 个会话。`)
      return
    }
    await this.#mount(chat, sessionId)
    await this.#say(chat, `已切换。\n\n${await this.#describe(chat)}`)
  }

  /** Cancel the running turn of the mounted session. */
  async #stopTurn(chat: ChatKey): Promise<void> {
    const sessionId = this.#bindings.get(chat)
    if (sessionId === undefined) {
      await this.#say(chat, '还没有挂载会话。')
      return
    }
    const backend = await this.#ensureHost()
    unwrap(await backend.ctx.remote.session.cancel({ sessionId: sessionId as never }))
    await this.#say(chat, '已请求停止。')
  }

  /** Prompt the mounted session, auto-mounting the default on first use. */
  async #prompt(message: InboundMessage): Promise<void> {
    const chat = message.chat
    const text = message.text.trim()
    // Images arrive as files; the model is told the path and reads it with
    // `read_image`. Image prompt parts would need a vision model, and this bot
    // cannot know which model a session uses.
    const withImages = [text, ...(message.images ?? []).map(image => `[图片: ${image.path}]`)]
      .filter(line => line !== '')
      .join('\n\n')
    if (withImages === '') return
    let sessionId = this.#bindings.get(chat)
    if (sessionId === undefined) {
      sessionId = await this.#default()
      if (sessionId === undefined) {
        await this.#say(chat, '无法创建会话：Host 里没有可用的工作区。')
        return
      }
      await this.#mount(chat, sessionId)
    }
    const backend = await this.#ensureHost()
    try {
      unwrap(await backend.ctx.remote.session.prompt({
        requestId: randomUUID() as never,
        sessionId: sessionId as never,
        mode: 'queue',
        content: [{ type: 'text', text: withImages }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }))
    } catch (error) {
      await this.#drop(error instanceof Error ? error.message : String(error))
      await this.#say(chat, 'Host 没有接受这次请求，已重新连接；请再发一次。')
    }
  }

  /**
   * First-use mount: a session of this conversation's own.
   *
   * Sharing one session across conversations would stream every turn into every
   * chat mounted to it — a private chat and an unrelated group would echo each
   * other. Sharing stays available, but only explicitly: `/cwd` mounts the
   * newest session under a directory, and `/switch` picks one from the list.
   */
  async #default(): Promise<string | undefined> {
    const backend = await this.#ensureHost()
    const remote = backend.ctx.remote
    const path = this.#config.defaultCwd
    const workspaceId = (unwrap(await remote.workspace.create({ path })) as { workspace: { workspaceId: string } }).workspace.workspaceId
    return (unwrap(await remote.session.create({ workspaceId: workspaceId as never })) as { sessionId: string }).sessionId
  }

  /** Mount one conversation and start following its session. */
  async #mount(chat: ChatKey, sessionId: string, known: { path?: string; title?: string } = {}): Promise<void> {
    const existing = this.#mounts.get(keyOf(chat))
    existing?.abort.abort()
    existing?.reply?.dispose()
    let path = known.path
    let title = known.title
    if (path === undefined || title === undefined) {
      const summary = await this.#summary(sessionId).catch(() => undefined)
      path ??= summary?.cwd
      title ??= this.#titleOf(summary)
    }
    this.#mounts.set(keyOf(chat), {
      key: chat,
      sessionId,
      tracker: new TurnTracker(),
      abort: new AbortController(),
      reply: undefined,
      active: false,
      path,
      title,
    })
    this.#bindings.set(chat, sessionId)
    await this.#bindings.flush().catch(() => undefined)
    // A projection baseline may already have been read before this chat
    // mounted: the Web client re-reconciles on a session list change too.
    this.#reconcile(sessionId)
    void this.#follow(this.#mounts.get(keyOf(chat)) as Mount)
    void this.#syncStatus(chat)
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
    return new ReplyStream(this.#channel(mount.key), mount.key, {
      intervalMs: this.#config.streamIntervalMs,
      onError: message => { this.#log.error(`${keyOf(mount.key)}: ${message}`) },
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
      const { text, links } = takeImageLinks(mount.tracker.text)
      await reply?.finish(text)
      if (links.length > 0) await this.#sendImages(mount, links)
      void this.#syncStatus(mount.key)
    }
  }

  /**
   * Attach the images one reply referenced.
   *
   * A file the agent wrote is only reachable by a surface that accepts uploads;
   * the path is resolved against the session directory, and anything unreadable
   * or unrecognised is left out instead of failing the turn.
   */
  async #sendImages(mount: Mount, links: readonly ImageLink[]): Promise<void> {
    const channel = this.#channel(mount.key)
    if (channel.sendImage === undefined) return
    for (const link of links.slice(0, 4)) {
      const path = isAbsolute(link.path) ? link.path : resolve(mount.path ?? this.#config.defaultCwd, link.path)
      const mediaType = mediaTypeOf(path)
      if (mediaType === undefined) continue
      const data = await readFile(path).catch(() => undefined)
      if (data === undefined) {
        this.#log.error(`image not readable: ${path}`)
        continue
      }
      if (data.byteLength > MAX_IMAGE_BYTES) {
        this.#log.error(`image too large: ${path}`)
        continue
      }
      await channel.sendImage(mount.key, {
        data: new Uint8Array(data),
        mediaType,
        ...(link.alt === '' ? {} : { caption: link.alt }),
      }).catch(error => { this.#log.error(`image send failed: ${error instanceof Error ? error.message : String(error)}`) })
    }
  }

  /**
   * Answer one approval on the conversations mounted to the Session that
   * asked, and delegate every other request.
   *
   * `approval/request` is an Agent-scoped Host waterfall: an answerer may
   * return an outcome only for an Agent it owns. Broadcasting a card to
   * whichever chat has a turn in flight attributes one Session's permission
   * request to an unrelated Session, and claiming it short-circuits the client
   * answerer that actually owns the turn.
   */
  async #onApproval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const sessionId = request.agent?.session?.id
    if (sessionId === undefined) {
      this.#log.info('approval delegated: the request names no Session')
      return await next()
    }
    const watchers = [...this.#mounts.values()].filter(mount => mount.sessionId === sessionId)
    if (watchers.length === 0) {
      this.#log.info(`approval delegated: ${sessionId} has no mounted conversation`)
      return await next()
    }
    this.#log.info(`approval for ${sessionId} on ${String(watchers.length)} mounted conversation(s)`)

    this.#sequence += 1
    const key = `a${String(this.#sequence)}`
    const reason = typeof request.displayReason === 'string' ? request.displayReason : request.reason
    const summary = `🛡 需要批准 · ${request.toolName}${reason === undefined ? '' : `\n${reason}`}`
    const cards: { chat: ChatKey; messageId: string }[] = []
    const outcome = new Promise<Decision>((resolve) => {
      this.#pending.set(key, { key, cards, settled: false, resolve })
    })
    for (const mount of watchers) {
      try {
        const channel = this.#channel(mount.key)
        const messageId = await channel.send(mount.key, project(channel, summary), {
          keyboard: [[
            { text: '允许这一次', data: `approve:${key}` },
            { text: '完全权限', data: `full:${key}` },
            { text: '拒绝', data: `reject:${key}` },
          ]],
          preview: false,
        })
        if (messageId !== undefined) cards.push({ chat: mount.key, messageId })
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
      const decision = await outcome
      if (decision !== 'full-access') return decision
      await this.#grantFullAccess(request, watchers)
      return 'allowed-once'
    } finally {
      removeAbort()
      this.#pending.delete(key)
    }
  }

  /**
   * Widen one Session after its approval card asked for full access.
   *
   * The write path is the Host's own `/permission` command, so the switch lands
   * in the Session log as `permission/preset`, `sandbox/mode` and
   * `approval/policy` and every later turn keeps it until the user changes it.
   * The current call is answered `allowed-once` either way; a failed switch is
   * reported to the conversation instead of pretending it worked.
   * @param request - the approval whose card was pressed.
   * @param watchers - conversations the cards went to.
   */
  async #grantFullAccess(request: ApprovalRequest, watchers: readonly Mount[]): Promise<void> {
    const sessionId = request.agent?.session?.id
    const mount = sessionId === undefined
      ? watchers[0]
      : watchers.find(candidate => candidate.sessionId === sessionId)
    const backend = this.#backend
    if (sessionId === undefined || backend === undefined) {
      this.#log.error('full access: the approval names no live Session')
      if (mount !== undefined) await this.#say(mount.key, '⚠️ 完全权限没有切换：这条审批没有会话信息')
      return
    }
    try {
      unwrap(await backend.ctx.remote.commands.execute(sessionId, '/permission danger-full-access'))
      this.#log.info(`full access enabled for ${sessionId}`)
      if (mount !== undefined) await this.#say(mount.key, '🔓 本会话已改为完全权限，之后不再询问权限')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.#log.error(`full access failed: ${reason}`)
      if (mount !== undefined) await this.#say(mount.key, `⚠️ 完全权限没有切换成功：${reason}`)
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
  async #closeCards(cards: readonly { chat: ChatKey; messageId: string }[], decision: Decision, by: string): Promise<void> {
    const text = decision === 'allowed-once' || decision === 'full-access'
      ? `✅ 已允许${by === '' ? '' : `（${by}）`}`
      : decision === 'rejected'
        ? `⛔ 已拒绝${by === '' ? '' : `（${by}）`}`
        : '☑️ 已在其他端处理'
    for (const card of cards) {
      try {
        const channel = this.#channel(card.chat)
        await channel.edit(card.chat, card.messageId, project(channel, text), { keyboard: [], preview: false })
      } catch {
        // A closed card is cosmetic; never let it break the approval flow.
      }
    }
  }

  /**
   * Answer one question on the conversations mounted to the Session that
   * asked it, and delegate every other request.
   *
   * This is the same answerer shape as DSH's `SdkUserQuestionBridge`: an
   * `ownsAgent` predicate (here, "a mounted conversation watches this
   * Session"), then a promise the answerer settles with a structured
   * `AskUserQuestionAnswer` instead of calling `next()`. `next()` is reserved
   * for an explicit hand-on, which is what DSH's `QuestionWaterfallChannel`
   * calls delegation.
   *
   * The card is keyed by `(sessionId, callId)` and shared with the projection:
   * a timed request that reaches its deadline keeps its card, and the
   * `continued` row later gives it the `userQuestions.answer` path. A
   * blocking request has no call id, so its card ends with the waterfall.
   */
  async #onQuestion(request: QuestionRequest, next: () => Promise<unknown>): Promise<unknown> {
    const sessionId = request.agent?.session?.id
    if (sessionId === undefined) {
      this.#log.info('question delegated: the request names no Session')
      return await next()
    }
    const watchers = [...this.#mounts.values()].filter(mount => mount.sessionId === sessionId)
    if (watchers.length === 0) {
      this.#log.info(`question delegated: ${sessionId} has no mounted conversation`)
      return await next()
    }
    const callId = request.wait?.callId
    const card = this.#cardByCall(sessionId, callId)
      ?? this.#ensureCard(sessionId, request.questions, callId, watchers)
    this.#log.info(`question ${card.key} for ${sessionId} on ${String(watchers.length)} mounted conversation(s)`)
    card.hidden = false
    card.status = ''
    const channel = createWaterfall(request.signal)
    card.waterfall = channel
    try {
      try {
        await this.#publishCard(card)
      } catch (error) {
        this.#log.error(`question card failed: ${String(error)}`)
      }
      if (card.messages.length === 0) {
        // No surface could show a card: there is nobody to answer it here.
        card.settled = true
        this.#cards.delete(card.token)
        return await next()
      }

      // A claim suspends the Host's own timer, so the client that holds it
      // owns the countdown and must reject with ASK_TIMED_OUT at the
      // deadline: `TimedQuestionWait.attach()` + `createWaterfallRequest()`.
      let claimEnded: Promise<QuestionAnswerBatch> | undefined
      let noWindow = false
      const claim = new AbortController()
      const userQuestions = this.#backend?.ctx.remote.userQuestions
      if (request.wait?.timed === true && callId !== undefined && userQuestions !== undefined) {
        const signal = request.signal === undefined
          ? claim.signal
          : AbortSignal.any([claim.signal, request.signal])
        try {
          const iterator = userQuestions.attachWait(request.agent, callId, signal)[Symbol.asyncIterator]()
          card.claim = claim
          const opening = await iterator.next()
          if (opening.done === true) {
            noWindow = true
          } else {
            this.#armCountdown(card, channel, Math.max(0, opening.value.remainingMs))
            // The first publish happened before the claim reported its
            // remaining window; repaint so the card shows the countdown.
            await this.#publishCard(card)
            claimEnded = (async (): Promise<QuestionAnswerBatch> => {
              await iterator.next()
              throw questionError('ASK_TIMED_OUT')
            })()
          }
        } catch (error) {
          this.#log.info(`question wait not attached: ${error instanceof Error ? error.message : String(error)}`)
          this.#disposeClaim(card)
        }
      }
      if (noWindow) {
        // The wait is already over; there is no foreground window to answer in.
        this.#disposeClaim(card)
        await this.#hideCard(card, '⌛️ 回答窗口已关闭')
        return await next()
      }
      try {
        return await (claimEnded === undefined
          ? channel.result
          : Promise.race([channel.result, claimEnded]))
      } catch (error) {
        if (!channel.isDelegation(error)) throw error
        // Delegation releases the claim before `next()`, so the Host's clock
        // is never left suspended by a client that has stepped aside.
        this.#disposeClaim(card)
        try {
          return await next()
        } catch (downstream) {
          // A blocking request that nobody took has no projection row that
          // could bring its card back. A timed one does: it becomes
          // `continued`, so its card stays for the late-answer path.
          if (request.wait?.timed !== true) {
            await this.#removeCard(card, '⌛️ 没有其他端接手这条问题')
          }
          throw downstream
        }
      }
    } finally {
      card.waterfall = undefined
      this.#disposeClaim(card)
      if (!card.settled) {
        if (callId === undefined) {
          await this.#removeCard(card, card.status === '' ? '☑️ 这条问题已结束' : card.status)
        } else {
          if (card.status === '') {
            card.status = card.state === 'continued'
              ? '选择后按「提交」，答案会在下一轮进入 agent'
              : '⌛️ 回答窗口已关闭，等待会话投影'
          }
          await this.#publishCard(card)
        }
      }
    }
  }

  /** Find the one card DSH keyed a tool call by, if it is still answerable. */
  #cardByCall(sessionId: string, callId: string | undefined): QuestionCard | undefined {
    if (callId === undefined) return undefined
    return [...this.#cards.values()].find(card =>
      !card.settled && card.sessionId === sessionId && card.callId === callId)
  }

  /** Register and publish one card for a `(sessionId, callId)` pair. */
  #ensureCard(
    sessionId: string,
    questions: readonly QuestionItem[],
    callId: string | undefined,
    watchers: readonly Mount[],
  ): QuestionCard {
    this.#sequence += 1
    const token = `q${String(this.#sequence)}`
    const card: QuestionCard = {
      key: `question:${sessionId}:${callId ?? token}`,
      token,
      sessionId,
      callId,
      questions,
      chats: watchers.map(mount => mount.key),
      messages: [],
      drafts: questions.map(() => ({ selected: [] })),
      index: 0,
      state: 'open',
      answerable: false,
      hidden: false,
      settled: false,
      status: '',
    }
    this.#cards.set(token, card)
    return card
  }

  /** Send the card on every watching chat, or edit the copies already sent. */
  async #publishCard(card: QuestionCard): Promise<void> {
    if (card.settled) return
    const text = questionText(card)
    // A hidden card has withdrawn its seat. Only the projection can bring it
    // back (as a `continued` row); a button on a card with no answer channel
    // would be a trap.
    const keyboard = card.hidden ? [] : questionKeyboard(card)
    for (const chat of card.chats) {
      try {
        const channel = this.#channel(chat)
        const sent = card.messages.find(message => keyOf(message.chat) === keyOf(chat))
        if (sent === undefined) {
          const messageId = await channel.send(chat, project(channel, text), { keyboard, preview: false })
          if (messageId !== undefined) card.messages.push({ chat, messageId })
        } else {
          await channel.edit(chat, sent.messageId, project(channel, text), { keyboard, preview: false })
        }
      } catch (error) {
        this.#log.error(`question card failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** Replace every copy of one card with an exact text and keyboard. */
  async #rewriteCard(card: QuestionCard, text: string, keyboard: Keyboard): Promise<void> {
    for (const message of card.messages) {
      try {
        const channel = this.#channel(message.chat)
        await channel.edit(message.chat, message.messageId, project(channel, text), { keyboard, preview: false })
      } catch {
        // A closed card is cosmetic; never let it break the question flow.
      }
    }
  }

  /** Withdraw a card's buttons but keep the request and its deadline standing. */
  async #hideCard(card: QuestionCard, status: string): Promise<void> {
    if (card.settled) return
    card.hidden = true
    card.status = status
    card.awaitingCustom = undefined
    await this.#publishCard(card)
  }

  /** End a card for good and drop every timer and claim it owned. */
  async #removeCard(card: QuestionCard, status: string): Promise<void> {
    if (card.settled) return
    card.status = status
    const text = questionText(card)
    card.settled = true
    card.hidden = false
    this.#cards.delete(card.token)
    this.#disposeClaim(card)
    await this.#rewriteCard(card, text, [])
  }

  /** Give the foreground wait back to the Host and stop the local countdown. */
  #disposeClaim(card: QuestionCard): void {
    if (card.timer !== undefined) clearTimeout(card.timer)
    card.timer = undefined
    card.deadline = undefined
    card.claim?.abort()
    card.claim = undefined
  }

  /**
   * Own the timed window: tick the card every few seconds and reject the
   * waterfall with `ASK_TIMED_OUT` at the Host-computed deadline.
   */
  #armCountdown(card: QuestionCard, channel: QuestionWaterfall, remainingMs: number): void {
    const deadline = Date.now() + remainingMs
    card.deadline = deadline
    let shown = -1
    const tick = (): void => {
      if (card.settled || card.waterfall !== channel) return
      const left = Math.max(0, deadline - Date.now())
      if (left <= 0) {
        channel.reject('ASK_TIMED_OUT')
        return
      }
      const bucket = Math.ceil(left / 5000)
      if (bucket !== shown) {
        shown = bucket
        void this.#publishCard(card)
      }
      const timer = setTimeout(tick, Math.min(1000, left))
      unref(timer)
      card.timer = timer
    }
    const first = setTimeout(tick, Math.min(1000, remainingMs))
    unref(first)
    card.timer = first
  }

  /**
   * Submit one complete answer batch through the card's live channel: the
   * waterfall while the window is open, `userQuestions.answer` once the
   * projection says the call is `continued`.
   */
  async #submitAnswer(callback: InboundCallback, card: QuestionCard): Promise<void> {
    const channel = this.#channel(callback.chat)
    const batch = batchOf(card)
    if (batch === undefined) {
      await channel.answer(callback, '每道题都要选一个选项或填写自定义答案').catch(() => undefined)
      return
    }
    await channel.answer(callback).catch(() => undefined)
    const waterfall = card.waterfall
    if (waterfall !== undefined) {
      card.status = '✅ 已在本端回答'
      waterfall.resolve(batch)
      return
    }
    if (!card.answerable || card.callId === undefined || this.#backend === undefined) {
      await channel.answer(callback, '这条问题现在没有可提交的通道').catch(() => undefined)
      return
    }
    const result = await this.#backend.ctx.remote.userQuestions.answer(card.sessionId, card.callId, batch)
    if (!result.ok) {
      const code = result.error.code
      card.status = code === 'REPLY_QUEUED'
        ? '☑️ 答案已在排队，无需重复提交'
        : `⚠️ 提交失败：${result.error.message ?? code ?? 'Host request failed'}`
      await this.#publishCard(card)
      return
    }
    if (!result.value) {
      card.status = '⌛️ 这条问题已经不可补答'
      await this.#rewriteCard(card, questionText(card), [])
      return
    }
    // `true` means the reply was steered into the inbox, not that the agent
    // has read it. The projection closes the row when it admits the message.
    card.status = '☑️ 已提交，等下一轮生效'
    await this.#rewriteCard(card, questionText(card), [])
  }

  /** Handle one button press on a question card. */
  async #onQuestionCallback(callback: InboundCallback, action: string, token: string, args: readonly string[]): Promise<void> {
    const channel = this.#channel(callback.chat)
    const card = this.#cards.get(token)
    if (card === undefined || card.settled) {
      await channel.answer(callback, '这条问题已经处理过了').catch(() => undefined)
      await channel.edit(callback.chat, callback.messageId, project(channel, '☑️ 已处理'), { keyboard: [], preview: false })
        .catch(() => undefined)
      return
    }
    if (action === 'delegate') {
      await channel.answer(callback).catch(() => undefined)
      card.waterfall?.delegate()
      // The request outlives this card: the `userQuestions` projection brings
      // it back as a `continued` row once the window closes. DSH Web reveals
      // hidden cards from the transcript row, which a chat surface has no
      // equivalent of; promising a button here left a dead affordance.
      await this.#hideCard(card, '☑️ 已交给其他端 · 窗口关闭后仍可补答')
      return
    }
    if (action === 'qsubmit') {
      await this.#submitAnswer(callback, card)
      return
    }
    if (action === 'qnav') {
      const index = Number.parseInt(args[0] ?? '', 10)
      if (!Number.isInteger(index) || index < 0 || index >= card.questions.length) {
        await channel.answer(callback, '这道题已经不在了').catch(() => undefined)
        return
      }
      await channel.answer(callback).catch(() => undefined)
      card.index = index
      card.awaitingCustom = undefined
      await this.#publishCard(card)
      return
    }
    if (action === 'qcancel') {
      await channel.answer(callback).catch(() => undefined)
      card.awaitingCustom = undefined
      await this.#publishCard(card)
      return
    }
    if (action === 'qcustom') {
      const index = Number.parseInt(args[0] ?? '', 10)
      const question = card.questions[index]
      if (question === undefined || question.intent?.kind === 'approval') {
        await channel.answer(callback, '这道题不接受自定义答案').catch(() => undefined)
        return
      }
      await channel.answer(callback).catch(() => undefined)
      card.index = index
      card.awaitingCustom = { chat: callback.chat, question: index }
      await this.#publishCard(card)
      return
    }
    if (action === 'qopt') {
      const index = Number.parseInt(args[0] ?? '', 10)
      const optionIndex = Number.parseInt(args[1] ?? '', 10)
      const question = card.questions[index]
      const option = question?.options?.[optionIndex]
      const draft = card.drafts[index]
      if (question === undefined || option === undefined || draft === undefined) {
        await channel.answer(callback, '这个选项已经不在了').catch(() => undefined)
        return
      }
      card.index = index
      if (question.multiSelect === true) {
        const at = draft.selected.indexOf(option.label)
        if (at === -1) draft.selected.push(option.label)
        else draft.selected.splice(at, 1)
      } else {
        draft.selected = [option.label]
        draft.custom = undefined
      }
      // A caller-declared `approval` has three fixed actions and no free text;
      // one press is the whole answer, exactly like the Web permission card.
      if (question.intent?.kind === 'approval') {
        await this.#submitAnswer(callback, card)
        return
      }
      await channel.answer(callback).catch(() => undefined)
      await this.#publishCard(card)
      return
    }
    await channel.answer(callback, '这个按钮已经过期了').catch(() => undefined)
  }

  /** Handle one button press. */
  async #onCallback(callback: InboundCallback): Promise<void> {
    if (callback.data.startsWith('cwd:')) {
      await this.#onDirectoryChoice(callback)
      return
    }
    const channel = this.#channel(callback.chat)
    const [action, key, ...args] = callback.data.split(':')
    if (action !== undefined && key !== undefined
      && ['delegate', 'qsubmit', 'qnav', 'qcancel', 'qcustom', 'qopt'].includes(action)) {
      await this.#onQuestionCallback(callback, action, key, args)
      return
    }
    const pending = this.#pending.get(key ?? '')
    if (pending === undefined || pending.settled) {
      await channel.answer(callback, '这条审批已经处理过了').catch(() => undefined)
      await channel.edit(callback.chat, callback.messageId, project(channel, '☑️ 已处理'), { keyboard: [], preview: false })
        .catch(() => undefined)
      return
    }
    await channel.answer(callback).catch(() => undefined)
    this.#settle(key ?? '', action === 'approve' ? 'allowed-once' : action === 'full' ? 'full-access' : 'rejected', '手机')
  }

  /** Handle one directory button. */
  async #onDirectoryChoice(callback: InboundCallback): Promise<void> {
    const channel = this.#channel(callback.chat)
    const choices = this.#cwdChoices.get(keyOf(callback.chat))
    const index = Number.parseInt(callback.data.slice('cwd:'.length), 10)
    const path = choices === undefined ? undefined : choices[index]
    if (path === undefined) {
      await channel.answer(callback, '这个列表已过期，重新发 /cwd').catch(() => undefined)
      return
    }
    await channel.answer(callback).catch(() => undefined)
    await this.#switchDirectory(callback.chat, path)
    await channel.edit(callback.chat, callback.messageId, project(channel, `📍 ${path}`), { keyboard: [], preview: false })
      .catch(() => undefined)
  }
}

/**
 * The command list every configured channel may publish.
 * @returns the catalogue the bridge handles.
 */
export function commands(): typeof COMMANDS {
  return COMMANDS
}
