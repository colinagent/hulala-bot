/**
 * Test doubles: a Bot API server and a Host backend.
 *
 * Both speak the shapes the bridge actually uses, so a test drives the real
 * bridge code without a network, a token, or a running Host.
 *
 * @module hulala-bot/tests/fakes
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Channel, ChatKey, InboundEvent, Outgoing, SendOptions } from '../src/channel.ts'

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
  #edits = new Map<string, unknown>()
  #port = 0

  constructor() {
    this.#server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
        if (pathname.startsWith('/file/')) {
          response.writeHead(200, { 'content-type': 'image/jpeg' })
          response.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
          return
        }
        const method = pathname.split('/').pop() ?? ''
        const raw = Buffer.concat(chunks).toString()
        const multipart = String(request.headers['content-type'] ?? '').startsWith('multipart/form-data')
        const body = raw === '' ? {} : multipart ? { multipart: true, raw } : JSON.parse(raw) as Record<string, unknown>
        this.calls.push({ method, body })
        void this.#respond(method, body).then(result => {
          const document = result as { ok?: boolean }
          const failed = document.ok === false
          response.writeHead(failed ? 400 : 200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(failed ? result : { ok: true, result }))
        })
      })
    })
  }

  async #respond(method: string, body: Record<string, unknown>): Promise<unknown> {
    if (method === 'editMessageText') {
      const key = `${String(body.chat_id)}:${String(body.message_id)}`
      const previous = this.#edits.get(key)
      if (previous === body.text) {
        // Exactly what Telegram answers when an edit changes nothing.
        return { ok: false, description: 'Bad Request: message is not modified', code: 400 }
      }
      this.#edits.set(key, body.text)
      return { message_id: body.message_id }
    }
    if (method === 'getFile') return { file_path: 'photos/file.jpg', file_size: 4 }
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
  readonly prompts: { sessionId: string; text: string; content?: readonly { type: string; text?: string }[] }[] = []
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
        create: (request?: { workspaceId?: unknown }) => {
          host.#created += 1
          const workspaceId = String(request?.workspaceId ?? '')
          const cwd = workspaceId.startsWith('w:') ? workspaceId.slice(2) : '/workspace/default'
          const session = { sessionId: `s${String(host.#created)}`, cwd, updatedAt: Date.now(), running: false }
          host.sessions.push(session)
          return ok({ sessionId: session.sessionId })
        },
        prompt: (request: { sessionId: string; content: { type: string; text?: string }[] }) => {
          host.prompts.push({
            sessionId: request.sessionId,
            text: request.content.find(part => part.type === 'text')?.text ?? '',
            content: request.content,
          })
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

  /** How many sessions the bridge created. */
  get created(): number {
    return this.#created
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

/** One recorded message on a surface that is not Telegram. */
export interface SurfaceMessage {
  readonly chat: ChatKey
  readonly messageId: string
  readonly text: string
  readonly keyboard?: SendOptions['keyboard']
}

/**
 * A second surface for cross-channel tests.
 *
 * It implements the channel contract with nothing but arrays, so a bridge test
 * can prove an approval reaches every mounted conversation without needing a
 * real Lark tenant.
 */
export class FakeSurface implements Channel {
  readonly name = 'lark' as const
  readonly maxTextLength = 4000
  readonly pinnedStatus = false
  readonly sent: SurfaceMessage[] = []
  readonly edits: SurfaceMessage[] = []
  #next = 0
  #onEvent: ((event: InboundEvent) => Promise<void>) | undefined
  #ready: { promise: Promise<void>; resolve: () => void } = (() => {
    let resolve: () => void = () => undefined
    const promise = new Promise<void>(settle => { resolve = settle })
    return { promise, resolve }
  })()

  format(text: string): string {
    return text
  }

  async send(chat: ChatKey, body: Outgoing, options: SendOptions = {}): Promise<string> {
    this.#next += 1
    const messageId = `m${String(this.#next)}`
    this.sent.push({
      chat,
      messageId,
      text: body.parts[0] ?? body.text,
      ...(options.keyboard === undefined ? {} : { keyboard: options.keyboard }),
    })
    return messageId
  }

  async edit(chat: ChatKey, messageId: string, body: Outgoing, options: SendOptions = {}): Promise<void> {
    this.edits.push({
      chat,
      messageId,
      text: body.parts[0] ?? body.text,
      ...(options.keyboard === undefined ? {} : { keyboard: options.keyboard }),
    })
  }

  async delete(): Promise<void> {
    // Nothing to release.
  }

  async answer(): Promise<void> {
    // The toast is a Lark transport detail; nothing to record here.
  }

  /** Resolves once the bridge has started this surface. */
  async whenStarted(): Promise<void> {
    await this.#ready.promise
  }

  async start(onEvent: (event: InboundEvent) => Promise<void>, signal: AbortSignal): Promise<void> {
    this.#onEvent = onEvent
    this.#ready.resolve()
    await new Promise<void>(resolve => {
      if (signal.aborted) { resolve(); return }
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }

  /** Deliver one event as this surface. */
  async emit(event: InboundEvent): Promise<void> {
    await this.#onEvent?.(event)
  }
}

/** One inbound photo, with an optional caption. */
export function photoUpdate(updateId: number, chatId: number, userId: number, caption?: string): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: 'private' },
      from: { id: userId, is_bot: false },
      ...(caption === undefined ? {} : { caption }),
      photo: [
        { file_id: 'small', file_size: 100, width: 90, height: 90 },
        { file_id: 'large', file_size: 4000, width: 1280, height: 1280 },
      ],
    },
  }
}
