/**
 * One assistant turn, rendered as one Telegram message.
 *
 * Streaming edits the same message until the turn ends; then the durable text
 * replaces the preview and, only if it does not fit, later chunks follow as new
 * messages. A message that cannot be edited is left alone rather than retried
 * forever: three consecutive failures turn streaming off for that turn and the
 * final text is sent once.
 *
 * @module dsh-telegram/telegram/reply
 */
import { toMarkdownV2 } from '../render/markdown.ts'
import { previewOf, splitMessage } from '../render/split.ts'
import { TelegramApi, TelegramError, type SendOptions } from './api.ts'

/** How a turn's text is formatted. */
export type ParseMode = 'markdown' | 'plain'

/** Per-chat streaming settings. */
export interface ReplyOptions {
  readonly intervalMs: number
  readonly parseMode: ParseMode
  readonly threadId?: number | undefined
  /** Keep the chat header showing "typing" while the turn runs. */
  readonly typing?: boolean | undefined
}

/** Consecutive edit failures tolerated before falling back to one final send. */
const MAX_FAILURES = 3

/** How often to refresh the typing indicator while a turn runs. */
const TYPING_INTERVAL_MS = 4000

/**
 * Whether a rejection means the message already holds this exact text.
 * @param error - value thrown by the Bot API call.
 * @returns true only for Telegram's "message is not modified" case.
 */
function isNotModified(error: unknown): boolean {
  return error instanceof TelegramError && error.isBadRequest && /not modified/i.test(error.description)
}

/** Streaming projection of one assistant turn. */
export class ReplyStream {
  readonly #api: TelegramApi
  readonly #chatId: number
  readonly #options: ReplyOptions
  #messageId: number | undefined
  #latest: string | undefined
  #lastText = ''
  #lastSentAt = 0
  #timer: NodeJS.Timeout | undefined
  #typing: NodeJS.Timeout | undefined
  #failures = 0
  #degraded = false
  #closed = false
  #plain: boolean

  /**
   * @param api - Bot API client.
   * @param chatId - destination chat.
   * @param options - throttling and formatting.
   */
  constructor(api: TelegramApi, chatId: number, options: ReplyOptions) {
    this.#api = api
    this.#chatId = chatId
    this.#options = options
    this.#plain = options.parseMode === 'plain'
  }

