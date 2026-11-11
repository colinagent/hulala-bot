/**
 * One poller per state root.
 *
 * Two pollers on one bot token make Telegram answer 409 and hand each update to
 * only one of them, which looks exactly like lost messages. The Host is usually
 * the single instance, but the standalone bridge can still be started beside it,
 * so both paths take this lock.
 *
 * @module dsh-telegram/store/lock
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Refuse to run twice against one state root.
 *
 * Two pollers on one bot token make Telegram answer 409 and hand each update to
 * only one of them, which looks exactly like lost messages.
 * @param stateDir - bridge state directory.
 * @returns a release function.
 */
export async function acquireLock(stateDir: string): Promise<() => Promise<void>> {
  const path = join(stateDir, 'bridge.lock')
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  let owner: number | undefined
  try {
    const parsed = Number.parseInt((await readFile(path, 'utf8')).trim(), 10)
    if (Number.isSafeInteger(parsed) && parsed > 0) owner = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (owner !== undefined && owner !== process.pid) {
    let alive = false
    try {
      process.kill(owner, 0)
      alive = true
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code === 'EPERM'
    }
    if (alive) throw new Error(`another bridge is already running (pid ${String(owner)}); stop it first`)
  }
  await writeFile(path, `${String(process.pid)}\n`, { mode: 0o600 })
  return async () => { await rm(path, { force: true }) }
}

