import { describe, expect, test } from 'bun:test'

import { createScheduler, type SchedulerClock, type SchedulerLogger } from './scheduler'
import type { CronJob } from './schema'

const silentLogger: SchedulerLogger = { info: () => {}, warn: () => {}, error: () => {} }

function createFakeClock(start = new Date('2026-01-01T00:00:00Z').getTime()): SchedulerClock & {
  advance: (ms: number) => Promise<void>
  fireNext: () => void
  handleCount: () => number
  setNow: (next: number) => void
} {
  let now = start
  const timers: Array<{ fireAt: number; cb: () => void; cancelled: boolean }> = []
  let nextHandle = 1
  const handles = new Map<number, (typeof timers)[number]>()

  return {
    now: () => now,
    setTimeout: (cb, ms) => {
      const timer = { fireAt: now + Math.max(0, ms), cb, cancelled: false }
      const handle = nextHandle++
      timers.push(timer)
      handles.set(handle, timer)
      return handle
    },
    clearTimeout: (handle) => {
      const timer = handles.get(handle)
      if (timer) timer.cancelled = true
    },
    advance: async (ms) => {
      const target = now + ms
      for (;;) {
        const due = timers.filter((t) => !t.cancelled && t.fireAt <= target).sort((a, b) => a.fireAt - b.fireAt)[0]
        if (!due) break
        now = due.fireAt
        due.cancelled = true
        due.cb()
        await new Promise((r) => setImmediate(r))
      }
      now = target
    },
    fireNext: () => {
      const next = timers.filter((t) => !t.cancelled).sort((a, b) => a.fireAt - b.fireAt)[0]
      if (!next) throw new Error('no timer to fire')
      next.cancelled = true
      next.cb()
    },
    handleCount: () => Array.from(handles.values()).filter((t) => !t.cancelled).length,
    setNow: (next) => {
      now = next
    },
  }
}

type FireRecord = { kind: CronJob['kind']; id: string; firedAt: number }

function createFireRecorder(): {
  fires: FireRecord[]
  firesByJob: Map<string, FireRecord[]>
  promptText: Map<string, string>
  onFire: (job: CronJob) => void
} {
  const fires: FireRecord[] = []
  const firesByJob = new Map<string, FireRecord[]>()
  const promptText = new Map<string, string>()
  return {
    fires,
    firesByJob,
    promptText,
    onFire: (job) => {
      const record: FireRecord = { kind: job.kind, id: job.id, firedAt: Date.now() }
      fires.push(record)
      const existing = firesByJob.get(job.id) ?? []
      existing.push(record)
      firesByJob.set(job.id, existing)
      if (job.kind === 'prompt') promptText.set(job.id, job.prompt)
    },
  }
}

type PromptOverrides = {
  enabled?: boolean
  timezone?: string
  prompt?: string
  subagent?: string
  payload?: unknown
}
type ExecOverrides = { enabled?: boolean; timezone?: string; command?: string[] }

const promptJob = (id: string, schedule: string, overrides: PromptOverrides = {}): CronJob => ({
  id,
  schedule,
  kind: 'prompt',
  prompt: overrides.prompt ?? `run ${id}`,
  enabled: overrides.enabled ?? true,
  ...(overrides.timezone !== undefined && { timezone: overrides.timezone }),
  ...(overrides.subagent !== undefined && { subagent: overrides.subagent }),
  ...(overrides.payload !== undefined && { payload: overrides.payload }),
})

const execJob = (id: string, schedule: string, overrides: ExecOverrides = {}): CronJob => ({
  id,
  schedule,
  kind: 'exec',
  command: overrides.command ?? ['echo', id],
  enabled: overrides.enabled ?? true,
  ...(overrides.timezone !== undefined && { timezone: overrides.timezone }),
})

const handlerJob = (id: string, schedule: string, handler: () => Promise<void>, enabled = true): CronJob => ({
  id,
  schedule,
  kind: 'handler',
  handler,
  enabled,
})

