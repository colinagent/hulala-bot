/**
 * Command parsing and the command catalogue.
 *
 * Telegram addresses commands as `/name@botname` in groups, and users type
 * trailing whitespace; both are handled here so the bridge only sees
 * `{ name, args }`.
 *
 * @module dsh-telegram/router
 */

/** One parsed command. */
export interface Command {
  readonly name: string
  readonly args: string
}

/** Command menu published to Telegram clients. */
export const COMMANDS = [
  { command: 'help', description: '命令说明' },
  { command: 'cwd', description: '查看或切换工作目录' },
  { command: 'new', description: '在当前目录新建会话' },
  { command: 'sessions', description: '列出会话' },
  { command: 'switch', description: '切换到第 n 个会话' },
  { command: 'status', description: '当前会话状态' },
  { command: 'stop', description: '停止当前回合' },
] as const

/** Usage text, kept in sync with {@link COMMANDS}. */
export const HELP = [
  '把手机接到本机的 Hulala agent 上。',
  '',
  '/cwd            当前挂载的会话与目录',
  '/cwd <path>     换挂载：改到该目录的会话（没有就新建）',
  '/new            在当前目录新建会话',
  '/sessions       最近会话',
  '/switch <n>     切换到第 n 个',
  '/status         会话、目录、运行状态',
  '/stop           停止当前回合',
  '',
  '直接发文字就是提问；审批会以按钮出现，任何一端先点生效。',
].join('\n')

/**
 * Parse one inbound message as a command.
 * @param text - message text.
 * @returns the command, or undefined when this is a prompt.
 */
export function parseCommand(text: string): Command | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return undefined
  const space = trimmed.search(/\s/)
  const head = (space === -1 ? trimmed : trimmed.slice(0, space)).slice(1)
  const at = head.indexOf('@')
  const name = (at === -1 ? head : head.slice(0, at)).toLowerCase()
  const args = space === -1 ? '' : trimmed.slice(space).trim()
  if (name === '') return undefined
  return { name, args }
}
