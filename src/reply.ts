/**
 * One assistant turn, rendered as one streaming message.
 *
 * Streaming edits the same message until the turn ends; then the durable text
 * replaces the preview and, only if it does not fit, later chunks follow as new
 * messages. A message that cannot be edited is left alone rather than retried
 * forever: three consecutive failures turn streaming off for that turn and the
 * final text is sent once.
 *
 * Everything here is surface-independent: it only knows the {@link Channel}
 * contract, so a Telegram message and a Lark card stream the same way.
 *
 * @module hulala-bot/reply
 */
import type { Channel, ChatKey, Outgoing } from './channel.ts'
import { previewOf, splitMessage } from './render/split.ts'

/** Per-chat streaming settings. */
export interface ReplyOptions {
  readonly intervalMs: number
  /** Keep the chat header showing "typing" while the turn runs. */
  readonly typing?: boolean | undefined
}

/** Consecutive edit failures tolerated before falling back to one final send. */
const MAX_FAILURES = 3

/** How often to refresh the typing indicator while a turn runs. */
const TYPING_INTERVAL_MS = 4000

/** Placeholder that later edits replace. */
const PLACEHOLDER = '⋯ 正在思考'

/**
 * Project agent text for one channel.
 * @param channel - destination surface.
 * @param raw - agent Markdown.
 * @returns the projection and its parts.
 */
export function project(channel: Channel, raw: string): Outgoing {
  const text = channel.format(raw)
  return { raw, text, parts: splitMessage(text, channel.maxTextLength) }
}

/** Build a stream preview that stays inside one message. */
function preview(channel: Channel, raw: string): Outgoing {
  const text = channel.format(raw)
  const head = previewOf(text, channel.maxTextLength)
  return { raw, text: head, parts: [head] }
}

/** Streaming projection of one assistant turn. */
export class ReplyStream {
  readonly #channel: Channel
  readonly #chat: ChatKey
  readonly #options: ReplyOptions
  #messageId: string | undefined
  #latest: string | undefined
  #lastText = ''
  #lastSentAt = 0
  #timer: NodeJS.Timeout | undefined
  #typing: NodeJS.Timeout | undefined
  #failures = 0
  #degraded = false
  #closed = false

  /**
   * @param channel - destination surface.
   * @param chat - destination conversation.
   * @param options - throttling and typing behaviour.
   */
  constructor(channel: Channel, chat: ChatKey, options: ReplyOptions) {
    this.#channel = channel
    this.#chat = chat
    this.#options = options
  }

  /** Send the placeholder that later edits replace. */
  async begin(): Promise<void> {
    if (this.#messageId !== undefined || this.#closed) return
    try {
      const placeholder = project(this.#channel, PLACEHOLDER)
      this.#messageId = await this.#channel.send(this.#chat, placeholder, { preview: false })
      this.#lastText = placeholder.text
      this.#lastSentAt = Date.now()
      this.#startTyping()
    } catch {
      this.#degraded = true
    }
  }

  /** Keep the chat header alive for as long as the turn lasts. */
  #startTyping(): void {
    if (this.#options.typing === false || this.#typing !== undefined) return
    const channel = this.#channel
    if (channel.typing === undefined) return
    const beat = (): void => {
      void channel.typing?.(this.#chat).catch(() => undefined)
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
    const body = preview(this.#channel, latest)
    if (body.text === this.#lastText) return
    await this.#edit(body)
  }

  /** Edit once, counting failures so a broken message does not retry forever. */
  async #edit(body: Outgoing): Promise<void> {
    if (this.#messageId === undefined) return
    try {
      await this.#channel.edit(this.#chat, this.#messageId, body, { preview: false })
      this.#lastText = body.text
      this.#lastSentAt = Date.now()
      this.#failures = 0
    } catch (error) {
      const wait = this.#channel.retryAfterMs?.(error)
      if (wait !== undefined) {
        this.#lastSentAt = Date.now() + wait
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
      await this.#channel.delete(this.#chat, this.#messageId).catch(() => undefined)
    }
    await this.#sendAll(body, 0)
  }

  /**
   * Send the remaining parts as fresh messages.
   * @param body - raw assistant text.
   * @param skip - number of already-delivered parts.
   */
  async #sendAll(body: string, skip: number): Promise<void> {
    const { parts } = project(this.#channel, body)
    for (let index = skip; index < parts.length; index += 1) {
      const rest = { raw: body, text: body, parts: parts.slice(index) }
      try {
        await this.#channel.send(this.#chat, rest)
        return
      } catch {
        // The channel already retried in plain text; losing the tail beats
        // looping on a chat that refuses the message.
        return
      }
    }
  }

  /**
   * Edit one message to the head of the body.
   * @param messageId - message to edit.
   * @param body - raw assistant text.
   * @returns whether the edit landed, or the content was already correct.
   */
  async #safeEditBody(messageId: string, body: string): Promise<boolean> {
    try {
      await this.#channel.edit(this.#chat, messageId, project(this.#channel, body), { preview: false })
      return true
    } catch (error) {
      // The channel already retried plain text and swallowed "not modified";
      // anything left means the message itself is unusable.
      return this.#channel.isMissing?.(error) === false
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
