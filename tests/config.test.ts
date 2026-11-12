import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadConfig } from '../src/config.ts'

/** Write one config file into a throwaway state directory. */
async function state(document: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-telegram-config-'))
  await writeFile(join(root, 'config.json'), JSON.stringify({ allowedUsers: [1], ...document }))
  return root
}

test('a proxy is validated and normalized', async () => {
  const root = await state({ proxy: 'http://127.0.0.1:7897' })
  const config = await loadConfig({ TELEGRAM_BOT_TOKEN: 'token' }, root)
  assert.equal(config.proxy, 'http://127.0.0.1:7897/')
})

test('an unsupported proxy protocol is refused with the file in mind', async () => {
  const root = await state({ proxy: 'socks5://127.0.0.1:7897' })
  await assert.rejects(loadConfig({ TELEGRAM_BOT_TOKEN: 'token' }, root), /proxy must be an http:\/\/ or https:\/\/ URL/)
})

test('no proxy stays undefined', async () => {
  const root = await state({})
  const config = await loadConfig({ TELEGRAM_BOT_TOKEN: 'token' }, root)
  assert.equal(config.proxy, undefined)
})
