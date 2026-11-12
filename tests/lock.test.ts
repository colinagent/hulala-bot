import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireLock, holderPid, lockPath } from '../src/store/lock.ts'

/** Never touch the real home: the lock directory is injected per test. */
const dir = await mkdtemp(join(tmpdir(), 'hulala-bot-lock-'))
const env = { HULALA_BOT_LOCK_DIR: dir }

test('the lock path is a digest, so the credential never appears in a filename', () => {
  const path = lockPath('telegram:123456:ABC-secret', env)
  assert.ok(path.endsWith('.lock'))
  assert.ok(!path.includes('ABC-secret'))
  assert.match(path, /[0-9a-f]{16}\.lock$/)
})

test('one credential, one connection, across state directories', async () => {
  // The home directory is shared, so this is the same lock a DSH plugin and a
  // Hulala plugin would contend for.
  const identity = 'telegram:1:cross-home'
  const first = await acquireLock(identity, env)
  await assert.rejects(acquireLock(identity, env), /already running|already connected/)
  // Our own pid is not "another poller"; a live foreign pid is.
  assert.equal(await holderPid(identity, env), undefined)
  await writeFile(lockPath(identity, env), `${String(process.ppid)}\n`, { mode: 0o600 })
  assert.equal(await holderPid(identity, env), process.ppid)
  await first()
  assert.equal(await holderPid(identity, env), undefined)
})

test('a lock left by a dead process is replaced', async () => {
  const identity = 'lark:cli_0123456789abcdef'
  const path = lockPath(identity, env)
  await writeFile(path, '999999999\n', { mode: 0o600 })
  const release = await acquireLock(identity, env)
  assert.equal((await readFile(path, 'utf8')).trim(), String(process.pid))
  await release()
})

test('releasing is idempotent', async () => {
  const token = '3:idempotent'
  const release = await acquireLock(token, env)
  await release()
  await release()
  const again = await acquireLock(token, env)
  await again()
  await rm(lockPath(token, env), { force: true })
})
