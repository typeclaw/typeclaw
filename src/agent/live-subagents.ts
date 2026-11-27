import type { Stream } from '@/stream'

import type { AgentSession } from './index'
import type { SubagentCompletedChannelKey } from './subagent-completion-reminder'

export type SubagentProgressEvent =
  | { kind: 'started'; ts: number }
  | { kind: 'tool'; name: string; ok: boolean; ts: number }
  | { kind: 'message'; preview: string; ts: number }

export type SubagentStatus = 'running' | 'completed' | 'failed'

export type SubagentCompletion = {
  ok: boolean
  finalMessage?: string
  error?: string
  // Settled by work-key cancellation: its work was invalidated, not failed.
  cancelled?: boolean
  durationMs: number
}

export type LiveSubagent = {
  taskId: string
  sessionId: string
  subagentName: string
  parentSessionId?: string
  // The spawning channel conversation, so a completion published on the child's
  // behalf can still reach a live successor after the parent session rolls over.
  channelKey?: SubagentCompletedChannelKey
  // From the accepted channel obligation, not inferred from the current speaker.
  watchTurnId?: string
  workKey?: string
  // Role that resolved at spawn time, captured for the provenance cap on
  // subagent_output/subagent_cancel. Absent when no permission service was
  // active at spawn, in which case the cap fails closed.
  spawnedByRole?: string
  // True when the spawn resolved to background mode. Only background spawns
  // deliver their result out-of-band (via the subagent.completed broadcast and
  // the parent's drain); foreground spawns return their result inline as the
  // tool result, so the drain MUST NOT re-prompt for them. See runSubagentDrain.
  background?: boolean
  startedAt: number
  // The subagent's declared `timeoutMs`, after which it settles itself as
  // failed. A parent drain waits at least this long before abandoning it.
  timeoutMs?: number
  status: SubagentStatus
  completion?: SubagentCompletion
  abort: () => Promise<void>
  releaseCoalesceKey?: () => void
}

export type PendingWorkKeyRegistration = {
  readonly workKey: string
  cancelled: boolean
}

export const MAX_EVENTS_PER_SUBAGENT = 100
export const MESSAGE_PREVIEW_CHARS = 200

const releasedAbort = async (): Promise<void> => {}

// Newest — not oldest — so a long-running child that crossed a caller's backstop
// cannot unpin a parent while a more recently spawned sibling is still inside its
// window. Foreground children are excluded on purpose: they return inline, so a
// parent is never left waiting on one.
// Omitted: session lifetime. null: ordinary channel work. An ID: precisely
// this watch turn's descendants, including siblings of a completed child.
export function newestRunningBackgroundChildStartedAt(
  children: readonly LiveSubagent[],
  watchTurnId?: string | null,
): number | null {
  return children.reduce<number | null>(
    (newest, child) =>
      child.status === 'running' &&
      child.background === true &&
      (watchTurnId === undefined || (child.watchTurnId ?? null) === watchTurnId) &&
      (newest === null || child.startedAt > newest)
        ? child.startedAt
        : newest,
    null,
  )
}

type AgentSessionEvent =
  | { type: 'message_update'; assistantMessageEvent: { type: string; delta?: string } }
  | { type: 'message_end'; message: unknown }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: string }

export function coarsen(event: AgentSessionEvent, now: number): SubagentProgressEvent | null {
  if (event.type === 'tool_execution_end') {
    const ev = event as Extract<AgentSessionEvent, { type: 'tool_execution_end' }>
    return { kind: 'tool', name: ev.toolName, ok: !ev.isError, ts: now }
  }
  if (event.type === 'message_end') {
    const ev = event as Extract<AgentSessionEvent, { type: 'message_end' }>
    const preview = extractMessagePreview(ev.message)
    if (preview === null) return null
    return { kind: 'message', preview, ts: now }
  }
  return null
}

