/**
 * Minimal Bot API client: JSON over HTTPS, no framework.
 *
 * Only the calls this bridge uses are implemented. A 429 surfaces the server's
 * `retry_after` so callers can back off instead of hammering; a failed send
 * never throws out of the polling loop.
 *
 * @module dsh-telegram/telegram/api
 */

/** One inline keyboard button. */
export interface InlineButton {
  readonly text: string
  readonly callback_data: string
}

/** One Bot API failure. */
export class TelegramError extends Error {
  /** Bot API method that failed. */
  readonly method: string
  /** Server-supplied reason. */
  readonly description: string
  /** HTTP status code. */
  readonly code: number
  /** Seconds the server asked the caller to wait, when rate limited. */
  readonly retryAfter: number | undefined

  /**
   * @param method - Bot API method that failed.
   * @param description - server-supplied reason.
   * @param code - HTTP status code.
   * @param retryAfter - seconds the server asked the caller to wait.
   */
  constructor(method: string, description: string, code: number, retryAfter?: number) {
    super(`${method}: ${description} (${String(code)})`)
    this.name = 'TelegramError'
    this.method = method
    this.description = description
    this.code = code
    this.retryAfter = retryAfter
  }

  /** Whether this failure looks like rate limiting. */
  get isFlood(): boolean {
    return this.code === 429 || this.retryAfter !== undefined
  }

  /** Whether the failure is about the message itself, not the transport. */
  get isBadRequest(): boolean {
    return this.code === 400
  }
}

/** Transport options; tests inject a base URL and fetch. */
export interface TelegramOptions {
  readonly token: string
  readonly baseUrl: string
  readonly fetch?: typeof globalThis.fetch
}

/** A Telegram user or chat identity, reduced to what routing needs. */
export interface TelegramChat {
  readonly id: number
  readonly type: 'private' | 'group' | 'supergroup' | 'channel'
  readonly title?: string
}

/** One inbound message, flattened. */
export interface TelegramMessage {
  readonly messageId: number
  readonly chat: TelegramChat
  readonly fromId: number | undefined
  readonly text: string
  readonly threadId: number | undefined
  readonly isBot: boolean
}

/** One button press. */
export interface TelegramCallback {
  readonly id: string
  readonly chatId: number
  readonly messageId: number
  readonly data: string
  readonly fromId: number | undefined
  /** Forum topic the button lives in, when any. */
  readonly threadId: number | undefined
}

/** Normalized inbound update. */
export type InboundUpdate =
  | { readonly kind: 'message'; readonly updateId: number; readonly message: TelegramMessage }
  | { readonly kind: 'callback'; readonly updateId: number; readonly callback: TelegramCallback }

/** Raw Bot API update envelope, narrowed to the fields read here. */
interface RawUpdate {
  update_id: number
  message?: {
    message_id: number
    chat: TelegramChat
    from?: { id: number; is_bot?: boolean }
    text?: string
    message_thread_id?: number
    is_topic_message?: boolean
  }
  callback_query?: {
    id: string
    from?: { id: number }
    data?: string
    message?: { message_id: number; chat: TelegramChat; message_thread_id?: number; is_topic_message?: boolean }
  }
}

/** Options accepted by `sendMessage` and `editMessageText`. */
export interface SendOptions {
  readonly parseMode?: 'MarkdownV2' | undefined
  readonly keyboard?: readonly (readonly InlineButton[])[] | undefined
  readonly disablePreview?: boolean | undefined
  readonly threadId?: number | undefined
}

/** Bot API client for one token. */
export class TelegramApi {
  readonly #token: string
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch

