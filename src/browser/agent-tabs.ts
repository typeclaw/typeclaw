import { createHash, randomBytes } from 'node:crypto'

import type { CdpRelaySessions } from './relay'

const OBSERVER_RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const
// How long a session connection waits for the observer to catch up before it
// is let through anyway (Chrome may simply not be up yet).
const OBSERVER_SYNC_WAIT_MS = 5_000

export type BrowserSessions = {
  relay: CdpRelaySessions
  tokenFor: (sessionId: string) => string
  // Revokes the session's token and closes the tabs no live session still
  // shares; resolves to the number closed now. While the observer is behind,
  // those tabs are queued and closed once it catches up instead.
  end: (sessionId: string) => Promise<number>
  // Follows Chrome's own target events over a runtime connection, so popups
  // are attributed and closed tabs forgotten even when no session script is
  // connected. Reconnects until stopped.
  observe: (browserUrl: string) => TargetObserver
}

export type TargetObserver = {
  // Resolves once the first discovery pass has been reconciled.
  ready: Promise<void>
  stop: () => void
}

export function createBrowserSessions(upstreamSocket: string): BrowserSessions {
  const tabs = new AgentTabRegistry()
  const tokens = new Map<string, string>()
  // Keyed by digest so a lookup's timing reveals nothing about stored tokens.
  const ownerByDigest = new Map<string, string>()
  // While the observer is not caught up with Chrome, a popup can outlive the
  // opener that would attribute it, so session connections wait for it.
  let unsynced: { done: Promise<void>; resolve: () => void } | undefined
  const markUnsynced = (): void => {
    if (unsynced !== undefined) return
    let resolve!: () => void
    const done = new Promise<void>((r) => (resolve = r))
    unsynced = { done, resolve }
  }
  // Chrome stops reporting a closed opener's id, so tabs released while the
  // observer is behind stay open until it catches up and their popups can be
  // attributed. Session teardown never waits for that.
  const deferred = new Set<string>()
  const markSynced = (): void => {
    unsynced?.resolve()
    unsynced = undefined
    // A queued tab another session attached to meanwhile was reclaimed.
    const due = [...deferred].filter((targetId) => tabs.isReleased(targetId))
    deferred.clear()
    if (due.length > 0) void closeTabs(upstreamSocket, due)
  }
  const closeUnowned = (targetIds: string[]): Promise<number> => {
    if (unsynced === undefined) return closeTabs(upstreamSocket, targetIds)
    for (const targetId of targetIds) deferred.add(targetId)
    return Promise.resolve(0)
  }
  return {
    relay: {
      ownerOf: (candidate) => ownerByDigest.get(tokenDigest(candidate)),
      // A create Chrome answers after its session ended would otherwise
      // outlive the cleanup that already ran.
      onTabCreated: (owner, targetId) => {
        if (tokens.has(owner)) tabs.created(owner, targetId)
        else if (!tabs.adoptShared(targetId)) {
          tabs.markReleased(targetId)
          void closeUnowned([targetId])
        }
        // Popups reported before this tab was registered can be attributed now.
        const orphans = tabs.resolveAwaiting(targetId)
        if (orphans.length > 0) void closeUnowned(orphans)
      },
      onTabUsed: (owner, targetId) => {
        if (!tokens.has(owner)) return
        if (deferred.delete(targetId)) tabs.reclaim(owner, targetId)
        else tabs.used(owner, targetId)
      },
      admit: () =>
        unsynced === undefined
          ? undefined
          : Promise.race([unsynced.done, new Promise((resolve) => setTimeout(resolve, OBSERVER_SYNC_WAIT_MS).unref())]),
    },
    tokenFor: (sessionId) => {
      let token = tokens.get(sessionId)
      if (token === undefined) {
        token = randomBytes(32).toString('hex')
        tokens.set(sessionId, token)
        ownerByDigest.set(tokenDigest(token), sessionId)
      }
      return token
    },
    end: async (sessionId) => {
      const token = tokens.get(sessionId)
      if (token !== undefined) {
        tokens.delete(sessionId)
        ownerByDigest.delete(tokenDigest(token))
      }
      const orphaned = tabs.release(sessionId)
      if (orphaned.length === 0) return 0
      return closeUnowned(orphaned)
    },
    observe: (browserUrl) => {
      markUnsynced()
      const observer = observeTargets(browserUrl, tabs, {
        closeOrphan: (targetId) => void closeUnowned([targetId]),
        onSynced: markSynced,
        onLost: markUnsynced,
      })
      return {
        ready: observer.ready,
        stop: () => {
          deferred.clear()
          observer.stop()
        },
      }
    },
  }
}

