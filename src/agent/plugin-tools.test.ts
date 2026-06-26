import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { defineTool as definePiTool } from '@mariozechner/pi-coding-agent'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'
import { z } from 'zod'

import { createPermissionService } from '@/permissions/permissions'
import { createHookBus, defineTool, type PluginRegistry, type ToolResult } from '@/plugin'
import { _resetBwrapAvailabilityCacheForTests, _resetRealProcProbeCacheForTests, SESSION_TMP_ROOT } from '@/sandbox'

import {
  __resetSharedLoopGuardForTests,
  buildBuiltinPiToolOverrides,
  defaultBuiltinPiAgentTools,
  forgetSharedLoopGuardTool,
  TYPECLAW_INTERNAL_BASH_ENV,
  wrapAgentToolAsCustomToolDefinition,
  wrapPluginTool,
  wrapSystemAgentTool,
  wrapSystemTool,
  zodToToolParameters,
} from './plugin-tools'
import type { SessionOrigin } from './session-origin'

beforeEach(() => {
  __resetSharedLoopGuardForTests()
})

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

function textOfFirstContent(result: { content: { type: string; text?: string }[] }): string | undefined {
  const first = result.content[0]
  return first?.type === 'text' ? first.text : undefined
}

describe('zodToToolParameters', () => {
  test('produces a JSON-schema-shaped object from a Zod schema', () => {
    const schema = z.object({ name: z.string(), age: z.number().optional() })
    const json = zodToToolParameters(schema) as { type?: string; properties?: Record<string, unknown> }
    expect(json.type).toBe('object')
    expect(json.properties).toBeDefined()
    expect(json.properties).toHaveProperty('name')
    expect(json.properties).toHaveProperty('age')
  })

  test('strips the $schema URI so Ajv (used by pi-ai) can compile the result', async () => {
    const schema = z.object({ path: z.string(), entryId: z.string().min(1) })
    const json = zodToToolParameters(schema) as Record<string, unknown>
    expect(json.$schema).toBeUndefined()

    const AjvModule = await import('ajv')
    const Ajv = (AjvModule as unknown as { default?: typeof AjvModule.default }).default ?? AjvModule
    const ajv = new (Ajv as new (...args: unknown[]) => { compile: (s: unknown) => unknown })({
      allErrors: true,
      strict: false,
      coerceTypes: true,
    })
    expect(() => ajv.compile(json)).not.toThrow()
  })

  test('preserves field-level constraints (format, pattern, minLength) after stripping $schema', () => {
    const schema = z.object({
      email: z.string().email(),
      id: z.string().uuid(),
      slug: z.string().min(1),
      pattern: z.string().regex(/^[a-z]+$/),
    })
    const json = zodToToolParameters(schema) as unknown as {
      properties: {
        email: { format?: string }
        id: { format?: string }
        slug: { minLength?: number }
        pattern: { pattern?: string }
      }
    }
    expect(json.properties.email.format).toBe('email')
    expect(json.properties.id.format).toBe('uuid')
    expect(json.properties.slug.minLength).toBe(1)
    expect(json.properties.pattern.pattern).toBe('^[a-z]+$')
  })
})

describe('wrapPluginTool', () => {
  test('passes parsed args to plugin execute and exposes ToolContext', async () => {
    const seen: { args: unknown; ctx: { sessionId: string; agentDir: string } }[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute(args, ctx) {
        seen.push({ args, ctx: { sessionId: ctx.sessionId, agentDir: ctx.agentDir } })
        return { content: [{ type: 'text', text: `q=${args.q}` }] }
      },
    })

    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'search',
      agentDir: '/agent',
      sessionId: 'sess-1',
      logger: noopLogger,
      hooks: createHookBus(),
    })

    const result = (await wrapped.execute('call-1', { q: 'hello' }, undefined, undefined, {} as never)) as {
      content: { type: string; text: string }[]
    }
    expect(result.content[0]?.text).toBe('q=hello')
    expect(seen[0]?.args).toEqual({ q: 'hello' })
    expect(seen[0]?.ctx.sessionId).toBe('sess-1')
    expect(seen[0]?.ctx.agentDir).toBe('/agent')
  })

  test('tool.before mutations to args propagate to the plugin tool execute', async () => {
    const seen: unknown[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute(args) {
        seen.push(args)
        return { content: [{ type: 'text', text: '' }] }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        event.args.q = 'mutated'
      },
    })

    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks,
    })

    await wrapped.execute('c', { q: 'original' }, undefined, undefined, {} as never)
    expect(seen[0]).toEqual({ q: 'mutated' })
  })

  test('tool.before { block: true } refuses execution and never invokes plugin tool', async () => {
    const calls: number[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        calls.push(1)
        return { content: [] }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': () => ({ block: true, reason: 'no thanks' }),
    })

    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks,
    })

    const result = (await wrapped.execute('c', {}, undefined, undefined, {} as never)) as {
      content: { type: string; text: string }[]
      isError?: boolean
    }
    expect(calls).toEqual([])
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('no thanks')
  })

  test('tool.after observes the plugin tool result', async () => {
    const observed: unknown[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        return { content: [{ type: 'text', text: 'done' }] }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.after': (event) => {
        observed.push(event.result.content[0])
      },
    })

    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks,
    })

    await wrapped.execute('c', {}, undefined, undefined, {} as never)
    expect(observed[0]).toEqual({ type: 'text', text: 'done' })
  })

  test('returns error result when args fail Zod validation', async () => {
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute() {
        return { content: [] }
      },
    })

    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks: createHookBus(),
    })
    const result = (await wrapped.execute('c', { q: 42 }, undefined, undefined, {} as never)) as {
      isError?: boolean
    }
    expect(result.isError).toBe(true)
  })

  test('returns error result when plugin tool throws', async () => {
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        throw new Error('kaboom')
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks: createHookBus(),
    })
    const result = (await wrapped.execute('c', {}, undefined, undefined, {} as never)) as {
      isError?: boolean
      content: { type: string; text: string }[]
    }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('kaboom')
  })

  test('forwards the AbortSignal from the engine through to the plugin tool', async () => {
    const captured: { signal: AbortSignal | undefined } = { signal: undefined }
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute(_args, ctx) {
        captured.signal = ctx.signal
        return { content: [] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'x',
      agentDir: '/agent',
      sessionId: 's',
      logger: noopLogger,
      hooks: createHookBus(),
    })

    const controller = new AbortController()
    await wrapped.execute('c', {}, controller.signal, undefined, {} as never)
    expect(captured.signal).toBe(controller.signal)
  })
})

