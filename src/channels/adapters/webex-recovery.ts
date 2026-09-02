import { describeError } from '../describe-error'
import { resolveWebexBodyText } from './webex-format'
import { toRef } from './webex-id-ref'
import { createWebexPrefetchLimiter, type WebexPrefetchLimiter } from './webex-prefetch-limiter'

export const WEBEX_RECOVERY_SPACE_CAP = 100
export const WEBEX_RECOVERY_MESSAGE_CAP = 100
export const WEBEX_RECOVERY_MAX_BATCH = WEBEX_RECOVERY_SPACE_CAP * WEBEX_RECOVERY_MESSAGE_CAP
// Mercury heartbeat detection can trail the actual socket loss by a few seconds;
// overlap that blind edge and let stable-ref dedupe absorb the intentional replay.
export const WEBEX_RECOVERY_OVERLAP_MS = 5_000
export const WEBEX_RECOVERY_DEDUPE_CAPACITY = WEBEX_RECOVERY_MAX_BATCH + WEBEX_RECOVERY_MESSAGE_CAP
export const WEBEX_RECOVERY_RETRY_DELAYS_MS = [1_000, 5_000] as const
export const WEBEX_RECOVERY_ATTEMPT_TIMEOUT_MS = 30_000
export const WEBEX_RECOVERY_LIVE_GATE_CAPACITY = 1_000

export type WebexRecoverySpace = {
  id: string
  type: 'direct' | 'group'
  lastActivity?: string
}

export type WebexRecoveryMessage = {
  id: string
  ref: string
  roomId: string
  roomRef: string
  roomType: 'direct' | 'group'
  personId: string
  personRef: string
  personEmail: string
  text?: string
  markdown?: string
  html?: string
  created: string
  parentId?: string
  parentRef?: string
  files?: string[]
  mentionedPeople?: string[]
  mentionedPeopleRefs?: string[]
  mentionedGroups?: string[]
}

export type WebexInboundRecord = {
  id: string
  ref: string
  roomId: string
  roomRef: string
  roomType?: string
  personId: string
  personRef: string
  personEmail: string
  text: string
  created: string
  parentId?: string
  parentRef?: string
  mentionedPeople: string[]
  mentionedPeopleRefs: string[]
  mentionedGroups: string[]
  files: string[]
  raw: unknown
}

export type WebexConnectionInfo = {
  connected: boolean
  status: {
    status: string
    webSocketOpen: boolean
  }
}

type RecoveryClient = {
  listSpaces: (options?: { type?: string; max?: number }) => Promise<WebexRecoverySpace[]>
  listMessages: (roomId: string, options?: { max?: number }) => Promise<WebexRecoveryMessage[]>
}

type RecoveryLogger = { warn: (message: string) => void }
type RecoveryDelay = (ms: number) => Promise<void>
type RecoveryTimeoutScheduler = (ms: number, onTimeout: () => void) => () => void
type AttemptGate = {
  promise: Promise<void>
  pending: number
  abort: (error: Error) => void
  interrupt: () => void
}
type AttemptToken = { version: number; cancelled: boolean }
type RecoveryEpisode = { protectedRefs: ReadonlySet<string>; refs: BoundedRefSet }
type AttemptOutcome =
  | { kind: 'success' }
  | { kind: 'interrupted' }
  | { kind: 'stale' }
  | { kind: 'deferred'; error: unknown }
  | { kind: 'failed'; error: unknown }

export type WebexRecoveryTuning = {
  now?: () => number
  overlapMs?: number
  dedupeCapacity?: number
  retryDelaysMs?: readonly number[]
  delay?: RecoveryDelay
  attemptTimeoutMs?: number
  scheduleTimeout?: RecoveryTimeoutScheduler
  liveGateCapacity?: number
}

export type WebexRecovery = {
  markDisconnected: (at?: number) => void
  recover: () => Promise<void>
  routeLive: (message: WebexInboundRecord) => Promise<void>
  stop: () => void
  finishStop: () => Promise<void>
}

export type WebexInboundHandleOutcome = 'committed' | 'retryable'

type ClaimOwner = symbol

