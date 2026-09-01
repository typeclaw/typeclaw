import { CronExpressionParser } from 'cron-parser'

import type { CronJob } from './schema'

export type SchedulerClock = {
  now: () => number
  setTimeout: (cb: () => void, ms: number) => number
  clearTimeout: (handle: number) => void
}

export type SchedulerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

// The scheduler uses the count store only to stop arming once a job's durable
// count is exhausted (an optimization) and to reconcile progress on reload.
// The authoritative count gate lives in the consumer, which owns accepted-fire
// accounting — the scheduler must not be the correctness boundary because it
// can't know whether the downstream coalescer will accept or skip a fire.
export type SchedulerCountStore = {
  get: (id: string, job: CronJob) => number
  reconcile: (jobs: CronJob[]) => Promise<void>
}

export type CreateSchedulerOptions = {
  jobs: CronJob[]
  onFire: (job: CronJob) => void
  clock?: SchedulerClock
  logger?: SchedulerLogger
  countStore?: SchedulerCountStore
}

export type JobDiff = {
  added: CronJob[]
  removed: CronJob[]
  updated: CronJob[]
  unchanged: CronJob[]
}

export type Scheduler = {
  start: () => void
  stop: () => void
  replaceJobs: (jobs: CronJob[]) => JobDiff
  currentJobs: () => readonly CronJob[]
}

const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
}

const consoleLogger: SchedulerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

// Node clamps delays greater than this to 1ms. Re-arm long waits instead of
// allowing an early callback to dispatch a future occurrence.
const maxTimeoutMs = 2 ** 31 - 1

export function createScheduler({
  jobs,
  onFire,
  clock = realClock,
  logger = consoleLogger,
  countStore,
}: CreateSchedulerOptions): Scheduler {
  const registry = new Map<string, CronJob>()
  for (const job of jobs) registry.set(job.id, job)

  const handles = new Map<string, number>()
  let started = false

  function currentEnabled(id: string): CronJob | null {
    const job = registry.get(id)
    if (!job || !job.enabled) return null
    return job
  }

  function scheduleNext(id: string): void {
    if (!started) return
    const job = currentEnabled(id)
    if (!job) return

    const firedCount = job.count !== undefined ? (countStore?.get(id, job) ?? 0) : 0
    const result = computeNextFire(job, clock.now(), { firedCount })
    if (!result.ok) {
      if (result.expired) {
        logger.info(`[cron] ${id} retired: ${result.reason}`)
      } else {
        logger.warn(
          `[cron] ${id} not scheduled: invalid schedule "${job.schedule ?? job.at}"${tzSuffix(job)}: ${result.reason}`,
        )
      }
      return
    }

    cancel(id)

    const delay = Math.max(0, result.nextFire - clock.now())
    const handle = clock.setTimeout(
      () => {
        handles.delete(id)
        if (!started) return
        const live = currentEnabled(id)
        if (!live) return
        if (clock.now() < result.nextFire) {
          scheduleNext(id)
          return
        }
        fire(live)
        scheduleNext(id)
      },
      Math.min(delay, maxTimeoutMs),
    )
    handles.set(id, handle)
  }

  function fire(job: CronJob): void {
    logger.info(`[cron] firing ${job.kind} ${job.id}`)
    try {
      onFire(job)
    } catch (err) {
      logger.error(`[cron] ${job.id} onFire threw synchronously: ${describe(err)}`)
    }
  }

  function cancel(id: string): void {
    const handle = handles.get(id)
    if (handle === undefined) return
    clock.clearTimeout(handle)
    handles.delete(id)
  }

  function diff(next: CronJob[]): JobDiff {
    const added: CronJob[] = []
    const removed: CronJob[] = []
    const updated: CronJob[] = []
    const unchanged: CronJob[] = []

    const nextById = new Map<string, CronJob>()
    for (const job of next) nextById.set(job.id, job)

    for (const [id, before] of registry) {
      const after = nextById.get(id)
      if (!after) {
        removed.push(before)
        continue
      }
      if (jobFingerprint(before) === jobFingerprint(after)) {
        unchanged.push(after)
      } else {
        updated.push(after)
      }
    }
    for (const [id, after] of nextById) {
      if (!registry.has(id)) added.push(after)
    }

    return { added, removed, updated, unchanged }
  }

  return {
    start() {
      if (started) return
      started = true
      for (const id of registry.keys()) scheduleNext(id)
    },
    stop() {
      started = false
      for (const handle of handles.values()) clock.clearTimeout(handle)
      handles.clear()
    },
    replaceJobs(next) {
      const result = diff(next)

      const newRegistry = new Map<string, CronJob>()
      for (const job of next) newRegistry.set(job.id, job)
      registry.clear()
      for (const [id, job] of newRegistry) registry.set(id, job)

      // Reconcile counts before arming so re-added/changed jobs don't inherit
      // stale progress. `reconcile` settles the authoritative in-memory map
      // synchronously; only the persist is async, so a failure there just means
      // disk lags the (correct) in-memory state — log it, don't fail the reload.
      countStore?.reconcile(next).catch((err) => {
        logger.error(`[cron] failed to persist count reconciliation: ${describe(err)}`)
      })

      for (const job of result.removed) cancel(job.id)
      for (const job of result.updated) {
        cancel(job.id)
        scheduleNext(job.id)
      }
      for (const job of result.added) scheduleNext(job.id)

      return result
    },
    currentJobs() {
      return [...registry.values()]
    },
  }
}

