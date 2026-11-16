import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatTasks, type ScheduleTask } from '../src/tasks.ts'

function task(overrides: Partial<ScheduleTask> = {}): ScheduleTask {
  return {
    id: 'schedule-1',
    title: 'BTC 日报',
    kind: 'daily',
    status: 'active',
    time: '06:00:00.000',
    timeZone: 'Asia/Shanghai',
    scheduledAt: '2026-11-16T22:00:00.000Z',
    ...overrides,
  }
}

test('an empty Host points at the creation command', () => {
  assert.match(formatTasks([]), /\/create-auto-task/)
})

test('a daily task shows its zone, next run, and last delivery', () => {
  const text = formatTasks([task({
    lastDelivery: { deliveredAt: '2026-11-15T22:05:00.000Z' },
  })])
  assert.match(text, /定时任务 1 个（启用 1）/)
  assert.match(text, /BTC 日报 · \[启用\] · 每天 06:00 Asia\/Shanghai/)
  assert.match(text, /下次 11-17 06:00/)
  assert.match(text, /最近投递 11-16 06:05/)
})

test('a paused task has no next run and says so in its status', () => {
  const text = formatTasks([task({ status: 'paused' })])
  assert.match(text, /\[暂停\]/)
  assert.doesNotMatch(text, /下次/)
})

test('a cron task shows its expression', () => {
  const text = formatTasks([task({ kind: 'cron', expression: '0 6 * * *' })])
  assert.match(text, /cron 0 6 \* \* \* Asia\/Shanghai/)
})

test('an RRULE task shows the rule line', () => {
  const text = formatTasks([task({
    kind: 'rrule',
    rrule: 'DTSTART;TZID=Asia/Shanghai:20261117T060000\nRRULE:FREQ=WEEKLY;BYDAY=MO,FR',
  })])
  assert.match(text, /RRULE:FREQ=WEEKLY;BYDAY=MO,FR/)
})
