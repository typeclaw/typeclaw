import type { Stream, Unsubscribe } from '@/stream'

import type { LiveSubagent, LiveSubagentRegistry } from './live-subagents'
import { parseSubagentCompletedPayload, renderSubagentCompletionReminder } from './subagent-completion-reminder'

// Presence of this capability is the single signal that background spawning is
// permitted from a subagent (see the spawn_subagent guard); absence keeps the
// subagent a one-shot leaf. It carries everything the drain needs: the shared
// Stream to listen on, the subagent's own sessionId to filter completions by,
// and the registry that is the source of truth for child state.
export type SubagentBackgroundDrain = {
  stream: Stream
  sessionId: string
  liveRegistry: LiveSubagentRegistry
}

// Backstop ceiling for the background drain: a running child that never settles
// is abandoned after this so the parent can synthesize partial results instead
// of hanging forever. A child's own `timeoutMs` is the primary release: one that
// declares a longer deadline (browser = 15 min) is waited on until that deadline
// plus `DRAIN_CHILD_TIMEOUT_GRACE_MS`, so this only bounds children that declare
// a shorter deadline or none.
export const DRAIN_MAX_CHILD_WAIT_MS = 600_000

// Time for a child's own timeout to settle and broadcast before the drain
// abandons it.
const DRAIN_CHILD_TIMEOUT_GRACE_MS = 30_000

export type DrainPrompt = (text: string) => Promise<void>

export type RunSubagentDrainOptions = {
  drain: SubagentBackgroundDrain
  prompt: DrainPrompt
  // Cooperative cancellation: when this returns true the loop stops re-prompting
  // and returns, letting the caller's timeout/abort path dispose the session.
  cancelled?: () => boolean
  // Wall-clock ceiling on how long a single background child may stay `running`
  // before the drain gives up on it. A child without its own `timeoutMs` can
  // wedge forever (a hung `session.prompt`), and the drain would otherwise wait
  // on it indefinitely — stranding the parent's whole report. When a child
  // exceeds this, we abort it and record a timeout completion so its reminder is
  // delivered and the loop can reach its fixed point with partial results.
  // Undefined keeps the legacy unbounded behavior.
  maxChildWaitMs?: number
  // Task ids whose reminder was already delivered. Pass the same set to every
  // drain of one session so a later drain does not re-deliver a child an earlier
  // drain reported.
  delivered?: Set<string>
  // Injectable clock + abort-await seam for tests; production uses real time.
  now?: () => number
}

// Re-prompts a subagent with its children's completion reminders until a fixed
// point, called after the subagent's initial prompt resolves. The registry is
// the source of truth; stream broadcasts are only wakeups, so a duplicated or
// missed broadcast cannot corrupt termination (every iteration re-derives state
// from the registry). Each child's reminder is delivered at most once (tracked
// by taskId). Terminates only when no children are running AND none are
// completed-but-undelivered; a child spawned during a reminder turn reappears as
// `running` in the next snapshot and keeps the loop alive, so no separate
// "spawned nothing" flag is needed. The watch MUST have been started before the
// initial prompt (see `beginSubagentDrainWatch`) to close the lost-wakeup race.
export async function runSubagentDrain(watch: SubagentDrainWatch, options: RunSubagentDrainOptions): Promise<void> {
  const { drain, prompt, cancelled, maxChildWaitMs, delivered = new Set<string>(), now = Date.now } = options
  try {
    while (cancelled === undefined || !cancelled()) {
      expireOverdueChildren(drain, maxChildWaitMs, now)
      const pending = collectPendingReminders(drain, delivered)
      if (pending.length === 0) {
        if (!hasRunningChildren(drain)) return
        // Children still running but none newly completed: wait for the next
        // wakeup, then re-derive. A `maxChildWaitMs` bounds this wait (via a
        // timer) so a child that never broadcasts still gets expired next
        // iteration. `waitForWakeup` returns true on a completion OR a timer
        // expiry, and false ONLY when the watch is stopped — which must always
        // terminate the loop, else a stopped watch with a still-running child
        // spins synchronously forever.
        const woke = await watch.waitForWakeup(nextExpiryDelayMs(drain, maxChildWaitMs, now))
        if (!woke) return
        continue
      }
      for (const reminder of pending) {
        if (cancelled !== undefined && cancelled()) return
        delivered.add(reminder.taskId)
        await prompt(reminder.text)
      }
    }
  } finally {
    watch.stop()
  }
}

// Records a timeout completion (then fires abort) for any background child that
// has been `running` past the ceiling. Recording a (failed) completion is what
// lets the child surface as a delivered reminder and drop out of
// `hasRunningChildren`, so the loop reaches its fixed point with partial results
// rather than hanging on a wedged child. Synchronous by design — see the
// record-before-abort note inside.
function expireOverdueChildren(
  drain: SubagentBackgroundDrain,
  maxChildWaitMs: number | undefined,
  now: () => number,
): void {
  if (maxChildWaitMs === undefined) return
  for (const child of drain.liveRegistry.list({ parentSessionId: drain.sessionId })) {
    if (child.background !== true || child.status !== 'running') continue
    const waitMs = childWaitMs(child, maxChildWaitMs)
    if (child.startedAt > now() - waitMs) continue
    const durationMs = now() - child.startedAt
    const error = `subagent ${child.subagentName} exceeded the ${waitMs}ms drain wait and was abandoned`
    const finalMessage = drain.liveRegistry.getCapturedFinalMessage(child.taskId)
    // Claim the settlement BEFORE aborting. If the child's real completion
    // already won, skip — no double-settle, no broadcast. Awaiting abort here
    // would be the bug the ceiling exists to prevent: a wedged `session.abort()`
    // that never reaches idle would hang the drain, so fire-and-forget instead.
    // Logical settlement can precede physical teardown; startSubagent still
    // disposes the session when its own work settles.
    if (
      !drain.liveRegistry.recordCompletionIfRunning(child.taskId, {
        ok: false,
        durationMs,
        error,
        ...(finalMessage !== undefined ? { finalMessage } : {}),
      })
    )
      continue
    drain.stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'subagent.completed',
        taskId: child.taskId,
        subagent: child.subagentName,
        parentSessionId: drain.sessionId,
        ok: false,
        durationMs,
        error,
        ...(finalMessage !== undefined ? { hasRecoverableOutput: true } : {}),
      },
    })
    void child.abort().catch(() => {})
  }
}

