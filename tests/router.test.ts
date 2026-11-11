import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCommand } from '../src/router.ts'

test('plain text is a prompt, not a command', () => {
  assert.equal(parseCommand('帮我看下这个仓库'), undefined)
})

test('parses a bare command', () => {
  assert.deepEqual(parseCommand('/status'), { name: 'status', args: '' })
})

test('parses arguments and trims', () => {
  assert.deepEqual(parseCommand('/cwd   ~/work/foo  '), { name: 'cwd', args: '~/work/foo' })
})

test('ignores the bot suffix Telegram adds in groups', () => {
  assert.deepEqual(parseCommand('/cwd@hulala_bot /tmp'), { name: 'cwd', args: '/tmp' })
})

test('lowercases the command name', () => {
  assert.deepEqual(parseCommand('/STATUS'), { name: 'status', args: '' })
})

test('a bare slash is a prompt', () => {
  assert.equal(parseCommand('/'), undefined)
})
