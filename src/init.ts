/**
 * `hulala-bot --init`: write the one file the bot cannot run without.
 *
 * A Host plugin has no terminal to ask questions in, and the bot refuses to
 * start on an empty allowlist (any stranger could drive the agent). So setup is
 * a deliberate one-shot per channel: collect who may talk to it and where the
 * credential lives, then write `config.json` with user-only permissions. The
 * token or app secret itself is never written — the file holds a keychain
 * reference.
 *
 * Re-running with only one channel's flags updates that section and leaves the
 * other one alone, so adding Lark does not disturb a working Telegram setup.
 *
 * @module hulala-bot/init
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { botStateDir, type LarkDomain } from './config.ts'
import { normalizeProxy } from './telegram/proxy.ts'

/** Telegram section as `--init` writes it. */
export interface TelegramInit {
  readonly tokenRef: string
  readonly allowedUsers: readonly number[]
  readonly allowedChats: readonly number[]
  readonly tokenEnv?: string
  readonly baseUrl?: string
  readonly parseMode?: 'markdown' | 'plain'
  readonly proxy?: string
}

/** Lark section as `--init` writes it. */
export interface LarkInit {
  readonly appId: string
  readonly appSecretRef: string
  readonly allowedUsers: readonly string[]
  readonly allowedChats: readonly string[]
  readonly appSecretEnv?: string
  readonly domain: LarkDomain
}

/** What `--init` decided to write. */
export interface InitOptions {
  readonly defaultCwd?: string
  readonly telegram?: TelegramInit
  readonly lark?: LarkInit
}

/** Raw form of one on-disk section, kept loose so unknown fields survive. */
type Section = Record<string, unknown>

/** Existing document; only the parts this command owns are typed. */
interface Existing {
  readonly defaultCwd?: string
  readonly telegram?: Section
  readonly lark?: Section
  readonly [key: string]: unknown
}

/** Flags parsed before validation. */
interface Parsed {
  readonly options: InitOptions
  readonly interactive: boolean
}

/**
 * Collect repeated `--flag value` pairs.
 * @param argv - arguments after `--init`.
 * @returns a lookup plus the interactive decision.
 */
function parse(argv: readonly string[]): Parsed {
  const telegram: {
    tokenRef?: string
    allowedUsers?: number[]
    allowedChats?: number[]
    tokenEnv?: string
    parseMode?: 'markdown' | 'plain'
    proxy?: string
  } = {}
  const lark: {
    appId?: string
    appSecretRef?: string
    appSecretEnv?: string
    allowedUsers?: string[]
    allowedChats?: string[]
    domain?: LarkDomain
  } = {}
  let defaultCwd: string | undefined
  let interactive = stdin.isTTY
  let touched = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string
    const value = (): string => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`${argument} needs a value`)
      index += 1
      return next
    }
    const ids = (): string[] => value().split(',').map(entry => entry.trim()).filter(entry => entry !== '')
    if (argument === '--telegram-token-ref') { telegram.tokenRef = value(); touched = true }
    else if (argument === '--telegram-token-env') { telegram.tokenEnv = value(); touched = true }
    else if (argument === '--telegram-allowed-user' || argument === '--telegram-allowed-users') {
      for (const entry of ids()) {
        const id = Number(entry)
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`not a Telegram user id: ${entry}`)
        telegram.allowedUsers = [...telegram.allowedUsers ?? [], id]
      }
      touched = true
    } else if (argument === '--telegram-allowed-chat' || argument === '--telegram-allowed-chats') {
      for (const entry of ids()) {
        const id = Number(entry)
        if (!Number.isSafeInteger(id)) throw new Error(`not a Telegram chat id: ${entry}`)
        telegram.allowedChats = [...telegram.allowedChats ?? [], id]
      }
      touched = true
    } else if (argument === '--proxy') { telegram.proxy = normalizeProxy(value()); touched = true }
    else if (argument === '--parse-mode') {
      const mode = value()
      if (mode !== 'markdown' && mode !== 'plain') throw new Error('--parse-mode is markdown or plain')
      telegram.parseMode = mode
      touched = true
    } else if (argument === '--lark-app-id') { lark.appId = value(); touched = true }
    else if (argument === '--lark-app-secret-ref') { lark.appSecretRef = value(); touched = true }
    else if (argument === '--lark-app-secret-env') { lark.appSecretEnv = value(); touched = true }
    else if (argument === '--lark-allowed-user' || argument === '--lark-allowed-users') {
      lark.allowedUsers = [...lark.allowedUsers ?? [], ...ids()]
      touched = true
    } else if (argument === '--lark-allowed-chat' || argument === '--lark-allowed-chats') {
      lark.allowedChats = [...lark.allowedChats ?? [], ...ids()]
      touched = true
    } else if (argument === '--lark-domain') {
      const domain = value()
      if (domain !== 'feishu' && domain !== 'lark') throw new Error('--lark-domain is feishu or lark')
      lark.domain = domain
      touched = true
    } else if (argument === '--default-cwd') { defaultCwd = value(); touched = true }
    else if (argument === '--no-input') interactive = false
    else if (argument === '--init') continue
    else throw new Error(`unknown option ${argument}`)
  }
  const hasTelegram = Object.keys(telegram).length > 0
  const hasLark = Object.keys(lark).length > 0
  return {
    interactive: interactive && !touched,
    options: {
      ...(defaultCwd === undefined ? {} : { defaultCwd }),
      ...(hasTelegram ? { telegram: telegram as TelegramInit } : {}),
      ...(hasLark ? { lark: lark as LarkInit } : {}),
    },
  }
}

