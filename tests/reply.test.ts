import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ReplyStream } from '../src/reply.ts'
import type { ChatKey } from '../src/channel.ts'
import type { TelegramChannelConfig } from '../src/config.ts'
import { Log } from '../src/log.ts'
import { UpdateLedger } from '../src/store/ledger.ts'
import { TelegramApi } from '../src/telegram/api.ts'
import { TelegramChannel } from '../src/telegram/channel.ts'

interface Call {
  readonly method: string
  readonly body: Record<string, unknown>
}

/** Record every Bot API call the stream makes. */
function recorder(handle?: (method: string, body: Record<string, unknown>) => Response | undefined): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = url.pathname.split('/').pop() ?? ''
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const handled = handle?.(method, body)
    if (handled !== undefined) return handled
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

/** One streaming channel over a recording Bot API. */
async function harness(options: {
  parseMode?: 'plain' | 'markdown'
  threadId?: string
  handle?: (method: string, body: Record<string, unknown>) => Response | undefined
} = {}): Promise<{ calls: Call[]; chat: ChatKey; stream: ReplyStream; errors: string[] }> {
  const calls: Call[] = []
  const errors: string[] = []
  const fake = recorder((method, body) => {
    calls.push({ method, body })
    return options.handle?.(method, body)
  })
  const dir = await mkdtemp(join(tmpdir(), 'hulala-bot-reply-'))
  const config: TelegramChannelConfig = {
    token: 't',
    baseUrl: 'http://fake',
    proxy: undefined,
    allowedUsers: [1],
    allowedChats: [],
    parseMode: options.parseMode ?? 'plain',
    pollTimeoutSeconds: 1,
  }
  const channel = new TelegramChannel({
    api: new TelegramApi({ token: 't', baseUrl: 'http://fake', fetch: fake }),
    config,
    ledger: await UpdateLedger.open(join(dir, 'r.json')),
    log: new Log(dir, []),
    commands: [],
  })
  const chat: ChatKey = {
    channel: 'telegram',
    chatId: '1',
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
  }
  return {
    calls,
    chat,
    stream: new ReplyStream(channel, chat, {
      intervalMs: 0,
      onError: message => { errors.push(message) },
    }),
    errors,
  }
}

/** Calls that changed the message itself, ignoring the typing indicator. */
function sends(calls: readonly { method: string }[]): readonly string[] {
  return calls.map(call => call.method).filter(method => method !== 'sendChatAction')
}

test('begins with a placeholder, shows typing, and edits it', async () => {
  const { calls, stream } = await harness()
  await stream.begin()
  await stream.push('hello')
  assert.deepEqual(sends(calls), ['sendMessage', 'editMessageText'])
  assert.equal(calls.filter(call => call.method === 'editMessageText')[0]?.body.text, 'hello')
  assert.ok(calls.some(call => call.method === 'sendChatAction' && call.body.action === 'typing'))
  stream.dispose()
})

test('finishes short text by editing, not by sending again', async () => {
  const { calls, stream } = await harness()
  await stream.begin()
  await stream.finish('final answer')
  assert.deepEqual(sends(calls), ['sendMessage', 'editMessageText'])
  assert.equal(calls.filter(call => call.method === 'editMessageText')[0]?.body.text, 'final answer')
})

test('splits a long final answer into fresh messages', async () => {
  const { calls, stream } = await harness()
  await stream.begin()
  await stream.finish('x'.repeat(9000))
  const messages = calls.filter(call => call.method === 'sendMessage')
  assert.equal(messages.length, 3)
  for (const send of messages) assert.ok(String(send.body.text).length <= 4000)
})

test('markdown mode escapes and falls back to plain text on a 400', async () => {
  let failed = false
  const { calls, stream } = await harness({
    parseMode: 'markdown',
    handle: (method, body) => {
      if (method === 'editMessageText' && body.parse_mode === 'MarkdownV2' && String(body.text).includes('_') && !failed) {
        failed = true
        return new Response(JSON.stringify({ ok: false, description: "can't parse entities" }), { status: 400 })
      }
      return undefined
    },
  })
  await stream.begin()
  await stream.finish('a_b')
  assert.ok(calls.some(body => body.body.parse_mode === 'MarkdownV2'))
  assert.equal(calls.at(-1)?.body.text, 'a_b')
  assert.equal(calls.at(-1)?.body.parse_mode, undefined)
})

test('carries the thread id on every call', async () => {
  const { calls, stream } = await harness({ threadId: '77' })
  await stream.begin()
  await stream.finish('x')
  for (const call of calls) assert.equal(call.body.message_thread_id ?? 77, 77)
})

test('replaces the placeholder even when every edit failed', async () => {
  const { calls, stream } = await harness({
    handle: (method) => method !== 'editMessageText'
      ? undefined
      : new Response(JSON.stringify({ ok: false, description: 'Bad Request: message to edit not found' }), { status: 400 }),
  })
  await stream.begin()
  await stream.finish('answer')
  assert.ok(calls.some(call => call.method === 'deleteMessage'), 'placeholder removed')
  assert.ok(calls.some(call => call.method === 'sendMessage' && call.body.text === 'answer'))
})

test('an edit that changes nothing is success, not a failure', async () => {
  const { calls, stream } = await harness({
    handle: (method, body) => method === 'editMessageText' && body.text === 'same'
      ? new Response(JSON.stringify({ ok: false, description: 'Bad Request: message is not modified' }), { status: 400 })
      : undefined,
  })
  await stream.begin()
  await stream.push('same')
  await stream.finish('same')
  assert.ok(!calls.some(call => call.method === 'deleteMessage'))
})

test('a send that cannot be retried is reported, not swallowed', async () => {
  const { errors, stream } = await harness({
    handle: (method) => method === 'sendMessage'
      ? new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 })
      : undefined,
  })
  await stream.begin()
  await stream.finish('answer')
  assert.ok(errors.some(message => message.includes('chat not found')), `no error reported: ${errors.join(' | ')}`)
})
