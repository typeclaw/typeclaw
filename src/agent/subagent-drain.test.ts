import { describe, expect, test } from 'bun:test'

import { createStream } from '@/stream'

import { LiveSubagentRegistry } from './live-subagents'
import {
  beginSubagentDrainWatch,
  runSubagentDrain,
  type SubagentBackgroundDrain,
  type TimerScheduler,
} from './subagent-drain'

const PARENT = 'ses_subagent'

// A controllable timer scheduler: records set/clear so tests can assert
// cancellation deterministically, and lets a test fire the pending timer by hand.
function makeFakeScheduler(): TimerScheduler & {
  setCount: () => number
  clearCount: () => number
  fire: () => void
  hasPending: () => boolean
} {
  let pending: (() => void) | null = null
  let handle = 0
  let sets = 0
  let clears = 0
  return {
    set: (fn) => {
      sets++
      pending = fn
      return ++handle
    },
    clear: () => {
      clears++
      pending = null
    },
    setCount: () => sets,
    clearCount: () => clears,
    hasPending: () => pending !== null,
    fire: () => {
      const fn = pending
      pending = null
      fn?.()
    },
  }
}

function noopAbort(): Promise<void> {
  return Promise.resolve()
}

function registerChild(
  reg: LiveSubagentRegistry,
  taskId: string,
  opts?: { startedAt?: number; timeoutMs?: number; abort?: () => Promise<void> },
): void {
  reg.register({
    taskId,
    sessionId: `ses_${taskId}`,
    subagentName: 'scout',
    parentSessionId: PARENT,
    background: true,
    startedAt: opts?.startedAt ?? 0,
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    status: 'running',
    abort: opts?.abort ?? noopAbort,
  })
}

function registerSyncChild(reg: LiveSubagentRegistry, taskId: string): void {
  reg.register({
    taskId,
    sessionId: `ses_${taskId}`,
    subagentName: 'scout',
    parentSessionId: PARENT,
    background: false,
    startedAt: 0,
    status: 'running',
    abort: noopAbort,
  })
}

function makeDrain(): { drain: SubagentBackgroundDrain; reg: LiveSubagentRegistry } {
  const reg = new LiveSubagentRegistry()
  const drain: SubagentBackgroundDrain = { stream: createStream(), sessionId: PARENT, liveRegistry: reg }
  return { drain, reg }
}

