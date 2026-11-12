/**
 * Lark as one {@link Channel}.
 *
 * Two surfaces differ in one structural way: Telegram edits a text message,
 * Lark patches an interactive card, so every turn is a card from the first
 * placeholder to the durable answer. Ids are `oc_…`/`om_…` strings, the
 * allowlist is open ids, and a button press arrives as a WebSocket callback
 * whose response carries the toast the presser sees.
 *
 * @module hulala-bot/lark/channel
 */
import type {
  Channel,
  ChatKey,
  InboundCallback,
  InboundEvent,
  Outgoing,
  SendOptions,
} from '../channel.ts'
import type { LarkChannelConfig } from '../config.ts'
import { Log } from '../log.ts'
import { UpdateLedger } from '../store/ledger.ts'
import { LarkApi, LarkError } from './api.ts'
import { buildCard, stripMentions } from './card.ts'
import { formatMarkdown } from './format.ts'
import type { LarkActionEvent, LarkMessageEvent, LarkTransport } from './ws.ts'

/** What the Lark channel needs from outside. */
export interface LarkChannelOptions {
  readonly api: LarkApi
  readonly transport: LarkTransport
  readonly config: LarkChannelConfig
  readonly ledger: UpdateLedger
  readonly log: Log
}

/** Lark, speaking the bridge's channel contract. */
export class LarkChannel implements Channel {
  readonly name = 'lark' as const
  readonly maxTextLength = 4000
  readonly pinnedStatus = false
  readonly #api: LarkApi
  readonly #transport: LarkTransport
  readonly #config: LarkChannelConfig
  readonly #ledger: UpdateLedger
  readonly #log: Log
  /** Toast text for the callback currently being handled, keyed by message id. */
  readonly #toasts = new Map<string, string>()

  /** @param options - client, transport, configuration and collaborators. */
  constructor(options: LarkChannelOptions) {
    this.#api = options.api
    this.#transport = options.transport
    this.#config = options.config
    this.#ledger = options.ledger
    this.#log = options.log
  }

  /** @param text - agent Markdown, reduced to what `lark_md` renders. */
  format(text: string): string {
    return formatMarkdown(text)
  }

  /** Allowlist: either list may admit; both empty refuses everything. */
  #allowed(chatId: string, userId: string | undefined): boolean {
    const { allowedChats, allowedUsers } = this.#config
    if (allowedChats.length === 0 && allowedUsers.length === 0) return false
    if (allowedChats.length > 0 && allowedChats.includes(chatId)) return true
    if (allowedUsers.length > 0 && userId !== undefined && allowedUsers.includes(userId)) return true
    return false
  }

  /** One card built from one projection part. */
  #card(text: string, options: SendOptions): string {
    return JSON.stringify(buildCard(text, { buttons: options.keyboard }))
  }

  /** Send one card per part. */
  async send(chat: ChatKey, body: Outgoing, options: SendOptions = {}): Promise<string | undefined> {
    let first: string | undefined
    for (const part of body.parts) {
      const messageId = await this.#api.sendCard(chat.chatId, this.#card(part, options))
      first ??= messageId
    }
    return first
  }

  /** Patch one card in place. */
  async edit(chat: ChatKey, messageId: string, body: Outgoing, options: SendOptions = {}): Promise<void> {
    void chat
    await this.#api.patchCard(messageId, this.#card(body.parts[0] ?? body.text, options))
  }

  /** Recall one card. */
  async delete(chat: ChatKey, messageId: string): Promise<void> {
    void chat
    await this.#api.deleteMessage(messageId)
    this.#toasts.delete(messageId)
  }

  /** Remember the toast; the callback response picks it up. */
  async answer(event: InboundCallback, text?: string): Promise<void> {
    if (text !== undefined && text !== '') this.#toasts.set(event.messageId, text)
  }

  /** @param error - value thrown by a Lark call. */
  retryAfterMs(error: unknown): number | undefined {
    return error instanceof LarkError && error.isThrottled ? 1000 : undefined
  }

  /** @param error - value thrown by a Lark call. */
  isMissing(error: unknown): boolean {
    return error instanceof LarkError && /not found|not exist|已撤回|no message/i.test(error.message)
  }

  /** Open the long connection and deliver events until the signal aborts. */
  async start(onEvent: (event: InboundEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
    await this.#transport.start({
      message: event => { void this.#onMessage(event, onEvent) },
      action: event => this.#onAction(event, onEvent),
    })
    await new Promise<void>(resolve => {
      if (signal.aborted) { resolve(); return }
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    this.#transport.close()
  }

  /** Normalize one inbound message. */
  async #onMessage(event: LarkMessageEvent, onEvent: (event: InboundEvent) => Promise<void>): Promise<void> {
    try {
      const message = event.message
      if (message === undefined) return
      const senderType = event.sender?.sender_type ?? ''
      if (senderType !== 'user') return
      const userId = event.sender?.sender_id?.open_id
      if (userId === undefined) return
      const chatId = message.chat_id
      if (!this.#allowed(chatId, userId)) {
        this.#log.info(`ignored chat=${chatId} from=${userId} (not in allowlist)`)
        return
      }
      const eventId = event.event_id ?? message.message_id
      if (this.#ledger.seen(eventId)) return
      await this.#ledger.flush().catch(() => undefined)
      if (message.message_type !== 'text') {
        this.#log.info(`ignored ${message.message_type} message in ${chatId}`)
        await this.#api.sendText(chatId, '只支持文字消息。').catch(() => undefined)
        return
      }
      const text = stripMentions(textOf(message.content))
      if (text === '') return
      this.#log.info(`message chat=${chatId} from=${userId} len=${String(text.length)}`)
      await onEvent({
        kind: 'message',
        chat: { channel: 'lark', chatId },
        userId,
        text,
        fromBot: false,
        messageId: message.message_id,
      })
    } catch (error) {
      this.#log.error(`lark message failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Normalize one card action and build its response. */
  async #onAction(event: LarkActionEvent, onEvent: (event: InboundEvent) => Promise<void>): Promise<unknown> {
    const chatId = event.context?.open_chat_id ?? event.open_chat_id
    const messageId = event.context?.open_message_id ?? event.open_message_id
    const userId = event.operator?.open_id
    const data = actionData(event)
    if (chatId === undefined || messageId === undefined || userId === undefined || data === undefined) return {}
    if (!this.#allowed(chatId, userId)) return { toast: { type: 'error', content: '没有权限' } }
    try {
      await onEvent({
        kind: 'callback',
        chat: { channel: 'lark', chatId },
        userId,
        callbackId: messageId,
        messageId,
        data,
      })
    } catch (error) {
      this.#log.error(`callback failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const toast = this.#toasts.get(messageId)
    this.#toasts.delete(messageId)
    return toast === undefined ? {} : { toast: { type: 'success', content: toast } }
  }
}

/**
 * Text of a Feishu message content document.
 * @param content - JSON string from the event.
 * @returns the text field, or an empty string.
 */
function textOf(content: string | undefined): string {
  if (content === undefined) return ''
  try {
    const parsed = JSON.parse(content) as { text?: unknown }
    return typeof parsed.text === 'string' ? parsed.text : ''
  } catch {
    return ''
  }
}

/**
 * Button payload of one action.
 * @param event - raw card action.
 * @returns the `data` string the button carried.
 */
function actionData(event: LarkActionEvent): string | undefined {
  const value = event.action?.value
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'object' && 'data' in value) {
    const data = (value as { data?: unknown }).data
    return typeof data === 'string' ? data : undefined
  }
  return undefined
}