describe('createScheduler', () => {
  test('fires a prompt job at its scheduled time', async () => {
    const clock = createFakeClock(new Date('2026-01-01T00:00:00Z').getTime())
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('hourly', '0 * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(60 * 60 * 1000 + 100)

    expect(recorder.fires).toHaveLength(1)
    expect(recorder.fires[0]?.kind).toBe('prompt')
    expect(recorder.fires[0]?.id).toBe('hourly')

    scheduler.stop()
  })

  test('fires an exec job by passing the job to onFire', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [execJob('backup', '0 * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(60 * 60 * 1000 + 100)

    expect(recorder.fires).toEqual([expect.objectContaining({ kind: 'exec', id: 'backup' })])

    scheduler.stop()
  })

  test('fires repeatedly across multiple ticks', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('every-min', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(5 * 60 * 1000 + 100)

    expect(recorder.fires.length).toBeGreaterThanOrEqual(5)

    scheduler.stop()
  })

  test('skips disabled jobs', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('off', '* * * * *', { enabled: false })],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(10 * 60 * 1000)

    expect(recorder.fires).toHaveLength(0)

    scheduler.stop()
  })

  test('scheduler is fire-and-forget: it does not coalesce or wait for execution', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('every-min', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(5 * 60 * 1000 + 100)

    expect(recorder.fires.length).toBe(5)

    scheduler.stop()
  })

  test('does not fire a long-delay job when Node clamps an oversized timer', async () => {
    const clock = createFakeClock()
    const nodeMaxTimeoutMs = 2 ** 31 - 1
    const nodeLikeClock: SchedulerClock & Pick<typeof clock, 'advance'> = {
      ...clock,
      setTimeout: (cb, ms) => clock.setTimeout(cb, ms > nodeMaxTimeoutMs ? 1 : ms),
    }
    const recorder = createFireRecorder()
    const dueAt = new Date('2026-02-01T00:00:00Z').toISOString()
    const scheduler = createScheduler({
      jobs: [{ id: 'long-delay', at: dueAt, kind: 'prompt', prompt: 'run', enabled: true }],
      onFire: recorder.onFire,
      clock: nodeLikeClock,
      logger: silentLogger,
    })

    scheduler.start()
    await nodeLikeClock.advance(nodeMaxTimeoutMs)

    expect(recorder.fires).toHaveLength(0)

    await nodeLikeClock.advance(new Date(dueAt).getTime() - nodeLikeClock.now())

    expect(recorder.firesByJob.get('long-delay')).toHaveLength(1)

    scheduler.stop()
  })

  test('retains a long-delay occurrence across a backward clock adjustment', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const nodeMaxTimeoutMs = 2 ** 31 - 1
    const scheduler = createScheduler({
      jobs: [promptJob('monthly', '0 0 1 * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    clock.setNow(new Date('2025-12-15T00:00:00Z').getTime())
    clock.fireNext()
    await clock.advance(nodeMaxTimeoutMs)

    expect(recorder.fires).toHaveLength(0)

    await clock.advance(new Date('2026-02-01T00:00:00Z').getTime() - clock.now())

    expect(recorder.firesByJob.get('monthly')).toHaveLength(1)

    scheduler.stop()
  })

  test('stop() prevents future fires', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('j', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(60 * 1000 + 100)
    const firesBeforeStop = recorder.fires.length

    scheduler.stop()
    await clock.advance(10 * 60 * 1000)

    expect(recorder.fires.length).toBe(firesBeforeStop)
  })

  test('an onFire that throws synchronously does not crash the scheduler', async () => {
    const clock = createFakeClock()
    let fires = 0
    const scheduler = createScheduler({
      jobs: [promptJob('j', '* * * * *')],
      onFire: () => {
        fires++
        throw new Error('boom')
      },
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(3 * 60 * 1000 + 100)

    expect(fires).toBeGreaterThanOrEqual(2)

    scheduler.stop()
  })

  test('multiple jobs fire independently', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('a', '* * * * *'), execJob('b', '0 * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(60 * 60 * 1000 + 100)

    const ids = recorder.fires.map((c) => c.id)
    expect(ids).toContain('a')
    expect(ids).toContain('b')

    scheduler.stop()
  })

  test('start() is idempotent - double-start does not duplicate timers', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('j', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    scheduler.start()
    await clock.advance(60 * 1000 + 100)

    expect(recorder.fires).toHaveLength(1)

    scheduler.stop()
  })

  test('empty job list is a no-op', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({ jobs: [], onFire: recorder.onFire, clock, logger: silentLogger })

    scheduler.start()
    await clock.advance(60 * 60 * 1000)

    expect(recorder.fires).toHaveLength(0)

    scheduler.stop()
  })
})

describe('Scheduler.replaceJobs', () => {
  test('returns a diff describing what changed', () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('keep', '* * * * *'), promptJob('remove', '0 * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    scheduler.start()

    const diff = scheduler.replaceJobs([
      promptJob('keep', '* * * * *'),
      promptJob('add', '*/5 * * * *'),
      promptJob('remove', '0 * * * *', { prompt: 'changed prompt' }),
    ])

    expect(diff.added.map((j) => j.id)).toEqual(['add'])
    expect(diff.removed.map((j) => j.id)).toEqual([])
    expect(diff.updated.map((j) => j.id)).toEqual(['remove'])
    expect(diff.unchanged.map((j) => j.id)).toEqual(['keep'])

    scheduler.stop()
  })

  test('detects removal when a job id is no longer present', () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('a', '* * * * *'), promptJob('b', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    scheduler.start()

    const diff = scheduler.replaceJobs([promptJob('a', '* * * * *')])

    expect(diff.removed.map((j) => j.id)).toEqual(['b'])
    expect(diff.unchanged.map((j) => j.id)).toEqual(['a'])

    scheduler.stop()
  })

  test('treats schedule, prompt, command, kind, timezone, and enabled changes as updates', () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [
        promptJob('p1', '* * * * *'),
        promptJob('p2', '* * * * *', { timezone: 'UTC' }),
        execJob('e1', '0 * * * *'),
      ],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    scheduler.start()

    const diff = scheduler.replaceJobs([
      promptJob('p1', '*/2 * * * *'),
      promptJob('p2', '* * * * *', { timezone: 'Asia/Seoul' }),
      execJob('e1', '0 * * * *', { command: ['echo', 'changed'] }),
    ])

    expect(diff.updated.map((j) => j.id).sort()).toEqual(['e1', 'p1', 'p2'])

    scheduler.stop()
  })

  test('treats subagent and payload changes on a prompt job as updates', () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [
        promptJob('plain-to-subagent', '* * * * *'),
        promptJob('subagent-rename', '* * * * *', { subagent: 'old-name' }),
        promptJob('payload-change', '* * * * *', { subagent: 'dreaming', payload: { agentDir: '/old' } }),
        promptJob('untouched', '* * * * *', { subagent: 'memory-logger' }),
      ],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    scheduler.start()

    const diff = scheduler.replaceJobs([
      promptJob('plain-to-subagent', '* * * * *', { subagent: 'dreaming' }),
      promptJob('subagent-rename', '* * * * *', { subagent: 'new-name' }),
      promptJob('payload-change', '* * * * *', { subagent: 'dreaming', payload: { agentDir: '/new' } }),
      promptJob('untouched', '* * * * *', { subagent: 'memory-logger' }),
    ])

    expect(diff.updated.map((j) => j.id).sort()).toEqual(['payload-change', 'plain-to-subagent', 'subagent-rename'])
    expect(diff.unchanged.map((j) => j.id)).toEqual(['untouched'])

    scheduler.stop()
  })

  test('newly added jobs start firing on their schedule', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({ jobs: [], onFire: recorder.onFire, clock, logger: silentLogger })
    scheduler.start()

    scheduler.replaceJobs([promptJob('fresh', '* * * * *')])
    await clock.advance(60 * 1000 + 100)

    expect(recorder.fires.map((c) => c.id)).toEqual(['fresh'])

    scheduler.stop()
  })

  test('removed jobs stop firing immediately (their pending timer is cancelled)', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [promptJob('doomed', '* * * * *'), promptJob('survivor', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    scheduler.start()

    scheduler.replaceJobs([promptJob('survivor', '* * * * *')])
    await clock.advance(60 * 1000 + 100)

    const ids = recorder.fires.map((c) => c.id)
    expect(ids).toContain('survivor')
    expect(ids).not.toContain('doomed')

    scheduler.stop()
  })

  test('updated jobs use the new definition for the next fire', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const sched = createScheduler({
      jobs: [promptJob('mut', '* * * * *', { prompt: 'old' })],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    sched.start()

    sched.replaceJobs([promptJob('mut', '* * * * *', { prompt: 'new' })])
    await clock.advance(60 * 1000 + 100)

    expect(recorder.fires).toHaveLength(1)
    expect(recorder.firesByJob.get('mut')?.[0]?.kind).toBe('prompt')
    expect(recorder.promptText.get('mut')).toBe('new')

    sched.stop()
  })

  test('unchanged jobs keep their pending timer (no re-arming)', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const sched = createScheduler({
      jobs: [promptJob('keep', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    sched.start()

    const beforeHandles = clock.handleCount()
    sched.replaceJobs([promptJob('keep', '* * * * *')])
    const afterHandles = clock.handleCount()

    expect(afterHandles).toBe(beforeHandles)

    await clock.advance(60 * 1000 + 100)
    expect(recorder.fires).toHaveLength(1)

    sched.stop()
  })

  test('replaceJobs after stop() does not start anything', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const sched = createScheduler({ jobs: [], onFire: recorder.onFire, clock, logger: silentLogger })
    sched.start()
    sched.stop()

    sched.replaceJobs([promptJob('late', '* * * * *')])
    await clock.advance(60 * 1000 + 100)

    expect(recorder.fires).toHaveLength(0)
  })

  test('replaceJobs before start() is allowed; jobs go live on start()', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const sched = createScheduler({ jobs: [], onFire: recorder.onFire, clock, logger: silentLogger })

    sched.replaceJobs([promptJob('preset', '* * * * *')])
    await clock.advance(60 * 1000 + 100)
    expect(recorder.fires).toHaveLength(0)

    sched.start()
    await clock.advance(60 * 1000 + 100)
    expect(recorder.fires.map((c) => c.id)).toEqual(['preset'])

    sched.stop()
  })

  test('disabled-to-enabled transition is treated as an update and starts firing', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const sched = createScheduler({
      jobs: [promptJob('toggle', '* * * * *', { enabled: false })],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    sched.start()
    await clock.advance(5 * 60 * 1000)
    expect(recorder.fires).toHaveLength(0)

    sched.replaceJobs([promptJob('toggle', '* * * * *', { enabled: true })])
    await clock.advance(60 * 1000 + 100)

    expect(recorder.fires.map((c) => c.id)).toEqual(['toggle'])

    sched.stop()
  })

  test('enabled-to-disabled transition cancels future fires', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const sched = createScheduler({
      jobs: [promptJob('toggle', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    sched.start()

    sched.replaceJobs([promptJob('toggle', '* * * * *', { enabled: false })])
    await clock.advance(10 * 60 * 1000)

    expect(recorder.fires).toHaveLength(0)

    sched.stop()
  })
})

// The scheduler is NOT the count authority — the consumer is. The scheduler
// only reads `get` to STOP ARMING once the durable count is already exhausted.
// This fake models a store whose count is set externally (by the consumer).
function fixedCountStore(counts: Record<string, number> = {}): {
  get: (id: string, job: CronJob) => number
  reconcile: () => Promise<void>
} {
  return {
    get: (id) => counts[id] ?? 0,
    reconcile: async () => {},
  }
}

const countedPrompt = (id: string, schedule: string, count: number): CronJob => ({
  id,
  schedule,
  kind: 'prompt',
  prompt: `run ${id}`,
  enabled: true,
  count,
})

describe('end boundaries', () => {
  test('scheduler stops arming once the store reports the count is exhausted', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [countedPrompt('limited', '* * * * *', 3)],
      onFire: recorder.onFire,
      clock,
      countStore: fixedCountStore({ limited: 3 }),
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(10 * 60 * 1000 + 100)

    expect(recorder.firesByJob.get('limited')).toBeUndefined()

    scheduler.stop()
  })

  test('scheduler keeps arming while the store reports count below the limit', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [countedPrompt('limited', '* * * * *', 3)],
      onFire: recorder.onFire,
      clock,
      countStore: fixedCountStore({ limited: 1 }),
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(3 * 60 * 1000 + 100)

    // count never advances in this fake (consumer would), so it keeps firing —
    // proving the scheduler is not the gate, only an arming optimization.
    expect((recorder.firesByJob.get('limited') ?? []).length).toBeGreaterThanOrEqual(3)

    scheduler.stop()
  })

  test('until stops a recurring job after the boundary instant', async () => {
    const clock = createFakeClock(new Date('2026-01-01T00:00:00Z').getTime())
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [
        {
          id: 'bounded',
          schedule: '* * * * *',
          kind: 'prompt',
          prompt: 'run',
          enabled: true,
          until: '2026-01-01T00:03:00Z',
        },
      ],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(10 * 60 * 1000 + 100)

    expect(recorder.firesByJob.get('bounded')).toHaveLength(3)

    scheduler.stop()
  })

  test('an "at" job fires exactly once then retires', async () => {
    const clock = createFakeClock(new Date('2026-01-01T00:00:00Z').getTime())
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [{ id: 'oneshot', at: '2026-01-01T00:05:00Z', kind: 'prompt', prompt: 'remind', enabled: true }],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(60 * 60 * 1000)

    expect(recorder.firesByJob.get('oneshot')).toHaveLength(1)

    scheduler.stop()
  })

  test('count + until: scheduler stops arming when the store reports count exhausted before until', async () => {
    const clock = createFakeClock(new Date('2026-01-01T00:00:00Z').getTime())
    const recorder = createFireRecorder()
    const scheduler = createScheduler({
      jobs: [
        {
          id: 'both',
          schedule: '* * * * *',
          kind: 'prompt',
          prompt: 'run',
          enabled: true,
          until: '2026-01-01T00:10:00Z',
          count: 2,
        },
      ],
      onFire: recorder.onFire,
      clock,
      countStore: fixedCountStore({ both: 2 }),
      logger: silentLogger,
    })

    scheduler.start()
    await clock.advance(20 * 60 * 1000)

    expect(recorder.firesByJob.get('both')).toBeUndefined()

    scheduler.stop()
  })
})

describe('schedule failure surfacing', () => {
  function createCapturingLogger(): SchedulerLogger & { warns: string[]; errors: string[] } {
    const warns: string[] = []
    const errors: string[] = []
    return {
      info: () => {},
      warn: (m) => warns.push(m),
      error: (m) => errors.push(m),
      warns,
      errors,
    }
  }

  test('logs a warning naming the job id and parse error when schedule cannot be parsed', () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const logger = createCapturingLogger()
    const scheduler = createScheduler({
      jobs: [promptJob('broken', 'not a real schedule')],
      onFire: recorder.onFire,
      clock,
      logger,
    })

    scheduler.start()

    expect(logger.warns).toHaveLength(1)
    expect(logger.warns[0]).toContain('broken')
    expect(logger.warns[0]).toMatch(/schedule|parse|invalid/i)

    scheduler.stop()
  })

  test('logs a warning when timezone is unresolvable at runtime', () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const logger = createCapturingLogger()
    const scheduler = createScheduler({
      jobs: [promptJob('bad-tz', '* * * * *', { timezone: 'Not/A_Real_Zone' })],
      onFire: recorder.onFire,
      clock,
      logger,
    })

    scheduler.start()

    expect(logger.warns).toHaveLength(1)
    expect(logger.warns[0]).toContain('bad-tz')
    expect(logger.warns[0]).toContain('Not/A_Real_Zone')
  })

  test('a single broken schedule does not block sibling jobs from firing', async () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const logger = createCapturingLogger()
    const scheduler = createScheduler({
      jobs: [promptJob('broken', 'not a real schedule'), promptJob('healthy', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger,
    })

    scheduler.start()
    await clock.advance(60 * 1000 + 100)

    expect(recorder.fires.map((c) => c.id)).toEqual(['healthy'])
    expect(logger.warns.some((w) => w.includes('broken'))).toBe(true)

    scheduler.stop()
  })

  test('replaceJobs warns when an added job has an unparseable schedule', () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const logger = createCapturingLogger()
    const scheduler = createScheduler({
      jobs: [promptJob('healthy', '* * * * *')],
      onFire: recorder.onFire,
      clock,
      logger,
    })
    scheduler.start()
    expect(logger.warns).toHaveLength(0)

    scheduler.replaceJobs([promptJob('healthy', '* * * * *'), promptJob('broken', 'not a real schedule')])

    expect(logger.warns.some((w) => w.includes('broken'))).toBe(true)

    scheduler.stop()
  })

  test('warning is emitted only once per scheduling attempt, not on every reload of an unchanged broken job', () => {
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const logger = createCapturingLogger()
    const scheduler = createScheduler({
      jobs: [promptJob('broken', 'not a real schedule')],
      onFire: recorder.onFire,
      clock,
      logger,
    })
    scheduler.start()
    const warnsAfterStart = logger.warns.length

    scheduler.replaceJobs([promptJob('broken', 'not a real schedule')])

    expect(logger.warns.length).toBe(warnsAfterStart)

    scheduler.stop()
  })

  test('replaceJobs reclassifies a handler job as updated when the function reference changes', () => {
    // given
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    let calls = 0
    const initialHandler = async (): Promise<void> => {
      calls += 1
    }
    const scheduler = createScheduler({
      jobs: [handlerJob('watch', '*/5 * * * *', initialHandler)],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    scheduler.start()

    // when a plugin reload replaces the handler with a different function body
    const replacementHandler = async (): Promise<void> => {
      calls += 2
    }
    const diff = scheduler.replaceJobs([handlerJob('watch', '*/5 * * * *', replacementHandler)])

    // then: classified as updated, not unchanged. Otherwise replaceJobs would
    // keep the old timer pointing at initialHandler and replacementHandler
    // would never fire.
    expect(diff.updated.map((j) => j.id)).toEqual(['watch'])
    expect(diff.unchanged).toHaveLength(0)

    scheduler.stop()
  })

  test('replaceJobs classifies a handler job as unchanged when the function reference is the same', () => {
    // given
    const clock = createFakeClock()
    const recorder = createFireRecorder()
    const handler = async (): Promise<void> => {}
    const scheduler = createScheduler({
      jobs: [handlerJob('watch', '*/5 * * * *', handler)],
      onFire: recorder.onFire,
      clock,
      logger: silentLogger,
    })
    scheduler.start()

    // when replaceJobs runs with the SAME handler reference
    const diff = scheduler.replaceJobs([handlerJob('watch', '*/5 * * * *', handler)])

    // then
    expect(diff.unchanged.map((j) => j.id)).toEqual(['watch'])
    expect(diff.updated).toHaveLength(0)

    scheduler.stop()
  })
})