describe('wrapSystemTool', () => {
  test('tool.before mutations propagate to TypeClaw system tool execution and tool.after can rewrite the result', async () => {
    const seen: unknown[] = []
    const observed: unknown[] = []
    const tool = definePiTool({
      name: 'reload',
      label: 'reload',
      description: '',
      parameters: Type.Object({ q: Type.String() }),
      async execute(_callId, params) {
        seen.push(params)
        return { content: [{ type: 'text', text: `q=${params.q}` }], details: { q: params.q } }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        event.args.q = 'mutated'
      },
      'tool.after': (event) => {
        observed.push(event.result.details)
        event.result.content = [{ type: 'text', text: 'rewritten' }]
        event.result.details = { rewritten: true }
      },
    })

    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    const result = await wrapped.execute('c', { q: 'original' }, undefined, undefined, {} as never)
    expect(textOfFirstContent(result)).toBe('rewritten')
    expect(result.details).toEqual({ rewritten: true })
    expect(seen[0]).toEqual({ q: 'mutated' })
    expect(observed[0]).toEqual({ q: 'mutated' })
  })

  test('tool.before { block: true } rejects TypeClaw system tool execution through the engine error path', async () => {
    const calls: number[] = []
    const tool = definePiTool({
      name: 'restart',
      label: 'restart',
      description: '',
      parameters: Type.Object({}),
      async execute() {
        calls.push(1)
        return { content: [], details: undefined }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': () => ({ block: true, reason: 'no restart' }),
    })

    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    await expect(wrapped.execute('c', {}, undefined, undefined, {} as never)).rejects.toThrow('blocked: no restart')
    expect(calls).toEqual([])
  })

  test('write system tool exposes and strips guard acknowledgements before execution', async () => {
    const seen: unknown[] = []
    const tool = definePiTool({
      name: 'write',
      label: 'write',
      description: '',
      parameters: Type.Object(
        {
          path: Type.String(),
          content: Type.String(),
        },
        { additionalProperties: false },
      ),
      async execute(_callId, params) {
        seen.push(params)
        return { content: [{ type: 'text', text: 'wrote' }], details: params }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        expect(event.args.acknowledgeGuards).toEqual({ nonWorkspaceWrite: true })
      },
    })

    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    const parameters = wrapped.parameters as { properties?: Record<string, unknown> }
    expect(parameters.properties).toHaveProperty('acknowledgeGuards')
    await wrapped.execute(
      'c',
      { path: 'typeclaw.json', content: '{}', acknowledgeGuards: { nonWorkspaceWrite: true } },
      undefined,
      undefined,
      {} as never,
    )

    expect(seen[0]).toEqual({ path: 'typeclaw.json', content: '{}' })
  })

  test('write system tool runs a final guard after hook mutations', async () => {
    const calls: number[] = []
    const tool = definePiTool({
      name: 'write',
      label: 'write',
      description: '',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute() {
        calls.push(1)
        return { content: [], details: undefined }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        event.args.path = 'notes.md'
      },
    })

    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    await expect(
      wrapped.execute('c', { path: 'workspace/file.txt', content: 'x' }, undefined, undefined, {} as never),
    ).rejects.toThrow('Guard `nonWorkspaceWrite` blocked write outside the workspace')
    expect(calls).toEqual([])
  })

  test('write system tool runs final skill guard after hook mutations', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-plugin-tools-'))
    await mkdir(path.join(agentDir, 'memory', 'skills'), { recursive: true })
    const calls: number[] = []
    const tool = definePiTool({
      name: 'write',
      label: 'write',
      description: '',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute() {
        calls.push(1)
        return { content: [], details: undefined }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', agentDir, noopLogger, {
      'tool.before': (event) => {
        event.args.path = 'memory/skills/release-checklist/SKILL.md'
        event.args.content = 'not a skill file'
      },
    })

    const wrapped = wrapSystemTool(tool, { agentDir, sessionId: 's', hooks })

    await expect(
      wrapped.execute('c', { path: 'workspace/file.txt', content: 'x' }, undefined, undefined, {} as never),
    ).rejects.toThrow('Guard `skillAuthoring` blocked write')
    expect(calls).toEqual([])
  })

  test('write system tool runs final managed-config guard after hook mutations', async () => {
    const calls: number[] = []
    const tool = definePiTool({
      name: 'write',
      label: 'write',
      description: '',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute() {
        calls.push(1)
        return { content: [], details: undefined }
      },
    })
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        event.args.path = 'typeclaw.json'
        event.args.content = '{ not valid json'
      },
    })

    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    await expect(
      wrapped.execute('c', { path: 'workspace/file.txt', content: 'x' }, undefined, undefined, {} as never),
    ).rejects.toThrow('Guard `managedConfig` blocked write')
    expect(calls).toEqual([])
  })
})

describe('wrapSystemAgentTool', () => {
  test('tool.before and tool.after fire for built-in pi-style agent tools and can rewrite the result', async () => {
    const seen: unknown[] = []
    const observed: unknown[] = []
    const tool = {
      name: 'read',
      label: 'read',
      description: '',
      parameters: Type.Object({ path: Type.String() }),
      async execute(_callId: string, params: { path: string }) {
        seen.push(params)
        return { content: [{ type: 'text' as const, text: params.path }], details: { path: params.path } }
      },
    }
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        event.args.path = '/mutated'
      },
      'tool.after': (event) => {
        observed.push(event.result.details)
        event.result.content = [{ type: 'text', text: 'rewritten read' }]
        event.result.details = { rewritten: true }
      },
    })

    const wrapped = wrapSystemAgentTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    const result = await wrapped.execute('c', { path: '/original' })
    expect(textOfFirstContent(result)).toBe('rewritten read')
    expect(result.details as Record<string, unknown>).toEqual({ rewritten: true })
    expect(seen[0]).toEqual({ path: '/mutated' })
    expect(observed[0]).toEqual({ path: '/mutated' })
  })

  test('tool.before { block: true } rejects built-in pi-style agent tool execution through the engine error path', async () => {
    const calls: number[] = []
    const tool = {
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: Type.Object({ command: Type.String() }),
      async execute(_callId: string, _params: { command: string }) {
        calls.push(1)
        return { content: [], details: undefined }
      },
    }
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': () => ({ block: true, reason: 'no bash' }),
    })

    const wrapped = wrapSystemAgentTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    await expect(wrapped.execute('c', { command: 'pwd' })).rejects.toThrow('blocked: no bash')
    expect(calls).toEqual([])
  })

  // pi's bash tool REJECTS on non-zero exit. Without a finally-style after-run,
  // a tool.after hook that releases a reservation (the github approve guard)
  // never fires, stranding the PR as "already approved" on retry (PR #672).
  test('tool.after fires with an error result when a built-in agent tool throws, then rethrows', async () => {
    const afterResults: unknown[] = []
    const tool = {
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: Type.Object({ command: Type.String() }),
      async execute(_callId: string, _params: { command: string }) {
        throw new Error('no such file or directory')
      },
    }
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.after': (event) => {
        afterResults.push(event.result)
      },
    })

    const wrapped = wrapAgentToolAsCustomToolDefinition(tool, { agentDir: '/agent', sessionId: 's', hooks })

    await expect(
      wrapped.execute('c', { command: 'gh api --input /tmp/x' } as never, undefined, undefined, {} as never),
    ).rejects.toThrow('no such file or directory')
    expect(afterResults).toHaveLength(1)
    const errorText = ((afterResults[0] as ToolResult).content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
    expect(errorText).toContain('no such file or directory')
  })

  test('edit built-in agent tool exposes and strips guard acknowledgements before execution', async () => {
    const seen: unknown[] = []
    const tool = {
      name: 'edit',
      label: 'edit',
      description: '',
      parameters: Type.Object(
        {
          path: Type.String(),
          edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
        },
        { additionalProperties: false },
      ),
      async execute(
        _callId: string,
        params: {
          path: string
          edits: { oldText: string; newText: string }[]
          acknowledgeGuards?: { nonWorkspaceWrite?: boolean }
        },
      ) {
        seen.push(params)
        return { content: [{ type: 'text' as const, text: 'edited' }], details: params }
      },
    }
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        expect(event.args.acknowledgeGuards).toEqual({ nonWorkspaceWrite: true })
      },
    })

    const wrapped = wrapSystemAgentTool(tool, { agentDir: '/agent', sessionId: 's', hooks })

    const parameters = wrapped.parameters as { properties?: Record<string, unknown> }
    expect(parameters.properties).toHaveProperty('acknowledgeGuards')
    const params = {
      path: 'notes.md',
      edits: [{ oldText: 'x', newText: 'y' }],
      acknowledgeGuards: { nonWorkspaceWrite: true },
    } as unknown as Parameters<typeof wrapped.execute>[1]
    await wrapped.execute('c', params)

    expect(seen[0]).toEqual({ path: 'notes.md', edits: [{ oldText: 'x', newText: 'y' }] })
  })
})

