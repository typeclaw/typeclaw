import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import type { PermissionService } from '@/permissions'
import { createStream } from '@/stream'

import type { AgentSession } from '../index'
import { LiveSubagentRegistry } from '../live-subagents'
import type { SessionOrigin } from '../session-origin'
import type { CreateSessionForSubagent, Subagent, SubagentRegistry } from '../subagents'
import { createSpawnSubagentTool } from './spawn-subagent'

const ctx = {} as Parameters<ReturnType<typeof createSpawnSubagentTool>['execute']>[4]

type StubSession = AgentSession & { emit: (event: unknown) => void; abortCount: { n: number } }

function stubSession(): StubSession {
  const calls = { prompt: [] as string[], disposed: 0, abortCount: { n: 0 } }
  let listener: ((event: unknown) => void) | null = null
  const session = {
    prompt: async (text: string) => {
      calls.prompt.push(text)
      await new Promise((r) => setImmediate(r))
    },
    dispose: () => {
      calls.disposed += 1
    },
    subscribe: (l: (event: unknown) => void) => {
      listener = l
      return () => {
        listener = null
      }
    },
    abort: async () => {
      calls.abortCount.n += 1
    },
    emit: (event: unknown) => listener?.(event),
    abortCount: calls.abortCount,
  } as unknown as StubSession
  return session
}

function emittingSession(emitOnPrompt: () => unknown): StubSession {
  const session = stubSession()
  const orig = session.prompt.bind(session)
  session.prompt = async (text: string) => {
    const event = emitOnPrompt()
    if (event !== undefined) session.emit(event)
    await orig(text)
  }
  return session
}

function makeRegistry(overrides: Record<string, Subagent<unknown>> = {}): SubagentRegistry {
  const publicSub: Subagent<unknown> = { systemPrompt: 'You are public.', visibility: 'public' }
  const internalSub: Subagent<unknown> = { systemPrompt: 'You are internal.' }
  return {
    explorer: publicSub,
    'memory-logger': internalSub,
    ...overrides,
  }
}

function fixedSpawn(opts: {
  createSession: CreateSessionForSubagent
  registry?: SubagentRegistry
  permissions?: PermissionService
  parentSessionId?: string
}) {
  const registry = opts.registry ?? makeRegistry()
  const liveRegistry = new LiveSubagentRegistry()
  let counter = 0
  const tool = createSpawnSubagentTool({
    registry,
    liveRegistry,
    createSessionForSubagent: opts.createSession,
    agentDir: '/agent',
    parentSessionId: opts.parentSessionId ?? 'ses_parent',
    getOrigin: () => ({ kind: 'tui', sessionId: 'ses_parent' }),
    ...(opts.permissions ? { permissions: opts.permissions } : {}),
    generateTaskId: () => {
      counter += 1
      return `bg_test${counter}`
    },
    now: () => 1_000,
    stream: createStream(),
  })
  return { tool, liveRegistry, registry }
}

describe('createSpawnSubagentTool — visibility gate', () => {
  test('public subagent (explorer) spawns successfully', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({ createSession: async () => session })

    const result = await tool.execute(
      'call_1',
      { subagent_type: 'explorer', prompt: 'find X' },
      undefined,
      undefined,
      ctx,
    )
    const details = result.details as { ok: boolean; mode?: string }
    expect(details.ok).toBe(true)
    expect(details.mode).toBe('sync')
  })

  test('internal subagent (memory-logger) is rejected as unknown', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({ createSession: async () => session })

    const result = await tool.execute(
      'call_1',
      {
        subagent_type: 'memory-logger',
        prompt: 'consolidate',
      },
      undefined,
      undefined,
      ctx,
    )
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('Unknown subagent: memory-logger')
  })

  test('unknown subagent error does NOT leak internal subagent names', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({ createSession: async () => session })

    const result = await tool.execute(
      'call_1',
      {
        subagent_type: 'memory-logger',
        prompt: 'consolidate',
      },
      undefined,
      undefined,
      ctx,
    )
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).not.toContain('memory-logger\b')
    expect(text).toContain('Available: explorer')
  })

  test('empty public-subagent set surfaces "(none)" in error', async () => {
    const internalOnly: SubagentRegistry = {
      'memory-logger': { systemPrompt: 'internal' },
    }
    const session = stubSession()
    const { tool } = fixedSpawn({ createSession: async () => session, registry: internalOnly })

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('Available: (none)')
  })
})

