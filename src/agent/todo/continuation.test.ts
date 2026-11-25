import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import { createPermissionService } from '@/permissions'
import { WakeDispatcher } from '@/watches/delivery'
import { createBundledProbeRegistry } from '@/watches/runner'
import { registerWatchRuntime } from '@/watches/runtime'
import { WatchService } from '@/watches/service'
import { WatchStore } from '@/watches/store'
import { registerWatchesFromBash } from '@/watches/tool'
import type { WatchWakeTarget } from '@/watches/types'

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

describe('maybeInjectContinuation with a watch on the conversation', () => {
  const waiting = 'Merge after checks'
  const alsoWaiting = 'Review the export'
  const CHANNEL: SessionOrigin = {
    kind: 'channel',
    adapter: 'slack-bot',
    workspace: 'workspace',
    chat: 'room',
    thread: 'thread',
    lastInboundAuthorId: 'requester',
  }
  const channelTarget = (chat: string): WatchWakeTarget => ({
    kind: 'channel',
    key: { adapter: 'slack-bot', workspace: 'workspace', chat, thread: 'thread' },
    requester: { authorId: 'requester', authorAdapter: 'slack-bot' },
  })
  const tuiTarget = { kind: 'tui', sessionId: 'another-session' } as const

  function setupWatches() {
    const store = new WatchStore(agentDir)
    const service = new WatchService(
      store,
      async () => ({ verdict: 'quiet' }),
      async () => {},
      () => {},
      { now: () => 0, after: () => () => {} },
    )
    const unregister = registerWatchRuntime(agentDir, {
      service,
      registry: createBundledProbeRegistry(),
      isAutoEnabled: () => true,
      resolveGithubCredential: async () => ({ kind: 'token', token: 'fixture' }),
    })
    return {
      store,
      unregister,
      create: (wakeTarget: WatchWakeTarget, waitsFor: string) =>
        service.create({
          description: 'Check for the result',
          probe: { command: 'true' },
          mode: 'judge',
          createdByRole: 'owner',
          createdByOrigin: wakeTarget.kind === 'channel' ? CHANNEL : TUI,
          wakeTarget,
          waitsFor,
        }),
    }
  }

  async function seedPending(origin: SessionOrigin, ...contents: string[]) {
    const scope = resolveTodoScope(origin)
    if (!scope) throw new Error('Expected a todo scope')
    await writeTodos(agentDir, scope, [
      ...contents.map((content, index) => ({ content, status: index === 0 ? 'pending' : 'in_progress' }) as const),
      { content: 'Already finished', status: 'completed' },
      { content: 'No longer needed', status: 'cancelled' },
    ])
    await writeContinuationState(
      agentDir,
      scope,
      onTurnOutcome(await readContinuationState(agentDir, scope), { turnId: 't', stopReason: 'stop', endedAt: 1 }),
    )
  }

  test('parks without spending budget when every incomplete todo is linked to an active watch', async () => {
    await seedPending(TUI, waiting, alsoWaiting)
    const { create, unregister } = setupWatches()
    try {
      await create(tuiTarget, waiting)
      await create(tuiTarget, alsoWaiting)
      const res = await maybeInjectContinuation({ agentDir, origin: TUI })
      expect(res).toEqual({ kind: 'skipped', reason: 'watch-pending' })
      expect((await readContinuationState(agentDir, SCOPE)).episode).toBeNull()
      expect(describeContinuationDecision(res)).toBe('todo_continuation skip reason=watch-pending')
    } finally {
      unregister()
    }
  })

  test('injects when a runnable todo is unlinked alongside a linked one', async () => {
    await seedPending(TUI, waiting, 'Draft release notes')
    const { create, unregister } = setupWatches()
    try {
      await create(tuiTarget, waiting)
      const result = await maybeInjectContinuation({ agentDir, origin: TUI })
      expect(result.kind).toBe('injected')
      expect((await readContinuationState(agentDir, SCOPE)).episode?.autoTurnCount).toBe(1)
    } finally {
      unregister()
    }
  })

  test('a deferred watch result leaves unrelated todos runnable', async () => {
    const runnable = 'Draft release notes'
    await seedPending(TUI, waiting, runnable)
    const result = await maybeInjectContinuation({ agentDir, origin: TUI, deferredTodos: new Set([waiting]) })
    expect(result.kind).toBe('injected')
    if (result.kind !== 'injected') throw new Error('Expected a continuation prompt')
    expect(result.text).toContain(runnable)
    expect(result.text).not.toContain(waiting)
  })

  test('the next TUI idle continues after a nonterminal green wake leaves the todo incomplete', async () => {
    await seedPending(TUI, waiting)
    const { create, store, unregister } = setupWatches()
    let attempt: (() => Promise<void>) | undefined
    let attached = false
    const dispatcher = new WakeDispatcher(store, async () => (attached ? 'delivered' : 'held'), {
      now: () => 0,
      after: (_ms, fn) => {
        attempt = fn
        return () => {
          attempt = undefined
        }
      },
    })
    const flush = async () => {
      if (!attempt) throw new Error('Expected a scheduled wake delivery')
      await attempt()
    }
    const decide = () => maybeInjectContinuation({ agentDir, origin: TUI })
    const parked = { kind: 'skipped', reason: 'watch-pending' } as const
    try {
      const id = await create(tuiTarget, waiting)
      expect(await decide()).toEqual(parked)
      // The PR probe has reported green without ending the watch.
      await store.update((rows) => {
        const watch = rows.find((row) => row.id === id)
        if (!watch) throw new Error('Expected a persisted watch')
        watch.pending.push({ key: crypto.randomUUID(), summary: 'Checks passed', final: false })
      })
      dispatcher.notify()
      await flush()
      expect(await decide()).toEqual(parked)

      attached = true
      dispatcher.notify('attached')
      await flush()
      expect((await decide()).kind).toBe('injected')
      const restored = new WatchStore(agentDir)
      await restored.restore()
      expect(restored.records[0]?.status).toBe('active')
      expect(restored.records[0]?.waitsFor).toBeUndefined()
    } finally {
      await dispatcher.stop()
      unregister()
    }
  })

  test('an auto-registered issue watch does not park continuation', async () => {
    await seedPending(TUI, waiting)
    const { store, unregister } = setupWatches()
    try {
      await registerWatchesFromBash(
        agentDir,
        TUI,
        createPermissionService(),
        'gh issue create',
        'https://github.com/acme/widgets/issues/13',
      )
      expect(store.records).toHaveLength(1)
      expect(store.records[0]?.waitsFor).toBeUndefined()
      expect((await maybeInjectContinuation({ agentDir, origin: TUI })).kind).toBe('injected')
    } finally {
      unregister()
    }
  })

  test('a linked channel watch does not park a different conversation', async () => {
    await seedPending(CHANNEL, waiting)
    const { create, unregister } = setupWatches()
    try {
      await create(channelTarget('other-room'), waiting)
      expect((await maybeInjectContinuation({ agentDir, origin: CHANNEL })).kind).toBe('injected')
    } finally {
      unregister()
    }
  })

  test('a paused linked watch does not park continuation', async () => {
    await seedPending(TUI, waiting)
    const { create, store, unregister } = setupWatches()
    try {
      const id = await create(tuiTarget, waiting)
      await store.update((rows) => {
        const watch = rows.find((row) => row.id === id)
        if (!watch) throw new Error('Expected a persisted watch')
        watch.status = 'paused'
      })
      expect((await maybeInjectContinuation({ agentDir, origin: TUI })).kind).toBe('injected')
    } finally {
      unregister()
    }
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
