import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as FakeTimers from '@sinonjs/fake-timers'

type Clock = FakeTimers.Clock

import { noopPermissionService } from '@/permissions'
import type {
  PluginContext,
  PluginExports,
  PluginLogger,
  SessionEndEvent,
  SessionIdleEvent,
  SessionTurnStartEvent,
} from '@/plugin'
import { createPluginContext, createPluginLogger } from '@/plugin/context'
import { formatLocalDate } from '@/shared'

import { renderShard } from './frontmatter'
import memoryPlugin from './index'
import { streamFilePath, topicShardPath, topicsDir } from './paths'

// Fake timers replace ~10s of real setTimeout waits used to exercise the idle
// debouncer and spawn-timeout race. Date is included in `toFake` so the
// per-agent spawn serialization tests' `Date.now()` non-overlap assertions
// observe the fake clock instead of wall-clock skew.
let clock: Clock | null = null

function installFakeClock(): void {
  clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
}

async function uninstallFakeClock(): Promise<void> {
  // Drain any in-flight spawn-chain microtasks AND advance any leftover fake
  // timers (e.g. raceSpawn's spawnTimeoutMs timer that the plugin clears in a
  // `finally` block) so they settle before the clock is uninstalled. Without
  // this, a pending fake-timer outlives the install and resumes against real
  // time in the next test, intermittently corrupting per-test assertions.
  if (clock) {
    await clock.runAllAsync()
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
    clock.uninstall()
    clock = null
  }
}

async function tickMs(ms: number): Promise<void> {
  if (!clock) throw new Error('clock not installed; call installFakeClock() in beforeEach')
  // The fire chain awaits real fs.stat (libuv) AND faked setTimeout chained
  // AFTER it (e.g. mock spawnSubagent's spawnDelayMs). One big tickAsync(ms)
  // fires only the setTimeouts scheduled BEFORE the first libuv yield — every
  // subsequent chain link's setTimeout is registered later, after a real
  // event-loop turn settles its predecessor's fs.stat. So we interleave:
  // advance some fake time, yield to libuv, advance more, yield again.
  let remaining = ms
  while (remaining > 0) {
    const step = Math.min(remaining, 25)
    await clock.tickAsync(step)
    remaining -= step
    for (let j = 0; j < 5; j++) await new Promise((r) => setImmediate(r))
  }
  for (let j = 0; j < 30; j++) await new Promise((r) => setImmediate(r))
}

// Wait for a condition that depends on the spawn chain settling. Use this when
// asserting on captured side effects (`spawned`, `logs.info`) after tickMs,
// since libuv-and-faked-setTimeout interleavings can leave the final chain
// link's microtasks pending past the last drain cycle. The poll uses real
// setImmediate (libuv) not the fake clock.
//
// `timeoutMs` bounds the wall-clock budget rather than counting `setImmediate`
// iterations. Under `bun test --parallel` (18 workers on a typical dev box),
// libuv's threadpool can saturate to the point where a worker's `fs.readdir`
// callback sits queued for hundreds of ms while this worker's event loop
// keeps firing `setImmediate` callbacks. An iteration-count cap exhausts in
// <50ms under contention, well before the fs chain — `loadAllShards` ->
// `fs.readdir` -> N x `fs.stat` -> `fs.readFile` -> faked-setTimeout ->
// spawn.push — actually settles. 10s is roomy enough for any plausibly
// correct chain and matches Bun's default per-test timeout.
//
// Uses `performance.now()` rather than `Date.now()` because several describe
// blocks (`session.idle hook (debouncer)`, `session.end hook`, etc.) install
// sinon fake timers with `Date` in `toFake`. Under a faked `Date`,
// `Date.now()` does not advance between `setImmediate` ticks, so a
// `Date.now()`-based deadline never expires and a failure path becomes a
// permanent hang. `performance.now()` is NOT in any test's `toFake` list,
// so it tracks wall clock under both real and faked Date.
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`waitFor(${label}) exhausted ${timeoutMs}ms without predicate becoming true`)
}

type SpawnCall = { name: string; payload: unknown; options: unknown; startedAt: number; finishedAt: number }

type CapturedLogs = { info: string[]; warn: string[]; error: string[] }

function makeCapturingLogger(): { logger: PluginLogger; logs: CapturedLogs } {
  const logs: CapturedLogs = { info: [], warn: [], error: [] }
  const logger: PluginLogger = {
    info: (m) => logs.info.push(m),
    warn: (m) => logs.warn.push(m),
    error: (m) => logs.error.push(m),
  }
  return { logger, logs }
}

async function bootMemoryPlugin(
  agentDir: string,
  rawConfig: unknown,
  options: { logger?: PluginLogger; spawnDelayMs?: number } = {},
): Promise<{
  exports: PluginExports
  spawned: SpawnCall[]
  started: { name: string; payload: unknown; options: unknown }[]
  ctx: PluginContext<unknown>
}> {
  const spawned: SpawnCall[] = []
  // `started` captures the spawn invocation BEFORE the artificial delay, so
  // tests that detach the spawn can distinguish "spawn was kicked off" from
  // "spawn completed". `spawned` records the post-delay completion.
  const started: { name: string; payload: unknown; options: unknown }[] = []
  const parsed = memoryPlugin.configSchema!.safeParse(rawConfig)
  if (!parsed.success) throw new Error(`config invalid: ${parsed.error.message}`)
  const spawnDelayMs = options.spawnDelayMs ?? 0
  const ctx = createPluginContext({
    name: 'memory',
    version: undefined,
    agentDir,
    config: parsed.data,
    logger: options.logger ?? createPluginLogger('memory'),
    permissions: noopPermissionService,
    spawnSubagent: async (name, payload, spawnOptions) => {
      started.push({ name, payload, options: spawnOptions })
      const startedAt = Date.now()
      if (spawnDelayMs > 0) await new Promise((r) => setTimeout(r, spawnDelayMs))
      const finishedAt = Date.now()
      spawned.push({ name, payload, options: spawnOptions, startedAt, finishedAt })
    },
    isBooted: () => true,
  })
  const exports = await memoryPlugin.plugin(ctx)
  return { exports, spawned, started, ctx }
}

let agentDir: string