describe('createSpawnSubagentTool — sync mode', () => {
  test('returns mode=sync with final message captured from message_end event', async () => {
    const session = emittingSession(() => ({
      type: 'message_end',
      message: { content: 'Found three matches in src/.' },
    }))
    const { tool, liveRegistry } = fixedSpawn({ createSession: async () => session })

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)

    const details = result.details as {
      ok: boolean
      mode?: string
      taskId?: string
      finalMessage?: string
    }
    expect(details.ok).toBe(true)
    expect(details.mode).toBe('sync')
    expect(details.taskId).toBe('bg_test1')
    expect(details.finalMessage).toBe('Found three matches in src/.')
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toBe('Found three matches in src/.')
    expect(liveRegistry.get('bg_test1')?.status).toBe('completed')
  })

  test('returns mode=sync with synthesized text when no final message was captured', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({ createSession: async () => session })

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toMatch(/explorer completed in/)
  })

  test('propagates failure with error envelope when subagent throws', async () => {
    const session = stubSession()
    session.prompt = async () => {
      throw new Error('provider exploded')
    }
    const { tool, liveRegistry } = fixedSpawn({ createSession: async () => session })

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toBe('provider exploded')
    expect(liveRegistry.get('bg_test1')?.status).toBe('failed')
  })
})

describe('createSpawnSubagentTool — background mode', () => {
  test('returns immediately with task_id and registers as running', async () => {
    let resolvePrompt: () => void = () => {}
    const session = stubSession()
    session.prompt = () =>
      new Promise<void>((r) => {
        resolvePrompt = r
      })
    const { tool, liveRegistry } = fixedSpawn({ createSession: async () => session })

    const result = await tool.execute(
      'call_1',
      {
        subagent_type: 'explorer',
        prompt: 'long search',
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx,
    )

    const details = result.details as { ok: boolean; mode?: string; taskId?: string }
    expect(details.ok).toBe(true)
    expect(details.mode).toBe('background')
    expect(details.taskId).toBe('bg_test1')
    expect(liveRegistry.get('bg_test1')?.status).toBe('running')

    resolvePrompt()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
  })

  test('background completion publishes a subagent.completed broadcast to the stream', async () => {
    const stream = createStream()
    const events: unknown[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      events.push(msg.payload)
    })
    const liveRegistry = new LiveSubagentRegistry()
    const session = stubSession()
    let counter = 0
    const tool = createSpawnSubagentTool({
      registry: makeRegistry(),
      liveRegistry,
      createSessionForSubagent: async () => session,
      agentDir: '/agent',
      parentSessionId: 'ses_parent',
      getOrigin: () => ({ kind: 'tui', sessionId: 'ses_parent' }),
      stream,
      generateTaskId: () => {
        counter += 1
        return `bg_b${counter}`
      },
      now: () => 1_000,
    })

    const result = await tool.execute(
      'call_1',
      {
        subagent_type: 'explorer',
        prompt: 'q',
        run_in_background: true,
      },
      undefined,
      undefined,
      ctx,
    )
    const details = result.details as { ok: boolean; taskId?: string }
    expect(details.ok).toBe(true)

    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(events.length).toBeGreaterThan(0)
    const completion = events.find((e) => (e as { kind?: string }).kind === 'subagent.completed') as
      | Record<string, unknown>
      | undefined
    expect(completion).toBeDefined()
    expect(completion?.taskId).toBe(details.taskId)
    expect(completion?.subagent).toBe('explorer')
    expect(completion?.ok).toBe(true)
  })
})

