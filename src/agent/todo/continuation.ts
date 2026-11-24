import type { SessionOrigin } from '@/agent/session-origin'

import { type ContinuationLimits, DEFAULT_CONTINUATION_LIMITS, decideContinuation } from './continuation-policy'
import { consumeRestartKickSuppression, readContinuationState, writeContinuationState } from './continuation-state'
import { resolveTodoScope, type TodoScope } from './scope'
import { readTodoList } from './store'

export const TODO_CONTINUATION_SOURCE = 'todo-continuation'

export const CONTINUATION_PROMPT = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'Incomplete todo items remain in your list. Continue working on the next',
  'pending item now, without asking for permission. Mark each item complete (or',
  'cancelled) as you finish it by calling `todo_write` with the updated list. If',
  'you believe all the work is already done, do not just assert it — re-examine',
  'each remaining item skeptically, verify the work actually landed, and update',
  'the list accordingly. Once your `todo_write` leaves no incomplete items, the',
  'list is cleared for you automatically. Do not acknowledge or reply to this',
  'notice; just continue the work.',
  '',
  '---',
  '',
].join('\n')

// Skip reasons that fire on almost every idle and say nothing about pending
// work; operator logs omit them so the ones that matter stay readable.
const ROUTINE_SKIP_REASONS = new Set(['no-origin', 'no-scope', 'no-incomplete-todos'])

// One operator-log line for a continuation decision that involved pending
// work, or null when the decision is routine.
export function describeContinuationDecision(result: ContinuationInjectResult): string | null {
  if (result.kind === 'injected') return 'todo_continuation inject'
  return ROUTINE_SKIP_REASONS.has(result.reason) ? null : `todo_continuation skip reason=${result.reason}`
}

export type ContinuationInjectResult =
  | { kind: 'injected'; scope: TodoScope; text: string }
  | { kind: 'skipped'; reason: string }

export type MaybeInjectContinuationArgs = {
  agentDir: string
  origin: SessionOrigin | undefined
  now?: number
  limits?: ContinuationLimits
  newEpisodeId?: () => string
}

// Decide-and-persist entry point called from the idle path of each origin's
// drain loop. On `injected`, the caller is responsible for actually delivering
// `text` into the session (TUI: stream.publish; channel: pendingSystemReminders
// + drain). The episode mutation is persisted BEFORE returning so a crash
// between persist and deliver can only UNDER-count (fail-safe: a missed
// delivery costs one wasted budget slot, never an unbounded loop).
//
// The restart-kick one-shot is consumed here even on skip, so the first
// post-restart idle always burns the suppressor exactly once.
export async function maybeInjectContinuation(args: MaybeInjectContinuationArgs): Promise<ContinuationInjectResult> {
  if (args.origin === undefined) return { kind: 'skipped', reason: 'no-origin' }
  const scope = resolveTodoScope(args.origin)
  if (scope === null) return { kind: 'skipped', reason: 'no-scope' }

  const now = args.now ?? Date.now()
  const limits = args.limits ?? DEFAULT_CONTINUATION_LIMITS
  const newEpisodeId = args.newEpisodeId ?? (() => crypto.randomUUID())

  const { todos, updatedAt } = await readTodoList(args.agentDir, scope)
  const state = await readContinuationState(args.agentDir, scope)

  const decision = decideContinuation({ state, todos, listUpdatedAt: updatedAt, limits, now, newEpisodeId })

  if (decision.kind === 'skip') {
    if (state.suppressNextIdleNudgeReason !== null) {
      await writeContinuationState(args.agentDir, scope, consumeRestartKickSuppression(state))
    }
    return { kind: 'skipped', reason: decision.reason }
  }

  await writeContinuationState(args.agentDir, scope, { ...state, episode: decision.episode })
  return { kind: 'injected', scope, text: CONTINUATION_PROMPT }
}
