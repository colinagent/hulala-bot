/**
 * What the bridge needs from whichever Host it runs inside.
 *
 * A plugin supplies the Host's own context with the Remote-shaped facade over
 * its services; there is no second transport. The bridge only ever calls
 * `ctx.remote`, so this is the single seam between Telegram behaviour and the
 * Host it drives.
 *
 * @module dsh-telegram/host/backend
 */
import type { Context } from '@deepseek-ai/cordis'

/** Envelope every Remote call returns; only these fields matter to the bridge. */
export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message?: string; readonly code?: string } }

/**
 * The Remote facade over Host services.
 *
 * Both hosts build it (`local-remote.ts` in-process); its methods are the
 * `session` and `workspace` calls plus `$on`, and their argument and return
 * types come from the DSH packages the bridge compiles against. Typing it
 * structurally here keeps the seam in one place instead of re-exporting the
 * whole client surface.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the facade forwards calls whose signatures come from the DSH packages */
export type RemoteFacade = {
  readonly session: {
    list(request?: unknown, signal?: AbortSignal): Promise<RemoteResult<any>>
    create(request: unknown): Promise<RemoteResult<any>>
    prompt(request: unknown, signal?: AbortSignal): Promise<RemoteResult<any>>
    cancel(request: unknown): Promise<RemoteResult<any>>
    follow(request: unknown, signal?: AbortSignal): AsyncIterable<any>
  }
  readonly workspace: {
    create(request: unknown): Promise<RemoteResult<any>>
  }
  $on(name: string, handler: (...args: any[]) => any): () => void
}
/* eslint-enable @typescript-eslint/no-explicit-any */


export interface HostBackend {
  /** Host context whose `remote` facade answers session and workspace calls. */
  readonly ctx: Context & { readonly remote: RemoteFacade }
  /** Release anything this backend opened. */
  close(): Promise<void>
}
