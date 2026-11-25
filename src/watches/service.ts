import { createHash } from 'node:crypto'

import { raceWithAbortSignal } from '@earendil-works/pi-ai/utils/abort'

import type { WatchRecord } from './store'
import { recordSchema, WatchStore } from './store'
import { conversationKey } from './target'
import type { WatchWakeTarget } from './types'
import type { ProbeResult } from './verdict'

const minute = 60_000,
  hour = 60 * minute,
  day = 24 * hour
export type WatchClock = { now: () => number; after: (ms: number, fn: () => Promise<void>) => () => void }
export const systemClock: WatchClock = {
  now: Date.now,
  after: (ms, fn) => {
    const t = setTimeout(() => {
      void fn().catch((e) => console.warn('[watch]', e))
    }, ms)
    return () => clearTimeout(t)
  },
}
type NewWatch = Pick<
  WatchRecord,
  'description' | 'mode' | 'probe' | 'createdByRole' | 'createdByOrigin' | 'wakeTarget'
> & { deadlineMs?: number }
export class WatchService {
  private running = false
  private cancelTimer?: () => void
  private readonly inflight = new Map<string, { controller: AbortController; task: Promise<void> }>()
  constructor(
    readonly store: WatchStore,
    private readonly run: (w: WatchRecord, s: AbortSignal) => Promise<ProbeResult>,
    private readonly cleanup: (id: string) => Promise<void>,
    private readonly pending: () => void,
    private readonly clock = systemClock,
  ) {}
  async start(afterRestore?: () => Promise<void>) {
    await this.store.restore()
    await afterRestore?.()
    for (const w of this.store.records) if (isEnded(w)) await this.cleanup(w.id)
    this.running = true
    this.arm()
    this.pending()
  }
  async stop() {
    this.running = false
    this.cancelTimer?.()
    for (const r of this.inflight.values()) r.controller.abort()
    await Promise.allSettled([...this.inflight.values()].map((r) => r.task))
  }
  async create(input: NewWatch) {
    const now = this.clock.now(),
      ttl = input.deadlineMs ?? 14 * day
    if (!(ttl > 0 && ttl <= 30 * day)) throw new Error('Watch deadline must be positive and at most 30 days')
    const record = recordSchema.parse({
      ...input,
      id: crypto.randomUUID(),
      createdAt: now,
      deadline: now + ttl,
      nextRunAt: now,
      status: 'active',
      consecutiveWakes: 0,
      consecutiveFailures: 0,
      pending: [],
    })
    await this.store.update((rows) => rows.push(record))
    this.arm()
    return record.id
  }
  async change(id: string, action: 'rearm' | 'cancel') {
    await this.store.update((rows) => {
      const w = rows.find((row) => row.id === id)
      if (!w || isEnded(w)) throw new Error('Watch is not live')
      if (action === 'cancel') {
        w.status = 'cancelled'
        w.pending = []
        return
      }
      if (w.status !== 'paused' || w.deadline <= this.clock.now())
        throw new Error('Only an unexpired paused watch can be rearmed')
      w.status = 'active'
      w.consecutiveWakes = 0
      w.nextRunAt = this.clock.now()
    })
    if (action === 'cancel') {
      const run = this.inflight.get(id)
      run?.controller.abort()
      await run?.task
      await this.cleanup(id)
    }
    this.arm()
  }
  async progress(target: WatchWakeTarget) {
    const key = conversationKey(target)
    const matches = (w: WatchRecord) =>
      w.status === 'active' && w.consecutiveWakes > 0 && conversationKey(w.wakeTarget) === key
    if (this.store.records.some(matches))
      await this.store.update((rows) => {
        for (const w of rows.filter(matches)) w.consecutiveWakes = 0
      })
  }
  private arm(retryMs = 0) {
    this.cancelTimer?.()
    if (!this.running || this.inflight.size >= 2) return
    const due = this.store.records.filter((w) => !isEnded(w) && !this.inflight.has(w.id)).map(dueAt)
    if (!due.length) return
    this.cancelTimer = this.clock.after(
      Math.min(2_147_483_647, Math.max(retryMs, Math.min(...due) - this.clock.now())),
      async () => {
        const tasks = []
        for (const w of this.store.records
          .filter((w) => !isEnded(w) && !this.inflight.has(w.id) && dueAt(w) <= this.clock.now())
          .sort((a, b) => dueAt(a) - dueAt(b))) {
          if (this.inflight.size >= 2) break
          const controller = new AbortController()
          let retry = 0
          const task = this.tick(w, controller.signal)
            .catch((e) => {
              retry = minute
              console.warn(`[watch] ${w.id}:`, e)
            })
            .finally(() => {
              this.inflight.delete(w.id)
              this.arm(retry)
            })
          this.inflight.set(w.id, { controller, task })
          tasks.push(task)
        }
        this.arm()
        await Promise.all(tasks)
      },
    )
  }
  private async tick(snapshot: WatchRecord, signal: AbortSignal) {
    let result: ProbeResult | undefined, failure: string | undefined
    if (snapshot.deadline > this.clock.now()) {
      // The service owns the slot; a hook or bundled probe need not cooperate
      // with abort. Timeout fails this attempt, not the watch's lifecycle.
      const timeout = new AbortController()
      const attempt = AbortSignal.any([signal, timeout.signal])
      const clearTimeout = this.clock.after(2 * minute, async () =>
        timeout.abort(new Error('Probe timed out after 120 seconds')),
      )
      try {
        result = await raceWithAbortSignal(this.run(snapshot, attempt), attempt)
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e)
      } finally {
        clearTimeout()
      }
    }
    if (signal.aborted) return
    const now = this.clock.now()
    await this.store.update((rows) => {
      const w = rows.find((row) => row.id === snapshot.id)
      if (!w || isEnded(w) || signal.aborted) return
      const wake = (summary: string, final = false) => {
        // Assign in the serialized verdict write, not at probe start: two
        // watches for one target can finish in either order.
        const sequence = 1 + rows.reduce((max, row) => Math.max(max, row.pending.at(-1)?.sequence ?? 0), 0)
        w.pending.push({ key: crypto.randomUUID(), summary: summary.slice(0, 16_384), final, sequence })
      }
      if (now >= w.deadline) {
        w.status = 'expired'
        wake('Watch expired.', true)
        return
      }
      w.lastRunAt = now
      const age = now - w.createdAt
      let interval = age < hour ? minute : age < day ? 5 * minute : age < 7 * day ? 15 * minute : 30 * minute
      if (!result) {
        w.consecutiveFailures++
        interval *= 2 ** Math.min(8, w.consecutiveFailures)
        if (w.consecutiveFailures === 3) {
          console.warn(`[watch] ${w.id}: three consecutive probe failures`)
          wake(`Probe failed three times: ${failure}`)
        }
      } else {
        w.consecutiveFailures = 0
        w.state = result.state
        interval = result.nextMs ?? interval
        const summary = result.summary || result.verdict
        const fingerprint = createHash('sha256').update(summary).digest('hex')
        if (result.verdict === 'done') {
          w.status = 'done'
          if (result.wake === true) wake(summary, true)
        } else if (result.verdict === 'wake' && fingerprint !== w.lastSummaryFingerprint) {
          w.lastSummaryFingerprint = fingerprint
          w.consecutiveWakes++
          if (w.consecutiveWakes >= 5) w.status = 'paused'
          wake(w.status === 'paused' ? `${summary}\nWatch paused; rearm to continue.` : summary)
        } else w.consecutiveWakes = 0
      }
      w.nextRunAt = Math.min(w.deadline, now + Math.max(minute, Math.min(hour, interval)))
    }, signal)
    if (signal.aborted) return
    this.pending()
    if (this.store.records.some((w) => w.id === snapshot.id && isEnded(w))) await this.cleanup(snapshot.id)
  }
}
function isEnded(w: WatchRecord) {
  return w.status !== 'active' && w.status !== 'paused'
}
function dueAt(w: WatchRecord) {
  return w.status === 'paused' ? w.deadline : Math.min(w.deadline, w.nextRunAt)
}
