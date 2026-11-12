import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInit } from '../src/init.ts'

/** A throwaway HOME so nothing ever touches the real keychain directory. */
async function home(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'hulala-bot-init-'))
}

test('writes the Telegram allowlist and the token reference, never the token', async () => {
  const root = await home()
  const code = await runInit([
    '--telegram-token-ref', 'telegram/bot-token',
    '--telegram-allowed-user', '1,2',
    '--default-cwd', '/tmp/work',
  ], { HOME: root, HULALA_HOME: join(root, '.hulala') })
  assert.equal(code, 0)
  const file = join(root, '.hulala', 'config', 'hulala-bot', 'config.json')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    telegram: { tokenRef: 'telegram/bot-token', allowedUsers: [1, 2] },
    defaultCwd: '/tmp/work',
  })
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test('an empty allowlist is refused instead of written', async () => {
  const root = await home()
  await assert.rejects(
    runInit(['--telegram-token-ref', 'telegram/bot-token', '--no-input'], { HOME: root, HULALA_HOME: join(root, '.hulala') }),
    /empty Telegram allowlist/,
  )
})

test('inside a Host the file lands under the Harness home', async () => {
  const root = await home()
  await runInit(['--telegram-token-ref', 'telegram/bot-token', '--telegram-allowed-user', '7', '--no-input'], {
    HOME: root,
    DSH_HOME: join(root, 'dsh'),
  })
  const file = join(root, 'dsh', 'config', 'hulala-bot', 'config.json')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).telegram.allowedUsers, [7])
})

test('writes a Lark section with its domain and open ids', async () => {
  const root = await home()
  await runInit([
    '--lark-app-id', 'cli_0123456789abcdef',
    '--lark-app-secret-ref', 'lark/app-secret',
    '--lark-allowed-user', 'ou_1,ou_2',
    '--lark-domain', 'lark',
    '--no-input',
  ], { HOME: root, HULALA_HOME: join(root, '.hulala') })
  const file = join(root, '.hulala', 'config', 'hulala-bot', 'config.json')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).lark, {
    appId: 'cli_0123456789abcdef',
    appSecretRef: 'lark/app-secret',
    allowedUsers: ['ou_1', 'ou_2'],
    domain: 'lark',
  })
})

test('adding Lark keeps the Telegram section already on disk', async () => {
  const root = await home()
  const env = { HOME: root, HULALA_HOME: join(root, '.hulala') }
  const file = join(root, '.hulala', 'config', 'hulala-bot', 'config.json')
  await runInit(['--telegram-token-ref', 'telegram/bot-token', '--telegram-allowed-user', '1', '--no-input'], env)
  await runInit([
    '--lark-app-id', 'cli_0123456789abcdef',
    '--lark-app-secret-ref', 'lark/app-secret',
    '--lark-allowed-user', 'ou_1',
    '--no-input',
  ], env)
  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(document.telegram.allowedUsers, [1])
  assert.equal(document.lark.appId, 'cli_0123456789abcdef')
})

test('a malformed app id is refused before anything is written', async () => {
  const root = await home()
  await assert.rejects(
    runInit(['--lark-app-id', 'nope', '--lark-app-secret-ref', 'lark/app-secret', '--lark-allowed-user', 'ou_1', '--no-input'], { HOME: root }),
    /cli_<16 hex>/,
  )
})

test('configuring nothing at all is an error, not an empty file', async () => {
  const root = await home()
  await assert.rejects(
    runInit(['--default-cwd', '/tmp', '--no-input'], { HOME: root, HULALA_HOME: join(root, '.hulala') }),
    /nothing to configure/,
  )
})

test('the proxy is normalized into the Telegram section', async () => {
  const root = await home()
  const env = { HOME: root, HULALA_HOME: join(root, '.hulala') }
  await runInit([
    '--telegram-token-ref', 'telegram/bot-token',
    '--telegram-allowed-user', '1',
    '--proxy', 'http://127.0.0.1:7897',
    '--no-input',
  ], env)
  // A second run keeps the first section and only adds the proxy.
  await runInit(['--proxy', 'http://127.0.0.1:7897', '--no-input'], env)
  const file = join(root, '.hulala', 'config', 'hulala-bot', 'config.json')
  assert.equal(JSON.parse(await readFile(file, 'utf8')).telegram.proxy, 'http://127.0.0.1:7897/')
})

test('a partial Telegram rewrite keeps its allowlist from disk', async () => {
  const root = await home()
  const env = { HOME: root, HULALA_HOME: join(root, '.hulala') }
  const file = join(root, '.hulala', 'config', 'hulala-bot', 'config.json')
  await runInit(['--telegram-token-ref', 'telegram/bot-token', '--telegram-allowed-user', '1', '--no-input'], env)
  await writeFile(file, JSON.stringify({
    telegram: { tokenRef: 'telegram/bot-token', allowedUsers: [1], parseMode: 'plain' },
  }))
  await runInit(['--parse-mode', 'markdown', '--no-input'], env)
  const document = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(document.telegram.allowedUsers, [1])
  assert.equal(document.telegram.parseMode, 'markdown')
})
