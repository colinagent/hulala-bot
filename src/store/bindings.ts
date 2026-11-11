/**
 * Chat-to-session mount table.
 *
 * The only durable state this bridge owns. Sessions, history, cwd and models
 * stay the Host's; this file only remembers which conversation a chat is
 * looking at, so a restart re-attaches instead of starting over.
 *
 * @module dsh-telegram/store/bindings
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** One chat conversation; a forum topic is its own conversation. */
export interface ChatKey {
  readonly chatId: number
  readonly threadId?: number | undefined
}

/** Stable file key for one conversation. */
export function keyOf(key: ChatKey): string {
  return `${String(key.chatId)}:${String(key.threadId ?? 0)}`
}

/** One persisted mount. */
interface Entry {
  readonly sessionId: string
  readonly updatedAt: number
  /** Message pinned above the conversation, rewritten on every move. */
  readonly statusMessageId?: number
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
   * @param dir - bridge state directory.
   * @returns the loaded table.
   */
  static async open(dir: string): Promise<Bindings> {
    const table = new Bindings(join(dir, 'bindings.json'))
    try {
      const parsed = JSON.parse(await readFile(table.#path, 'utf8')) as Record<string, Entry>
      for (const [key, entry] of Object.entries(parsed)) {
        if (typeof entry?.sessionId === 'string') table.#entries.set(key, entry)
      }
    } catch {
      // Missing or corrupt: start empty rather than refuse to run.
    }
    return table
  }

  /**
   * Session a conversation is mounted to.
   * @param key - chat and optional topic.
   * @returns the session id, when mounted.
   */
  get(key: ChatKey): string | undefined {
    return this.#entries.get(keyOf(key))?.sessionId
  }

  /**
   * Mount a conversation to a session.
   * @param key - chat and optional topic.
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
   * @param key - chat and optional topic.
   * @returns the message id, when one was pinned.
   */
  statusMessageId(key: ChatKey): number | undefined {
    return this.#entries.get(keyOf(key))?.statusMessageId
  }

  /**
   * Remember the pinned status message.
   * @param key - chat and optional topic.
   * @param messageId - message that was pinned.
   */
  setStatusMessageId(key: ChatKey, messageId: number): void {
    const entry = this.#entries.get(keyOf(key))
    if (entry === undefined) return
    this.#entries.set(keyOf(key), { ...entry, statusMessageId: messageId })
  }

  /**
   * Drop a mount.
   * @param key - chat and optional topic.
   */
  delete(key: ChatKey): void {
    this.#entries.delete(keyOf(key))
  }

  /**
   * Every conversation currently mounted to a session.
   * @param sessionId - session to look up.
   * @returns the matching chat keys.
   */
  chatsFor(sessionId: string): readonly ChatKey[] {
    const keys: ChatKey[] = []
    for (const [key, entry] of this.#entries) {
      if (entry.sessionId !== sessionId) continue
      const [chatId, threadId] = key.split(':')
      keys.push({ chatId: Number(chatId), ...(threadId === '0' ? {} : { threadId: Number(threadId) }) })
    }
    return keys
  }

  /** Every persisted conversation. */
  entries(): readonly ChatKey[] {
    return [...this.#entries.keys()].map(key => {
      const [chatId, threadId] = key.split(':')
      return { chatId: Number(chatId), ...(threadId === '0' ? {} : { threadId: Number(threadId) }) }
    })
  }

  /** Write the table atomically. */
  async flush(): Promise<void> {
    const temporary = `${this.#path}.${String(process.pid)}.tmp`
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
    await writeFile(temporary, JSON.stringify(Object.fromEntries(this.#entries), null, 2), { mode: 0o600 })
    await rename(temporary, this.#path)
  }
}
