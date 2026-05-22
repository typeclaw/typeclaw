import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { noopPermissionService } from '@/permissions'
import type { PluginContext, PluginExports, PluginLogger, SessionEndEvent, SessionIdleEvent } from '@/plugin'
import { createPluginContext, createPluginLogger } from '@/plugin/context'

import memoryPlugin from './index'

type SpawnCall = { name: string; payload: unknown; startedAt: number; finishedAt: number }

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
  ctx: PluginContext<unknown>
}> {
  const spawned: SpawnCall[] = []
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
    spawnSubagent: async (name, payload) => {
      const startedAt = Date.now()
      if (spawnDelayMs > 0) await new Promise((r) => setTimeout(r, spawnDelayMs))
      const finishedAt = Date.now()
      spawned.push({ name, payload, startedAt, finishedAt })
    },
    isBooted: () => true,
  })
  const exports = await memoryPlugin.plugin(ctx)
  return { exports, spawned, ctx }
}

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'memory-plugin-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('memory plugin shape', () => {
  test('awaits migration before returning hooks', async () => {
    const memoryDir = join(agentDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(
      join(memoryDir, '2026-05-15.md'),
      '<!-- fragment source=sess-1 entry=ent-1 -->\n## Test Topic\nTest body\n',
      'utf8',
    )

    const { exports } = await bootMemoryPlugin(agentDir, {})

    expect(existsSync(join(memoryDir, 'streams', '2026-05-15.jsonl'))).toBe(true)
    expect(existsSync(join(memoryDir, '2026-05-15.md'))).toBe(false)
    expect(exports.hooks).toBeDefined()
    expect(exports.subagents).toBeDefined()
  })

  test('rejects plugin boot when migration fails', async () => {
    const memoryDir = join(agentDir, 'memory')
    await mkdir(join(memoryDir, '2026-05-15.md'), { recursive: true })

    await expect(bootMemoryPlugin(agentDir, {})).rejects.toThrow()
  })

  test('exposes both subagents', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    expect(Object.keys(exports.subagents ?? {})).toEqual(expect.arrayContaining(['memory-logger', 'dreaming']))
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

describe('session.prompt hook (removed)', () => {
  test('does NOT expose a session.prompt hook; memory injection is owned by core createResourceLoader so it can be positioned at the cache-suffix end of the system prompt', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    expect(exports.hooks?.['session.prompt']).toBeUndefined()
  })
})

describe('session.idle hook (debouncer)', () => {
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

    await new Promise((r) => setTimeout(r, 1100))

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
    await new Promise((r) => setTimeout(r, 1100))

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
    await new Promise((r) => setTimeout(r, 400))
    await exports.hooks!['session.idle']!(event, ctx)
    await new Promise((r) => setTimeout(r, 400))
    await exports.hooks!['session.idle']!(event, ctx)

    expect(spawned).toHaveLength(0)

    await new Promise((r) => setTimeout(r, 1200))

    expect(spawned).toHaveLength(1)
  })

  test('different sessionIds get independent timers', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/a.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.idle']!({ sessionId: 'ses_b', parentTranscriptPath: '/tmp/b.jsonl', idleMs: 0 }, ctx)

    await new Promise((r) => setTimeout(r, 1200))

    expect(spawned).toHaveLength(2)
    const sessions = spawned.map((c) => (c.payload as { parentSessionId: string }).parentSessionId).sort()
    expect(sessions).toEqual(['ses_a', 'ses_b'])
  })

  test('does NOT spawn when parentTranscriptPath is undefined (e.g. no persisted transcript)', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 1000 })
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: undefined, idleMs: 0 }
    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger: createPluginLogger('m') })

    await new Promise((r) => setTimeout(r, 1200))

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

    await new Promise((r) => setTimeout(r, 1200))

    expect(spawned).toHaveLength(0)
  })
})

