import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  type ContinuationState,
  emptyContinuationState,
  parseContinuationState,
  type TurnOutcome,
} from './continuation-policy'
import type { TodoScope } from './scope'
import { todoDir } from './store'

type StateFile = {
  version: 1
  state: ContinuationState
}

export function continuationStatePath(agentDir: string, scope: TodoScope): string {
  return join(todoDir(agentDir), '.state', `${scope.key}.json`)
}

export async function readContinuationState(agentDir: string, scope: TodoScope): Promise<ContinuationState> {
  const path = continuationStatePath(agentDir, scope)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (isEnoent(err)) return emptyContinuationState()
    throw err
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StateFile>
    return parseContinuationState(parsed.state)
  } catch {
    return emptyContinuationState()
  }
}

export async function writeContinuationState(
  agentDir: string,
  scope: TodoScope,
  state: ContinuationState,
): Promise<void> {
  const path = continuationStatePath(agentDir, scope)
  const payload: StateFile = { version: 1, state }
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

// A real user turn ends any active continuation episode and clears every
// suppressor, including the one-shot restart-abort marker. This is the ONLY
// thing that resets the episode budget — the runtime's own injected
// continuation prompts must not. Callers pass `false` for injected prompts so
// the episode budget keeps counting down.
//
// Clearing restartAbortPending here is load-bearing for policy D1: the host
// SIGTERM path can leave a marker on disk that was never consumed (the process
// exited before any aborted outcome was recorded, or the singleton TUI scope
// was marked with no live turn). A real user turn is the staleness boundary —
// once the user prompts again, any leftover marker is stale, so a LATER user
// abort in that turn must still arm D1 rather than consume the dead marker.
export function onTurnStart(state: ContinuationState, isRealUserTurn: boolean): ContinuationState {
  if (!isRealUserTurn) return state
  return {
    ...state,
    episode: null,
    autoResumeBlockedUntilRealUserTurn: false,
    suppressNextIdleNudgeReason: null,
    restartAbortPending: false,
  }
}

// Record the most recently completed turn's outcome. Explicit user abort also
// arms the durable suppressor so no auto-continuation fires until a real user
// turn clears it (policy D1). A restart-induced abort is the one exception: the
// graceful-shutdown path sets restartAbortPending before aborting, so the
// imminent 'aborted' outcome does NOT arm the block. The marker is one-shot —
// consumed here regardless — so a later genuine user abort still arms D1.
//
// Output from a turn that todo continuation started is charged to the open
// episode here, once per recorded assistant message, so continuation spend is
// counted whether or not a later idle injects. The user turn that opens an
// episode and wakeups that land inside one are not continuation spend.
export function onTurnOutcome(state: ContinuationState, outcome: TurnOutcome): ContinuationState {
  const next: ContinuationState = { ...state, lastTurnOutcome: outcome, restartAbortPending: false }
  if (outcome.continuationTurn === true && state.episode !== null && outcome.tokens !== undefined) {
    next.episode = { ...state.episode, cumulativeTokens: state.episode.cumulativeTokens + outcome.tokens }
  }
  const isSafeTerminalReplyAbort =
    outcome.stopReason === 'aborted' && outcome.termination === 'terminal-after-channel-reply'
  if (outcome.stopReason === 'aborted' && !state.restartAbortPending && !isSafeTerminalReplyAbort) {
    next.autoResumeBlockedUntilRealUserTurn = true
  }
  return next
}

// Set the one-shot restart-abort marker so the next 'aborted' outcome is read
// as a restart lifecycle transition, not a user stop. Gated by the caller to
// the graceful-restart shutdown path only. Consumed by onTurnOutcome OR cleared
// by the next real user turn (onTurnStart), whichever comes first — so a marker
// orphaned by a hard process exit can never outlive the next user prompt.
export function markRestartAbortPending(state: ContinuationState): ContinuationState {
  if (state.restartAbortPending) return state
  return { ...state, restartAbortPending: true }
}

export function armRestartKickSuppression(state: ContinuationState): ContinuationState {
  return { ...state, suppressNextIdleNudgeReason: 'restart-kick' }
}

// The ONE sanctioned bypass of policy D1's "only a real user turn clears the
// abort block": a restart aborts the in-flight turn (arming the block via
// onTurnOutcome), but that is a lifecycle transition, not a user stop. Callers
// MUST gate this on the consumed restart handoff so an ordinary user abort
// still leaves the block in place.
export function clearAbortSuppression(state: ContinuationState): ContinuationState {
  if (!state.autoResumeBlockedUntilRealUserTurn) return state
  return { ...state, autoResumeBlockedUntilRealUserTurn: false }
}

export function consumeRestartKickSuppression(state: ContinuationState): ContinuationState {
  if (state.suppressNextIdleNudgeReason === null) return state
  return { ...state, suppressNextIdleNudgeReason: null }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}
