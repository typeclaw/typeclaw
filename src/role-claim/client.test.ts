import { afterEach, describe, expect, test } from 'bun:test'

import type { Server, TCPSocketListener } from 'bun'

import type { ClaimCompletedPayload, ClaimStartedPayload, ClientMessage, ServerMessage } from '@/shared'

import { runClaimSession } from './client'

type RaceServer = Server<{ ready: boolean }>
let server: RaceServer | null = null
let stalledTcp: TCPSocketListener<undefined> | null = null

afterEach(() => {
  server?.stop(true)
  server = null
  stalledTcp?.stop(true)
  stalledTcp = null
})

// Accepts the TCP connection but never speaks the WebSocket upgrade, so the
// client's `open` event never fires and waitForOpen must hit its own budget.
function serveStalledOpen(): number {
  const listener = Bun.listen<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    socket: { open() {}, data() {}, close() {} },
  })
  stalledTcp = listener
  return listener.port
}

type ServeOptions = {
  openDelayMs: number
  emitConnected?: boolean
}

function serveRaceProneClaim(opts: ServeOptions): RaceServer {
  return Bun.serve<{ ready: boolean }>({
    port: 0,
    fetch(req, s) {
      const data = { ready: false }
      if (s.upgrade(req, { data })) return
      return new Response('typeclaw agent', { status: 200 })
    },
    websocket: {
      async open(ws) {
        await new Promise((r) => setTimeout(r, opts.openDelayMs))
        ws.data.ready = true
        if (opts.emitConnected !== false) {
          const msg: ServerMessage = { type: 'connected', sessionId: 'sid-test' }
          ws.send(JSON.stringify(msg))
        }
      },
      message(ws, raw) {
        const parsed = JSON.parse(String(raw)) as ClientMessage
        if (!ws.data.ready) return
        handleClientMessage(ws, parsed)
      },
    },
  })
}

function handleClientMessage(
  ws: Parameters<NonNullable<NonNullable<Parameters<typeof Bun.serve>[0]['websocket']>['message']>>[0] & {
    data: { ready: boolean }
  },
  msg: ClientMessage,
): void {
  if (msg.type !== 'claim_start') return
  const startedPayload: ClaimStartedPayload = {
    code: msg.code,
    role: msg.role,
    expiresAt: Date.now() + msg.ttlMs,
  }
  ws.send(JSON.stringify({ type: 'claim_started', payload: startedPayload } satisfies ServerMessage))
  const completedPayload: ClaimCompletedPayload = {
    code: msg.code,
    role: msg.role,
    matchRule: 'discord:test',
    adapter: 'discord-bot',
    authorId: 'U_TEST',
  }
  ws.send(JSON.stringify({ type: 'claim_completed', payload: completedPayload } satisfies ServerMessage))
}

describe('runClaimSession', () => {
  test("doesn't race with the server's slow open path", async () => {
    // given: a server whose `open` takes 100ms (modeling createSession during
    // hatching). Pre-`connected` messages are dropped, mirroring production.
    server = serveRaceProneClaim({ openDelayMs: 100 })
    const port = server.port

    // when: client runs the full claim session
    let onStartedFired = false
    const result = await runClaimSession({
      url: `ws://127.0.0.1:${port}`,
      role: 'owner',
      ttlMs: 500,
      onStarted: () => {
        onStartedFired = true
      },
    })

    expect(onStartedFired).toBe(true)
    expect(result.kind).toBe('completed')
  })

  test('times out the connect handshake if connected never arrives', async () => {
    // given: a server that accepts the upgrade but never sends `connected`
    server = serveRaceProneClaim({ openDelayMs: 0, emitConnected: false })
    const port = server.port

    // when: client runs with a generous open budget but a short connected budget
    // (a loaded host could otherwise blow the shared budget on the open phase and
    // surface the wrong "timed out connecting" error)
    // then: the session rejects specifically on the missing `connected` message
    await expect(
      runClaimSession({
        url: `ws://127.0.0.1:${port}`,
        role: 'owner',
        ttlMs: 60_000,
        openTimeoutMs: 5_000,
        connectTimeoutMs: 200,
      }),
    ).rejects.toThrow(/timed out waiting for connected/i)
  })

  test('an omitted openTimeoutMs makes the open phase time out on the connectTimeoutMs budget', async () => {
    // given: a peer that never completes the WS upgrade, so only the open phase
    // can resolve the session — and it can only do so by timing out
    const port = serveStalledOpen()

    // when: openTimeoutMs is omitted and connectTimeoutMs is short
    // then: the open phase rejects on the inherited 200ms budget. Asserting the
    // budget in the message (not just /connecting/) is what pins the fallback:
    // if the default regressed to DEFAULT_CONNECT_TIMEOUT_MS the open phase would
    // wait 30s and this would fail.
    const start = Date.now()
    await expect(
      runClaimSession({
        url: `ws://127.0.0.1:${port}`,
        role: 'owner',
        ttlMs: 60_000,
        connectTimeoutMs: 200,
      }),
    ).rejects.toThrow(/timed out connecting to .* after 200ms/i)
    expect(Date.now() - start).toBeLessThan(2_000)
  })
})
