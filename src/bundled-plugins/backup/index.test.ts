import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as FakeTimers from '@sinonjs/fake-timers'

import { noopPermissionService } from '@/permissions'
import type { PluginContext, PluginExports } from '@/plugin'

import backupPlugin, { backupCommitted } from './index'
import type { BackupResult } from './runner'
import { type CommitMessagePayload, createCommitMessageSubagent } from './subagents'

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
})

describe('backup commit message reuse', () => {
  const IDENTITY_ENV = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']
  let repo: string
  let savedEnv: Record<string, string | undefined>

  async function git(...args: string[]): Promise<void> {
    const proc = Bun.spawn(['git', ...args], { cwd: repo, stdout: 'ignore', stderr: 'pipe' })
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(proc.stderr).text()}`)
  }

  beforeEach(async () => {
    // The backup runner shells out with real timeouts; virtual time would never fire them.
    clock?.uninstall()
    clock = null
    savedEnv = Object.fromEntries(
      [...IDENTITY_ENV, 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map((k) => [k, process.env[k]]),
    )
    for (const k of IDENTITY_ENV) delete process.env[k]
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    repo = await mkdtemp(join(tmpdir(), 'typeclaw-backup-memo-'))
    await git('init', '-q')
    await writeFile(join(repo, 'seed.md'), 'seed\n')
    await git('add', 'seed.md')
    await git('-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-q', '-m', 'seed')
    // An identity passes the runner's preflight, but a signer that always fails
    // makes every backup commit fail after the message is picked.
    await git('config', 'user.name', 'Backup Test')
    await git('config', 'user.email', 'backup@example.com')
    await git('config', 'commit.gpgSign', 'true')
    await git('config', 'gpg.program', 'false')
  })

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(repo, { recursive: true, force: true })
  })

  test('a commit that keeps failing on the same changes reuses a generated message, never a fallback', async () => {
    // given a backup plugin driving the real commit-message subagent, whose model can fail
    const messageSubagent = createCommitMessageSubagent()
    let generationFails = true
    const messageSpawns: unknown[] = []
    const { ctx } = makeCtx({ config: { ...tinyConfig, maintenance: false } })
    const repoCtx: PluginContext<any> = {
      ...ctx,
      agentDir: repo,
      spawnSubagent: async (name, payload) => {
        if (name !== 'backup-message') return
        messageSpawns.push(payload)
        await messageSubagent.handler!(
          { userPrompt: '', agentDir: repo, payload: payload as CommitMessagePayload },
          (async (override?: { onFinalMessage?: (text: string) => void }) => {
            if (generationFails) throw new Error('model unavailable')
            override?.onFinalMessage?.('chore: update notes')
          }) as never,
        )
      },
    }
    const runner = (await loadPlugin(repoCtx)).subagents?.backup
    if (!runner?.handler) throw new Error('backup runner subagent missing')
    const runBackup = () =>
      runner.handler!(
        { userPrompt: '', agentDir: repo, payload: { agentDir: repo, pushToOrigin: false, maintenance: false } },
        async () => {
          throw new Error('the backup runner never starts an LLM session')
        },
      )
    await writeFile(join(repo, 'notes.md'), 'one\n')

    // A failed run leaves intent-to-add entries behind, so the status settles after it.
    await runBackup()
    await runBackup()
    const settled = messageSpawns.length

    // when generation fails on the settled dirty set, the fallback is not remembered
    await runBackup()
    expect(messageSpawns).toHaveLength(settled + 1)

    // when generation recovers, the generated message is picked and then reused
    generationFails = false
    await runBackup()
    await runBackup()
    await runBackup()
    expect(messageSpawns).toHaveLength(settled + 2)

    // when the dirty set changes
    await writeFile(join(repo, 'more.md'), 'two\n')
    await runBackup()

    // then a fresh message is picked
    expect(messageSpawns).toHaveLength(settled + 3)
  })
})

describe('backupCommitted (maintenance gate)', () => {
  const cases: Array<[BackupResult, boolean]> = [
    [{ ok: true, kind: 'committed' }, true],
    [{ ok: true, kind: 'pushed' }, true],
    [{ ok: true, kind: 'pushed-set-upstream' }, true],
    [{ ok: true, kind: 'rebased-and-pushed' }, true],
    // a commit is created BEFORE push recovery, so a failed push/rebase still
    // grew local history and must trigger reclamation (the reviewer's outage case)
    [{ ok: false, kind: 'push-failed', reason: 'x' }, true],
    [{ ok: false, kind: 'rebase-failed', reason: 'x' }, true],
    // no commit was made in these — nothing to reclaim
    [{ ok: true, kind: 'clean' }, false],
    [{ ok: true, kind: 'no-repo' }, false],
    [{ ok: false, kind: 'commit-failed', reason: 'x' }, false],
    [{ ok: false, kind: 'aborted', reason: 'x' }, false],
  ]

  for (const [result, expected] of cases) {
    test(`${result.kind} -> ${expected}`, () => {
      expect(backupCommitted(result)).toBe(expected)
    })
  }
})

function hookCtx() {
  return {
    agentDir: '/agent',
    pluginName: 'backup',
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}