describe('createSpawnSubagentTool — permissions gating', () => {
  function permService(allowed: Set<string>): PermissionService {
    return {
      has: (_origin, permission) => allowed.has(permission),
      resolveRole: () => 'tester',
      describe: () => ({ role: 'tester', permissions: [...allowed] }),
      replaceRoles: () => {},
    }
  }

  test('denied when origin lacks subagent.spawn and no per-subagent permission', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({
      createSession: async () => session,
      permissions: permService(new Set()),
    })

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('denied')
  })

  test('allowed via generic subagent.spawn fallback', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({
      createSession: async () => session,
      permissions: permService(new Set(['subagent.spawn'])),
    })

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean }
    expect(details.ok).toBe(true)
  })

  test('allowed via per-subagent permission even without generic spawn', async () => {
    const session = stubSession()
    const { tool } = fixedSpawn({
      createSession: async () => session,
      permissions: permService(new Set(['subagent.spawn.explorer'])),
    })

    const result = await tool.execute('call_1', { subagent_type: 'explorer', prompt: 'q' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean }
    expect(details.ok).toBe(true)
  })

  test('requiresSpecificPermission=true subagent IGNORES the generic subagent.spawn (per-subagent only)', async () => {
    const session = stubSession()
    const restrictedRegistry: SubagentRegistry = {
      operator: {
        systemPrompt: 'You are restricted.',
        visibility: 'public',
        requiresSpecificPermission: true,
      },
    }
    const { tool } = fixedSpawn({
      createSession: async () => session,
      registry: restrictedRegistry,
      permissions: permService(new Set(['subagent.spawn'])),
    })

    const result = await tool.execute('call_1', { subagent_type: 'operator', prompt: 'q' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error).toContain('denied')
  })

  test('requiresSpecificPermission=true subagent IS spawnable when the specific permission is held', async () => {
    const session = stubSession()
    const restrictedRegistry: SubagentRegistry = {
      operator: {
        systemPrompt: 'You are restricted.',
        visibility: 'public',
        requiresSpecificPermission: true,
      },
    }
    const { tool } = fixedSpawn({
      createSession: async () => session,
      registry: restrictedRegistry,
      permissions: permService(new Set(['subagent.spawn.operator'])),
    })

    const result = await tool.execute('call_1', { subagent_type: 'operator', prompt: 'q' }, undefined, undefined, ctx)
    const details = result.details as { ok: boolean }
    expect(details.ok).toBe(true)
  })
})

describe('createSpawnSubagentTool — concurrency', () => {
  test('two concurrent spawns get distinct task_ids', async () => {
    let resolveA: () => void = () => {}
    let resolveB: () => void = () => {}
    const sessions = [
      (() => {
        const s = stubSession()
        s.prompt = () =>
          new Promise<void>((r) => {
            resolveA = r
          })
        return s
      })(),
      (() => {
        const s = stubSession()
        s.prompt = () =>
          new Promise<void>((r) => {
            resolveB = r
          })
        return s
      })(),
    ]
    let idx = 0
    const liveRegistry = new LiveSubagentRegistry()
    let counter = 0
    const tool = createSpawnSubagentTool({
      registry: makeRegistry(),
      liveRegistry,
      createSessionForSubagent: async () => {
        const s = sessions[idx]
        if (s === undefined) throw new Error('out of sessions')
        idx += 1
        return s
      },
      agentDir: '/agent',
      parentSessionId: 'ses_parent',
      getOrigin: () => ({ kind: 'tui', sessionId: 'ses_parent' }),
      generateTaskId: () => {
        counter += 1
        return `bg_p${counter}`
      },
      now: () => 1_000,
    })

    const p1 = tool.execute(
      'call_1',
      { subagent_type: 'explorer', prompt: 'a', run_in_background: true },
      undefined,
      undefined,
      ctx,
    )
    const p2 = tool.execute(
      'call_2',
      { subagent_type: 'explorer', prompt: 'b', run_in_background: true },
      undefined,
      undefined,
      ctx,
    )
    const [r1, r2] = await Promise.all([p1, p2])
    const d1 = r1.details as { taskId: string }
    const d2 = r2.details as { taskId: string }

    expect(d1.taskId).toBe('bg_p1')
    expect(d2.taskId).toBe('bg_p2')
    expect(d1.taskId).not.toBe(d2.taskId)
    expect(
      liveRegistry
        .list()
        .map((e) => e.taskId)
        .sort(),
    ).toEqual(['bg_p1', 'bg_p2'])

    resolveA()
    resolveB()
    await new Promise((r) => setImmediate(r))
  })
})

