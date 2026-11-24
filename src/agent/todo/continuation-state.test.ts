import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type ContinuationEpisode,
  type ContinuationState,
  emptyContinuationState,
  type TurnOutcome,
} from './continuation-policy'
import {
  armRestartKickSuppression,
  consumeRestartKickSuppression,
  markRestartAbortPending,
  onTurnOutcome,
  onTurnStart,
  readContinuationState,
  writeContinuationState,
} from './continuation-state'
import type { TodoScope } from './scope'

const SCOPE: TodoScope = { kind: 'tui', key: 'tui' }

const EPISODE: ContinuationEpisode = {
  episodeId: 'e1',
  startedAt: 100,
  autoTurnCount: 2,
  cumulativeTokens: 5000,
  failureCount: 0,
  stagnationCount: 1,
  lastIncompleteHash: 'abc',
}

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-cont-state-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('continuation-state persistence', () => {
  test('reading a non-existent scope returns the empty state', async () => {
    expect(await readContinuationState(agentDir, SCOPE)).toEqual(emptyContinuationState())
  })

  test('write then read round-trips and survives a simulated restart', async () => {
    const state: ContinuationState = {
      episode: EPISODE,
      lastTurnOutcome: { turnId: 't', stopReason: 'stop', endedAt: 1 },
      suppressNextIdleNudgeReason: null,
      autoResumeBlockedUntilRealUserTurn: false,
      restartAbortPending: false,
    }
    await writeContinuationState(agentDir, SCOPE, state)
    expect(await readContinuationState(agentDir, SCOPE)).toEqual(state)
  })

  test('corrupt state file falls back to empty (fail-closed)', async () => {
    await writeContinuationState(agentDir, SCOPE, emptyContinuationState())
    const { writeFile } = await import('node:fs/promises')
    const { continuationStatePath } = await import('./continuation-state')
    await writeFile(continuationStatePath(agentDir, SCOPE), 'not json{{', 'utf8')
    expect(await readContinuationState(agentDir, SCOPE)).toEqual(emptyContinuationState())
  })

  test('a partially-written episode is dropped on read, not trusted', async () => {
    const { writeFile } = await import('node:fs/promises')
    const { continuationStatePath } = await import('./continuation-state')
    const { mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    const path = continuationStatePath(agentDir, SCOPE)
    await mkdir(dirname(path), { recursive: true })
    // valid JSON, but episode is missing its numeric counters
    await writeFile(path, JSON.stringify({ version: 1, state: { episode: { episodeId: 'e' } } }), 'utf8')
    const loaded = await readContinuationState(agentDir, SCOPE)
    expect(loaded.episode).toBeNull()
  })
})

describe('onTurnStart', () => {
  test('a real user turn resets the episode and clears suppressors', () => {
    const state: ContinuationState = {
      episode: EPISODE,
      lastTurnOutcome: null,
      suppressNextIdleNudgeReason: 'restart-kick',
      autoResumeBlockedUntilRealUserTurn: true,
      restartAbortPending: true,
    }
    const next = onTurnStart(state, true)
    expect(next.episode).toBeNull()
    expect(next.suppressNextIdleNudgeReason).toBeNull()
    expect(next.autoResumeBlockedUntilRealUserTurn).toBe(false)
    expect(next.restartAbortPending).toBe(false)
  })

  test('an injected (non-user) turn does NOT reset the episode budget', () => {
    const state: ContinuationState = { ...emptyContinuationState(), episode: EPISODE }
    expect(onTurnStart(state, false)).toBe(state)
  })

  // Regression: a restart marker orphaned by a hard process exit (no aborted
  // outcome ever recorded — e.g. the singleton TUI scope marked with no live
  // turn) must NOT survive into the next user turn and downgrade a genuine user
  // abort. The real user turn clears the stale marker, so the user's later
  // abort still arms D1.
  test('a stale restart marker does not suppress D1 for a later genuine user abort', () => {
    // given a marker left on disk by a restart, with no outcome recorded
    const stale: ContinuationState = { ...emptyContinuationState(), restartAbortPending: true }
    // when the user prompts again (real user turn) and then aborts that turn
    const afterUserPrompt = onTurnStart(stale, true)
    expect(afterUserPrompt.restartAbortPending).toBe(false)
    const afterUserAbort = onTurnOutcome(afterUserPrompt, { turnId: 'u1', stopReason: 'aborted', endedAt: 1 })
    // then D1 arms — the stale marker did not classify it as restart-induced
    expect(afterUserAbort.autoResumeBlockedUntilRealUserTurn).toBe(true)
  })
})

describe('onTurnOutcome', () => {
  test('records the outcome', () => {
    const outcome: TurnOutcome = { turnId: 't', stopReason: 'stop', endedAt: 9 }
    expect(onTurnOutcome(emptyContinuationState(), outcome).lastTurnOutcome).toEqual(outcome)
  })

  test('a user abort arms the durable suppressor', () => {
    const outcome: TurnOutcome = { turnId: 't', stopReason: 'aborted', endedAt: 9 }
    const next = onTurnOutcome(emptyContinuationState(), outcome)
    expect(next.autoResumeBlockedUntilRealUserTurn).toBe(true)
  })

  test('a terminal channel-reply abort does not arm the durable suppressor', () => {
    const outcome: TurnOutcome = {
      turnId: 't',
      stopReason: 'aborted',
      termination: 'terminal-after-channel-reply',
      endedAt: 9,
    }
    const next = onTurnOutcome(emptyContinuationState(), outcome)
    expect(next.autoResumeBlockedUntilRealUserTurn).toBe(false)
  })

  test('a normal stop does not arm the suppressor', () => {
    const outcome: TurnOutcome = { turnId: 't', stopReason: 'stop', endedAt: 9 }
    expect(onTurnOutcome(emptyContinuationState(), outcome).autoResumeBlockedUntilRealUserTurn).toBe(false)
  })

  test('a restart-induced abort does NOT arm the suppressor and consumes the marker', () => {
    const outcome: TurnOutcome = { turnId: 't', stopReason: 'aborted', endedAt: 9 }
    const marked = markRestartAbortPending(emptyContinuationState())
    const next = onTurnOutcome(marked, outcome)
    expect(next.autoResumeBlockedUntilRealUserTurn).toBe(false)
    expect(next.restartAbortPending).toBe(false)
  })

  test('the marker is one-shot: a later genuine abort still arms the suppressor', () => {
    const firstAbort = onTurnOutcome(markRestartAbortPending(emptyContinuationState()), {
      turnId: 't1',
      stopReason: 'aborted',
      endedAt: 1,
    })
    const secondAbort = onTurnOutcome(firstAbort, { turnId: 't2', stopReason: 'aborted', endedAt: 2 })
    expect(secondAbort.autoResumeBlockedUntilRealUserTurn).toBe(true)
  })
})

describe('markRestartAbortPending', () => {
  test('sets the one-shot marker', () => {
    expect(markRestartAbortPending(emptyContinuationState()).restartAbortPending).toBe(true)
  })

  test('is idempotent', () => {
    const once = markRestartAbortPending(emptyContinuationState())
    expect(markRestartAbortPending(once)).toBe(once)
  })
})

describe('restart-kick suppression', () => {
  test('arm then consume is a one-shot', () => {
    const armed = armRestartKickSuppression(emptyContinuationState())
    expect(armed.suppressNextIdleNudgeReason).toBe('restart-kick')
    const consumed = consumeRestartKickSuppression(armed)
    expect(consumed.suppressNextIdleNudgeReason).toBeNull()
  })
})

describe('onTurnOutcome continuation spend', () => {
  const OUTCOME: TurnOutcome = { turnId: 't', stopReason: 'stop', endedAt: 1, tokens: 11_000 }
  const base = (): ContinuationState => ({
    ...emptyContinuationState(),
    episode: { ...EPISODE, cumulativeTokens: 9_000 },
  })

  test('charges each continuation message to the open episode as it is recorded', () => {
    const first = onTurnOutcome(base(), { ...OUTCOME, tokens: 400, continuationTurn: true })
    const second = onTurnOutcome(first, { ...OUTCOME, tokens: 600, continuationTurn: true })
    expect(second.episode?.cumulativeTokens).toBe(10_000)
  })

  test('does not charge a wakeup or user turn with the same usage', () => {
    expect(onTurnOutcome(base(), OUTCOME).episode?.cumulativeTokens).toBe(9_000)
    expect(onTurnOutcome(base(), { ...OUTCOME, continuationTurn: true }).episode?.cumulativeTokens).toBe(20_000)
  })

  test('does not open an episode for spend recorded without one', () => {
    const state = onTurnOutcome(emptyContinuationState(), { ...OUTCOME, continuationTurn: true })
    expect(state.episode).toBeNull()
  })
})