describe('getOrigin (live origin holder)', () => {
  test('wrapPluginTool: tool.before sees the current value of getOrigin() at execute time, not at wrap time', async () => {
    // Regression for: channel sessions need per-turn lastInboundAuthorId on
    // tool.before so permission gating can resolve author: rules against the
    // current actor, not the cold-start origin captured at session creation.
    const seenOrigins: (unknown | undefined)[] = []
    const hooks = createHookBus()
    hooks.registerAll('p', '/agent', noopLogger, {
      'tool.before': (event) => {
        seenOrigins.push(event.origin)
        return undefined
      },
    })
    const ref: { current: unknown } = { current: { kind: 'tui', sessionId: 's-A' } }
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p',
      toolName: 't',
      agentDir: '/agent',
      sessionId: 'sess',
      logger: noopLogger,
      hooks,
      getOrigin: () => ref.current as never,
    })

    await wrapped.execute('c1', {}, undefined, undefined, {} as never)
    ref.current = { kind: 'tui', sessionId: 's-B' }
    await wrapped.execute('c2', {}, undefined, undefined, {} as never)

    expect(seenOrigins).toEqual([
      { kind: 'tui', sessionId: 's-A' },
      { kind: 'tui', sessionId: 's-B' },
    ])
  })

  test('wrapSystemTool: same dynamic-origin contract', async () => {
    const seenOrigins: (unknown | undefined)[] = []
    const hooks = createHookBus()
    hooks.registerAll('p', '/agent', noopLogger, {
      'tool.before': (event) => {
        seenOrigins.push(event.origin)
        return undefined
      },
    })
    const ref: { current: unknown } = { current: { kind: 'cron', jobId: 'j1', jobKind: 'prompt' } }
    const tool = definePiTool({
      name: 'sys',
      label: 'sys',
      description: '',
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }], details: undefined }
      },
    })
    const wrapped = wrapSystemTool(tool, {
      agentDir: '/agent',
      sessionId: 'sess',
      hooks,
      getOrigin: () => ref.current as never,
    })

    await wrapped.execute('c1', {}, undefined, undefined, {} as never)
    ref.current = { kind: 'cron', jobId: 'j2', jobKind: 'prompt' }
    await wrapped.execute('c2', {}, undefined, undefined, {} as never)

    expect((seenOrigins[0] as { jobId: string }).jobId).toBe('j1')
    expect((seenOrigins[1] as { jobId: string }).jobId).toBe('j2')
  })
})

describe('resolveBuiltinToolRefs (dual-route)', () => {
  test('pi-side coding tools go to agentTools, typeclaw-side web tools go to toolDefinitions', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    const resolved = resolveBuiltinToolRefs([
      { __builtinTool: 'read' },
      { __builtinTool: 'bash' },
      { __builtinTool: 'edit' },
      { __builtinTool: 'write' },
      { __builtinTool: 'grep' },
      { __builtinTool: 'find' },
      { __builtinTool: 'ls' },
      { __builtinTool: 'web_search' },
      { __builtinTool: 'web_fetch' },
    ])
    expect(resolved.agentTools.map((t) => t.name)).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])
    expect(resolved.toolDefinitions.map((t) => t.name)).toEqual(['web_search', 'web_fetch'])
  })

  test('pi-side resolve to pi-coding-agent AgentTool exports by reference equality (not *ToolDefinition variant)', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    const pi = await import('@mariozechner/pi-coding-agent')
    const cases: { name: string; expected: unknown }[] = [
      { name: 'read', expected: pi.readTool },
      { name: 'edit', expected: pi.editTool },
      { name: 'write', expected: pi.writeTool },
      { name: 'grep', expected: pi.grepTool },
      { name: 'find', expected: pi.findTool },
      { name: 'ls', expected: pi.lsTool },
    ]
    for (const { name, expected } of cases) {
      const r = resolveBuiltinToolRefs([{ __builtinTool: name }])
      expect(r.agentTools.length).toBe(1)
      expect(r.toolDefinitions.length).toBe(0)
      expect(r.agentTools[0]).toBe(expected as never)
    }
  })

  test('bash resolves to a typeclaw-constructed AgentTool (spawnHook-wired), not pi.bashTool', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    const pi = await import('@mariozechner/pi-coding-agent')
    const r = resolveBuiltinToolRefs([{ __builtinTool: 'bash' }])
    expect(r.agentTools.length).toBe(1)
    expect(r.toolDefinitions.length).toBe(0)
    expect(r.agentTools[0]?.name).toBe('bash')
    // It is our own instance carrying the env-overlay spawnHook, not the raw
    // pi export — reference inequality is the observable proof.
    expect(r.agentTools[0]).not.toBe(pi.bashTool as never)
  })

  test('typeclaw-side resolve to the original ToolDefinition imports by reference equality', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    const { webSearchTool } = await import('./tools/websearch')
    const { webFetchTool } = await import('./tools/webfetch')
    const ws = resolveBuiltinToolRefs([{ __builtinTool: 'web_search' }])
    const wf = resolveBuiltinToolRefs([{ __builtinTool: 'web_fetch' }])
    expect(ws.agentTools).toEqual([])
    expect(ws.toolDefinitions[0]).toBe(webSearchTool)
    expect(wf.agentTools).toEqual([])
    expect(wf.toolDefinitions[0]).toBe(webFetchTool)
  })

  test('mixed refs partition correctly: scout-shape (web only) leaves agentTools empty', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    const r = resolveBuiltinToolRefs([{ __builtinTool: 'web_search' }, { __builtinTool: 'web_fetch' }])
    expect(r.agentTools).toEqual([])
    expect(r.toolDefinitions.map((t) => t.name).sort()).toEqual(['web_fetch', 'web_search'])
  })

  test('mixed refs partition correctly: explorer-shape (coding only) leaves toolDefinitions empty', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    const r = resolveBuiltinToolRefs([
      { __builtinTool: 'read' },
      { __builtinTool: 'grep' },
      { __builtinTool: 'find' },
      { __builtinTool: 'ls' },
      { __builtinTool: 'bash' },
    ])
    expect(r.toolDefinitions).toEqual([])
    expect(r.agentTools.map((t) => t.name).sort()).toEqual(['bash', 'find', 'grep', 'ls', 'read'])
  })

  test('throws on unknown built-in names', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    expect(() => resolveBuiltinToolRefs([{ __builtinTool: 'nope' }])).toThrow(/unknown built-in tool ref/)
  })
})

