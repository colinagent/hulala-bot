/**
 * `fetch` over an HTTP CONNECT proxy.
 *
 * The bridge talks to exactly one host, so a full fetch replacement is overkill:
 * every request opens a tunnel through the proxy, wraps it in TLS for `https:`
 * targets, and reads the body to completion. That is enough for the Bot API and
 * it keeps the plugin dependency-free — the Host may run on Bun or on Node, and
 * both ship `node:http`, `node:https` and `node:tls`.
 *
 * @module dsh-telegram/telegram/proxy
 */
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

/** Receives the tunneled socket, or why it could not be opened. */
type Connected = (error: Error | null, socket?: Socket) => void

/**
 * Validate and normalize a proxy URL.
 * @param value - `http://` or `https://` URL, optionally with credentials.
 * @returns the normalized URL string.
 */
export function normalizeProxy(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`proxy must be an http:// or https:// URL, not ${JSON.stringify(value)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`proxy must be an http:// or https:// URL, not ${JSON.stringify(value)}`)
  }
  if (url.hostname === '') {
    throw new Error(`proxy has no host: ${JSON.stringify(value)}`)
  }
  return url.toString()
}

/**
 * Open a CONNECT tunnel, optionally wrapping it in TLS.
 * @param proxy - proxy address.
 * @param host - target host.
 * @param port - target port.
 * @param secure - whether the target speaks TLS.
 * @param done - receives the usable socket.
 */
function tunnel(proxy: URL, host: string, port: number, secure: boolean, done: Connected): void {
  const proxySecure = proxy.protocol === 'https:'
  const authorization = proxy.username === ''
    ? undefined
    : `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
  const request = (proxySecure ? https : http).request({
    host: proxy.hostname,
    port: Number(proxy.port || (proxySecure ? 443 : 80)),
    method: 'CONNECT',
    path: `${host}:${String(port)}`,
    headers: {
      host: `${host}:${String(port)}`,
      ...(authorization === undefined ? {} : { 'proxy-authorization': authorization }),
    },
    timeout: 20_000,
  })
  request.once('connect', (response, socket) => {
    if (response.statusCode !== 200) {
      socket.destroy()
      const detail = response.statusMessage === undefined ? '' : ` ${response.statusMessage}`
      done(new Error(`proxy CONNECT failed: ${String(response.statusCode)}${detail}`))
      return
    }
    if (!secure) {
      done(null, socket)
      return
    }
    const wrapped = tls.connect({ socket, servername: host })
    wrapped.once('secureConnect', () => done(null, wrapped))
    wrapped.once('error', error => done(error))
  })
  request.once('error', error => done(error))
  request.once('timeout', () => request.destroy(new Error('proxy CONNECT timed out')))
  request.end()
}

/**
 * One tunnel per request: the bridge sends a handful of calls a minute, so
 * pooling would only keep sockets open through the proxy for no gain.
 * @param proxy - proxy address.
 * @param options - the request the agent is opening a socket for.
 * @param secure - whether the target speaks TLS.
 * @param callback - receives the tunneled socket.
 * @returns nothing; the agent contract allows an asynchronous socket.
 */
function connect(
  proxy: URL,
  options: http.ClientRequestArgs,
  secure: boolean,
  callback?: (error: Error | null, stream: Duplex) => void,
): undefined {
  const host = options.host ?? 'localhost'
  const port = Number(options.port ?? (secure ? 443 : 80))
  tunnel(proxy, host, port, secure, (error, socket) => {
    if (callback === undefined) return
    if (socket === undefined) callback(error ?? new Error('no socket from the proxy'), undefined as unknown as Duplex)
    else callback(error, socket)
  })
  return undefined
}

/** Tunnels plain-HTTP targets. */
class HttpTunnelAgent extends http.Agent {
  readonly #proxy: URL

  /**
   * @param proxy - proxy address.
   */
  constructor(proxy: URL) {
    super({ keepAlive: false })
    this.#proxy = proxy
  }

  override createConnection(
    options: http.ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): undefined {
    return connect(this.#proxy, options, false, callback)
  }
}

/**
 * Tunnels TLS targets. `https.Agent` is required, not just convenient: Node
 * refuses to hand an `http.Agent` to `https.request`.
 */
class HttpsTunnelAgent extends https.Agent {
  readonly #proxy: URL

  /**
   * @param proxy - proxy address.
   */
  constructor(proxy: URL) {
    super({ keepAlive: false })
    this.#proxy = proxy
  }

  override createConnection(
    options: http.ClientRequestArgs,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): undefined {
    return connect(this.#proxy, options, true, callback)
  }
}

/**
 * Build a `fetch` that reaches its target through `proxy`.
 * @param proxy - `http://` or `https://` proxy URL.
 * @returns a fetch-compatible function for one Bot API client.
 */
export function createProxiedFetch(proxy: string): typeof globalThis.fetch {
  const address = new URL(normalizeProxy(proxy))
  return async (input, init = {}) => {
    const target = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input)
    const secure = target.protocol === 'https:'
    const agent = secure ? new HttpsTunnelAgent(address) : new HttpTunnelAgent(address)
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value
    })
    const body = typeof init.body === 'string' ? init.body : undefined
    const status = await new Promise<{ code: number; text: string }>((resolve, reject) => {
      let settled = false
      const finish = (error: Error | null, result?: { code: number; text: string }): void => {
        if (settled) return
        settled = true
        if (error === null && result !== undefined) resolve(result)
        else reject(error ?? new Error('proxy request failed'))
      }
      const request = (secure ? https : http).request({
        host: target.hostname,
        port: Number(target.port || (secure ? 443 : 80)),
        path: `${target.pathname}${target.search}`,
        method: init.method ?? 'GET',
        headers,
        agent,
        signal: init.signal ?? undefined,
      }, response => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => finish(null, { code: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
        response.on('error', error => finish(error))
      })
      request.once('error', error => finish(error))
      request.end(body)
    })
    const responseHeaders = new Headers()
    return new Response(status.text, { status: status.code, headers: responseHeaders })
  }
}