async function writeTopic(dir: string, slug: string, heading: string, body: string): Promise<void> {
  await mkdir(topicsDir(dir), { recursive: true })
  await writeFile(
    topicShardPath(dir, slug),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-05-16' }, body),
  )
}

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'memory-plugin-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('memory plugin shape', () => {
  test('exposes memory subagents and memory_search tool', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    expect(Object.keys(exports.subagents ?? {})).toEqual(
      expect.arrayContaining(['memory-logger', 'dreaming', 'memory-retrieval']),
    )
    expect(exports.tools?.memory_search).toBeDefined()
  })

  test('exposes store_reference as a main-agent tool for inline verbatim capture', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    expect(exports.tools?.store_reference).toBeDefined()
  })

  test('memory-retrieval declares profile=fast', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    expect(exports.subagents?.['memory-retrieval']?.profile).toBe('fast')
  })

  test('plumbs retrievalSpawnTimeoutMs onto the memory-retrieval subagent declaration', async () => {
    // given a non-default retrieval timeout
    const { exports } = await bootMemoryPlugin(agentDir, { retrievalSpawnTimeoutMs: 7777 })

    // when reading the subagent the plugin contributed
    const retrieval = exports.subagents?.['memory-retrieval']

    // then the timeout flows to the field the orchestration layer reads
    expect(retrieval?.timeoutMs).toBe(7777)
  })

  test('registers a dreaming cron job with the configured schedule', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, { dreaming: { schedule: '*/5 * * * *' } })
    const cron = exports.cronJobs?.dreaming
    expect(cron).toBeDefined()
    expect(cron!.schedule).toBe('*/5 * * * *')
    expect(cron!.kind).toBe('prompt')
    if (cron!.kind === 'prompt') {
      expect(cron!.subagent).toBe('dreaming')
      expect(cron!.payload).toEqual({ agentDir })
    }
  })

  test('accepts five-field dreaming schedules with extra whitespace', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, { dreaming: { schedule: '  */5   * * * *  ' } })

    expect(exports.cronJobs?.dreaming?.schedule).toBe('  */5   * * * *  ')
  })

  test('registers the dreaming cron job with the default schedule when dreaming is not configured', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 5000 })
    expect(exports.cronJobs?.dreaming?.schedule).toBe('*/30 * * * *')
  })

  test('default config injects an idleMs of 60 seconds and a default dreaming schedule', async () => {
    const parsed = memoryPlugin.configSchema!.safeParse({})
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect((parsed.data as { idleMs: number }).idleMs).toBe(60_000)
    }

    const { exports: noDream } = await bootMemoryPlugin(agentDir, {})
    expect(noDream.cronJobs?.dreaming?.schedule).toBe('*/30 * * * *')

    const { exports: withDream } = await bootMemoryPlugin(agentDir, { dreaming: {} })
    expect(withDream.cronJobs?.dreaming?.schedule).toBe('*/30 * * * *')
  })

  test('rejects invalid cron expression in dreaming.schedule', async () => {
    await expect(bootMemoryPlugin(agentDir, { dreaming: { schedule: 'not a cron' } })).rejects.toThrow(/cron/i)
  })

  test('rejects second-level dreaming schedules to prevent tight cron loops', async () => {
    await expect(bootMemoryPlugin(agentDir, { dreaming: { schedule: '* * * * * *' } })).rejects.toThrow(/five-field/i)
  })

  test('rejects idleMs below the 1000ms minimum (lower bound prevents memory-logger thrash)', async () => {
    await expect(bootMemoryPlugin(agentDir, { idleMs: 500 })).rejects.toThrow()
  })
})

