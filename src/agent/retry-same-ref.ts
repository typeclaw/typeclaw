import type { AgentSession } from './index'
import { isRetryableSameRef, isThrottleOrOverload, subscribeProviderErrors } from './provider-error'

// Same-ref retry policy. Conservative on purpose: the pi-ai provider layer ALSO
// retries transport/5xx blips underneath us (WebSocket→SSE fallback + its own
// SSE retry loop), and each typeclaw attempt is bounded by the observer timeouts
// (TTFB 15s / idle 120s / overall 300s). Stacking a large per-ref retry count on
// top of that turns one outage into minutes of dead air, so we replay the same
// ref just ONCE by default and rely on cross-ref fallback for anything the single
// replay can't clear.
export const RETRIES_PER_REF = 1
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 5_000

// How much added latency a call site can absorb before the caller would rather
// see a failure. Deliberately NOT the model-profile name: the retry layer cares
// about latency tolerance, not which tier the operator configured. 'responsive'
// is every interactive path (channel chat, TUI, slash commands, multimodal
// look-at); 'patient' is a background path where a human is already waiting
// minutes for a considered answer. Today the only producer of 'patient' is a
// subagent whose REQUESTED profile is `deep` (reviewer, researcher) — see
// subagents.ts. Cron does NOT flow through here: it rebuilds a fresh session per
// attempt via promptWithFallback (model-fallback.ts), so a capacity wait can't
// push one scheduled run into the next.
export type RetryPolicy = 'responsive' | 'patient'

// Capacity backoff, used ONLY for throttle/overload and ONLY on the last usable
// ref. Kept separate from retryBackoffMs above on purpose: that curve (1–5s) is
// sized for a one-off socket blip, and widening it globally would add dead air
// to ordinary network errors too.
//
// Overload is normally handled by failing OVER (isRetryableSameRef excludes it),
// so this curve only exists for the case where there is no other ref to reach:
// a single-ref chain, or the tail of an exhausted one. Both policies get a
// curve; they differ in how long the caller can stand to wait.
//
// 'patient': nominal 10s, 20s, 30s, 30s, 30s, 30s (±20% jitter), so six retries
// span roughly 120–180s and place the last attempt late enough to outlive a
// two-minute blip.
export const PATIENT_OVERLOAD_RETRIES = 6
const PATIENT_OVERLOAD_BASE_MS = 10_000
const PATIENT_OVERLOAD_CAP_MS = 30_000
// Ceiling on when the LAST retry may START, not a hard wall on total elapsed
// time: an attempt already in flight still runs to the observer's own 300s
// overall deadline. The pathological upper bound is therefore ~8m, comfortably
// inside the 30m reviewer/researcher spawn timeout.
export const PATIENT_OVERLOAD_WINDOW_MS = 180_000

// 'responsive': nominal 5s then 10s (±20% jitter), so two retries add at most
// ~18s of scheduled waiting. Sized against a LIVE chat turn, where the channel
// is already showing a typing indicator: short enough to read as thinking rather
// than as a hang (and far inside the 120s typing-silence cap), long enough to
// clear the intermittent capacity dips that make up the common case — the
// incident that motivated this saw ~14% of turns fail while 85% succeeded around
// them, so most single failures had a healthy provider seconds later.
//
// It deliberately does NOT try to outlive a sustained multi-minute outage. That
// is what failing over to another ref is for; when no such ref exists, surfacing
// the notice a few seconds later beats holding a chat thread for minutes.
export const RESPONSIVE_OVERLOAD_RETRIES = 2
const RESPONSIVE_OVERLOAD_BASE_MS = 5_000
const RESPONSIVE_OVERLOAD_CAP_MS = 10_000
export const RESPONSIVE_OVERLOAD_WINDOW_MS = 25_000

// Proportional (±20%) rather than full jitter: full jitter can return ~0ms,
// which against a capacity outage means retrying instantly into the same wall.
// The floor keeps every wait meaningful while still decorrelating concurrent
// callers recovering from one upstream blip.
function proportionalJitter(nominalMs: number, random: () => number): number {
  return Math.floor(nominalMs * (0.8 + random() * 0.4))
}

