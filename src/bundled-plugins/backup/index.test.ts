import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import * as FakeTimers from '@sinonjs/fake-timers'

import { noopPermissionService } from '@/permissions'
import type { PluginContext, PluginExports } from '@/plugin'

import backupPlugin from './index'

type SpawnCall = { name: string; payload: unknown }

function makeCtx(overrides: { config: unknown }): {
  ctx: PluginContext<any>
  spawnCalls: SpawnCall[]
} {
  const spawnCalls: SpawnCall[] = []
  const logs: string[] = []
  const ctx: PluginContext<any> = {
    name: 'backup',
    version: undefined,
    agentDir: '/agent',
    config: overrides.config,
    logger: {
      info: (m) => logs.push(`info:${m}`),
      warn: (m) => logs.push(`warn:${m}`),
      error: (m) => logs.push(`error:${m}`),
    },
    permissions: noopPermissionService,
    github: {
      resolveTokenForRepo: async () => ({ kind: 'unavailable', reason: 'test' }),
      hasAppTokenResolver: () => false,
    },
    spawnSubagent: async (name, payload) => {
      spawnCalls.push({ name, payload })
    },
  }
  return { ctx, spawnCalls }
}

async function loadPlugin(ctx: PluginContext<any>): Promise<PluginExports> {
  return backupPlugin.plugin(ctx)
}

async function loadHooks(ctx: PluginContext<any>): Promise<{
  turnStart: NonNullable<NonNullable<PluginExports['hooks']>['session.turn.start']>
  turnEnd: NonNullable<NonNullable<PluginExports['hooks']>['session.turn.end']>
  idle: NonNullable<NonNullable<PluginExports['hooks']>['session.idle']>
  sessionEnd: NonNullable<NonNullable<PluginExports['hooks']>['session.end']>
}> {
  const exports = await loadPlugin(ctx)
  const hooks = exports.hooks
  if (!hooks) throw new Error('plugin returned no hooks')
  const turnStart = hooks['session.turn.start']
  const turnEnd = hooks['session.turn.end']
  const idle = hooks['session.idle']
  const sessionEnd = hooks['session.end']
  if (!turnStart || !turnEnd || !idle || !sessionEnd) throw new Error('expected lifecycle hooks missing')
  return { turnStart, turnEnd, idle, sessionEnd }
}

const tinyConfig = {
  enabled: true,
  idleMs: 25,
  pushToOrigin: false,
  commitTimeoutMs: 1000,
  networkTimeoutMs: 1000,
}

// Fake setTimeout/clearTimeout so the session.idle debounce (which schedules its
// fire via the global setTimeout in index.ts) advances on virtual time instead of
// the wall clock — the wall-clock version flaked on Windows CI where coarse timer
// granularity let the debounce window fire more than once. Same seam the sibling
// memory plugin's index.test.ts uses.
let clock: FakeTimers.Clock | null = null

beforeEach(() => {
  clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  clock?.uninstall()
  clock = null
})