describe('session.turn.start hook', () => {
  test('spawns memory-retrieval with the user prompt when injection plan is index mode', async () => {
    await writeTopic(agentDir, 'large-a', 'Large A', 'a'.repeat(3000))
    await writeTopic(agentDir, 'large-b', 'Large B', 'b'.repeat(3000))
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { injectionBudgetBytes: 4096 })
    const origin: SessionTurnStartEvent['origin'] = { kind: 'tui', sessionId: 'ses_parent' }

    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_parent', agentDir, userPrompt: 'what do I know about deploys?', origin },
      {
        agentDir,
        pluginName: 'memory',
        logger: createPluginLogger('m'),
      },
    )

    await waitFor(() => spawned.length >= 1, 'memory-retrieval spawn settles')

    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.name).toBe('memory-retrieval')
    expect(spawned[0]!.payload).toEqual({
      parentSessionId: 'ses_parent',
      agentDir,
      recentPrompt: 'what do I know about deploys?',
      cacheFilePath: join(agentDir, 'memory', '.retrieval-cache', 'ses_parent.md'),
      origin,
    })
    // Execution authority is `system` (→ owner), with the triggering origin
    // preserved as `triggeredBy` for audit. Content provenance stays in the
    // payload `origin` above.
    expect(spawned[0]!.options).toEqual({
      parentSessionId: 'ses_parent',
      spawnedByOrigin: { kind: 'system', component: 'memory-retrieval', triggeredBy: origin },
    })
  })

  test('passes the actual user text, not the assembling system prompt (the bug session.prompt produced)', async () => {
    // Regression guard. Pre-fix, memory-retrieval ran from `session.prompt`
    // whose `event.prompt` is `basePrompt + IDENTITY.md + SOUL.md` (the
    // assembling system prompt). The plugin shipped that string as
    // `recentPrompt`, so the retrieval subagent keyword-mined TypeClaw's
    // framing prose instead of the user's question. Moving to
    // `session.turn.start` plumbs `event.userPrompt` (the literal text
    // headed to `session.prompt(text)`) into `recentPrompt`. This test
    // pins that wiring so a future refactor that "simplifies" the field
    // back to event.prompt or `event.text` is caught.
    await writeTopic(agentDir, 'large-a', 'Large A', 'a'.repeat(3000))
    await writeTopic(agentDir, 'large-b', 'Large B', 'b'.repeat(3000))
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { injectionBudgetBytes: 4096 })

    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_user', agentDir, userPrompt: 'Did Alice merge the deploy PR?', origin: undefined },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('m') },
    )
    await waitFor(() => spawned.length >= 1, 'memory-retrieval spawn settles')

    const payload = spawned[0]!.payload as { recentPrompt: string }
    expect(payload.recentPrompt).toBe('Did Alice merge the deploy PR?')
    expect(payload.recentPrompt).not.toContain('You are a general-purpose AI agent')
    expect(payload.recentPrompt).not.toContain('TypeClaw')
  })

  test('does not block on a slow memory-retrieval spawn', async () => {
    // PR #337 made the spawn fire-and-forget under session.prompt to keep
    // channel cold-start under ensureLive's 30s watchdog. Moving to
    // session.turn.start preserves that detached shape so a slow retrieval
    // never gates the user's reply.
    await writeTopic(agentDir, 'large-a', 'Large A', 'a'.repeat(3000))
    await writeTopic(agentDir, 'large-b', 'Large B', 'b'.repeat(3000))
    const { exports, spawned, started } = await bootMemoryPlugin(
      agentDir,
      { injectionBudgetBytes: 4096 },
      { spawnDelayMs: 10_000 },
    )

    const start = Date.now()
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_turn', agentDir, userPrompt: 'first turn', origin: undefined },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('m') },
    )
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(500)
    await waitFor(() => started.length >= 1, 'memory-retrieval spawn settles')
    expect(started[0]!.name).toBe('memory-retrieval')
    expect(spawned).toHaveLength(0)
  })

  test('hook returns synchronously without awaiting the shard load (channel turn gating)', async () => {
    // session.turn.start has NO per-handler timeout (unlike session.prompt,
    // session.idle, session.end), and the channel router awaits it before
    // calling `live.session.prompt(text)`. An inline `await loadAllShards`
    // would gate every channel turn on N shard reads. The hook body must
    // be fully detached. This test fires the hook against a tmpdir with no
    // memory directory at all — `loadAllShards` rejects/returns empty after
    // an fs round-trip — and asserts the hook returns within a single
    // event-loop tick. Pre-fix, the await would yield to libuv for the
    // readdir ENOENT and the hook would resolve only after that round-trip.
    const { exports } = await bootMemoryPlugin(agentDir, { injectionBudgetBytes: 4096 })

    // Promise.resolve() wraps the return so we can observe whether the
    // hook returned synchronously (sync function → resolves on the next
    // microtask) vs after yielding to libuv (async function with an
    // inline await → resolves only after the libuv round-trip).
    let resolved = false
    const hookPromise = Promise.resolve(
      exports.hooks!['session.turn.start']!(
        { sessionId: 'ses_sync', agentDir, userPrompt: 'q', origin: undefined },
        { agentDir, pluginName: 'memory', logger: createPluginLogger('m') },
      ),
    )
    void hookPromise.then(() => {
      resolved = true
    })
    for (let i = 0; i < 3; i++) await Promise.resolve()
    await hookPromise
    expect(resolved).toBe(true)
  })

  test('detached spawn rejection is reported via plugin logger, not unhandled', async () => {
    await writeTopic(agentDir, 'large-a', 'Large A', 'a'.repeat(3000))
    await writeTopic(agentDir, 'large-b', 'Large B', 'b'.repeat(3000))
    const parsed = memoryPlugin.configSchema!.safeParse({ injectionBudgetBytes: 4096 })
    if (!parsed.success) throw new Error(parsed.error.message)
    const { logger, logs } = makeCapturingLogger()
    const ctx = createPluginContext({
      name: 'memory',
      version: undefined,
      agentDir,
      config: parsed.data,
      logger,
      permissions: noopPermissionService,
      spawnSubagent: async () => {
        throw new Error('spawn rejected for test')
      },
      isBooted: () => true,
    })
    const exports = await memoryPlugin.plugin(ctx)

    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_fail', agentDir, userPrompt: 'q?', origin: undefined },
      { agentDir, pluginName: 'memory', logger },
    )

    await waitFor(
      () => logs.error.some((m) => m.includes('memory-retrieval spawn failed')),
      'detached spawn rejection routed to logger',
    )

    const errorLine = logs.error.find((m) => m.includes('memory-retrieval spawn failed'))
    expect(errorLine).toMatch(/spawn rejected for test/)
  })

  test('does not spawn memory-retrieval when the injection plan is direct mode', async () => {
    await writeTopic(agentDir, 'small-a', 'Small A', 'small body')
    const { exports, spawned } = await bootMemoryPlugin(agentDir, {})

    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_direct', agentDir, userPrompt: 'small?' },
      {
        agentDir,
        pluginName: 'memory',
        logger: createPluginLogger('m'),
      },
    )

    expect(spawned).toHaveLength(0)
  })

  test('does not recurse for subagent-origin turn events', async () => {
    await writeTopic(agentDir, 'large-a', 'Large A', 'a'.repeat(3000))
    await writeTopic(agentDir, 'large-b', 'Large B', 'b'.repeat(3000))
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { injectionBudgetBytes: 4096 })

    await exports.hooks!['session.turn.start']!(
      {
        sessionId: 'ses_subagent',
        agentDir,
        userPrompt: 'subagent prompt',
        origin: { kind: 'subagent', subagent: 'memory-retrieval', parentSessionId: 'ses_parent' },
      },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('m') },
    )

    expect(spawned).toHaveLength(0)
  })

  // Opt-out invariant guard for `suppressSystemMemory === memory.vector.enabled`:
  // with vector OFF (default) memory lives only in the system prompt, so the
  // non-vector hook branch must never write the per-turn `retrievalContext` bag.
  // Writing it would double-inject (system prompt + user turn). The sentinel
  // surviving proves the opt-out path leaves the bag untouched in BOTH plans.
  //
  // The non-vector retrieval runs DETACHED (`void runMemoryRetrieval`), so each
  // test must wait for an observable completion point AFTER the plan decision
  // before asserting — otherwise a future write inside the detached path (which
  // awaits `loadAllShards` first) would race past the assertion unobserved.
  test('leaves retrievalContext.results empty when vector is off (index-mode plan)', async () => {
    // given: over-budget shards → index mode, whose detached path ends in a spawn
    await writeTopic(agentDir, 'large-a', 'Large A', 'a'.repeat(3000))
    await writeTopic(agentDir, 'large-b', 'Large B', 'b'.repeat(3000))
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { injectionBudgetBytes: 4096 })

    const retrievalContext = { results: 'SENTINEL' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_optout_index', agentDir, userPrompt: 'what do I know?', retrievalContext },
      { agentDir, pluginName: 'memory', logger: createPluginLogger('m') },
    )

    // The spawn is the detached path's terminal step: once it lands, the hook has
    // run past every line that could have touched the bag.
    await waitFor(() => spawned.length >= 1, 'memory-retrieval spawn settles')
    expect(retrievalContext.results).toBe('SENTINEL')
  })

  test('leaves retrievalContext.results empty when vector is off (direct-mode plan)', async () => {
    // given: a small shard under budget → direct mode, which returns early with
    // NO spawn and NO log. Its only observable is `loadAllShards` resolving, so
    // wrap that module boundary as an observer (real impl preserved) and signal a
    // barrier on the next macrotask — by then the plugin's microtask continuation
    // (buildInjectionPlan + the direct-mode early return) has already run.
    await writeTopic(agentDir, 'small-a', 'Small A', 'small body')
    const { loadAllShards: realLoadAllShards } = await import('./load-shards')
    let signalDirectPathSettled: () => void = () => {}
    const directPathSettled = new Promise<void>((resolve) => {
      signalDirectPathSettled = resolve
    })
    mock.module('./load-shards', () => ({
      loadAllShards: async (dir: string) => {
        const shards = await realLoadAllShards(dir)
        setImmediate(signalDirectPathSettled)
        return shards
      },
    }))
    try {
      const { exports } = await bootMemoryPlugin(agentDir, {})

      const retrievalContext = { results: 'SENTINEL' }
      await exports.hooks!['session.turn.start']!(
        { sessionId: 'ses_optout_direct', agentDir, userPrompt: 'small?', retrievalContext },
        { agentDir, pluginName: 'memory', logger: createPluginLogger('m') },
      )

      await directPathSettled
      expect(retrievalContext.results).toBe('SENTINEL')
    } finally {
      mock.restore()
    }
  })
})

