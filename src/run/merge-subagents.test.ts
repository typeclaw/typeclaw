import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import type { PluginRegistry, Subagent as PluginSubagent } from '@/plugin'

import { mergeSubagents } from './index'

function emptyRegistry(): PluginRegistry {
  return {
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
}

function registerSubagent(reg: PluginRegistry, name: string, subagent: PluginSubagent<any>): PluginRegistry {
  reg.subagents.push({ pluginName: 'test-plugin', subagentName: name, subagent })
  return reg
}

describe('mergeSubagents', () => {
  test('preserves visibility:public so spawn_subagent surfaces plugin-contributed public subagents', () => {
    // given — the exact scout/explorer/operator regression: a plugin
    // contributing a public subagent. Before the shim refactor, this field
    // was silently dropped during merge, making the registered subagent
    // indistinguishable from an internal one to `isPublicSubagent` in
    // `spawn-subagent.ts:isPublicSubagent` — every public bundled subagent
    // showed up as `Available: (none)` from the agent's POV.
    const registry = registerSubagent(emptyRegistry(), 'scout', {
      systemPrompt: 'fake scout',
      visibility: 'public',
    })

    const { registry: merged } = mergeSubagents(registry)

    expect(merged.scout?.visibility).toBe('public')
  })

  test('preserves visibility:internal explicitly (distinct from the absent-field default)', () => {
    const registry = registerSubagent(emptyRegistry(), 'internal-thing', {
      systemPrompt: 'fake internal',
      visibility: 'internal',
    })

    const { registry: merged } = mergeSubagents(registry)

    expect(merged['internal-thing']?.visibility).toBe('internal')
  })

  test('preserves the absence of visibility (default-internal behavior)', () => {
    // Bundled memory-logger / dreaming / backup omit `visibility` and rely
    // on `isPublicSubagent` returning false for `undefined`. A "helpful"
    // shim that defaulted to a concrete value would change the policy for
    // every silent internal subagent — keep it absent.
    const registry = registerSubagent(emptyRegistry(), 'silent', {
      systemPrompt: 'fake silent',
    })

    const { registry: merged } = mergeSubagents(registry)

    expect(merged.silent?.visibility).toBeUndefined()
  })

  test('preserves requiresSpecificPermission so per-subagent permission gates take effect', () => {
    // The operator subagent sets this to force a per-spawn permission check
    // (`subagent.spawn.operator`) instead of falling back to the generic
    // `subagent.spawn`. Dropping this in the shim would silently widen the
    // gate to "anyone with the generic permission can spawn operator",
    // bypassing the write-capability isolation operator declares it for.
    const registry = registerSubagent(emptyRegistry(), 'operator', {
      systemPrompt: 'fake operator',
      visibility: 'public',
      requiresSpecificPermission: true,
    })

    const { registry: merged } = mergeSubagents(registry)

    expect(merged.operator?.requiresSpecificPermission).toBe(true)
  })

  test('preserves payloadSchema so payload validation runs against the right contract', () => {
    const schema = z.object({ topic: z.string() })
    const registry = registerSubagent(emptyRegistry(), 'schemafied', {
      systemPrompt: 'fake',
      payloadSchema: schema,
    })

    const { registry: merged } = mergeSubagents(registry)

    expect(merged.schemafied?.payloadSchema).toBe(schema)
  })

  test('preserves handler reference so plugin-defined logic runs on spawn', () => {
    const handler = async () => {}
    const registry = registerSubagent(emptyRegistry(), 'handled', {
      systemPrompt: 'fake',
      handler,
    })

    const { registry: merged } = mergeSubagents(registry)

    expect(merged.handled?.handler).toBe(handler)
  })

  test('preserves profile so per-subagent model selection survives the shim', () => {
    const registry = registerSubagent(emptyRegistry(), 'fast-one', {
      systemPrompt: 'fake',
      profile: 'fast',
    })

    const { registry: merged } = mergeSubagents(registry)

    expect(merged['fast-one']?.profile).toBe('fast')
  })

  test('preserves toolResultBudget so the per-run byte ceiling reaches the runtime', () => {
    const budget = { maxTotalBytes: 1024, toolNames: ['read'] as const }
    const registry = registerSubagent(emptyRegistry(), 'budgeted', {
      systemPrompt: 'fake',
      toolResultBudget: budget,
    })

    const { registry: merged } = mergeSubagents(registry)

    expect(merged.budgeted?.toolResultBudget).toBe(budget)
  })

  test('keeps the original plugin reference recoverable via pluginSubagentByShim', () => {
    // The shim discards `tools`, `customTools`, and `inFlightKey` from the
    // registry-visible object, but createSessionForSubagent must still be
    // able to recover the original plugin subagent (which carries those
    // fields) so it can resolve BuiltinToolRef[] → AgentSessionTools at
    // session-creation time. This is the WeakMap-roundtrip invariant.
    const plugin: PluginSubagent<any> = {
      systemPrompt: 'fake',
      visibility: 'public',
      inFlightKey: (p: unknown) => `key:${JSON.stringify(p)}`,
    }
    const registry = registerSubagent(emptyRegistry(), 'roundtrip', plugin)

    const { registry: merged, pluginSubagentByShim, pluginSubagentByName } = mergeSubagents(registry)
    const shim = merged.roundtrip
    if (shim === undefined) throw new Error('shim missing from merged registry')

    expect(pluginSubagentByShim.get(shim)?.pluginSubagent).toBe(plugin)
    expect(pluginSubagentByName.get('roundtrip')?.pluginSubagent).toBe(plugin)
  })

  test('drops tools, customTools, and inFlightKey from the registry-visible shim', () => {
    // The shim must NOT carry plugin-only fields through to the internal
    // registry. `tools` and `customTools` have different shapes on each side
    // (BuiltinToolRef[] vs AgentSessionTools, Tool<any>[] vs ToolDefinition[]),
    // so they get resolved later via the pluginSubagentByShim WeakMap.
    // `inFlightKey` is consumed only by the SubagentConsumer via
    // pluginSubagentByName, not through the registry path. Confirming these
    // are absent on the shim pins the negative boundary so the rest-spread
    // can't silently leak a future plugin-only field into the internal type.
    const registry = registerSubagent(emptyRegistry(), 'rich', {
      systemPrompt: 'fake',
      visibility: 'public',
      tools: [{ __builtinTool: 'read' }],
      customTools: [
        {
          description: 'noop',
          parameters: z.object({}),
          execute: async () => ({ content: [] }),
        },
      ],
      inFlightKey: () => 'k',
    })

    const { registry: merged } = mergeSubagents(registry)
    const shim = merged.rich
    if (shim === undefined) throw new Error('shim missing from merged registry')

    expect(Object.hasOwn(shim, 'tools')).toBe(false)
    expect(Object.hasOwn(shim, 'customTools')).toBe(false)
    expect(Object.hasOwn(shim, 'inFlightKey')).toBe(false)
    expect(Object.hasOwn(shim, 'visibility')).toBe(true)
    expect(Object.hasOwn(shim, 'systemPrompt')).toBe(true)
  })

  test('rejects duplicate subagent names across plugins', () => {
    const registry = emptyRegistry()
    registry.subagents.push({ pluginName: 'a', subagentName: 'dup', subagent: { systemPrompt: 'a' } })
    registry.subagents.push({ pluginName: 'b', subagentName: 'dup', subagent: { systemPrompt: 'b' } })

    expect(() => mergeSubagents(registry)).toThrow(/already registered/)
  })
})
