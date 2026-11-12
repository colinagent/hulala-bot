/**
 * `dsh-telegram --init`: write the one file the bridge cannot run without.
 *
 * A Host plugin has no terminal to ask questions in, and the bridge refuses to
 * start on an empty allowlist (any stranger could drive the agent). So setup is
 * a deliberate one-shot: collect the allowed Telegram users and a token
 * reference, write `config.json` with user-only permissions, and say what to do
 * next. The token itself is never written — the file holds a keychain reference.
 *
 * @module dsh-telegram/init
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { bridgeStateDir } from './config.ts'
import { normalizeProxy } from './telegram/proxy.ts'

/** What `--init` decided to write. */
export interface InitOptions {
  readonly tokenRef: string
  readonly allowedUsers: readonly number[]
  readonly defaultCwd: string
  readonly baseUrl?: string
  readonly parseMode?: 'markdown' | 'plain'
  readonly proxy?: string
}

interface Parsed {
  readonly options: Partial<InitOptions>
  readonly interactive: boolean
}

/**
 * Parse the flags; anything missing is asked for when a terminal is attached.
 * @param argv - arguments after `--init`.
 * @returns what was supplied and whether prompting is allowed.
 */
function parse(argv: readonly string[]): Parsed {
  const options: { tokenRef?: string; allowedUsers?: number[]; defaultCwd?: string; baseUrl?: string; parseMode?: 'markdown' | 'plain'; proxy?: string } = {}
  let interactive = stdin.isTTY
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string
    const value = (): string => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`${argument} needs a value`)
      index += 1
      return next
    }
    if (argument === '--token-ref') options.tokenRef = value()
    else if (argument === '--allowed-user' || argument === '--allowed-users') {
      for (const entry of value().split(',')) {
        const id = Number(entry.trim())
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`not a Telegram user id: ${entry}`)
        options.allowedUsers = [...options.allowedUsers ?? [], id]
      }
    } else if (argument === '--default-cwd') options.defaultCwd = value()
    else if (argument === '--base-url') options.baseUrl = value()
    else if (argument === '--proxy') options.proxy = normalizeProxy(value())
    else if (argument === '--parse-mode') {
      const mode = value()
      if (mode !== 'markdown' && mode !== 'plain') throw new Error('--parse-mode is markdown or plain')
      options.parseMode = mode
    } else if (argument === '--no-input') interactive = false
    else throw new Error(`unknown option ${argument}`)
  }
  return { options, interactive }
}

/**
 * Ask for the missing pieces on a terminal.
 * @param partial - flags already supplied.
 * @returns the complete options.
 */
async function prompt(partial: Partial<InitOptions>): Promise<InitOptions> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const answer = (await rl.question('Keychain reference for the bot token [telegram/bot-token]: ')).trim()
    const tokenRef = partial.tokenRef ?? (answer === '' ? 'telegram/bot-token' : answer)
    const users = partial.allowedUsers ?? (await rl.question('Allowed Telegram user ids, comma separated: '))
      .split(',')
      .map(entry => Number(entry.trim()))
      .filter(id => Number.isSafeInteger(id) && id > 0)
    const cwdAnswer = (await rl.question('Directory the first message mounts [~]: ')).trim()
    const cwd = partial.defaultCwd ?? (cwdAnswer === '' ? '~' : cwdAnswer)
    return { ...partial, tokenRef, allowedUsers: users, defaultCwd: cwd }
  } finally {
    rl.close()
  }
}

/**
 * Run setup and write the configuration file.
 * @param argv - arguments after `--init`.
 * @param env - process environment.
 * @returns exit code.
 */
export async function runInit(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { options: partial, interactive } = parse(argv)
  const options = interactive ? await prompt(partial) : partial as InitOptions
  if (options.tokenRef === undefined) throw new Error('--token-ref is required without a terminal')
  if (options.allowedUsers === undefined || options.allowedUsers.length === 0) {
    throw new Error('refusing to write an empty allowlist: pass --allowed-user <id> (Telegram user ids)')
  }
  const stateDir = bridgeStateDir(env)
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, 'config.json')
  const document = {
    tokenRef: options.tokenRef,
    allowedUsers: options.allowedUsers,
    defaultCwd: options.defaultCwd ?? '~',
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.parseMode === undefined ? {} : { parseMode: options.parseMode }),
    ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
  }
  await writeFile(file, JSON.stringify(document, null, 2) + '\n', { mode: 0o600 })
  console.log(`wrote ${file}`)
  console.log('store the token itself in the keychain, never in this file:')
  if (process.platform === 'darwin') {
    console.log(`  security add-generic-password -U -s ${options.tokenRef.split('/')[0] ?? 'telegram'} -a ${options.tokenRef.split('/')[1] ?? 'bot-token'} -w '123456:ABC…'`)
  } else {
    console.log(`  secret-tool store --label 'telegram bot' service ${options.tokenRef.split('/')[0] ?? 'telegram'} account ${options.tokenRef.split('/')[1] ?? 'bot-token'}`)
  }
  console.log('restart the Host (or the bridge process) to pick it up')
  return 0
}