describe('runSubagentDrain — termination', () => {
  test('returns immediately when the subagent has no children', async () => {
    const { drain } = makeDrain()
    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []

    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts).toEqual([])
  })

  test('delivers one reminder per already-completed child, then terminates', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_a')
    registerChild(reg, 'bg_b')
    reg.recordCompletion('bg_a', { ok: true, durationMs: 100, finalMessage: 'A done' })
    reg.recordCompletion('bg_b', { ok: true, durationMs: 200, finalMessage: 'B done' })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts.length).toBe(2)
    expect(prompts.some((p) => p.includes('bg_a'))).toBe(true)
    expect(prompts.some((p) => p.includes('bg_b'))).toBe(true)
  })

  test('does not deliver a reminder for the same child twice', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_a')
    reg.recordCompletion('bg_a', { ok: true, durationMs: 100 })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts.filter((p) => p.includes('bg_a')).length).toBe(1)
  })

  test('a child still running blocks termination until it completes (wakeup-driven)', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_slow')

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    const done = runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    // Loop should be parked on waitForWakeup (no completed children yet).
    await new Promise((r) => setTimeout(r, 5))
    expect(prompts).toEqual([])

    // Complete the child and fire the broadcast wakeup.
    reg.recordCompletion('bg_slow', { ok: true, durationMs: 300 })
    drain.stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'subagent.completed',
        taskId: 'bg_slow',
        subagent: 'scout',
        parentSessionId: PARENT,
        ok: true,
        durationMs: 300,
      },
    })

    await done
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('bg_slow')
  })

  test('lost-wakeup race: child completes BEFORE the loop waits, still terminates', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_race')

    // Watch subscribes first (this is the contract).
    const watch = beginSubagentDrainWatch(drain)

    // Child completes + broadcast fires BEFORE runSubagentDrain is even called —
    // simulating a completion that lands while the subagent was mid initial-prompt.
    reg.recordCompletion('bg_race', { ok: true, durationMs: 50 })
    drain.stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'subagent.completed',
        taskId: 'bg_race',
        subagent: 'scout',
        parentSessionId: PARENT,
        ok: true,
        durationMs: 50,
      },
    })

    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    // The completed child is found by the first snapshot; loop delivers and exits.
    expect(prompts.length).toBe(1)
  })

  test('ignores completions for other parents', async () => {
    const { drain, reg } = makeDrain()
    reg.register({
      taskId: 'bg_other',
      sessionId: 'ses_other',
      subagentName: 'scout',
      parentSessionId: 'ses_someone_else',
      startedAt: 0,
      status: 'running',
      abort: noopAbort,
    })
    reg.recordCompletion('bg_other', { ok: true, durationMs: 10 })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts).toEqual([])
  })

  test('a child spawned during a reminder turn keeps the loop alive', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_1')
    reg.recordCompletion('bg_1', { ok: true, durationMs: 10 })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, {
      drain,
      prompt: async (t) => {
        prompts.push(t)
        // On the first reminder turn, the model spawns a new completed child.
        if (t.includes('bg_1') && reg.get('bg_2') === undefined) {
          registerChild(reg, 'bg_2')
          reg.recordCompletion('bg_2', { ok: true, durationMs: 20 })
        }
      },
    })

    expect(prompts.length).toBe(2)
    expect(prompts.some((p) => p.includes('bg_2'))).toBe(true)
  })

  test('cancellation stops the loop before delivering more reminders', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_a')
    registerChild(reg, 'bg_b')
    reg.recordCompletion('bg_a', { ok: true, durationMs: 10 })
    reg.recordCompletion('bg_b', { ok: true, durationMs: 10 })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    let cancel = false
    await runSubagentDrain(watch, {
      drain,
      cancelled: () => cancel,
      prompt: async (t) => {
        prompts.push(t)
        cancel = true
      },
    })

    expect(prompts.length).toBe(1)
  })

  test('does NOT re-prompt for synchronous children (their result returned inline)', async () => {
    const { drain, reg } = makeDrain()
    registerSyncChild(reg, 'sync_a')
    registerSyncChild(reg, 'sync_b')
    reg.recordCompletion('sync_a', { ok: true, durationMs: 10, finalMessage: 'A inline' })
    reg.recordCompletion('sync_b', { ok: true, durationMs: 10, finalMessage: 'B inline' })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts).toEqual([])
  })

  test('drains only background children, ignoring completed sync siblings', async () => {
    const { drain, reg } = makeDrain()
    registerSyncChild(reg, 'sync_done')
    registerChild(reg, 'bg_done')
    reg.recordCompletion('sync_done', { ok: true, durationMs: 10 })
    reg.recordCompletion('bg_done', { ok: true, durationMs: 20 })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('bg_done')
    expect(prompts.some((p) => p.includes('sync_done'))).toBe(false)
  })

  test('a running sync child does not block termination', async () => {
    const { drain, reg } = makeDrain()
    registerSyncChild(reg, 'sync_running')

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts).toEqual([])
  })

  test('delivers a FAILED reminder for a failed child', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_fail')
    reg.recordCompletion('bg_fail', { ok: false, durationMs: 10, error: 'boom' })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('FAILED')
    expect(prompts[0]).toContain('boom')
  })

  test('delivers a close-out, not a failure, for a child cancelled by work key while the parent waits', async () => {
    const { drain, reg } = makeDrain()
    reg.register({
      taskId: 'bg_rev',
      sessionId: 'ses_bg_rev',
      subagentName: 'reviewer',
      parentSessionId: PARENT,
      workKey: 'reviewer:github:acme/widgets#42',
      background: true,
      startedAt: 0,
      status: 'running',
      abort: noopAbort,
    })
    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    const run = runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    // when: the waiting child is cancelled by its work key
    await reg.cancelRunningByWorkKey('reviewer:github:acme/widgets#42', 'pull request converted to draft', drain.stream)
    await run

    // then: the drain closes it out instead of asking for recovery
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('was cancelled')
    expect(prompts[0]).not.toContain('FAILED')
    expect(prompts[0]).not.toContain('keep the item pending')
  })
})