  /** Send the placeholder that later edits replace. */
  async begin(): Promise<void> {
    if (this.#messageId !== undefined || this.#closed) return
    try {
      this.#messageId = await this.#api.sendMessage(this.#chatId, '⋯ 正在思考', this.#sendOptions())
      this.#lastText = '⋯ 正在思考'
      this.#lastSentAt = Date.now()
      this.#startTyping()
    } catch (error) {
      if (error instanceof TelegramError && error.isBadRequest && !this.#plain) {
        this.#plain = true
        await this.begin()
        return
      }
      this.#degraded = true
    }
  }

  /** Keep the chat header alive for as long as the turn lasts. */
  #startTyping(): void {
    if (this.#options.typing === false || this.#typing !== undefined) return
    const beat = (): void => {
      void this.#api.sendChatAction(this.#chatId, this.#options.threadId).catch(() => undefined)
    }
    beat()
    this.#typing = setInterval(beat, TYPING_INTERVAL_MS)
    // A typing indicator must never be the reason a process stays alive.
    this.#typing.unref()
  }

  /** Stop the typing indicator. */
  #stopTyping(): void {
    if (this.#typing === undefined) return
    clearInterval(this.#typing)
    this.#typing = undefined
  }

  /** Build send options from the current formatting state. */
  #sendOptions(): SendOptions {
    return {
      disablePreview: true,
      ...(this.#plain ? {} : { parseMode: 'MarkdownV2' as const }),
      ...(this.#options.threadId === undefined ? {} : { threadId: this.#options.threadId }),
    }
  }

  /** Project text according to the active formatting mode. */
  #format(text: string): string {
    return this.#plain ? text : toMarkdownV2(text)
  }

  /**
   * Replace the visible message with the given text, subject to throttling.
   * @param text - full text accumulated so far.
   */
  async push(text: string): Promise<void> {
    if (this.#closed || this.#degraded || text.trim() === '') return
    this.#latest = text
    if (this.#timer !== undefined) return
    const wait = this.#options.intervalMs - (Date.now() - this.#lastSentAt)
    if (wait <= 0) {
      await this.#flush()
      return
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.#flush()
    }, wait)
  }

  /** Edit once with the newest accumulated text. */
  async #flush(): Promise<void> {
    const latest = this.#latest
    if (latest === undefined) return
    const preview = previewOf(this.#format(latest))
    if (preview === this.#lastText) return
    await this.#edit(preview)
  }

  /** Edit once, falling back to plain text and then to degraded mode. */
  async #edit(text: string): Promise<void> {
    if (this.#messageId === undefined) return
    try {
      await this.#api.editMessageText(this.#chatId, this.#messageId, text, this.#sendOptions())
      this.#lastText = text
      this.#lastSentAt = Date.now()
      this.#failures = 0
    } catch (error) {
      if (!(error instanceof TelegramError)) return
      if (error.isBadRequest && !this.#plain) {
        this.#plain = true
        this.#lastText = ''
        this.#lastSentAt = 0
        return
      }
      if (error.isFlood) {
        this.#lastSentAt = Date.now() + (error.retryAfter ?? 1) * 1000
        return
      }
      this.#failures += 1
      if (this.#failures >= MAX_FAILURES) this.#degraded = true
    }
  }

  /**
   * Finish the turn with the durable text.
   * @param text - final assistant text.
   */
  async finish(text: string): Promise<void> {
    this.#closed = true
    this.#stopTyping()
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    const body = text.trim()
    if (body === '') {
      if (this.#messageId !== undefined && !this.#degraded) {
        await this.#safeEditBody(this.#messageId, '（本轮没有输出）')
      }
      return
    }
    if (this.#messageId !== undefined) {
      // Even after a degraded turn, try once more: leaving a placeholder that
      // says "thinking" forever is worse than one extra request.
      if (await this.#safeEditBody(this.#messageId, body)) {
        await this.#sendAll(body, 1)
        return
      }
      await this.#api.deleteMessage(this.#chatId, this.#messageId).catch(() => undefined)
    }
    await this.#sendAll(body, 0)
  }

  /**
   * Send the remaining chunks as fresh messages.
   * @param body - raw assistant text, re-projected after a formatting fallback.
   * @param skip - number of already-delivered chunks.
   */
  async #sendAll(body: string, skip: number): Promise<void> {
    let chunks = splitMessage(this.#format(body))
    for (let index = skip; index < chunks.length; index += 1) {
      const chunk = chunks[index] as string
      try {
        await this.#api.sendMessage(this.#chatId, chunk, this.#sendOptions())
      } catch (error) {
        if (!(error instanceof TelegramError) || !error.isBadRequest || this.#plain || index !== skip) continue
        // Nothing was delivered yet under the old projection, so re-split the
        // raw text instead of resending a half-escaped chunk.
        this.#plain = true
        chunks = splitMessage(body)
        index = skip - 1
      }
    }
  }

  /**
   * Edit one message to the head of the body.
   *
   * The body is projected inside this method so a formatting fallback can
   * re-project the raw text instead of resending a half-escaped chunk.
   * @param messageId - message to edit.
   * @param body - raw assistant text.
   * @returns whether the edit landed, or the content was already correct.
   */
  async #safeEditBody(messageId: number, body: string): Promise<boolean> {
    const attempt = async (): Promise<void> => {
      const first = splitMessage(this.#format(body))[0] ?? ''
      await this.#api.editMessageText(this.#chatId, messageId, first, this.#sendOptions())
    }
    try {
      await attempt()
      return true
    } catch (error) {
      if (error instanceof TelegramError && error.isBadRequest && !this.#plain) {
        this.#plain = true
        try {
          await attempt()
          return true
        } catch (retry) {
          // An edit that changes nothing already delivered the text.
          return isNotModified(retry)
        }
      }
      return isNotModified(error)
    }
  }

  /** Release timers; the message already sent stays in the chat. */
  dispose(): void {
    this.#closed = true
    this.#stopTyping()
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }
}
