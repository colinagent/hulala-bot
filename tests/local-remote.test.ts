import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createLocalRemote } from '../src/host/local-remote.ts'

/** Minimal Host context: only the two controllers the facade delegates to. */
function fakeHost(options: {
  failList?: boolean
  onFollow?: (request: unknown, signal?: AbortSignal) => AsyncIterable<unknown>
} = {}) {
  const seen: string[] = []
  const services = new Map<string, unknown>()
  const ctx = {
    sessionController: {
      list: async (request: unknown) => {
        seen.push('list')
        if (options.failList === true) throw new Error('session store is locked')
        return { items: [{ sessionId: 'a', cwd: '/tmp', updatedAt: 1, origin: 'user' }], request }
      },
      create: async (request: unknown) => ({ sessionId: 'new', request }),
      prompt: async (request: unknown) => ({ accepted: true, request }),
      cancel: (request: unknown) => ({ cancelled: true, request }),
      follow: (request: unknown, signal?: AbortSignal) => options.onFollow?.(request, signal) ?? (async function* () {})(),
    },
    workspaceController: {
      create: async (request: unknown) => ({ workspace: { workspaceId: 'w1' }, request }),
    },
    get: (name: string) => services.get(name),
    on: (name: string, handler: unknown) => {
      seen.push(`on:${name}`)
      assert.equal(typeof handler, 'function')
      return () => seen.push(`off:${name}`)
    },
  }
  return { ctx: ctx as never, seen, services, raw: ctx }
}

test('list wraps the Host value in the envelope the bridge unwraps', async () => {
  const host = fakeHost()
  const remote = createLocalRemote(host.ctx)
  const result = await remote.session.list({})
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.value.items, [{ sessionId: 'a', cwd: '/tmp', updatedAt: 1, origin: 'user' }])
})

test('a Host failure becomes an envelope error, not a rejection', async () => {
  const host = fakeHost({ failList: true })
  const result = await createLocalRemote(host.ctx).session.list({})
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.error.message, 'session store is locked')
})

test('create, prompt, cancel and workspace.create delegate with the caller request', async () => {
  const host = fakeHost()
  const remote = createLocalRemote(host.ctx)
  const created = await remote.session.create({ workspaceId: 'w1' })
  const prompted = await remote.session.prompt({ requestId: 'r1', mode: 'queue', content: 'hi' })
  const cancelled = await remote.session.cancel({ sessionId: 'a' })
  const workspace = await remote.workspace.create({ path: '/tmp' })
  assert.deepEqual(created.ok && created.value.sessionId, 'new')
  assert.equal(prompted.ok, true)
  assert.equal(cancelled.ok, true)
  assert.deepEqual(workspace.ok && workspace.value.workspace.workspaceId, 'w1')
})

test('follow stays a bare async iterable because the bridge iterates it directly', async () => {
  const host = fakeHost({
    onFollow: async function* () {
      yield { type: 'snapshot' }
      yield { type: 'event' }
    },
  })
  const frames: unknown[] = []
  for await (const frame of createLocalRemote(host.ctx).session.follow({})) frames.push(frame)
  assert.deepEqual(frames, [{ type: 'snapshot' }, { type: 'event' }])
})

test('commands.execute resolves the live Agent and delegates the line', async () => {
  const host = fakeHost()
  const seen: unknown[] = []
  host.services.set('agents', { get: (sessionId: string) => ({ id: `agent-${sessionId}` }) })
  host.services.set('commands', {
    execute: (agent: unknown, line: string, attachments: readonly unknown[], signal: AbortSignal) => {
      seen.push({ agent, line, attachments, aborted: signal.aborted })
      return { commandId: 'c1' }
    },
  })
  const result = await createLocalRemote(host.ctx).commands.execute('a', '/permission danger-full-access')
  assert.equal(result.ok, true)
  assert.deepEqual(seen, [{
    agent: { id: 'agent-a' },
    line: '/permission danger-full-access',
    attachments: [],
    aborted: false,
  }])
})

test('commands.execute fails closed when the Session has no live Agent', async () => {
  const host = fakeHost()
  const result = await createLocalRemote(host.ctx).commands.execute('gone', '/permission danger-full-access')
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.error.message, 'session gone has no live agent')
})

test('$on subscribes on the Host context and returns its disposer', () => {
  const host = fakeHost()
  const remote = createLocalRemote(host.ctx)
  const off = remote.$on('approval/request', async () => 'allowed-once')
  off()
  assert.deepEqual(host.seen, ['on:approval/request', 'off:approval/request'])
})

test('optional services are read through ctx.get, which needs no inject declaration', async () => {
  const ctx = new Context()
  const provide = (name: string, value: unknown): void => {
    (ctx as unknown as { provide(name: string, value: unknown): void }).provide(name, value)
  }
  provide('schedule', {
    catalog: async () => [{
      id: 's1',
      title: 'T',
      kind: 'daily',
      status: 'active',
      time: '06:00:00.000',
      timeZone: 'Asia/Shanghai',
      scheduledAt: '2026-11-16T22:00:00.000Z',
    }],
  })
  provide('agents', { get: () => ({ id: 'agent-a' }) })
  provide('commands', { execute: () => ({ commandId: 'c1' }) })

  const remote = createLocalRemote(ctx)
  const listed = await remote.schedule.catalog()
  assert.equal(listed.ok, true)
  const ran = await remote.commands.execute('a', '/tasks')
  assert.equal(ran.ok, true)
})

test('a Host without the schedule service reports it instead of throwing', async () => {
  const result = await createLocalRemote(fakeHost().ctx).schedule.catalog()
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.error.message, 'this Host composes no schedule service')
})