describe('session.idle hook (debouncer)', () => {
  beforeEach(installFakeClock)
  afterEach(uninstallFakeClock)

  test('does NOT spawn memory-logger synchronously on idle', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }
    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger: createPluginLogger('m') })
    expect(spawned).toHaveLength(0)
  })

  test('spawns memory-logger after idleMs elapses with no further idle events', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }
    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger: createPluginLogger('m') })

    await tickMs(1100)
    await waitFor(() => spawned.length >= 1, 'spawned.length>=1')

    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.name).toBe('memory-logger')
    expect(spawned[0]!.payload).toEqual({
      parentSessionId: 'ses_a',
      parentTranscriptPath: '/tmp/t.jsonl',
      agentDir,
    })
  })

  test('passes conversation origin to memory-logger payload', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const origin: SessionIdleEvent['origin'] = {
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T123',
      workspaceName: 'Acme',
      chat: 'C456',
      chatName: 'infra',
      thread: '171234.0001',
      lastInboundAuthorId: 'U1',
      participants: [
        {
          authorId: 'U1',
          authorName: 'Neo',
          firstMessageAt: 1000,
          lastMessageAt: 2000,
          messageCount: 2,
        },
      ],
    }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0, origin }

    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger: createPluginLogger('m') })
    await tickMs(1100)
    await waitFor(() => spawned.length >= 1, 'spawned.length>=1')

    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.payload).toEqual({
      parentSessionId: 'ses_a',
      parentTranscriptPath: '/tmp/t.jsonl',
      agentDir,
      origin,
    })
  })

  test('rapid idle events debounce: only one spawn after the LAST idle + idleMs', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }

    await exports.hooks!['session.idle']!(event, ctx)
    await tickMs(400)
    await exports.hooks!['session.idle']!(event, ctx)
    await tickMs(400)
    await exports.hooks!['session.idle']!(event, ctx)

    expect(spawned).toHaveLength(0)

    await tickMs(1200)
    await waitFor(() => spawned.length >= 1, 'spawned.length>=1')

    expect(spawned).toHaveLength(1)
  })

  test('different sessionIds get independent timers', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/a.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.idle']!({ sessionId: 'ses_b', parentTranscriptPath: '/tmp/b.jsonl', idleMs: 0 }, ctx)

    await tickMs(1200)
    await waitFor(() => spawned.length >= 2, 'spawned.length>=2')

    expect(spawned).toHaveLength(2)
    const sessions = spawned.map((c) => (c.payload as { parentSessionId: string }).parentSessionId).sort()
    expect(sessions).toEqual(['ses_a', 'ses_b'])
  })

  test('does NOT spawn when parentTranscriptPath is undefined (e.g. no persisted transcript)', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: undefined, idleMs: 0 }
    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger: createPluginLogger('m') })

    await tickMs(1200)

    expect(spawned).toHaveLength(0)
  })

  test('does NOT spawn for subagent-origin idle events (prevents memory-logger self-recursion)', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const origin: SessionIdleEvent['origin'] = {
      kind: 'subagent',
      subagent: 'memory-logger',
      parentSessionId: 'ses_parent',
    }
    const event: SessionIdleEvent = {
      sessionId: 'ses_subagent',
      parentTranscriptPath: '/tmp/subagent-transcript.jsonl',
      idleMs: 0,
      origin,
    }
    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger: createPluginLogger('m') })

    await tickMs(1200)

    expect(spawned).toHaveLength(0)
  })
})

describe('session.end hook', () => {
  beforeEach(installFakeClock)
  afterEach(uninstallFakeClock)

  test('cancels the idle timer and spawns memory-logger immediately on close', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx)

    await waitFor(() => spawned.length >= 1, 'memory-logger spawn on session.end')
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.name).toBe('memory-logger')
  })

  test('deletes the retrieval cache file on close', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 10_000 })
    const cacheFilePath = join(agentDir, 'memory', '.retrieval-cache', 'ses_cache.md')
    await mkdir(join(agentDir, 'memory', '.retrieval-cache'), { recursive: true })
    await writeFile(cacheFilePath, 'retrieved context', 'utf8')

    await exports.hooks!['session.end']!({ sessionId: 'ses_cache' } as SessionEndEvent, {
      agentDir,
      pluginName: 'memory',
      logger: createPluginLogger('m'),
    })

    await waitFor(() => !existsSync(cacheFilePath), 'retrieval cache unlinked')
    expect(existsSync(cacheFilePath)).toBe(false)
  })

  test('logs a warning when retrieval cache cleanup fails for a non-ENOENT error', async () => {
    const { logger, logs } = makeCapturingLogger()
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 10_000 }, { logger })
    const cacheFilePath = join(agentDir, 'memory', '.retrieval-cache', 'ses_cache.md')
    await mkdir(cacheFilePath, { recursive: true })

    await exports.hooks!['session.end']!({ sessionId: 'ses_cache' } as SessionEndEvent, {
      agentDir,
      pluginName: 'memory',
      logger,
    })

    await waitFor(
      () => logs.warn.some((m) => m.includes('failed to clean retrieval cache')),
      'retrieval cache cleanup warning',
    )
    expect(logs.warn.some((m) => m.includes('failed to clean retrieval cache'))).toBe(true)
  })

  test('on close without a prior idle event, does NOT spawn (no transcript path is known)', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 10_000 })
    await exports.hooks!['session.end']!({ sessionId: 'ses_unknown' } as SessionEndEvent, {
      agentDir,
      pluginName: 'memory',
      logger: createPluginLogger('m'),
    })
    expect(spawned).toHaveLength(0)
  })

  test('does NOT spawn for subagent-origin end events (prevents memory-logger self-recursion)', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.end']!(
      {
        sessionId: 'ses_subagent',
        origin: { kind: 'subagent', subagent: 'memory-logger', parentSessionId: 'ses_parent' },
      } as SessionEndEvent,
      ctx,
    )

    expect(spawned).toHaveLength(0)
  })

  test('after close, no further pending timer fires', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx)

    await waitFor(() => spawned.length >= 1, 'session-end spawn settles')
    await tickMs(1200)

    expect(spawned).toHaveLength(1)
  })
})

// Regression guard for the user-visible Discord channel-silence bug: when the
// router's stale-rollover path calls `tearDownLive(existing)`, it awaits
// `fireSessionEnd` which awaits this hook. If the hook awaited the
// memory-logger spawn (which takes 20+ seconds on a real transcript), the
// new session's cold-start would block for the full subagent runtime — observed
// as ~28s of channel silence between inbound message and any reply. The
// detached `void fireMemoryLogger(...)` keeps the hook fast while
// `spawnChain` preserves the agentDir-keyed serialization invariant.
describe('session.end channel-silence regression guard', () => {
  test('session.end returns synchronously even when memory-logger spawn is slow', async () => {
    const SLOW_SPAWN_MS = 1000
    const { exports, spawned } = await bootMemoryPlugin(
      agentDir,
      { idleMs: 60_000, bufferBytes: 0 },
      { spawnDelayMs: SLOW_SPAWN_MS },
    )
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }, ctx)

    const start = performance.now()
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx)
    const elapsed = performance.now() - start

    // The hook must return well under SLOW_SPAWN_MS — it's detached from
    // the spawn. 100ms is a generous ceiling for synchronous bookkeeping
    // under worker contention; the production user-visible bug had this
    // path blocking for 22 seconds.
    expect(elapsed).toBeLessThan(100)
    expect(spawned).toHaveLength(0)

    await waitFor(() => spawned.length >= 1, 'spawn eventually completes via chain')
    expect(spawned).toHaveLength(1)
  })
})

describe('bufferBytes config', () => {
  test('defaults to 500_000 when omitted', async () => {
    const parsed = memoryPlugin.configSchema!.safeParse({})
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect((parsed.data as { bufferBytes: number }).bufferBytes).toBe(500_000)
    }
  })

  test('accepts 0 to disable', async () => {
    const parsed = memoryPlugin.configSchema!.safeParse({ bufferBytes: 0 })
    expect(parsed.success).toBe(true)
  })

  test('rejects values between 1 and 9_999 (would thrash the subagent)', async () => {
    await expect(bootMemoryPlugin(agentDir, { bufferBytes: 5000 })).rejects.toThrow()
  })

  test('accepts values >= 10_000', async () => {
    const parsed = memoryPlugin.configSchema!.safeParse({ bufferBytes: 10_000 })
    expect(parsed.success).toBe(true)
  })

  test('rejects negative values', async () => {
    await expect(bootMemoryPlugin(agentDir, { bufferBytes: -1 })).rejects.toThrow()
  })
})