describe('runSubagentDrain — maxChildWaitMs (wedged-child ceiling)', () => {
  test('expires a child that stays running past the ceiling, then terminates', async () => {
    // given: a child that started at t=0 and never completes
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_wedged', { startedAt: 0 })

    // when: the clock is already past the 5000ms ceiling
    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, {
      drain,
      prompt: async (t) => void prompts.push(t),
      maxChildWaitMs: 5000,
      now: () => 6000,
    })

    // then: the wedged child is abandoned (FAILED reminder) and the loop returns
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('bg_wedged')
    expect(prompts[0]).toContain('FAILED')
    expect(reg.get('bg_wedged')?.status).toBe('failed')
  })

  test('aborts the wedged child when expiring it', async () => {
    // given: a child whose abort we can observe
    const { drain, reg } = makeDrain()
    let aborted = false
    registerChild(reg, 'bg_wedged', { startedAt: 0, abort: async () => void (aborted = true) })

    // when
    const watch = beginSubagentDrainWatch(drain)
    await runSubagentDrain(watch, {
      drain,
      prompt: async () => {},
      maxChildWaitMs: 5000,
      now: () => 6000,
    })

    // then
    expect(aborted).toBe(true)
  })

  test('waits past the ceiling for a child whose own timeout is longer', async () => {
    // given: a child declaring a 15s timeout, 6s in, with a 5s drain ceiling
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_slow', { startedAt: 0, timeoutMs: 15_000 })

    // when: the drain runs its first (synchronous) expiry pass
    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    const done = runSubagentDrain(watch, {
      drain,
      prompt: async (t) => void prompts.push(t),
      maxChildWaitMs: 5000,
      now: () => 6000,
    })

    // then: the child is left running for its own deadline
    expect(reg.get('bg_slow')?.status).toBe('running')
    watch.stop()
    await done
    expect(prompts).toEqual([])
  })

  test('abandons a long-timeout child once its own timeout plus grace has passed', async () => {
    // given: a child declaring a 15s timeout, well past 15s + grace
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_slow', { startedAt: 0, timeoutMs: 15_000 })

    // when
    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, {
      drain,
      prompt: async (t) => void prompts.push(t),
      maxChildWaitMs: 5000,
      now: () => 60_000,
    })

    // then
    expect(reg.get('bg_slow')?.status).toBe('failed')
    expect(prompts[0]).toContain('FAILED')
  })

  test('does NOT expire a child still within the ceiling (parks on wakeup)', async () => {
    // given: a child started at t=0, clock at 3000ms, ceiling 5000ms
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_young', { startedAt: 0 })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    const done = runSubagentDrain(watch, {
      drain,
      prompt: async (t) => void prompts.push(t),
      maxChildWaitMs: 5000,
      now: () => 3000,
    })

    // then: still running, not expired — no reminder yet
    await new Promise((r) => setTimeout(r, 5))
    expect(prompts).toEqual([])
    expect(reg.get('bg_young')?.status).toBe('running')

    // when: the child completes normally and wakes the loop
    reg.recordCompletion('bg_young', { ok: true, durationMs: 3000 })
    drain.stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'subagent.completed',
        taskId: 'bg_young',
        subagent: 'scout',
        parentSessionId: PARENT,
        ok: true,
        durationMs: 3000,
      },
    })

    await done
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('bg_young')
    expect(prompts[0]).not.toContain('FAILED')
  })

  test('expires only the overdue child, leaving a healthy sibling to complete', async () => {
    // given: one child wedged since t=0 and one that will complete normally
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_wedged', { startedAt: 0 })
    registerChild(reg, 'bg_ok', { startedAt: 5000 })
    reg.recordCompletion('bg_ok', { ok: true, durationMs: 100 })

    // when: clock past the ceiling for bg_wedged but not bg_ok
    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, {
      drain,
      prompt: async (t) => void prompts.push(t),
      maxChildWaitMs: 5000,
      now: () => 6000,
    })

    // then: both are delivered — ok as success, wedged as FAILED — and loop ends
    expect(prompts.length).toBe(2)
    expect(prompts.some((p) => p.includes('bg_ok') && !p.includes('FAILED'))).toBe(true)
    expect(prompts.some((p) => p.includes('bg_wedged') && p.includes('FAILED'))).toBe(true)
  })

  test("still terminates when the wedged child's abort() never settles", async () => {
    // given: a child whose abort hangs forever — awaiting it would wedge the drain
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_wedged', { startedAt: 0, abort: () => new Promise<void>(() => {}) })

    // when: clock past the ceiling
    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, {
      drain,
      prompt: async (t) => void prompts.push(t),
      maxChildWaitMs: 5000,
      now: () => 6000,
    })

    // then: the timeout was recorded and reminder delivered despite the hung abort
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('bg_wedged')
    expect(prompts[0]).toContain('FAILED')
    expect(reg.get('bg_wedged')?.status).toBe('failed')
  })

  test('a real completion racing the timeout does not double-settle (first writer wins)', async () => {
    // given: the timeout path settles the child first (clock past the ceiling)
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_race', { startedAt: 0 })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, {
      drain,
      prompt: async (t) => void prompts.push(t),
      maxChildWaitMs: 5000,
      now: () => 6000,
    })

    // when: the child's real (success) completion arrives afterwards
    const late = reg.recordCompletionIfRunning('bg_race', { ok: true, durationMs: 6000, finalMessage: 'late' })

    // then: it loses; the timeout outcome the model already saw stays canonical
    expect(late).toBe(false)
    expect(reg.get('bg_race')?.status).toBe('failed')
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('FAILED')
  })

  test('timeout winner preserves only final output captured before settlement and broadcasts metadata only', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_review', { startedAt: 0 })
    const review = '<review>\n<verdict>approve</verdict>\n</review>'
    reg.recordCapturedFinalMessageIfRunning('bg_review', review)
    const broadcasts: unknown[] = []
    drain.stream.subscribe({ target: { kind: 'broadcast' } }, (message) => broadcasts.push(message.payload))

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    await runSubagentDrain(watch, {
      drain,
      prompt: async (text) => void prompts.push(text),
      maxChildWaitMs: 5000,
      now: () => 6000,
    })

    const completion = reg.get('bg_review')?.completion
    expect(reg.get('bg_review')?.status).toBe('failed')
    expect(completion?.error).toContain('drain wait')
    expect(completion?.finalMessage).toBe(review)
    expect(prompts[0]).toContain('produced output before failing')
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]).toMatchObject({ ok: false, hasRecoverableOutput: true })
    expect(JSON.stringify(broadcasts[0])).not.toContain(review)

    expect(reg.recordCapturedFinalMessageIfRunning('bg_review', '<review>late</review>')).toBe(false)
    expect(reg.get('bg_review')?.completion?.finalMessage).toBe(review)
  })

  test('timeout winner does not claim recoverability for stale analysis captured as progress only', async () => {
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_analysis', { startedAt: 0 })
    reg.recordEvent('bg_analysis', { kind: 'message', preview: '<analysis>still working</analysis>', ts: 100 })
    const broadcasts: unknown[] = []
    drain.stream.subscribe({ target: { kind: 'broadcast' } }, (message) => broadcasts.push(message.payload))

    const watch = beginSubagentDrainWatch(drain)
    await runSubagentDrain(watch, {
      drain,
      prompt: async () => {},
      maxChildWaitMs: 5000,
      now: () => 6000,
    })

    expect(reg.get('bg_analysis')?.completion?.finalMessage).toBeUndefined()
    expect(broadcasts[0]).not.toHaveProperty('hasRecoverableOutput')
  })

  test('a timer expiry (no broadcast) wakes the loop and expires the child at the boundary', async () => {
    // given: a fake scheduler so the expiry timer fires on demand — deterministic,
    // no real clock. The child is within the ceiling at loop entry (clock=30 <
    // deadline=50), so the loop parks on the expiry TIMER, not on a broadcast.
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_timer', { startedAt: 0 })
    let clock = 30
    const sched = makeFakeScheduler()

    const watch = beginSubagentDrainWatch(drain, sched)
    const prompts: string[] = []
    const done = runSubagentDrain(watch, {
      drain,
      prompt: async (t) => void prompts.push(t),
      maxChildWaitMs: 50,
      now: () => clock,
    })

    // the loop is parked on the expiry timer, no broadcast, no reminder yet
    await Promise.resolve()
    expect(sched.setCount()).toBeGreaterThan(0)
    expect(prompts).toEqual([])

    // when: the deadline passes and the timer fires (returns true); re-derive expires it
    clock = 100
    sched.fire()

    // then: the timer-driven path (not a broadcast) drove expiry
    await done
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('bg_timer')
    expect(prompts[0]).toContain('FAILED')
  })

  test('a completion-broadcast wake CLEARS the pending expiry timer', async () => {
    // given: a child within the ceiling, so the loop parks on the expiry timer
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_wake', { startedAt: 0 })
    const sched = makeFakeScheduler()

    const watch = beginSubagentDrainWatch(drain, sched)
    const prompts: string[] = []
    const done = runSubagentDrain(watch, {
      drain,
      prompt: async (t) => void prompts.push(t),
      maxChildWaitMs: 50,
      now: () => 30,
    })
    await Promise.resolve()
    expect(sched.setCount()).toBe(1)
    expect(sched.hasPending()).toBe(true)

    // when: the child completes and a broadcast wake arrives before the timer
    reg.recordCompletion('bg_wake', { ok: true, durationMs: 30 })
    drain.stream.publish({
      target: { kind: 'broadcast' },
      payload: {
        kind: 'subagent.completed',
        taskId: 'bg_wake',
        subagent: 'scout',
        parentSessionId: PARENT,
        ok: true,
        durationMs: 30,
      },
    })
    await done

    // then: the wake cleared the pending timer (no leaked timer, no double-wake)
    expect(sched.clearCount()).toBe(1)
    expect(sched.hasPending()).toBe(false)
  })
})

