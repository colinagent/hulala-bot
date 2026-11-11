/**
 * Inbound update de-duplication.
 *
 * Bot API keeps an unconfirmed update for 24 hours and re-delivers it when the
 * acknowledgement is lost. Without a ledger, a re-delivery feeds the same
 * sentence to the agent twice — and the agent really writes files. The ledger
 * is one file per bot, pruned by TTL and a hard cap.
 *
 * @module dsh-telegram/telegram/ledger
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** One remembered update. */
interface Entry {
  readonly id: number
  readonly at: number
}

/** Bounded, TTL-pruned set of update ids. */
export class UpdateLedger {
  readonly #path: string
  readonly #ttlMs: number
  readonly #capacity: number
  #entries: Entry[] = []
  #seen = new Set<number>()
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
      ledger.#entries = (parsed.entries ?? []).filter(entry => Number.isSafeInteger(entry.id) && Number.isSafeInteger(entry.at))
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
   * Test and remember one update id.
   * @param id - Telegram update id.
   * @returns true when this update was already handled.
   */
  seen(id: number): boolean {
    if (this.#seen.has(id)) return true
    this.#seen.add(id)
    this.#entries.push({ id, at: Date.now() })
    this.#dirty = true
    this.#prune(Date.now())
    if (this.#entries.length > this.#capacity) {
      this.#seen = new Set(this.#entries.map(entry => entry.id))
    }
    return false
  }

  /** Highest update id seen, for the next `getUpdates` offset. */
  get cursor(): number {
    let highest = 0
    for (const entry of this.#entries) highest = Math.max(highest, entry.id)
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
