import type { SessionOrigin } from '@/agent/session-origin'

import { maybeInjectContinuation } from './continuation'
import { type TurnOutcome } from './continuation-policy'
import {
  armRestartKickSuppression,
  clearAbortSuppression,
  markRestartAbortPending,
  onTurnOutcome,
  onTurnStart,
  readContinuationState,
  writeContinuationState,
} from './continuation-state'
import { resolveTodoScope } from './scope'
import { writeTodos } from './store'

// Map a pi `message_end` event's stopReason onto the TurnOutcome stopReason
// space. Anything we don't recognize collapses to 'unknown' so the idle path
// fails closed (no auto-injection on an outcome we can't classify). 'length'
// is preserved (not collapsed) because a budget-truncated turn is a legitimate
// unfinished turn the continuation guards should be allowed to resume.
export function classifyStopReason(raw: unknown): TurnOutcome['stopReason'] {
  if (raw === 'stop' || raw === 'length' || raw === 'aborted' || raw === 'error') return raw
  return 'unknown'
}

// Extract the stopReason and token usage from a pi `message_end` event.
// Returns null for any event that is not an assistant message_end. `tokens`
// is the assistant message's `usage.output`: the work the model did. Input and
// cache counts re-bill the whole context on every request, so they track
// context size and provider caching, not continuation cost. It is undefined
// when the provider did not report usage.
export function extractTurnUsage(event: unknown): { stopReason: TurnOutcome['stopReason']; tokens?: number } | null {
  if (typeof event !== 'object' || event === null) return null
  const e = event as { type?: unknown; message?: unknown }
  if (e.type !== 'message_end') return null
  const message = e.message as { role?: unknown; stopReason?: unknown; usage?: unknown } | undefined
  if (message?.role !== 'assistant') return null
  const usage = message.usage as { output?: unknown } | undefined
  const output = usage?.output
  const tokens = typeof output === 'number' && Number.isFinite(output) ? output : undefined
  return { stopReason: classifyStopReason(message.stopReason), ...(tokens !== undefined ? { tokens } : {}) }
}

export function extractStopReason(event: unknown): TurnOutcome['stopReason'] | null {
  return extractTurnUsage(event)?.stopReason ?? null
}

// Persist the just-completed turn's outcome for a scope. No-op for origins
// without a todo scope (subagent/system). Safe to call from a subscription
// callback; it swallows nothing — callers wrap as they see fit.
export async function recordTurnOutcome(args: {
  agentDir: string
  origin: SessionOrigin
  turnId: string
  stopReason: TurnOutcome['stopReason']
  termination?: TurnOutcome['termination']
  tokens?: number
  continuationTurn?: boolean
  now?: number
}): Promise<void> {
  const scope = resolveTodoScope(args.origin)
  if (scope === null) return
  const state = await readContinuationState(args.agentDir, scope)
  const outcome: TurnOutcome = {
    turnId: args.turnId,
    stopReason: args.stopReason,
    endedAt: args.now ?? Date.now(),
    ...(args.termination !== undefined ? { termination: args.termination } : {}),
    ...(args.tokens !== undefined ? { tokens: args.tokens } : {}),
    ...(args.continuationTurn === true ? { continuationTurn: true as const } : {}),
  }
  await writeContinuationState(args.agentDir, scope, onTurnOutcome(state, outcome))
}

// Mark the recorded outcome as a turn that handed output back to the person.
// Called at idle rather than when the outcome is written, because a channel
// turn can still deliver its final prose after its last assistant message
// ends. No-op for scopeless origins or before any outcome exists.
export async function recordTurnHandBack(args: { agentDir: string; origin: SessionOrigin }): Promise<void> {
  const scope = resolveTodoScope(args.origin)
  if (scope === null) return
  const state = await readContinuationState(args.agentDir, scope)
  if (state.lastTurnOutcome === null) return
  await writeContinuationState(args.agentDir, scope, {
    ...state,
    lastTurnOutcome: { ...state.lastTurnOutcome, deliveredAfterTodoWrite: true },
  })
}

// Reset the continuation episode at the start of a REAL user turn. Injected
// continuation turns pass isRealUserTurn=false so the episode budget keeps
// counting down. No-op for scopeless origins.
export async function recordTurnStart(args: {
  agentDir: string
  origin: SessionOrigin
  isRealUserTurn: boolean
}): Promise<void> {
  const scope = resolveTodoScope(args.origin)
  if (scope === null) return
  const state = await readContinuationState(args.agentDir, scope)
  const next = onTurnStart(state, args.isRealUserTurn)
  if (next !== state) await writeContinuationState(args.agentDir, scope, next)
}

// Arm the one-shot restart-kick suppressor for an origin's scope, so the first
// idle after a restart skips exactly one continuation injection (the restart
// kick prompt owns that turn). No-op for scopeless origins.
export async function armRestartKickForOrigin(agentDir: string, origin: SessionOrigin): Promise<void> {
  const scope = resolveTodoScope(origin)
  if (scope === null) return
  const state = await readContinuationState(agentDir, scope)
  await writeContinuationState(agentDir, scope, armRestartKickSuppression(state))
}

// Mark an origin's scope so the imminent restart-induced abort does not arm the
// durable user-abort block. Called by the graceful-restart shutdown BEFORE it
// aborts the in-flight turn, so onTurnOutcome reads the marker when it records
// the 'aborted' outcome. No-op for scopeless origins.
export async function markRestartAbortPendingForOrigin(agentDir: string, origin: SessionOrigin): Promise<void> {
  const scope = resolveTodoScope(origin)
  if (scope === null) return
  const state = await readContinuationState(agentDir, scope)
  const next = markRestartAbortPending(state)
  if (next !== state) await writeContinuationState(agentDir, scope, next)
}

// Clear the durable user-abort suppressor for an origin's scope on a restart
// resume, so a turn aborted by the restart itself does not permanently block
// auto-continuation. Gated by the caller to the restart-handoff path only.
// No-op for scopeless origins.
export async function clearAbortSuppressionForOrigin(agentDir: string, origin: SessionOrigin): Promise<void> {
  const scope = resolveTodoScope(origin)
  if (scope === null) return
  const state = await readContinuationState(agentDir, scope)
  const next = clearAbortSuppression(state)
  if (next !== state) await writeContinuationState(agentDir, scope, next)
}

// Empty the todo list for an origin's scope. No-op for scopeless origins.
export async function clearTodosForOrigin(agentDir: string, origin: SessionOrigin): Promise<void> {
  const scope = resolveTodoScope(origin)
  if (scope === null) return
  await writeTodos(agentDir, scope, [])
}

export type DeliverContinuation = (text: string) => void

// Idle-path entry: decide whether to nudge and, if so, deliver via the
// origin-appropriate mechanism the caller supplies. Returns true if a nudge
// was delivered. The decide-and-persist step happens inside
// maybeInjectContinuation; delivery is the only side effect the caller owns.
export async function runIdleContinuation(args: {
  agentDir: string
  origin: SessionOrigin
  deliver: DeliverContinuation
}): Promise<boolean> {
  const result = await maybeInjectContinuation({ agentDir: args.agentDir, origin: args.origin })
  if (result.kind !== 'injected') return false
  args.deliver(result.text)
  return true
}
