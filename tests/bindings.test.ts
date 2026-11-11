import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Bindings, keyOf } from '../src/store/bindings.ts'

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), 'dsh-telegram-bindings-'))

test('keys a topic separately from its chat', () => {
  assert.equal(keyOf({ chatId: 1 }), '1:0')
  assert.equal(keyOf({ chatId: 1, threadId: 9 }), '1:9')
})

test('remembers and resolves a mount', async () => {
  const table = await Bindings.open(await dir())
  table.set({ chatId: 1 }, 'session-a')
  assert.equal(table.get({ chatId: 1 }), 'session-a')
  assert.equal(table.get({ chatId: 1, threadId: 2 }), undefined)
})

test('lists every chat mounted to one session', async () => {
  const table = await Bindings.open(await dir())
  table.set({ chatId: 1 }, 's')
  table.set({ chatId: 2, threadId: 3 }, 's')
  table.set({ chatId: 4 }, 'other')
  assert.deepEqual(table.chatsFor('s'), [{ chatId: 1 }, { chatId: 2, threadId: 3 }])
})

test('round-trips through disk', async () => {
  const root = await dir()
  const first = await Bindings.open(root)
  first.set({ chatId: 5, threadId: 6 }, 'session-b')
  await first.flush()
  const second = await Bindings.open(root)
  assert.equal(second.get({ chatId: 5, threadId: 6 }), 'session-b')
  assert.deepEqual(second.entries(), [{ chatId: 5, threadId: 6 }])
})

test('a missing file starts empty', async () => {
  const table = await Bindings.open(join(await dir(), 'nested'))
  assert.deepEqual(table.entries(), [])
})
