import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Bindings, keyOf } from '../src/store/bindings.ts'

const dir = (): Promise<string> => mkdtemp(join(tmpdir(), 'hulala-bot-bindings-'))

test('keys a channel and a topic separately', () => {
  assert.equal(keyOf({ channel: 'telegram', chatId: '1' }), 'telegram:1:')
  assert.equal(keyOf({ channel: 'telegram', chatId: '1', threadId: '9' }), 'telegram:1:9')
  assert.equal(keyOf({ channel: 'lark', chatId: 'oc_1' }), 'lark:oc_1:')
})

test('remembers and resolves a mount', async () => {
  const table = await Bindings.open(await dir())
  table.set({ channel: 'telegram', chatId: '1' }, 'session-a')
  assert.equal(table.get({ channel: 'telegram', chatId: '1' }), 'session-a')
  assert.equal(table.get({ channel: 'telegram', chatId: '1', threadId: '2' }), undefined)
  assert.equal(table.get({ channel: 'lark', chatId: 'oc_1' }), undefined)
})

test('lists every conversation mounted to one session', async () => {
  const table = await Bindings.open(await dir())
  table.set({ channel: 'telegram', chatId: '1' }, 's')
  table.set({ channel: 'telegram', chatId: '2', threadId: '3' }, 's')
  table.set({ channel: 'lark', chatId: 'oc_4' }, 'other')
  assert.deepEqual(table.chatsFor('s'), [
    { channel: 'telegram', chatId: '1' },
    { channel: 'telegram', chatId: '2', threadId: '3' },
  ])
})

test('round-trips through disk', async () => {
  const root = await dir()
  const first = await Bindings.open(root)
  first.set({ channel: 'telegram', chatId: '5', threadId: '6' }, 'session-b')
  await first.flush()
  const second = await Bindings.open(root)
  assert.equal(second.get({ channel: 'telegram', chatId: '5', threadId: '6' }), 'session-b')
  assert.deepEqual(second.entries(), [{ channel: 'telegram', chatId: '5', threadId: '6' }])
})

test('a missing file starts empty', async () => {
  const table = await Bindings.open(join(await dir(), 'nested'))
  assert.deepEqual(table.entries(), [])
})

test('a key from another product is ignored rather than crashing', async () => {
  const root = await dir()
  const table = await Bindings.open(root)
  table.set({ channel: 'lark', chatId: 'oc_1' }, 's')
  await table.flush()
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(root, 'bindings.json'), JSON.stringify({
    'lark:oc_1:': { sessionId: 's', updatedAt: 1 },
    'slack:C1:': { sessionId: 's', updatedAt: 1 },
  }))
  const reloaded = await Bindings.open(root)
  assert.deepEqual(reloaded.entries(), [{ channel: 'lark', chatId: 'oc_1' }])
})
