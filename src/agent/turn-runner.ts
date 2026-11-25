import { providerForModelRef, type ModelRef } from '@/config/providers'

import type { AgentSession } from './index'
import {
  detectProviderError,
  isObserverTtfbTimeout,
  isRetryableSameRef,
  isThrottleOrOverload,
  subscribeProviderErrors,
} from './provider-error'
import {
  overloadRetryBudget,
  RETRIES_PER_REF,
  retryTurnAfterCompletedToolResult,
  retryTurnOnPersistentSession,
  type RetryPolicy,
} from './retry-same-ref'
import { modelThrottleCircuit, type ThrottleCircuit } from './throttle-circuit'

export type PersistentTurnAttempt = {
  ref: ModelRef
  outcome: 'hard' | 'soft' | 'success'
  errorMessage?: string
}

export type PersistentTurnResult = {
  success: boolean
  refUsed: ModelRef
  attempts: PersistentTurnAttempt[]
  lastError?: Error
}

type AttemptActivity = {
  producedAssistantOutput: boolean
  startedToolExecution: boolean
}

// SDK-level attempts already contain pi-ai's internal fetch recovery. Three is
// the safe minimum for a fallback chain: primary attempt + its one ordinary
// transient replay + one cross-ref attempt. Lowering it would weaken either the
// retained transient retry or fallback; raising it would recreate the repeated
// TTFB bursts reviewer coalescing is intended to prevent from multiplying.
// Patient overload retries do not apply to observer TTFB errors, so this envelope
// already bounds deep-review no-progress without a reviewer-specific retry fork.
const MAX_NO_PROGRESS_ATTEMPTS = 3
const MAX_CUMULATIVE_NO_PROGRESS_MS = 60_000

