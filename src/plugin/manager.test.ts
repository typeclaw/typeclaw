import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { defineTool } from './define'
import { type LoadPluginEntryFn, PluginNotFoundError, PluginSecurityError } from './loader'
import { loadPlugins, summarizeLoaded, pluginCronJobs } from './manager'

function noopTool() {
  return defineTool({
    description: '',
    parameters: z.object({}),
    async execute() {
      return { content: [] }
    },
  })
}

function captureWarnings(): { warnings: string[]; restore: () => void } {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.join(' '))
  return { warnings, restore: () => (console.warn = original) }
}

describe('loadPlugins — user plugin failures are isolated', () => {
  test('a user plugin whose factory throws is skipped + recorded, the rest still load', async () => {
    const tool = noopTool()
    const loadEntry: LoadPluginEntryFn = async (entry) => {
      if (entry === 'bad') {
        return {
          name: 'bad',
          version: undefined,
          source: 'bad',
          defined: {
            plugin: async () => {
              throw new Error('factory failed')
            },
          },
        }
      }
      return {
        name: entry,
        version: undefined,
        source: entry,
        defined: { plugin: async () => ({ tools: { [entry]: tool } }) },
      }
    }

    const cap = captureWarnings()
    let result
    try {
      result = await loadPlugins({ entries: ['good', 'bad'], agentDir: '/tmp', configsByName: {}, loadEntry })
    } finally {
      cap.restore()
    }

    expect(result.loadedPlugins.map((p) => p.name)).toEqual(['good'])
    expect(result.failedPlugins).toEqual([
      { entry: 'bad', phase: 'factory', error: expect.stringContaining('factory threw: factory failed') },
    ])
    expect(cap.warnings.some((w) => w.includes('bad') && w.includes('skipping'))).toBe(true)
  })

  test('a user plugin with an import-time throw is skipped, not fatal', async () => {
    const loadEntry: LoadPluginEntryFn = async (entry) => {
      if (entry === 'broken') throw new Error(`plugin ${entry}: default export is not a definePlugin(...) result`)
      return { name: entry, version: undefined, source: entry, defined: { plugin: async () => ({}) } }
    }

    const cap = captureWarnings()
    let result
    try {
      result = await loadPlugins({ entries: ['good', 'broken'], agentDir: '/tmp', configsByName: {}, loadEntry })
    } finally {
      cap.restore()
    }

    expect(result.loadedPlugins.map((p) => p.name)).toEqual(['good'])
    expect(result.failedPlugins.map((f) => ({ entry: f.entry, phase: f.phase }))).toEqual([
      { entry: 'broken', phase: 'resolve' },
    ])
  })

  test('a user plugin with an invalid config block is skipped, not fatal', async () => {
    const loadEntry: LoadPluginEntryFn = async (entry) => ({
      name: entry,
      version: undefined,
      source: entry,
      defined: { configSchema: z.object({ schedule: z.string() }), plugin: async () => ({}) },
    })

    const cap = captureWarnings()
    let result
    try {
      result = await loadPlugins({
        entries: ['bad-config'],
        agentDir: '/tmp',
        configsByName: { 'bad-config': { schedule: 42 } },
        loadEntry,
      })
    } finally {
      cap.restore()
    }

    expect(result.loadedPlugins).toEqual([])
    expect(result.failedPlugins).toEqual([
      { entry: 'bad-config', phase: 'config', error: expect.stringContaining('config invalid: schedule:') },
    ])
  })

  test('earlier successfully-loaded user plugins survive a later plugin failure', async () => {
    const tool = noopTool()
    const loadEntry: LoadPluginEntryFn = async (entry) => {
      if (entry === 'p2')
        return {
          name: 'p2',
          version: undefined,
          source: 'p2',
          defined: {
            plugin: async () => {
              throw new Error('boom')
            },
          },
        }
      return {
        name: entry,
        version: undefined,
        source: entry,
        defined: { plugin: async () => ({ tools: { [entry]: tool } }) },
      }
    }

    const cap = captureWarnings()
    let result
    try {
      result = await loadPlugins({ entries: ['p1', 'p2', 'p3'], agentDir: '/tmp', configsByName: {}, loadEntry })
    } finally {
      cap.restore()
    }

    expect(result.loadedPlugins.map((p) => p.name)).toEqual(['p1', 'p3'])
    expect(result.registry.tools.map((t) => t.toolName).sort()).toEqual(['p1', 'p3'])
  })

  test('duplicate plugin names stay fatal (global invariant, not a per-plugin skip)', async () => {
    const tool = noopTool()
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'same',
      version: undefined,
      source: 's',
      defined: { plugin: async () => ({ tools: { t: tool } }) },
    })

    await expect(loadPlugins({ entries: ['x', 'y'], agentDir: '/tmp', configsByName: {}, loadEntry })).rejects.toThrow(
      /plugin name conflict: same/,
    )
  })
})

