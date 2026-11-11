/**
 * Bridge configuration.
 *
 * The bot token never lives in this document: it is referenced and resolved
 * from the operating-system keychain, or supplied through the environment for
 * development. Everything else here is non-secret.
 *
 * @module dsh-telegram/config
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Where the Bot API lives; tests point this at a fake server. */
export const TELEGRAM_API = 'https://api.telegram.org'

/** Fully resolved configuration for one bridge process. */
export interface BridgeConfig {
  /** Bot API root, without the `/bot<token>` suffix. */
  readonly baseUrl: string
  /** Bot token, already resolved from its reference. */
  readonly token: string
  /** Telegram user ids allowed to drive the agent. Empty refuses everyone. */
  readonly allowedUsers: readonly number[]
  /** Chat ids allowed to drive the agent. Empty refuses everyone. */
  readonly allowedChats: readonly number[]
  /** Directory the first message mounts when no binding exists. */
  readonly defaultCwd: string
  /** Minimum delay between two edits of the same streaming message. */
  readonly streamIntervalMs: number
  /** Reply formatting; `plain` never fails on escaping. */
  readonly parseMode: 'markdown' | 'plain'
  /** Bridge-owned state directory: bindings, receipts, logs. */
  readonly stateDir: string
  /** How long long-polling waits for an update, in seconds. */
  readonly pollTimeoutSeconds: number
}

/** On-disk shape; every field optional except the token reference. */
interface BridgeConfigFile {
  readonly token?: string
  readonly tokenRef?: string
  readonly tokenEnv?: string
  readonly baseUrl?: string
  readonly allowedUsers?: readonly number[]
  readonly allowedChats?: readonly number[]
  readonly defaultCwd?: string
  readonly streamIntervalMs?: number
  readonly parseMode?: 'markdown' | 'plain'
  readonly pollTimeoutSeconds?: number
}

/** Resolve the Hulala state root the same way the Host does. */
export function hulalaHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HULALA_HOME ?? join(homedir(), '.hulala')
}

/** Directory holding this bridge's own files. */
export function bridgeStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(hulalaHome(env), 'config', 'dsh-telegram')
}

/** Expand a leading `~` so chat-side paths behave like the shell. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Read one keychain entry.
 * @param ref - `<service>/<account>`, for example `telegram/bot-token`.
 * @returns the secret, or undefined when the platform has no such store.
 */
async function readKeychain(ref: string): Promise<string | undefined> {
  const slash = ref.lastIndexOf('/')
  const service = slash === -1 ? ref : ref.slice(0, slash)
  const account = slash === -1 ? ref : ref.slice(slash + 1)
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await run('security', ['find-generic-password', '-s', service, '-a', account, '-w'])
      return stdout.trim() || undefined
    }
    const { stdout } = await run('secret-tool', ['lookup', 'service', service, 'account', account])
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Load and validate the bridge configuration.
 * @param env - process environment; tests inject their own.
 * @returns the resolved configuration.
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<BridgeConfig> {
  const stateDir = env.HULALA_TELEGRAM_STATE ?? bridgeStateDir(env)
  const file = env.HULALA_TELEGRAM_CONFIG ?? join(stateDir, 'config.json')
  let raw: BridgeConfigFile = {}
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as BridgeConfigFile
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const token = raw.token
    ?? (raw.tokenEnv === undefined ? undefined : env[raw.tokenEnv])
    ?? env.TELEGRAM_BOT_TOKEN
    ?? (raw.tokenRef === undefined ? undefined : await readKeychain(raw.tokenRef))
  if (token === undefined || token.trim() === '') {
    throw new Error(`no bot token: set tokenRef in ${file}, or TELEGRAM_BOT_TOKEN in the environment`)
  }

  const allowedUsers = (raw.allowedUsers ?? []).map(Number).filter(Number.isSafeInteger)
  const allowedChats = (raw.allowedChats ?? []).map(Number).filter(Number.isSafeInteger)
  if (allowedUsers.length === 0 && allowedChats.length === 0) {
    throw new Error(`refusing to start with an empty allowlist: set allowedUsers or allowedChats in ${file}`)
  }

  return {
    baseUrl: (raw.baseUrl ?? TELEGRAM_API).replace(/\/$/, ''),
    token,
    allowedUsers,
    allowedChats,
    defaultCwd: resolve(expandHome(raw.defaultCwd ?? join(homedir(), 'hulala-workspace', 'workspace'))),
    streamIntervalMs: Math.max(300, raw.streamIntervalMs ?? 800),
    parseMode: raw.parseMode ?? 'markdown',
    stateDir,
    pollTimeoutSeconds: Math.max(1, Math.min(50, raw.pollTimeoutSeconds ?? 25)),
  }
}
