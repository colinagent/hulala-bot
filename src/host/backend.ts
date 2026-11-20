/**
 * What the bridge needs from whichever Host it runs inside.
 *
 * A plugin supplies the Host's own context with the Remote-shaped facade over
 * its services; there is no second transport. The bridge only ever calls
 * `ctx.remote`, so this is the single seam between Telegram behaviour and the
 * Host it drives.
 *
 * @module hulala-bot/host/backend
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionControlFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ScheduleTask } from '../tasks.ts'

/** One structured answer item, exactly the shape DSH's `AskUserQuestionAnswer` accepts. */
export interface QuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string | undefined
}

/** One structured answer batch: one item per question of the call. */
export interface QuestionAnswerBatch {
  readonly answers: readonly QuestionAnswerItem[]
}

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
    /**
     * Host-wide live control state: one baseline carrying every Session's
     * projections, then one frame per committed event that changed them.
     * This is the same stream the official Web client consumes for
     * `userQuestions` / `inbox`; no private projection registry is involved.
     */
    control(signal: AbortSignal): AsyncIterable<SessionControlFrame>
  }
  readonly workspace: {
    create(request: unknown): Promise<RemoteResult<any>>
  }
  /** Run one Host command line against the Session's own live Agent. */
  readonly commands: {
    execute(sessionId: string, line: string): Promise<RemoteResult<unknown>>
  }
  /** Every Host scheduled task; listing needs no Session or live Agent. */
  readonly schedule: {
    catalog(): Promise<RemoteResult<readonly ScheduleTask[]>>
  }
  /** Timed-question halves a card needs; in-process, so the Agent is exact. */
  readonly userQuestions: {
    /**
     * Hold one foreground wait and read what is left of it.
     *
     * The Host suspends its own timer while any client holds the claim, so an
     * answering UI owns the countdown and must reject with `ASK_TIMED_OUT`
     * when it ends. Closing the stream hands the deadline back to the Host.
     */
    attachWait(agent: unknown, callId: string, signal: AbortSignal): AsyncIterable<{ remainingMs: number }>
    /**
     * Steer a late answer into a `continued` question of one Session.
     *
     * `true` only means the reply was queued; the projection closes the row
     * when the agent admits its `user-question-reply` user message.
     */
    answer(sessionId: string, callId: string, answer: QuestionAnswerBatch): Promise<RemoteResult<boolean>>
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
