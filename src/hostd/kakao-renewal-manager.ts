import { renewAllAccounts, type AttemptLoginFn } from '@/secrets/kakao-renewal'
import { createKeyStore, type KeyStore } from '@/secrets/keys'

import { keysDir } from './paths'

const DEFAULT_TICK_INTERVAL_MS = 24 * 60 * 60 * 1000

export type KakaoRenewalCallbacks = {
  start: (input: KakaoRenewalStartInput) => void
  stop: (containerName: string) => Promise<void>
  drain: () => Promise<void>
}

export type KakaoRenewalStartInput = {
  containerName: string
  cwd: string
}

export type KakaoRenewalLogEvent =
  | { kind: 'kakao-renewal-tick-start'; containerName: string }
  | { kind: 'kakao-renewal-tick-skipped'; containerName: string; reason: string; ageMs?: number }
  | { kind: 'kakao-renewal-tick-ok'; containerName: string; accountId: string; previousUpdatedAt: string }
  | {
      kind: 'kakao-renewal-tick-reauth-required'
      containerName: string
      accountId: string
      reason: string
      message: string
    }
  | { kind: 'kakao-renewal-tick-transient-failure'; containerName: string; accountId: string; reason: string }
  | { kind: 'kakao-renewal-tick-error'; containerName: string; error: string }
  | { kind: 'kakao-renewal-restart-scheduled'; containerName: string; accountId: string }
  | { kind: 'kakao-renewal-restart-failed'; containerName: string; accountId: string; reason: string }

export type KakaoRenewalManagerOptions = {
  onLog?: (event: KakaoRenewalLogEvent) => void
  tickIntervalMs?: number
  keyStoreFactory?: () => KeyStore
  attemptLogin?: AttemptLoginFn
  schedule?: (fn: () => void, intervalMs: number) => { stop: () => void }
  // Invoked after a successful renewal so the host can restart the container
  // and the in-memory adapter picks up the fresh tokens. Without this, the
  // cron writes new tokens to secrets.json but the live LOCO client keeps the
  // old token in its closure and still hits 401 at the ~7-day wall. Production
  // wires this to the same restart path the `restart` RPC uses; tests can
  // observe it via a fake.
  onRenewalOk?: (input: { containerName: string; cwd: string; accountId: string }) => Promise<void>
  // Optional predicate: only start the renewal cron for containers whose
  // `typeclaw.json` actually has a `channels.kakaotalk` block. Without this,
  // every typeclaw agent on the host emits daily `no_account` skip logs.
  shouldRenew?: (input: KakaoRenewalStartInput) => boolean
}

