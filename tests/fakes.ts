/**
 * Test doubles: a Bot API server and a Host backend.
 *
 * Both speak the shapes the bridge actually uses, so a test drives the real
 * bridge code without a network, a token, or a running Host.
 *
 * @module dsh-telegram/tests/fakes
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One recorded Bot API call. */
export interface Recorded {
  readonly method: string
  readonly body: Record<string, unknown>
}

/** Scriptable Bot API endpoint. */
export class FakeTelegram {
  readonly calls: Recorded[] = []
  readonly #server: Server
  #queue: Record<string, unknown>[] = []
  #waiters: (() => void)[] = []
  #port = 0

  constructor() {
    this.#server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const method = new URL(request.url ?? '/', 'http://localhost').pathname.split('/').pop() ?? ''
        const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
        this.calls.push({ method, body })
        void this.#respond(method).then(result => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ ok: true, result }))
        })
      })
    })
  }

  async #respond(method: string): Promise<unknown> {
    if (method !== 'getUpdates') return { message_id: this.calls.length }
    const update = this.#queue.shift()
    if (update !== undefined) return [update]
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter(waiter => waiter !== wake)
        resolve()
      }, 60)
      const wake = (): void => {
        clearTimeout(timer)
        resolve()
      }
      this.#waiters.push(wake)
    })
    const next = this.#queue.shift()
    return next === undefined ? [] : [next]
  }

  /** Start listening on an ephemeral port. */
  async start(): Promise<string> {
    await new Promise<void>(resolve => this.#server.listen(0, '127.0.0.1', resolve))
    this.#port = (this.#server.address() as AddressInfo).port
    return this.url
  }

  /** Base URL the bridge should call. */
  get url(): string {
    return `http://127.0.0.1:${String(this.#port)}`
  }

  /** Deliver one update on the next poll. */
  push(update: Record<string, unknown>): void {
    this.#queue.push(update)
    for (const waiter of this.#waiters) waiter()
    this.#waiters = []
  }

  /** Messages sent to one chat, oldest first. */
  texts(chatId: number): readonly string[] {
    return this.calls
      .filter(call => call.method === 'sendMessage' || call.method === 'editMessageText')
      .filter(call => call.body.chat_id === chatId)
      .map(call => String(call.body.text ?? ''))
  }

  /** Every recorded call of one method. */
  of(method: string): readonly Recorded[] {
    return this.calls.filter(call => call.method === method)
  }

  /** Wait until `predicate` holds. */
  async until(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out; calls: ${this.calls.map(call => call.method).join(',')}`)
      await new Promise(settle => setTimeout(settle, 15))
    }
  }

  /** Close the server. */
  async stop(): Promise<void> {
    this.#server.closeAllConnections()
    await new Promise<void>(resolve => this.#server.close(() => resolve()))
  }
}

/** One inbound text message. */
export function messageUpdate(updateId: number, chatId: number, userId: number, text: string): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: 'private' },
      from: { id: userId, is_bot: false },
      text,
    },
  }
}

/** One button press. */
export function callbackUpdate(updateId: number, chatId: number, userId: number, messageId: number, data: string): Record<string, unknown> {
  return {
    update_id: updateId,
    callback_query: { id: `cb${String(updateId)}`, from: { id: userId }, data, message: { message_id: messageId, chat: { id: chatId, type: 'private' } } },
  }
}

/** Result wrapper the Remote layer uses. */
function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

/** In-memory Host the bridge can drive. */
export class FakeHost {
  readonly calls: { method: string; args: unknown }[] = []
  readonly sessions: { sessionId: string; cwd: string; updatedAt: number; running: boolean; origin?: string }[] = []
  readonly prompts: { sessionId: string; text: string }[] = []
  readonly followRequests: unknown[] = []
  readonly #handlers = new Map<string, (request: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
  readonly #streams = new Set<(frame: unknown) => void>()
  #created = 0
  #disposed = false

  /** Backend facade handed to the bridge. */
  get backend(): unknown {
    const host = this
    const remote = {
      $on(name: string, handler: (request: unknown, next: () => Promise<unknown>) => Promise<unknown>) {
        host.#handlers.set(name, handler)
        return () => { host.#handlers.delete(name) }
      },
      session: {
        list: () => ok({ items: host.sessions.map(session => ({ ...session, blank: false, agentAvailable: true })) }),
        create: () => {
          host.#created += 1
          const session = { sessionId: `s${String(host.#created)}`, cwd: '/workspace/default', updatedAt: Date.now(), running: false }
          host.sessions.push(session)
          return ok({ sessionId: session.sessionId })
        },
        prompt: (request: { sessionId: string; content: { text: string }[] }) => {
          host.prompts.push({ sessionId: request.sessionId, text: request.content[0]?.text ?? '' })
          return ok({ accepted: true })
        },
        cancel: () => ok({ cancelled: true }),
        follow: (request: unknown, signal: AbortSignal) => {
          host.followRequests.push(request)
          let closed = false
          const queue: unknown[] = []
          let resume: (() => void) | undefined
          const push = (frame: unknown): void => {
            queue.push(frame)
            resume?.()
          }
          host.#streams.add(push)
          signal.addEventListener('abort', () => {
            closed = true
            host.#streams.delete(push)
            resume?.()
          }, { once: true })
          return {
            async *[Symbol.asyncIterator]() {
              while (!closed) {
                const frame = queue.shift()
                if (frame !== undefined) { yield frame; continue }
                await new Promise<void>(settle => { resume = settle })
              }
            },
            dispose: () => { closed = true; host.#streams.delete(push) },
          }
        },
      },
      workspace: {
        create: (request: { path: string }) => {
          host.calls.push({ method: 'workspace.create', args: request })
          return ok({ workspace: { workspaceId: `w:${request.path}` } })
        },
      },
    }
    return { ctx: { remote, fiber: { dispose: async () => { host.#disposed = true } } }, endpoint: { version: 'test' }, close: async () => { host.#disposed = true } }
  }

  /** Whether the bridge closed the connection. */
  get disposed(): boolean {
    return this.#disposed
  }

  /** Push one follow frame into every open stream. */
  emit(frame: unknown): void {
    for (const push of this.#streams) push(frame)
  }

  /** Invoke one registered waterfall handler. */
  async invoke(name: string, request: unknown, next: () => Promise<unknown> = async () => 'unavailable'): Promise<unknown> {
    const handler = this.#handlers.get(name)
    if (handler === undefined) throw new Error(`${name} is not registered`)
    return await handler(request, next)
  }

  /** Whether a handler is registered for one event. */
  handles(name: string): boolean {
    return this.#handlers.has(name)
  }
}

/** One session turn-start frame. */
export function turnStart(): unknown {
  return { type: 'event', event: { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } } }
}

/** One streamed text delta. */
export function textDelta(attemptId: string, text: string): unknown {
  return { type: 'assistant-stream', frame: { type: 'chunk', attemptId, revision: 1, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text } } }
}

/** One attempt start frame. */
export function attemptStart(attemptId: string): unknown {
  return { type: 'assistant-stream', frame: { type: 'start', attemptId, revision: 0, startedAfterSeq: 0, turn: 1, step: 1 } }
}

/** One committed assistant message. */
export function assistantMessage(text: string): unknown {
  return {
    type: 'event',
    event: { type: 'assistant/message', seq: 2, time: Date.now(), data: { message: { content: [{ type: 'text', text }] } } },
  }
}

/** One turn end. */
export function turnEnd(): unknown {
  return { type: 'event', event: { type: 'turn/end', seq: 3, time: Date.now(), data: { turn: 1, reason: 'completed' } } }
}
