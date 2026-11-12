/**
 * Telegram as one {@link Channel}.
 *
 * Everything Telegram-specific stops in this file: numeric chat ids, the
 * MarkdownV2 projection and its plain-text fallback, inline keyboards, pinned
 * status messages, typing indicators, long polling, and the update ledger that
 * keeps a re-delivered update from prompting the agent twice.
 *
 * @module hulala-bot/telegram/channel
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { splitMessage } from '../render/split.ts'
import { toMarkdownV2 } from '../render/markdown.ts'
import type {
  Channel,
  ChatKey,
  InboundCallback,
  InboundEvent,
  InboundImage,
  Keyboard,
  Outgoing,
  OutgoingImage,
  SendOptions,
} from '../channel.ts'
import type { TelegramChannelConfig } from '../config.ts'
import { Log } from '../log.ts'
import { TELEGRAM_IMAGE_LIMIT, TelegramApi, TelegramError, type InboundUpdate, type TelegramMessage } from './api.ts'
import { UpdateLedger } from '../store/ledger.ts'

/** How Telegram ids are spelled on the wire versus in a binding key. */
function numeric(value: string, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`not a Telegram ${label}: ${value}`)
  return parsed
}

/** Command menu published to Telegram clients. */
export interface CommandEntry {
  readonly command: string
  readonly description: string
}

/** What the Telegram channel needs from outside. */
export interface TelegramChannelOptions {
  readonly api: TelegramApi
  readonly config: TelegramChannelConfig
  readonly ledger: UpdateLedger
  readonly log: Log
  readonly commands: readonly CommandEntry[]
  /** Where inbound images are saved before their paths go to the agent. */
  readonly inboxDir: string
}

/** Telegram, speaking the bridge's channel contract. */
export class TelegramChannel implements Channel {
  readonly name = 'telegram' as const
  readonly maxTextLength = 4000
  readonly pinnedStatus = true
  readonly #api: TelegramApi
  readonly #config: TelegramChannelConfig
  readonly #ledger: UpdateLedger
  readonly #log: Log
  readonly #commands: readonly CommandEntry[]
  readonly #inboxDir: string
  /** Formatting degrades to plain text on the first rejected projection. */
  #plain: boolean

  /** @param options - client, configuration and collaborators. */
  constructor(options: TelegramChannelOptions) {
    this.#api = options.api
    this.#config = options.config
    this.#ledger = options.ledger
    this.#log = options.log
    this.#commands = options.commands
    this.#inboxDir = options.inboxDir
    this.#plain = options.config.parseMode === 'plain'
  }

  /** @param text - agent Markdown. */
  format(text: string): string {
    return this.#plain ? text : toMarkdownV2(text)
  }

