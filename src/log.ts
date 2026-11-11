/**
 * Small structured log.
 *
 * Everything the bridge prints goes through here so the bot token can never
 * reach a file or a terminal transcript.
 *
 * @module dsh-telegram/log
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Redact the token out of any string. */
function redact(text: string, token: string): string {
  return token === '' ? text : text.split(token).join('<bot-token>')
}

/** Append-only log with console mirroring. */
export class Log {
  readonly #file: string
  readonly #token: string
  #ready: Promise<void> | undefined

  /**
   * @param dir - bridge state directory.
   * @param token - bot token to redact.
   */
  constructor(dir: string, token: string) {
    this.#file = join(dir, 'logs', `bridge-${new Date().toISOString().slice(0, 10)}.log`)
    this.#token = token
  }

  /**
   * Record one line.
   * @param level - severity tag.
   * @param message - text; never include the token.
   */
  write(level: 'info' | 'warn' | 'error', message: string): void {
    const line = `${new Date().toISOString()} ${level} ${redact(message, this.#token)}`
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
