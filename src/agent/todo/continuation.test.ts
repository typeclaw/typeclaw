import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'

import { CONTINUATION_PROMPT, describeContinuationDecision, maybeInjectContinuation } from './continuation'
import { DEFAULT_CONTINUATION_LIMITS } from './continuation-policy'
import {
  armRestartKickSuppression,
  onTurnOutcome,
  readContinuationState,
  writeContinuationState,
} from './continuation-state'
import { resolveTodoScope } from './scope'
import { todoContentPath, writeTodos } from './store'

const TUI: SessionOrigin = { kind: 'tui', sessionId: 'ses_x' }
const SCOPE = resolveTodoScope(TUI)!

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-cont-inject-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

async function seedSafeOutcome() {
  await writeContinuationState(
    agentDir,
    SCOPE,
    onTurnOutcome(await readContinuationState(agentDir, SCOPE), { turnId: 't', stopReason: 'stop', endedAt: 1 }),
  )
}

describe('maybeInjectContinuation', () => {
  test('injects the continuation prompt when incomplete todos remain after a safe turn', async () => {
    await writeTodos(agentDir, SCOPE, [{ content: 'task', status: 'pending' }])
    await seedSafeOutcome()
    const res = await maybeInjectContinuation({ agentDir, origin: TUI, newEpisodeId: () => 'ep1' })
    expect(res.kind).toBe('injected')
    if (res.kind === 'injected') expect(res.text).toBe(CONTINUATION_PROMPT)
    const state = await readContinuationState(agentDir, SCOPE)
    expect(state.episode?.autoTurnCount).toBe(1)
  })

  test('skips a list last written beyond the age limit', async () => {
    const now = Date.now()
    await writeTodos(
      agentDir,
      SCOPE,
      [{ content: 'task', status: 'pending' }],
      now - DEFAULT_CONTINUATION_LIMITS.maxListAgeMs,
    )
    await seedSafeOutcome()
    const res = await maybeInjectContinuation({ agentDir, origin: TUI, now })
    expect(res).toEqual({ kind: 'skipped', reason: 'stale-list' })
  })

  test('skips a list file written before write times were recorded', async () => {
    const path = todoContentPath(agentDir, SCOPE)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 1, todos: [{ content: 'task', status: 'pending' }] }))
    await seedSafeOutcome()
    const res = await maybeInjectContinuation({ agentDir, origin: TUI })
    expect(res).toEqual({ kind: 'skipped', reason: 'stale-list' })
  })

  test('skips when no incomplete todos', async () => {
    await writeTodos(agentDir, SCOPE, [{ content: 'done', status: 'completed' }])
    await seedSafeOutcome()
    const res = await maybeInjectContinuation({ agentDir, origin: TUI })
    expect(res).toEqual({ kind: 'skipped', reason: 'no-incomplete-todos' })
  })

  test('subagent origin is a no-op', async () => {
    const origin: SessionOrigin = { kind: 'subagent', subagent: 'scout', parentSessionId: 'p' }
    const res = await maybeInjectContinuation({ agentDir, origin })
    expect(res).toEqual({ kind: 'skipped', reason: 'no-scope' })
  })

  test('the restart-kick one-shot suppresses exactly one idle then clears', async () => {
    await writeTodos(agentDir, SCOPE, [{ content: 'task', status: 'pending' }])
    await seedSafeOutcome()
    await writeContinuationState(
      agentDir,
      SCOPE,
      armRestartKickSuppression(await readContinuationState(agentDir, SCOPE)),
    )

    const first = await maybeInjectContinuation({ agentDir, origin: TUI })
    expect(first).toEqual({ kind: 'skipped', reason: 'restart-kick-suppressed' })
    expect((await readContinuationState(agentDir, SCOPE)).suppressNextIdleNudgeReason).toBeNull()

    const second = await maybeInjectContinuation({ agentDir, origin: TUI, newEpisodeId: () => 'ep2' })
    expect(second.kind).toBe('injected')
  })

  test('stagnation caps injections when the incomplete set never shrinks', async () => {
    await writeTodos(agentDir, SCOPE, [{ content: 'task', status: 'pending' }])
    await seedSafeOutcome()

    const results: string[] = []
    for (let i = 0; i < 5; i++) {
      const res = await maybeInjectContinuation({ agentDir, origin: TUI, newEpisodeId: () => 'ep-fixed' })
      results.push(res.kind)
    }
    // Identical todos every idle → stagnation (limit 2) trips before the turn
    // ceiling (3). Exactly two injections, then permanently skipped.
    const injected = results.filter((r) => r === 'injected').length
    expect(injected).toBe(DEFAULT_CONTINUATION_LIMITS.stagnationLimit)
    expect(results.at(-1)).toBe('skipped')
  })

  test('the turn ceiling caps useless-but-changing work (no real progress)', async () => {
    await seedSafeOutcome()
    const results: string[] = []
    // Each idle the model rewords the SAME single incomplete item: the hash
    // changes (no stagnation) but the incomplete count never shrinks. The
    // max-auto-turns ceiling is what must bound this useless-success loop.
    for (let i = 0; i < DEFAULT_CONTINUATION_LIMITS.maxAutoTurns + 2; i++) {
      await writeTodos(agentDir, SCOPE, [{ content: `reworded variant ${i}`, status: 'pending' }])
      const res = await maybeInjectContinuation({ agentDir, origin: TUI, newEpisodeId: () => 'ep-fixed' })
      results.push(res.kind)
    }
    const injected = results.filter((r) => r === 'injected').length
    expect(injected).toBe(DEFAULT_CONTINUATION_LIMITS.maxAutoTurns)
    expect(results.at(-1)).toBe('skipped')
  })

  test('does not inject after an explicit user abort', async () => {
    await writeTodos(agentDir, SCOPE, [{ content: 'task', status: 'pending' }])
    await writeContinuationState(
      agentDir,
      SCOPE,
      onTurnOutcome(await readContinuationState(agentDir, SCOPE), { turnId: 't', stopReason: 'aborted', endedAt: 1 }),
    )
    const res = await maybeInjectContinuation({ agentDir, origin: TUI })
    expect(res).toEqual({ kind: 'skipped', reason: 'user-abort-blocked' })
  })

  test('budget persists across a simulated restart and stays capped', async () => {
    await writeTodos(agentDir, SCOPE, [{ content: 'task', status: 'pending' }])
    await seedSafeOutcome()
    for (let i = 0; i < 4; i++) {
      await maybeInjectContinuation({ agentDir, origin: TUI, newEpisodeId: () => 'ep-fixed' })
    }
    const beforeRestart = await readContinuationState(agentDir, SCOPE)
    expect(beforeRestart.episode).not.toBeNull()

    // Simulate restart: the next call reads guard state purely from disk. With
    // an unchanged incomplete set the cap (stagnation) must still hold — the
    // budget is not reset by a process boundary.
    const res = await maybeInjectContinuation({ agentDir, origin: TUI, newEpisodeId: () => 'ep-restart' })
    expect(res.kind).toBe('skipped')
  })
})

describe('describeContinuationDecision', () => {
  test('names the reason for a skip that involved pending work', () => {
    expect(describeContinuationDecision({ kind: 'skipped', reason: 'delivered-after-todo-write' })).toBe(
      'todo_continuation skip reason=delivered-after-todo-write',
    )
    expect(describeContinuationDecision({ kind: 'skipped', reason: 'stale-list' })).toBe(
      'todo_continuation skip reason=stale-list',
    )
  })

  test('reports an injection', () => {
    expect(describeContinuationDecision({ kind: 'injected', scope: SCOPE, text: 'x' })).toBe('todo_continuation inject')
  })

  test('stays quiet for idles with no pending work', () => {
    expect(describeContinuationDecision({ kind: 'skipped', reason: 'no-incomplete-todos' })).toBeNull()
    expect(describeContinuationDecision({ kind: 'skipped', reason: 'no-scope' })).toBeNull()
  })
})
