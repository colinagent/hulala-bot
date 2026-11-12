/**
 * Feishu card Markdown projection.
 *
 * `lark_md` is a small subset of Markdown: bold, italic, strikethrough, links,
 * mentions and list items. It has no headings and no tables — `### title` shows
 * up with the hashes and a table shows up as rows of pipes, which is what the
 * agent's well-formed output looks like when pasted into a card.
 *
 * This rewrites just those two constructs: headings become bold lines, and a
 * table becomes one bullet per row with its header names inlined. Fenced code
 * is left alone, so a table the agent quoted inside a code block stays literal.
 *
 * @module hulala-bot/lark/format
 */

/** One table: header labels plus data rows, all cells trimmed. */
interface Table {
  readonly header: readonly string[]
  readonly rows: readonly (readonly string[])[]
}

/**
 * Split one `| a | b |` line into cells.
 * @param line - table row.
 * @returns trimmed cells.
 */
function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

/**
 * Whether a line is a table row.
 * @param line - candidate line.
 * @returns true for `| … |`.
 */
function isRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

/**
 * Whether a line is the `|---|:--:|` separator under a table header.
 * @param line - candidate line.
 * @returns true when every cell is dashes with optional alignment colons.
 */
function isSeparator(line: string): boolean {
  if (!isRow(line)) return false
  const parts = cells(line)
  return parts.length > 0 && parts.every(part => /^:?-{3,}:?$/.test(part))
}

/**
 * Render one table as bullets.
 * @param table - parsed table.
 * @returns one line per row; the first column is bold.
 */
function bullets(table: Table): string[] {
  return table.rows
    .filter(row => row.some(cell => cell !== ''))
    .map(row => {
      const [first = '', ...rest] = row
      const details = rest
        .map((cell, index) => {
          const label = table.header[index + 1]
          return label === undefined || label === '' ? cell : `${label}：${cell}`
        })
        .filter(detail => detail !== '')
      const head = first === '' ? '' : `**${first}**`
      return `- ${[head, details.join(' · ')].filter(part => part !== '').join(' · ')}`
    })
}

/**
 * Project agent Markdown onto what a Feishu card can actually render.
 * @param text - Markdown produced by the agent.
 * @returns Markdown with headings and tables rewritten.
 */
export function formatMarkdown(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fenced = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      out.push(line)
      continue
    }
    if (fenced) {
      out.push(line)
      continue
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
    if (heading !== null) {
      const title = (heading[1] as string).trim()
      if (title !== '') out.push(`**${title}**`)
      continue
    }
    const next = lines[index + 1]
    if (isRow(line) && next !== undefined && isSeparator(next)) {
      const header = cells(line)
      const rows: string[][] = []
      let cursor = index + 2
      while (cursor < lines.length && isRow(lines[cursor] as string)) {
        rows.push(cells(lines[cursor] as string))
        cursor += 1
      }
      out.push(...bullets({ header, rows }))
      index = cursor - 1
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}