describe('session.idle hook (buffer-bytes ceiling)', () => {
  test('does NOT fire on the first idle event (initializes baseline)', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'x'.repeat(50_000))

    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }, ctx)

    expect(spawned).toHaveLength(0)
  })

  test('fires synchronously when growth since last run reaches bufferBytes', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'x'.repeat(1000))

    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    // given: first idle initializes baseline at 1000 bytes
    await exports.hooks!['session.idle']!(event, ctx)
    expect(spawned).toHaveLength(0)

    // when: transcript grows by 10_000 bytes and another idle fires
    await appendFile(transcript, 'y'.repeat(10_000))
    await exports.hooks!['session.idle']!(event, ctx)

    // then: memory-logger spawns synchronously, before idleMs elapses
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.name).toBe('memory-logger')
  })

  test('does NOT fire when growth is below bufferBytes', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'x'.repeat(1000))

    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    await exports.hooks!['session.idle']!(event, ctx)
    await appendFile(transcript, 'y'.repeat(9_999))
    await exports.hooks!['session.idle']!(event, ctx)

    expect(spawned).toHaveLength(0)
  })

  test('resets baseline after spawn so next ceiling requires another bufferBytes of growth', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, '')

    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    // given: baseline at 0 bytes
    await exports.hooks!['session.idle']!(event, ctx)
    expect(spawned).toHaveLength(0)

    // when: 10_000 bytes appended → first trip
    await appendFile(transcript, 'a'.repeat(10_000))
    await exports.hooks!['session.idle']!(event, ctx)
    expect(spawned).toHaveLength(1)

    // and: only 5_000 more bytes appended → no second trip
    await appendFile(transcript, 'b'.repeat(5_000))
    await exports.hooks!['session.idle']!(event, ctx)
    expect(spawned).toHaveLength(1)

    // and: another 5_000 bytes (10_000 since last spawn) → second trip
    await appendFile(transcript, 'c'.repeat(5_000))
    await exports.hooks!['session.idle']!(event, ctx)
    expect(spawned).toHaveLength(2)
  })

  test('disabled when bufferBytes is 0 (idle-only legacy behavior)', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'x'.repeat(1000))

    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 0 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    await exports.hooks!['session.idle']!(event, ctx)
    await appendFile(transcript, 'y'.repeat(1_000_000))
    await exports.hooks!['session.idle']!(event, ctx)

    expect(spawned).toHaveLength(0)
  })

  test('fail-opens when transcript file does not exist (no spawn, no crash)', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = {
      sessionId: 'ses_a',
      parentTranscriptPath: join(agentDir, 'does-not-exist.jsonl'),
      idleMs: 0,
    }

    await exports.hooks!['session.idle']!(event, ctx)
    await exports.hooks!['session.idle']!(event, ctx)

    expect(spawned).toHaveLength(0)
  })

  test('different sessions track buffers independently', async () => {
    const transcriptA = join(agentDir, 'a.jsonl')
    const transcriptB = join(agentDir, 'b.jsonl')
    await writeFile(transcriptA, '')
    await writeFile(transcriptB, '')

    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    // given: baselines at 0 for both
    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: transcriptA, idleMs: 0 }, ctx)
    await exports.hooks!['session.idle']!({ sessionId: 'ses_b', parentTranscriptPath: transcriptB, idleMs: 0 }, ctx)

    // when: A grows by 10_000 but B does not
    await appendFile(transcriptA, 'a'.repeat(10_000))
    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: transcriptA, idleMs: 0 }, ctx)
    await exports.hooks!['session.idle']!({ sessionId: 'ses_b', parentTranscriptPath: transcriptB, idleMs: 0 }, ctx)

    // then: only A's session triggered a spawn
    expect(spawned).toHaveLength(1)
    expect((spawned[0]!.payload as { parentSessionId: string }).parentSessionId).toBe('ses_a')
  })
})

describe('session.idle min-delta gate', () => {
  beforeEach(installFakeClock)
  afterEach(uninstallFakeClock)

  test('skips idle spawn when transcript line growth is below minIdleDeltaLines', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'a\nb\n')

    const { exports, spawned } = await bootMemoryPlugin(agentDir, {
      idleMs: 1000,
      bufferBytes: 0,
      minIdleDeltaLines: 3,
    })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    // given: 2-line transcript, no prior spawn (baseline absent → 0). Delta=2 < 3.
    await exports.hooks!['session.idle']!(event, ctx)
    // when: idleMs elapses (gate runs at timer-fire)
    await tickMs(1100)
    await tickMs(50)
    // then: no spawn
    expect(spawned).toHaveLength(0)
  })

  test('fires idle spawn when transcript line growth meets minIdleDeltaLines', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'a\nb\nc\nd\n')

    const { exports, spawned } = await bootMemoryPlugin(agentDir, {
      idleMs: 1000,
      bufferBytes: 0,
      minIdleDeltaLines: 3,
    })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    // 4 lines, baseline=0, delta=4 >= 3 → spawn
    await exports.hooks!['session.idle']!(event, ctx)
    await tickMs(1100)
    await waitFor(() => spawned.length >= 1, 'idle spawn fires when delta >= minIdleDeltaLines')
    expect(spawned).toHaveLength(1)
  })

  test('skips subsequent idle spawn when new lines since last spawn is below threshold', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'a\nb\nc\nd\ne\n')

    const { exports, spawned } = await bootMemoryPlugin(agentDir, {
      idleMs: 1000,
      bufferBytes: 0,
      minIdleDeltaLines: 3,
    })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    // given: first idle spawns (5 lines vs baseline 0)
    await exports.hooks!['session.idle']!(event, ctx)
    await tickMs(1100)
    await waitFor(() => spawned.length >= 1, 'first idle spawns')
    expect(spawned).toHaveLength(1)

    // when: 2 more lines arrive (delta = 2 from baseline of 5) and idle fires again
    await appendFile(transcript, 'f\ng\n')
    await exports.hooks!['session.idle']!(event, ctx)
    await tickMs(1100)
    // then: no second spawn (2 < 3)
    expect(spawned).toHaveLength(1)

    // and: when one more line arrives (delta = 3), idle does spawn
    await appendFile(transcript, 'h\n')
    await exports.hooks!['session.idle']!(event, ctx)
    await tickMs(1100)
    await waitFor(() => spawned.length >= 2, 'second idle spawns when delta reaches threshold')
    expect(spawned).toHaveLength(2)
  })

  test('minIdleDeltaLines=0 disables the gate (legacy always-fire behavior)', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'a\n')

    const { exports, spawned } = await bootMemoryPlugin(agentDir, {
      idleMs: 1000,
      bufferBytes: 0,
      minIdleDeltaLines: 0,
    })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    await exports.hooks!['session.idle']!(event, ctx)
    await tickMs(1100)
    await waitFor(() => spawned.length >= 1, 'spawn fires when gate is disabled')
    expect(spawned).toHaveLength(1)
  })

  test('zero-line transcript is not gated — preserves legacy "fire and let logger decide" behavior', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, '')

    const { exports, spawned } = await bootMemoryPlugin(agentDir, {
      idleMs: 1000,
      bufferBytes: 0,
      minIdleDeltaLines: 3,
    })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    await exports.hooks!['session.idle']!(event, ctx)
    await tickMs(1100)
    await waitFor(() => spawned.length >= 1, 'empty-transcript spawn still fires')
    expect(spawned).toHaveLength(1)
  })

  test('buffer-trip path is independent of minIdleDeltaLines', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'a\n')

    const { exports, spawned } = await bootMemoryPlugin(agentDir, {
      idleMs: 60_000,
      bufferBytes: 10_000,
      minIdleDeltaLines: 1000,
    })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    // given: baseline initialized
    await exports.hooks!['session.idle']!(event, ctx)
    // when: byte growth crosses bufferBytes (only 2 lines added, well below 1000-line gate)
    await appendFile(transcript, 'b'.repeat(11_000))
    await exports.hooks!['session.idle']!(event, ctx)
    // then: buffer-trip fires synchronously despite the gate
    expect(spawned).toHaveLength(1)
  })
})

