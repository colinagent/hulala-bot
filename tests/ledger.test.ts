import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { UpdateLedger } from '../src/telegram/ledger.ts'

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), 'dsh-telegram-ledger-'))

test('remembers an id exactly once', async () => {
  const ledger = await UpdateLedger.open(join(await dir(), 'r.json'))
  assert.equal(ledger.seen(7), false)
  assert.equal(ledger.seen(7), true)
  assert.equal(ledger.seen(8), false)
})

test('survives a restart', async () => {
  const path = join(await dir(), 'r.json')
  const first = await UpdateLedger.open(path)
  first.seen(42)
  await first.flush()
  const second = await UpdateLedger.open(path)
  assert.equal(second.seen(42), true)
  assert.equal(second.cursor, 42)
})

test('drops entries past the TTL', async () => {
  const path = join(await dir(), 'r.json')
  const ledger = await UpdateLedger.open(path, { ttlMs: 10 })
  ledger.seen(5)
  await new Promise(settle => setTimeout(settle, 25))
  ledger.seen(6)
  await ledger.flush()
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { entries: { id: number }[] }
  assert.deepEqual(parsed.entries.map(entry => entry.id), [6])
})

test('honours the capacity, keeping the newest ids', async () => {
  const ledger = await UpdateLedger.open(join(await dir(), 'r.json'), { capacity: 3 })
  for (const id of [1, 2, 3, 4]) ledger.seen(id)
  await ledger.flush()
  assert.equal(ledger.seen(4), true)
  assert.equal(ledger.seen(2), true)
})

test('a corrupt file behaves like an empty ledger', async () => {
  const path = join(await dir(), 'r.json')
  await writeFile(path, 'not json')
  const ledger = await UpdateLedger.open(path)
  assert.equal(ledger.seen(1), false)
})