describe('loadPlugins — bundled plugin failures stay fatal', () => {
  test('a bundled plugin whose factory throws aborts boot (typeclaw bug, fail loud)', async () => {
    const bundled = [
      {
        name: 'security',
        version: undefined,
        source: '<bundled>',
        defined: {
          plugin: async () => {
            throw new Error('bundled boom')
          },
        },
      },
    ]
    await expect(
      loadPlugins({
        entries: [],
        agentDir: '/tmp',
        configsByName: {},
        loadEntry: async () => {
          throw new Error('unused')
        },
        bundled,
      }),
    ).rejects.toThrow(/bundled boom/)
  })

  test('a bundled plugin with an invalid config block aborts boot', async () => {
    const bundled = [
      {
        name: 'memory',
        version: undefined,
        source: '<bundled>',
        defined: { configSchema: z.object({ n: z.number() }), plugin: async () => ({}) },
      },
    ]
    await expect(
      loadPlugins({
        entries: [],
        agentDir: '/tmp',
        configsByName: { memory: { n: 'nope' } },
        loadEntry: async () => {
          throw new Error('unused')
        },
        bundled,
      }),
    ).rejects.toThrow(/memory: config invalid/)
  })
})

describe('loadPlugins — mcpServers permission gate', () => {
  test("a plugin exporting mcpServers without the 'mcp' permission fails registration", async () => {
    const bundled = [
      {
        name: 'vision',
        version: undefined,
        source: '<bundled>',
        defined: {
          plugin: async () => ({
            mcpServers: { vision: { transport: { type: 'stdio' as const, command: 'vision-mcp' } } },
          }),
        },
      },
    ]

    await expect(
      loadPlugins({ entries: [], agentDir: '/tmp', configsByName: {}, loadEntry: async () => bundled[0]!, bundled }),
    ).rejects.toThrow(/exporting mcpServers requires declaring the 'mcp' permission/)
  })

  test("a plugin exporting mcpServers with the 'mcp' permission registers them", async () => {
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'vision',
      version: undefined,
      source: 'vision',
      defined: {
        permissions: ['mcp'],
        plugin: async () => ({
          mcpServers: { vision: { transport: { type: 'stdio', command: 'vision-mcp' } } },
        }),
      },
    })

    const result = await loadPlugins({ entries: ['vision'], agentDir: '/tmp', configsByName: {}, loadEntry })

    expect(result.loadedPlugins.map((p) => p.name)).toEqual(['vision'])
    expect(result.declaredPermissions).toContain('mcp')
    expect(result.registry.mcpServers.map((server) => server.name)).toEqual(['vision'])
  })
})