export function patientOverloadBackoffMs(attempt: number, random: () => number = Math.random): number {
  return proportionalJitter(Math.min(PATIENT_OVERLOAD_CAP_MS, PATIENT_OVERLOAD_BASE_MS * 2 ** attempt), random)
}

export function responsiveOverloadBackoffMs(attempt: number, random: () => number = Math.random): number {
  return proportionalJitter(Math.min(RESPONSIVE_OVERLOAD_CAP_MS, RESPONSIVE_OVERLOAD_BASE_MS * 2 ** attempt), random)
}

export type OverloadRetryBudget = {
  retries: number
  windowMs: number
  backoffMs: (attempt: number, random?: () => number) => number
}

// Single source of truth for "how long may this caller wait out a capacity
// outage it cannot fail over from". An omitted policy resolves to 'responsive':
// the safe default is the short curve, so a new call site that never thought
// about retries still recovers from a blip instead of dropping the turn.
export function overloadRetryBudget(policy: RetryPolicy | undefined): OverloadRetryBudget {
  if (policy === 'patient') {
    return {
      retries: PATIENT_OVERLOAD_RETRIES,
      windowMs: PATIENT_OVERLOAD_WINDOW_MS,
      backoffMs: (attempt, random) => patientOverloadBackoffMs(attempt, random ?? Math.random),
    }
  }
  return {
    retries: RESPONSIVE_OVERLOAD_RETRIES,
    windowMs: RESPONSIVE_OVERLOAD_WINDOW_MS,
    backoffMs: (attempt, random) => responsiveOverloadBackoffMs(attempt, random ?? Math.random),
  }
}

// Full-jitter exponential backoff: random in [0, min(cap, base·2^attempt)].
// Jitter decorrelates concurrent turns (multiple channels/subagents recovering
// from the same upstream blip) so they don't retry in lockstep and re-collide.
export function retryBackoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt)
  return Math.floor(random() * ceiling)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// For callers that recreate the session themselves (cron) and only need the delay.
export function sleepBackoff(attempt: number, signal?: AbortSignal, random?: () => number): Promise<void> {
  return sleep(retryBackoffMs(attempt, random), signal)
}

type ContinuableAgent = {
  state?: { messages?: unknown }
  continue?: () => Promise<void>
}

// Replay the CURRENT turn on a persistent session WITHOUT re-appending the user
// message. Mirrors the SDK's own auto-retry shape, resuming via `agent.continue()`
// (which replays from the trailing user/tool-result message). Re-calling
// `session.prompt(text)` instead would duplicate the user message and corrupt
// history, so we never do that.
//
// Two resolved shapes are retryable, matching `continue()`'s contract that the
// last message be user/tool-result:
//   - trailing ASSISTANT error leaf → pop it, then continue (soft error, or a
//     hard throw AFTER a partial assistant message was written)
//   - trailing USER message → the provider died BEFORE writing any assistant
//     message (the reported incident: transport/session failure before stream
//     start). Nothing to pop — continue() replays the user turn as-is.
// Any other trailing shape (tool-result mid-execution, custom, empty transcript,
// no `agent.continue`) fails CLOSED — the caller falls back / surfaces instead.
export async function retryTurnOnPersistentSession(
  session: AgentSession,
  opts: {
    attempt: number
    signal?: AbortSignal
    random?: () => number
    delayMs?: number
    beforeResume?: () => void
  } = { attempt: 0 },
): Promise<boolean> {
  const agent = (session as { agent?: ContinuableAgent }).agent
  if (!agent || typeof agent.continue !== 'function') return false
  const messages = agent.state?.messages
  if (!Array.isArray(messages) || messages.length === 0) return false
  const leafRole = (messages[messages.length - 1] as { role?: unknown }).role
  if (leafRole !== 'assistant' && leafRole !== 'user') return false

  await sleep(opts.delayMs ?? retryBackoffMs(opts.attempt, opts.random), opts.signal)
  if (opts.signal?.aborted) return false
  opts.beforeResume?.()

  // Drop only a trailing assistant error leaf; a trailing user message is already
  // the shape continue() wants, so leave it untouched (and never re-appended).
  if (leafRole === 'assistant') {
    ;(agent.state as { messages: unknown }).messages = messages.slice(0, -1)
  }
  await agent.continue()
  return true
}

