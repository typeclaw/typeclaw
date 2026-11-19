import { timingSafeEqual } from 'node:crypto'
import { connect, createServer, type Server, type Socket } from 'node:net'

import { createTextMessageTap } from './ws-tap'

// The managed Chrome runs in a network-isolated sandbox, so its DevTools port
// is unreachable from model bash. This relay is the only path in: a loopback
// TCP listener that admits a connection only when its first HTTP request
// carries the session token, then forwards it to Chrome's DevTools socket.
// The token reaches bash only for roles holding `browser.shared`, so a
// lower-privilege session cannot drive pages another role is logged into.

const MAX_HEAD_BYTES = 64 * 1024
const BROWSER_PATH = /^\/devtools\/browser\/[^/?#]*/
// CDP commands and the replies and events that create or open tabs are small;
// anything larger (screenshots, DOM snapshots) is never inspected.
const MAX_TAPPED_MESSAGE_BYTES = 64 * 1024
// How long a closed session connection keeps reading Chrome's side for the
// replies to tab creations it already sent.
const PENDING_CREATE_GRACE_MS = 10_000

export type CdpRelayOptions = {
  token: string
  // Unix socket bridged to Chrome's private DevTools port.
  upstreamSocket: string
  host?: string
  port?: number
  sessions?: CdpRelaySessions
}

// Per-session tokens grant the same access as `token`, and additionally let
// the relay attribute the tabs a connection opens to the session that made it.
export type CdpRelaySessions = {
  ownerOf: (token: string) => string | undefined
  onTabCreated: (owner: string, targetId: string) => void
  onTabUsed: (owner: string, targetId: string) => void
  // A pending promise holds the session's new connection until it settles.
  admit: (owner: string) => Promise<unknown> | undefined
}

export type CdpRelay = {
  port: number
  // Drops a session's open connections so an ended session sends no new commands.
  disconnect: (owner: string) => void
  close: () => Promise<void>
}

export async function startCdpRelay(options: CdpRelayOptions): Promise<CdpRelay> {
  const host = options.host ?? '127.0.0.1'
  const connections = new Map<string, Set<Socket>>()
  const server = createServer((client) => handleClient(client, options, host, server, connections))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('CDP relay did not bind a TCP port')
  return {
    port: address.port,
    disconnect: (owner) => {
      for (const client of connections.get(owner) ?? []) client.destroy()
    },
    close: () => closeServer(server),
  }
}

export function cdpWebSocketUrl(port: number, token: string): string {
  return `ws://127.0.0.1:${port}/devtools/browser/typeclaw?token=${encodeURIComponent(token)}`
}

function handleClient(
  client: Socket,
  options: CdpRelayOptions,
  host: string,
  server: Server,
  connections: Map<string, Set<Socket>>,
): void {
  let buffered = Buffer.alloc(0)
  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk])
    const headEnd = buffered.indexOf('\r\n\r\n')
    if (headEnd === -1) {
      if (buffered.length > MAX_HEAD_BYTES) client.destroy()
      return
    }
    client.off('data', onData)
    client.pause()
    const head = buffered.subarray(0, headEnd).toString('latin1')
    const rest = buffered.subarray(headEnd + 4)
    const request = parseHead(head)
    const token = request?.token
    const owner = token === undefined ? undefined : options.sessions?.ownerOf(token)
    if (request === null || token === undefined || (owner === undefined && !tokenMatches(token, options.token))) {
      client.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
    const relayPort = (server.address() as { port: number }).port
    if (request.isUpgrade) {
      const taps = owner === undefined || options.sessions === undefined ? undefined : tabTaps(owner, options.sessions)
      if (owner !== undefined) trackConnection(connections, owner, client)
      const gate = owner === undefined ? undefined : options.sessions?.admit(owner)
      if (gate === undefined) pipeUpgrade(client, options.upstreamSocket, request, rest, taps)
      else void gate.then(() => pipeUpgrade(client, options.upstreamSocket, request, rest, taps))
    } else {
      void answerDiscovery(client, options.upstreamSocket, token, request.path, `${host}:${relayPort}`)
    }
  }
  client.on('data', onData)
  client.on('error', () => client.destroy())
}

type ParsedHead = {
  method: string
  path: string
  token: string | undefined
  isUpgrade: boolean
  headerLines: string[]
}