describe('loadPlugins — a failed plugin does not influence the permission model', () => {
  test("a skipped user plugin's permissions + ownerWildcardExclusions never reach the live service", async () => {
    const ownerOrigin = { kind: 'system', component: 'test' } as const
    const loadEntry: LoadPluginEntryFn = async (entry) => {
      if (entry === 'failed') {
        return {
          name: 'failed',
          version: undefined,
          source: 'failed',
          defined: {
            permissions: ['security.bypass.failedPlugin'],
            ownerWildcardExclusions: ['security.bypass.allowedPlugin'],
            plugin: async () => {
              throw new Error('boom')
            },
          },
        }
      }
      return {
        name: 'survivor',
        version: undefined,
        source: 'survivor',
        defined: { permissions: ['security.bypass.allowedPlugin'], plugin: async () => ({}) },
      }
    }

    const cap = captureWarnings()
    let result
    try {
      result = await loadPlugins({ entries: ['survivor', 'failed'], agentDir: '/tmp', configsByName: {}, loadEntry })
    } finally {
      cap.restore()
    }

    // given the failed plugin is reported disabled and absent from the loaded set
    expect(result.failedPlugins.map((f) => f.entry)).toEqual(['failed'])
    expect(result.loadedPlugins.map((p) => p.name)).toEqual(['survivor'])

    // then its declared permission is NOT in the known universe
    expect(result.declaredPermissions).toContain('security.bypass.allowedPlugin')
    expect(result.declaredPermissions).not.toContain('security.bypass.failedPlugin')

    // and the live service reflects survivors only
    expect(result.permissions.has(ownerOrigin, 'security.bypass.failedPlugin')).toBe(false)
    // the security-critical assertion: the failed plugin's exclusion must NOT
    // have stripped the surviving plugin's owner-wildcard bypass.
    expect(result.permissions.has(ownerOrigin, 'security.bypass.allowedPlugin')).toBe(true)
  })
})

describe('loadPlugins — unresolvable entry is non-fatal', () => {
  test('warns and skips an entry that fails to resolve, still loading the rest', async () => {
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        return { content: [] }
      },
    })
    const loadEntry: LoadPluginEntryFn = async (entry) => {
      if (entry === 'typeclaw-plugin-missing') {
        throw new PluginNotFoundError(entry, `cannot resolve plugin "${entry}": Cannot find package '${entry}'`)
      }
      return {
        name: entry,
        version: undefined,
        source: entry,
        defined: { plugin: async () => ({ tools: { [entry]: tool } }) },
      }
    }

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '))
    let result
    try {
      result = await loadPlugins({
        entries: ['good-one', 'typeclaw-plugin-missing', 'good-two'],
        agentDir: '/tmp',
        configsByName: {},
        loadEntry,
      })
    } finally {
      console.warn = originalWarn
    }

    expect(result.loadedPlugins.map((p) => p.name)).toEqual(['good-one', 'good-two'])
    expect(warnings.some((w) => w.includes('typeclaw-plugin-missing') && w.includes('Cannot find package'))).toBe(true)
  })

  test('a PluginSecurityError stays fatal even for a user plugin (path escape is never skipped)', async () => {
    const loadEntry: LoadPluginEntryFn = async (entry) => {
      if (entry === './escape.ts') {
        throw new PluginSecurityError(entry, `plugin path escapes agent directory: ${entry}`)
      }
      return { name: entry, version: undefined, source: entry, defined: { plugin: async () => ({}) } }
    }

    await expect(
      loadPlugins({ entries: ['good', './escape.ts'], agentDir: '/tmp', configsByName: {}, loadEntry }),
    ).rejects.toThrow(/escapes agent directory/)
  })
})

