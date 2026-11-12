/**
 * The Lark long connection.
 *
 * Events and card callbacks arrive over a WebSocket in Feishu's protobuf
 * framing, which is the one thing worth taking the official SDK for: it
 * negotiates the endpoint, keeps the socket alive, reconnects, and merges
 * fragmented frames. Nothing else here uses the SDK — REST goes through
 * `api.ts`, so tests never load protobuf.
 *
 * The long connection is the only transport that fits a local-first Host: no
 * public URL, no tunnel, no inbound port, and it works behind NAT.
 *
 * @module hulala-bot/lark/ws
 */
import type { LarkDomain } from '../config.ts'

/** One `im.message.receive_v1` event, narrowed to the fields read here. */
export interface LarkMessageEvent {
  readonly event_id?: string
  readonly sender?: {
    readonly sender_type?: string
    readonly sender_id?: { readonly open_id?: string }
  }
  readonly message?: {
    readonly message_id: string
    readonly chat_id: string
    readonly chat_type?: string
    readonly message_type: string
    readonly content?: string
  }
}

/** One `application.bot.menu_v6` click: the bot menu has no chat context. */
export interface LarkMenuEvent {
  readonly event_id?: string
  readonly event_key?: string
  readonly operator?: {
    readonly operator_id?: { readonly open_id?: string }
  }
}

/** One `card.action.trigger` callback, in both observed shapes. */
export interface LarkActionEvent {
  readonly context?: { readonly open_message_id?: string; readonly open_chat_id?: string }
  readonly open_message_id?: string
  readonly open_chat_id?: string
  readonly operator?: { readonly open_id?: string; readonly name?: string }
  readonly action?: { readonly value?: unknown; readonly tag?: string }
}

/** What the channel gives the transport. */
export interface LarkHandlers {
  readonly message: (event: LarkMessageEvent) => void
  readonly action: (event: LarkActionEvent) => Promise<unknown>
  readonly menu: (event: LarkMenuEvent) => void
}

/** A long connection; replaceable in tests. */
export interface LarkTransport {
  /** Open the connection and dispatch events until {@link close}. */
  start(handlers: LarkHandlers): Promise<void>
  /** Close the connection; safe to call twice. */
  close(): void
}

/** Transport options. */
export interface LarkTransportOptions {
  readonly appId: string
  readonly appSecret: string
  readonly domain: LarkDomain
  /** Reports a failed connection attempt; the client keeps reconnecting. */
  readonly onError?: (error: Error) => void
}

/**
 * Create the SDK-backed long connection.
 *
 * The SDK is imported on first use, so a Telegram-only bot never loads protobuf
 * and `--init` works before the dependency is even installed.
 * @param options - credentials, domain and error sink.
 * @returns the transport.
 */
export function createSdkTransport(options: LarkTransportOptions): LarkTransport {
  let client: { close(params?: { force?: boolean }): void } | undefined
  return {
    async start(handlers) {
      const sdk = await import('@larksuiteoapi/node-sdk')
      const dispatcher = new sdk.EventDispatcher({})
      dispatcher.register({
        'im.message.receive_v1': (event: LarkMessageEvent) => {
          handlers.message(event)
        },
        'card.action.trigger': async (event: LarkActionEvent) => await handlers.action(event),
        'application.bot.menu_v6': (event: LarkMenuEvent) => { handlers.menu(event) },
      })
      const ws = new sdk.WSClient({
        appId: options.appId,
        appSecret: options.appSecret,
        domain: options.domain === 'lark' ? sdk.Domain.Lark : sdk.Domain.Feishu,
        loggerLevel: sdk.LoggerLevel.warn,
        ...(options.onError === undefined ? {} : { onError: options.onError }),
      })
      client = ws
      await ws.start({ eventDispatcher: dispatcher })
    },
    close() {
      client?.close({ force: true })
      client = undefined
    },
  }
}