describe('wrapAgentToolAsCustomToolDefinition (pi customTools override path)', () => {
  test('the returned ToolDefinition runs tool.before/runFinalWriteGuards before delegating to the underlying pi AgentTool', async () => {
    let executedUnderlying = 0
    const beforeArgs: unknown[] = []
    const tool = {
      name: 'edit',
      label: 'edit',
      description: '',
      parameters: Type.Object({
        path: Type.String(),
        edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
      }),
      async execute(_id: string, _params: unknown) {
        executedUnderlying++
        return { content: [{ type: 'text' as const, text: 'underlying ran' }], details: undefined }
      },
    }
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        beforeArgs.push({ ...event.args })
      },
    })

    const wrapped = wrapAgentToolAsCustomToolDefinition(tool, { agentDir: '/agent', sessionId: 's', hooks })

    expect(wrapped.name).toBe('edit')
    const result = await wrapped.execute(
      'c',
      { path: 'workspace/notes.md', edits: [{ oldText: 'a', newText: 'b' }] },
      undefined,
      undefined,
      {} as never,
    )
    expect(textOfFirstContent(result)).toBe('underlying ran')
    expect(executedUnderlying).toBe(1)
    expect(beforeArgs).toEqual([{ path: 'workspace/notes.md', edits: [{ oldText: 'a', newText: 'b' }] }])
  })

  test('regression: managedConfig guard blocks an edit that would produce invalid typeclaw.json, on the customTool override path', async () => {
    // PR #283's failure mode: pi 0.67.3 ignores `tools:` for implementation
    // overrides, so the channel-session `edit` tool that landed in a host
    // agent folder ran pi's internal builtin and bypassed
    // both `tool.before` and `runFinalWriteGuards`. The fix routes wrapped
    // builtin pi tools through `customTools`, which IS the override path
    // pi honors. This test pins the post-fix behavior end-to-end: a tool
    // call that mutates typeclaw.json to an invalid shape MUST be blocked
    // by `runFinalWriteGuards` (which calls `checkManagedConfigGuard`),
    // before the underlying pi `edit` is invoked.
    const dir = await mkdtemp(path.join(tmpdir(), 'typeclaw-managed-config-'))
    const configPath = path.join(dir, 'typeclaw.json')
    const validConfig = {
      models: { default: 'anthropic/claude-haiku-4-5' },
    }
    await Bun.write(configPath, `${JSON.stringify(validConfig, null, 2)}\n`)

    let executedUnderlying = 0
    const tool = {
      name: 'edit',
      label: 'edit',
      description: '',
      parameters: Type.Object({
        path: Type.String(),
        edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
      }),
      async execute(_id: string, _params: unknown) {
        executedUnderlying++
        return { content: [{ type: 'text' as const, text: 'should not run' }], details: undefined }
      },
    }
    const hooks = createHookBus()
    hooks.registerAll('p1', dir, noopLogger, {})

    const wrapped = wrapAgentToolAsCustomToolDefinition(tool, { agentDir: dir, sessionId: 's', hooks })

    await expect(
      wrapped.execute(
        'c',
        {
          path: configPath,
          edits: [{ oldText: 'anthropic/claude-haiku-4-5', newText: 'kimi' }],
        },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(/Guard `managedConfig` blocked edit/)
    expect(executedUnderlying).toBe(0)
  })

  test('defaultBuiltinPiAgentTools returns the seven pi coding-tool refs that need hook coverage', async () => {
    const tools = defaultBuiltinPiAgentTools()
    expect(tools.map((t) => t.name)).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])
  })

  test('buildBuiltinPiToolOverrides produces same-named ToolDefinitions ready for customTools', async () => {
    const hooks = createHookBus()
    const overrides = buildBuiltinPiToolOverrides({ agentDir: '/agent', sessionId: 's', hooks })
    expect(overrides.map((t) => t.name)).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])
  })

  test('buildBuiltinPiToolOverrides preserves edit guard-acknowledgement schema (so the model can pass acknowledgeGuards on edit)', async () => {
    const hooks = createHookBus()
    const overrides = buildBuiltinPiToolOverrides({ agentDir: '/agent', sessionId: 's', hooks })
    const edit = overrides.find((t) => t.name === 'edit')
    expect(edit).toBeDefined()
    const params = (edit as ToolDefinition).parameters as { properties?: Record<string, unknown> }
    expect(params.properties).toBeDefined()
    expect(params.properties).toHaveProperty('acknowledgeGuards')
  })

  // given: the security plugin's tool.before policies read
  //   `acknowledgeGuards.<guardName>: true` keys
  // when: a new high-tier guard ships expecting an ack key
  // then: the published JSON Schema for `acknowledgeGuards` MUST advertise
  //       that key, OR strict-mode LLM clients (OpenAI strict tool calling,
  //       Anthropic with `additionalProperties: false`) will refuse to emit
  //       it AND lax clients will strip it before the tool wrapper sees it.
  //       This test pins every ack key the security/guard plugins read.
  test('ACKNOWLEDGE_GUARDS_SCHEMA advertises every guard key the security/guard plugins read', async () => {
    const hooks = createHookBus()
    const overrides = buildBuiltinPiToolOverrides({ agentDir: '/agent', sessionId: 's', hooks })
    const write = overrides.find((t) => t.name === 'write')
    const params = (write as ToolDefinition).parameters as { properties?: Record<string, unknown> }
    const ack = params.properties?.acknowledgeGuards as { properties?: Record<string, unknown> } | undefined
    expect(ack).toBeDefined()
    const ackProps = ack?.properties ?? {}
    expect(ackProps).toHaveProperty('nonWorkspaceWrite')
    expect(ackProps).toHaveProperty('rolePromotion')
    expect(ackProps).toHaveProperty('cronPromotion')
  })

  // given: the acknowledgeGuards schema permits exactly the keys we
  //   advertise
  // when: a future refactor relaxes the schema to allow arbitrary keys
  // then: typos like `acknowledgeGuards: { rolePromotin: true }` would
  //   silently no-op (the strict schema currently rejects them, so the
  //   model gets immediate feedback). Pin additionalProperties:false on
  //   BOTH write and edit since both expose the schema. Oracle PR #305
  //   finding #7.
  test('ACKNOWLEDGE_GUARDS_SCHEMA pins additionalProperties:false on write and edit (no silent typo passthrough)', async () => {
    const hooks = createHookBus()
    const overrides = buildBuiltinPiToolOverrides({ agentDir: '/agent', sessionId: 's', hooks })
    for (const toolName of ['write', 'edit'] as const) {
      const tool = overrides.find((t) => t.name === toolName)
      const params = (tool as ToolDefinition).parameters as { properties?: Record<string, unknown> }
      const ack = params.properties?.acknowledgeGuards as { additionalProperties?: boolean } | undefined
      expect(ack).toBeDefined()
      expect(ack?.additionalProperties).toBe(false)
    }
  })
})

