import assert from 'node:assert/strict'
import { test } from 'node:test'
import { previewOf, splitMessage } from '../src/render/split.ts'

test('short text stays one chunk', () => {
  assert.deepEqual(splitMessage('hello'), ['hello'])
})

test('never exceeds the budget', () => {
  const text = Array.from({ length: 400 }, (_, index) => `line ${String(index)} ${'x'.repeat(40)}`).join('\n')
  for (const chunk of splitMessage(text, 1000)) assert.ok(chunk.length <= 1000, `chunk of ${String(chunk.length)}`)
})

test('splits on line boundaries', () => {
  const text = `${'a'.repeat(50)}\n${'b'.repeat(50)}`
  const chunks = splitMessage(text, 60)
  assert.equal(chunks.length, 2)
  assert.ok(chunks[0]?.endsWith('a'))
  assert.ok(chunks[1]?.startsWith('b'))
})

test('closes and reopens a fence across the split', () => {
  const body = Array.from({ length: 60 }, (_, index) => `row ${String(index)}`).join('\n')
  const chunks = splitMessage(`before\n\`\`\`sh\n${body}\n\`\`\`\nafter`, 400)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.equal((chunk.match(/^```/gm) ?? []).length % 2, 0, chunk.slice(0, 40))
  }
})

test('preview truncates with a marker and respects the limit', () => {
  const preview = previewOf('a'.repeat(500), 100)
  assert.ok(preview.length <= 100)
  assert.ok(preview.endsWith('…'))
})

test('preview keeps short text unchanged', () => {
  assert.equal(previewOf('short', 100), 'short')
})

test('a preview of a code block keeps the fence balanced', () => {
  const body = Array.from({ length: 200 }, (_, index) => `row ${String(index)}`).join('\n')
  const preview = previewOf(`说明\n\`\`\`sh\n${body}\n\`\`\`\n结尾`, 400)
  assert.ok(preview.length <= 400)
  assert.equal((preview.match(/^```/gm) ?? []).length % 2, 0)
})
