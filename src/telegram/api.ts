/**
 * Minimal Bot API client: JSON over HTTPS, no framework.
 *
 * Only the calls this bridge uses are implemented. A 429 surfaces the server's
 * `retry_after` so callers can back off instead of hammering; a failed send
 * never throws out of the polling loop.
 *
 * @module hulala-bot/telegram/api
 */
import { createProxiedFetch } from './proxy.ts'

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

/** Transport options; tests inject a base URL and fetch, users may set a proxy. */
export interface TelegramOptions {
  readonly token: string
  readonly baseUrl: string
  readonly proxy?: string | undefined
  readonly fetch?: typeof globalThis.fetch
}

/** A Telegram user or chat identity, reduced to what routing needs. */
export interface TelegramChat {
  readonly id: number
  readonly type: 'private' | 'group' | 'supergroup' | 'channel'
  readonly title?: string
}

/** One image attached to a Telegram message, still on Telegram's servers. */
export interface TelegramImage {
  readonly fileId: string
  readonly mediaType: string
  readonly name?: string | undefined
  readonly size: number
}

/** Largest image this bot downloads from Telegram. */
export const TELEGRAM_IMAGE_LIMIT = 10 * 1024 * 1024

/** One inbound message, flattened. */
export interface TelegramMessage {
  readonly messageId: number
  readonly chat: TelegramChat
  readonly fromId: number | undefined
  readonly text: string
  readonly threadId: number | undefined
  readonly isBot: boolean
  /** Photos and image documents; empty for a plain text message. */
  readonly images: readonly TelegramImage[]
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
  /** An update this bot has no use for; it still has to be confirmed by offset. */
  | {
    readonly kind: 'ignored'
    readonly updateId: number
    readonly reason: string
    /** Present when the ignored update was a message, so the bot can answer. */
    readonly chatId?: number
    readonly threadId?: number
    readonly fromId?: number
  }

/** Raw Bot API update envelope, narrowed to the fields read here. */
interface RawUpdate {
  update_id: number
  message?: {
    message_id: number
    chat: TelegramChat
    from?: { id: number; is_bot?: boolean }
    text?: string
    caption?: string
    message_thread_id?: number
    is_topic_message?: boolean
    photo?: readonly { file_id: string; file_size?: number; width: number; height: number }[]
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
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
    this.#fetch = options.fetch
      ?? (options.proxy === undefined ? globalThis.fetch : createProxiedFetch(options.proxy))
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
   * @returns normalized updates, including ignored ones so the offset advances.
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
      if (message !== undefined) {
        const images: TelegramImage[] = []
        const photo = message.photo ?? []
        if (photo.length > 0) {
          // Telegram sends the same photo at several sizes; the largest is the
          // one worth downloading and the only one the model should see.
          const largest = [...photo].sort((left, right) => right.width * right.height - left.width * left.height)[0] as NonNullable<typeof photo>[number]
          images.push({ fileId: largest.file_id, mediaType: 'image/jpeg', size: largest.file_size ?? 0 })
        } else if (message.document?.mime_type?.startsWith('image/') === true) {
          images.push({
            fileId: message.document.file_id,
            mediaType: message.document.mime_type,
            size: message.document.file_size ?? 0,
            ...(message.document.file_name === undefined ? {} : { name: message.document.file_name }),
          })
        }
        const text = message.text ?? message.caption ?? ''
        if (text !== '' || images.length > 0) {
          updates.push({
            kind: 'message',
            updateId: update.update_id,
            message: {
              messageId: message.message_id,
              chat: message.chat,
              fromId: message.from?.id,
              text,
              threadId: message.is_topic_message === true ? message.message_thread_id : undefined,
              isBot: message.from?.is_bot === true,
              images,
            },
          })
          continue
        }
        updates.push({
          kind: 'ignored',
          updateId: update.update_id,
          reason: 'unsupported message type',
          chatId: message.chat.id,
          ...(message.is_topic_message === true && message.message_thread_id !== undefined
            ? { threadId: message.message_thread_id }
            : {}),
          ...(message.from?.id === undefined ? {} : { fromId: message.from.id }),
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
        continue
      }
      updates.push({ kind: 'ignored', updateId: update.update_id, reason: 'unhandled update' })
    }
    return updates
  }

  /**
   * Download one file the Bot API is serving.
   * @param fileId - `file_id` from a message.
   * @returns the bytes.
   */
  async downloadFile(fileId: string): Promise<Uint8Array> {
    const file = await this.call<{ file_path: string }>('getFile', { file_id: fileId })
    const response = await this.#fetch(`${this.#baseUrl}/file/bot${this.#token}/${file.file_path}`, {
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new TelegramError('getFile', `download failed (${String(response.status)})`, response.status)
    return new Uint8Array(await response.arrayBuffer())
  }

  /**
   * Send one photo. Telegram takes the bytes as multipart, which is why the
   * proxied transport knows how to encode a `FormData` body.
   * @param chatId - destination chat.
   * @param bytes - encoded image.
   * @param mediaType - image MIME type.
   * @param options - caption and thread.
   * @returns the new message id.
   */
  async sendPhoto(
    chatId: number,
    bytes: Uint8Array,
    mediaType: string,
    options: { caption?: string; threadId?: number } = {},
  ): Promise<number> {
    const form = new FormData()
    form.append('chat_id', String(chatId))
    if (options.caption !== undefined && options.caption !== '') form.append('caption', options.caption.slice(0, 1024))
    if (options.threadId !== undefined) form.append('message_thread_id', String(options.threadId))
    const extension = mediaType === 'image/png' ? '.png' : mediaType === 'image/webp' ? '.webp' : mediaType === 'image/gif' ? '.gif' : '.jpg'
    form.append('photo', new Blob([bytes], { type: mediaType }), `image${extension}`)
    const response = await this.#fetch(`${this.#baseUrl}/bot${this.#token}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000),
    })
    const body = await response.json() as {
      ok: boolean
      result?: { message_id: number }
      description?: string
      parameters?: { retry_after?: number }
    }
    if (!body.ok) {
      throw new TelegramError('sendPhoto', body.description ?? 'request failed', response.status, body.parameters?.retry_after)
    }
    return (body.result as { message_id: number }).message_id
  }
}