describe('wrapAgentToolAsCustomToolDefinition bash sandbox (role-derived path hiding)', () => {
  beforeEach(() => {
    _resetBwrapAvailabilityCacheForTests()
    _resetRealProcProbeCacheForTests()
  })

  function fakeBash(record: { command?: string }) {
    return {
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: Type.Object({ command: Type.String() }),
      async execute(_id: string, params: { command: string }) {
        record.command = params.command
        return { content: [{ type: 'text' as const, text: 'ran' }], details: undefined }
      },
    }
  }

  const tui: SessionOrigin = { kind: 'tui', sessionId: 's' }
  const guest: SessionOrigin = { kind: 'subagent', subagent: 'x', parentSessionId: 'p', spawnedByRole: 'guest' }

  test('trusted+ (tui→owner) has no masks, so bash runs unchanged even without bwrap', async () => {
    const record: { command?: string } = {}
    const wrapped = wrapAgentToolAsCustomToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
    })
    await wrapped.execute('c', { command: 'echo hi' }, undefined, undefined, {} as never)
    expect(record.command).toBe('echo hi')
  })

  test('guest needs masks; with bwrap unavailable the call fails closed and the underlying bash never runs', async () => {
    const record: { command?: string } = {}
    const wrapped = wrapAgentToolAsCustomToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
      getOrigin: () => guest,
      permissions: createPermissionService(),
    })
    await expect(
      wrapped.execute('c', { command: 'cat /agent/.env' }, undefined, undefined, {} as never),
    ).rejects.toThrow()
    expect(record.command).toBeUndefined()
  })

  test('without a permission service bash is never rewritten (escape hatch for unwired sessions)', async () => {
    const record: { command?: string } = {}
    const wrapped = wrapAgentToolAsCustomToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
      getOrigin: () => guest,
    })
    await wrapped.execute('c', { command: 'echo hi' }, undefined, undefined, {} as never)
    expect(record.command).toBe('echo hi')
  })

  test('a hook-set env overlay is stripped from args and never reaches the command (non-sandboxed)', async () => {
    const record: { command?: string } = {}
    const hooks = createHookBus()
    hooks.registerAll('env-setter', '/agent', noopLogger, {
      'tool.before': (event) => {
        ;(event.args as Record<string, unknown>)[TYPECLAW_INTERNAL_BASH_ENV] = { GH_TOKEN: 'ghs_minted' }
      },
    })
    const args: Record<string, unknown> = { command: 'gh pr view -R acme/widgets' }
    const wrapped = wrapAgentToolAsCustomToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks,
      getOrigin: () => tui,
      permissions: createPermissionService(),
    })
    await wrapped.execute('c', args as never, undefined, undefined, {} as never)
    expect(record.command).toBe('gh pr view -R acme/widgets')
    expect(args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
  })

  test('a client-supplied env overlay is stripped before hooks run (only trusted hooks may set it)', async () => {
    const record: { command?: string } = {}
    let seenInHook: unknown = 'unset'
    const hooks = createHookBus()
    hooks.registerAll('observer', '/agent', noopLogger, {
      'tool.before': (event) => {
        seenInHook = (event.args as Record<string, unknown>)[TYPECLAW_INTERNAL_BASH_ENV]
      },
    })
    const args: Record<string, unknown> = {
      command: 'echo hi',
      [TYPECLAW_INTERNAL_BASH_ENV]: { GH_TOKEN: 'attacker' },
    }
    const wrapped = wrapAgentToolAsCustomToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks,
      getOrigin: () => tui,
      permissions: createPermissionService(),
    })
    await wrapped.execute('c', args as never, undefined, undefined, {} as never)
    expect(seenInHook).toBeUndefined()
  })
})

describe('wrapAgentToolAsCustomToolDefinition subagent bash policy (capability fence, role-independent)', () => {
  function fakeBash(record: { command?: string }) {
    return {
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: Type.Object({ command: Type.String() }),
      async execute(_id: string, params: { command: string }) {
        record.command = params.command
        return { content: [{ type: 'text' as const, text: 'ran' }], details: undefined }
      },
    }
  }

  const ownerTui: SessionOrigin = { kind: 'tui', sessionId: 's' }

  test('readonly-reviewer policy blocks a mutating command and the underlying bash never runs — even for a trusted owner origin', async () => {
    const record: { command?: string } = {}
    const wrapped = wrapAgentToolAsCustomToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
      getOrigin: () => ownerTui,
      permissions: createPermissionService(),
      bashPolicy: { kind: 'readonly-reviewer' },
    })
    await expect(
      wrapped.execute('c', { command: 'git push origin HEAD' }, undefined, undefined, {} as never),
    ).rejects.toThrow()
    expect(record.command).toBeUndefined()
  })

  test('readonly-reviewer policy lets a read-only command through (and the role sandbox still leaves an owner command unchanged)', async () => {
    const record: { command?: string } = {}
    const wrapped = wrapAgentToolAsCustomToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
      getOrigin: () => ownerTui,
      permissions: createPermissionService(),
      bashPolicy: { kind: 'readonly-reviewer' },
    })
    await wrapped.execute('c', { command: 'git status' }, undefined, undefined, {} as never)
    expect(record.command).toBe('git status')
  })

  test('no bashPolicy leaves bash unrestricted (default subagents keep today behavior)', async () => {
    const record: { command?: string } = {}
    const wrapped = wrapAgentToolAsCustomToolDefinition(fakeBash(record), {
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
      getOrigin: () => ownerTui,
      permissions: createPermissionService(),
    })
    await wrapped.execute('c', { command: 'git push origin HEAD' }, undefined, undefined, {} as never)
    expect(record.command).toBe('git push origin HEAD')
  })
})