describe('createSpawnSubagentTool — structured payload forwarding', () => {
  function reviewerLikeRegistry(captured: { payload?: unknown }): SubagentRegistry {
    const reviewerLike: Subagent<{ requestId?: string; prompt?: string; reviewTarget?: unknown }> = {
      systemPrompt: 'You review.',
      visibility: 'public',
      payloadSchema: z
        .object({
          requestId: z.string().optional(),
          prompt: z.string().optional(),
          description: z.string().optional(),
          reviewTarget: z.unknown().optional(),
        })
        .passthrough(),
      handler: async (toolCtx, runSession) => {
        captured.payload = toolCtx.payload
        await runSession()
      },
    }
    return { reviewer: reviewerLike }
  }

  test('forwards caller payload fields (reviewTarget) to the subagent', async () => {
    const captured: { payload?: unknown } = {}
    const { tool } = fixedSpawn({
      createSession: async () => stubSession(),
      registry: reviewerLikeRegistry(captured),
    })

    await tool.execute(
      'call_1',
      {
        subagent_type: 'reviewer',
        prompt: 'review it',
        payload: { reviewTarget: { kind: 'github-pr', owner: 'o', repo: 'r', pullNumber: 7 } },
      },
      undefined,
      undefined,
      ctx,
    )

    expect((captured.payload as { reviewTarget?: unknown }).reviewTarget).toEqual({
      kind: 'github-pr',
      owner: 'o',
      repo: 'r',
      pullNumber: 7,
    })
  })

  test('reserved keys win: caller cannot override requestId or prompt', async () => {
    const captured: { payload?: unknown } = {}
    const { tool } = fixedSpawn({
      createSession: async () => stubSession(),
      registry: reviewerLikeRegistry(captured),
    })

    await tool.execute(
      'call_1',
      {
        subagent_type: 'reviewer',
        prompt: 'real prompt',
        payload: { requestId: 'EVIL', prompt: 'EVIL' },
      },
      undefined,
      undefined,
      ctx,
    )

    const payload = captured.payload as { requestId?: string; prompt?: string }
    expect(payload.requestId).toBe('bg_test1')
    expect(payload.prompt).toBe('real prompt')
  })

  test('strict (non-passthrough) schema rejects unknown caller payload field', async () => {
    const strictSub: Subagent<{ requestId?: string; prompt?: string }> = {
      systemPrompt: 'strict',
      visibility: 'public',
      payloadSchema: z.object({ requestId: z.string().optional(), prompt: z.string().optional() }).strict(),
    }
    const { tool } = fixedSpawn({
      createSession: async () => stubSession(),
      registry: { strict: strictSub },
    })

    const result = await tool.execute(
      'call_1',
      { subagent_type: 'strict', prompt: 'q', payload: { bogus: 'nope' } },
      undefined,
      undefined,
      ctx,
    )

    const details = result.details as { ok: boolean; error?: string }
    expect(details.ok).toBe(false)
    expect(details.error ?? '').toMatch(/invalid payload/i)
  })
})
