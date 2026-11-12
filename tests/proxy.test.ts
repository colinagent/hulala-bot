import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { test } from 'node:test'
import { createProxiedFetch, normalizeProxy } from '../src/telegram/proxy.ts'

/** A target that echoes the request back as JSON. */
async function target(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        method: request.method,
        path: request.url,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return {
    port: address.port,
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

/** A CONNECT proxy; records the tunnels it opened. */
async function proxy(options: { auth?: string; reject?: boolean } = {}): Promise<{ port: number; tunnels: string[]; close: () => Promise<void> }> {
  const tunnels: string[] = []
  const server = http.createServer((_request, response) => {
    response.writeHead(400)
    response.end()
  })
  server.on('connect', (request, client, head) => {
    tunnels.push(request.url ?? '')
    if (options.auth !== undefined && request.headers['proxy-authorization'] !== options.auth) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      return
    }
    if (options.reject === true) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    const [host, port] = (request.url ?? '').split(':')
    const upstream = net.connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return {
    port: address.port,
    tunnels,
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())) },
  }
}

test('normalizes http and https proxies and rejects everything else', () => {
  assert.equal(normalizeProxy('http://127.0.0.1:7897'), 'http://127.0.0.1:7897/')
  assert.equal(normalizeProxy('https://proxy.example:8443'), 'https://proxy.example:8443/')
  assert.throws(() => normalizeProxy('socks5://127.0.0.1:7897'), /http:\/\/ or https:\/\//)
  assert.throws(() => normalizeProxy('127.0.0.1:7897'), /http:\/\/ or https:\/\//)
})

test('tunnels a request through the proxy and reads the JSON body', async () => {
  const upstream = await target()
  const gateway = await proxy()
  try {
    const request = createProxiedFetch(`http://127.0.0.1:${String(gateway.port)}`)
    const response = await request(`http://127.0.0.1:${String(upstream.port)}/bot123/getMe?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { method: 'POST', path: '/bot123/getMe?x=1', body: '{"a":1}' })
    assert.deepEqual(gateway.tunnels, [`127.0.0.1:${String(upstream.port)}`])
  } finally {
    await gateway.close()
    await upstream.close()
  }
})

test('sends proxy credentials when the URL carries them', async () => {
  const upstream = await target()
  const expected = `Basic ${Buffer.from('user:pass').toString('base64')}`
  const gateway = await proxy({ auth: expected })
  try {
    const request = createProxiedFetch(`http://user:pass@127.0.0.1:${String(gateway.port)}`)
    const response = await request(`http://127.0.0.1:${String(upstream.port)}/ping`)
    assert.equal(response.status, 200)
  } finally {
    await gateway.close()
    await upstream.close()
  }
})

test('a refused CONNECT fails the request', async () => {
  const gateway = await proxy({ reject: true })
  try {
    const request = createProxiedFetch(`http://127.0.0.1:${String(gateway.port)}`)
    await assert.rejects(request('http://127.0.0.1:9/ping'), /proxy CONNECT failed: 403/)
  } finally {
    await gateway.close()
  }
})
