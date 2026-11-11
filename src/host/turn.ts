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

/** Human label and optional detail for one tool invocation. */
const TOOL_LABELS: Record<string, string> = {
  bash: '运行命令',
  job_output: '等待任务输出',
  job_kill: '结束任务',
  read: '读文件',
  write: '写文件',
  edit: '改文件',
  multi_edit: '改文件',
  apply_patch: '改文件',
  grep: '搜索内容',
  glob: '找文件',
  ls: '列目录',
  todo_write: '更新计划',
  ask_user_question: '向你提问',
  web_fetch: '取网页',
  web_search: '搜索网页',
}

/** Fields that carry a useful one-line detail for a tool. */
const TOOL_DETAIL = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'description'] as const

/**
 * Describe a tool call the way a person would read it.
 * @param name - tool name from the session log.
 * @param rawArguments - JSON arguments string.
 * @returns label plus an optional short detail.
 */
export function describeTool(name: string, rawArguments: unknown): { label: string; detail?: string } {
  const label = TOOL_LABELS[name] ?? name
  if (typeof rawArguments !== 'string' || rawArguments === '') return { label }
  let args: Record<string, unknown>
  try {
    args = JSON.parse(rawArguments) as Record<string, unknown>
  } catch {
    return { label }
  }
  for (const field of TOOL_DETAIL) {
    const value = args[field]
    if (typeof value !== 'string' || value.trim() === '') continue
    const line = value.replace(/\s+/g, ' ').trim()
    return { label, detail: line.length > 80 ? `${line.slice(0, 80)}…` : line }
  }
  return { label }
}

/** Accumulates one followed session's turn state. */
export class TurnTracker {
  #streamed = ''
  #durable = ''
  #tools = 0
  #tool: { label: string; detail?: string } | undefined
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
    if (this.#tool === undefined) return ''
    return this.#tool.detail === undefined
      ? `· ${this.#tool.label} …`
      : `· ${this.#tool.label}：${this.#tool.detail}`
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
      const text = textOfContent(content).trim()
      // A multi-step turn commits one message per step; most carry only tool
      // calls. Keep the last message that actually said something.
      if (text !== '') this.#durable = text
      return 'final'
    }
    if (event.type === 'tool/call') {
      this.#tools += 1
      const data = event.data as { name?: unknown; arguments?: unknown }
      this.#tool = describeTool(typeof data.name === 'string' ? data.name : 'tool', data.arguments)
      return 'delta'
    }
    return undefined
  }
}
