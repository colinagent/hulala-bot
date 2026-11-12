/**
 * Minimal Lark open-platform client: JSON over HTTPS, no SDK.
 *
 * The SDK is only needed for the WebSocket transport (its event framing is
 * protobuf). REST is four endpoints, so doing it here keeps the API injectable:
 * tests point `baseUrl` at a local server and never touch Feishu.
 *
 * @module hulala-bot/lark/api
 */
import { createProxiedFetch } from '../telegram/proxy.ts'

/** One open-platform failure. */
export class LarkError extends Error {
  /** Endpoint label, for example `im/v1/messages`. */
  readonly method: string
  /** Platform error code; `0` means success and never reaches here. */
  readonly code: number
  /** HTTP status. */
  readonly status: number

  /**
   * @param method - endpoint label.
   * @param message - platform-supplied message.
   * @param code - platform error code.
   * @param status - HTTP status.
   */
  constructor(method: string, message: string, code: number, status: number) {
    super(`${method}: ${message} (${String(code)})`)
    this.name = 'LarkError'
    this.method = method
    this.code = code
    this.status = status
  }

  /** Whether the tenant token was rejected and a refresh will help. */
  get isTokenInvalid(): boolean {
    return this.code === 99991661 || this.code === 99991663
  }

  /** Whether this failure is the platform asking us to slow down. */
  get isThrottled(): boolean {
    return this.status === 429 || this.code === 99991400
  }
}

/** Client options; tests inject a base URL and fetch. */
export interface LarkOptions {
  readonly appId: string
  readonly appSecret: string
  readonly baseUrl: string
  readonly proxy?: string | undefined
  readonly fetch?: typeof globalThis.fetch
}

/** Response envelope every endpoint uses. */
interface Envelope<T> {
  readonly code: number
  readonly msg: string
  readonly tenant_access_token?: string
  readonly expire?: number
  readonly data?: T
}

/** One tenant access token, cached until shortly before it expires. */
interface Token {
  readonly value: string
  readonly expiresAt: number
}

/** Open-platform client for one app. */
export class LarkApi {
  readonly #appId: string
  readonly #appSecret: string
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch
  #token: Token | undefined

  /**
   * @param options - credentials, base URL and optional fetch replacement.
   */
  constructor(options: LarkOptions) {
    this.#appId = options.appId
    this.#appSecret = options.appSecret
    this.#baseUrl = options.baseUrl
    this.#fetch = options.fetch
      ?? (options.proxy === undefined ? globalThis.fetch : createProxiedFetch(options.proxy))
  }

  /** Current tenant token, refreshed when it is close to expiring. */
  async #accessToken(): Promise<string> {
    const cached = this.#token
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value
    const envelope = await this.#request<never>('auth/v3/tenant_access_token/internal', {
      method: 'POST',
      body: { app_id: this.#appId, app_secret: this.#appSecret },
      authenticated: false,
    })
    const value = envelope.tenant_access_token ?? ''
    if (value === '') throw new Error('Lark returned no tenant access token')
    const lifetime = Number(envelope.expire ?? 7200)
    this.#token = { value, expiresAt: Date.now() + Math.max(60, lifetime - 120) * 1000 }
    return value
  }

  /**
   * Invoke one endpoint.
   * @param path - path below `/open-apis`.
   * @param options - method, body, query and whether a token is needed.
   * @returns the envelope.
   */
  async #request<T>(
    path: string,
    options: { method: string; body?: unknown; query?: string; authenticated?: boolean },
    retried = false,
  ): Promise<Envelope<T>> {
    const token = options.authenticated === false ? undefined : await this.#accessToken()
    const response = await this.#fetch(
      `${this.#baseUrl}/${path}${options.query === undefined ? '' : `?${options.query}`}`,
      {
        method: options.method,
        headers: {
          'content-type': 'application/json',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(30_000),
      },
    )
    const text = await response.text()
    let envelope: Envelope<T>
    try {
      envelope = JSON.parse(text) as Envelope<T>
    } catch {
      throw new LarkError(path, `unreadable response (${String(response.status)})`, 0, response.status)
    }
    if (envelope.code !== 0) {
      const error = new LarkError(path, envelope.msg, envelope.code, response.status)
      if (error.isTokenInvalid && !retried) {
        this.#token = undefined
        return await this.#request<T>(path, options, true)
      }
      throw error
    }
    return envelope
  }

  /**
   * Send one interactive card.
   * @param chatId - `oc_…` chat id.
   * @param content - card JSON.
   * @returns the new message id.
   */
  async sendCard(chatId: string, content: string): Promise<string> {
    const envelope = await this.#request<{ message_id: string }>('im/v1/messages', {
      method: 'POST',
      query: 'receive_id_type=chat_id',
      body: { receive_id: chatId, msg_type: 'interactive', content },
    })
    const messageId = envelope.data?.message_id
    if (messageId === undefined) throw new Error('Lark returned no message id')
    return messageId
  }

  /**
   * Send one plain text message.
   * @param chatId - `oc_…` chat id.
   * @param text - body.
   * @returns the new message id.
   */
  async sendText(chatId: string, text: string): Promise<string> {
    const envelope = await this.#request<{ message_id: string }>('im/v1/messages', {
      method: 'POST',
      query: 'receive_id_type=chat_id',
      body: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    })
    const messageId = envelope.data?.message_id
    if (messageId === undefined) throw new Error('Lark returned no message id')
    return messageId
  }

  /**
   * Send one interactive card to a user's private chat.
   *
   * The bot menu carries no chat id, only the operator's open id, so this is the
   * only way to answer a menu click. Feishu opens the p2p chat when it does not
   * exist yet, and the response names it, which is what lets the next click run
   * a session command in the same conversation.
   * @param openId - `ou_…` user id.
   * @param content - card JSON.
   * @returns the new message and the p2p chat it landed in.
   */
  async sendCardToUser(openId: string, content: string): Promise<{ messageId: string; chatId: string }> {
    const envelope = await this.#request<{ message_id: string; chat_id: string }>('im/v1/messages', {
      method: 'POST',
      query: 'receive_id_type=open_id',
      body: { receive_id: openId, msg_type: 'interactive', content },
    })
    const messageId = envelope.data?.message_id
    const chatId = envelope.data?.chat_id
    if (messageId === undefined || chatId === undefined) throw new Error('Lark returned no message id')
    return { messageId, chatId }
  }

  /**
   * Replace the content of one card this app sent.
   * @param messageId - `om_…` message id.
   * @param content - card JSON.
   */
  async patchCard(messageId: string, content: string): Promise<void> {
    await this.#request(`im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: { content },
    })
  }

  /**
   * Recall one message this app sent.
   * @param messageId - `om_…` message id.
   */
  async deleteMessage(messageId: string): Promise<void> {
    await this.#request(`im/v1/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' })
  }
}
