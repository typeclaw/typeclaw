import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'

import { continuationStatePath, readContinuationState } from './continuation-state'
import {
  armRestartKickForOrigin,
  classifyStopReason,
  clearAbortSuppressionForOrigin,
  clearTodosForOrigin,
  extractStopReason,
  extractTurnUsage,
  recordTurnOutcome,
  recordTurnStart,
  runIdleContinuation,
} from './continuation-wiring'
import { resolveTodoScope } from './scope'
import { readTodos, writeTodos } from './store'

const TUI: SessionOrigin = { kind: 'tui', sessionId: 'ses_x' }
const SCOPE = resolveTodoScope(TUI)!

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-cont-wiring-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('classifyStopReason', () => {
  test('passes through known reasons and collapses the rest to unknown', () => {
    expect(classifyStopReason('stop')).toBe('stop')
    expect(classifyStopReason('length')).toBe('length')
    expect(classifyStopReason('aborted')).toBe('aborted')
    expect(classifyStopReason('error')).toBe('error')
    expect(classifyStopReason('tool_calls')).toBe('unknown')
    expect(classifyStopReason(undefined)).toBe('unknown')
  })
})

describe('extractStopReason', () => {
  test('reads stopReason from an assistant message_end event', () => {
    expect(extractStopReason({ type: 'message_end', message: { role: 'assistant', stopReason: 'aborted' } })).toBe(
      'aborted',
    )
  })

  test('ignores non-message_end events', () => {
    expect(extractStopReason({ type: 'text_delta' })).toBeNull()
  })
})

describe('extractTurnUsage', () => {
  test('counts output tokens, not the re-billed context', () => {
    const event = {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        usage: { input: 2590, output: 89, cacheRead: 40_000, cacheWrite: 0, totalTokens: 42_679 },
      },
    }
    expect(extractTurnUsage(event)).toEqual({ stopReason: 'stop', tokens: 89 })
  })
})

describe('recordTurnOutcome / recordTurnStart', () => {
  test('records the outcome and a user abort arms the durable suppressor', async () => {
    await recordTurnOutcome({ agentDir, origin: TUI, turnId: 't1', stopReason: 'aborted' })
    const state = await readContinuationState(agentDir, SCOPE)
    expect(state.lastTurnOutcome?.stopReason).toBe('aborted')
    expect(state.autoResumeBlockedUntilRealUserTurn).toBe(true)
  })

  test('records trusted terminal-reply provenance without arming the abort suppressor', async () => {
    await recordTurnOutcome({
      agentDir,
      origin: TUI,
      turnId: 't1',
      stopReason: 'aborted',
      termination: 'terminal-after-channel-reply',
    })
    const state = await readContinuationState(agentDir, SCOPE)
    expect(state.lastTurnOutcome).toMatchObject({
      stopReason: 'aborted',
      termination: 'terminal-after-channel-reply',
    })
    expect(state.autoResumeBlockedUntilRealUserTurn).toBe(false)
  })

  test('a real user turn clears the abort suppressor; an injected turn does not', async () => {
    await recordTurnOutcome({ agentDir, origin: TUI, turnId: 't1', stopReason: 'aborted' })
    await recordTurnStart({ agentDir, origin: TUI, isRealUserTurn: false })
    expect((await readContinuationState(agentDir, SCOPE)).autoResumeBlockedUntilRealUserTurn).toBe(true)
    await recordTurnStart({ agentDir, origin: TUI, isRealUserTurn: true })
    expect((await readContinuationState(agentDir, SCOPE)).autoResumeBlockedUntilRealUserTurn).toBe(false)
  })

  test('scopeless origins are a no-op', async () => {
    const origin: SessionOrigin = { kind: 'subagent', subagent: 's', parentSessionId: 'p' }
    await recordTurnOutcome({ agentDir, origin, turnId: 't', stopReason: 'stop' })
    await recordTurnStart({ agentDir, origin, isRealUserTurn: true })
    // nothing thrown, nothing written
    expect(true).toBe(true)
  })
})

