/**
 * One connection per credential, machine-wide.
 *
 * Two Telegram pollers on one token make Telegram answer 409 and hand each
 * update to only one of them, which looks exactly like lost messages. Two Lark
 * long connections on one app split the event stream the same way. The lock
 * cannot live in the bot's state directory: DSH keeps its home in `~/.dsh` and
 * Hulala in `~/.hulala/harness`, so a plugin installed in both products would
 * take two independent locks and collide.
 *
 * The lock is therefore keyed by the credential, in one directory that belongs
 * to neither home. The credential never appears in a path: the file name is a
 * digest.
 *
 * @module hulala-bot/store/lock
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Directory holding credential locks and nothing else.
 * @param env - process environment; `HULALA_BOT_LOCK_DIR` overrides for tests.
 * @returns absolute directory.
 */
export function lockDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.HULALA_BOT_LOCK_DIR
  if (override !== undefined && override !== '') return override
  return join(homedir(), '.hulala-bot')
}

/**
 * Lock file for one credential identity.
 * @param identity - `<channel>:<credential>`, for example `telegram:123:ABC`.
 * @param env - process environment.
 * @returns absolute path; the credential contributes only a digest.
 */
export function lockPath(identity: string, env: NodeJS.ProcessEnv = process.env): string {
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return join(lockDirectory(env), `${digest}.lock`)
}

/** Locks this process already holds, so a second bot instance cannot slip past the pid check. */
const held = new Set<string>()

/**
 * Take the machine-wide lock for one credential.
 *
 * A holder whose process is gone is stale and is replaced, so a crash never
 * requires deleting a file by hand.
 * @param identity - `<channel>:<credential>`.
 * @param env - process environment.
 * @returns a release function.
 */
export async function acquireLock(identity: string, env: NodeJS.ProcessEnv = process.env): Promise<() => Promise<void>> {
  const path = lockPath(identity, env)
  if (held.has(path)) throw new Error(`this bot is already running in another instance here (${path})`)
  await mkdir(lockDirectory(env), { recursive: true, mode: 0o700 })
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
    if (alive) {
      throw new Error(`this bot is already connected from another Host (pid ${String(owner)}); stop that process or remove ${path} if it is stale`)
    }
  }
  await writeFile(path, `${String(process.pid)}\n`, { mode: 0o600 })
  held.add(path)
  return async () => {
    if (!held.delete(path)) return
    await rm(path, { force: true })
  }
}

/**
 * Whether some other live process already holds this credential's lock.
 * @param identity - `<channel>:<credential>`.
 * @param env - process environment.
 * @returns the pid holding it, when it is alive.
 */
export async function holderPid(identity: string, env: NodeJS.ProcessEnv = process.env): Promise<number | undefined> {
  try {
    const owner = Number.parseInt((await readFile(lockPath(identity, env), 'utf8')).trim(), 10)
    if (!Number.isSafeInteger(owner) || owner <= 0 || owner === process.pid) return undefined
    process.kill(owner, 0)
    return owner
  } catch {
    return undefined
  }
}
