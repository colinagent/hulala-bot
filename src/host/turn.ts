/**
 * Fold the follow stream into one assistant turn.
 *
 * Two sources describe the same answer: process-local `assistant-stream` frames
 * that arrive as the model writes, and the durable `assistant/message` event
 * committed at the end. Frames drive the live preview; the durable text wins
 * when the turn settles, so the final message never drifts from history.
 *
 * @module dsh-telegram/host/turn
 */
import type { SessionFollowFrame } from '@deepseek-ai/dsh-api-session-controller/types'

/** Join the text blocks of one assistant message. */
export function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .flatMap(block => {
      if (block === null || typeof block !== 'object') return []
      const record = block as { type?: unknown; text?: unknown }
      return record.type === 'text' && typeof record.text === 'string' ? [record.text] : []
    })
    .join('\n')
}

/** What one turn currently looks like. */
export interface TurnView {
  /** Text the model has streamed so far. */
  readonly streamed: string
  /** Text the durable assistant message committed, once it exists. */
  readonly durable: string
  /** Number of tool calls observed in this turn. */
  readonly tools: number
}

/** What one follow frame implies for the chat. */
export type TurnEffect = 'begin' | 'delta' | 'final' | 'end'

/** Accumulates one followed session's turn state. */
export class TurnTracker {
  #streamed = ''
  #durable = ''
  #tools = 0
  #tool: string | undefined
  #attempt: string | undefined

  /** Reset for a new turn. */
  begin(): void {
    this.#streamed = ''
    this.#durable = ''
    this.#tools = 0
    this.#tool = undefined
    this.#attempt = undefined
  }

  /** Text to show while the turn is still running. */
  get preview(): string {
    if (this.text !== '') return this.text
    return this.#tool === undefined ? '' : `· ${this.#tool} …`
  }

  /** Text to display, preferring the durable message. */
  get text(): string {
    return this.#durable !== '' ? this.#durable : this.#streamed
  }

  /** Whether any text has been produced. */
  get empty(): boolean {
    return this.text === ''
  }

  /** Current view. */
  get view(): TurnView {
    return { streamed: this.#streamed, durable: this.#durable, tools: this.#tools }
  }

  /**
   * Apply one follow frame.
   * @param frame - a frame from `session.follow`.
   * @returns `delta` when the preview should be refreshed, `final` when the
   * durable answer landed, or undefined for frames this tracker ignores.
   */
  apply(frame: SessionFollowFrame): TurnEffect | undefined {
    if (frame.type === 'snapshot') {
      if (frame.assistantStream?.activeAttempt !== undefined) {
        this.#attempt = frame.assistantStream.activeAttempt.attemptId
        this.#streamed = ''
      }
      return undefined
    }
    if (frame.type === 'assistant-stream') {
      const inner = frame.frame
      if (inner.type === 'start') {
        this.#attempt = inner.attemptId
        this.#streamed = ''
        return 'delta'
      }
      if (inner.type === 'chunk' && inner.attemptId === this.#attempt) {
        const chunk = inner.chunk as { type?: unknown; text?: unknown }
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          this.#streamed += chunk.text
          return 'delta'
        }
        return undefined
      }
      return undefined
    }
    const event = frame.event
    if (event.type === 'turn/start') {
      this.begin()
      return 'begin'
    }
    if (event.type === 'turn/end') return 'end'
    if (event.type === 'assistant/message') {
      const content = (event.data as { message?: { content?: unknown } }).message?.content
      this.#durable = textOfContent(content)
      return 'final'
    }
    if (event.type === 'tool/call') {
      this.#tools += 1
      const name = (event.data as { name?: unknown }).name
      this.#tool = typeof name === 'string' ? name : 'tool'
      return 'delta'
    }
    return undefined
  }
}
