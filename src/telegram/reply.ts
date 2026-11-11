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
}

/** Consecutive edit failures tolerated before falling back to one final send. */
const MAX_FAILURES = 3

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
      this.#messageId = await this.#api.sendMessage(this.#chatId, '⋯', this.#sendOptions())
      this.#lastText = '⋯'
      this.#lastSentAt = Date.now()
    } catch (error) {
      if (error instanceof TelegramError && error.isBadRequest && !this.#plain) {
        this.#plain = true
        await this.begin()
        return
      }
      this.#degraded = true
    }
  }

  /** Build send options from the current formatting state. */
  #sendOptions(extra: { keyboard?: never } = {}): SendOptions {
    const options: SendOptions = {
      disablePreview: true,
      ...(this.#plain ? {} : { parseMode: 'MarkdownV2' as const }),
      ...(this.#options.threadId === undefined ? {} : { threadId: this.#options.threadId }),
    }
    return { ...options, ...extra }
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
    if (this.#messageId !== undefined && !this.#degraded) {
      if (await this.#safeEditBody(this.#messageId, body)) {
        await this.#sendAll(body, 1)
        return
      }
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
          // Telegram also refuses an edit that changes nothing; that is success.
          return retry instanceof TelegramError && retry.isBadRequest
        }
      }
      return error instanceof TelegramError && error.isBadRequest
    }
  }

  /** Release timers; the message already sent stays in the chat. */
  dispose(): void {
    this.#closed = true
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }
}