/** Ask one question, treating a blank answer as "not supplied". */
async function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return (await rl.question(question)).trim()
}

/**
 * Ask for both channels on a terminal.
 * @returns the options the answers describe.
 */
async function prompt(): Promise<InitOptions> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const tokenRef = await ask(rl, 'Telegram keychain reference (blank to skip): ')
    let telegram: TelegramInit | undefined
    if (tokenRef !== '') {
      const allowedUsers = (await ask(rl, 'Allowed Telegram user ids, comma separated: '))
        .split(',')
        .map(entry => Number(entry.trim()))
        .filter(id => Number.isSafeInteger(id) && id > 0)
      telegram = {
        tokenRef: tokenRef === '' ? 'telegram/bot-token' : tokenRef,
        allowedUsers,
        allowedChats: [],
      }
    }
    const appId = await ask(rl, 'Lark app id (cli_…), blank to skip: ')
    let lark: LarkInit | undefined
    if (appId !== '') {
      const appSecretRef = await ask(rl, 'Lark app-secret keychain reference [lark/app-secret]: ')
      const allowedUsers = (await ask(rl, 'Allowed Lark open ids (ou_…), comma separated: '))
        .split(',')
        .map(entry => entry.trim())
        .filter(entry => entry !== '')
      lark = {
        appId,
        appSecretRef: appSecretRef === '' ? 'lark/app-secret' : appSecretRef,
        allowedUsers,
        allowedChats: [],
        domain: 'feishu',
      }
    }
    const cwdAnswer = await ask(rl, 'Directory the first message mounts [~]: ')
    return {
      ...(cwdAnswer === '' ? {} : { defaultCwd: cwdAnswer }),
      ...(telegram === undefined ? {} : { telegram }),
      ...(lark === undefined ? {} : { lark }),
    }
  } finally {
    rl.close()
  }
}

/** Whether a merged section has at least one allowed identity. */
function hasAllowlist(section: Section): boolean {
  const users = Array.isArray(section.allowedUsers) ? section.allowedUsers : []
  const chats = Array.isArray(section.allowedChats) ? section.allowedChats : []
  return users.length > 0 || chats.length > 0
}

/**
 * Merge one channel's flags over what is already on disk.
 *
 * Setup is often re-run to change one thing (a proxy, an extra user), so a
 * partial rewrite must not silently drop the rest of the section.
 * @param previous - section already on disk.
 * @param next - flags supplied this run.
 * @returns the section to write.
 */