describe('wrapAgentToolAsCustomToolDefinition /tmp path redirect (per-session scratch)', () => {
  function fakeWrite(record: { path?: string }) {
    return {
      name: 'write',
      label: 'write',
      description: '',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute(_id: string, params: { path: string; content: string }) {
        record.path = params.path
        return { content: [{ type: 'text' as const, text: 'wrote' }], details: undefined }
      },
    }
  }

  function fakeRead(record: { path?: string }) {
    return {
      name: 'read',
      label: 'read',
      description: '',
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id: string, params: { path: string }) {
        record.path = params.path
        return { content: [{ type: 'text' as const, text: 'read' }], details: undefined }
      },
    }
  }

  const tui: SessionOrigin = { kind: 'tui', sessionId: 's' }
  const guest: SessionOrigin = { kind: 'subagent', subagent: 'x', parentSessionId: 'p', spawnedByRole: 'guest' }

  test('a sandboxed role (guest) has its /tmp write redirected to the session backing dir', async () => {
    const record: { path?: string } = {}
    const wrapped = wrapAgentToolAsCustomToolDefinition(fakeWrite(record), {
      agentDir: '/agent',
      sessionId: 'sid42',
      hooks: createHookBus(),
      getOrigin: () => guest,
      permissions: createPermissionService(),
    })
    await wrapped.execute('c', { path: '/tmp/review.json', content: '{}' } as never, undefined, undefined, {} as never)
    expect(record.path).toBe(`${SESSION_TMP_ROOT}/sid42/review.json`)
  })

  test('a sandboxed role (guest) reading /tmp resolves to the same session backing dir bash wrote', async () => {
    const record: { path?: string } = {}
    const wrapped = wrapAgentToolAsCustomToolDefinition(fakeRead(record), {
      agentDir: '/agent',
      sessionId: 'sid42',
      hooks: createHookBus(),
      getOrigin: () => guest,
      permissions: createPermissionService(),
    })
    await wrapped.execute('c', { path: '/tmp/review.json' } as never, undefined, undefined, {} as never)
    expect(record.path).toBe(`${SESSION_TMP_ROOT}/sid42/review.json`)
  })

  test('an unsandboxed role (tui→owner) writes the real /tmp path untouched', async () => {
    const record: { path?: string } = {}
    const wrapped = wrapAgentToolAsCustomToolDefinition(fakeWrite(record), {
      agentDir: '/agent',
      sessionId: 'sid42',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
    })
    await wrapped.execute('c', { path: '/tmp/review.json', content: '{}' } as never, undefined, undefined, {} as never)
    expect(record.path).toBe('/tmp/review.json')
  })

  test('an unsandboxed role (tui→owner) reads the real /tmp path untouched', async () => {
    const record: { path?: string } = {}
    const wrapped = wrapAgentToolAsCustomToolDefinition(fakeRead(record), {
      agentDir: '/agent',
      sessionId: 'sid42',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
    })
    await wrapped.execute('c', { path: '/tmp/review.json' } as never, undefined, undefined, {} as never)
    expect(record.path).toBe('/tmp/review.json')
  })

  test('a non-/tmp write is left untouched even for a sandboxed role', async () => {
    const record: { path?: string } = {}
    const wrapped = wrapAgentToolAsCustomToolDefinition(fakeWrite(record), {
      agentDir: '/agent',
      sessionId: 'sid42',
      hooks: createHookBus(),
      getOrigin: () => guest,
      permissions: createPermissionService(),
    })
    await wrapped.execute(
      'c',
      { path: 'workspace/out.json', content: '{}' } as never,
      undefined,
      undefined,
      {} as never,
    )
    expect(record.path).toBe('workspace/out.json')
  })

  // Mirrors pi's real write tool, which echoes the path back ("Successfully
  // wrote N bytes to <path>"). The leaked backing path does not exist inside
  // the bwrap bash sandbox, so a model that pastes it into `gh api --input`
  // hits "no such file or directory" (the PR #672 strand this guards).
  function fakeWriteEchoingPath() {
    return {
      name: 'write',
      label: 'write',
      description: '',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      async execute(_id: string, params: { path: string; content: string }) {
        return {
          content: [{ type: 'text' as const, text: `Successfully wrote 2 bytes to ${params.path}` }],
          details: { path: params.path },
        }
      },
    }
  }

  test('a sandboxed role sees its original /tmp path in the receipt, not the backing dir', async () => {
    const wrapped = wrapAgentToolAsCustomToolDefinition(fakeWriteEchoingPath(), {
      agentDir: '/agent',
      sessionId: 'sid42',
      hooks: createHookBus(),
      getOrigin: () => guest,
      permissions: createPermissionService(),
    })
    const result = await wrapped.execute(
      'c',
      { path: '/tmp/review.json', content: '{}' } as never,
      undefined,
      undefined,
      {} as never,
    )
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
    expect(text).toContain('/tmp/review.json')
    expect(text).not.toContain(`${SESSION_TMP_ROOT}/sid42`)
  })

  test('an unsandboxed role keeps the real /tmp path in the receipt (no rewrite)', async () => {
    const wrapped = wrapAgentToolAsCustomToolDefinition(fakeWriteEchoingPath(), {
      agentDir: '/agent',
      sessionId: 'sid42',
      hooks: createHookBus(),
      getOrigin: () => tui,
      permissions: createPermissionService(),
    })
    const result = await wrapped.execute(
      'c',
      { path: '/tmp/review.json', content: '{}' } as never,
      undefined,
      undefined,
      {} as never,
    )
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
    expect(text).toContain('/tmp/review.json')
  })
})