function extractMessagePreview(message: unknown): string | null {
  if (message === null || typeof message !== 'object') return null
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed ? trimmed.slice(0, MESSAGE_PREVIEW_CHARS) : null
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const text = (part as { text?: unknown }).text
        if (typeof text === 'string') {
          const trimmed = text.trim()
          if (trimmed) return trimmed.slice(0, MESSAGE_PREVIEW_CHARS)
        }
      }
    }
  }
  return null
}

export type StatusSnapshot = {
  taskId: string
  sessionId: string
  subagentName: string
  status: SubagentStatus
  startedAt: number
  elapsedMs: number
  eventsCount: number
  eventsRecent: SubagentProgressEvent[]
  lastActivity: SubagentProgressEvent | null
  statusSummary: string
  completion?: SubagentCompletion
}

export class LiveSubagentRegistry {
  private readonly listeners = new Set<(parentSessionId: string | undefined) => void>()
  private readonly entries = new Map<string, LiveSubagent>()
  private readonly events = new Map<string, SubagentProgressEvent[]>()
  private readonly capturedFinalMessages = new Map<string, string>()
  private readonly pendingWorkKeyRegistrations = new Map<string, Set<PendingWorkKeyRegistration>>()

  subscribe(listener: (parentSessionId: string | undefined) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(parentSessionId: string | undefined): void {
    for (const listener of this.listeners) listener(parentSessionId)
  }

  register(live: LiveSubagent): void {
    if (this.entries.has(live.taskId)) {
      throw new Error(`task ${live.taskId} already registered`)
    }
    this.entries.set(live.taskId, live)
    this.events.set(live.taskId, [{ kind: 'started', ts: live.startedAt }])
    this.notify(live.parentSessionId)
  }

  beginWorkKeyRegistration(workKey: string): PendingWorkKeyRegistration {
    const registration: PendingWorkKeyRegistration = { workKey, cancelled: false }
    const pending = this.pendingWorkKeyRegistrations.get(workKey) ?? new Set<PendingWorkKeyRegistration>()
    pending.add(registration)
    this.pendingWorkKeyRegistrations.set(workKey, pending)
    return registration
  }

  abandonWorkKeyRegistration(registration: PendingWorkKeyRegistration): void {
    this.removePendingWorkKeyRegistration(registration)
  }

  registerIfWorkKeyActive(live: LiveSubagent, registration: PendingWorkKeyRegistration): boolean {
    this.removePendingWorkKeyRegistration(registration)
    if (live.workKey !== registration.workKey) {
      throw new Error(`task ${live.taskId} work key changed before registration`)
    }
    if (registration.cancelled) return false
    this.register(live)
    return true
  }

  unregister(taskId: string): void {
    const entry = this.entries.get(taskId)
    this.entries.delete(taskId)
    this.events.delete(taskId)
    this.capturedFinalMessages.delete(taskId)
    if (entry) this.notify(entry.parentSessionId)
  }

  // Called once the child's completion has settled. Its abort and coalesce-key
  // handles close over the child session, so keeping them would pin the child's
  // whole transcript for the life of the process. Every caller of those handles
  // acts only on running entries, so a settled entry never needs them, even when
  // a spawn timeout settled it before the session was torn down.
  release(taskId: string): void {
    const entry = this.entries.get(taskId)
    if (entry === undefined) return
    entry.abort = releasedAbort
    delete entry.releaseCoalesceKey
  }

  get(taskId: string): LiveSubagent | undefined {
    return this.entries.get(taskId)
  }

  list(filter?: { parentSessionId?: string }): LiveSubagent[] {
    const all = Array.from(this.entries.values())
    if (filter?.parentSessionId === undefined) return all
    return all.filter((e) => e.parentSessionId === filter.parentSessionId)
  }

  hasLiveForSession(sessionId: string): boolean {
    for (const e of this.entries.values()) {
      if (e.sessionId === sessionId && e.status === 'running') return true
    }
    return false
  }

  recordEvent(taskId: string, event: SubagentProgressEvent): void {
    const ring = this.events.get(taskId)
    if (ring === undefined) return
    ring.push(event)
    if (ring.length > MAX_EVENTS_PER_SUBAGENT) {
      ring.splice(0, ring.length - MAX_EVENTS_PER_SUBAGENT)
    }
  }

  recordCapturedFinalMessageIfRunning(taskId: string, finalMessage: string): boolean {
    const entry = this.entries.get(taskId)
    if (entry === undefined || entry.status !== 'running') return false
    this.capturedFinalMessages.set(taskId, finalMessage)
    return true
  }

  getCapturedFinalMessage(taskId: string): string | undefined {
    return this.capturedFinalMessages.get(taskId)
  }

  recordCompletion(taskId: string, completion: SubagentCompletion): void {
    const entry = this.entries.get(taskId)
    if (entry === undefined) return
    entry.completion = completion
    entry.status = completion.ok ? 'completed' : 'failed'
    this.notify(entry.parentSessionId)
  }

  // First-writer-wins settlement, returning whether THIS caller won. A subagent
  // has two racing settlement producers — its real completion (spawn_subagent's
  // `completion.then`) and the parent drain's timeout ceiling — and both must
  // not overwrite each other's terminal state, or the registry/broadcast would
  // disagree with a reminder already delivered. There is no `await` between the
  // status check and the mutation, so under JS run-to-completion this compare-
  // and-set is atomic: a promise `.then` producer that races in on a later
  // microtask sees `status !== 'running'` and loses. Production settlement paths
  // MUST use this, not the unconditional `recordCompletion` (which stays for
  // tests that seed terminal state directly).
  recordCompletionIfRunning(taskId: string, completion: SubagentCompletion): boolean {
    const entry = this.entries.get(taskId)
    if (entry === undefined || entry.status !== 'running') return false
    entry.completion = completion
    entry.status = completion.ok ? 'completed' : 'failed'
    this.notify(entry.parentSessionId)
    return true
  }

  async cancelRunningByWorkKey(
    workKey: string,
    reason: string,
    stream?: Stream,
  ): Promise<{ matched: number; cancelled: number; failures: number }> {
    const pending = this.pendingWorkKeyRegistrations.get(workKey)
    if (pending !== undefined) {
      for (const registration of pending) registration.cancelled = true
      this.pendingWorkKeyRegistrations.delete(workKey)
    }
    const all = Array.from(this.entries.values())
    const roots = all.filter((entry) => entry.status === 'running' && entry.workKey === workKey)
    if (roots.length === 0) return { matched: 0, cancelled: 0, failures: 0 }

    const rootsBySessionId = new Set(roots.map((entry) => entry.sessionId))
    const entriesBySessionId = new Map(all.map((entry) => [entry.sessionId, entry]))
    const rootTaskIds = new Set(roots.map((entry) => entry.taskId))
    const matched = all.filter(
      (entry) =>
        entry.status === 'running' &&
        (rootTaskIds.has(entry.taskId) || isDescendantOfAny(entry, rootsBySessionId, entriesBySessionId)),
    )

    const settledAt = Date.now()
    for (const entry of matched) {
      const error = `cancelled: ${reason}`
      const durationMs = Math.max(0, settledAt - entry.startedAt)
      if (!this.recordCompletionIfRunning(entry.taskId, { ok: false, error, cancelled: true, durationMs })) continue
      // Winning the settlement suppresses the child's own completion broadcast,
      // so publish this one: the parent learns of the cancellation through the
      // same reminder as any other failure, before an idle observer runs.
      if (stream === undefined || entry.background !== true || entry.parentSessionId === undefined) continue
      stream.publish({
        target: { kind: 'broadcast' },
        payload: {
          kind: 'subagent.completed',
          taskId: entry.taskId,
          subagent: entry.subagentName,
          parentSessionId: entry.parentSessionId,
          ok: false,
          durationMs,
          error,
          cancelled: true,
          ...(entry.channelKey !== undefined ? { channelKey: entry.channelKey } : {}),
        },
      })
    }
    for (const entry of matched) entry.releaseCoalesceKey?.()

    const outcomes = await Promise.all(
      matched.map(async (entry): Promise<boolean> => {
        try {
          await entry.abort()
          return true
        } catch {
          return false
        }
      }),
    )
    const cancelled = outcomes.filter(Boolean).length
    return { matched: matched.length, cancelled, failures: matched.length - cancelled }
  }

  snapshot(taskId: string, now: number = Date.now()): StatusSnapshot | undefined {
    const entry = this.entries.get(taskId)
    if (entry === undefined) return undefined
    const events = this.events.get(taskId) ?? []
    const eventsRecent = events.slice(-10)
    const lastActivity: SubagentProgressEvent | null = events.length > 0 ? (events[events.length - 1] ?? null) : null
    const elapsedMs = (entry.completion ? entry.startedAt + entry.completion.durationMs : now) - entry.startedAt
    return {
      taskId: entry.taskId,
      sessionId: entry.sessionId,
      subagentName: entry.subagentName,
      status: entry.status,
      startedAt: entry.startedAt,
      elapsedMs,
      eventsCount: events.length,
      eventsRecent,
      lastActivity,
      statusSummary: renderStatusSummary(entry, events.length, lastActivity, elapsedMs),
      ...(entry.completion ? { completion: entry.completion } : {}),
    }
  }

  clear(): void {
    // Shutdown must not erase evidence of children that have not terminated.
    const parents = new Set(Array.from(this.entries.values(), (entry) => entry.parentSessionId))
    this.entries.clear()
    this.events.clear()
    this.capturedFinalMessages.clear()
    this.pendingWorkKeyRegistrations.clear()
    for (const parent of parents) this.notify(parent)
  }

  private removePendingWorkKeyRegistration(registration: PendingWorkKeyRegistration): void {
    const pending = this.pendingWorkKeyRegistrations.get(registration.workKey)
    if (pending === undefined) return
    pending.delete(registration)
    if (pending.size === 0) this.pendingWorkKeyRegistrations.delete(registration.workKey)
  }
}

function isDescendantOfAny(
  entry: LiveSubagent,
  rootSessionIds: ReadonlySet<string>,
  entriesBySessionId: ReadonlyMap<string, LiveSubagent>,
): boolean {
  let parentSessionId = entry.parentSessionId
  const visited = new Set<string>()
  while (parentSessionId !== undefined && !visited.has(parentSessionId)) {
    if (rootSessionIds.has(parentSessionId)) return true
    visited.add(parentSessionId)
    parentSessionId = entriesBySessionId.get(parentSessionId)?.parentSessionId
  }
  return false
}

function renderStatusSummary(
  entry: LiveSubagent,
  eventsCount: number,
  lastActivity: SubagentProgressEvent | null,
  elapsedMs: number,
): string {
  const elapsed = formatElapsed(elapsedMs)
  if (entry.status === 'completed') return `Completed in ${elapsed}.`
  if (entry.status === 'failed') {
    const err = entry.completion?.error ?? 'unknown error'
    return `Failed after ${elapsed}: ${err}`
  }
  const last = describeLastActivity(lastActivity)
  return `Running for ${elapsed}. ${eventsCount} event${eventsCount === 1 ? '' : 's'} so far${last ? `. Last: ${last}` : ''}.`
}

function describeLastActivity(event: SubagentProgressEvent | null): string | null {
  if (event === null) return null
  if (event.kind === 'tool') return `${event.ok ? '' : 'failed '}tool ${event.name}`
  if (event.kind === 'message') {
    const preview = event.preview.length > 60 ? `${event.preview.slice(0, 60)}…` : event.preview
    return `message "${preview}"`
  }
  return null
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}m${sec}s`
}

export function attachProgressCapture(
  registry: LiveSubagentRegistry,
  taskId: string,
  session: Pick<AgentSession, 'subscribe'>,
): () => void {
  const unsubscribe = session.subscribe((event: unknown) => {
    const coarsened = coarsen(event as AgentSessionEvent, Date.now())
    if (coarsened !== null) {
      registry.recordEvent(taskId, coarsened)
    }
  })
  return () => {
    if (typeof unsubscribe === 'function') unsubscribe()
  }
}