export type WebexRecoveryState = {
  readonly dedupeCapacity: number
  restoreGap: (start: number) => void
  claimGap: () => number | null
  hasGap: () => boolean
  hasRef: (ref: string) => boolean
  claimRef: (ref: string, owner: ClaimOwner) => boolean
  commitRef: (ref: string, owner: ClaimOwner) => void
  releaseRef: (ref: string, owner: ClaimOwner) => void
  releaseOwner: (owner: ClaimOwner) => void
  refSnapshot: () => readonly string[]
  lingeringRead: () => Promise<void> | null
  trackLingeringRead: (read: Promise<void>) => void
  clear: () => void
}

export function createWebexRecoveryState(options: { dedupeCapacity?: number } = {}): WebexRecoveryState {
  const dedupeCapacity = Math.max(1, Math.floor(options.dedupeCapacity ?? WEBEX_RECOVERY_DEDUPE_CAPACITY))
  const recentRefs = new BoundedRefSet(dedupeCapacity)
  const claimCapacity = WEBEX_RECOVERY_MAX_BATCH + WEBEX_RECOVERY_LIVE_GATE_CAPACITY
  const claims = new Map<string, ClaimOwner>()
  let pendingGapStart: number | null = null
  let lingeringRead: Promise<void> | null = null
  return {
    dedupeCapacity,
    restoreGap(start): void {
      pendingGapStart = pendingGapStart === null ? start : Math.min(pendingGapStart, start)
    },
    claimGap(): number | null {
      const start = pendingGapStart
      pendingGapStart = null
      return start
    },
    hasGap: () => pendingGapStart !== null,
    hasRef: (ref) => recentRefs.has(ref),
    claimRef(ref, owner): boolean {
      if (recentRefs.has(ref) || claims.has(ref) || claims.size >= claimCapacity) return false
      claims.set(ref, owner)
      return true
    },
    commitRef(ref, owner): void {
      if (claims.get(ref) !== owner) return
      claims.delete(ref)
      recentRefs.reserve(ref)
    },
    releaseRef(ref, owner): void {
      if (claims.get(ref) === owner) claims.delete(ref)
    },
    releaseOwner(owner): void {
      for (const [ref, claimedBy] of claims) {
        if (claimedBy === owner) claims.delete(ref)
      }
    },
    refSnapshot: () => [...recentRefs.values()],
    lingeringRead: () => lingeringRead,
    trackLingeringRead(read): void {
      lingeringRead = read
      void read.finally(() => {
        if (lingeringRead === read) lingeringRead = null
      })
    },
    clear(): void {
      pendingGapStart = null
      recentRefs.clear()
      claims.clear()
      lingeringRead = null
    },
  }
}

export function isAuthoritativeWebexConnection(info: WebexConnectionInfo): boolean {
  return info.connected && info.status.status === 'connected' && info.status.webSocketOpen
}