// Resume only the post-tool provider-failure shape. Unlike the generic helper,
// this deliberately refuses a trailing user leaf or an assistant error whose
// predecessor is anything other than the completed tool result. Callers use it
// after externally visible tool activity, where replaying the original turn
// could duplicate side effects.
export async function retryTurnAfterCompletedToolResult(
  session: AgentSession,
  opts: {
    attempt: number
    signal?: AbortSignal
    random?: () => number
    authorize: () => boolean
    beforeResume?: () => void
    onBackoffStart?: () => void
    // Overrides the ordinary jittered backoff, exactly as in
    // retryTurnOnPersistentSession. A capacity retry has already chosen its
    // delay from the policy budget; without this the post-tool path would fall
    // back to the 1–5s blip curve (which can jitter to ~0ms) and start
    // hammering an overloaded ref far sooner than the budget advertises.
    delayMs?: number
  },
): Promise<boolean> {
  const agent = (session as { agent?: ContinuableAgent }).agent
  if (!agent || typeof agent.continue !== 'function') return false
  if (!hasCompletedToolResultErrorTail(agent.state?.messages)) return false

  opts.onBackoffStart?.()
  await sleep(opts.delayMs ?? retryBackoffMs(opts.attempt, opts.random), opts.signal)
  if (opts.signal?.aborted) return false

  // Re-read after the backoff: another actor may have advanced the transcript
  // while we slept. Mutation is safe only while the exact tail still holds.
  const messages = agent.state?.messages
  if (!hasCompletedToolResultErrorTail(messages)) return false
  opts.beforeResume?.()
  if (opts.authorize() !== true) return false

  const originalMessages = messages
  const prefix = messages.slice(0, -1)
  ;(agent.state as { messages: unknown }).messages = prefix
  try {
    await agent.continue()
  } catch (err) {
    if (hasSameEntries(agent.state?.messages, prefix)) {
      ;(agent.state as { messages: unknown }).messages = originalMessages
    }
    throw err
  }
  return true
}

function hasCompletedToolResultErrorTail(messages: unknown): messages is unknown[] {
  if (!Array.isArray(messages) || messages.length < 2) return false
  const predecessor = messages[messages.length - 2]
  const leaf = messages[messages.length - 1]
  return (
    typeof predecessor === 'object' &&
    predecessor !== null &&
    (predecessor as { role?: unknown }).role === 'toolResult' &&
    typeof leaf === 'object' &&
    leaf !== null &&
    (leaf as { role?: unknown }).role === 'assistant' &&
    (leaf as { stopReason?: unknown }).stopReason === 'error'
  )
}

function hasSameEntries(messages: unknown, expected: unknown[]): boolean {
  return (
    Array.isArray(messages) &&
    messages.length === expected.length &&
    messages.every((entry, i) => entry === expected[i])
  )
}

// Same-ref retry for DIRECT `session.prompt()` call sites that bypass the model
// fallback helpers (non-stream TUI, slash commands, subagent drain/required-block
// nudges, multimodal look-at). These lost the SDK's built-in retry when it was
// disabled globally to kill the soft-error race; this restores equivalent
// same-model resilience WITHOUT cross-ref fallback (there's no chain here) and
// WITHOUT the race (typeclaw owns the soft-error signal). On a non-retryable
// failure it does exactly what a bare prompt() did: the throw propagates, or the
// soft error stays on the leaf for the caller to read.
export type SameRefPromptResult = { success: boolean; lastError?: Error }

