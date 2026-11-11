/**
 * The Remote facade a Host-mounted bridge talks to.
 *
 * `bridge.ts` was written against the client proxy (`ctx.remote`) because that
 * was the only way in from another process. In-process the same four calls are
 * plain service methods, so this adapter hands the bridge the exact shape it
 * already speaks: a `RemoteResult` envelope per call, an async iterable for
 * `follow`, and `$on` forwarding Cordis events.
 *
 * Nothing here re-implements Host behaviour: every method delegates, and the
 * envelope only carries the error message across the one boundary the bridge
 * already unwraps.
 *
 * @module dsh-telegram/host/local-remote
 */
import type { Context } from '@deepseek-ai/cordis'

/** Envelope `bridge.ts` unwraps; failure carries a message, never a stack. */
export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message: string } }

/** The slice of `ctx.remote` this bridge actually uses. */
export interface LocalRemote {
  readonly session: {
    list(request: unknown, signal?: AbortSignal): Promise<RemoteResult<{ items: readonly unknown[] }>>
    create(request: unknown): Promise<RemoteResult<{ sessionId: unknown }>>
    prompt(request: unknown, signal?: AbortSignal): Promise<RemoteResult<unknown>>
    cancel(request: unknown): Promise<RemoteResult<unknown>>
    follow(request: unknown, signal?: AbortSignal): AsyncIterable<unknown>
  }
  readonly workspace: {
    create(request: unknown): Promise<RemoteResult<{ workspace: { workspaceId: unknown } }>>
  }
  $on(name: string, handler: (request: unknown, next: () => Promise<unknown>) => Promise<unknown>): () => void
}

/**
 * Await a call and normalise it into the envelope the bridge unwraps.
 * @param run - the delegating call.
 * @returns the value or its failure message.
 */
async function envelope<T>(run: () => T | Promise<T>): Promise<RemoteResult<T>> {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
  }
}

/** Host services this facade needs. */
interface HostServices {
  sessionController: {
    list(request: never, signal: AbortSignal): Promise<{ items: readonly unknown[] }>
    create(request: never): Promise<{ sessionId: unknown }>
    prompt(request: never, signal: AbortSignal): Promise<unknown>
    cancel(request: never): unknown
    follow(request: never, signal: AbortSignal): AsyncIterable<unknown>
  }
  workspaceController: {
    create(request: never): Promise<{ workspace: { workspaceId: unknown } }>
  }
}

/**
 * Build the in-process Remote facade over the Host's own services.
 * @param ctx - Host context carrying the session and workspace controllers.
 * @returns the facade `bridge.ts` accepts as `ctx.remote`.
 */
export function createLocalRemote(ctx: Context): LocalRemote {
  const services = ctx as unknown as HostServices
  // One lifetime for reads that take a signal; an aborted read is a bridge bug,
  // not a Host condition, so it is never cancelled from here.
  const lifetime = new AbortController()
  return {
    session: {
      list: request => envelope(() => services.sessionController.list(request as never, lifetime.signal)),
      create: request => envelope(() => services.sessionController.create(request as never)),
      prompt: (request, signal) => envelope(() => services.sessionController.prompt(request as never, signal ?? lifetime.signal)),
      cancel: request => envelope(() => services.sessionController.cancel(request as never)),
      follow: (request, signal) => services.sessionController.follow(request as never, signal ?? lifetime.signal),
    },
    workspace: {
      create: request => envelope(() => services.workspaceController.create(request as never)),
    },
    $on: (name, handler) => ctx.on(name as never, handler as never) as unknown as () => void,
  }
}
