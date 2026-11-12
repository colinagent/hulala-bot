import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatMarkdown } from '../src/lark/format.ts'

test('headings become bold lines', () => {
  assert.equal(formatMarkdown('### 仓位算法\n内容'), '**仓位算法**\n内容')
})

test('a table becomes one bullet per row with header labels', () => {
  const table = [
    '| 方案 | 触发 | 入场 |',
    '|---|---|---|',
    '| A | 收回 73.2k | 73.0–73.2k |',
    '| B | 站上 74.8k | 74.6–74.8k |',
  ].join('\n')
  assert.equal(
    formatMarkdown(table),
    '- **A** · 触发：收回 73.2k · 入场：73.0–73.2k\n- **B** · 触发：站上 74.8k · 入场：74.6–74.8k',
  )
})

test('a table inside a code fence is left alone', () => {
  const text = '```\n| a | b |\n|---|---|\n```'
  assert.equal(formatMarkdown(text), text)
})

test('plain pipes without a separator are not a table', () => {
  const text = '| a | b |\n| c | d |'
  assert.equal(formatMarkdown(text), text)
})

test('an aligned separator is still a table', () => {
  const text = '| a | b |\n|:---|---:|\n| 1 | 2 |'
  assert.equal(formatMarkdown(text), '- **1** · b：2')
})

test('ordinary text is untouched', () => {
  const text = '- 一条列表\n\n**加粗**与[链接](https://example.com)'
  assert.equal(formatMarkdown(text), text)
})
