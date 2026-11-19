import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentTabRegistry, createBrowserSessions, TAB_CAP, TAB_IDLE_MS, TAB_RECENT_MS } from './agent-tabs'
import { cdpWebSocketUrl, startCdpRelay } from './relay'

const MASTER_TOKEN = 'm'.repeat(64)
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

type Hold = { received: Promise<void>; release: () => void }

function createHold(): Hold & { arrive: (reply: () => void) => void } {
  const replies: (() => void)[] = []
  let released = false
  let onReceived!: () => void
  const received = new Promise<void>((resolve) => (onReceived = resolve))
  return {
    received,
    arrive: (reply) => {
      onReceived()
      if (released) reply()
      else replies.push(reply)
    },
    release: () => {
      released = true
      for (const reply of replies.splice(0)) reply()
    },
  }
}

type FakeChrome = {
  socket: string
  closed: string[]
  // Opens a popup in Chrome without any client watching, as when the script that clicked has exited.
  // `missed`: the observer never hears about it live, as when it was offline.
  openPopup: (targetId: string, openerId: string, options?: { missed?: boolean }) => void
  closeFromPage: (targetId: string) => void
  holdCreates: () => Hold
  holdDiscovery: () => Hold
  holdVersion: () => Hold
  holdList: () => Hold
  holdClose: () => Hold
  attachOthers: (targetId: string) => void
  failNextClose: () => void
  upgrades: () => number
  nextClose: () => Promise<string>
  nextDisconnect: () => Promise<void>
}