describe('setupSession integration: builtin pi tools route through customTools when hooks are present', () => {
  // End-to-end seam test for the bug PR #283 thought it had closed: PR #283's
  // managedConfig guard only fires when the active `edit` tool is the wrapped
  // one — but pi 0.67.3 ignores `tools:` for implementation, so without
  // routing wrapped builtins through `customTools`, the active `edit` is
  // pi's internal builtin and the guard never sees the call. This test
  // builds a real AgentSession via `createSession` and asserts that the
  // active `edit` came from `sdk` (customTools override) rather than
  // `builtin`. If the override wiring in `setupSession` is removed, this
  // test fails immediately.
  let agentDir: string
  let prevCwd: string
  let prevFireworks: string | undefined

  beforeEach(async () => {
    agentDir = await mkdtemp(path.join(tmpdir(), 'typeclaw-guard-wiring-'))
    prevCwd = process.cwd()
    prevFireworks = process.env.FIREWORKS_API_KEY
    process.env.FIREWORKS_API_KEY = 'fw_test'
    process.chdir(agentDir)
    await Bun.write(
      path.join(agentDir, 'typeclaw.json'),
      JSON.stringify({ models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' } }),
    )
    const { reloadConfig } = await import('@/config/config')
    reloadConfig(agentDir)
  })

  afterEach(async () => {
    if (prevFireworks === undefined) delete process.env.FIREWORKS_API_KEY
    else process.env.FIREWORKS_API_KEY = prevFireworks
    const { __resetConfigForTesting } = await import('@/config/config')
    const { resetAuthForTesting } = await import('./auth')
    __resetConfigForTesting()
    resetAuthForTesting()
    process.chdir(prevCwd)
    await rm(agentDir, { recursive: true, force: true })
  })

  test('with tool.before hooks present, the active `edit` is the customTools override (sourceInfo.source === "sdk"), not pi\'s builtin', async () => {
    const { createSession } = await import('./index')
    const hooks = createHookBus()
    hooks.registerAll('p1', agentDir, noopLogger, {
      'tool.before': () => undefined,
    })
    const registry: PluginRegistry = {
      tools: [],
      subagents: [],
      cronJobs: [],
      mcpServers: [],
      skills: [],
      skillsDirs: [],
      doctorChecks: [],
      commands: [],
      disposers: [],
    }

    const session = await createSession({
      plugins: { registry, hooks, sessionId: 'test-session', agentDir },
    })

    const allTools = session.getAllTools()
    const editInfo = allTools.find((t) => t.name === 'edit')
    expect(editInfo).toBeDefined()
    expect(editInfo?.sourceInfo.source).toBe('sdk')

    session.dispose()
  })

  test("without any tool hooks, the active `edit` falls through to pi's builtin (no wrapping overhead)", async () => {
    const { createSession } = await import('./index')

    const session = await createSession({})

    const allTools = session.getAllTools()
    const editInfo = allTools.find((t) => t.name === 'edit')
    expect(editInfo).toBeDefined()
    expect(editInfo?.sourceInfo.source).toBe('builtin')

    session.dispose()
  })

  test('regression: subagent declaring [edit] only must NOT also activate read/bash/write/grep/find/ls just because builtin overrides exist in customTools', async () => {
    // The customTools override path widens pi's active tool set as a side effect:
    // pi's `_refreshToolRegistry` runs with `includeAllExtensionTools: true`,
    // which appends every customTool name into `nextActiveToolNames` even when
    // the caller passed a narrow `tools:` filter. Without explicit re-narrowing,
    // a subagent declaring `toolRefs: [{ __builtinTool: 'edit' }]` ends up with
    // all 7 builtin pi tools (read/bash/edit/write/grep/find/ls) active, which
    // is a security regression — a read-only memory-logger subagent silently
    // gets full edit/write/bash capability. See QA finding for PR #290.
    const { createSession } = await import('./index')
    const hooks = createHookBus()
    hooks.registerAll('p1', agentDir, noopLogger, {
      'tool.before': () => undefined,
    })
    const registry: PluginRegistry = {
      tools: [],
      subagents: [],
      cronJobs: [],
      mcpServers: [],
      skills: [],
      skillsDirs: [],
      doctorChecks: [],
      commands: [],
      disposers: [],
    }

    const session = await createSession({
      plugins: { registry, hooks, sessionId: 'test-session', agentDir },
      pluginSubagent: { pluginName: 'p1', toolRefs: [{ __builtinTool: 'edit' }], toolNamePrefix: 's' },
    })

    expect(session.getActiveToolNames().sort()).toEqual(['edit'])

    session.dispose()
  })

  test('subagent declaring [read, grep] gets exactly those two active, with the wrapped (sdk) implementations', async () => {
    const { createSession } = await import('./index')
    const hooks = createHookBus()
    hooks.registerAll('p1', agentDir, noopLogger, {
      'tool.before': () => undefined,
    })
    const registry: PluginRegistry = {
      tools: [],
      subagents: [],
      cronJobs: [],
      mcpServers: [],
      skills: [],
      skillsDirs: [],
      doctorChecks: [],
      commands: [],
      disposers: [],
    }

    const session = await createSession({
      plugins: { registry, hooks, sessionId: 'test-session', agentDir },
      pluginSubagent: {
        pluginName: 'p1',
        toolRefs: [{ __builtinTool: 'read' }, { __builtinTool: 'grep' }],
        toolNamePrefix: 's',
      },
    })

    expect(session.getActiveToolNames().sort()).toEqual(['grep', 'read'])
    const all = session.getAllTools()
    const readInfo = all.find((t) => t.name === 'read')
    const grepInfo = all.find((t) => t.name === 'grep')
    expect(readInfo?.sourceInfo.source).toBe('sdk')
    expect(grepInfo?.sourceInfo.source).toBe('sdk')

    session.dispose()
  })

  test('TUI session with hooks gets exactly pi default 4 active builtins (read/bash/edit/write) plus typeclaw customTools, not all 7 pi builtins', async () => {
    // TUI/channel sessions pass no `options.tools`, so the intended active
    // set is pi's defaultActiveToolNames union the typeclaw customSystemTools.
    // The unconditional inclusion of grep/find/ls overrides would otherwise
    // widen the TUI's active set silently — not a security regression like
    // the subagent case, but still an unintended scope expansion.
    const { createSession } = await import('./index')
    const hooks = createHookBus()
    hooks.registerAll('p1', agentDir, noopLogger, {
      'tool.before': () => undefined,
    })
    const registry: PluginRegistry = {
      tools: [],
      subagents: [],
      cronJobs: [],
      mcpServers: [],
      skills: [],
      skillsDirs: [],
      doctorChecks: [],
      commands: [],
      disposers: [],
    }

    const session = await createSession({
      plugins: { registry, hooks, sessionId: 'test-session', agentDir },
    })

    const active = new Set(session.getActiveToolNames())
    expect(active.has('read')).toBe(true)
    expect(active.has('bash')).toBe(true)
    expect(active.has('edit')).toBe(true)
    expect(active.has('write')).toBe(true)
    expect(active.has('grep')).toBe(false)
    expect(active.has('find')).toBe(false)
    expect(active.has('ls')).toBe(false)

    session.dispose()
  })
})

describe('loop guard integration', () => {
  test('appends a soft-warning suffix to a plugin tool result on the third identical call', async () => {
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute(args) {
        return { content: [{ type: 'text', text: `q=${args.q}` }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'search',
      agentDir: '/agent',
      sessionId: 'loop-plugin-1',
      logger: noopLogger,
      hooks: createHookBus(),
    })

    const r1 = (await wrapped.execute('c1', { q: 'a' }, undefined, undefined, {} as never)) as {
      content: { type: string; text: string }[]
    }
    expect(r1.content.length).toBe(1)

    await wrapped.execute('c2', { q: 'a' }, undefined, undefined, {} as never)
    const r3 = (await wrapped.execute('c3', { q: 'a' }, undefined, undefined, {} as never)) as {
      content: { type: string; text: string }[]
    }
    expect(r3.content.length).toBe(2)
    expect(r3.content[1]?.text).toContain('loop-guard')
    expect(r3.content[1]?.text).toContain('search')
  })

  test('refuses the fifth identical plugin tool call with an error result and never invokes the tool', async () => {
    const calls: number[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute() {
        calls.push(1)
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'search',
      agentDir: '/agent',
      sessionId: 'loop-plugin-2',
      logger: noopLogger,
      hooks: createHookBus(),
    })

    for (let i = 0; i < 4; i++) {
      await wrapped.execute(`c${i}`, { q: 'a' }, undefined, undefined, {} as never)
    }
    expect(calls.length).toBe(4)
    const blocked = (await wrapped.execute('c5', { q: 'a' }, undefined, undefined, {} as never)) as {
      isError?: boolean
      content: { type: string; text: string }[]
    }
    expect(calls.length).toBe(4)
    expect(blocked.isError).toBe(true)
    expect(blocked.content[0]?.text).toContain('loop-guard')
  })

  test('forgetSharedLoopGuardTool clears the shared streak for the named tool so the next call passes', async () => {
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute(args) {
        return { content: [{ type: 'text', text: `q=${args.q}` }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'search',
      agentDir: '/agent',
      sessionId: 'loop-forget-1',
      logger: noopLogger,
      hooks: createHookBus(),
    })

    for (let i = 0; i < 4; i++) {
      await wrapped.execute(`c${i}`, { q: 'a' }, undefined, undefined, {} as never)
    }
    forgetSharedLoopGuardTool('loop-forget-1', 'search')
    const after = (await wrapped.execute('c5', { q: 'a' }, undefined, undefined, {} as never)) as {
      isError?: boolean
    }
    expect(after.isError).toBeUndefined()
  })

  test('resets the streak when the args change between plugin tool calls', async () => {
    const calls: string[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute(args) {
        calls.push(args.q)
        return { content: [{ type: 'text', text: args.q }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'search',
      agentDir: '/agent',
      sessionId: 'loop-plugin-3',
      logger: noopLogger,
      hooks: createHookBus(),
    })

    await wrapped.execute('c1', { q: 'a' }, undefined, undefined, {} as never)
    await wrapped.execute('c2', { q: 'a' }, undefined, undefined, {} as never)
    await wrapped.execute('c3', { q: 'b' }, undefined, undefined, {} as never)
    await wrapped.execute('c4', { q: 'b' }, undefined, undefined, {} as never)
    const r5 = (await wrapped.execute('c5', { q: 'b' }, undefined, undefined, {} as never)) as {
      isError?: boolean
      content: { type: string; text: string }[]
    }
    expect(r5.isError).not.toBe(true)
    expect(r5.content[1]?.text).toContain('loop-guard')
    expect(calls).toEqual(['a', 'a', 'b', 'b', 'b'])
  })

  test('throws on the fifth identical system tool call so the engine surfaces the loop error', async () => {
    const calls: number[] = []
    const tool = definePiTool({
      name: 'web_fetch',
      label: 'web_fetch',
      description: '',
      parameters: Type.Object({ url: Type.String() }),
      async execute() {
        calls.push(1)
        return { content: [{ type: 'text', text: 'ok' }], details: undefined }
      },
    })
    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 'loop-sys-1', hooks: createHookBus() })

    for (let i = 0; i < 4; i++) {
      await wrapped.execute(`c${i}`, { url: 'https://example.com' }, undefined, undefined, {} as never)
    }
    expect(calls.length).toBe(4)
    await expect(
      wrapped.execute('c5', { url: 'https://example.com' }, undefined, undefined, {} as never),
    ).rejects.toThrow(/loop-guard/)
    expect(calls.length).toBe(4)
  })

  test('keeps loop streaks isolated between sessions', async () => {
    const calls: { session: string }[] = []
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })

    const make = (sessionId: string) => {
      return wrapPluginTool(tool, {
        pluginName: 'p1',
        toolName: 'search',
        agentDir: '/agent',
        sessionId,
        logger: noopLogger,
        hooks: createHookBus(),
      })
    }

    const wA = make('loop-iso-A')
    const wB = make('loop-iso-B')

    for (let i = 0; i < 4; i++) {
      await wA.execute(`a${i}`, {}, undefined, undefined, {} as never)
      calls.push({ session: 'A' })
    }
    const aBlocked = (await wA.execute('a5', {}, undefined, undefined, {} as never)) as { isError?: boolean }
    expect(aBlocked.isError).toBe(true)

    const bFirst = (await wB.execute('b1', {}, undefined, undefined, {} as never)) as { isError?: boolean }
    expect(bFirst.isError).not.toBe(true)
  })

  test('aborts the turn when a plugin tool is blocked so the model cannot keep retrying', async () => {
    let aborts = 0
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'search',
      agentDir: '/agent',
      sessionId: 'loop-abort-plugin',
      logger: noopLogger,
      hooks: createHookBus(),
      getAbort: () => () => {
        aborts += 1
      },
    })

    for (let i = 0; i < 4; i++) {
      await wrapped.execute(`c${i}`, { q: 'a' }, undefined, undefined, {} as never)
    }
    expect(aborts).toBe(0)
    await wrapped.execute('c5', { q: 'a' }, undefined, undefined, {} as never)
    expect(aborts).toBe(1)
  })

  test('aborts the turn when a system tool is blocked, alongside the thrown loop error', async () => {
    let aborts = 0
    const tool = definePiTool({
      name: 'web_fetch',
      label: 'web_fetch',
      description: '',
      parameters: Type.Object({ url: Type.String() }),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }], details: undefined }
      },
    })
    const wrapped = wrapSystemTool(tool, {
      agentDir: '/agent',
      sessionId: 'loop-abort-sys',
      hooks: createHookBus(),
      getAbort: () => () => {
        aborts += 1
      },
    })

    for (let i = 0; i < 4; i++) {
      await wrapped.execute(`c${i}`, { url: 'https://example.com' }, undefined, undefined, {} as never)
    }
    expect(aborts).toBe(0)
    await expect(
      wrapped.execute('c5', { url: 'https://example.com' }, undefined, undefined, {} as never),
    ).rejects.toThrow(/loop-guard/)
    expect(aborts).toBe(1)
  })

  test('does not abort while calls are still under the block threshold', async () => {
    let aborts = 0
    const tool = defineTool({
      description: '',
      parameters: z.object({ q: z.string() }),
      async execute() {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    })
    const wrapped = wrapPluginTool(tool, {
      pluginName: 'p1',
      toolName: 'search',
      agentDir: '/agent',
      sessionId: 'loop-abort-warn-only',
      logger: noopLogger,
      hooks: createHookBus(),
      getAbort: () => () => {
        aborts += 1
      },
    })

    for (let i = 0; i < 4; i++) {
      await wrapped.execute(`c${i}`, { q: 'a' }, undefined, undefined, {} as never)
    }
    expect(aborts).toBe(0)
  })

  // A subagent_output poll that returns status:'running' is a still-pending
  // wait, not a loop. The wrapper retracts it from the guard so round-robin
  // fan-out polling never false-blocks (the production incident).
  function makeSubagentOutputTool(statusFor: (taskId: string, callIdx: number) => 'running' | 'completed') {
    let callIdx = 0
    const calls: string[] = []
    const tool = definePiTool({
      name: 'subagent_output',
      label: 'subagent_output',
      description: '',
      parameters: Type.Object({ task_id: Type.String() }),
      async execute(_id, params: { task_id: string }) {
        const status = statusFor(params.task_id, callIdx++)
        calls.push(params.task_id)
        return {
          content: [{ type: 'text' as const, text: status }],
          details: { ok: true, status, taskId: params.task_id, subagent: 'scout', durationMs: 1 },
        }
      },
    })
    return { tool, calls }
  }

  test('never blocks subagent_output polls that keep returning running', async () => {
    const { tool, calls } = makeSubagentOutputTool(() => 'running')
    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 'poll-running', hooks: createHookBus() })

    // Replay the incident shape: 6 task_ids polled round-robin for many waves.
    const tasks = ['bg_1', 'bg_2', 'bg_3', 'bg_4', 'bg_5', 'bg_6']
    for (let wave = 0; wave < 12; wave++) {
      for (const task_id of tasks) {
        const r = (await wrapped.execute(`c${wave}`, { task_id }, undefined, undefined, {} as never)) as {
          isError?: boolean
        }
        expect(r.isError).not.toBe(true)
      }
    }
    expect(calls.length).toBe(72)
  })

  test('still blocks a subagent_output poll that repeats a terminal result', async () => {
    // Every poll of bg_done returns 'completed' (terminal). The 5th poll is the
    // block boundary: it executes once (deferred) to reveal 'completed', is
    // marked terminal-known, then throws. From the 6th on the signature is known
    // terminal, so the block is enforced PRE-execute and the tool stops running.
    const { tool, calls } = makeSubagentOutputTool(() => 'completed')
    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 'poll-terminal', hooks: createHookBus() })

    // Four polls execute and each marks the signature terminal-known.
    for (let i = 0; i < 4; i++) {
      await wrapped.execute(`c${i}`, { task_id: 'bg_done' }, undefined, undefined, {} as never)
    }
    expect(calls.length).toBe(4)
    // The 5th poll hits the hard-block threshold; because the signature is
    // already terminal-known the block is NOT deferred — it fires pre-execute,
    // so the tool does not run and never will for further identical polls.
    for (let i = 5; i < 10; i++) {
      await expect(wrapped.execute(`c${i}`, { task_id: 'bg_done' }, undefined, undefined, {} as never)).rejects.toThrow(
        /loop-guard/,
      )
    }
    expect(calls.length).toBe(4)
  })

  test('repeated back-to-back polls of one still-running task never block', async () => {
    // A tight loop on ONE task_id (consecutive detector territory). Every poll
    // returns 'running', so every one is retracted — the streak never sticks and
    // the boundary poll past the hard-block threshold still executes.
    const { tool, calls } = makeSubagentOutputTool(() => 'running')
    const wrapped = wrapSystemTool(tool, { agentDir: '/agent', sessionId: 'poll-consecutive', hooks: createHookBus() })

    for (let i = 0; i < 10; i++) {
      const r = (await wrapped.execute(`c${i}`, { task_id: 'bg_b' }, undefined, undefined, {} as never)) as {
        isError?: boolean
      }
      expect(r.isError).not.toBe(true)
    }
    expect(calls.length).toBe(10)
  })
})
