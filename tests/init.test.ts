import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInit } from '../src/init.ts'

/** A throwaway HOME so nothing ever touches the real keychain directory. */
async function home(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-telegram-init-'))
}

test('writes the allowlist and the token reference, never the token', async () => {
  const root = await home()
  const code = await runInit([
    '--token-ref', 'telegram/bot-token',
    '--allowed-user', '1,2',
    '--default-cwd', '/tmp/work',
  ], { HOME: root, HULALA_HOME: join(root, '.hulala') })
  assert.equal(code, 0)
  const file = join(root, '.hulala', 'config', 'dsh-telegram', 'config.json')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    tokenRef: 'telegram/bot-token',
    allowedUsers: [1, 2],
    defaultCwd: '/tmp/work',
  })
  assert.equal((await stat(file)).mode & 0o777, 0o600)
})

test('an empty allowlist is refused instead of written', async () => {
  const root = await home()
  await assert.rejects(
    runInit(['--token-ref', 'telegram/bot-token', '--no-input'], { HOME: root, HULALA_HOME: join(root, '.hulala') }),
    /empty allowlist/,
  )
})

test('inside a Host the file lands under the Harness home', async () => {
  const root = await home()
  await runInit(['--token-ref', 'telegram/bot-token', '--allowed-user', '7', '--no-input'], {
    HOME: root,
    DSH_HOME: join(root, 'dsh'),
  })
  const file = join(root, 'dsh', 'config', 'dsh-telegram', 'config.json')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).allowedUsers, [7])
})
