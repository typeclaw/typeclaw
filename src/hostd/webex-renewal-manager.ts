import { createKeyStore, type KeyStore } from '@/secrets/keys'
import { renewAllAccounts, type LoginWithPasswordFn } from '@/secrets/webex-renewal'

import { keysDir } from './paths'

// Webex password-login tokens live ~27h and renewal triggers within 8h of
// expiry (see RENEWAL_WINDOW_MS). A 24h tick like KakaoTalk's would let a token
// cross into the 8h window and expire before the next tick, so Webex ticks
// hourly: short enough to always catch the window, cheap because a fresh token
// short-circuits to a no-op skip.
const DEFAULT_TICK_INTERVAL_MS = 60 * 60 * 1000

export type WebexRenewalCallbacks = {
  start: (input: WebexRenewalStartInput) => void
  stop: (containerName: string) => Promise<void>
  drain: () => Promise<void>
}

export type WebexRenewalStartInput = {
  containerName: string
  cwd: string
}

export type WebexRenewalLogEvent =
  | { kind: 'webex-renewal-tick-start'; containerName: string }
  | { kind: 'webex-renewal-tick-skipped'; containerName: string; reason: string; expiresInMs?: number }
  | { kind: 'webex-renewal-tick-ok'; containerName: string; accountId: string; nextExpiresAt: number }
  | {
      kind: 'webex-renewal-tick-reauth-required'
      containerName: string
      accountId: string
      reason: string
      message: string
    }
  | { kind: 'webex-renewal-tick-transient-failure'; containerName: string; accountId: string; reason: string }
  | { kind: 'webex-renewal-tick-error'; containerName: string; error: string }
  | { kind: 'webex-renewal-restart-scheduled'; containerName: string; accountId: string }
  | { kind: 'webex-renewal-restart-failed'; containerName: string; accountId: string; reason: string }

export type WebexRenewalManagerOptions = {
  onLog?: (event: WebexRenewalLogEvent) => void
  tickIntervalMs?: number
  keyStoreFactory?: () => KeyStore
  loginWithPassword?: LoginWithPasswordFn
  schedule?: (fn: () => void, intervalMs: number) => { stop: () => void }
  // Invoked after a successful renewal so the host can restart the container
  // and the in-memory adapter picks up the fresh token. Without this, the cron
  // writes a new token to secrets.json but the live WebexClient keeps the old
  // token in its `getToken` closure (src/channels/adapters/webex.ts) and still
  // hits 401 on every outbound REST call and KMS key fetch.
  onRenewalOk?: (input: { containerName: string; cwd: string; accountId: string }) => Promise<void>
  // Only start the renewal cron for containers whose typeclaw.json actually has
  // a channels.webex block, so non-webex agents don't emit hourly no_account
  // skip logs.
  shouldRenew?: (input: WebexRenewalStartInput) => boolean
}

export function createWebexRenewalManager(opts: WebexRenewalManagerOptions = {}): WebexRenewalCallbacks {
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
  const latestInput = new Map<string, WebexRenewalStartInput>()
  const inFlight = new Map<string, Promise<void>>()
  const pendingRerun = new Set<string>()

  const runTick = async (input: WebexRenewalStartInput): Promise<void> => {
    log({ kind: 'webex-renewal-tick-start', containerName: input.containerName })
    try {
      const results = await renewAllAccounts({
        containerName: input.containerName,
        agentDir: input.cwd,
        keyStore,
        ...(opts.loginWithPassword ? { loginWithPassword: opts.loginWithPassword } : {}),
      })
      for (const result of results) {
        if (result.kind === 'skipped') {
          log({
            kind: 'webex-renewal-tick-skipped',
            containerName: input.containerName,
            reason: result.reason,
            ...(result.expiresInMs !== undefined ? { expiresInMs: result.expiresInMs } : {}),
          })
        } else if (result.kind === 'ok') {
          log({
            kind: 'webex-renewal-tick-ok',
            containerName: input.containerName,
            accountId: result.account_id,
            nextExpiresAt: result.nextExpiresAt,
          })
          // A tick that started before stop()/drain() (deregister, shutdown) or
          // before a re-register with a different cwd can finish the slow login
          // here. Restarting a container that is no longer the current
          // registration would resurrect a just-deregistered agent or fight a
          // shutdown, so skip onRenewalOk unless this container+cwd is still the
          // live registration.
          const current = latestInput.get(input.containerName)
          if (opts.onRenewalOk && current?.cwd === input.cwd) {
            log({
              kind: 'webex-renewal-restart-scheduled',
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
                kind: 'webex-renewal-restart-failed',
                containerName: input.containerName,
                accountId: result.account_id,
                reason: err instanceof Error ? err.message : String(err),
              })
            }
          }
        } else if (result.kind === 'reauth_required') {
          log({
            kind: 'webex-renewal-tick-reauth-required',
            containerName: input.containerName,
            accountId: result.account_id,
            reason: result.reason,
            message: result.message,
          })
        } else {
          log({
            kind: 'webex-renewal-tick-transient-failure',
            containerName: input.containerName,
            accountId: result.account_id,
            reason: result.reason,
          })
        }
      }
    } catch (err) {
      log({
        kind: 'webex-renewal-tick-error',
        containerName: input.containerName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const scheduleTick = (containerName: string): Promise<void> => {
    const existing = inFlight.get(containerName)
    if (existing) {
      pendingRerun.add(containerName)
      return existing
    }
    const promise = (async () => {
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
    start(input: WebexRenewalStartInput): void {
      // Tear down any prior registration for this container BEFORE the
      // shouldRenew gate. The daemon calls start() on every registration, so a
      // container that had Webex can re-register to a non-Webex cwd; if we
      // returned early without clearing, the old timer would keep ticking and a
      // post-login restart guard would still match the stale cwd. Clearing
      // latestInput also makes an in-flight tick's onRenewalOk re-check fail.
      const existing = timers.get(input.containerName)
      if (existing) {
        existing.stop()
        timers.delete(input.containerName)
      }
      latestInput.delete(input.containerName)

      if (opts.shouldRenew && !opts.shouldRenew(input)) return

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
