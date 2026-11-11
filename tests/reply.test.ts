import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TelegramApi } from '../src/telegram/api.ts'
import { ReplyStream } from '../src/telegram/reply.ts'

interface Call {
  readonly method: string
  readonly body: Record<string, unknown>
}

/** Record every Bot API call the stream makes. */
function recorder(): { api: TelegramApi; calls: Call[] } {
  const calls: Call[] = []
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ method: url.pathname.split('/').pop() ?? '', body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { api: new TelegramApi({ token: 't', baseUrl: 'http://fake', fetch: fake }), calls }
}

test('begins with a placeholder and edits it', async () => {
  const { api, calls } = recorder()
  const stream = new ReplyStream(api, 1, { intervalMs: 0, parseMode: 'plain' })
  await stream.begin()
  await stream.push('hello')
  assert.deepEqual(calls.map(call => call.method), ['sendMessage', 'editMessageText'])
  assert.equal(calls[1]?.body.text, 'hello')
  stream.dispose()
})

test('finishes short text by editing, not by sending again', async () => {
  const { api, calls } = recorder()
  const stream = new ReplyStream(api, 1, { intervalMs: 0, parseMode: 'plain' })
  await stream.begin()
  await stream.finish('final answer')
  assert.deepEqual(calls.map(call => call.method), ['sendMessage', 'editMessageText'])
  assert.equal(calls[1]?.body.text, 'final answer')
})

test('splits a long final answer into fresh messages', async () => {
  const { api, calls } = recorder()
  const stream = new ReplyStream(api, 1, { intervalMs: 0, parseMode: 'plain' })
  await stream.begin()
  await stream.finish('x'.repeat(9000))
  const sends = calls.filter(call => call.method === 'sendMessage')
  assert.equal(sends.length, 3)
  for (const send of sends) assert.ok(String(send.body.text).length <= 4096)
})

test('markdown mode escapes and falls back to plain text on a 400', async () => {
  let failed = false
  const calls: Record<string, unknown>[] = []
  const fake = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push(body)
    if (body.parse_mode === 'MarkdownV2' && String(body.text).includes('_') && !failed) {
      failed = true
      return new Response(JSON.stringify({ ok: false, description: "can't parse entities" }), { status: 400 })
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const api = new TelegramApi({ token: 't', baseUrl: 'http://fake', fetch: fake })
  const stream = new ReplyStream(api, 1, { intervalMs: 0, parseMode: 'markdown' })
  await stream.begin()
  await stream.finish('a_b')
  assert.ok(calls.some(body => body.parse_mode === 'MarkdownV2'))
  assert.equal(calls.at(-1)?.text, 'a_b')
  assert.equal(calls.at(-1)?.parse_mode, undefined)
})

test('carries the thread id on every call', async () => {
  const { api, calls } = recorder()
  const stream = new ReplyStream(api, 1, { intervalMs: 0, parseMode: 'plain', threadId: 77 })
  await stream.begin()
  await stream.finish('x')
  for (const call of calls) assert.equal(call.body.message_thread_id ?? 77, 77)
})