// Per-container daily renewal tick. Mirrors portbroker-manager.ts: hostd calls
// start() on register and stop() on deregister, and the manager owns timer
// lifecycle plus the actual renewal work. The keystore lives on the host
// (~/.typeclaw/keys/<name>.key), unreachable from inside the container —
// that's load-bearing for encryption.ts's threat model.
export function createKakaoRenewalManager(opts: KakaoRenewalManagerOptions = {}): KakaoRenewalCallbacks {
  const intervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
  const keyStore = (opts.keyStoreFactory ?? (() => createKeyStore({ keysDir: keysDir() })))()
  const log = opts.onLog ?? (() => {})
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms)
      return { stop: () => clearInterval(handle) }
    })

  const timers = new Map<string, { stop: () => void }>()
  // Track the latest registration input per container so a re-register
  // arriving during an in-flight tick can both (a) prevent the in-flight tick
  // from acting on stale cwd, and (b) trigger a fresh tick once the in-flight
  // one finishes. The Map's value is the most recent input.
  const latestInput = new Map<string, KakaoRenewalStartInput>()
  // Track in-flight tick promises per container so stop()/drain() can await
  // them. Without this, daemon shutdown abandons an in-flight attemptLogin
  // HTTPS request mid-write.
  const inFlight = new Map<string, Promise<void>>()
  // Pending immediate-tick request: set when start() is called while a tick
  // is in flight, so we re-fire one tick after the in-flight settles.
  const pendingRerun = new Set<string>()

  const runTick = async (input: KakaoRenewalStartInput): Promise<void> => {
    log({ kind: 'kakao-renewal-tick-start', containerName: input.containerName })
    try {
      const results = await renewAllAccounts({
        containerName: input.containerName,
        agentDir: input.cwd,
        keyStore,
        ...(opts.attemptLogin ? { attemptLogin: opts.attemptLogin } : {}),
      })
      for (const result of results) {
        if (result.kind === 'skipped') {
          log({
            kind: 'kakao-renewal-tick-skipped',
            containerName: input.containerName,
            reason: result.reason,
            ...(result.ageMs !== undefined ? { ageMs: result.ageMs } : {}),
          })
        } else if (result.kind === 'ok') {
          log({
            kind: 'kakao-renewal-tick-ok',
            containerName: input.containerName,
            accountId: result.account_id,
            previousUpdatedAt: result.previousUpdatedAt,
          })
          if (opts.onRenewalOk) {
            log({
              kind: 'kakao-renewal-restart-scheduled',
              containerName: input.containerName,
              accountId: result.account_id,
            })
            try {
              await opts.onRenewalOk({
                containerName: input.containerName,
                cwd: input.cwd,
                accountId: result.account_id,
              })
            } catch (err) {
              log({
                kind: 'kakao-renewal-restart-failed',
                containerName: input.containerName,
                accountId: result.account_id,
                reason: err instanceof Error ? err.message : String(err),
              })
            }
          }
        } else if (result.kind === 'reauth_required') {
          log({
            kind: 'kakao-renewal-tick-reauth-required',
            containerName: input.containerName,
            accountId: result.account_id,
            reason: result.reason,
            message: result.message,
          })
        } else {
          log({
            kind: 'kakao-renewal-tick-transient-failure',
            containerName: input.containerName,
            accountId: result.account_id,
            reason: result.reason,
          })
        }
      }
    } catch (err) {
      // Defensive: renewCurrentAccount's contract is to return a structured
      // result, but a malformed secrets.json or a disk error could surface
      // here. Log and move on — the next tick retries.
      log({
        kind: 'kakao-renewal-tick-error',
        containerName: input.containerName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Single-flight per container: dedupe overlapping ticks, but if a new
  // tick request arrives while one is in flight, queue ONE rerun so the new
  // registration's cwd (or a manual nudge) gets a chance after the in-flight
  // settles. The Promise stored in inFlight resolves only after any queued
  // rerun also completes, so stop()/drain() awaiting inFlight is enough to
  // observe a quiescent manager.
  const scheduleTick = (containerName: string): Promise<void> => {
    const existing = inFlight.get(containerName)
    if (existing) {
      pendingRerun.add(containerName)
      return existing
    }
    const promise = (async () => {
      // Loop until no rerun was queued during this tick, so the LAST input
      // recorded for the container is the one we end on. This handles the
      // re-register-while-in-flight + cwd-change case described in the
      // pendingRerun comment above.
      while (true) {
        const input = latestInput.get(containerName)
        if (!input) return
        await runTick(input)
        if (!pendingRerun.has(containerName)) return
        pendingRerun.delete(containerName)
      }
    })().finally(() => {
      inFlight.delete(containerName)
      pendingRerun.delete(containerName)
    })
    inFlight.set(containerName, promise)
    return promise
  }

  return {
    start(input: KakaoRenewalStartInput): void {
      if (opts.shouldRenew && !opts.shouldRenew(input)) return
      const existing = timers.get(input.containerName)
      if (existing) existing.stop()
      latestInput.set(input.containerName, input)
      const handle = schedule(() => {
        void scheduleTick(input.containerName)
      }, intervalMs)
      timers.set(input.containerName, handle)
      void scheduleTick(input.containerName)
    },

    async stop(containerName: string): Promise<void> {
      const handle = timers.get(containerName)
      if (handle) {
        timers.delete(containerName)
        handle.stop()
      }
      latestInput.delete(containerName)
      // Await any in-flight tick before resolving so the caller can rely on
      // "stop returned → no work outstanding". Daemon shutdown depends on
      // this; without it, a mid-tick `attemptLogin` HTTPS call is abandoned.
      const promise = inFlight.get(containerName)
      if (promise) await promise.catch(() => {})
    },

    async drain(): Promise<void> {
      for (const [, handle] of timers) handle.stop()
      timers.clear()
      latestInput.clear()
      const promises = Array.from(inFlight.values())
      await Promise.allSettled(promises)
    },
  }
}