describe('runSubagentDrain — stop() with a running child', () => {
  test('a stopped watch terminates instead of spinning forever on a still-running child', async () => {
    // given: a background child that never completes
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_stuck', { startedAt: 0 })

    const watch = beginSubagentDrainWatch(drain)
    const prompts: string[] = []
    const done = runSubagentDrain(watch, { drain, prompt: async (t) => void prompts.push(t) })

    // the loop parks on waitForWakeup (no ceiling, child still running)
    await new Promise((r) => setTimeout(r, 5))
    expect(prompts).toEqual([])

    // when: the watch is stopped (waitForWakeup resolves false)
    watch.stop()

    // then: the loop returns rather than busy-looping on the running child
    await done
    expect(prompts).toEqual([])
  })

  test('stop() CLEARS a pending expiry timer', async () => {
    // given: a child within the ceiling, so the loop parks on the expiry timer
    const { drain, reg } = makeDrain()
    registerChild(reg, 'bg_stuck', { startedAt: 0 })
    const sched = makeFakeScheduler()

    const watch = beginSubagentDrainWatch(drain, sched)
    const prompts: string[] = []
    const done = runSubagentDrain(watch, {
      drain,
      prompt: async (t) => void prompts.push(t),
      maxChildWaitMs: 50,
      now: () => 30,
    })
    await Promise.resolve()
    expect(sched.hasPending()).toBe(true)

    // when: the watch is stopped while the expiry timer is still pending
    watch.stop()
    await done

    // then: stop() cancelled the pending timer (it never fires after teardown)
    expect(sched.clearCount()).toBe(1)
    expect(sched.hasPending()).toBe(false)
    expect(prompts).toEqual([])
  })
})