function parseHead(head: string): ParsedHead | null {
  const [requestLine, ...headerLines] = head.split('\r\n')
  const match = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine ?? '')
  if (match === null) return null
  let url: URL
  try {
    url = new URL(match[2]!, 'http://relay.invalid')
  } catch {
    return null
  }
  const queryToken = url.searchParams.get('token') ?? undefined
  url.searchParams.delete('token')
  const authorization = headerLines
    .find((line) => line.toLowerCase().startsWith('authorization:'))
    ?.slice('authorization:'.length)
    .trim()
  const headerToken = authorization?.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : undefined
  const isUpgrade = headerLines.some((line) => /^upgrade:\s*websocket\s*$/i.test(line))
  return {
    method: match[1]!,
    path: `${url.pathname}${url.search}`,
    token: queryToken ?? headerToken,
    isUpgrade,
    // Dropping the compression offer keeps frames readable by the tab taps;
    // the hop is loopback, so compression saved nothing.
    headerLines: headerLines.filter((line) => {
      const lower = line.toLowerCase()
      return !lower.startsWith('authorization:') && !lower.startsWith('sec-websocket-extensions:')
    }),
  }
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Chrome's browser target id changes on every launch, so clients connect to a
// stable `/devtools/browser/<anything>` path and the relay substitutes the
// live id discovered from Chrome itself.
function pipeUpgrade(
  client: Socket,
  upstreamSocket: string,
  request: ParsedHead,
  rest: Buffer,
  taps: TabTaps | undefined,
): void {
  void resolveBrowserPath(upstreamSocket, request.path).then(
    (path) => {
      // The session may have been dropped while the lookup ran.
      if (client.destroyed) return
      const upstream = connect(upstreamSocket)
      upstream.on('connect', () => {
        upstream.write(`${request.method} ${path} HTTP/1.1\r\n${request.headerLines.join('\r\n')}\r\n\r\n`)
        if (rest.length > 0) upstream.write(rest)
        if (taps !== undefined) {
          if (rest.length > 0) taps.fromClient(rest)
          client.on('data', taps.fromClient)
          upstream.on('data', skipResponseHead(taps.fromBrowser))
        }
        // The close handler below owns upstream teardown, so a reply Chrome still
        // owes this connection is not cut off by the client's end.
        client.pipe(upstream, { end: false })
        upstream.pipe(client)
        client.resume()
      })
      upstream.on('error', () => client.destroy())
      upstream.on('close', () => client.destroy())
      client.on('close', () => {
        if (taps === undefined || taps.pendingCreates() === 0) return void upstream.destroy()
        // Chrome creates the tab even though nobody reads the reply, so keep
        // reading until it arrives and the tab is attributed to its session.
        upstream.unpipe(client)
        upstream.resume()
        const giveUp = setTimeout(() => upstream.destroy(), PENDING_CREATE_GRACE_MS)
        taps.onSettled(() => {
          clearTimeout(giveUp)
          upstream.destroy()
        })
      })
    },
    () => client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'),
  )
}

function trackConnection(connections: Map<string, Set<Socket>>, owner: string, client: Socket): void {
  let owned = connections.get(owner)
  if (owned === undefined) connections.set(owner, (owned = new Set()))
  owned.add(client)
  client.once('close', () => {
    owned.delete(client)
    if (owned.size === 0 && connections.get(owner) === owned) connections.delete(owner)
  })
}

type TabTaps = {
  fromClient: (chunk: Buffer) => void
  fromBrowser: (chunk: Buffer) => void
  pendingCreates: () => number
  onSettled: (callback: () => void) => void
}

function tabTaps(owner: string, sessions: CdpRelaySessions): TabTaps {
  const pendingCreates = new Set<number>()
  const settledCallbacks: (() => void)[] = []
  const fromClient = createTextMessageTap((text) => {
    if (!text.includes('"Target.')) return
    const message = parseCdpMessage(text)
    if (message?.method === 'Target.createTarget' && typeof message.id === 'number') {
      pendingCreates.add(message.id)
    } else if (message?.method === 'Target.attachToTarget' && typeof message.params?.['targetId'] === 'string') {
      sessions.onTabUsed(owner, message.params['targetId'])
    }
  }, MAX_TAPPED_MESSAGE_BYTES)
  const fromBrowser = createTextMessageTap((text) => {
    // Engines that auto-attach (browser-use) learn of tabs from this event
    // instead of sending Target.attachToTarget themselves.
    if (text.includes('"Target.attachedToTarget"')) {
      const info = parseCdpMessage(text)?.params?.['targetInfo'] as Record<string, unknown> | undefined
      if (info?.['type'] === 'page' && typeof info['targetId'] === 'string') sessions.onTabUsed(owner, info['targetId'])
      return
    }
    if (pendingCreates.size === 0) return
    const message = parseCdpMessage(text)
    if (typeof message?.id !== 'number' || message.method !== undefined || !pendingCreates.delete(message.id)) return
    const targetId = message.result?.['targetId']
    if (typeof targetId === 'string') sessions.onTabCreated(owner, targetId)
    if (pendingCreates.size === 0) for (const callback of settledCallbacks.splice(0)) callback()
  }, MAX_TAPPED_MESSAGE_BYTES)
  return {
    fromClient,
    fromBrowser,
    pendingCreates: () => pendingCreates.size,
    onSettled: (callback) => void settledCallbacks.push(callback),
  }
}

