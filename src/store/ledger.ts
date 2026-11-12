/**
 * Inbound event de-duplication.
 *
 * Telegram keeps an unconfirmed update for 24 hours and re-delivers it when the
 * acknowledgement is lost; a WebSocket can replay an event after a reconnect.
 * Without a ledger, a re-delivery feeds the same sentence to the agent twice —
 * and the agent really writes files. The ledger is one file per bot, pruned by
 * TTL and a hard cap.
 *
 * Both transports deliver duplicates: Telegram re-delivers an unconfirmed
 * update, and a long connection can replay an event after a reconnect. The
 * ledger is keyed by whatever id the surface has — a number for Telegram, an
 * `event_id` string for Lark — because a duplicate prompt costs real file edits.
 *
 * @module hulala-bot/store/ledger
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** One remembered update. */
interface Entry {
  readonly id: string
  readonly at: number
}

/** Bounded, TTL-pruned set of update ids. */
export class UpdateLedger {
  readonly #path: string
  readonly #ttlMs: number
  readonly #capacity: number
  #entries: Entry[] = []
  #seen = new Set<string>()
  #dirty = false
  #flushing: Promise<void> | undefined

  /**
   * @param path - receipt file for this bot.
   * @param options - TTL and capacity.
   */
  constructor(path: string, options: { ttlMs?: number; capacity?: number } = {}) {
    this.#path = path
    this.#ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000
    this.#capacity = options.capacity ?? 4096
  }

  /**
   * Load receipts from disk and prune them.
   * @param path - receipt file.
   * @param options - TTL and capacity.
   * @returns the loaded ledger.
   */
  static async open(path: string, options: { ttlMs?: number; capacity?: number } = {}): Promise<UpdateLedger> {
    const ledger = new UpdateLedger(path, options)
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as { entries?: readonly Entry[] }
      ledger.#entries = (parsed.entries ?? []).filter(entry => typeof entry.id === 'string' && Number.isSafeInteger(entry.at))
    } catch {
      // A missing or corrupt receipt file just means an empty ledger.
    }
    ledger.#prune(Date.now())
    ledger.#seen = new Set(ledger.#entries.map(entry => entry.id))
    return ledger
  }

  /** Drop entries past the TTL or beyond the capacity, newest first. */
  #prune(now: number): void {
    const fresh = this.#entries.filter(entry => now - entry.at < this.#ttlMs)
    fresh.sort((left, right) => left.at - right.at)
    this.#entries = fresh.slice(-this.#capacity)
  }

  /**
   * Test and remember one event id.
   * @param id - update id or event id; numbers are accepted for Telegram.
   * @returns true when this event was already handled.
   */
  seen(id: string | number): boolean {
    const key = String(id)
    if (this.#seen.has(key)) return true
    this.#seen.add(key)
    this.#entries.push({ id: key, at: Date.now() })
    this.#dirty = true
    this.#prune(Date.now())
    if (this.#entries.length > this.#capacity) {
      this.#seen = new Set(this.#entries.map(entry => entry.id))
    }
    return false
  }

  /** Highest numeric id seen, for the next `getUpdates` offset. */
  get cursor(): number {
    let highest = 0
    for (const entry of this.#entries) {
      const value = Number(entry.id)
      if (Number.isSafeInteger(value)) highest = Math.max(highest, value)
    }
    return highest
  }

  /**
   * Write the ledger, coalescing concurrent flushes.
   * @returns a promise settled once the newest snapshot is on disk.
   */
  async flush(): Promise<void> {
    if (!this.#dirty) return this.#flushing ?? Promise.resolve()
    if (this.#flushing !== undefined) return this.#flushing
    this.#dirty = false
    this.#flushing = (async () => {
      const temporary = `${this.#path}.${String(process.pid)}.tmp`
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
      await writeFile(temporary, JSON.stringify({ entries: this.#entries }), { mode: 0o600 })
      await rename(temporary, this.#path)
    })().finally(() => {
      this.#flushing = undefined
    })
    return this.#flushing
  }
}