export function createWebexRecovery(
  options: WebexRecoveryTuning & {
    client: RecoveryClient
    handleMessage: (message: WebexInboundRecord) => Promise<WebexInboundHandleOutcome>
    isCurrent: () => boolean
    isConnected: () => boolean
    logger: RecoveryLogger
    limiter?: WebexPrefetchLimiter
    groupMessagesMentionSelfRef?: () => string | null
    logPrefix?: string
    state?: WebexRecoveryState
  },
): WebexRecovery {
  const now = options.now ?? Date.now
  const overlapMs = options.overlapMs ?? WEBEX_RECOVERY_OVERLAP_MS
  const logPrefix = options.logPrefix ?? 'webex'
  const retryDelaysMs = options.retryDelaysMs ?? WEBEX_RECOVERY_RETRY_DELAYS_MS
  const delay = options.delay ?? defaultDelay
  const attemptTimeoutMs = options.attemptTimeoutMs ?? WEBEX_RECOVERY_ATTEMPT_TIMEOUT_MS
  const scheduleTimeout = options.scheduleTimeout ?? defaultScheduleTimeout
  const liveGateCapacity = Math.max(1, Math.floor(options.liveGateCapacity ?? WEBEX_RECOVERY_LIVE_GATE_CAPACITY))
  const limiter = options.limiter ?? createWebexPrefetchLimiter()
  const state = options.state ?? createWebexRecoveryState({ dedupeCapacity: options.dedupeCapacity })
  const dedupeCapacity = state.dedupeCapacity
  let interruptionVersion = 0
  let flight: Promise<void> | null = null
  let activeGate: AttemptGate | null = null
  let episode: RecoveryEpisode | null = null
  let claimedGapStart: number | null = null
  let stopped = false
  let stopFinished = false
  let inflightClaimHandlers = 0
  let claimHandlerWaiters: Array<() => void> = []
  const claimOwner: ClaimOwner = Symbol('webex-recovery')

  const isCurrent = (): boolean => !stopped && options.isCurrent()

  const claim = (ref: string): boolean => {
    if (episode?.protectedRefs.has(ref) === true || episode?.refs.has(ref) === true || state.hasRef(ref)) return false
    return state.claimRef(ref, claimOwner)
  }

  const restoreMessageGap = (message: WebexInboundRecord): void => {
    const createdAt = Date.parse(message.created)
    state.restoreGap((Number.isFinite(createdAt) ? createdAt : now()) - overlapMs)
  }

  const handleClaimed = async (message: WebexInboundRecord): Promise<WebexInboundHandleOutcome> => {
    inflightClaimHandlers++
    try {
      if (!isCurrent()) {
        state.releaseRef(message.ref, claimOwner)
        restoreMessageGap(message)
        return 'retryable'
      }
      let outcome: WebexInboundHandleOutcome
      try {
        outcome = await options.handleMessage(message)
      } catch (error) {
        options.logger.warn(
          `[${logPrefix}] inbound id=${message.ref} failed before dedupe commit: ${describeError(error)}`,
        )
        outcome = 'retryable'
      }
      if (outcome === 'committed') {
        state.commitRef(message.ref, claimOwner)
        episode?.refs.reserve(message.ref)
      } else {
        state.releaseRef(message.ref, claimOwner)
        restoreMessageGap(message)
      }
      return outcome
    } finally {
      inflightClaimHandlers--
      if (inflightClaimHandlers === 0 && claimHandlerWaiters.length > 0) {
        const waiters = claimHandlerWaiters
        claimHandlerWaiters = []
        for (const waiter of waiters) waiter()
      }
    }
  }

  const routeLive = (message: WebexInboundRecord): Promise<void> => {
    if (!isCurrent()) return Promise.resolve()
    const gate = activeGate
    if (gate === null) {
      if (!claim(message.ref)) return Promise.resolve()
      return handleClaimed(message).then(() => undefined)
    }
    if (gate.pending >= liveGateCapacity) {
      gate.abort(new Error(`live gate reached cap=${liveGateCapacity}`))
    } else {
      gate.pending++
    }
    return gate.promise
      .then(async () => {
        if (!isCurrent() || !claim(message.ref)) return
        await handleClaimed(message)
      })
      .then(() => undefined)
  }

  const lifecycleCheckpoint = (version: number): 'ok' | 'interrupted' | 'stale' => {
    if (!isCurrent()) return 'stale'
    if (!options.isConnected() || interruptionVersion !== version) return 'interrupted'
    return 'ok'
  }

  const checkpoint = (token: AttemptToken): 'ok' | 'interrupted' | 'stale' =>
    token.cancelled ? 'stale' : lifecycleCheckpoint(token.version)

  const runAttemptWork = async (start: number, end: number, token: AttemptToken): Promise<AttemptOutcome> => {
    try {
      const spaces = await options.client.listSpaces({ max: WEBEX_RECOVERY_SPACE_CAP })
      const afterSpaces = checkpoint(token)
      if (afterSpaces !== 'ok') return { kind: afterSpaces }
      if (spaces.length >= WEBEX_RECOVERY_SPACE_CAP) {
        options.logger.warn(
          `[${logPrefix}] reconnect recovery spaces truncated at cap=${WEBEX_RECOVERY_SPACE_CAP}; recovery may be partial`,
        )
      }

      const recovered: Array<{ message: WebexInboundRecord; createdAt: number }> = []
      for (const space of spaces.slice(0, WEBEX_RECOVERY_SPACE_CAP)) {
        const beforeRoom = checkpoint(token)
        if (beforeRoom !== 'ok') return { kind: beforeRoom }
        const lastActivity = Date.parse(space.lastActivity ?? '')
        if (!Number.isFinite(lastActivity) || lastActivity < start) continue

        let outcome: { admitted: true; value: WebexRecoveryMessage[] } | { admitted: false }
        try {
          outcome = await limiter.run(toRef(space.id), () =>
            options.client.listMessages(space.id, { max: WEBEX_RECOVERY_MESSAGE_CAP }),
          )
        } catch (error) {
          const afterFailure = checkpoint(token)
          if (afterFailure !== 'ok') return { kind: afterFailure }
          return { kind: 'failed', error: new Error(`room=${space.id} read failed: ${describeError(error)}`) }
        }
        const afterRoom = checkpoint(token)
        if (afterRoom !== 'ok') return { kind: afterRoom }
        if (!outcome.admitted) {
          return { kind: 'failed', error: new Error(`room=${space.id} limiter admission timed out`) }
        }
        if (outcome.value.length >= WEBEX_RECOVERY_MESSAGE_CAP) {
          options.logger.warn(
            `[${logPrefix}] reconnect recovery room=${space.id} messages truncated at cap=${WEBEX_RECOVERY_MESSAGE_CAP}; recovery may be partial`,
          )
        }
        for (const message of outcome.value.slice(0, WEBEX_RECOVERY_MESSAGE_CAP)) {
          const createdAt = Date.parse(message.created)
          if (!Number.isFinite(createdAt) || createdAt < start || createdAt > end) continue
          recovered.push({
            message: normalizeRecoveredMessage(message, space.type, options.groupMessagesMentionSelfRef),
            createdAt,
          })
        }
      }

      recovered.sort((a, b) => a.createdAt - b.createdAt)
      for (const { message } of recovered) {
        const beforeRoute = checkpoint(token)
        if (beforeRoute !== 'ok') return { kind: beforeRoute }
        if (!claim(message.ref)) continue
        const handled = await handleClaimed(message)
        if (handled === 'retryable') {
          return { kind: 'failed', error: new Error(`inbound id=${message.ref} was not handled`) }
        }
        const afterRoute = checkpoint(token)
        if (afterRoute !== 'ok') return { kind: afterRoute }
      }
      return { kind: 'success' }
    } catch (error) {
      const state = checkpoint(token)
      return state === 'ok' ? { kind: 'failed', error } : { kind: state }
    }
  }

  const runAttempt = async (start: number, end: number, version: number): Promise<AttemptOutcome> => {
    const token: AttemptToken = { version, cancelled: false }
    const released = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<AttemptOutcome>()
    let settled = false
    const gate: AttemptGate = {
      promise: released.promise,
      pending: 0,
      abort(error): void {
        if (settled) return
        settled = true
        token.cancelled = true
        if (activeGate === gate) activeGate = null
        released.resolve()
        aborted.resolve({ kind: 'deferred', error })
      },
      interrupt(): void {
        if (settled) return
        settled = true
        token.cancelled = true
        if (activeGate === gate) activeGate = null
        released.resolve()
        aborted.resolve({ kind: 'interrupted' })
      },
    }
    activeGate = gate
    const cancelTimeout = scheduleTimeout(attemptTimeoutMs, () => {
      gate.abort(new Error(`attempt timed out after ${attemptTimeoutMs}ms`))
    })
    const work = runAttemptWork(start, end, token)
    try {
      const outcome = await Promise.race([work, aborted.promise])
      if (outcome.kind === 'deferred' || outcome.kind === 'interrupted') {
        state.trackLingeringRead(work.then(() => undefined))
      }
      return outcome
    } finally {
      settled = true
      cancelTimeout()
      if (activeGate === gate) activeGate = null
      released.resolve()
    }
  }

  const drain = async (): Promise<void> => {
    while (isCurrent() && options.isConnected() && state.hasGap()) {
      const lingeringRead = state.lingeringRead()
      if (lingeringRead !== null) {
        await lingeringRead
        continue
      }
      episode ??= {
        protectedRefs: new Set(state.refSnapshot()),
        refs: new BoundedRefSet(WEBEX_RECOVERY_MAX_BATCH + dedupeCapacity),
      }
      const start = state.claimGap()
      if (start === null) break
      claimedGapStart = start
      const end = now()
      let completed = false

      for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
        const version = interruptionVersion
        const outcome = await runAttempt(start, end, version)
        if (outcome.kind === 'stale') return
        if (outcome.kind === 'interrupted') {
          state.restoreGap(start)
          claimedGapStart = null
          break
        }
        if (outcome.kind === 'success') {
          completed = true
          claimedGapStart = null
          break
        }
        if (outcome.kind === 'deferred') {
          state.restoreGap(start)
          claimedGapStart = null
          options.logger.warn(
            `[${logPrefix}] reconnect recovery deferred: ${describeError(outcome.error)}; gap retained for a future reconnect`,
          )
          return
        }

        options.logger.warn(
          `[${logPrefix}] reconnect recovery attempt=${attempt + 1}/${retryDelaysMs.length + 1} failed: ${describeError(outcome.error)}`,
        )
        const retryDelay = retryDelaysMs[attempt]
        if (retryDelay === undefined) {
          state.restoreGap(start)
          claimedGapStart = null
          options.logger.warn(
            `[${logPrefix}] reconnect recovery exhausted after ${retryDelaysMs.length + 1} attempts; gap retained for a future reconnect`,
          )
          return
        }
        await delay(retryDelay)
        const afterDelay = lifecycleCheckpoint(version)
        if (afterDelay === 'stale') return
        if (afterDelay === 'interrupted') {
          state.restoreGap(start)
          claimedGapStart = null
          break
        }
      }

      if (!completed && !options.isConnected()) return
    }

    if (!state.hasGap()) episode = null
  }

  const recover = (): Promise<void> => {
    if (flight !== null) return flight
    if (!isCurrent() || !options.isConnected() || !state.hasGap()) {
      return Promise.resolve()
    }
    const lingeringRead = state.lingeringRead()
    if (lingeringRead !== null) return lingeringRead.then(() => recover())
    const running = drain()
    let tracked: Promise<void>
    tracked = running.finally(() => {
      if (flight === tracked) flight = null
      if (!isCurrent()) episode = null
    })
    flight = tracked
    return tracked
  }

  return {
    markDisconnected(at = now()): void {
      interruptionVersion++
      state.restoreGap(at - overlapMs)
      activeGate?.interrupt()
    },

    recover,

    routeLive,

    stop(): void {
      if (stopped) return
      stopped = true
      interruptionVersion++
      if (claimedGapStart !== null) {
        state.restoreGap(claimedGapStart)
        claimedGapStart = null
      }
      activeGate?.interrupt()
      episode = null
    },

    async finishStop(): Promise<void> {
      if (stopFinished) return
      if (inflightClaimHandlers > 0) {
        await new Promise<void>((resolve) => {
          claimHandlerWaiters.push(resolve)
        })
      }
      state.releaseOwner(claimOwner)
      stopFinished = true
    },
  }
}

