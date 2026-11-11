import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { acquireLock, lockPath, pollerPid } from '../src/store/lock.ts'

/** Never touch the real home: the lock directory is injected per test. */
const dir = await mkdtemp(join(tmpdir(), 'dsh-telegram-lock-'))
const env = { DSH_TELEGRAM_LOCK_DIR: dir }

test('the lock path is a digest, so the token never appears in a filename', () => {
  const path = lockPath('123456:ABC-secret', env)
  assert.ok(path.endsWith('.lock'))
  assert.ok(!path.includes('ABC-secret'))
  assert.match(path, /[0-9a-f]{16}\.lock$/)
})

test('one token, one poller, across state directories', async () => {
  // The home directory is shared, so this is the same lock a DSH plugin and a
  // Hulala plugin would contend for.
  const token = '1:cross-home'
  const first = await acquireLock(token, env)
  await assert.rejects(acquireLock(token, env), /already being polled/)
  // Our own pid is not "another poller"; a live foreign pid is.
  assert.equal(await pollerPid(token, env), undefined)
  await writeFile(lockPath(token, env), `${String(process.ppid)}\n`, { mode: 0o600 })
  assert.equal(await pollerPid(token, env), process.ppid)
  await first()
  assert.equal(await pollerPid(token, env), undefined)
})

test('a lock left by a dead process is replaced', async () => {
  const token = '2:stale'
  const path = lockPath(token, env)
  await writeFile(path, '999999999\n', { mode: 0o600 })
  const release = await acquireLock(token, env)
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