// The soonest a still-running child will cross the ceiling, so waitForWakeup can
// wake the loop to expire it even if no completion broadcast ever arrives.
// Undefined when there is no ceiling or no running child (wait indefinitely).
function nextExpiryDelayMs(
  drain: SubagentBackgroundDrain,
  maxChildWaitMs: number | undefined,
  now: () => number,
): number | undefined {
  if (maxChildWaitMs === undefined) return undefined
  const running = drain.liveRegistry
    .list({ parentSessionId: drain.sessionId })
    .filter((c) => c.background === true && c.status === 'running')
  if (running.length === 0) return undefined
  const soonestDeadline = Math.min(...running.map((c) => c.startedAt + childWaitMs(c, maxChildWaitMs)))
  return Math.max(0, soonestDeadline - now())
}

function childWaitMs(child: LiveSubagent, maxChildWaitMs: number): number {
  if (child.timeoutMs === undefined) return maxChildWaitMs
  return Math.max(maxChildWaitMs, child.timeoutMs + DRAIN_CHILD_TIMEOUT_GRACE_MS)
}

type PendingReminder = { taskId: string; text: string }

function collectPendingReminders(drain: SubagentBackgroundDrain, delivered: Set<string>): PendingReminder[] {
  const children = drain.liveRegistry.list({ parentSessionId: drain.sessionId })
  const pending: PendingReminder[] = []
  for (const child of children) {
    // Synchronous spawns return their result inline via the tool call; only
    // background spawns deliver out-of-band and need a drain reminder.
    if (child.background !== true) continue
    if (child.status === 'running') continue
    if (delivered.has(child.taskId)) continue
    const completion = child.completion
    const hasRecoverableOutput = child.status !== 'completed' && completion?.finalMessage !== undefined
    const text = renderSubagentCompletionReminder({
      subagent: child.subagentName,
      taskId: child.taskId,
      ok: child.status === 'completed',
      durationMs: completion?.durationMs ?? 0,
      ...(completion?.error !== undefined ? { error: completion.error } : {}),
      ...(hasRecoverableOutput ? { hasRecoverableOutput: true } : {}),
    })
    pending.push({ taskId: child.taskId, text })
  }
  return pending
}

function hasRunningChildren(drain: SubagentBackgroundDrain): boolean {
  // Only background children gate termination. A sync child still marked running
  // in the registry settles via its inline tool call, never via a broadcast
  // wakeup, so waiting on it would hang the drain forever.
  return drain.liveRegistry
    .list({ parentSessionId: drain.sessionId })
    .some((c) => c.background === true && c.status === 'running')
}

export type SubagentDrainWatch = {
  // Resolves true on a child-completion wakeup, false once stopped. A wakeup
  // that arrives before anyone waits is latched (pendingWake), so a completion
  // during the subagent's prompt is not lost. An optional `timeoutMs` resolves
  // true when it elapses (a spurious wake) so the loop re-derives and can expire
  // a child that never broadcast a completion.
  waitForWakeup: (timeoutMs?: number) => Promise<boolean>
  stop: () => void
}

// Injectable timer seam so tests can assert timer cancellation deterministically
// (a real setTimeout cancellation is invisible without racing the clock). `set`
// returns an opaque handle; `clear` cancels it. Production uses node timers.
export type TimerScheduler = {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimerScheduler: TimerScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function beginSubagentDrainWatch(
  drain: SubagentBackgroundDrain,
  scheduler: TimerScheduler = realTimerScheduler,
): SubagentDrainWatch {
  let stopped = false
  let pendingWake = false
  let resolveWaiter: ((woke: boolean) => void) | null = null
  let waiterTimer: unknown = null

  const clearWaiterTimer = (): void => {
    if (waiterTimer !== null) {
      scheduler.clear(waiterTimer)
      waiterTimer = null
    }
  }

  const wake = (): void => {
    if (resolveWaiter !== null) {
      const r = resolveWaiter
      resolveWaiter = null
      clearWaiterTimer()
      r(true)
      return
    }
    pendingWake = true
  }

  const unsubscribe: Unsubscribe = drain.stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
    const parsed = parseSubagentCompletedPayload(msg.payload)
    if (parsed === null) return
    if (parsed.parentSessionId !== drain.sessionId) return
    wake()
  })

  return {
    waitForWakeup: (timeoutMs?: number) =>
      new Promise<boolean>((resolve) => {
        if (stopped) {
          resolve(false)
          return
        }
        if (pendingWake) {
          pendingWake = false
          resolve(true)
          return
        }
        resolveWaiter = resolve
        if (timeoutMs !== undefined) {
          waiterTimer = scheduler.set(() => {
            if (resolveWaiter === null) return
            resolveWaiter = null
            waiterTimer = null
            resolve(true)
          }, timeoutMs)
        }
      }),
    stop: () => {
      if (stopped) return
      stopped = true
      unsubscribe()
      clearWaiterTimer()
      if (resolveWaiter !== null) {
        const r = resolveWaiter
        resolveWaiter = null
        r(false)
      }
    },
  }
}