type CdpMessage = {
  id?: unknown
  method?: unknown
  params?: Record<string, unknown>
  result?: Record<string, unknown>
}

function parseCdpMessage(text: string): CdpMessage | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as CdpMessage) : undefined
  } catch {
    return undefined
  }
}

// Chrome's `101 Switching Protocols` head precedes its first frame.
function skipResponseHead(onFrames: (chunk: Buffer) => void): (chunk: Buffer) => void {
  let head: Buffer | undefined = Buffer.alloc(0)
  return (chunk) => {
    if (head === undefined) return onFrames(chunk)
    head = Buffer.concat([head, chunk])
    const end = head.indexOf('\r\n\r\n')
    if (end === -1) return
    const frames = head.subarray(end + 4)
    head = undefined
    if (frames.length > 0) onFrames(frames)
  }
}

async function resolveBrowserPath(upstreamSocket: string, path: string): Promise<string> {
  if (!BROWSER_PATH.test(path)) return path
  const version = (await fetchUpstreamJson(upstreamSocket, '/json/version')) as { webSocketDebuggerUrl?: string }
  const live = version.webSocketDebuggerUrl === undefined ? undefined : new URL(version.webSocketDebuggerUrl).pathname
  if (live === undefined) throw new Error('Chrome did not report a browser target')
  return path.replace(BROWSER_PATH, live)
}

// `/json/*` answers embed Chrome's private `127.0.0.1:9222`; rewrite them to
// the relay (with the token) so a client that discovers over HTTP reconnects
// through the relay instead of to an address it cannot reach.
async function answerDiscovery(client: Socket, upstreamSocket: string, token: string, path: string, relayHost: string) {
  try {
    const body = await fetchUpstreamText(upstreamSocket, path)
    const rewritten = body.replace(
      /ws:\/\/[^/"]+(\/devtools\/[^"]+)/g,
      (_all, devtoolsPath: string) => `ws://${relayHost}${devtoolsPath}?token=${encodeURIComponent(token)}`,
    )
    const bytes = Buffer.from(rewritten)
    client.write(
      `HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`,
    )
    client.end(bytes)
  } catch {
    client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  }
}

async function fetchUpstreamJson(upstreamSocket: string, path: string): Promise<unknown> {
  return JSON.parse(await fetchUpstreamText(upstreamSocket, path)) as unknown
}

async function fetchUpstreamText(upstreamSocket: string, path: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1${path}`, { unix: upstreamSocket } as RequestInit)
  if (!response.ok) throw new Error(`DevTools answered ${response.status} for ${path}`)
  return response.text()
}

// Token-gated raw byte relay for the BrowserSkill daemon socket: the client
// sends the token and a newline, then speaks the daemon's own protocol. A
// `<token> describe` line instead returns `describe()` (the daemon's
// daemon.json, which the CLI cross-checks against the IPC daemon's pid).
export async function startTokenStreamRelay(options: {
  token: string
  upstreamSocket: string
  describe?: () => Promise<string>
}): Promise<Omit<CdpRelay, 'disconnect'>> {
  const server = createServer((client) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const newline = buffered.indexOf('\n')
      if (newline === -1) {
        if (buffered.length > 1024) client.destroy()
        return
      }
      client.off('data', onData)
      client.pause()
      const [candidate, verb] = buffered.subarray(0, newline).toString('latin1').split(' ')
      if (!tokenMatches(candidate, options.token)) {
        client.destroy()
        return
      }
      if (verb === 'describe' && options.describe !== undefined) {
        options.describe().then(
          (text) => client.end(text),
          () => client.destroy(),
        )
        return
      }
      const upstream = connect(options.upstreamSocket)
      upstream.on('connect', () => {
        const rest = buffered.subarray(newline + 1)
        if (rest.length > 0) upstream.write(rest)
        client.pipe(upstream)
        upstream.pipe(client)
        client.resume()
      })
      upstream.on('error', () => client.destroy())
      upstream.on('close', () => client.destroy())
      client.on('close', () => upstream.destroy())
    }
    client.on('data', onData)
    client.on('error', () => client.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as { port: number }
  return { port: address.port, close: () => closeServer(server) }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}