function jobFingerprint(job: CronJob): string {
  return JSON.stringify({
    schedule: job.schedule ?? null,
    at: job.at ?? null,
    until: job.until ?? null,
    count: job.count ?? null,
    enabled: job.enabled,
    timezone: job.timezone ?? null,
    kind: job.kind,
    payload: jobPayload(job),
  })
}

function jobPayload(job: CronJob): unknown {
  if (job.kind === 'prompt') return { prompt: job.prompt, subagent: job.subagent ?? null, payload: job.payload ?? null }
  if (job.kind === 'exec') return job.command
  // Use the handler's source as the discriminator. A constant placeholder
  // would make every handler fingerprint identically, so a plugin reload
  // that replaces the handler with a new implementation would be classified
  // as `unchanged` by `diff()` — the old function reference would keep
  // firing forever. `Function.prototype.toString()` returns the function's
  // declared source (deterministic per declaration site, changes when the
  // plugin module is re-imported with edits), which is the cheapest stable
  // discriminator without keeping a separate identity Map. JSON-safe.
  return { handler: String(job.handler) }
}

export type ComputeNextFireResult =
  | { ok: true; nextFire: number }
  // `expired` distinguishes a reached end-boundary (count/until/past `at`) from
  // a malformed schedule: the former is silent and final, the latter warns.
  | { ok: false; expired: true; reason: string }
  | { ok: false; expired: false; reason: string }

export type ComputeNextFireOptions = {
  // Accepted fires so far, sourced from the count store. Defaults to 0 so
  // callers that don't track counts (cron list rendering, pure schedule
  // preview) compute the raw next occurrence.
  firedCount?: number
}

export function computeNextFire(
  job: CronJob,
  now: number,
  options: ComputeNextFireOptions = {},
): ComputeNextFireResult {
  const firedCount = options.firedCount ?? 0
  if (job.count !== undefined && firedCount >= job.count) {
    return { ok: false, expired: true, reason: `count limit reached (${firedCount}/${job.count})` }
  }

  if (job.at !== undefined) {
    const at = Date.parse(job.at)
    if (Number.isNaN(at)) return { ok: false, expired: false, reason: `invalid "at": ${job.at}` }
    if (at <= now) return { ok: false, expired: true, reason: `one-shot "at" already elapsed` }
    return { ok: true, nextFire: at }
  }

  if (job.schedule === undefined) {
    return { ok: false, expired: false, reason: `job has neither "schedule" nor "at"` }
  }

  let nextFire: number
  try {
    const expr = CronExpressionParser.parse(job.schedule, {
      currentDate: new Date(now),
      ...(job.timezone ? { tz: job.timezone } : {}),
    })
    nextFire = expr.next().getTime()
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, expired: false, reason }
  }

  if (job.until !== undefined) {
    const until = Date.parse(job.until)
    if (!Number.isNaN(until) && nextFire > until) {
      return { ok: false, expired: true, reason: `next occurrence is after "until" (${job.until})` }
    }
  }

  return { ok: true, nextFire }
}

function tzSuffix(job: CronJob): string {
  return job.timezone ? ` (timezone "${job.timezone}")` : ''
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