  /**
   * @param options - token, base URL and optional fetch replacement.
   */
  constructor(options: TelegramOptions) {
    this.#token = options.token
    this.#baseUrl = options.baseUrl
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  /**
   * Invoke one Bot API method.
   * @param method - method name, for example `sendMessage`.
   * @param params - JSON body.
   * @returns the `result` field.
   */
  async call<T>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}/bot${this.#token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: signal === undefined ? AbortSignal.timeout(40_000) : AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
    })
    const body = await response.json() as {
      ok: boolean
      result?: T
      description?: string
      parameters?: { retry_after?: number }
    }
    if (!body.ok) {
      throw new TelegramError(method, body.description ?? 'request failed', response.status, body.parameters?.retry_after)
    }
    return body.result as T
  }

  /** Apply formatting options to a Bot API params object. */
  static decorate(params: Record<string, unknown>, options: SendOptions): Record<string, unknown> {
    if (options.parseMode !== undefined) params.parse_mode = options.parseMode
    if (options.disablePreview === true) {
      params.link_preview_options = { is_disabled: true }
    }
    if (options.threadId !== undefined) params.message_thread_id = options.threadId
    if (options.keyboard !== undefined) params.reply_markup = { inline_keyboard: options.keyboard }
    return params
  }

  /**
   * Send one message.
   * @param chatId - destination chat.
   * @param text - body.
   * @param options - formatting and keyboard.
   * @returns the new message id.
   */
  async sendMessage(chatId: number, text: string, options: SendOptions = {}): Promise<number> {
    const result = await this.call<{ message_id: number }>(
      'sendMessage',
      TelegramApi.decorate({ chat_id: chatId, text }, options),
    )
    return result.message_id
  }

  /**
   * Replace the body of an existing message.
   * @param chatId - owning chat.
   * @param messageId - message to edit.
   * @param text - new body.
   * @param options - formatting and keyboard; an empty keyboard removes buttons.
   */
  async editMessageText(chatId: number, messageId: number, text: string, options: SendOptions = {}): Promise<void> {
    await this.call('editMessageText', TelegramApi.decorate({ chat_id: chatId, message_id: messageId, text }, options))
  }

  /**
   * Remove one message.
   * @param chatId - owning chat.
   * @param messageId - message to delete.
   */
  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.call('deleteMessage', { chat_id: chatId, message_id: messageId })
  }

  /**
   * Answer a button press so the client stops its spinner.
   * @param id - callback query id.
   * @param text - optional toast text.
   */
  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', text === undefined ? { callback_query_id: id } : { callback_query_id: id, text })
  }

  /**
   * Pin one message so it stays visible above the conversation.
   * @param chatId - owning chat.
   * @param messageId - message to pin.
   */
  async pinChatMessage(chatId: number, messageId: number): Promise<void> {
    await this.call('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true })
  }

  /**
   * Remove one pinned message.
   * @param chatId - owning chat.
   * @param messageId - message to unpin.
   */
  async unpinChatMessage(chatId: number, messageId: number): Promise<void> {
    await this.call('unpinChatMessage', { chat_id: chatId, message_id: messageId })
  }

  /**
   * Show "typing" in the chat header, which is how a long turn stays visible.
   * @param chatId - destination chat.
   * @param threadId - forum topic, when any.
   */
  async sendChatAction(chatId: number, threadId?: number): Promise<void> {
    await this.call('sendChatAction', {
      chat_id: chatId,
      action: 'typing',
      ...(threadId === undefined ? {} : { message_thread_id: threadId }),
    })
  }

  /** Replace the command menu shown by Telegram clients. */
  async setMyCommands(commands: readonly { command: string; description: string }[]): Promise<void> {
    await this.call('setMyCommands', { commands })
  }

  /**
   * Long-poll for updates.
   * @param offset - first update id to accept.
   * @param timeoutSeconds - server-side hold time.
   * @param signal - aborts the long poll so shutdown is immediate.
   * @returns normalized updates.
   */
  async getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<readonly InboundUpdate[]> {
    const raw = await this.call<readonly RawUpdate[]>('getUpdates', {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    }, signal)
    const updates: InboundUpdate[] = []
    for (const update of raw) {
      const message = update.message
      if (message !== undefined && typeof message.text === 'string') {
        updates.push({
          kind: 'message',
          updateId: update.update_id,
          message: {
            messageId: message.message_id,
            chat: message.chat,
            fromId: message.from?.id,
            text: message.text,
            threadId: message.is_topic_message === true ? message.message_thread_id : undefined,
            isBot: message.from?.is_bot === true,
          },
        })
        continue
      }
      const callback = update.callback_query
      if (callback?.message !== undefined && typeof callback.data === 'string') {
        updates.push({
          kind: 'callback',
          updateId: update.update_id,
          callback: {
            id: callback.id,
            chatId: callback.message.chat.id,
            messageId: callback.message.message_id,
            data: callback.data,
            fromId: callback.from?.id,
            threadId: callback.message.is_topic_message === true ? callback.message.message_thread_id : undefined,
          },
        })
      }
    }
    return updates
  }
}