describe('session.end hook', () => {
  test('cancels the idle timer and spawns memory-logger immediately on close', async () => {
    const { exports, spawned } = await bootMemoryPlugin(agentDir, { idleMs: 10_000 })
    const ctx = { agentDir, pluginName: 'memory', logger: createPluginLogger('m') }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx)

    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.name).toBe('memory-logger')
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

    await new Promise((r) => setTimeout(r, 1200))

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

describe('per-agent spawn serialization', () => {
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
        spawned.push({ name, payload, startedAt, finishedAt: Date.now() })
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
        spawned.push({ name, payload, startedAt, finishedAt: Date.now() })
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

    // then the hung spawn timed out within the configured ceiling, the
    // failure was logged with attribution, and the next spawn ran to
    // completion
    expect(elapsed).toBeLessThan(2000)
    expect(spawned).toHaveLength(1)
    expect((spawned[0]!.payload as { parentSessionId: string }).parentSessionId).toBe('ses_b')
    expect(logs.error.some((m) => m.includes('memory-logger spawn failed') && m.includes('timed out after 30ms'))).toBe(
      true,
    )
  })
})

describe('lifecycle logging', () => {
  test('logs `memory-logger spawn` with reason=idle when the debounce timer fires', async () => {
    const { logger, logs } = makeCapturingLogger()
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 1000 }, { logger })
    const event: SessionIdleEvent = { sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }

    await exports.hooks!['session.idle']!(event, { agentDir, pluginName: 'memory', logger })
    await new Promise((r) => setTimeout(r, 1100))

    expect(logs.info.some((m) => m.includes('memory-logger spawn ses_a') && m.includes('reason=idle'))).toBe(true)
  })

  test('logs `memory-logger spawn` with reason=session-end when the session closes', async () => {
    const { logger, logs } = makeCapturingLogger()
    const { exports } = await bootMemoryPlugin(agentDir, { idleMs: 60_000 }, { logger })
    const ctx = { agentDir, pluginName: 'memory', logger }

    await exports.hooks!['session.idle']!({ sessionId: 'ses_a', parentTranscriptPath: '/tmp/t.jsonl', idleMs: 0 }, ctx)
    await exports.hooks!['session.end']!({ sessionId: 'ses_a' } as SessionEndEvent, ctx)

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
  test('legacy-md-cleanup: Case A — only .md present → warning with fix.apply', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    const memoryDir = join(agentDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(
      join(memoryDir, '2026-05-15.md'),
      '<!-- fragment source=sess-1 entry=ent-1 -->\n## Test Topic\nTest body\n',
      'utf8',
    )

    const check = exports.doctorChecks?.['legacy-md-cleanup']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('warning')
    expect(result.message).toContain('legacy .md daily stream(s) still present')
    expect(result.fix).toBeDefined()
    expect(result.fix!.description).toContain('Re-run migration')
    expect(result.fix!.apply).toBeDefined()

    const fixResult = await result.fix!.apply!({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(fixResult.summary).toContain('migrated')
    expect(fixResult.changedPaths).toContain('memory/streams/2026-05-15.jsonl')
    expect(existsSync(join(memoryDir, '2026-05-15.md'))).toBe(false)
    expect(existsSync(join(memoryDir, 'streams', '2026-05-15.jsonl'))).toBe(true)
  })

  test('legacy-md-cleanup: Case B — both .md and .jsonl present → warning, no fix.apply', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    const memoryDir = join(agentDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, '2026-05-15.md'), 'legacy', 'utf8')
    await writeFile(join(memoryDir, '2026-05-15.jsonl'), '{}\n', 'utf8')

    const check = exports.doctorChecks?.['legacy-md-cleanup']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('warning')
    expect(result.message).toContain('Conflicting .md+.jsonl pair')
    expect(result.fix).toBeDefined()
    expect(result.fix!.description).toContain('Manual inspection required')
    expect(result.fix!.apply).toBeUndefined()
  })

  test('legacy-md-cleanup: clean state — only .jsonl files → ok', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})
    const memoryDir = join(agentDir, 'memory')
    await mkdir(memoryDir, { recursive: true })
    await writeFile(join(memoryDir, '2026-05-15.jsonl'), '{}\n', 'utf8')

    const check = exports.doctorChecks?.['legacy-md-cleanup']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('ok')
  })

  test('legacy-md-cleanup: no memory dir → ok', async () => {
    const { exports } = await bootMemoryPlugin(agentDir, {})

    const check = exports.doctorChecks?.['legacy-md-cleanup']
    expect(check).toBeDefined()

    const { logger } = makeCapturingLogger()
    const result = await check!.run({ pluginName: 'memory', agentDir, config: {}, logger })
    expect(result.status).toBe('ok')
  })
})
