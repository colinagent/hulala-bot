/**
 * `/tasks` and `/create-auto-task`: the bot side of Host scheduled tasks.
 *
 * The Host owns the store; this module only shapes `schedule.catalog()` into a
 * chat message. The terminal's own `/tasks` command renders the same fields
 * (hulala's `apps/server/src/plugins/commandTasks.ts`), so both surfaces show
 * one list.
 *
 * @module hulala-bot/tasks
 */

/** Instruction seed the composer-side command also inserts, so both entries ask the same question. */
export const AUTO_TASK_SEED = '请根据需求创建一个自动化任务。'

/** One Host task, with only the fields this list renders. */
export interface ScheduleTask {
  readonly id: string
  readonly title: string
  readonly kind: 'after' | 'at' | 'every' | 'daily' | 'weekly' | 'cron' | 'rrule'
  readonly status: 'active' | 'paused' | 'ended'
  readonly scheduledAt: string
  readonly timeZone?: string | undefined
  readonly time?: string | undefined
  readonly weekdays?: readonly number[] | undefined
  readonly expression?: string | undefined
  readonly afterSeconds?: number | undefined
  readonly everySeconds?: number | undefined
  readonly rrule?: string | undefined
  readonly lastDelivery?: { readonly deliveredAt: string } | undefined
}

const STATUS = { active: '启用', paused: '暂停', ended: '结束' } as const

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'] as const

/** Render one UTC instant as `MM-DD HH:mm` in the task's zone, else the Host's. */
function stamp(instant: string, timeZone: string | undefined): string {
  const options: Intl.DateTimeFormatOptions = {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone === undefined ? {} : { timeZone }),
  }
  return new Intl.DateTimeFormat('en-CA', options).format(new Date(instant)).replace(',', '')
}

/** One line describing how often the task fires. */
function frequency(task: ScheduleTask): string {
  switch (task.kind) {
    case 'after':
      return `${String(task.afterSeconds ?? 0)} 秒后一次`
    case 'at':
      return '一次'
    case 'every': {
      const minutes = Math.round((task.everySeconds ?? 60) / 60)
      return minutes % 60 === 0 ? `每 ${String(minutes / 60)} 小时` : `每 ${String(minutes)} 分钟`
    }
    case 'daily':
      return `每天 ${(task.time ?? '').slice(0, 5)} ${task.timeZone ?? ''}`.trim()
    case 'weekly': {
      const days = (task.weekdays ?? []).map(day => WEEKDAYS[day - 1] ?? String(day)).join('')
      return `每周${days} ${(task.time ?? '').slice(0, 5)} ${task.timeZone ?? ''}`.trim()
    }
    case 'cron':
      return `cron ${task.expression ?? ''} ${task.timeZone ?? ''}`.trim()
    case 'rrule': {
      const rule = (task.rrule ?? '').split('\n').find(line => line.startsWith('RRULE:'))
      return rule === undefined ? 'RRULE' : rule
    }
  }
}

/** One task as a single scannable line. */
function lineOf(task: ScheduleTask): string {
  const zone = task.timeZone
  const parts = [task.title, `[${STATUS[task.status]}]`, frequency(task)]
  if (task.status === 'active') parts.push(`下次 ${stamp(task.scheduledAt, zone)}`)
  if (task.lastDelivery !== undefined) parts.push(`最近投递 ${stamp(task.lastDelivery.deliveredAt, zone)}`)
  return `• ${parts.join(' · ')}`
}

/**
 * Render the Host task list for a chat message.
 * @param tasks - every task the Host stores, active first.
 * @returns the text to send.
 */
export function formatTasks(tasks: readonly ScheduleTask[]): string {
  if (tasks.length === 0) return '还没有定时任务。用 /create-auto-task 描述需求，让 agent 建一个。'
  const active = tasks.filter(task => task.status === 'active').length
  return [`定时任务 ${String(tasks.length)} 个（启用 ${String(active)}）`, ...tasks.map(lineOf)].join('\n')
}