const DISCOVER_ID = 1

type ObserverHooks = { closeOrphan: (targetId: string) => void; onSynced: () => void; onLost: () => void }

function observeTargets(browserUrl: string, tabs: AgentTabRegistry, hooks: ObserverHooks): TargetObserver {
  let stopped = false
  let failures = 0
  let socket: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let markReady!: () => void
  const ready = new Promise<void>((resolve) => (markReady = resolve))
  const connect = (): void => {
    const ws = new WebSocket(browserUrl)
    socket = ws
    // Chrome answers discovery with one targetCreated per live target before
    // its reply, which lets a reconnect catch up on what it missed.
    const live = new Set<string>()
    let discovering = true
    // Tabs tracked after discovery starts may be missing from Chrome's
    // snapshot without being closed, so only older entries are pruned.
    let generation = 0
    ws.onopen = () => {
      generation = tabs.generation
      ws.send(JSON.stringify({ id: DISCOVER_ID, method: 'Target.setDiscoverTargets', params: { discover: true } }))
    }
    ws.onmessage = (event) => {
      const message = parseJson(String(event.data))
      if (message?.['id'] === DISCOVER_ID) {
        tabs.retainOnly(live, generation)
        discovering = false
        failures = 0
        hooks.onSynced()
        markReady()
        return
      }
      const params = message?.['params'] as Record<string, unknown> | undefined
      if (message?.['method'] === 'Target.targetCreated') {
        const info = params?.['targetInfo'] as Record<string, unknown> | undefined
        if (info?.['type'] !== 'page' || typeof info['targetId'] !== 'string') return
        if (discovering) live.add(info['targetId'])
        if (typeof info['openerId'] !== 'string') return
        for (const orphan of tabs.opened(info['targetId'], info['openerId'])) hooks.closeOrphan(orphan)
      } else if (message?.['method'] === 'Target.targetDestroyed' && typeof params?.['targetId'] === 'string') {
        tabs.forget(params['targetId'])
      }
    }
    ws.onclose = () => {
      if (stopped) return
      hooks.onLost()
      const delay = OBSERVER_RETRY_MS[Math.min(failures, OBSERVER_RETRY_MS.length - 1)]!
      failures += 1
      retry = setTimeout(connect, delay)
    }
  }
  connect()
  return {
    ready,
    stop: () => {
      stopped = true
      clearTimeout(retry)
      socket?.close()
    },
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// Tabs that sessions open in the shared Chrome stay open after the script that
// opened them exits (engines keep them for the next script), so nothing frees
// their renderers. Each tab is owned by the sessions that opened or attached
// to it, and closes once the last of them ends. Tabs no session opened (the
// operator's own tabs, ones restored at launch) are never tracked or closed.
type TrackedTab = { owners: Set<string>; generation: number }

export class AgentTabRegistry {
  readonly #tabs = new Map<string, TrackedTab>()
  // Released tabs are being closed, but Chrome may still report a popup one of
  // them opened just before; that popup has no live owner either.
  // Keyed by the generation the tab was tracked at, so discovery judges
  // released markers by the same rule as live entries.
  readonly #released = new Map<string, number>()
  // Sessions that attached to a tab before its creator's reply registered it.
  // These never make a tab tracked on their own, so operator and runtime tabs
  // stay out of cleanup; they join the owners if a session created the tab.
  readonly #earlyShares = new Map<string, { owners: Set<string>; generation: number }>()
  readonly #awaitingOpener = new Map<string, string>()
  #generation = 0

  get generation(): number {
    return this.#generation
  }

  created(owner: string, targetId: string): void {
    const tab = this.#tabs.get(targetId)
    if (tab !== undefined) {
      tab.owners.add(owner)
      return
    }
    const owners = new Set([owner, ...(this.#earlyShares.get(targetId)?.owners ?? [])])
    this.#earlyShares.delete(targetId)
    this.#tabs.set(targetId, { owners, generation: ++this.#generation })
  }

  // Attaching to a tracked tab shares it, so handing a tab to another live
  // session keeps it open until that session ends too.
  used(owner: string, targetId: string): void {
    const tab = this.#tabs.get(targetId)
    if (tab !== undefined) {
      tab.owners.add(owner)
      return
    }
    if (this.#released.has(targetId)) return
    const early = this.#earlyShares.get(targetId)
    if (early === undefined)
      this.#earlyShares.set(targetId, { owners: new Set([owner]), generation: ++this.#generation })
    else early.owners.add(owner)
  }

  // A session-created tab whose creator ended before Chrome's reply arrived
  // stays open for the live sessions that already attached to it.
  adoptShared(targetId: string): boolean {
    const early = this.#earlyShares.get(targetId)
    this.#earlyShares.delete(targetId)
    if (early === undefined || early.owners.size === 0) return false
    this.#tabs.set(targetId, { owners: early.owners, generation: ++this.#generation })
    return true
  }

  // A popup or `target=_blank` tab belongs to whoever owns the tab that opened
  // it, plus any session that attached to it first; one with none of those
  // left has no owner to wait for. Chrome may report a popup before its opener
  // is known (discovery order, a late create reply), so it waits for it.
  // Returns the popups, this one and any waiting on it, to close.
  opened(targetId: string, openerId: string): string[] {
    if (this.#tabs.has(targetId) || this.#released.has(targetId)) return []
    const opener = this.#tabs.get(openerId)
    if (opener === undefined && !this.#released.has(openerId)) {
      this.#awaitingOpener.set(targetId, openerId)
      return []
    }
    this.#awaitingOpener.delete(targetId)
    const owners = new Set([...(opener?.owners ?? []), ...(this.#earlyShares.get(targetId)?.owners ?? [])])
    this.#earlyShares.delete(targetId)
    if (owners.size === 0) this.#released.set(targetId, ++this.#generation)
    else this.#tabs.set(targetId, { owners, generation: ++this.#generation })
    return [...(owners.size === 0 ? [targetId] : []), ...this.resolveAwaiting(targetId)]
  }

  resolveAwaiting(openerId: string): string[] {
    const orphans: string[] = []
    for (const [popup, waitingFor] of this.#awaitingOpener) {
      if (waitingFor === openerId) orphans.push(...this.opened(popup, openerId))
    }
    return orphans
  }

  isReleased(targetId: string): boolean {
    return this.#released.has(targetId)
  }

  // A tab a session created after it ended has no owner, but its popups must
  // still be attributable until it is actually closed.
  markReleased(targetId: string): void {
    if (!this.#tabs.has(targetId)) this.#released.set(targetId, ++this.#generation)
  }

  // A live session attached to a released tab before its close was issued.
  reclaim(owner: string, targetId: string): void {
    if (!this.#released.delete(targetId)) return
    this.#tabs.set(targetId, { owners: new Set([owner]), generation: ++this.#generation })
  }

  forget(targetId: string): void {
    this.#tabs.delete(targetId)
    this.#released.delete(targetId)
    this.#earlyShares.delete(targetId)
    this.#awaitingOpener.delete(targetId)
  }

  // Drops tabs Chrome no longer has, so closed tabs stop counting as owned.
  // Only entries tracked at or before `generation` are judged against the list.
  retainOnly(liveTargetIds: ReadonlySet<string>, generation: number): void {
    for (const [targetId, tab] of this.#tabs) {
      if (tab.generation <= generation && !liveTargetIds.has(targetId)) this.#tabs.delete(targetId)
    }
    for (const [targetId, tracked] of this.#released) {
      if (tracked <= generation && !liveTargetIds.has(targetId)) this.#released.delete(targetId)
    }
    for (const [targetId, early] of this.#earlyShares) {
      if (early.generation <= generation && !liveTargetIds.has(targetId)) this.#earlyShares.delete(targetId)
    }
  }

  release(owner: string): string[] {
    for (const [targetId, early] of this.#earlyShares) {
      early.owners.delete(owner)
      if (early.owners.size === 0) this.#earlyShares.delete(targetId)
    }
    const orphaned: string[] = []
    for (const [targetId, tab] of this.#tabs) {
      if (!tab.owners.delete(owner) || tab.owners.size > 0) continue
      this.#tabs.delete(targetId)
      this.#released.set(targetId, tab.generation)
      orphaned.push(targetId)
    }
    return orphaned
  }
}

async function closeTabs(upstreamSocket: string, targetIds: readonly string[]): Promise<number> {
  const results = await Promise.allSettled(
    targetIds.map(async (targetId) => {
      const response = await fetch(`http://127.0.0.1/json/close/${encodeURIComponent(targetId)}`, {
        unix: upstreamSocket,
      } as RequestInit)
      return response.ok
    }),
  )
  return results.filter((result) => result.status === 'fulfilled' && result.value).length
}