// Stands in for Chrome's DevTools socket: creates numbered tabs, announces
// targets to discovering clients (existing ones first, before the discovery
// reply, like Chrome), lists open tabs, and records `/json/close` calls. It negotiates
// compression whenever a client offers it, like Chrome does.
async function startFakeChrome(): Promise<FakeChrome> {
  const socket = join(tmpdir(), `typeclaw-tabs-${randomUUID()}.sock`)
  const closed: string[] = []
  const open = new Map<string, string | undefined>()
  const discovering = new Set<Bun.ServerWebSocket<undefined>>()
  const autoAttaching = new Set<Bun.ServerWebSocket<undefined>>()
  const closeWaiters: ((targetId: string) => void)[] = []
  const disconnects: (() => void)[] = []
  let heldCreates: ReturnType<typeof createHold> | undefined
  let heldDiscovery: ReturnType<typeof createHold> | undefined
  let heldVersion: ReturnType<typeof createHold> | undefined
  let heldList: ReturnType<typeof createHold> | undefined
  let heldClose: ReturnType<typeof createHold> | undefined
  let failClose = false
  let upgrades = 0
  let nextTab = 0
  const announce = (ws: Bun.ServerWebSocket<undefined>, targetId: string, openerId: string | undefined) =>
    ws.send(
      JSON.stringify({
        method: 'Target.targetCreated',
        params: { targetInfo: { targetId, type: 'page', ...(openerId === undefined ? {} : { openerId }) } },
      }),
    )
  const server = Bun.serve({
    unix: socket,
    async fetch(request, srv) {
      const url = new URL(request.url)
      if (url.pathname === '/json/version') {
        const version = () => Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/live-id' })
        const hold = heldVersion
        if (hold === undefined) return version()
        return new Promise<Response>((resolve) => hold.arrive(() => resolve(version())))
      }
      if (url.pathname === '/json/list') {
        const list = Response.json([...open.keys()].map((id) => ({ id, type: 'page' })))
        const hold = heldList
        if (hold === undefined) return list
        return new Promise<Response>((resolve) => hold.arrive(() => resolve(list)))
      }
      if (url.pathname.startsWith('/json/close/')) {
        const targetId = decodeURIComponent(url.pathname.slice('/json/close/'.length))
        if (failClose) {
          failClose = false
          return new Response('busy', { status: 500 })
        }
        const close = () => {
          closed.push(targetId)
          open.delete(targetId)
          // Like Chrome, a closed opener is no longer reported for its popups.
          for (const [other, openerId] of open) if (openerId === targetId) open.set(other, undefined)
          const event = JSON.stringify({ method: 'Target.targetDestroyed', params: { targetId } })
          for (const ws of discovering) ws.send(event)
          closeWaiters.shift()?.(targetId)
          return new Response('Target is closing')
        }
        const hold = heldClose
        if (hold === undefined) return close()
        return new Promise<Response>((resolve) => hold.arrive(() => resolve(close())))
      }
      if (url.pathname === '/devtools/browser/live-id' && srv.upgrade(request, { data: undefined })) {
        upgrades += 1
        return undefined
      }
      return new Response('not found', { status: 404 })
    },
    websocket: {
      perMessageDeflate: true,
      close: (ws) => {
        discovering.delete(ws)
        autoAttaching.delete(ws)
        disconnects.shift()?.()
      },
      message: (ws, raw) => {
        const message = JSON.parse(String(raw)) as { id: number; method: string }
        if (message.method === 'Target.setDiscoverTargets') {
          for (const [targetId, openerId] of open) announce(ws, targetId, openerId)
          discovering.add(ws)
          const reply = () => ws.send(JSON.stringify({ id: message.id, result: {} }))
          if (heldDiscovery === undefined) reply()
          else heldDiscovery.arrive(reply)
          return
        }
        if (message.method === 'Target.setAutoAttach') autoAttaching.add(ws)
        const targetId = message.method === 'Target.createTarget' ? `T${nextTab++}` : undefined
        if (targetId !== undefined) {
          open.set(targetId, undefined)
          const attached = { method: 'Target.attachedToTarget', params: { targetInfo: { targetId, type: 'page' } } }
          for (const other of autoAttaching) if (other !== ws) other.send(JSON.stringify(attached))
        }
        const reply = () =>
          ws.send(JSON.stringify({ id: message.id, result: targetId === undefined ? {} : { targetId } }))
        if (targetId !== undefined && heldCreates !== undefined) heldCreates.arrive(reply)
        else reply()
      },
    },
  })
  cleanups.push(async () => {
    await server.stop(true)
    await rm(socket, { force: true })
  })
  return {
    socket,
    closed,
    openPopup: (targetId, openerId, { missed = false } = {}) => {
      open.set(targetId, openerId)
      if (!missed) for (const ws of discovering) announce(ws, targetId, openerId)
    },
    closeFromPage: (targetId) => {
      open.delete(targetId)
      const event = JSON.stringify({ method: 'Target.targetDestroyed', params: { targetId } })
      for (const ws of discovering) ws.send(event)
    },
    holdCreates: () => (heldCreates = createHold()),
    holdDiscovery: () => (heldDiscovery = createHold()),
    holdVersion: () => (heldVersion = createHold()),
    upgrades: () => upgrades,
    holdList: () => (heldList = createHold()),
    holdClose: () => (heldClose = createHold()),
    attachOthers: (targetId) => {
      const attached = { method: 'Target.attachedToTarget', params: { targetInfo: { targetId, type: 'page' } } }
      for (const ws of autoAttaching) ws.send(JSON.stringify(attached))
    },
    failNextClose: () => void (failClose = true),
    nextClose: () => new Promise((resolve) => closeWaiters.push(resolve)),
    nextDisconnect: () => new Promise((resolve) => disconnects.push(resolve)),
  }
}

type CdpClient = { send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>> }

async function connectCdp(url: string): Promise<CdpClient & { closed: Promise<void>; close: () => void }> {
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error(`could not connect to ${url}`))
  })
  cleanups.push(() => ws.close())
  const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve()))
  const replies = new Map<number, (result: Record<string, unknown>) => void>()
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown> }
    if (message.id !== undefined) replies.get(message.id)?.(message.result ?? {})
  }
  let nextId = 1
  return {
    send: (method, params = {}) =>
      new Promise((resolve) => {
        const id = nextId++
        replies.set(id, resolve)
        ws.send(JSON.stringify({ id, method, params }))
      }),
    closed,
    close: () => ws.close(),
  }
}

async function setup(now: () => number = Date.now) {
  const chrome = await startFakeChrome()
  const sessions = createBrowserSessions(chrome.socket, now)
  const relay = await startCdpRelay({ token: MASTER_TOKEN, upstreamSocket: chrome.socket, sessions: sessions.relay })
  cleanups.push(() => relay.close())
  const connectAs = (sessionId: string) => connectCdp(cdpWebSocketUrl(relay.port, sessions.tokenFor(sessionId)))
  const startObserver = () => {
    const observer = sessions.observe(cdpWebSocketUrl(relay.port, MASTER_TOKEN))
    cleanups.push(() => observer.stop())
    return observer
  }
  const observe = () => startObserver().ready
  return { chrome, sessions, relay, connectAs, observe, startObserver }
}