describe('clearAbortSuppressionForOrigin', () => {
  test('clears the abort suppressor a restart-induced abort armed', async () => {
    // given a turn aborted (as a restart would) which armed the durable block
    await recordTurnOutcome({ agentDir, origin: TUI, turnId: 't1', stopReason: 'aborted' })
    expect((await readContinuationState(agentDir, SCOPE)).autoResumeBlockedUntilRealUserTurn).toBe(true)
    // when the restart resume path clears it
    await clearAbortSuppressionForOrigin(agentDir, TUI)
    // then auto-continuation is unblocked without needing a real user turn
    expect((await readContinuationState(agentDir, SCOPE)).autoResumeBlockedUntilRealUserTurn).toBe(false)
  })

  test('lets work auto-continue once the restart-kick turn laundered the aborted outcome', async () => {
    // given a turn the restart aborted, leaving incomplete work
    await writeTodos(agentDir, SCOPE, [{ content: 'task', status: 'pending' }])
    await recordTurnOutcome({ agentDir, origin: TUI, turnId: 't1', stopReason: 'aborted' })

    // when the resume path clears the durable block and arms the one-shot kick
    await clearAbortSuppressionForOrigin(agentDir, TUI)
    await armRestartKickForOrigin(agentDir, TUI)

    // and the synthetic "I'm back" kick runs as a non-user turn, then goes idle
    await recordTurnStart({ agentDir, origin: TUI, isRealUserTurn: false })
    await recordTurnOutcome({ agentDir, origin: TUI, turnId: 'kick', stopReason: 'stop' })
    let count = 0
    const firstIdle = await runIdleContinuation({ agentDir, origin: TUI, deliver: () => count++ })

    // then the kick's own idle is suppressed, but the next idle continues —
    // proving the kick laundered lastTurnOutcome from 'aborted' to 'stop'
    expect(firstIdle).toBe(false)
    const secondIdle = await runIdleContinuation({ agentDir, origin: TUI, deliver: () => count++ })
    expect(secondIdle).toBe(true)
    expect(count).toBe(1)
  })

  test('still blocks when the restart-kick turn itself aborts', async () => {
    await writeTodos(agentDir, SCOPE, [{ content: 'task', status: 'pending' }])
    await recordTurnOutcome({ agentDir, origin: TUI, turnId: 't1', stopReason: 'aborted' })
    await clearAbortSuppressionForOrigin(agentDir, TUI)
    await armRestartKickForOrigin(agentDir, TUI)
    await recordTurnStart({ agentDir, origin: TUI, isRealUserTurn: false })
    await recordTurnOutcome({ agentDir, origin: TUI, turnId: 'kick', stopReason: 'aborted' })
    await runIdleContinuation({ agentDir, origin: TUI, deliver: () => undefined })
    let delivered = false
    const ok = await runIdleContinuation({ agentDir, origin: TUI, deliver: () => (delivered = true) })
    expect(ok).toBe(false)
    expect(delivered).toBe(false)
  })

  test('scopeless origins are a no-op', async () => {
    const origin: SessionOrigin = { kind: 'subagent', subagent: 's', parentSessionId: 'p' }
    await clearAbortSuppressionForOrigin(agentDir, origin)
    expect(true).toBe(true)
  })
})

describe('runIdleContinuation', () => {
  test('delivers the nudge when work remains after a safe turn', async () => {
    await writeTodos(agentDir, SCOPE, [{ content: 'task', status: 'pending' }])
    await recordTurnOutcome({ agentDir, origin: TUI, turnId: 't1', stopReason: 'stop' })
    let delivered: string | null = null
    const ok = await runIdleContinuation({ agentDir, origin: TUI, deliver: (t) => (delivered = t) })
    expect(ok).toBe(true)
    expect(delivered).not.toBeNull()
  })

  test('does not deliver after a user abort', async () => {
    await writeTodos(agentDir, SCOPE, [{ content: 'task', status: 'pending' }])
    await recordTurnOutcome({ agentDir, origin: TUI, turnId: 't1', stopReason: 'aborted' })
    let delivered = false
    const ok = await runIdleContinuation({ agentDir, origin: TUI, deliver: () => (delivered = true) })
    expect(ok).toBe(false)
    expect(delivered).toBe(false)
    expect((await readContinuationState(agentDir, SCOPE)).autoResumeBlockedUntilRealUserTurn).toBe(true)
  })

  test('a persisted bogus termination value does not authorize continuation', async () => {
    await writeTodos(agentDir, SCOPE, [{ content: 'task', status: 'pending' }])
    const path = continuationStatePath(agentDir, SCOPE)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        state: {
          lastTurnOutcome: {
            turnId: 't1',
            stopReason: 'aborted',
            termination: 'forged-safe-abort',
            endedAt: 1,
          },
        },
      }),
      'utf8',
    )

    let delivered = false
    const ok = await runIdleContinuation({ agentDir, origin: TUI, deliver: () => (delivered = true) })
    expect(ok).toBe(false)
    expect(delivered).toBe(false)
  })

  test('clearTodosForOrigin empties a scope (cron per-fire reset)', async () => {
    const cron: SessionOrigin = { kind: 'cron', jobId: 'daily', jobKind: 'prompt' }
    const cronScope = resolveTodoScope(cron)!
    await writeTodos(agentDir, cronScope, [{ content: 'leftover', status: 'pending' }])
    await clearTodosForOrigin(agentDir, cron)
    expect(await readTodos(agentDir, cronScope)).toEqual([])
  })

  test('an armed restart-kick suppresses the first post-restart idle', async () => {
    await writeTodos(agentDir, SCOPE, [{ content: 'task', status: 'pending' }])
    await recordTurnOutcome({ agentDir, origin: TUI, turnId: 't1', stopReason: 'stop' })
    await armRestartKickForOrigin(agentDir, TUI)
    let count = 0
    const first = await runIdleContinuation({ agentDir, origin: TUI, deliver: () => count++ })
    expect(first).toBe(false)
    const second = await runIdleContinuation({ agentDir, origin: TUI, deliver: () => count++ })
    expect(second).toBe(true)
    expect(count).toBe(1)
  })
})