export async function promptPersistentTurnWithFallback(opts: {
  refs: ModelRef[]
  currentModelRef: ModelRef
  session: AgentSession
  text: string
  shouldFailover: (err: Error) => boolean
  setModelForRef: (ref: ModelRef) => Promise<void>
  profile?: string
  retryPolicy?: RetryPolicy
  circuit?: ThrottleCircuit
  skipProviderErrorSubscription?: boolean
  detectSoftErrorFromLeaf?: boolean
  authorizeRetryAfterCompletedToolResult?: () => boolean
  retryRandom?: () => number
  overloadBackoffMs?: (attempt: number) => number
  onRetryBackoffStart?: () => void
  beforeAttempt?: (ref: ModelRef) => void
  // After retry backoff, before either helper edits the transcript for continue().
  beforeResume?: () => void
  onAttemptFailed?: (attempt: PersistentTurnAttempt) => void
  // Fired the first time an attempt starts executing a tool. Callers use it to
  // learn that the turn stopped being silent even when the turn ultimately
  // fails — including the hard-throw path, where no result is ever returned.
  onToolExecutionStarted?: () => void
  now?: () => number
}): Promise<PersistentTurnResult> {
  if (opts.refs.length === 0) throw new Error('promptPersistentTurnWithFallback: refs[] must be non-empty')
  const attempts: PersistentTurnAttempt[] = []
  let lastError: Error | undefined
  const circuit = opts.circuit ?? modelThrottleCircuit
  // Monotonic clock for the no-progress budget: it only ever measures elapsed
  // (now() - attemptStartedAt), and performance.now() can't jump backward on an
  // NTP/system-clock correction the way Date.now() can, which would otherwise
  // prematurely trip or stall the 60s cap.
  const now = opts.now ?? (() => performance.now())
  const overloadBudget = overloadRetryBudget(opts.retryPolicy)
  const hasNonCodexFallback = opts.refs.some((ref) => !isCodexRef(ref))
  let noHeaderAttempts = 0
  let cumulativeNoProgressMs = 0
  let noProgressEnvelopeExhausted = false
  // The model the session currently has loaded; only call setModel when the
  // chosen ref differs from it. Tracked locally so successive setModel calls
  // within a single turn stay coherent.
  let loadedRef = opts.currentModelRef
  // Always start from the head of the chain so a recovered primary is probed
  // again (the circuit breaker, not a sticky start index, decides when to skip
  // a still-throttled ref). Starting at the previous turn's fallback would make
  // a one-time failover permanent and never let the cooldown/half-open path
  // re-test the primary.
  for (let i = 0; i < opts.refs.length; i++) {
    const ref = opts.refs[i]!
    const codexProviderOpen = isCodexRef(ref) && circuit.isProviderOpen({ profile: opts.profile, ref })
    if (codexProviderOpen && hasNonCodexFallback) continue
    const isLast = !opts.refs
      .slice(i + 1)
      .some((candidate) => isRefUsable(candidate, opts.profile, circuit, hasNonCodexFallback))
    // The last usable ref remains a safety probe. Codex refs stop being usable
    // together only when the chain has transport-diverse credentials to use.
    if (!isLast && circuit.isOpen({ profile: opts.profile, ref })) continue
    if (ref !== loadedRef) {
      await opts.setModelForRef(ref)
      loadedRef = ref
    }
    opts.beforeAttempt?.(ref)
    const activity: AttemptActivity = { producedAssistantOutput: false, startedToolExecution: false }
    let softError: Error | undefined
    // Activity tracking ALWAYS runs — the idempotency guard must hold even for
    // subagents. `skipProviderErrorSubscription` only suppresses the soft-error
    // listener (subagents capture their final message off the leaf instead, via
    // detectSoftErrorFromLeaf, so a second listener would race that capture).
    const unsubActivity = subscribeAttemptActivity(opts.session, activity, opts.onToolExecutionStarted)
    const unsubProvider = opts.skipProviderErrorSubscription
      ? () => {}
      : subscribeProviderErrorsIfAvailable(opts.session, (err) => {
          if (softError === undefined) softError = new Error(err.message)
        })
    try {
      // Same-ref retry loop: replay this ref on a transient failure before
      // advancing the chain. `retry === 0` is the first, prompt()-driven attempt;
      // later iterations resume via agent.continue() (no user-message re-append).
      let outcome: AttemptOutcome | undefined
      let retryAfterCompletedToolResult = false
      let overloadRetries = 0
      let overloadWindowStartedAt: number | undefined
      let nextDelayMs: number | undefined
      for (let retry = 0; ; retry++) {
        softError = undefined
        const attemptStartedAt = now()
        let outcomeThisAttempt: AttemptOutcome | undefined
        try {
          if (retry === 0) {
            await opts.session.prompt(opts.text)
          } else {
            const retried = retryAfterCompletedToolResult
              ? await retryTurnAfterCompletedToolResult(opts.session, {
                  attempt: retry - 1,
                  beforeResume: opts.beforeResume,
                  authorize: () => opts.authorizeRetryAfterCompletedToolResult?.() === true,
                  ...(nextDelayMs !== undefined ? { delayMs: nextDelayMs } : {}),
                  ...(opts.retryRandom !== undefined ? { random: opts.retryRandom } : {}),
                  ...(opts.onRetryBackoffStart !== undefined ? { onBackoffStart: opts.onRetryBackoffStart } : {}),
                })
              : await retryTurnOnPersistentSession(opts.session, {
                  attempt: retry - 1,
                  beforeResume: opts.beforeResume,
                  ...(nextDelayMs !== undefined ? { delayMs: nextDelayMs } : {}),
                })
            // The safe continue-recipe couldn't apply: keep the PREVIOUS failure
            // outcome (never cleared) and let it drive the advance/return below.
            if (!retried) break
          }
          outcomeThisAttempt = classifySoftOutcome(softError, opts)
        } catch (err) {
          outcomeThisAttempt = { kind: 'hard', error: err instanceof Error ? err : new Error(String(err)) }
        }
        outcome = outcomeThisAttempt
        if (outcome === undefined) break
        if (isObserverTtfbTimeout(outcome.error.message)) {
          noHeaderAttempts++
          cumulativeNoProgressMs += Math.max(0, now() - attemptStartedAt)
          noProgressEnvelopeExhausted =
            noHeaderAttempts >= MAX_NO_PROGRESS_ATTEMPTS || cumulativeNoProgressMs >= MAX_CUMULATIVE_NO_PROGRESS_MS
        }
        // A fallback reached before the cap may still recover; once the cap is
        // reached, no same-ref replay or later ref may start.
        if (noProgressEnvelopeExhausted) break
        // Retry within budget only when the failure is same-ref retryable and
        // either no visible/tool activity occurred, or the caller explicitly
        // authorizes the strict post-tool-result resume recipe.
        // Overload means "this ref is out of capacity NOW", so the standing policy
        // is to fail OVER rather than burn same-ref retries — which is why
        // isRetryableSameRef excludes it. But on the LAST usable ref there is
        // nothing to fail over to, and a single-ref chain is all last, so that
        // policy would leave a capacity outage with no recovery whatsoever: the
        // turn dies on its first attempt in seconds and the caller drops the
        // user's message. Both policies therefore ride it out here, differing
        // only in how long (see overloadRetryBudget) — patient for minutes,
        // responsive for a live-chat-sized handful of seconds.
        // Budget the delay BEFORE accepting the retry. Testing only the elapsed
        // window lets a retry accepted just under the deadline sleep past it, so
        // the next provider attempt would START after the window we advertise.
        const nowMs = now()
        const overloadDelayMs =
          isLast && isThrottleOrOverload(outcome.error.message)
            ? (opts.overloadBackoffMs ?? ((n: number) => overloadBudget.backoffMs(n, opts.retryRandom)))(
                overloadRetries,
              )
            : undefined
        const overloadElapsedMs = overloadWindowStartedAt === undefined ? 0 : nowMs - overloadWindowStartedAt
        const overloadRetry =
          overloadDelayMs !== undefined &&
          overloadRetries < overloadBudget.retries &&
          overloadElapsedMs + overloadDelayMs <= overloadBudget.windowMs
        const retryableWithinBudget =
          overloadRetry || (retry < RETRIES_PER_REF && isRetryableSameRef(outcome.error.message))
        const mayRetryWithoutActivity = !activity.producedAssistantOutput && !activity.startedToolExecution
        retryAfterCompletedToolResult =
          retryableWithinBudget &&
          activity.startedToolExecution &&
          opts.authorizeRetryAfterCompletedToolResult?.() === true
        const mayRetry = retryableWithinBudget && (mayRetryWithoutActivity || retryAfterCompletedToolResult)
        if (!mayRetry) break
        if (overloadRetry) {
          overloadWindowStartedAt ??= nowMs
          nextDelayMs = overloadDelayMs
          overloadRetries++
        } else {
          nextDelayMs = undefined
        }
      }

      if (outcome === undefined) {
        attempts.push({ ref, outcome: 'success' })
        circuit.recordSuccess({ profile: opts.profile, ref })
        return { success: true, refUsed: ref, attempts }
      }

      // Ref abandoned after exhausting same-ref retries. Record throttle ONCE
      // here (not per internal retry) so a single turn can't self-trip the
      // circuit breaker.
      const attempt: PersistentTurnAttempt = { ref, outcome: outcome.kind, errorMessage: outcome.error.message }
      attempts.push(attempt)
      lastError = outcome.error
      if (opts.shouldFailover(outcome.error)) circuit.recordThrottle({ profile: opts.profile, ref })
      if (isCodexRef(ref) && isObserverTtfbTimeout(outcome.error.message)) {
        circuit.recordProviderTrip({ profile: opts.profile, ref })
      }
      // A codex-only chain surfaces after one attempt once its breaker is open
      // (no transport-diverse ref to fall to). isRefUsable can't express this —
      // with no non-codex fallback every codex ref reads as "usable" — so it stays
      // an explicit condition.
      const codexOnlyProviderOpen =
        !hasNonCodexFallback && isCodexRef(ref) && circuit.isProviderOpen({ profile: opts.profile, ref })
      // `isLast` was computed BEFORE this attempt, but recordProviderTrip above
      // may have just opened the codex breaker and made every trailing candidate
      // unusable (all remaining refs are codex the loop would now skip). Re-derive
      // "is there a ref left worth advancing to" from the post-trip circuit state,
      // so we finish on the CURRENT outcome (throw hard / return soft) instead of
      // falling through the loop and returning success:false for a ref that was
      // skipped and never attempted.
      const noUsableCandidateRemains = !opts.refs
        .slice(i + 1)
        .some((next) => isRefUsable(next, opts.profile, circuit, hasNonCodexFallback))
      if (
        noProgressEnvelopeExhausted ||
        isLast ||
        codexOnlyProviderOpen ||
        noUsableCandidateRemains ||
        !canAdvance(outcome.error, activity, opts.shouldFailover)
      ) {
        if (outcome.kind === 'hard') throw outcome.error
        return { success: false, refUsed: ref, attempts, lastError }
      }
      opts.onAttemptFailed?.(attempt)
      continue
    } finally {
      unsubProvider()
      unsubActivity()
    }
  }
  return { success: false, refUsed: opts.refs[opts.refs.length - 1]!, attempts, lastError }
}