  /** Allowlist: either list may admit; both empty refuses everything. */
  #allowed(chatId: number, userId: number | undefined): boolean {
    const { allowedChats, allowedUsers } = this.#config
    if (allowedChats.length === 0 && allowedUsers.length === 0) return false
    if (allowedChats.length > 0 && allowedChats.includes(chatId)) return true
    if (allowedUsers.length > 0 && userId !== undefined && allowedUsers.includes(userId)) return true
    return false
  }

  /** Conversation key for one message. */
  #key(chatId: number, threadId: number | undefined): ChatKey {
    return {
      channel: 'telegram',
      chatId: String(chatId),
      ...(threadId === undefined ? {} : { threadId: String(threadId) }),
    }
  }

  /** Bot API options for one send or edit. */
  #transport(chat: ChatKey, options: SendOptions): {
    parseMode?: 'MarkdownV2' | undefined
    keyboard?: readonly (readonly { text: string; callback_data: string }[])[] | undefined
    disablePreview?: boolean | undefined
    threadId?: number | undefined
  } {
    return {
      ...(this.#plain ? {} : { parseMode: 'MarkdownV2' as const }),
      ...(options.keyboard === undefined ? {} : { keyboard: this.#keyboard(options.keyboard) }),
      ...(options.preview === false ? { disablePreview: true } : {}),
      ...(chat.threadId === undefined ? {} : { threadId: numeric(chat.threadId, 'thread id') }),
    }
  }

  /** Project the channel's buttons onto Bot API inline buttons. */
  #keyboard(keyboard: Keyboard): readonly (readonly { text: string; callback_data: string }[])[] {
    return keyboard.map(row => row.map(button => ({ text: button.text, callback_data: button.data })))
  }

  /** Send every part, retrying the rejected one in plain text. */
  async send(chat: ChatKey, body: Outgoing, options: SendOptions = {}): Promise<string | undefined> {
    const chatId = numeric(chat.chatId, 'chat id')
    let parts = body.parts
    let first: number | undefined
    let index = 0
    while (index < parts.length) {
      try {
        const messageId = await this.#api.sendMessage(chatId, parts[index] as string, this.#transport(chat, options))
        first ??= messageId
        index += 1
      } catch (error) {
        if (this.#plain || !(error instanceof TelegramError) || !error.isBadRequest) throw error
        this.#log.error(`markdown rejected, retrying plain: ${error.description}`)
        this.#plain = true
        parts = splitMessage(body.raw, this.maxTextLength)
      }
    }
    return first === undefined ? undefined : String(first)
  }

  /** Edit one message, retrying a rejected projection in plain text. */
  async edit(chat: ChatKey, messageId: string, body: Outgoing, options: SendOptions = {}): Promise<void> {
    const chatId = numeric(chat.chatId, 'chat id')
    const id = numeric(messageId, 'message id')
    const attempt = async (text: string): Promise<void> => {
      await this.#api.editMessageText(chatId, id, text, this.#transport(chat, options))
    }
    try {
      await attempt(this.#plain
        ? (splitMessage(body.raw, this.maxTextLength)[0] ?? body.raw)
        : (body.parts[0] ?? body.text))
    } catch (error) {
      if (error instanceof TelegramError && error.isBadRequest && !this.#plain) {
        this.#plain = true
        try {
          await attempt(splitMessage(body.raw, this.maxTextLength)[0] ?? body.raw)
          return
        } catch (retry) {
          if (isNotModified(retry)) return
          throw retry
        }
      }
      if (isNotModified(error)) return
      throw error
    }
  }

  /** Delete one message; a message that is already gone is fine. */
  async delete(chat: ChatKey, messageId: string): Promise<void> {
    try {
      await this.#api.deleteMessage(numeric(chat.chatId, 'chat id'), numeric(messageId, 'message id'))
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }

  /** Stop the button spinner, optionally explaining that it was already handled. */
  async answer(event: InboundCallback, text?: string): Promise<void> {
    await this.#api.answerCallbackQuery(event.callbackId, text)
  }

  /** Pin one message above the conversation. */
  async pin(chat: ChatKey, messageId: string): Promise<void> {
    await this.#api.pinChatMessage(numeric(chat.chatId, 'chat id'), numeric(messageId, 'message id'))
  }

  /** Remove one pinned message. */
  async unpin(chat: ChatKey, messageId: string): Promise<void> {
    await this.#api.unpinChatMessage(numeric(chat.chatId, 'chat id'), numeric(messageId, 'message id'))
  }

  /** Show "typing" in the chat header. */
  async typing(chat: ChatKey): Promise<void> {
    await this.#api.sendChatAction(
      numeric(chat.chatId, 'chat id'),
      chat.threadId === undefined ? undefined : numeric(chat.threadId, 'thread id'),
    )
  }

  /** @param error - value thrown by a Bot API call. */
  retryAfterMs(error: unknown): number | undefined {
    return error instanceof TelegramError && error.isFlood ? (error.retryAfter ?? 1) * 1000 : undefined
  }

  /** @param error - value thrown by a Bot API call. */
  isMissing(error: unknown): boolean {
    return isMissing(error)
  }

  /** Publish the command menu, then long-poll until the signal aborts. */
  async start(onEvent: (event: InboundEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
    void this.#api
      .setMyCommands(this.#commands.map(command => ({ command: command.command, description: command.description })))
      .catch(error => { this.#log.error(`setMyCommands failed: ${String(error)}`) })
    let offset = this.#ledger.cursor === 0 ? 0 : this.#ledger.cursor + 1
    let failures = 0
    while (!signal.aborted) {
      try {
        const updates = await this.#api.getUpdates(offset, this.#config.pollTimeoutSeconds, signal)
        failures = 0
        for (const update of updates) {
          offset = update.updateId + 1
          if (this.#ledger.seen(update.updateId)) continue
          this.#log.info(`update ${String(update.updateId)} ${describe(update)}`)
          if (update.kind === 'ignored') {
            // The offset moves on, and the sender is told why nothing happened
            // instead of waiting for an answer that will never come.
            if (update.chatId !== undefined && this.#allowed(update.chatId, update.fromId)) {
              await this.send(this.#key(update.chatId, update.threadId), {
                raw: '只支持文字和图片消息。',
                text: '只支持文字和图片消息。',
                parts: ['只支持文字和图片消息。'],
              }).catch(() => undefined)
            }
            continue
          }
          const event = await this.#eventOf(update)
          if (event === undefined) continue
          try {
            await onEvent(event)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.#log.error(`update ${String(update.updateId)} failed: ${message}`)
            if (event.kind === 'message') {
              await this.send(event.chat, {
                raw: 'Host 现在不可用，这次请求没有送出去。确认 Host 在运行后再发一次。',
                text: 'Host 现在不可用，这次请求没有送出去。确认 Host 在运行后再发一次。',
                parts: ['Host 现在不可用，这次请求没有送出去。确认 Host 在运行后再发一次。'],
              }).catch(() => undefined)
            }
          }
        }
        await this.#ledger.flush().catch(() => undefined)
      } catch (error) {
        if (signal.aborted) return
        failures += 1
        const wait = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))
        this.#log.error(`polling failed (${String(failures)}): ${error instanceof Error ? error.message : String(error)}`)
        await new Promise(settle => setTimeout(settle, wait))
      }
    }
  }

  /** Normalize one update, dropping anything the allowlist does not admit. */
  async #eventOf(update: InboundUpdate): Promise<InboundEvent | undefined> {
    if (update.kind === 'ignored') return undefined
    if (update.kind === 'callback') {
      const callback = update.callback
      if (!this.#allowed(callback.chatId, callback.fromId)) {
        this.#log.info(`ignored callback chat=${String(callback.chatId)} from=${String(callback.fromId ?? 0)} (not in allowlist)`)
        return undefined
      }
      return {
        kind: 'callback',
        chat: this.#key(callback.chatId, callback.threadId),
        userId: String(callback.fromId ?? ''),
        callbackId: callback.id,
        messageId: String(callback.messageId),
        data: callback.data,
      }
    }
    const message = update.message
    if (!this.#allowed(message.chat.id, message.fromId)) {
      this.#log.info(`ignored message chat=${String(message.chat.id)} from=${String(message.fromId ?? 0)} (not in allowlist)`)
      return undefined
    }
    const images = await this.#images(message)
    return {
      kind: 'message',
      chat: this.#key(message.chat.id, message.threadId),
      userId: String(message.fromId ?? ''),
      text: message.text,
      fromBot: message.isBot,
      messageId: String(message.messageId),
      ...(images.length === 0 ? {} : { images }),
    }
  }

  /** Download every image to this machine so the agent gets a path. */
  async #images(message: TelegramMessage): Promise<InboundImage[]> {
    const images: InboundImage[] = []
    for (const [index, image] of message.images.entries()) {
      if (image.size > TELEGRAM_IMAGE_LIMIT) {
        this.#log.error(`image ${image.fileId} is too large (${String(image.size)} bytes)`)
        continue
      }
      const bytes = await this.#api.downloadFile(image.fileId).catch(error => {
        this.#log.error(`image download failed: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })
      if (bytes === undefined) continue
      const extension = image.mediaType === 'image/png' ? 'png'
        : image.mediaType === 'image/webp' ? 'webp'
          : image.mediaType === 'image/gif' ? 'gif' : 'jpg'
      const name = `${String(message.messageId)}-${String(index)}.${extension}`
      const path = join(this.#inboxDir, name)
      try {
        await mkdir(this.#inboxDir, { recursive: true, mode: 0o700 })
        await writeFile(path, bytes, { mode: 0o600 })
      } catch (error) {
        this.#log.error(`image save failed: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      images.push({ path, ...(image.name === undefined ? {} : { name: image.name }) })
    }
    return images
  }

  /** Attach one image the agent referenced. */
  async sendImage(chat: ChatKey, image: OutgoingImage): Promise<void> {
    await this.#api.sendPhoto(
      numeric(chat.chatId, 'chat id'),
      image.data,
      image.mediaType,
      {
        ...(image.caption === undefined ? {} : { caption: image.caption }),
        ...(chat.threadId === undefined ? {} : { threadId: numeric(chat.threadId, 'thread id') }),
      },
    )
  }
}

/** Telegram's answer to an edit that changes nothing. */
function isNotModified(error: unknown): boolean {
  return error instanceof TelegramError && error.isBadRequest && /not modified/i.test(error.description)
}

/** Whether an edit or delete refers to a message that no longer exists. */
function isMissing(error: unknown): boolean {
  return error instanceof TelegramError
    && error.isBadRequest
    && /not found|MESSAGE_ID_INVALID|message to edit not found|message can't be deleted/i.test(error.description)
}

/** Loggable summary of one update. */
function describe(update: InboundUpdate): string {
  if (update.kind === 'ignored') return `ignored (${update.reason})`
  if (update.kind === 'callback') {
    return `callback chat=${String(update.callback.chatId)} data=${update.callback.data}`
  }
  const message = update.message
  const command = message.text.trim().startsWith('/') ? ' command' : ` prompt len=${String(message.text.length)}`
  return `message chat=${String(message.chat.id)} from=${String(message.fromId ?? 0)}${command}`
}
