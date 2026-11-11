/**
 * Telegram MarkdownV2 projection.
 *
 * The agent writes Markdown; Telegram's MarkdownV2 is not Markdown and fails
 * the whole message on one unescaped character. Rather than trusting the model
 * to emit a compatible dialect, this module keeps fenced code blocks verbatim
 * and escapes everything else literally. A failed send still falls back to
 * plain text at the transport layer.
 *
 * @module dsh-telegram/render/markdown
 */

/** Characters MarkdownV2 requires escaped outside code spans. */
const RESERVED = new Set('_*[]()~`>#+-=|{}.!\\'.split(''))

/**
 * Escape one plain-text run for MarkdownV2.
 * @param text - literal text.
 * @returns the escaped run.
 */
export function escapeMarkdownV2(text: string): string {
  let out = ''
  for (const character of text) out += RESERVED.has(character) ? `\\${character}` : character
  return out
}

/**
 * Escape the inside of a code span or pre block.
 * @param text - literal code.
 * @returns the escaped code.
 */
function escapeCode(text: string): string {
  return text.replace(/[`\\]/g, character => `\\${character}`)
}

/** One parsed region of a message. */
type Region =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly language: string; readonly text: string }

/**
 * Split text into fenced code and everything else.
 * @param text - Markdown produced by the agent.
 * @returns the ordered regions; an unterminated fence runs to the end.
 */
export function splitFences(text: string): readonly Region[] {
  const regions: Region[] = []
  let cursor = 0
  while (cursor < text.length) {
    const open = text.indexOf('```', cursor)
    if (open === -1) break
    if (open > cursor) regions.push({ kind: 'text', text: text.slice(cursor, open) })
    const lineEnd = text.indexOf('\n', open)
    const language = lineEnd === -1 ? '' : text.slice(open + 3, lineEnd).trim()
    const bodyStart = lineEnd === -1 ? open + 3 : lineEnd + 1
    const close = text.indexOf('```', bodyStart)
    if (close === -1) {
      regions.push({ kind: 'code', language, text: text.slice(bodyStart) })
      return regions
    }
    regions.push({ kind: 'code', language, text: text.slice(bodyStart, close) })
    cursor = close + 3
  }
  if (cursor < text.length) regions.push({ kind: 'text', text: text.slice(cursor) })
  return regions
}

/**
 * Project agent Markdown onto MarkdownV2.
 * @param text - Markdown produced by the agent.
 * @returns a message the Bot API accepts with `parse_mode: 'MarkdownV2'`.
 */
export function toMarkdownV2(text: string): string {
  return splitFences(text)
    .map(region => region.kind === 'text'
      ? escapeMarkdownV2(region.text)
      : `\`\`\`${region.language}\n${escapeCode(region.text)}\`\`\``)
    .join('')
}

/**
 * Project agent Markdown onto plain text, keeping fenced code readable.
 * @param text - Markdown produced by the agent.
 * @returns text safe to send without `parse_mode`.
 */
export function toPlainText(text: string): string {
  return text
}
