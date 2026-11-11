import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeTool, textOfContent, TurnTracker } from '../src/host/turn.ts'
import { assistantMessage, attemptStart, textDelta, turnEnd, turnStart } from './fakes.ts'

/** One tool/call event. */
function toolCall(name: string, args: unknown): unknown {
  return { type: 'event', event: { type: 'tool/call', seq: 2, time: 0, data: { name, arguments: JSON.stringify(args) } } }
}

test('joins only text blocks of an assistant message', () => {
  const content = [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: '答案' }, { type: 'tool-call' }]
  assert.equal(textOfContent(content), '答案')
})

test('describes bash by its command', () => {
  assert.deepEqual(describeTool('bash', '{"command":"bun run test 2>&1 | tail -40"}'), {
    label: '运行命令',
    detail: 'bun run test 2>&1 | tail -40',
  })
})

test('keeps an unknown tool name', () => {
  assert.deepEqual(describeTool('mystery_tool', '{}'), { label: 'mystery_tool' })
})

test('truncates a long detail to one line', () => {
  const described = describeTool('bash', JSON.stringify({ command: `echo ${'x'.repeat(300)}` }))
  assert.ok(described.detail !== undefined && described.detail.length <= 81)
  assert.ok(described.detail.endsWith('…'))
})

test('shows the tool while thinking and the text once it arrives', () => {
  const tracker = new TurnTracker()
  tracker.apply(turnStart() as never)
  assert.equal(tracker.preview, '')
  tracker.apply(toolCall('job_output', { job_id: 'bash-1' }) as never)
  assert.equal(tracker.preview, '· 等待任务输出 …')
  tracker.apply(attemptStart('a1') as never)
  tracker.apply(textDelta('a1', '先看测试') as never)
  assert.equal(tracker.preview, '先看测试')
})

test('keeps the last answer when a later step has no text', () => {
  const tracker = new TurnTracker()
  tracker.apply(turnStart() as never)
  tracker.apply(assistantMessage('项目进度如下') as never)
  tracker.apply(assistantMessage('') as never)
  assert.equal(tracker.text, '项目进度如下')
  assert.equal(tracker.apply(turnEnd() as never), 'end')
})

test('a new turn clears the previous answer', () => {
  const tracker = new TurnTracker()
  tracker.apply(turnStart() as never)
  tracker.apply(assistantMessage('第一轮') as never)
  tracker.apply(turnStart() as never)
  assert.equal(tracker.text, '')
})