describe('loadPlugins — config validation', () => {
  test("validates per-plugin config against the plugin's configSchema", async () => {
    const captured: { value: unknown } = { value: undefined }
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'standup-log',
      version: '0.1.0',
      source: 'standup-log',
      defined: {
        configSchema: z.object({ schedule: z.string().default('0 9 * * 1') }),
        plugin: async (ctx) => {
          captured.value = ctx.config
          return {}
        },
      },
    })

    await loadPlugins({
      entries: ['standup-log'],
      agentDir: '/tmp',
      configsByName: { 'standup-log': { schedule: '0 17 * * 5' } },
      loadEntry,
    })

    expect(captured.value).toEqual({ schedule: '0 17 * * 5' })
  })

  test('applies schema defaults when config is absent', async () => {
    const captured: { value: unknown } = { value: undefined }
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'standup-log',
      version: undefined,
      source: 's',
      defined: {
        configSchema: z.object({ schedule: z.string().default('0 9 * * 1') }),
        plugin: async (ctx) => {
          captured.value = ctx.config
          return {}
        },
      },
    })

    await loadPlugins({ entries: ['s'], agentDir: '/tmp', configsByName: {}, loadEntry })
    expect(captured.value).toEqual({ schedule: '0 9 * * 1' })
  })

  test('records invalid config with plugin name + field path in failedPlugins (skipped, not fatal)', async () => {
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'standup-log',
      version: undefined,
      source: 's',
      defined: {
        configSchema: z.object({ schedule: z.string() }),
        plugin: async () => ({}),
      },
    })

    const cap = captureWarnings()
    let result
    try {
      result = await loadPlugins({
        entries: ['s'],
        agentDir: '/tmp',
        configsByName: { 'standup-log': { schedule: 42 } },
        loadEntry,
      })
    } finally {
      cap.restore()
    }

    expect(result.loadedPlugins).toEqual([])
    expect(result.failedPlugins[0]?.error).toMatch(/standup-log: config invalid: schedule:/)
  })

  test('records a config block present without a configSchema in failedPlugins (skipped, not fatal)', async () => {
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'no-config-plugin',
      version: undefined,
      source: 's',
      defined: {
        plugin: async () => ({}),
      },
    })

    const cap = captureWarnings()
    let result
    try {
      result = await loadPlugins({
        entries: ['s'],
        agentDir: '/tmp',
        configsByName: { 'no-config-plugin': { foo: 1 } },
        loadEntry,
      })
    } finally {
      cap.restore()
    }

    expect(result.loadedPlugins).toEqual([])
    expect(result.failedPlugins[0]?.error).toMatch(/declares no configSchema/)
  })
})

describe('loadPlugins — markBooted gates spawnSubagent', () => {
  test('spawnSubagent in factory throws; callable after markBooted', async () => {
    const calls: string[] = []
    const setup: { spawn?: (name: string) => Promise<void> } = {}

    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'p1',
      version: undefined,
      source: 's',
      defined: {
        plugin: async (ctx) => {
          setup.spawn = (n) => ctx.spawnSubagent(n)
          return {}
        },
      },
    })

    const result = await loadPlugins({
      entries: ['p1'],
      agentDir: '/tmp',
      configsByName: {},
      loadEntry,
    })

    await expect(setup.spawn!('worker')).rejects.toThrow(/before boot completed/)

    result.setSpawnSubagent(async (name) => {
      calls.push(name)
    })
    result.markBooted()

    await setup.spawn!('worker')
    expect(calls).toEqual(['worker'])
  })

  test('a factory that calls spawnSubagent before boot fails that plugin (recorded, not fatal)', async () => {
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'p1',
      version: undefined,
      source: 's',
      defined: {
        plugin: async (ctx) => {
          await ctx.spawnSubagent('w')
          return {}
        },
      },
    })

    const cap = captureWarnings()
    let result
    try {
      result = await loadPlugins({ entries: ['p1'], agentDir: '/tmp', configsByName: {}, loadEntry })
    } finally {
      cap.restore()
    }

    expect(result.loadedPlugins).toEqual([])
    expect(result.failedPlugins[0]?.phase).toBe('factory')
    expect(result.failedPlugins[0]?.error).toMatch(/before boot completed/)
  })

  test('forwards the SpawnSubagentOptions arg to the wired implementation', async () => {
    // given a plugin that spawns with parentSessionId + spawnedByOrigin options
    // (the shape the bundled memory plugin's session.prompt hook passes).
    // Without forwarding, dispatchSpawnSubagent in src/run/index.ts cannot
    // resolve the spawned role or stamp provenance, and any future in-process
    // coalescing keyed on payload would not see the parent's identity either.
    const captured: { name: string; payload: unknown; options: unknown }[] = []
    const setup: { spawn?: (name: string, payload: unknown, options: unknown) => Promise<void> } = {}
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'p1',
      version: undefined,
      source: 's',
      defined: {
        plugin: async (ctx) => {
          setup.spawn = (n, p, o) => ctx.spawnSubagent(n, p, o as never)
          return {}
        },
      },
    })

    const result = await loadPlugins({ entries: ['p1'], agentDir: '/tmp', configsByName: {}, loadEntry })
    result.setSpawnSubagent(async (name, payload, options) => {
      captured.push({ name, payload, options })
    })
    result.markBooted()

    const origin = { kind: 'channel' as const, adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null }
    await setup.spawn!('worker', { x: 1 }, { parentSessionId: 'ses_parent', spawnedByOrigin: origin })

    expect(captured).toHaveLength(1)
    expect(captured[0]).toEqual({
      name: 'worker',
      payload: { x: 1 },
      options: { parentSessionId: 'ses_parent', spawnedByOrigin: origin },
    })
  })
})