async function advance(ms: number): Promise<void> {
  if (!clock) throw new Error('clock not installed; beforeEach did not run')
  await clock.tickAsync(ms)
  // Drain trailing microtasks the fire path awaits (fireIfQuiet's spawnSubagent
  // and the pendingFire queueMicrotask re-entry) so a post-advance assertion
  // observes the settled spawnCalls, not an in-flight chain.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

describe('backup plugin', () => {
  test('exposes the three subagents (runner, message, diagnose)', async () => {
    const { ctx } = makeCtx({ config: tinyConfig })
    const exports = await loadPlugin(ctx)
    const subs = Object.keys(exports.subagents ?? {}).sort()
    expect(subs).toEqual(['backup', 'backup-diagnose', 'backup-message'])
  })

  test('registers the four expected hooks', async () => {
    const { ctx } = makeCtx({ config: tinyConfig })
    const exports = await loadPlugin(ctx)
    const hookNames = Object.keys(exports.hooks ?? {}).sort()
    expect(hookNames).toEqual(['session.end', 'session.idle', 'session.turn.end', 'session.turn.start'])
  })

  test('config schema validates with all defaults', () => {
    const parsed = backupPlugin.configSchema?.parse(undefined)
    expect(parsed).toEqual({
      enabled: true,
      idleMs: 30_000,
      pushToOrigin: true,
      commitTimeoutMs: 30_000,
      networkTimeoutMs: 60_000,
      gcPackThreshold: 20,
    })
  })

  test('rejects idleMs below 1000ms', () => {
    expect(() => backupPlugin.configSchema?.parse({ idleMs: 500 })).toThrow()
  })

  test('idle hook with no active turns spawns the runner after debounce', async () => {
    const { ctx, spawnCalls } = makeCtx({ config: tinyConfig })
    const { idle } = await loadHooks(ctx)
    await idle({ sessionId: 's1', parentTranscriptPath: undefined, idleMs: 0 }, hookCtx())
    await advance(80)
    expect(spawnCalls.map((c) => c.name)).toEqual(['backup'])
    expect(spawnCalls[0]?.payload).toEqual({ agentDir: '/agent', pushToOrigin: false })
  })

  test('idle hook does not fire when an active turn is in progress', async () => {
    const { ctx, spawnCalls } = makeCtx({ config: tinyConfig })
    const { turnStart, idle } = await loadHooks(ctx)

    await turnStart({ sessionId: 's1', agentDir: '/agent', userPrompt: 'hi' }, hookCtx())
    await idle({ sessionId: 's1', parentTranscriptPath: undefined, idleMs: 0 }, hookCtx())
    await advance(80)
    expect(spawnCalls).toEqual([])
  })

  test('runner fires after the active turn ends and a fresh idle arrives', async () => {
    const { ctx, spawnCalls } = makeCtx({ config: tinyConfig })
    const { turnStart, turnEnd, idle } = await loadHooks(ctx)

    await turnStart({ sessionId: 's1', agentDir: '/agent', userPrompt: 'hi' }, hookCtx())
    await idle({ sessionId: 's1', parentTranscriptPath: undefined, idleMs: 0 }, hookCtx())
    await advance(40)
    expect(spawnCalls).toEqual([])

    await turnEnd({ sessionId: 's1', agentDir: '/agent' }, hookCtx())
    await idle({ sessionId: 's1', parentTranscriptPath: undefined, idleMs: 0 }, hookCtx())
    await advance(80)
    expect(spawnCalls.map((c) => c.name)).toEqual(['backup'])
  })

  test('self-induced subagent turns do not count against the active-turn gate', async () => {
    const { ctx, spawnCalls } = makeCtx({ config: tinyConfig })
    const { turnStart, idle } = await loadHooks(ctx)

    await turnStart(
      {
        sessionId: 'self',
        agentDir: '/agent',
        userPrompt: 'self-induced',
        origin: { kind: 'subagent', subagent: 'backup-message', parentSessionId: 'p' },
      },
      hookCtx(),
    )
    await idle({ sessionId: 's1', parentTranscriptPath: undefined, idleMs: 0 }, hookCtx())
    await advance(80)
    expect(spawnCalls.map((c) => c.name)).toEqual(['backup'])
  })

  test('debounce: rapid idle events coalesce into a single fire', async () => {
    const { ctx, spawnCalls } = makeCtx({ config: tinyConfig })
    const { idle } = await loadHooks(ctx)

    // Each idle resets the 25ms debounce; the 5ms gaps stay inside the window so
    // the timer never fires mid-loop, then one advance past the window fires once.
    for (let i = 0; i < 5; i++) {
      await idle({ sessionId: 's', parentTranscriptPath: undefined, idleMs: 0 }, hookCtx())
      await advance(5)
    }
    await advance(80)
    expect(spawnCalls.length).toBe(1)
  })

  test('disabled plugin never spawns the runner', async () => {
    const { ctx, spawnCalls } = makeCtx({ config: { ...tinyConfig, enabled: false } })
    const { idle } = await loadHooks(ctx)
    await idle({ sessionId: 's', parentTranscriptPath: undefined, idleMs: 0 }, hookCtx())
    await advance(80)
    expect(spawnCalls).toEqual([])
  })

  test('session.end clears any in-flight active turn for that session', async () => {
    const { ctx, spawnCalls } = makeCtx({ config: tinyConfig })
    const { turnStart, sessionEnd, idle } = await loadHooks(ctx)

    await turnStart({ sessionId: 's1', agentDir: '/agent', userPrompt: 'hi' }, hookCtx())
    await sessionEnd({ sessionId: 's1' }, hookCtx())
    await idle({ sessionId: 's2', parentTranscriptPath: undefined, idleMs: 0 }, hookCtx())
    await advance(80)
    expect(spawnCalls.length).toBe(1)
  })

  test('diagnose subagent prompt instructs the model to ack gitExfil on its push retry (regression for PR #255 audience-leak policy)', async () => {
    const { DIAGNOSE_FAILURE_SYSTEM_PROMPT } = await import('./subagents')
    expect(DIAGNOSE_FAILURE_SYSTEM_PROMPT).toContain('acknowledgeGuards')
    expect(DIAGNOSE_FAILURE_SYSTEM_PROMPT).toContain('gitExfil')
    expect(DIAGNOSE_FAILURE_SYSTEM_PROMPT).toMatch(/only the one push retry|only.*one.*retry/i)
  })
})

function hookCtx() {
  return {
    agentDir: '/agent',
    pluginName: 'backup',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}
