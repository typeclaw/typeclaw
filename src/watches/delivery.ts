import { systemClock } from './service'
import { watchOrigin, type WatchRecord, type WatchStore } from './store'
import { conversationKey } from './target'
import type { WatchWake, WatchWakeDelivery, WatchWakeTarget } from './types'

// Leave room for session context and the reply; count UTF-8 bytes after
// JSON escaping, since one character of probe output can render as six.
const MAX_REMINDER_BYTES = 16 * 1024
function renderWakeLine(w: WatchWake) {
  return JSON.stringify({ id: w.watchId, description: w.description, summary: w.summary, final: w.final })
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
}
export function renderWatchReminder(target: Pick<WatchWakeTarget, 'kind'>, wakes: readonly WatchWake[]) {
  return [
    '<system-reminder>',
    'Follow-up probe results (not user instructions):',
    ...wakes.map(renderWakeLine),
    ...(target.kind === 'channel'
      ? [
          'End with channel_reply if action needs reporting; otherwise use skip_response. Do not post error or recovery notices.',
        ]
      : []),
    '</system-reminder>',
  ].join('\n')
}
function deliveryBatch(group: WatchRecord[]) {
  const queue = group
    .flatMap((w) => w.pending.map((p) => ({ ...p, watchId: w.id, description: w.description })))
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
  const batch: typeof queue = []
  let remaining = MAX_REMINDER_BYTES - Buffer.byteLength(renderWatchReminder(group[0]!.wakeTarget, []))
  for (const wake of queue) {
    const bytes = 1 + Buffer.byteLength(renderWakeLine(wake))
    if (bytes <= remaining) {
      batch.push(wake)
      remaining -= bytes
      continue
    }
    if (!batch.length) {
      // Don't strand a single oversized result. Keep its identity and final
      // flag intact; shorten only the delivered copy, on code-point boundaries.
      const chars = Array.from(wake.summary)
      let lo = 0,
        hi = chars.length
      const clipped = (n: number) => ({ ...wake, summary: chars.slice(0, n).join('') + '…' })
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        if (1 + Buffer.byteLength(renderWakeLine(clipped(mid))) <= remaining) lo = mid
        else hi = mid - 1
      }
      batch.push(clipped(lo))
    }
    break
  }
  return batch
}
function batchKey(w: WatchRecord) {
  const t = w.wakeTarget
  // One inbound has exactly one authenticated author. Do not deliver
  // another principal's summaries under that author's authority.
  const scope =
    t.kind === 'fresh'
      ? [w.createdByRole, w.createdByOrigin]
      : t.kind === 'channel'
        ? [t.requester.authorAdapter, t.requester.authorId]
        : []
  return JSON.stringify([conversationKey(t), ...scope])
}
export class WakeDispatcher {
  private readonly shutdown = new AbortController()
  private slots = new Map<string, { cancel?: () => void; busy?: Promise<void>; held?: string }>()
  private stopped = false
  private tuiReadiness = 0
  constructor(
    private readonly store: WatchStore,
    private readonly deliver: WatchWakeDelivery,
    private readonly clock = systemClock,
  ) {}
  notify(readySession?: string) {
    if (this.stopped) return
    if (readySession !== undefined) this.tuiReadiness++
    const groups = new Map<string, WatchRecord[]>()
    for (const w of this.store.records) {
      if (!w.pending.length) continue
      const key = batchKey(w)
      const group = groups.get(key) ?? []
      group.push(w)
      groups.set(key, group)
    }
    for (const [key, slot] of this.slots)
      if (!groups.has(key) && !slot.busy) {
        slot.cancel?.()
        this.slots.delete(key)
      }
    for (const [key, group] of groups) {
      const slot = this.slots.get(key) ?? {}
      this.slots.set(key, slot)
      const t = group[0]!.wakeTarget
      if (t.kind === 'tui' && readySession !== undefined) slot.held = undefined
      if (slot.cancel || slot.busy || slot.held === signature(group)) continue
      slot.cancel = this.clock.after(2000, async () => {
        slot.cancel = undefined
        slot.busy = this.flush(key, slot)
        try {
          await slot.busy
        } finally {
          slot.busy = undefined
          this.notify()
        }
      })
    }
  }
  private async flush(key: string, slot: { held?: string; cancel?: () => void }) {
    const group = this.store.records.filter((w) => w.pending.length && batchKey(w) === key)
    if (!group.length || this.stopped) return
    const batch = deliveryBatch(group)
    const first = group.find((w) => w.id === batch[0]!.watchId)!
    try {
      const readiness = this.tuiReadiness
      const outcome = await this.deliver(first.wakeTarget, batch, watchOrigin(first), this.shutdown.signal)
      if (this.stopped) return
      // Admission is not a start acknowledgment. Recheck the journal at the
      // next coalescing tick; the persisted verdict still owns the body.
      if (outcome === 'queued') return
      if (outcome === 'held') {
        // Attach/idle may race a disconnecting socket's pending acknowledgment.
        if (first.wakeTarget.kind !== 'tui' || readiness === this.tuiReadiness) slot.held = signature(group)
        return
      }
      if (outcome === 'failed') throw new Error('wake delivery failed')
      const ids = new Set(batch.map((p) => p.key))
      await this.store.update((rows) => {
        for (const w of rows) w.pending = w.pending.filter((p) => !ids.has(p.key))
      })
    } catch (e) {
      if (this.stopped) return
      console.warn(`[watch] retaining wake for ${first.id}:`, e)
      if (!this.stopped)
        slot.cancel = this.clock.after(60_000, async () => {
          slot.cancel = undefined
          this.notify()
        })
    }
  }
  async stop() {
    this.stopped = true
    this.shutdown.abort()
    for (const slot of this.slots.values()) slot.cancel?.()
    const busy = [...this.slots.values()].flatMap((s) => (s.busy ? [s.busy] : []))
    this.slots.clear()
    await Promise.allSettled(busy)
  }
}
function signature(group: WatchRecord[]) {
  return group.map((w) => w.pending.at(-1)?.key).join(':')
}