export async function promptWithSameRefRetryOnly(
  session: AgentSession,
  text: string,
  promptOpts?: Parameters<AgentSession['prompt']>[1],
  opts: {
    signal?: AbortSignal
    retryPolicy?: RetryPolicy
    random?: () => number
    now?: () => number
    overloadBackoffMs?: (attempt: number) => number
  } = {},
): Promise<SameRefPromptResult> {
  const now = opts.now ?? (() => performance.now())
  const overloadBudget = overloadRetryBudget(opts.retryPolicy)
  let softError: Error | undefined
  // Feature-detect subscribe: some lightweight call sites / test fakes pass a
  // session without an event stream. Without it we simply can't observe soft
  // errors — the wrapper then only retries hard throws, still safe.
  const canSubscribe = typeof (session as { subscribe?: unknown }).subscribe === 'function'
  const unsub = canSubscribe
    ? subscribeProviderErrors(session, (err) => {
        if (!softError) softError = new Error(err.message)
      })
    : () => {}
  try {
    // Carry the last attempt's failure so a retry that CAN'T run (unsafe
    // transcript shape → retryTurnOnPersistentSession returns false) still
    // surfaces the original failure instead of resolving as a phantom success.
    let priorHardError: Error | undefined
    let lastError: Error | undefined
    let overloadRetries = 0
    let overloadWindowStartedAt: number | undefined
    let nextDelayMs: number | undefined
    for (let attempt = 0; ; attempt++) {
      opts.signal?.throwIfAborted()
      softError = undefined
      let hardError: Error | undefined
      try {
        if (attempt === 0) {
          await session.prompt(text, promptOpts)
        } else if (
          !(await retryTurnOnPersistentSession(session, {
            attempt: attempt - 1,
            signal: opts.signal,
            ...(nextDelayMs !== undefined ? { delayMs: nextDelayMs } : {}),
          }))
        ) {
          // Continue-recipe not applicable: replay never happened, so the prior
          // failure stands — re-throw a hard error, or return to leave a soft
          // error on the leaf (bare-prompt() semantics).
          if (priorHardError !== undefined) throw priorHardError
          return { success: false, ...(lastError !== undefined ? { lastError } : {}) }
        }
      } catch (err) {
        hardError = err instanceof Error ? err : new Error(String(err))
      }
      const error = hardError ?? softError
      if (error === undefined) return { success: true }
      lastError = error
      // Every call site here rides out a capacity outage on the same ref: there
      // is no cross-ref failover on this path, so declining to retry an overload
      // (isRetryableSameRef excludes it, expecting failover to handle it) would
      // leave it with no recovery at all. How long it may wait comes from the
      // policy's budget — see overloadRetryBudget.
      // The delay is budgeted BEFORE the retry is accepted: an elapsed-only check
      // would let a retry taken just under the deadline sleep past it.
      const nowMs = now()
      const overloadDelayMs = isThrottleOrOverload(error.message)
        ? (opts.overloadBackoffMs ?? ((n: number) => overloadBudget.backoffMs(n, opts.random)))(overloadRetries)
        : undefined
      const overloadElapsedMs = overloadWindowStartedAt === undefined ? 0 : nowMs - overloadWindowStartedAt
      const overloadRetry =
        overloadDelayMs !== undefined &&
        overloadRetries < overloadBudget.retries &&
        overloadElapsedMs + overloadDelayMs <= overloadBudget.windowMs
      if (overloadRetry) {
        overloadWindowStartedAt ??= nowMs
        nextDelayMs = overloadDelayMs
        overloadRetries++
      } else if (attempt < RETRIES_PER_REF && isRetryableSameRef(error.message)) {
        nextDelayMs = undefined
      } else {
        // Out of budget or not retryable: preserve bare-prompt() semantics — a
        // hard error throws; a soft error stays on the leaf for the caller.
        if (hardError !== undefined) throw hardError
        return { success: false, lastError: error }
      }
      priorHardError = hardError
    }
  } finally {
    unsub()
  }
}
