/**
 * Message splitting for Telegram's 4096-character limit.
 *
 * Chunks break on line boundaries only, and a fenced block that crosses a
 * boundary is closed before the split and reopened after it, so every chunk
 * renders as the code block the agent wrote.
 *
 * @module dsh-telegram/render/split
 */

/** Telegram's hard per-message limit. */
export const TELEGRAM_LIMIT = 4096

/** Safety margin so escapes and fence repairs never push a chunk over. */
const BUDGET = 3600

/** Closing a pre block costs this many characters. */
const FENCE_TAIL = '\n```'

/** Opening a pre block costs its marker plus the language tag. */
function fenceHead(language: string): string {
  return `\`\`\`${language}\n`
}

/**
 * Split one message into Telegram-sized chunks.
 * @param text - already projected message text.
 * @param limit - maximum chunk length.
 * @returns chunks in send order.
 */
export function splitMessage(text: string, limit = BUDGET): readonly string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let current = ''
  let openFence: string | undefined

  const flush = (): void => {
    if (current.trim() === '') return
    chunks.push(openFence === undefined ? current : `${current}${FENCE_TAIL}`)
    current = openFence === undefined ? '' : fenceHead(openFence)
  }

  for (const line of text.split('\n')) {
    const reserve = openFence === undefined ? 0 : FENCE_TAIL.length
    if (current !== '' && current.length + line.length + 1 + reserve > limit) flush()
    if (line.length > limit) {
      // A pathological line: hard-split it rather than send an oversized chunk.
      const stride = Math.max(1, limit - reserve - 1)
      for (let index = 0; index < line.length; index += stride) {
        if (current !== '') flush()
        current = line.slice(index, index + stride)
        flush()
      }
      continue
    }
    current = current === '' || current.endsWith('\n') ? `${current}${line}` : `${current}\n${line}`
    if (line.startsWith('```')) {
      openFence = openFence === undefined ? line.slice(3).trim() : undefined
    }
  }
  if (current.trim() !== '') chunks.push(openFence === undefined ? current : `${current}${FENCE_TAIL}`)
  return chunks
}

/**
 * Build a stream preview that stays inside one message.
 * @param text - full text so far.
 * @param limit - maximum preview length.
 * @returns the head of the text plus an ellipsis marker when truncated.
 */
export function previewOf(text: string, limit = BUDGET): string {
  if (text.length <= limit) return text
  // Reuse the splitter so a preview never leaves a code fence unbalanced; an
  // unbalanced fence makes Telegram reject the whole edit.
  const first = splitMessage(text, limit - 8)[0] ?? ''
  return `${first.replace(/\n+$/, '')}\n…`
}
