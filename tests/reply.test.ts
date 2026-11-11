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

/** Calls that changed the message itself, ignoring the typing indicator. */
function sends(calls: readonly { method: string }[]): readonly string[] {
  return calls.map(call => call.method).filter(method => method !== 'sendChatAction')
}

test('begins with a placeholder, shows typing, and edits it', async () => {
  const { api, calls } = recorder()
  const stream = new ReplyStream(api, 1, { intervalMs: 0, parseMode: 'plain' })
  await stream.begin()
  await stream.push('hello')
  assert.deepEqual(sends(calls), ['sendMessage', 'editMessageText'])
  assert.equal(calls.filter(call => call.method === 'editMessageText')[0]?.body.text, 'hello')
  assert.ok(calls.some(call => call.method === 'sendChatAction' && call.body.action === 'typing'))
  stream.dispose()
})

test('finishes short text by editing, not by sending again', async () => {
  const { api, calls } = recorder()
  const stream = new ReplyStream(api, 1, { intervalMs: 0, parseMode: 'plain' })
  await stream.begin()
  await stream.finish('final answer')
  assert.deepEqual(sends(calls), ['sendMessage', 'editMessageText'])
  assert.equal(calls.filter(call => call.method === 'editMessageText')[0]?.body.text, 'final answer')
})

test('splits a long final answer into fresh messages', async () => {
  const { api, calls } = recorder()
  const stream = new ReplyStream(api, 1, { intervalMs: 0, parseMode: 'plain' })
  await stream.begin()
  await stream.finish('x'.repeat(9000))
  const messages = calls.filter(call => call.method === 'sendMessage')
  assert.equal(messages.length, 3)
  for (const send of messages) assert.ok(String(send.body.text).length <= 4096)
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

test('replaces the placeholder even when every edit failed', async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = []
  let edits = 0
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = new URL(String(input)).pathname.split('/').pop() ?? ''
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ method, body })
    if (method === 'editMessageText' && edits++ < 5) {
      return new Response(JSON.stringify({ ok: false, description: 'Bad Request: message to edit not found' }), { status: 400 })
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const api = new TelegramApi({ token: 't', baseUrl: 'http://fake', fetch: fake })
  const stream = new ReplyStream(api, 1, { intervalMs: 0, parseMode: 'plain' })
  await stream.begin()
  await stream.finish('answer')
  assert.ok(calls.some(call => call.method === 'deleteMessage'), 'placeholder removed')
  assert.ok(calls.some(call => call.method === 'sendMessage' && call.body.text === 'answer'))
})
