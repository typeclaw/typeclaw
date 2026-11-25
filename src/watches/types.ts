import type { SessionOrigin } from '@/agent/session-origin'
import type { ResolveGithubTokenForRepo } from '@/channels/github-token-bridge'
import type { AdapterId } from '@/channels/schema'
import type { ChannelKey } from '@/channels/types'

// What one probe run decided. `done` ends the watch; `wake` (or `done` with
// `wake: true`) starts one LLM turn on the watch's wake target with `summary`.
export type WatchVerdict = {
  verdict: 'quiet' | 'wake' | 'done'
  wake?: boolean
  summary?: string
  // Hint for the next run, clamped by the scheduler.
  nextMs?: number
}

// Where a wake lands. Stored durably on the watch, never a live session id for
// channels: the conversation may have rolled over or gone idle by the time the
// wake fires.
export type WatchWakeTarget =
  | {
      kind: 'channel'
      key: ChannelKey
      // The human whose request created the watch. The wake is authored as
      // them so the router re-resolves their current role at wake time.
      requester: { authorId: string; authorAdapter: AdapterId; authorName?: string }
    }
  | { kind: 'tui'; sessionId: string }
  // No human origin (a pure cron run): the wake starts a fresh slim session.
  | { kind: 'fresh' }

export type WatchWake = {
  watchId: string
  description: string
  summary: string
  final: boolean
}

export type WatchWakeDeliveryResult = 'delivered' | 'held' | 'failed'

export type WatchWakeDelivery = (
  target: WatchWakeTarget,
  wakes: readonly WatchWake[],
  origin: SessionOrigin,
) => Promise<WatchWakeDeliveryResult>

// Trusted in-process probe shipped with TypeClaw. It never shells out; state is
// an opaque JSON value the runtime persists between runs.
export type BundledProbeContext<P> = {
  params: P
  state: unknown
  lastRunAt: number | undefined
  resolveTokenForRepo: ResolveGithubTokenForRepo
  signal: AbortSignal
  fetch: typeof fetch
}

export type BundledProbeResult = WatchVerdict & { state: unknown }

export type BundledProbe<P = unknown> = {
  readonly kind: string
  parseParams: (raw: unknown) => P
  describe: (params: P) => string
  run: (ctx: BundledProbeContext<P>) => Promise<BundledProbeResult>
}
