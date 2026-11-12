/**
 * Small structured log.
 *
 * Everything the bot prints goes through here so a bot token or app secret can
 * never reach a file or a terminal transcript.
 *
 * @module hulala-bot/log
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Redact every secret out of one string. */
function redact(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret !== '') out = out.split(secret).join('<secret>')
  }
  return out
}

/** Append-only log with console mirroring. */
export class Log {
  readonly #file: string
  readonly #secrets: readonly string[]
  #ready: Promise<void> | undefined

  /**
   * @param dir - bot state directory.
   * @param secrets - credentials to redact.
   */
  constructor(dir: string, secrets: readonly string[]) {
    this.#file = join(dir, 'logs', `bridge-${new Date().toISOString().slice(0, 10)}.log`)
    this.#secrets = secrets
  }

  /**
   * Record one line.
   * @param level - severity tag.
   * @param message - text; never include a credential.
   */
  write(level: 'info' | 'warn' | 'error', message: string): void {
    const line = `${new Date().toISOString()} ${level} ${redact(message, this.#secrets)}`
    if (level === 'error') console.error(line)
    else console.log(line)
    this.#ready ??= mkdir(dirname(this.#file), { recursive: true, mode: 0o700 }).then(() => undefined)
    void this.#ready
      .then(() => appendFile(this.#file, `${line}\n`, { mode: 0o600 }))
      .catch(() => undefined)
  }

  /** Convenience wrapper for informational lines. */
  info(message: string): void {
    this.write('info', message)
  }

  /** Convenience wrapper for failures. */
  error(message: string): void {
    this.write('error', message)
  }
}