describe('session.end byte-equality skip', () => {
  beforeEach(installFakeClock)
  afterEach(uninstallFakeClock)

  test('skips spawn when session.end arrives with no new bytes since the last logger run', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'a'.repeat(15_000))

    const { exports, spawned } = await bootMemoryPlugin(agentDir, {
      idleMs: 60_000,
      bufferBytes: 10_000,
      minIdleDeltaLines: 0,
    })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    // given: first idle initializes baseline at 15_000 bytes (no spawn)
    await exports.hooks!['session.idle']!(event, ctx)
    // when: transcript crosses bufferBytes and idle fires → buffer-trip spawn (baseline now 25_000)
    await appendFile(transcript, 'b'.repeat(10_000))
    await exports.hooks!['session.idle']!(event, ctx)
    await waitFor(() => spawned.length >= 1, 'buffer-trip spawn')
    expect(spawned).toHaveLength(1)

    // when: session.end arrives with no new bytes
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx)
    // give the async session.end body a microtask to settle
    await tickMs(50)
    // then: no second spawn — the buffer-trip already drained this transcript
    expect(spawned).toHaveLength(1)
  })

  test('still spawns on session.end when transcript grew since the last logger run', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'a'.repeat(15_000))

    const { exports, spawned } = await bootMemoryPlugin(agentDir, {
      idleMs: 60_000,
      bufferBytes: 10_000,
      minIdleDeltaLines: 0,
    })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    await exports.hooks!['session.idle']!(event, ctx)
    await appendFile(transcript, 'b'.repeat(10_000))
    await exports.hooks!['session.idle']!(event, ctx)
    await waitFor(() => spawned.length >= 1, 'buffer-trip spawn')

    // given: transcript grows again after the spawn
    await appendFile(transcript, 'c'.repeat(500))
    // when: session.end arrives
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx)

    // then: a second spawn fires (delta = 500 bytes > 0)
    await waitFor(() => spawned.length >= 2, 'session-end spawn fires when transcript grew')
    expect(spawned).toHaveLength(2)
  })

  test('still spawns on session.end when no prior logger run set a baseline', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'a'.repeat(5000))

    const { exports, spawned } = await bootMemoryPlugin(agentDir, {
      idleMs: 60_000,
      bufferBytes: 0,
      minIdleDeltaLines: 0,
    })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    // given: idle event set lastIdleEvent (so session.end knows the path), but no prior spawn
    await exports.hooks!['session.idle']!(event, ctx)
    // when: session.end fires before any logger spawn has set a baseline
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx)
    // then: spawn fires (baseline === undefined means "always fire")
    await waitFor(() => spawned.length >= 1, 'session-end spawn fires with no baseline')
    expect(spawned).toHaveLength(1)
  })
})

describe('stream line cursor', () => {
  beforeEach(installFakeClock)
  afterEach(uninstallFakeClock)

  test('first spawn for a session has no streamLineCursor in the payload', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'a'.repeat(15_000))

    const { exports, spawned } = await bootMemoryPlugin(agentDir, {
      idleMs: 60_000,
      bufferBytes: 10_000,
      minIdleDeltaLines: 0,
    })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    await exports.hooks!['session.idle']!(event, ctx)
    await appendFile(transcript, 'b'.repeat(10_000))
    await exports.hooks!['session.idle']!(event, ctx)
    await waitFor(() => spawned.length >= 1, 'first spawn')

    expect(spawned[0]!.payload).not.toHaveProperty('streamLineCursor')
  })

  test('subsequent spawn for the same session on the same day carries a streamLineCursor reflecting the daily-stream line count', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, 'a'.repeat(15_000))

    // pre-seed today's daily stream with two lines (e.g. earlier sessions today)
    const today = formatLocalDate()
    const streamPath = streamFilePath(agentDir, today)
    await mkdir(join(agentDir, 'memory', 'streams'), { recursive: true })
    await writeFile(streamPath, '{"kind":"fragment"}\n{"kind":"watermark"}\n')

    const { exports, spawned } = await bootMemoryPlugin(agentDir, {
      idleMs: 60_000,
      bufferBytes: 10_000,
      minIdleDeltaLines: 0,
    })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    // first spawn (via buffer-trip) — its post-spawn read of the daily stream
    // sees the 2 pre-seeded lines and stamps the cursor as 2
    await exports.hooks!['session.idle']!(event, ctx)
    await appendFile(transcript, 'b'.repeat(10_000))
    await exports.hooks!['session.idle']!(event, ctx)
    await waitFor(() => spawned.length >= 1, 'first spawn')

    // allow the post-spawn cursor-stamp microtask to run
    await new Promise((r) => setImmediate(r))

    // second spawn — should carry streamLineCursor=2 (set by the first spawn's
    // post-spawn read of the daily stream)
    await appendFile(transcript, 'c'.repeat(10_000))
    await exports.hooks!['session.idle']!(event, ctx)
    await waitFor(() => spawned.length >= 2, 'second spawn')

    expect(spawned[1]!.payload).toHaveProperty('streamLineCursor', 2)
  })

  test("cursor is per-session — session B does not inherit session A's cursor", async () => {
    const transcriptA = join(agentDir, 'a.jsonl')
    const transcriptB = join(agentDir, 'b.jsonl')
    await writeFile(transcriptA, 'a'.repeat(15_000))
    await writeFile(transcriptB, 'b'.repeat(15_000))

    // pre-seed today's daily stream with three lines
    const today = formatLocalDate()
    const streamPath = streamFilePath(agentDir, today)
    await mkdir(join(agentDir, 'memory', 'streams'), { recursive: true })
    await writeFile(streamPath, '{"a":1}\n{"a":2}\n{"a":3}\n')

    const { exports, spawned } = await bootMemoryPlugin(agentDir, {
      idleMs: 60_000,
      bufferBytes: 10_000,
      minIdleDeltaLines: 0,
    })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    // session A spawns first; cursor for ses_a gets set to 3
    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: transcriptA, idleMs: 0 }, ctx)
    await appendFile(transcriptA, 'x'.repeat(10_000))
    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: transcriptA, idleMs: 0 }, ctx)
    await waitFor(() => spawned.length >= 1, 'session A first spawn')
    await new Promise((r) => setImmediate(r))

    // session B's first spawn — should NOT see session A's cursor
    await exports.hooks!['session.idle']!({ sessionId: 'ses_b', parentTranscriptPath: transcriptB, idleMs: 0 }, ctx)
    await appendFile(transcriptB, 'y'.repeat(10_000))
    await exports.hooks!['session.idle']!({ sessionId: 'ses_b', parentTranscriptPath: transcriptB, idleMs: 0 }, ctx)
    await waitFor(() => spawned.length >= 2, 'session B first spawn')

    const sessionBSpawn = spawned.find((s) => (s.payload as { parentSessionId: string }).parentSessionId === 'ses_b')
    expect(sessionBSpawn).toBeDefined()
    expect(sessionBSpawn!.payload).not.toHaveProperty('streamLineCursor')
  })
})

