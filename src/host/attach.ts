/**
 * Attach this bridge to a running Hulala Host as one more peer.
 *
 * The bridge is a client, not a Host plugin: it reads the published endpoint,
 * exchanges the process token for the API cookie, and mounts only the Remote
 * namespaces it drives. It never spawns a Host — a machine has one Host, and a
 * second runtime would split the state root.
 *
 * @module dsh-telegram/host/attach
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply as gatewayClient } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/types'
import SessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import WorkspaceRemote from '@deepseek-ai/dsh-api-workspace-controller/remote'
import { installConnection, type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import WebSocket from 'ws'
import { hulalaHome } from '../config.ts'

/** Discovery protocol this bridge understands. */
const REQUIRED_PROTOCOL = 2

/** Fields of `endpoint.json` this bridge reads. */
export interface HostEndpoint {
  readonly protocol: number
  readonly version: string
  readonly pid: number
  readonly descriptor: {
    readonly httpUrl: string
    readonly eventsUrl: string
    readonly token: string
    readonly instanceId: string
  }
  readonly roots: { readonly hulala: string; readonly workspace: string }
}

/** One authenticated attachment. */
export interface HostBackend {
  readonly ctx: Context
  readonly endpoint: HostEndpoint
  /** Stop following sessions and release the connection. */
  close(): Promise<void>
}

/** Absolute path of the published endpoint for one state root. */
export function endpointPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hulalaHome(env), 'server', 'host', 'endpoint.json')
}

/**
 * Read the published endpoint without trusting it.
 * @param path - `endpoint.json` path.
 * @returns the parsed endpoint.
 */
export async function readEndpoint(path: string): Promise<HostEndpoint> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Hulala Host is not running (no endpoint.json); start it from the TUI or `hulala start`')
    }
    throw new Error(`cannot read ${path}: ${(error as Error).message}`)
  }
  const record = parsed as Partial<HostEndpoint>
  if (record.descriptor === undefined || typeof record.descriptor.httpUrl !== 'string' || typeof record.descriptor.token !== 'string') {
    throw new Error(`${path} is not a Host endpoint; the file is stale or foreign`)
  }
  if (record.protocol !== REQUIRED_PROTOCOL) {
    throw new Error(`Host speaks discovery protocol ${String(record.protocol)}, this bridge needs ${String(REQUIRED_PROTOCOL)}; update the bridge`)
  }
  return record as HostEndpoint
}

/**
 * Exchange the launch token for the API cookie.
 * @param endpoint - published endpoint.
 * @returns the cookie and the WebSocket mux URL.
 */
export async function exchangeCookie(endpoint: HostEndpoint): Promise<{ cookie: string; muxUrl: string }> {
  const url = `${endpoint.descriptor.httpUrl}/connect?token=${encodeURIComponent(endpoint.descriptor.token)}&interactions=answer`
  const response = await fetch(url, { redirect: 'manual' })
  if (response.status !== 302) {
    throw new Error(`Host refused the connection exchange (${String(response.status)}); the endpoint token is stale`)
  }
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  if (cookie === undefined || cookie === '') throw new Error('Host did not return an API cookie')
  const location = response.headers.get('location')
  const muxUrl = location !== null && location.startsWith('ws')
    ? location
    : `${endpoint.descriptor.httpUrl.replace(/^http/, 'ws')}/api/remote.mux`
  return { cookie, muxUrl }
}

/**
 * Wait until the forwarded-event stream is open.
 *
 * `$on` is only legal once the connection has published its event generation;
 * registering earlier throws instead of queueing.
 * @param connection - installed connection handle.
 * @param timeoutMs - how long to wait.
 */
async function waitConnected(connection: ConnectionHandle, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (connection.state.getSnapshot() !== 'connected') {
    if (Date.now() > deadline) throw new Error('Host connection did not become ready')
    await new Promise(settle => setTimeout(settle, 25))
  }
}

/**
 * Connect and mount the Remote namespaces the bridge drives.
 * @param endpoint - published endpoint.
 * @returns the mounted backend.
 */
export async function attach(endpoint: HostEndpoint): Promise<HostBackend> {
  const { cookie } = await exchangeCookie(endpoint)
  const baseUrl = endpoint.descriptor.httpUrl
  const ctx = new Context()
  installConnection(ctx, {
    interactions: 'answer',
    transport: {
      streamBaseUrl: baseUrl,
      fetch: (input, init) => fetch(new URL(String(input), baseUrl), {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers)), cookie },
      }),
      createWebSocket: url => new WebSocket(url, {
        headers: { cookie, origin: baseUrl },
      }) as never,
    },
  })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin({ apply: gatewayClient, inject: ['typert', 'connection'] })
  await ctx.remote.$mount(SessionRemote)
  await ctx.remote.$mount(WorkspaceRemote)
  // Waterfall requests arrive scoped to an Agent; without this client binding
  // the Gateway cannot project that scope onto this peer and the delivery is
  // dropped before any listener runs.
  const contexts = ctx.typert.contexts as unknown as {
    registerClient(name: 'agent', client: { identity: () => undefined; resolve: () => typeof ctx }): unknown
  }
  contexts.registerClient('agent', {
    identity: () => undefined,
    resolve: () => ctx,
  })
  await waitConnected(ctx.get('connection') as ConnectionHandle, 10_000)
  return {
    ctx,
    endpoint,
    async close() {
      await ctx.fiber.dispose()
    },
  }
}
