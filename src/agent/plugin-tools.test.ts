import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { defineTool as definePiTool } from '@mariozechner/pi-coding-agent'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'
import { z } from 'zod'

import { createHookBus, defineTool, type PluginRegistry } from '@/plugin'

import {
  __resetSharedLoopGuardForTests,
  buildBuiltinPiToolOverrides,
  defaultBuiltinPiAgentTools,
  wrapAgentToolAsCustomToolDefinition,
  wrapPluginTool,
  wrapSystemAgentTool,
  wrapSystemTool,
  zodToToolParameters,
} from './plugin-tools'

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
      { __builtinTool: 'websearch' },
      { __builtinTool: 'webfetch' },
    ])
    expect(resolved.agentTools.map((t) => t.name)).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'])
    expect(resolved.toolDefinitions.map((t) => t.name)).toEqual(['websearch', 'webfetch'])
  })

  test('pi-side resolve to pi-coding-agent AgentTool exports by reference equality (not *ToolDefinition variant)', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    const pi = await import('@mariozechner/pi-coding-agent')
    const cases: { name: string; expected: unknown }[] = [
      { name: 'read', expected: pi.readTool },
      { name: 'bash', expected: pi.bashTool },
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

  test('typeclaw-side resolve to the original ToolDefinition imports by reference equality', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    const { websearchTool } = await import('./tools/websearch')
    const { webfetchTool } = await import('./tools/webfetch')
    const ws = resolveBuiltinToolRefs([{ __builtinTool: 'websearch' }])
    const wf = resolveBuiltinToolRefs([{ __builtinTool: 'webfetch' }])
    expect(ws.agentTools).toEqual([])
    expect(ws.toolDefinitions[0]).toBe(websearchTool)
    expect(wf.agentTools).toEqual([])
    expect(wf.toolDefinitions[0]).toBe(webfetchTool)
  })

  test('mixed refs partition correctly: scout-shape (web only) leaves agentTools empty', async () => {
    const { resolveBuiltinToolRefs } = await import('./plugin-tools')
    const r = resolveBuiltinToolRefs([{ __builtinTool: 'websearch' }, { __builtinTool: 'webfetch' }])
    expect(r.agentTools).toEqual([])
    expect(r.toolDefinitions.map((t) => t.name).sort()).toEqual(['webfetch', 'websearch'])
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
    // overrides, so the channel-session `edit` tool that landed commit
    // 6d1c42c in ~/typeclaw/servant ran pi's internal builtin and bypassed
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
      skills: [],
      skillsDirs: [],
      doctorChecks: [],
      commands: [],
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
      skills: [],
      skillsDirs: [],
      doctorChecks: [],
      commands: [],
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
      skills: [],
      skillsDirs: [],
      doctorChecks: [],
      commands: [],
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
      skills: [],
      skillsDirs: [],
      doctorChecks: [],
      commands: [],
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
      name: 'webfetch',
      label: 'webfetch',
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
})

describe('bash sandbox policy', () => {
  function bashSpy(captured: { command?: unknown }) {
    return {
      name: 'bash',
      label: 'bash',
      description: '',
      parameters: Type.Object({ command: Type.String() }),
      async execute(_callId: string, params: { command: string }) {
        captured.command = params.command
        return { content: [{ type: 'text' as const, text: 'ok' }], details: undefined }
      },
    }
  }

  test('rewrites the bash command through bwrap when a policy is present', async () => {
    // given: a bash tool wrapped with a sandbox policy
    const captured: { command?: unknown } = {}
    const wrapped = wrapAgentToolAsCustomToolDefinition(bashSpy(captured), {
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
      sandboxPolicy: {
        cwd: '/agent',
        network: 'inherit',
        mounts: [{ type: 'ro-bind', source: '/agent', dest: '/agent' }],
      },
    })

    // when: the model runs `git status`
    await wrapped.execute('c', { command: 'git status' }, undefined, undefined, {} as never)

    // then: pi's bash receives a bwrap-wrapped command, not the raw one
    const rewritten = captured.command as string
    expect(rewritten).not.toBe('git status')
    expect(rewritten.startsWith('bwrap ')).toBe(true)
    expect(rewritten).toContain('--unshare-all')
    expect(rewritten).toContain('--share-net')
    expect(rewritten).toContain("bash -c 'git status'")
  })

  test('leaves the bash command untouched when no policy is set', async () => {
    const captured: { command?: unknown } = {}
    const wrapped = wrapAgentToolAsCustomToolDefinition(bashSpy(captured), {
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
    })

    await wrapped.execute('c', { command: 'git status' }, undefined, undefined, {} as never)

    expect(captured.command).toBe('git status')
  })

  test('does not sandbox non-bash tools even when a policy is present', async () => {
    const captured: { path?: unknown } = {}
    const readSpy = {
      name: 'read',
      label: 'read',
      description: '',
      parameters: Type.Object({ path: Type.String() }),
      async execute(_callId: string, params: { path: string }) {
        captured.path = params.path
        return { content: [{ type: 'text' as const, text: 'ok' }], details: undefined }
      },
    }
    const wrapped = wrapAgentToolAsCustomToolDefinition(readSpy, {
      agentDir: '/agent',
      sessionId: 's',
      hooks: createHookBus(),
      sandboxPolicy: { cwd: '/agent' },
    })

    await wrapped.execute('c', { path: '/agent/file.ts' }, undefined, undefined, {} as never)

    expect(captured.path).toBe('/agent/file.ts')
  })

  test('tool.before guards see the raw command, not the bwrap argv', async () => {
    // given: a tool.before hook recording the command it inspects
    const seen: unknown[] = []
    const captured: { command?: unknown } = {}
    const hooks = createHookBus()
    hooks.registerAll('p1', '/agent', noopLogger, {
      'tool.before': (event) => {
        seen.push(event.args.command)
      },
    })
    const wrapped = wrapAgentToolAsCustomToolDefinition(bashSpy(captured), {
      agentDir: '/agent',
      sessionId: 's',
      hooks,
      sandboxPolicy: { cwd: '/agent' },
    })

    // when: a command runs under the sandbox
    await wrapped.execute('c', { command: 'git diff' }, undefined, undefined, {} as never)

    // then: the guard saw the operator command; only the executed arg is wrapped
    expect(seen[0]).toBe('git diff')
    expect(captured.command as string).toContain("bash -c 'git diff'")
  })
})
