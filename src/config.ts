/**
 * Bot configuration.
 *
 * Secrets never live in this document: each one is referenced and resolved from
 * the operating-system keychain, or supplied through the environment for
 * development. Everything else here is non-secret.
 *
 * One file holds both surfaces. A channel with no section simply does not run,
 * so adding Lark later does not disturb a working Telegram setup.
 *
 * @module hulala-bot/config
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { normalizeProxy } from './telegram/proxy.ts'

const run = promisify(execFile)

/** Where the Bot API lives; tests point this at a fake server. */
export const TELEGRAM_API = 'https://api.telegram.org'

/** Feishu open-platform root. */
export const LARK_API = 'https://open.feishu.cn/open-apis'

/** Lark (international) open-platform root. */
export const LARK_API_INTERNATIONAL = 'https://open.larksuite.com/open-apis'

/** Which open platform an app belongs to. */
export type LarkDomain = 'feishu' | 'lark'

/** Telegram, fully resolved for one process. */
export interface TelegramChannelConfig {
  /** Bot token, already resolved from its reference. */
  readonly token: string
  /** Bot API root, without the `/bot<token>` suffix. */
  readonly baseUrl: string
  /** HTTP/HTTPS proxy for api.telegram.org, when the network needs one. */
  readonly proxy: string | undefined
  /** Telegram user ids allowed to drive the agent. */
  readonly allowedUsers: readonly number[]
  /** Chat ids allowed to drive the agent. */
  readonly allowedChats: readonly number[]
  /** Reply formatting; `plain` never fails on escaping. */
  readonly parseMode: 'markdown' | 'plain'
  /** How long long-polling waits for an update, in seconds. */
  readonly pollTimeoutSeconds: number
}

/** Lark, fully resolved for one process. */
export interface LarkChannelConfig {
  /** `cli_…` app id. */
  readonly appId: string
  /** App secret, already resolved from its reference. */
  readonly appSecret: string
  /** Feishu or international Lark. */
  readonly domain: LarkDomain
  /** Open API root, without a trailing slash. */
  readonly baseUrl: string
  /** Open ids (`ou_…`) allowed to drive the agent. */
  readonly allowedUsers: readonly string[]
  /** Chat ids (`oc_…`) allowed to drive the agent. */
  readonly allowedChats: readonly string[]
}

/** Fully resolved configuration for one bot process. */
export interface BridgeConfig {
  /** Directory the first message mounts when no binding exists. */
  readonly defaultCwd: string
  /** Minimum delay between two edits of the same streaming message. */
  readonly streamIntervalMs: number
  /** Bot-owned state directory: bindings, receipts, logs. */
  readonly stateDir: string
  /** Absent when Telegram is not configured. */
  readonly telegram: TelegramChannelConfig | undefined
  /** Absent when Lark is not configured. */
  readonly lark: LarkChannelConfig | undefined
}

/** On-disk Telegram section; every field is optional. */
interface TelegramFile {
  readonly token?: string
  readonly tokenRef?: string
  readonly tokenEnv?: string
  readonly baseUrl?: string
  readonly proxy?: string
  readonly allowedUsers?: readonly number[]
  readonly allowedChats?: readonly number[]
  readonly parseMode?: 'markdown' | 'plain'
  readonly pollTimeoutSeconds?: number
}

/** On-disk Lark section; the app id is the only required field. */
interface LarkFile {
  readonly appId?: string
  readonly appSecret?: string
  readonly appSecretRef?: string
  readonly appSecretEnv?: string
  readonly domain?: LarkDomain
  readonly baseUrl?: string
  readonly allowedUsers?: readonly string[]
  readonly allowedChats?: readonly string[]
}

/** On-disk document. */
interface ConfigFile {
  readonly defaultCwd?: string
  readonly streamIntervalMs?: number
  readonly telegram?: TelegramFile
  readonly lark?: LarkFile
}

/** Resolve the Hulala state root the same way the Host does. */
export function hulalaHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HULALA_HOME ?? join(homedir(), '.hulala')
}

/**
 * Directory holding this bot's own files.
 *
 * Inside a Host the bot runs as a plugin, so its state belongs under the
 * Harness home; beside a Host it is a peer process under the Hulala home.
 * @param env - process environment.
 * @returns absolute state directory.
 */
export function botStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const dshHome = env.DSH_HOME
  if (dshHome !== undefined && dshHome !== '') return join(dshHome, 'config', 'hulala-bot')
  return join(hulalaHome(env), 'config', 'hulala-bot')
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
 * Resolve one secret from its references.
 * @param raw - the channel section.
 * @param env - process environment.
 * @param field - prefix of the three fields (`token` / `appSecret`).
 * @returns the secret, or undefined when nothing supplied it.
 */
async function resolveSecret(
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  field: 'token' | 'appSecret',
): Promise<string | undefined> {
  const direct = raw[field]
  if (typeof direct === 'string' && direct.trim() !== '') return direct
  const envName = raw[`${field}Env`]
  if (typeof envName === 'string' && envName !== '') {
    const value = env[envName]
    if (value !== undefined && value.trim() !== '') return value
  }
  const ref = raw[`${field}Ref`]
  if (typeof ref === 'string' && ref !== '') return await readKeychain(ref)
  return undefined
}

