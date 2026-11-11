/**
 * Print the chat and user ids of whoever messaged the bot.
 *
 * Setup helper: send the bot anything, run this, and copy the id into
 * `allowedUsers`. It confirms the updates it reads, so stop the bridge first.
 *
 * Usage: node scripts/whoami.ts [seconds]
 *
 * @module dsh-telegram/scripts/whoami
 */
import { loadToken } from '../src/config.ts'
import { TelegramApi } from '../src/telegram/api.ts'

const seconds = Number(process.argv[2] ?? 30)
const { token, baseUrl } = await loadToken()
const api = new TelegramApi({ token, baseUrl })
console.log(`listening ${String(seconds)}s; send /start to the bot now`)

const seen = new Map<string, string>()
const deadline = Date.now() + seconds * 1000
let offset = 0
while (Date.now() < deadline) {
  const updates = await api.getUpdates(offset, 5)
  for (const update of updates) {
    offset = update.updateId + 1
    if (update.kind !== 'message') continue
    const { chat, fromId, text } = update.message
    seen.set(`${String(chat.id)}:${String(fromId)}`, `${String(update.updateId)} ${chat.type} chat=${String(chat.id)} user=${String(fromId ?? '?')} text=${JSON.stringify(text)}`)
    console.log(`chat.id=${String(chat.id)}  user.id=${String(fromId ?? '?')}  (${chat.type})`)
  }
}
if (seen.size === 0) console.log('nothing arrived; send /start to @colin_hulala_bot and rerun')
else console.log('\nput the private-chat user id into allowedUsers')
process.exit(0)
