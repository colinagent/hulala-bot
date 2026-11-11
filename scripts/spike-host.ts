/**
 * Spike: prove the bridge loads as a Host plugin and drives a session.
 *
 * Boots a real `dsh` profile that lists this bundle, points the bridge at a
 * fake Bot API, sends one message, and prints what the Host did with it. No
 * language model is needed: the point is the wiring (poll → mount → prompt →
 * stream), not the answer.
 *
 * Usage: node scripts/spike-host.ts <dsh-bin> <dsh-home> <profile>
 *
 * @module dsh-telegram/scripts/spike-host
 */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FakeTelegram } from '../tests/fakes.ts'

const [dshBin, dshHome, profile] = process.argv.slice(2)
if (dshBin === undefined || dshHome === undefined || profile === undefined) {
  throw new Error('usage: node scripts/spike-host.ts <dsh-bin> <dsh-home> <profile>')
}

const stateDir = join(dshHome, 'config', 'dsh-telegram')
const workspace = join(dshHome, 'workspace')
await mkdir(stateDir, { recursive: true, mode: 0o700 })
await mkdir(workspace, { recursive: true, mode: 0o700 })

const telegram = new FakeTelegram()
const baseUrl = await telegram.start()
await writeFile(join(stateDir, 'config.json'), JSON.stringify({
  tokenEnv: 'SPIKE_BOT_TOKEN',
  baseUrl,
  allowedUsers: [1],
  defaultCwd: workspace,
  parseMode: 'plain',
  streamIntervalMs: 0,
}, undefined, 2))
console.log(`fake Bot API on ${baseUrl}`)

const child = spawn(dshBin, [profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
  env: {
    ...process.env,
    DSH_HOME: dshHome,
    SPIKE_BOT_TOKEN: '1:spike',
    NODE_USE_ENV_PROXY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const said: string[] = []
child.stdout.on('data', chunk => { said.push(String(chunk)) })
child.stderr.on('data', chunk => { said.push(String(chunk)) })

/** Poll a predicate until it holds or the deadline passes. */
async function until(label: string, check: () => boolean, ms = 60000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(settle => setTimeout(settle, 250))
  }
  console.log(`--- host output ---\n${said.join('')}`)
  throw new Error(`timed out waiting for ${label}`)
}

try {
  await until('the bridge to poll the Bot API', () => telegram.calls.some(call => call.method === 'getUpdates'))
  console.log('ok: plugin loaded and is polling through the Host')

  telegram.push({
    update_id: 1,
    message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: false, first_name: 'spike' }, text: '跑一下 echo hi 然后总结' },
  })
  await until('a reply to be posted', () => telegram.calls.some(call => call.method === 'sendMessage'), 90000)
  const sent = telegram.calls.filter(call => call.method === 'sendMessage' || call.method === 'editMessageText')
  console.log(`ok: ${String(sent.length)} Telegram message call(s) after the inbound update`)
  for (const call of sent.slice(0, 6)) console.log(`   ${call.method}: ${JSON.stringify(call.body).slice(0, 160)}`)
  console.log('--- host output ---')
  console.log(said.join('').slice(-3000))
} finally {
  child.kill('SIGTERM')
  await new Promise(settle => setTimeout(settle, 1500))
  child.kill('SIGKILL')
  await telegram.stop()
}