/**
 * Read the configuration file, tolerating its absence.
 * @param env - process environment.
 * @returns the raw document and where it was read from.
 */
async function readFileConfig(env: NodeJS.ProcessEnv, root?: string): Promise<{ raw: ConfigFile; file: string; stateDir: string }> {
  const stateDir = root ?? env.HULALA_BOT_STATE ?? botStateDir(env)
  const file = env.HULALA_BOT_CONFIG ?? join(stateDir, 'config.json')
  let raw: ConfigFile = {}
  try {
    raw = JSON.parse(await readFile(file, 'utf8')) as ConfigFile
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { raw, file, stateDir }
}

/**
 * Resolve the Telegram section.
 * @param raw - the section as written.
 * @param env - process environment.
 * @param file - path used in errors.
 * @returns the resolved section, or undefined when it has no section.
 */
async function telegramConfig(raw: TelegramFile | undefined, env: NodeJS.ProcessEnv, file: string): Promise<TelegramChannelConfig | undefined> {
  if (raw === undefined) return undefined
  const token = await resolveSecret(raw as Record<string, unknown>, env, 'token')
    ?? env.TELEGRAM_BOT_TOKEN
  if (token === undefined || token.trim() === '') {
    throw new Error(`no Telegram bot token: set tokenRef in ${file}, or TELEGRAM_BOT_TOKEN in the environment`)
  }
  const allowedUsers = (raw.allowedUsers ?? []).map(Number).filter(Number.isSafeInteger)
  const allowedChats = (raw.allowedChats ?? []).map(Number).filter(Number.isSafeInteger)
  if (allowedUsers.length === 0 && allowedChats.length === 0) {
    throw new Error(`refusing to start Telegram with an empty allowlist: set telegram.allowedUsers or telegram.allowedChats in ${file}`)
  }
  const parseMode = raw.parseMode ?? 'markdown'
  if (parseMode !== 'markdown' && parseMode !== 'plain') {
    throw new Error(`telegram.parseMode must be "markdown" or "plain", not ${JSON.stringify(String(parseMode))}`)
  }
  const pollSeconds = Number.isFinite(raw.pollTimeoutSeconds) ? (raw.pollTimeoutSeconds as number) : 25
  return {
    token,
    baseUrl: (raw.baseUrl ?? TELEGRAM_API).replace(/\/$/, ''),
    proxy: raw.proxy === undefined ? undefined : normalizeProxy(raw.proxy),
    allowedUsers,
    allowedChats,
    parseMode,
    pollTimeoutSeconds: Math.max(1, Math.min(50, pollSeconds)),
  }
}

/**
 * Resolve the Lark section.
 * @param raw - the section as written.
 * @param env - process environment.
 * @param file - path used in errors.
 * @returns the resolved section, or undefined when it has no section.
 */
async function larkConfig(raw: LarkFile | undefined, env: NodeJS.ProcessEnv, file: string): Promise<LarkChannelConfig | undefined> {
  if (raw === undefined) return undefined
  const appId = (raw.appId ?? '').trim()
  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
    throw new Error(`lark.appId must look like cli_<16 hex>, not ${JSON.stringify(appId)} (from ${file})`)
  }
  const appSecret = await resolveSecret(raw as Record<string, unknown>, env, 'appSecret')
  if (appSecret === undefined || appSecret.trim() === '') {
    throw new Error(`no Lark app secret: set lark.appSecretRef in ${file}, or LARK_APP_SECRET in the environment`)
  }
  const allowedUsers = (raw.allowedUsers ?? []).map(entry => entry.trim()).filter(entry => entry !== '')
  const allowedChats = (raw.allowedChats ?? []).map(entry => entry.trim()).filter(entry => entry !== '')
  if (allowedUsers.length === 0 && allowedChats.length === 0) {
    throw new Error(`refusing to start Lark with an empty allowlist: set lark.allowedUsers (open ids) or lark.allowedChats in ${file}`)
  }
  const domain = raw.domain ?? 'feishu'
  if (domain !== 'feishu' && domain !== 'lark') {
    throw new Error(`lark.domain must be "feishu" or "lark", not ${JSON.stringify(String(domain))}`)
  }
  return {
    appId,
    appSecret,
    domain,
    baseUrl: (raw.baseUrl ?? (domain === 'lark' ? LARK_API_INTERNATIONAL : LARK_API)).replace(/\/$/, ''),
    allowedUsers,
    allowedChats,
  }
}

/**
 * Load and validate the bot configuration.
 * @param env - process environment; tests inject their own.
 * @param root - state directory override, used by tests.
 * @returns the resolved configuration.
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env, root?: string): Promise<BridgeConfig> {
  const { raw, file, stateDir } = await readFileConfig(env, root)
  const telegram = await telegramConfig(raw.telegram, env, file)
  const lark = await larkConfig(raw.lark, env, file)
  if (telegram === undefined && lark === undefined) {
    throw new Error(`no channel configured: add a "telegram" or "lark" section to ${file}`)
  }
  const streamIntervalMs = Number.isFinite(raw.streamIntervalMs) ? (raw.streamIntervalMs as number) : 800
  return {
    defaultCwd: resolve(expandHome(raw.defaultCwd ?? join(homedir(), 'hulala-workspace', 'workspace'))),
    streamIntervalMs: Math.max(300, streamIntervalMs),
    stateDir,
    telegram,
    lark,
  }
}