describe('per-agent spawn serialization', () => {
  // Real time used here. These tests assert non-overlap via Date.now() inside
  // the mock spawnSubagent (which captures startedAt / finishedAt). Total real
  // wall cost is ~200ms across the three tests — much cheaper than wiring fake
  // timers around the libuv-and-faked-setTimeout interleaving these chains
  // need. Re-evaluate if spawnDelayMs grows significantly.

  // Two concurrent channel sessions must never call spawnSubagent in parallel —
  // the subagent consumer keys memory-logger by agentDir and would silently drop
  // a colliding fire. The plugin owns this serialization via a chained Promise.
  test('back-to-back idle fires for different sessions run sequentially, not in parallel', async () => {
    const { exports, spawned } = await bootMemoryPlugin(
      agentDir,
      { idleMs: 60_000, bufferBytes: 0 },
      { spawnDelayMs: 50 },
    )
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    // given: two sessions trip the buffer ceiling at the same moment via session.end
    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/a.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.idle']!({ sessionId: 'ses_b', parentTranscriptPath: '/tmp/b.jsonl', idleMs: 0 }, ctx)

    // when: both fire via session.end nearly simultaneously
    await Promise.all([
      exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx),
      exports.hooks!['session.end']!({ sessionId: 'ses_b' } as SessionEndEvent, ctx),
    ])

    // then: both spawned, but the second started AFTER the first finished (no overlap)
    await waitFor(() => spawned.length >= 2, 'both spawns complete')
    expect(spawned).toHaveLength(2)
    const [first, second] = [...spawned].sort((a, b) => a.startedAt - b.startedAt)
    expect(second!.startedAt).toBeGreaterThanOrEqual(first!.finishedAt)
  })

  test('three back-to-back fires preserve FIFO order', async () => {
    const { exports, spawned } = await bootMemoryPlugin(
      agentDir,
      { idleMs: 60_000, bufferBytes: 0 },
      { spawnDelayMs: 20 },
    )
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/a.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.idle']!({ sessionId: 'ses_b', parentTranscriptPath: '/tmp/b.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.idle']!({ sessionId: 'ses_c', parentTranscriptPath: '/tmp/c.jsonl', idleMs: 0 }, ctx)

    await Promise.all([
      exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx),
      exports.hooks!['session.end']!({ sessionId: 'ses_b' } as SessionEndEvent, ctx),
      exports.hooks!['session.end']!({ sessionId: 'ses_c' } as SessionEndEvent, ctx),
    ])

    await waitFor(() => spawned.length >= 3, 'all three spawns complete')
    expect(spawned).toHaveLength(3)
    expect(spawned.map((s) => (s.payload as { parentSessionId: string }).parentSessionId)).toEqual([
      'ses_a',
      'ses_b',
      'ses_c',
    ])
  })

  test('a failing spawn does not break the chain for subsequent fires', async () => {
    const spawned: SpawnCall[] = []
    const parsed = memoryPlugin.configSchema!.safeParse({ idleMs: 60_000, bufferBytes: 0 })
    if (!parsed.success) throw new Error('config invalid')
    let firstCall = true
    const ctx = createPluginContext({
      name: 'memory',
      version: undefined,
      agentDir,
      config: parsed.data,
      logger: createPluginLogger('m'),
      permissions: noopPermissionService,
      spawnSubagent: async (name, payload) => {
        const startedAt = Date.now()
        if (firstCall) {
          firstCall = false
          throw new Error('first spawn boom')
        }
        spawned.push({ name, payload, options: undefined, startedAt, finishedAt: Date.now() })
      },
      isBooted: () => true,
    })
    const exports = await memoryPlugin.plugin(ctx)
    const hookCtx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!(
      { sessionId: 'ses_a', parentTranscriptPath: '/tmp/a.jsonl', idleMs: 0 },
      hookCtx,
    )
    await exports.hooks!['session.idle']!(
      { sessionId: 'ses_b', parentTranscriptPath: '/tmp/b.jsonl', idleMs: 0 },
      hookCtx,
    )

    await Promise.all([
      exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, hookCtx),
      exports.hooks!['session.end']!({ sessionId: 'ses_b' } as SessionEndEvent, hookCtx),
    ])

    await waitFor(() => spawned.length >= 1, 'second spawn after failing first')
    expect(spawned).toHaveLength(1)
    expect((spawned[0]!.payload as { parentSessionId: string }).parentSessionId).toBe('ses_b')
  })

  test('a hanging spawn does not wedge the chain; subsequent fires recover after the timeout', async () => {
    // given a config where spawnTimeoutMs is short enough to fire in the
    // test window. without the spawn-side timeout, a non-settling
    // spawnSubagent would wedge spawnChain forever and every subsequent
    // session.end would block on the dead chain — silently coalescing all
    // future cron fires per the production failure mode.
    const spawned: SpawnCall[] = []
    const parsed = memoryPlugin.configSchema!.safeParse({
      idleMs: 60_000,
      bufferBytes: 0,
      spawnTimeoutMs: 30,
    })
    if (!parsed.success) throw new Error('config invalid')
    const { logger, logs } = makeCapturingLogger()
    let firstCall = true
    const ctx = createPluginContext({
      name: 'memory',
      version: undefined,
      agentDir,
      config: parsed.data,
      logger,
      permissions: noopPermissionService,
      spawnSubagent: async (name, payload) => {
        const startedAt = Date.now()
        if (firstCall) {
          firstCall = false
          await new Promise<void>(() => {})
          return
        }
        spawned.push({ name, payload, options: undefined, startedAt, finishedAt: Date.now() })
      },
      isBooted: () => true,
    })
    const exports = await memoryPlugin.plugin(ctx)
    const hookCtx = { agentDir, pluginName: 'memory', logger }

    // when two sessions fire end-to-end while the first spawn hangs forever
    await exports.hooks!['session.idle']!(
      { sessionId: 'ses_a', parentTranscriptPath: '/tmp/a.jsonl', idleMs: 0 },
      hookCtx,
    )
    await exports.hooks!['session.idle']!(
      { sessionId: 'ses_b', parentTranscriptPath: '/tmp/b.jsonl', idleMs: 0 },
      hookCtx,
    )

    const start = Date.now()
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, hookCtx)
    await exports.hooks!['session.end']!({ sessionId: 'ses_b' } as SessionEndEvent, hookCtx)
    const elapsed = Date.now() - start

    // The hook calls themselves return immediately (session.end is now
    // detached from the spawn chain), so the hung spawn must time out and
    // the second spawn must complete via the chain settling.
    await waitFor(() => spawned.length >= 1, 'second spawn after timeout')
    await waitFor(
      () => logs.error.some((m) => m.includes('memory-logger spawn failed') && m.includes('timed out after 30ms')),
      'timeout error log',
    )

    expect(elapsed).toBeLessThan(2000)
    expect(spawned).toHaveLength(1)
    expect((spawned[0]!.payload as { parentSessionId: string }).parentSessionId).toBe('ses_b')
    expect(logs.error.some((m) => m.includes('memory-logger spawn failed') && m.includes('timed out after 30ms'))).toBe(
      true,
    )
  })
})

