/**
 * Chat-to-session mount table.
 *
 * The only durable state this bot owns. Sessions, history, cwd and models stay
 * the Host's; this file only remembers which session a conversation is looking
 * at, so a restart re-attaches instead of starting over.
 *
 * Keys are `<channel>:<chatId>:<threadId>`; the thread segment is empty unless
 * a Telegram forum topic splits a chat into separate conversations.
 *
 * @module hulala-bot/store/bindings
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ChannelName, ChatKey } from '../channel.ts'

/** Stable file key for one conversation. */
export function keyOf(key: ChatKey): string {
  return `${key.channel}:${key.chatId}:${key.threadId ?? ''}`
}

/**
 * Parse one file key back into a conversation.
 * @param key - value produced by {@link keyOf}.
 * @returns the conversation, or undefined when the key is malformed.
 */
export function parseKey(key: string): ChatKey | undefined {
  const [channel, chatId, threadId] = key.split(':')
  if (channel !== 'telegram' && channel !== 'lark') return undefined
  if (chatId === undefined || chatId === '') return undefined
  return {
    channel: channel as ChannelName,
    chatId,
    ...(threadId === undefined || threadId === '' ? {} : { threadId }),
  }
}

/** One persisted mount. */
interface Entry {
  readonly sessionId: string
  readonly updatedAt: number
  /** Message pinned above the conversation, rewritten on every move. */
  readonly statusMessageId?: string
}

/** File-backed mount table. */
export class Bindings {
  readonly #path: string
  #entries = new Map<string, Entry>()

  /** @param path - `bindings.json` path. */
  constructor(path: string) {
    this.#path = path
  }

  /**
   * Load the table.
   * @param dir - bot state directory.
   * @returns the loaded table.
   */
  static async open(dir: string): Promise<Bindings> {
    const table = new Bindings(join(dir, 'bindings.json'))
    try {
      const parsed = JSON.parse(await readFile(table.#path, 'utf8')) as Record<string, Entry>
      for (const [key, entry] of Object.entries(parsed)) {
        if (typeof entry?.sessionId === 'string' && parseKey(key) !== undefined) table.#entries.set(key, entry)
      }
    } catch {
      // Missing or corrupt: start empty rather than refuse to run.
    }
    return table
  }

  /**
   * Session a conversation is mounted to.
   * @param key - conversation.
   * @returns the session id, when mounted.
   */
  get(key: ChatKey): string | undefined {
    return this.#entries.get(keyOf(key))?.sessionId
  }

  /**
   * Mount a conversation to a session.
   * @param key - conversation.
   * @param sessionId - target session.
   */
  set(key: ChatKey, sessionId: string): void {
    const status = this.#entries.get(keyOf(key))?.statusMessageId
    this.#entries.set(keyOf(key), {
      sessionId,
      updatedAt: Date.now(),
      ...(status === undefined ? {} : { statusMessageId: status }),
    })
  }

  /**
   * Pinned status message of one conversation.
   * @param key - conversation.
   * @returns the message id, when one was pinned.
   */
  statusMessageId(key: ChatKey): string | undefined {
    return this.#entries.get(keyOf(key))?.statusMessageId
  }

  /**
   * Remember the pinned status message.
   * @param key - conversation.
   * @param messageId - message that was pinned.
   */
  setStatusMessageId(key: ChatKey, messageId: string): void {
    const entry = this.#entries.get(keyOf(key))
    if (entry === undefined) return
    this.#entries.set(keyOf(key), { ...entry, statusMessageId: messageId })
  }

  /**
   * Drop a mount.
   * @param key - conversation.
   */
  delete(key: ChatKey): void {
    this.#entries.delete(keyOf(key))
  }

  /**
   * Every conversation currently mounted to a session.
   * @param sessionId - session to look up.
   * @returns the matching conversations.
   */
  chatsFor(sessionId: string): readonly ChatKey[] {
    const keys: ChatKey[] = []
    for (const [key, entry] of this.#entries) {
      if (entry.sessionId !== sessionId) continue
      const parsed = parseKey(key)
      if (parsed !== undefined) keys.push(parsed)
    }
    return keys
  }

  /** Every persisted conversation. */
  entries(): readonly ChatKey[] {
    return [...this.#entries.keys()].map(parseKey).filter((key): key is ChatKey => key !== undefined)
  }

  /** Write the table atomically. */
  async flush(): Promise<void> {
    const temporary = `${this.#path}.${String(process.pid)}.tmp`
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
    await writeFile(temporary, JSON.stringify(Object.fromEntries(this.#entries), null, 2), { mode: 0o600 })
    await rename(temporary, this.#path)
  }
}