type AttemptOutcome = { kind: 'hard' | 'soft'; error: Error }

// Classify a completed (non-throwing) attempt: a captured soft error, else a
// leaf soft error (subagent path), else success (undefined). Mirrors the two
// soft-error sources the loop handled inline before the retry refactor.
function classifySoftOutcome(
  softError: Error | undefined,
  opts: { session: AgentSession; detectSoftErrorFromLeaf?: boolean },
): AttemptOutcome | undefined {
  if (softError !== undefined) return { kind: 'soft', error: softError }
  const leafSoftError = opts.detectSoftErrorFromLeaf ? detectLeafSoftError(opts.session) : undefined
  if (leafSoftError !== undefined) return { kind: 'soft', error: leafSoftError }
  return undefined
}

function canAdvance(error: Error, activity: AttemptActivity, shouldFailover: (err: Error) => boolean): boolean {
  return shouldFailover(error) && !activity.producedAssistantOutput && !activity.startedToolExecution
}

function isCodexRef(ref: ModelRef): boolean {
  return providerForModelRef(ref) === 'openai-codex'
}

// A ref is still worth advancing to iff the loop wouldn't skip it at the top: a
// codex ref is dropped only once the codex provider breaker is open AND the chain
// has a transport-diverse (non-codex) fallback to use instead. Shared by the
// `isLast` safety-probe check and the post-trip terminal decision so both read
// the SAME circuit state and can't diverge.
function isRefUsable(
  ref: ModelRef,
  profile: string | undefined,
  circuit: ThrottleCircuit,
  hasNonCodexFallback: boolean,
): boolean {
  if (!isCodexRef(ref)) return true
  if (!hasNonCodexFallback) return true
  return !circuit.isProviderOpen({ profile, ref })
}

