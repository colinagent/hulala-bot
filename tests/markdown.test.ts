import assert from 'node:assert/strict'
import { test } from 'node:test'
import { escapeMarkdownV2, splitFences, toMarkdownV2 } from '../src/render/markdown.ts'

test('escapes every MarkdownV2 reserved character', () => {
  assert.equal(
    escapeMarkdownV2('a_b*c[d]e(f)g~h`i>j#k+l-m=n|o{p}q.r!s\\t'),
    'a\\_b\\*c\\[d\\]e\\(f\\)g\\~h\\`i\\>j\\#k\\+l\\-m\\=n\\|o\\{p\\}q\\.r\\!s\\\\t',
  )
})

test('leaves ordinary CJK and punctuation alone', () => {
  assert.equal(escapeMarkdownV2('你好，世界：这是测试。'), '你好，世界：这是测试。')
})

test('keeps a fenced block as a pre block and escapes its body', () => {
  const text = '说明：\n```ts\nconst a = `x`\n```\n完成。'
  assert.equal(toMarkdownV2(text), '说明：\n```ts\nconst a = \\`x\\`\n```\n完成。')
})

test('closes an unterminated fence so Telegram still accepts the message', () => {
  assert.equal(toMarkdownV2('```\nrm -rf /tmp/x'), '```\nrm -rf /tmp/x```')
})

test('splits fences and text in order', () => {
  const regions = splitFences('a\n```py\nb\n```\nc')
  assert.deepEqual(regions.map(region => region.kind), ['text', 'code', 'text'])
  assert.deepEqual(regions[1], { kind: 'code', language: 'py', text: 'b\n' })
})

test('an escaped asterisk never becomes bold', () => {
  assert.equal(toMarkdownV2('*not bold*'), '\\*not bold\\*')
})