async function openTab(client: CdpClient): Promise<string> {
  return String((await client.send('Target.createTarget', { url: 'about:blank' }))['targetId'])
}

describe('session-owned browser tabs', () => {
  test("closes a session's tabs when it ends and leaves other sessions' and runtime tabs open", async () => {
    const { chrome, sessions, relay, connectAs } = await setup()
    const first = await connectAs('session-a')
    const second = await connectAs('session-b')
    const runtime = await connectCdp(cdpWebSocketUrl(relay.port, MASTER_TOKEN))

    const ownTabs = [await openTab(first), await openTab(first)]
    await openTab(second)
    await openTab(runtime)

    expect(await sessions.end('session-a')).toBe(2)
    expect(chrome.closed).toEqual(ownTabs)
  })

  test('keeps a tab another live session attached to until that session ends too', async () => {
    const { chrome, sessions, connectAs } = await setup()
    const opener = await connectAs('session-a')
    const borrower = await connectAs('session-b')
    const tab = await openTab(opener)

    await borrower.send('Target.attachToTarget', { targetId: tab, flatten: true })

    expect(await sessions.end('session-a')).toBe(0)
    expect(await sessions.end('session-b')).toBe(1)
    expect(chrome.closed).toEqual([tab])
  })

  test('closes a popup that appeared after its script disconnected, with the session that owns its opener', async () => {
    const { chrome, sessions, connectAs, observe } = await setup()
    const client = await connectAs('session-a')
    const tab = await openTab(client)
    const disconnected = chrome.nextDisconnect()
    client.close()
    await disconnected

    chrome.openPopup('popup-1', tab)
    await observe()

    expect(await sessions.end('session-a')).toBe(2)
    expect(chrome.closed.toSorted()).toEqual(['popup-1', tab].toSorted())
  })

  test('forgets tabs Chrome already closed instead of closing them again', async () => {
    const { chrome, sessions, connectAs, observe } = await setup()
    const client = await connectAs('session-a')
    const kept = await openTab(client)
    chrome.closeFromPage(await openTab(client))

    await observe()

    expect(await sessions.end('session-a')).toBe(1)
    expect(chrome.closed).toEqual([kept])
  })

  test('closes a tab Chrome finishes creating after its session ended, and drops the session connection', async () => {
    const { chrome, sessions, relay, connectAs } = await setup()
    const client = await connectAs('session-a')
    const hold = chrome.holdCreates()
    void client.send('Target.createTarget', { url: 'about:blank' })
    await hold.received

    relay.disconnect('session-a')
    await client.closed
    expect(await sessions.end('session-a')).toBe(0)
    const closing = chrome.nextClose()
    hold.release()

    expect(await closing).toBe('T0')
  })

  test('closes a popup whose event arrives after the session that owns its opener ended', async () => {
    const { chrome, sessions, connectAs, observe } = await setup()
    await observe()
    const tab = await openTab(await connectAs('session-a'))
    const hold = chrome.holdClose()
    const ending = sessions.end('session-a')
    await hold.received

    chrome.openPopup('popup-1', tab)
    const closes = [chrome.nextClose(), chrome.nextClose()]
    hold.release()

    expect(await ending).toBe(1)
    expect((await Promise.all(closes)).toSorted()).toEqual(['popup-1', tab].toSorted())
  })

  test('keeps a tab a session created while discovery was in flight', async () => {
    const { chrome, sessions, connectAs, startObserver } = await setup()
    const client = await connectAs('session-a')
    const hold = chrome.holdDiscovery()
    const observer = startObserver()
    await hold.received

    const tab = await openTab(client)
    hold.release()
    await observer.ready

    expect(await sessions.end('session-a')).toBe(1)
    expect(chrome.closed).toEqual([tab])
  })

  test('closes a popup of an opener created and released while discovery was in flight', async () => {
    const { chrome, sessions, connectAs, startObserver } = await setup()
    const client = await connectAs('session-a')
    const discovery = chrome.holdDiscovery()
    const observer = startObserver()
    await discovery.received
    const tab = await openTab(client)
    const closing = chrome.holdClose()
    expect(await sessions.end('session-a')).toBe(0)
    discovery.release()
    await observer.ready
    await closing.received

    chrome.openPopup('popup-1', tab)
    const closes = [chrome.nextClose(), chrome.nextClose()]
    closing.release()

    expect((await Promise.all(closes)).toSorted()).toEqual(['popup-1', tab].toSorted())
  })

  test('holds new session connections until the observer has caught up with Chrome', async () => {
    const { chrome, relay, connectAs, startObserver } = await setup()
    const discovery = chrome.holdDiscovery()
    const observer = startObserver()
    await discovery.received
    const upgradesBefore = chrome.upgrades()

    const connecting = connectAs('session-a')
    await connectCdp(cdpWebSocketUrl(relay.port, MASTER_TOKEN))
    expect(chrome.upgrades()).toBe(upgradesBefore + 1)

    discovery.release()
    await observer.ready
    await connecting
    expect(chrome.upgrades()).toBe(upgradesBefore + 2)
  })

  test('closes a popup an existing session opened while the observer was offline, without closing unrelated tabs', async () => {
    const { chrome, sessions, relay, connectAs, startObserver } = await setup()
    const first = startObserver()
    await first.ready
    const client = await connectAs('session-a')
    const tab = await openTab(client)
    const unrelated = await openTab(await connectCdp(cdpWebSocketUrl(relay.port, MASTER_TOKEN)))
    first.stop()
    const offline = sessions.observe('ws://127.0.0.1:9/devtools/browser/unreachable')
    cleanups.push(() => offline.stop())

    chrome.openPopup('popup-1', tab, { missed: true })
    const closes = [chrome.nextClose(), chrome.nextClose()]
    expect(await sessions.end('session-a')).toBe(0)
    expect(chrome.closed).toEqual([])
    await startObserver().ready

    expect((await Promise.all(closes)).toSorted()).toEqual(['popup-1', tab].toSorted())
    expect(chrome.closed).not.toContain(unrelated)
  })

  test('closes a popup from a connection admitted after the sync wait timed out', async () => {
    const { chrome, sessions, relay, connectAs, startObserver } = await setup()
    const unreachable = sessions.observe('ws://127.0.0.1:9/devtools/browser/unreachable')
    cleanups.push(() => unreachable.stop())
    const unrelated = await openTab(await connectCdp(cdpWebSocketUrl(relay.port, MASTER_TOKEN)))

    const tab = await openTab(await connectAs('session-a'))
    chrome.openPopup('popup-1', tab, { missed: true })
    const closes = [chrome.nextClose(), chrome.nextClose()]
    expect(await sessions.end('session-a')).toBe(0)
    expect(chrome.closed).toEqual([])
    await startObserver().ready

    expect((await Promise.all(closes)).toSorted()).toEqual(['popup-1', tab].toSorted())
    expect(chrome.closed).not.toContain(unrelated)
  }, 15_000)

  test('ends a session promptly while discovery is unavailable, closing nothing early and nothing after the browser stops', async () => {
    const { chrome, sessions, connectAs, startObserver } = await setup()
    await openTab(await connectAs('session-a'))
    const offline = sessions.observe('ws://127.0.0.1:9/devtools/browser/unreachable')

    expect(await sessions.end('session-a')).toBe(0)
    expect(chrome.closed).toEqual([])

    offline.stop()
    await startObserver().ready
    const later = await openTab(await connectAs('session-b'))
    expect(await sessions.end('session-b')).toBe(1)
    expect(chrome.closed).toEqual([later])
  })

  test('closes nested popups that discovery lists before the popup that opened them', async () => {
    const { chrome, sessions, relay, connectAs, startObserver } = await setup()
    const tab = await openTab(await connectAs('session-a'))
    const unrelated = await openTab(await connectCdp(cdpWebSocketUrl(relay.port, MASTER_TOKEN)))
    const unreachable = sessions.observe('ws://127.0.0.1:9/devtools/browser/unreachable')
    cleanups.push(() => unreachable.stop())
    chrome.openPopup('popup-q', 'popup-p', { missed: true })
    chrome.openPopup('popup-p', tab, { missed: true })
    expect(await sessions.end('session-a')).toBe(0)

    const closes = [chrome.nextClose(), chrome.nextClose(), chrome.nextClose()]
    await startObserver().ready

    expect((await Promise.all(closes)).toSorted()).toEqual(['popup-p', 'popup-q', tab].toSorted())
    expect(chrome.closed).not.toContain(unrelated)
  })

  test('keeps a tab queued for closing during an outage once another session attaches to it', async () => {
    const { chrome, sessions, connectAs, startObserver } = await setup()
    const tab = await openTab(await connectAs('session-a'))
    const borrower = await connectAs('session-b')
    const unreachable = sessions.observe('ws://127.0.0.1:9/devtools/browser/unreachable')
    cleanups.push(() => unreachable.stop())
    expect(await sessions.end('session-a')).toBe(0)

    await borrower.send('Target.attachToTarget', { targetId: tab, flatten: true })
    await startObserver().ready
    expect(chrome.closed).toEqual([])

    expect(await sessions.end('session-b')).toBe(1)
    expect(chrome.closed).toEqual([tab])
  })

  test('keeps a late-created tab open during an outage until its popups can be attributed', async () => {
    const { chrome, sessions, relay, connectAs, startObserver } = await setup()
    const creator = await connectAs('session-a')
    const unrelated = await openTab(await connectCdp(cdpWebSocketUrl(relay.port, MASTER_TOKEN)))
    const hold = chrome.holdCreates()
    const created = openTab(creator)
    await hold.received
    const unreachable = sessions.observe('ws://127.0.0.1:9/devtools/browser/unreachable')
    cleanups.push(() => unreachable.stop())
    expect(await sessions.end('session-a')).toBe(0)

    hold.release()
    const tab = await created
    chrome.openPopup('popup-1', tab, { missed: true })
    expect(chrome.closed).toEqual([])
    const closes = [chrome.nextClose(), chrome.nextClose()]
    await startObserver().ready

    expect((await Promise.all(closes)).toSorted()).toEqual(['popup-1', tab].toSorted())
    expect(chrome.closed).not.toContain(unrelated)
  })

  test('closes a popup reported before its late-created opener was registered', async () => {
    const { chrome, sessions, connectAs, observe } = await setup()
    await observe()
    const creator = await connectAs('session-a')
    const hold = chrome.holdCreates()
    const created = openTab(creator)
    await hold.received
    expect(await sessions.end('session-a')).toBe(0)
    chrome.openPopup('popup-1', 'T0')
    await connectAs('session-b')

    const closes = [chrome.nextClose(), chrome.nextClose()]
    hold.release()
    await created

    expect((await Promise.all(closes)).toSorted()).toEqual(['T0', 'popup-1'])
  })

  test('does not open a Chrome connection for a session dropped while its upgrade was resolving', async () => {
    const { chrome, sessions, relay, connectAs } = await setup()
    const hold = chrome.holdVersion()
    const pending = new WebSocket(cdpWebSocketUrl(relay.port, sessions.tokenFor('session-a')))
    const pendingClosed = new Promise<void>((resolve) => pending.addEventListener('close', () => resolve()))
    await hold.received

    relay.disconnect('session-a')
    await pendingClosed
    hold.release()
    await connectAs('session-b')

    expect(chrome.upgrades()).toBe(1)
  })

  test('keeps a tab another session auto-attached to, even before its creator registered it', async () => {
    const { chrome, sessions, connectAs } = await setup()
    const creator = await connectAs('session-a')
    const watcher = await connectAs('session-b')
    await watcher.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    const hold = chrome.holdCreates()
    const created = openTab(creator)
    await hold.received
    await watcher.send('Runtime.evaluate', { expression: '1' })
    hold.release()
    const tab = await created

    expect(await sessions.end('session-a')).toBe(0)
    expect(await sessions.end('session-b')).toBe(1)
    expect(chrome.closed).toEqual([tab])
  })

  test('keeps a tab for an auto-attached session when its creator ended before Chrome replied', async () => {
    const { chrome, sessions, connectAs } = await setup()
    const creator = await connectAs('session-a')
    const watcher = await connectAs('session-b')
    await watcher.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    const hold = chrome.holdCreates()
    const created = openTab(creator)
    await hold.received
    await watcher.send('Runtime.evaluate', { expression: '1' })

    expect(await sessions.end('session-a')).toBe(0)
    hold.release()
    const tab = await created

    expect(chrome.closed).toEqual([])
    expect(await sessions.end('session-b')).toBe(1)
    expect(chrome.closed).toEqual([tab])
  })

  test('keeps a popup for a session that auto-attached to it before discovery attributed it', async () => {
    const { chrome, sessions, connectAs, observe } = await setup()
    const tab = await openTab(await connectAs('session-a'))
    const watcher = await connectAs('session-b')
    await watcher.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    chrome.attachOthers('popup-1')
    await watcher.send('Runtime.evaluate', { expression: '1' })
    chrome.openPopup('popup-1', tab)

    await observe()

    expect(await sessions.end('session-a')).toBe(1)
    expect(chrome.closed).toEqual([tab])
    expect(await sessions.end('session-b')).toBe(1)
    expect(chrome.closed).toEqual([tab, 'popup-1'])
  })

  test('never closes a runtime tab another session merely auto-attached to', async () => {
    const { chrome, sessions, relay, connectAs } = await setup()
    const watcher = await connectAs('session-b')
    await watcher.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    await openTab(await connectCdp(cdpWebSocketUrl(relay.port, MASTER_TOKEN)))
    await watcher.send('Runtime.evaluate', { expression: '1' })

    expect(await sessions.end('session-b')).toBe(0)
    expect(chrome.closed).toEqual([])
  })

  test('keeps a compression-offering client uncompressed so its tabs stay attributable', async () => {
    const { sessions, relay } = await setup()
    const handshake = [
      `GET /devtools/browser/typeclaw?token=${sessions.tokenFor('session-a')} HTTP/1.1`,
      `Host: 127.0.0.1:${relay.port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits',
    ].join('\r\n')

    const responseHead = await new Promise<string>((resolve, reject) => {
      const socket = connect(relay.port, '127.0.0.1', () => socket.write(`${handshake}\r\n\r\n`))
      let received = ''
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('latin1')
        if (!received.includes('\r\n\r\n')) return
        socket.destroy()
        resolve(received.slice(0, received.indexOf('\r\n\r\n')))
      })
      socket.on('error', reject)
    })

    expect(responseHead).toStartWith('HTTP/1.1 101')
    expect(responseHead.toLowerCase()).not.toContain('sec-websocket-extensions')
  })

  test("refuses an ended session's token while the runtime token keeps working", async () => {
    const { sessions, relay } = await setup()
    const token = sessions.tokenFor('session-a')
    expect((await fetch(`http://127.0.0.1:${relay.port}/json/version?token=${token}`)).status).toBe(200)

    await sessions.end('session-a')

    expect((await fetch(`http://127.0.0.1:${relay.port}/json/version?token=${token}`)).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${relay.port}/json/version?token=${MASTER_TOKEN}`)).status).toBe(200)
  })
})

describe('idle and over-cap tab reaping', () => {
  const MINUTE = 60_000

  test('closes tabs idle past the limit and keeps those a connected script still holds', () => {
    const registry = new AgentTabRegistry()
    registry.created('idle-session', 'idle-tab', 0)
    registry.created('busy-session', 'busy-tab', 0)
    registry.connected('busy-session')

    expect(registry.reapable(TAB_IDLE_MS - 1)).toEqual([])
    expect(registry.reapable(TAB_IDLE_MS)).toEqual(['idle-tab'])
  })

  test('over the cap, closes the least recently used first and spares recently used tabs', () => {
    const registry = new AgentTabRegistry()
    const total = TAB_CAP + 3
    for (let i = 0; i < total; i++) registry.created('session', `T${i}`, i * MINUTE)

    expect(registry.reapable((total - 1) * MINUTE)).toEqual(['T0', 'T1', 'T2'])
  })

  test('never goes below the cap by closing tabs used within the recent window', () => {
    const registry = new AgentTabRegistry()
    for (let i = 0; i < TAB_CAP + 2; i++) registry.created('session', `T${i}`, 0)

    expect(registry.reapable(TAB_RECENT_MS - 1)).toEqual([])
  })

  test('a script disconnecting counts as use of every tab its session owns', () => {
    const registry = new AgentTabRegistry()
    registry.created('session', 'tab', 0)
    registry.connected('session')

    registry.disconnected('session', 10 * MINUTE)

    expect(registry.reapable(TAB_IDLE_MS)).toEqual([])
    expect(registry.reapable(10 * MINUTE + TAB_IDLE_MS)).toEqual(['tab'])
  })

  test('reaps an idle tab through the relay once its script disconnects, and forgets tabs a page closed itself', async () => {
    let clock = 0
    const { chrome, sessions, relay, connectAs, observe } = await setup(() => clock)
    await observe()
    const client = await connectAs('session-a')
    const kept = await openTab(client)
    chrome.closeFromPage(await openTab(client))

    relay.disconnect('session-a')
    await client.closed
    clock = TAB_IDLE_MS

    expect(await sessions.reap()).toEqual({ closed: 1, failed: 0 })
    expect(chrome.closed).toEqual([kept])
    expect(await sessions.end('session-a')).toBe(0)
  })

  test('keeps a tab opened while the sweep was waiting for the page list', async () => {
    const { chrome, sessions, connectAs } = await setup()
    const client = await connectAs('session-a')
    const first = await openTab(client)
    const hold = chrome.holdList()
    const reaping = sessions.reap()
    await hold.received

    const second = await openTab(client)
    hold.release()
    await reaping

    expect(await sessions.end('session-a')).toBe(2)
    expect(chrome.closed.toSorted()).toEqual([first, second].toSorted())
  })

  test('does not sweep while the observer is behind, and sweeps once it catches up', async () => {
    let clock = 0
    const { chrome, sessions, relay, connectAs, startObserver } = await setup(() => clock)
    const client = await connectAs('session-a')
    const tab = await openTab(client)
    relay.disconnect('session-a')
    await client.closed
    const unreachable = sessions.observe('ws://127.0.0.1:9/devtools/browser/unreachable')
    cleanups.push(() => unreachable.stop())
    clock = TAB_IDLE_MS

    expect(await sessions.reap()).toEqual({ closed: 0, failed: 0 })
    await startObserver().ready
    expect(await sessions.reap()).toEqual({ closed: 1, failed: 0 })
    expect(chrome.closed).toEqual([tab])
  })

  test('retries a tab whose close failed on the next sweep', async () => {
    let clock = 0
    const { chrome, sessions, relay, connectAs, observe } = await setup(() => clock)
    await observe()
    const client = await connectAs('session-a')
    const tab = await openTab(client)
    relay.disconnect('session-a')
    await client.closed
    clock = TAB_IDLE_MS

    chrome.failNextClose()
    expect(await sessions.reap()).toEqual({ closed: 0, failed: 1 })
    expect(await sessions.reap()).toEqual({ closed: 1, failed: 0 })
    expect(chrome.closed).toEqual([tab])
  })

  test('lets a reconnecting owner through once the bounded wait ends, even if Chrome never answers the close', async () => {
    let clock = 0
    const { chrome, sessions, relay, connectAs, observe } = await setup(() => clock)
    await observe()
    const client = await connectAs('session-a')
    await openTab(client)
    relay.disconnect('session-a')
    await client.closed
    clock = TAB_IDLE_MS

    const hold = chrome.holdClose()
    const reaping = sessions.reap()
    await hold.received
    await connectAs('session-a')

    hold.release()
    expect(await reaping).toEqual({ closed: 1, failed: 0 })
  })

  test('holds a reconnecting owner until the sweep closing its tabs has finished', async () => {
    let clock = 0
    const { chrome, sessions, relay, connectAs, observe } = await setup(() => clock)
    await observe()
    const client = await connectAs('session-a')
    await openTab(client)
    relay.disconnect('session-a')
    await client.closed
    clock = TAB_IDLE_MS
    const upgradesBefore = chrome.upgrades()

    const hold = chrome.holdClose()
    const reaping = sessions.reap()
    await hold.received
    const reconnecting = connectAs('session-a')
    await connectAs('session-b')
    expect(chrome.upgrades()).toBe(upgradesBefore + 1)

    hold.release()
    expect(await reaping).toEqual({ closed: 1, failed: 0 })
    await reconnecting
    expect(chrome.upgrades()).toBe(upgradesBefore + 2)
  })
})
