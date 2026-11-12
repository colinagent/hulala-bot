import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { InboundEvent } from '../src/channel.ts'
import type { LarkChannelConfig } from '../src/config.ts'
import { LarkApi } from '../src/lark/api.ts'
import { buildCard, stripMentions } from '../src/lark/card.ts'
import { LarkChannel } from '../src/lark/channel.ts'
import type { LarkHandlers, LarkTransport } from '../src/lark/ws.ts'
import { Log } from '../src/log.ts'
import { UpdateLedger } from '../src/store/ledger.ts'

/** One recorded open-platform request. */
interface Call {
  readonly url: string
  readonly method: string
  readonly body: Record<string, unknown>
  readonly authorization: string | undefined
}

/** Scriptable open platform. */
function fakePlatform(plan: (call: Call) => unknown | undefined = () => undefined): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = []
  const handler = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const call: Call = {
      url: url.pathname + url.search,
      method: init?.method ?? 'GET',
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      authorization: (init?.headers as Record<string, string> | undefined)?.authorization,
    }
    calls.push(call)
    const planned = plan(call)
    if (planned !== undefined) {
      return new Response(JSON.stringify(planned), { headers: { 'content-type': 'application/json' } })
    }
    if (call.url.startsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return new Response(JSON.stringify({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    if (call.method === 'POST') {
      return new Response(JSON.stringify({ code: 0, msg: 'ok', data: { message_id: 'om_1' } }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ code: 0, msg: 'ok' }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { calls, fetch: handler }
}

/** Transport that lets a test deliver events synchronously. */
class FakeTransport implements LarkTransport {
  handlers: LarkHandlers | undefined
  closed = false

  async start(handlers: LarkHandlers): Promise<void> {
    this.handlers = handlers
  }

  close(): void {
    this.closed = true
  }
}

/** Let the channel's fire-and-forget event handlers run. */
const tick = (): Promise<void> => new Promise(settle => setTimeout(settle, 10))

test('cards carry markdown and one button row', () => {
  const card = buildCard('已允许', { buttons: [[{ text: '拒绝', data: 'reject:a1' }]] })
  const actions = card.elements.at(1) as { actions: { value: { data: string } }[] }
  assert.deepEqual(actions.actions.map(action => action.value.data), ['reject:a1'])
  assert.deepEqual(card.elements[0], { tag: 'markdown', content: '已允许' })
})

test('mentions are stripped so a command still parses', () => {
  assert.equal(stripMentions('@_user_1 /cwd /tmp'), '/cwd /tmp')
  assert.equal(stripMentions('  hello  '), 'hello')
})

test('one tenant token serves every call', async () => {
  const platform = fakePlatform()
  const api = new LarkApi({ appId: 'cli_0123456789abcdef', appSecret: 's', baseUrl: 'http://fake/open-apis', fetch: platform.fetch })
  assert.equal(await api.sendCard('oc_1', '{}'), 'om_1')
  await api.patchCard('om_1', '{}')
  await api.deleteMessage('om_1')
  const auths = platform.calls.filter(call => call.url.includes('tenant_access_token'))
  assert.equal(auths.length, 1)
  assert.equal(platform.calls.at(-1)?.authorization, 'Bearer t-1')
  assert.equal(platform.calls.at(-1)?.method, 'DELETE')
})

test('an expired token is refreshed once and the call retried', async () => {
  let refreshed = false
  const platform = fakePlatform((call) => {
    if (call.method === 'POST' && call.url.startsWith('/open-apis/im/v1/messages?') && !refreshed) {
      refreshed = true
      return { code: 99991663, msg: 'invalid tenant token' }
    }
    return undefined
  })
  const api = new LarkApi({ appId: 'cli_0123456789abcdef', appSecret: 's', baseUrl: 'http://fake/open-apis', fetch: platform.fetch })
  assert.equal(await api.sendCard('oc_1', '{}'), 'om_1')
  assert.equal(platform.calls.filter(call => call.url.includes('tenant_access_token')).length, 2)
})

test('a card is sent as an interactive message with the card as JSON content', async () => {
  const platform = fakePlatform()
  const api = new LarkApi({ appId: 'cli_0123456789abcdef', appSecret: 's', baseUrl: 'http://fake/open-apis', fetch: platform.fetch })
  await api.sendCard('oc_1', '{"a":1}')
  const send = platform.calls.find(call => call.url.startsWith('/open-apis/im/v1/messages?'))
  assert.equal(send?.body.msg_type, 'interactive')
  assert.equal(send?.body.receive_id, 'oc_1')
  assert.equal(send?.body.content, '{"a":1}')
})

/** One channel over a fake platform and a fake transport. */
async function channelHarness(): Promise<{
  channel: LarkChannel
  transport: FakeTransport
  events: InboundEvent[]
  controller: AbortController
  calls: Call[]
}> {
  const platform = fakePlatform()
  const transport = new FakeTransport()
  const dir = await mkdtemp(join(tmpdir(), 'hulala-bot-lark-'))
  const config: LarkChannelConfig = {
    appId: 'cli_0123456789abcdef',
    appSecret: 's',
    domain: 'feishu',
    baseUrl: 'http://fake/open-apis',
    allowedUsers: ['ou_1'],
    allowedChats: [],
  }
  const channel = new LarkChannel({
    api: new LarkApi({ appId: config.appId, appSecret: config.appSecret, baseUrl: config.baseUrl, fetch: platform.fetch }),
    transport,
    config,
    ledger: await UpdateLedger.open(join(dir, 'r.json')),
    log: new Log(dir, []),
  })
  const events: InboundEvent[] = []
  const controller = new AbortController()
  void channel.start(async (event) => { events.push(event) }, controller.signal)
  await tick()
  return { channel, transport, events, controller, calls: platform.calls }
}

test('a text message becomes an event with the mention removed', async () => {
  const { transport, events, controller } = await channelHarness()
  try {
    transport.handlers?.message({
      event_id: 'e1',
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 /cwd /tmp' }),
      },
    })
    await tick()
    assert.deepEqual(events, [{
      kind: 'message',
      chat: { channel: 'lark', chatId: 'oc_1' },
      userId: 'ou_1',
      text: '/cwd /tmp',
      fromBot: false,
      messageId: 'om_1',
    }])
  } finally {
    controller.abort()
    await tick()
  }
})

test('a duplicate event is delivered once', async () => {
  const { transport, events, controller } = await channelHarness()
  const event = {
    event_id: 'same',
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
    message: { message_id: 'om_1', chat_id: 'oc_1', message_type: 'text', content: JSON.stringify({ text: 'hi' }) },
  }
  try {
    transport.handlers?.message(event)
    transport.handlers?.message(event)
    await tick()
    assert.equal(events.length, 1)
  } finally {
    controller.abort()
    await tick()
  }
})

test('a sender outside the allowlist never reaches the bridge', async () => {
  const { transport, events, controller } = await channelHarness()
  try {
    transport.handlers?.message({
      event_id: 'e2',
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_stranger' } },
      message: { message_id: 'om_2', chat_id: 'oc_1', message_type: 'text', content: JSON.stringify({ text: 'hi' }) },
    })
    await tick()
    assert.deepEqual(events, [])
  } finally {
    controller.abort()
    await tick()
  }
})

test('a card action becomes a callback and returns its toast', async () => {
  const { channel, transport, events, controller } = await channelHarness()
  try {
    const result = await transport.handlers?.action({
      context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
      operator: { open_id: 'ou_1' },
      action: { value: { data: 'approve:a1' } },
    })
    assert.deepEqual(events, [{
      kind: 'callback',
      chat: { channel: 'lark', chatId: 'oc_1' },
      userId: 'ou_1',
      callbackId: 'om_1',
      messageId: 'om_1',
      data: 'approve:a1',
    }])
    assert.deepEqual(result, {})
    await channel.answer(events[0] as never, '已处理')
    const again = await transport.handlers?.action({
      context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
      operator: { open_id: 'ou_1' },
      action: { value: { data: 'approve:a1' } },
    })
    assert.deepEqual(again, { toast: { type: 'success', content: '已处理' } })
  } finally {
    controller.abort()
    await tick()
  }
})

test('aborting stops the transport', async () => {
  const { transport, controller } = await channelHarness()
  controller.abort()
  await tick()
  assert.equal(transport.closed, true)
})