describe('loadPlugins — plugin disposal', () => {
  test('disposePlugins awaits all onDispose callbacks and isolates failures', async () => {
    const calls: string[] = []
    const loadEntry: LoadPluginEntryFn = async (entry) => ({
      name: entry,
      version: undefined,
      source: entry,
      defined: {
        plugin: async () => ({
          onDispose: async () => {
            calls.push(`${entry}:start`)
            await Promise.resolve()
            if (entry === 'bad') throw new Error('dispose boom')
            calls.push(`${entry}:done`)
          },
        }),
      },
    })

    const cap = captureWarnings()
    try {
      const result = await loadPlugins({
        entries: ['good', 'bad', 'later'],
        agentDir: '/tmp',
        configsByName: {},
        loadEntry,
      })

      await result.disposePlugins()
    } finally {
      cap.restore()
    }

    expect(calls).toEqual(expect.arrayContaining(['good:start', 'good:done', 'bad:start', 'later:start', 'later:done']))
    expect(cap.warnings.some((w) => w.includes('[plugin:bad] onDispose failed: dispose boom'))).toBe(true)
  })
})

describe('loadPlugins — registry shape', () => {
  test('pluginCronJobs returns CronJob[] with __plugin_<name>_<key> ids', async () => {
    const loadEntry: LoadPluginEntryFn = async () => ({
      name: 'p1',
      version: undefined,
      source: 's',
      defined: {
        plugin: async () => ({
          cronJobs: {
            'weekly-digest': { schedule: '0 9 * * 1', kind: 'prompt', prompt: 'go' },
          },
        }),
      },
    })

    const result = await loadPlugins({ entries: ['p1'], agentDir: '/tmp', configsByName: {}, loadEntry })
    const jobs = pluginCronJobs(result.registry)
    expect(jobs.map((j) => j.id)).toEqual(['__plugin_p1_weekly-digest'])
  })

  test('summarizeLoaded includes counts and version when present', async () => {
    const loadEntry: LoadPluginEntryFn = async (entry) => ({
      name: entry,
      version: entry === 'a' ? '1.2.3' : undefined,
      source: entry,
      defined: {
        plugin: async () => ({}),
      },
    })

    const result = await loadPlugins({
      entries: ['a', 'b'],
      agentDir: '/tmp',
      configsByName: {},
      loadEntry,
    })
    const s = summarizeLoaded(result.loadedPlugins, result.registry)
    expect(s).toContain('a v1.2.3')
    expect(s).toContain('b')
    expect(s).toContain('0 tool(s)')
    expect(s).toContain('0 mcp server(s)')
  })
})
