/**
 * The one interface every chat surface implements.
 *
 * The bridge owns session logic — mounting, prompting, approvals, the pinned
 * status — and knows nothing about how a message travels. Telegram and Lark
 * differ in almost everything else: ids are numbers versus `oc_` strings,
 * formatting is MarkdownV2 versus `lark_md`, streaming is an edited message
 * versus a patched card, and a button press answers an HTTP callback versus a
 * WebSocket frame. Those differences stop here.
 *
 * @module hulala-bot/channel
 */

/** Surfaces this bot speaks. Also the first segment of every binding key. */
export type ChannelName = 'telegram' | 'lark'

/** One conversation; a Telegram forum topic is its own conversation. */
export interface ChatKey {
  readonly channel: ChannelName
  /** Chat id as the surface spells it: a number for Telegram, `oc_…` for Lark. */
  readonly chatId: string
  readonly threadId?: string | undefined
}

/**
 * One message as the caller projects it: the raw agent text, its surface
 * projection, and that projection split into sendable parts. Carrying all three
 * is what lets a channel retry a rejected projection in plain text without
 * re-asking the bridge what the agent actually wrote.
 */
export interface Outgoing {
  readonly raw: string
  readonly text: string
  readonly parts: readonly string[]
}

/** One inline button. */
export interface Button {
  readonly text: string
  readonly data: string
}

/** Rows of buttons. */
export type Keyboard = readonly (readonly Button[])[]

/** Extra instructions for one send or edit. */
export interface SendOptions {
  readonly keyboard?: Keyboard
  /** Link previews: on by default, so only an explicit `false` disables them. */
  readonly preview?: boolean
}

/** One inbound image, already downloaded and base64-encoded for the Host. */
export interface InboundImage {
  readonly mediaType: string
  readonly data: string
  readonly name?: string | undefined
}

/** One inbound message, already allowlisted. */
export interface InboundMessage {
  readonly kind: 'message'
  readonly chat: ChatKey
  readonly userId: string
  readonly text: string
  readonly fromBot: boolean
  readonly messageId: string
  /** Attached images; the text may be empty when only images were sent. */
  readonly images?: readonly InboundImage[] | undefined
}

/** One outbound image: a file the agent referenced and this channel should attach. */
export interface OutgoingImage {
  readonly data: Uint8Array
  readonly mediaType: string
  readonly caption?: string | undefined
}

/** One inbound button press, already allowlisted. */
export interface InboundCallback {
  readonly kind: 'callback'
  readonly chat: ChatKey
  readonly userId: string
  readonly callbackId: string
  readonly messageId: string
  readonly data: string
}

/** Everything a channel delivers to the bridge. */
export type InboundEvent = InboundMessage | InboundCallback

/**
 * One chat surface.
 *
 * `send` and `edit` take raw agent Markdown: each channel applies its own
 * projection and its own plain-text fallback, because only it knows what its
 * API rejects.
 */
export interface Channel {
  readonly name: ChannelName
  /** Characters one message may carry; the reply stream splits above it. */
  readonly maxTextLength: number
  /** Whether this surface has a pinned status message the bridge maintains. */
  readonly pinnedStatus: boolean
  /** Project agent Markdown for this surface. */
  format(text: string): string
  /**
   * Send one message, in as many parts as its projection needs.
   * @returns the id of the first part, when the surface reports it.
   */
  send(chat: ChatKey, body: Outgoing, options?: SendOptions): Promise<string | undefined>
  /** Replace one message this bot sent with the first part of `body`. */
  edit(chat: ChatKey, messageId: string, body: Outgoing, options?: SendOptions): Promise<void>
  /** Delete one message this bot sent; missing messages are not an error. */
  delete(chat: ChatKey, messageId: string): Promise<void>
  /** Attach one image, when the surface can carry it. */
  sendImage?(chat: ChatKey, image: OutgoingImage): Promise<void>
  /** Acknowledge a button press, optionally telling the presser why nothing happened. */
  answer(event: InboundCallback, text?: string): Promise<void>
  /** Pin a message, when the surface supports it. */
  pin?(chat: ChatKey, messageId: string): Promise<void>
  /** Unpin a message, when the surface supports it. */
  unpin?(chat: ChatKey, messageId: string): Promise<void>
  /** Show a typing indicator for one conversation. */
  typing?(chat: ChatKey): Promise<void>
  /**
   * How long to wait after a flood-control rejection.
   * @returns milliseconds, or undefined when this error is not a throttle.
   */
  retryAfterMs?(error: unknown): number | undefined
  /**
   * Whether an edit failure means the message no longer exists, so a status
   * message must be re-sent rather than edited again.
   */
  isMissing?(error: unknown): boolean
  /**
   * Connect and deliver events until the signal aborts. Must not reject after
   * the first event: transports reconnect on their own and report failures to
   * the log.
   */
  start(onEvent: (event: InboundEvent) => Promise<void>, signal: AbortSignal): Promise<void>
}