function normalizeRecoveredMessage(
  message: WebexRecoveryMessage,
  roomType: WebexRecoverySpace['type'],
  groupMessagesMentionSelfRef: (() => string | null) | undefined,
): WebexInboundRecord {
  const selfRef = roomType === 'group' ? (groupMessagesMentionSelfRef?.() ?? null) : null
  return {
    ...message,
    roomType,
    text: resolveWebexBodyText(message),
    mentionedPeople: message.mentionedPeople ?? [],
    mentionedPeopleRefs: message.mentionedPeopleRefs ?? (selfRef === null ? [] : [selfRef]),
    mentionedGroups: message.mentionedGroups ?? [],
    files: message.files ?? [],
    raw: message,
  }
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defaultScheduleTimeout(ms: number, onTimeout: () => void): () => void {
  const timer = setTimeout(onTimeout, ms)
  return () => clearTimeout(timer)
}

class BoundedRefSet {
  private readonly refs = new Set<string>()

  constructor(private readonly capacity: number) {}

  has(ref: string): boolean {
    return this.refs.has(ref)
  }

  values(): IterableIterator<string> {
    return this.refs.values()
  }

  clear(): void {
    this.refs.clear()
  }

  reserve(ref: string): void {
    if (this.refs.delete(ref)) this.refs.add(ref)
    else this.refs.add(ref)
    while (this.refs.size > this.capacity) {
      const oldest = this.refs.values().next().value
      if (oldest === undefined) break
      this.refs.delete(oldest)
    }
  }
}