function mergeSection(previous: Section | undefined, next: Record<string, unknown>): Section {
  const { allowedUsers, allowedChats, ...rest } = next
  return {
    ...previous,
    ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    ...(Array.isArray(allowedUsers) && allowedUsers.length > 0 ? { allowedUsers } : {}),
    ...(Array.isArray(allowedChats) && allowedChats.length > 0 ? { allowedChats } : {}),
  }
}

/**
 * Validate a merged Telegram section before writing it.
 * @param section - what would be written.
 */
function validateTelegram(section: Section): void {
  if (typeof section.tokenRef !== 'string' || section.tokenRef === '') {
    throw new Error('--telegram-token-ref is required for the Telegram channel')
  }
  if (!hasAllowlist(section)) {
    throw new Error('refusing to write an empty Telegram allowlist: pass --telegram-allowed-user <id>')
  }
}

/**
 * Validate a merged Lark section before writing it.
 * @param section - what would be written.
 */
function validateLark(section: Section): void {
  if (typeof section.appId !== 'string' || !/^cli_[0-9a-fA-F]{16}$/.test(section.appId)) {
    throw new Error('--lark-app-id must look like cli_<16 hex>')
  }
  if (typeof section.appSecretRef !== 'string' || section.appSecretRef === '') {
    throw new Error('--lark-app-secret-ref is required for the Lark channel')
  }
  if (!hasAllowlist(section)) {
    throw new Error('refusing to write an empty Lark allowlist: pass --lark-allowed-user <ou_…>')
  }
}

/**
 * Run setup and write the configuration file.
 * @param argv - arguments after `--init`.
 * @param env - process environment.
 * @returns exit code.
 */
export async function runInit(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parse(argv)
  const options = parsed.interactive ? await prompt() : parsed.options
  const stateDir = botStateDir(env)
  const file = join(stateDir, 'config.json')
  let existing: Existing = {}
  try {
    existing = JSON.parse(await readFile(file, 'utf8')) as Existing
  } catch {
    // No file yet, or unreadable: a fresh document is the honest start.
  }
  const document: Record<string, unknown> = { ...existing }
  if (options.defaultCwd !== undefined) document.defaultCwd = options.defaultCwd
  if (options.telegram !== undefined) {
    document.telegram = mergeSection(existing.telegram, options.telegram as unknown as Record<string, unknown>)
  }
  if (options.lark !== undefined) {
    document.lark = mergeSection(existing.lark, options.lark as unknown as Record<string, unknown>)
  }
  if (document.telegram === undefined && document.lark === undefined) {
    throw new Error('nothing to configure: pass --telegram-token-ref … or --lark-app-id … (see --help)')
  }
  if (document.telegram !== undefined) validateTelegram(document.telegram as Section)
  if (document.lark !== undefined) validateLark(document.lark as Section)
  if (document.defaultCwd === undefined) document.defaultCwd = '~'
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await writeFile(file, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 })
  console.log(`wrote ${file}`)
  const refs = [options.telegram?.tokenRef, options.lark?.appSecretRef]
    .filter((ref): ref is string => typeof ref === 'string' && ref !== '')
  console.log('store the credentials in the keychain, never in this file:')
  for (const ref of refs) printKeychain(ref)
  if (document.lark !== undefined) {
    console.log('Feishu: in a group the bot only receives real mentions — type @ and pick it;')
    console.log('private chat needs im:message.p2p_msg:readonly, groups need im:message.group_at_msg:readonly.')
  }
  console.log('restart the Host (or the bot process) to pick it up')
  return 0
}

/**
 * Print the platform command that stores one secret.
 * @param ref - `<service>/<account>`.
 */
function printKeychain(ref: string): void {
  const [service = 'telegram', account = 'bot-token'] = ref.split('/')
  if (process.platform === 'darwin') {
    console.log(`  security add-generic-password -U -s ${service} -a ${account} -w '…'`)
  } else {
    console.log(`  secret-tool store --label '${service}' service ${service} account ${account}`)
  }
}
