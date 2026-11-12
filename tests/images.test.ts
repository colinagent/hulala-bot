import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mediaTypeOf, takeImageLinks } from '../src/render/images.ts'

test('a plain link is collected and replaced by its alt text', () => {
  assert.deepEqual(takeImageLinks('图在这里 ![chart](/tmp/chart.png) 谢谢'), {
    text: '图在这里 chart 谢谢',
    links: [{ alt: 'chart', path: '/tmp/chart.png' }],
  })
})

test('a path with spaces inside angle brackets works', () => {
  assert.deepEqual(takeImageLinks('![a b](</tmp/my chart.png>)'), {
    text: 'a b',
    links: [{ alt: 'a b', path: '/tmp/my chart.png' }],
  })
})

test('several links keep their order', () => {
  const { links } = takeImageLinks('![one](1.png) ![](2.png)')
  assert.deepEqual(links.map(link => link.path), ['1.png', '2.png'])
})

test('a link with no alt text leaves no stray space', () => {
  assert.deepEqual(takeImageLinks('before ![](a.png)\nafter'), {
    text: 'before\n after'.replace('\n ', '\n'),
    links: [{ alt: '', path: 'a.png' }],
  })
})

test('supported image extensions map to MIME types', () => {
  assert.equal(mediaTypeOf('/a/b.PNG'), 'image/png')
  assert.equal(mediaTypeOf('x.jpeg'), 'image/jpeg')
  assert.equal(mediaTypeOf('x.webp'), 'image/webp')
  assert.equal(mediaTypeOf('x.gif'), 'image/gif')
  assert.equal(mediaTypeOf('x.pdf'), undefined)
})