describe('lifecycle logging', () => {
  beforeEach(installFakeClock)
  afterEach(uninstallFakeClock)

  test('logs `memory-logger spawn` with reason=idle when the debounce timer fires', async () => {
    const { logger, logs } = makeCapturingLogger()
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 1000 }, { logger })
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }

    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger })
    await tickMs(1100)
    await waitFor(
      () => logs.info.some((m) => m.includes('memory-logger spawn ses_a') && m.includes('reason=idle')),
      'memory-logger spawn ses_a reason=idle',
    )

    expect(logs.info.some((m) => m.includes('memory-logger spawn ses_a') && m.includes('reason=idle'))).toBe(true)
  })

  test('logs `memory-logger spawn` with reason=session-end when the session closes', async () => {
    const { logger, logs } = makeCapturingLogger()
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 60_000 }, { logger })
    const ctx = { agentDir, pluginName: 'memory', logger }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx)

    await waitFor(
      () => logs.info.some((m) => m.includes('memory-logger spawn ses_a') && m.includes('reason=session-end')),
      'memory-logger spawn ses_a reason=session-end',
    )
    expect(logs.info.some((m) => m.includes('memory-logger spawn ses_a') && m.includes('reason=session-end'))).toBe(
      true,
    )
  })

  test('logs `buffer-ceiling trip` and `memory-logger spawn reason=buffer-trip` when the size ceiling fires', async () => {
    const transcript = join(agentDir, 'transcript.jsonl')
    await writeFile(transcript, '')

    const { logger, logs } = makeCapturingLogger()
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 60_000, bufferBytes: 10_000 }, { logger })
    const ctx = { agentDir, pluginName: 'memory', logger }
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: transcript, idleMs: 0 }

    await exports.hooks!['session.idle']!(event, ctx)
    await appendFile(transcript, 'x'.repeat(10_000))
    await exports.hooks!['session.idle']!(event, ctx)

    expect(logs.info.some((m) => m.includes('buffer-ceiling trip ses_a') && m.includes('bufferBytes=10000'))).toBe(true)
    expect(logs.info.some((m) => m.includes('memory-logger spawn ses_a') && m.includes('reason=buffer-trip'))).toBe(
      true,
    )
  })
})

describe('doctor checks', () => {
  test('dir-writable: memory/topics/ missing → auto-creates and returns ok', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})

    const check = exports.doctorChecks?.['dir-writable']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('ok')
    expect(result.message).toContain('created')
    expect(existsSync(join(agentDir, 'memory', 'topics'))).toBe(true)
  })

  test('dir-writable: memory/topics/ already exists → ok', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    await mkdir(join(agentDir, 'memory', 'topics'), { recursive: true })

    const check = exports.doctorChecks?.['dir-writable']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('ok')
    expect(result.message).toContain('writable')
  })

  test('daily-stream-current: memory/streams/<today>.jsonl present → ok', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    const today = new Date().toISOString().slice(0, 10)
    await mkdir(join(agentDir, 'memory', 'streams'), { recursive: true })
    await writeFile(join(agentDir, 'memory', 'streams', `${today}.jsonl`), '', 'utf8')

    const check = exports.doctorChecks?.['daily-stream-current']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('ok')
    expect(result.message).toContain('present')
  })

  test('daily-stream-current: missing → warning with fix that creates file', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})

    const check = exports.doctorChecks?.['daily-stream-current']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('warning')
    expect(result.message).toContain('missing')
    expect(result.fix).toBeDefined()
    expect(result.fix!.apply).toBeDefined()

    const fixResult = await result.fix!.apply!({ pluginName: 'memory', agentDir, config: {}, logger })
    const today = new Date().toISOString().slice(0, 10)
    expect(fixResult.changedPaths).toContain(join('memory', 'streams', `${today}.jsonl`))
    expect(existsSync(join(agentDir, 'memory', 'streams', `${today}.jsonl`))).toBe(true)
  })

  test('pre-shard-backup-age: no backup → ok', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})

    const check = exports.doctorChecks?.['pre-shard-backup-age']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('ok')
    expect(result.message).toContain('no pre-shard backup present')
  })

  test('pre-shard-backup-age: backup ≤30 days → ok', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    const backupPath = join(agentDir, 'memory', 'MEMORY.md.pre-shard.bak')
    await mkdir(join(agentDir, 'memory'), { recursive: true })
    await writeFile(backupPath, 'backup', 'utf8')
    const now = new Date()
    await utimes(backupPath, now, now)

    const check = exports.doctorChecks?.['pre-shard-backup-age']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('ok')
    expect(result.message).toContain('under 30-day threshold')
  })

  test('pre-shard-backup-age: backup >30 days → warning with fix that deletes', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    const backupPath = join(agentDir, 'memory', 'MEMORY.md.pre-shard.bak')
    await mkdir(join(agentDir, 'memory'), { recursive: true })
    await writeFile(backupPath, 'backup', 'utf8')
    const old = new Date(Date.now() - 31 * 86_400_000)
    await utimes(backupPath, old, old)

    const check = exports.doctorChecks?.['pre-shard-backup-age']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('warning')
    expect(result.message).toContain('31 days old')
    expect(result.fix).toBeDefined()
    expect(result.fix!.apply).toBeDefined()

    const fixResult = await result.fix!.apply!({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(fixResult.summary).toContain('deleted')
    expect(existsSync(backupPath)).toBe(false)
  })

  test('vector-index: no-op ok when memory.vector is not enabled', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})

    const check = exports.doctorChecks?.['vector-index']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: { vector: { enabled: false } }, logger })
    expect(result.status).toBe('ok')
    expect(result.message).toContain('not enabled')
    expect(result.fix).toBeUndefined()
  })

  test('vector-index: when enabled, runs the real index check (ok for an empty agent)', async () => {
    // Booting with vector enabled opens the store, which creates the index DB,
    // so the realistic enabled-but-empty agent is healthy (nothing to index).
    const { exports } = await bootMemoryPlugin(agentDir, { vector: { enabled: true } })

    const check = exports.doctorChecks?.['vector-index']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: { vector: { enabled: true } }, logger })
    expect(result.status).toBe('ok')
    expect(result.message).toContain('0/0')
  })
})
