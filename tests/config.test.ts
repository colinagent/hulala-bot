import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config.ts'

/** Write one config file into a throwaway state directory. */
async function state(document: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hulala-bot-config-'))
  await writeFile(join(root, 'config.json'), JSON.stringify(document))
  return root
}

/** A Telegram section that only needs the environment token. */
const telegram = { allowedUsers: [1] }

test('resolves the Telegram section and its defaults', async () => {
  const root = await state({ telegram })
  const config = await loadConfig({ TELEGRAM_BOT_TOKEN: 'token' }, root)
  assert.equal(config.telegram?.token, 'token')
  assert.equal(config.telegram?.baseUrl, 'https://api.telegram.org')
  assert.equal(config.telegram?.parseMode, 'markdown')
  assert.equal(config.lark, undefined)
})

test('a proxy is validated and normalized', async () => {
  const root = await state({ telegram: { ...telegram, proxy: 'http://127.0.0.1:7897' } })
  const config = await loadConfig({ TELEGRAM_BOT_TOKEN: 'token' }, root)
  assert.equal(config.telegram?.proxy, 'http://127.0.0.1:7897/')
})

test('an unsupported proxy protocol is refused with the file in mind', async () => {
  const root = await state({ telegram: { ...telegram, proxy: 'socks5://127.0.0.1:7897' } })
  await assert.rejects(loadConfig({ TELEGRAM_BOT_TOKEN: 'token' }, root), /proxy must be an http:\/\/ or https:\/\/ URL/)
})

test('no proxy stays undefined', async () => {
  const root = await state({ telegram })
  const config = await loadConfig({ TELEGRAM_BOT_TOKEN: 'token' }, root)
  assert.equal(config.telegram?.proxy, undefined)
})

test('both channels load from one file', async () => {
  const root = await state({
    telegram,
    lark: {
      appId: 'cli_0123456789abcdef',
      appSecret: 'secret',
      allowedUsers: ['ou_1'],
      domain: 'lark',
    },
  })
  const config = await loadConfig({ TELEGRAM_BOT_TOKEN: 'token' }, root)
  assert.equal(config.telegram?.token, 'token')
  assert.equal(config.lark?.domain, 'lark')
  assert.equal(config.lark?.baseUrl, 'https://open.larksuite.com/open-apis')
  assert.deepEqual(config.lark?.allowedUsers, ['ou_1'])
})

test('an empty allowlist is refused per channel', async () => {
  const root = await state({ lark: { appId: 'cli_0123456789abcdef', appSecret: 's', allowedUsers: [] } })
  await assert.rejects(loadConfig({}, root), /empty allowlist: set lark\.allowedUsers/)
})

test('a malformed app id is refused before the connection is attempted', async () => {
  const root = await state({ lark: { appId: 'nope', appSecret: 's', allowedUsers: ['ou_1'] } })
  await assert.rejects(loadConfig({}, root), /lark\.appId must look like cli_<16 hex>/)
})

test('a file with no channel is refused with the path', async () => {
  const root = await state({ defaultCwd: '/tmp' })
  await assert.rejects(loadConfig({}, root), /no channel configured: add a "telegram" or "lark" section to .*config\.json/)
})

test('a missing file is reported as "no channel configured"', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hulala-bot-empty-'))
  await assert.rejects(loadConfig({}, root), /no channel configured/)
})

test('LARK_APP_SECRET is the environment fallback for the app secret', async () => {
  const root = await state({ lark: { appId: 'cli_0123456789abcdef', allowedUsers: ['ou_1'] } })
  const config = await loadConfig({ LARK_APP_SECRET: 'from-env' }, root)
  assert.equal(config.lark?.appSecret, 'from-env')
})