function subscribeAttemptActivity(
  session: AgentSession,
  activity: AttemptActivity,
  onToolExecutionStarted?: () => void,
): () => void {
  const subscribe = (session as { subscribe?: unknown }).subscribe
  if (typeof subscribe !== 'function') return () => {}
  return session.subscribe((event: unknown) => {
    if (!isRecord(event)) return
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      const alreadyStarted = activity.startedToolExecution
      activity.startedToolExecution = true
      if (!alreadyStarted) onToolExecutionStarted?.()
      return
    }
    if (event.type !== 'message_update') return
    const assistantMessageEvent = event.assistantMessageEvent
    if (!isRecord(assistantMessageEvent)) return
    if (assistantMessageEvent.type === 'text_delta' && typeof assistantMessageEvent.delta === 'string') {
      if (assistantMessageEvent.delta.length > 0) activity.producedAssistantOutput = true
    }
  })
}

function subscribeProviderErrorsIfAvailable(
  session: AgentSession,
  onError: Parameters<typeof subscribeProviderErrors>[1],
): () => void {
  const subscribe = (session as { subscribe?: unknown }).subscribe
  if (typeof subscribe !== 'function') return () => {}
  return subscribeProviderErrors(session, onError)
}

function detectLeafSoftError(session: AgentSession): Error | undefined {
  const leaf = session.sessionManager?.getLeafEntry()
  if (!leaf || leaf.type !== 'message') return undefined
  const detected = detectProviderError(leaf.message)
  return detected === null ? undefined : new Error(detected.message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
