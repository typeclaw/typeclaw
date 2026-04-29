import { describe, expect, test } from 'bun:test'

import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { CronJob } from '@/cron'
import { createStream } from '@/stream'

import { definePlugin } from './index'
import { PluginManager, type RegisteredPlugin } from './manager'
import type { PluginLogger } from './types'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function captureLogger(): PluginLogger & { errors: string[]; warns: string[]; infos: string[] } {
  const errors: string[] = []
  const warns: string[] = []
  const infos: string[] = []
  return {
    debug: () => {},
    info: (m) => infos.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    errors,
    warns,
    infos,
  }
}

const echoTool = defineTool({
  name: 'echo',
  label: 'Echo',
  description: 'Echoes input',
  parameters: Type.Object({ text: Type.String() }),
  async execute(_id, { text }) {
    return { content: [{ type: 'text', text }], details: {} }
  },
})

const otherEchoTool = defineTool({
  name: 'echo',
  label: 'Echo (other)',
  description: 'A second echo with the same name',
  parameters: Type.Object({ text: Type.String() }),
  async execute(_id, { text }) {
    return { content: [{ type: 'text', text }], details: {} }
  },
})

const dreamingJob: CronJob = {
  id: '__plugin_a_dreaming',
  schedule: '0 4 * * *',
  enabled: true,
  kind: 'subagent',
  subagent: 'dreaming',
  payload: { agentDir: '/agent' },
}

describe('PluginManager.loadAll', () => {
  test('loads plugins sequentially in declared order, exposing each via registeredPlugins()', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    const order: string[] = []
    const pluginA = definePlugin({ name: 'a' }, () => {
      order.push('a')
    })
    const pluginB = definePlugin({ name: 'b' }, () => {
      order.push('b')
    })

    await manager.loadAll([
      { plugin: pluginA, source: 'pkg-a' },
      { plugin: pluginB, source: 'pkg-b' },
    ])

    expect(order).toEqual(['a', 'b'])
    expect(manager.registeredPlugins().map((r) => r.manifest.name)).toEqual(['a', 'b'])
  })

  test('a failing plugin halts loadAll without registering subsequent plugins', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    const order: string[] = []
    const pluginA = definePlugin({ name: 'a' }, () => {
      order.push('a')
      throw new Error('boom')
    })
    const pluginB = definePlugin({ name: 'b' }, () => {
      order.push('b')
    })

    await expect(manager.loadAll([{ plugin: pluginA }, { plugin: pluginB }])).rejects.toThrow(
      /'a' failed to load.*boom/,
    )
    expect(order).toEqual(['a'])
    expect(manager.registeredPlugins()).toEqual([])
  })
})

describe('PluginManager.loadOne', () => {
  test('runs the plugin factory with a context that includes name, version, options, agentDir', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    const seen: { name: string; version: string | undefined; options: unknown; agentDir: string }[] = []
    const plugin = definePlugin({ name: 'foo', version: '1.2.3' }, (ctx) => {
      seen.push({ name: ctx.name, version: ctx.version, options: ctx.options, agentDir: ctx.agentDir })
    })
    await manager.loadOne(plugin, 'foo', { apiKey: 'k' })

    expect(seen).toEqual([{ name: 'foo', version: '1.2.3', options: { apiKey: 'k' }, agentDir: '/agent' }])
  })

  test('rejects loading two plugins with the same manifest.name', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    const a = definePlugin({ name: 'foo' }, () => {})
    const b = definePlugin({ name: 'foo' }, () => {})
    await manager.loadOne(a, 'a-source')
    await expect(manager.loadOne(b, 'b-source')).rejects.toThrow(/plugin name conflict.*foo/)
  })

  test('wraps factory errors with the plugin name', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    const plugin = definePlugin({ name: 'crashy' }, () => {
      throw new Error('boom')
    })
    await expect(manager.loadOne(plugin)).rejects.toThrow(/plugin 'crashy' failed to load: boom/)
  })

  test('rolls back partial registrations made before a factory throws', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    const survivor = defineTool({
      name: 'survivor',
      label: 'Survivor',
      description: 'Tool registered by a successful plugin loaded before the failing one',
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text: '' }], details: {} }
      },
    })

    await manager.loadOne(definePlugin({ name: 'good' }, (ctx) => ctx.registerTool(survivor)))

    const plugin = definePlugin({ name: 'crashy' }, (ctx) => {
      ctx.registerTool(echoTool)
      ctx.registerSubagent('worker', async () => {})
      ctx.registerSystemPromptSection(() => 'should be discarded')
      ctx.registerSkill({ name: 'discarded', description: 'd', content: 'c' })
      ctx.on('session.idle', () => {})
      ctx.onShutdown(() => {})
      throw new Error('boom')
    })
    await expect(manager.loadOne(plugin)).rejects.toThrow(/'crashy' failed to load/)

    expect(manager.getTools().map((t) => t.name)).toEqual(['survivor'])
    expect(Object.keys(manager.getSubagentSpawners())).toEqual([])
    expect(manager.getInMemorySkills()).toEqual([])
    expect(manager.registeredPlugins().map((r) => r.manifest.name)).toEqual(['good'])
  })
})

describe('PluginManager registries', () => {
  test('aggregates registerTool contributions across plugins, in load order', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    const second = defineTool({
      name: 'second',
      label: 'Second',
      description: 'second',
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text', text: '' }], details: {} }
      },
    })
    await manager.loadOne(definePlugin({ name: 'a' }, (ctx) => ctx.registerTool(echoTool)))
    await manager.loadOne(definePlugin({ name: 'b' }, (ctx) => ctx.registerTool(second)))

    const tools = manager.getTools()
    expect(tools.map((t) => t.name)).toEqual(['echo', 'second'])
  })

  test('rejects two plugins registering the same tool name', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    await manager.loadOne(definePlugin({ name: 'a' }, (ctx) => ctx.registerTool(echoTool)))
    await expect(
      manager.loadOne(definePlugin({ name: 'b' }, (ctx) => ctx.registerTool(otherEchoTool))),
    ).rejects.toThrow(/registered tool 'echo' which is already registered/)
  })

  test('aggregates registerSubagent contributions', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    await manager.loadOne(definePlugin({ name: 'a' }, (ctx) => ctx.registerSubagent('worker', async () => {})))

    const spawners = manager.getSubagentSpawners()
    expect(Object.keys(spawners)).toEqual(['worker'])
    expect(typeof spawners.worker).toBe('function')
  })

  test('rejects two plugins registering the same subagent name', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    await manager.loadOne(definePlugin({ name: 'a' }, (ctx) => ctx.registerSubagent('worker', async () => {})))
    await expect(
      manager.loadOne(definePlugin({ name: 'b' }, (ctx) => ctx.registerSubagent('worker', async () => {}))),
    ).rejects.toThrow(/already registered by plugin 'a'/)
  })

  test('aggregates registerCronJob contributions', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    await manager.loadOne(definePlugin({ name: 'a' }, (ctx) => ctx.registerCronJob(dreamingJob)))

    const jobs = manager.getCronJobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.id).toBe('__plugin_a_dreaming')
  })

  test('rejects cron job ids that do not start with __plugin_<name>_', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    await expect(
      manager.loadOne(definePlugin({ name: 'a' }, (ctx) => ctx.registerCronJob({ ...dreamingJob, id: 'plain-id' }))),
    ).rejects.toThrow(/must start with '__plugin_a_'/)
  })

  test('rejects cron job ids that use another plugin name as prefix', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    await expect(
      manager.loadOne(
        definePlugin({ name: 'b' }, (ctx) => ctx.registerCronJob({ ...dreamingJob, id: '__plugin_a_dreaming' })),
      ),
    ).rejects.toThrow(/must start with '__plugin_b_'/)
  })

  test('rejects the same cron job id within a single plugin (collision check)', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    await expect(
      manager.loadOne(
        definePlugin({ name: 'a' }, (ctx) => {
          ctx.registerCronJob(dreamingJob)
          ctx.registerCronJob({ ...dreamingJob, schedule: '*/5 * * * *' })
        }),
      ),
    ).rejects.toThrow(/already registered by plugin 'a'/)
  })

  test('aggregates registerSkillsDir paths in load order', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    await manager.loadOne(definePlugin({ name: 'a' }, (ctx) => ctx.registerSkillsDir('/path/a')))
    await manager.loadOne(definePlugin({ name: 'b' }, (ctx) => ctx.registerSkillsDir('/path/b')))

    expect(manager.getSkillsDirs()).toEqual(['/path/a', '/path/b'])
  })

  test('aggregates in-memory skills and rejects duplicates by name', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    await manager.loadOne(
      definePlugin({ name: 'a' }, (ctx) => ctx.registerSkill({ name: 's1', description: 'd', content: 'body' })),
    )
    expect(manager.getInMemorySkills().map((s) => s.name)).toEqual(['s1'])

    await expect(
      manager.loadOne(
        definePlugin({ name: 'b' }, (ctx) => ctx.registerSkill({ name: 's1', description: 'd2', content: 'body2' })),
      ),
    ).rejects.toThrow(/already registered by plugin 'a'/)
  })
})

describe('PluginManager.loadSystemPromptSections', () => {
  test('joins non-null sections in plugin-load order', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    await manager.loadOne(definePlugin({ name: 'a' }, (ctx) => ctx.registerSystemPromptSection(() => 'first section')))
    await manager.loadOne(
      definePlugin({ name: 'b' }, (ctx) => ctx.registerSystemPromptSection(async () => 'second section')),
    )

    const sections = await manager.loadSystemPromptSections({ sessionId: 'abc', agentDir: '/agent' })
    expect(sections).toEqual(['first section', 'second section'])
  })

  test('skips sections that return null or empty string', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    await manager.loadOne(definePlugin({ name: 'a' }, (ctx) => ctx.registerSystemPromptSection(() => null)))
    await manager.loadOne(definePlugin({ name: 'b' }, (ctx) => ctx.registerSystemPromptSection(() => '')))
    await manager.loadOne(definePlugin({ name: 'c' }, (ctx) => ctx.registerSystemPromptSection(() => 'hello')))

    const sections = await manager.loadSystemPromptSections({ sessionId: 'abc', agentDir: '/agent' })
    expect(sections).toEqual(['hello'])
  })

  test('continues past a throwing section and logs the failure', async () => {
    const logger = captureLogger()
    const manager = new PluginManager({ agentDir: '/agent', logger })
    await manager.loadOne(
      definePlugin({ name: 'a' }, (ctx) =>
        ctx.registerSystemPromptSection(() => {
          throw new Error('boom')
        }),
      ),
    )
    await manager.loadOne(definePlugin({ name: 'b' }, (ctx) => ctx.registerSystemPromptSection(() => 'survives')))

    const sections = await manager.loadSystemPromptSections({ sessionId: 'abc', agentDir: '/agent' })
    expect(sections).toEqual(['survives'])
    expect(logger.errors.some((e) => /plugin 'a' system prompt section failed: boom/.test(e))).toBe(true)
  })

  test('passes the {sessionId, agentDir} context through to loaders', async () => {
    const seen: Array<{ sessionId: string; agentDir: string }> = []
    const manager = new PluginManager({ agentDir: '/agent' })
    await manager.loadOne(
      definePlugin({ name: 'a' }, (ctx) =>
        ctx.registerSystemPromptSection((c) => {
          seen.push({ sessionId: c.sessionId, agentDir: c.agentDir })
          return 'ok'
        }),
      ),
    )
    await manager.loadSystemPromptSections({ sessionId: 'sess-1', agentDir: '/agent' })
    expect(seen).toEqual([{ sessionId: 'sess-1', agentDir: '/agent' }])
  })
})

describe('PluginManager.dispatchEvent', () => {
  test('invokes all handlers for the event in registration order', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    const order: string[] = []
    await manager.loadOne(
      definePlugin({ name: 'a' }, (ctx) =>
        ctx.on('session.idle', () => {
          order.push('a')
        }),
      ),
    )
    await manager.loadOne(
      definePlugin({ name: 'b' }, (ctx) =>
        ctx.on('session.idle', () => {
          order.push('b')
        }),
      ),
    )

    await manager.dispatchEvent('session.idle', {
      sessionId: 'sess',
      parentTranscriptPath: '/agent/sessions/sess.jsonl',
      idleMs: 30_000,
    })

    expect(order).toEqual(['a', 'b'])
  })

  test('isolates a throwing handler from peer handlers', async () => {
    const logger = captureLogger()
    const manager = new PluginManager({ agentDir: '/agent', logger })
    const order: string[] = []
    await manager.loadOne(
      definePlugin({ name: 'a' }, (ctx) =>
        ctx.on('session.idle', () => {
          order.push('a')
          throw new Error('boom')
        }),
      ),
    )
    await manager.loadOne(
      definePlugin({ name: 'b' }, (ctx) =>
        ctx.on('session.idle', () => {
          order.push('b')
        }),
      ),
    )

    await manager.dispatchEvent('session.idle', {
      sessionId: 'sess',
      parentTranscriptPath: '/agent/sessions/sess.jsonl',
      idleMs: 30_000,
    })

    expect(order).toEqual(['a', 'b'])
    expect(logger.errors.some((e) => /handler for 'session.idle' failed: boom/.test(e))).toBe(true)
  })
})

describe('PluginManager.spawnSubagent', () => {
  test('rejects calls during plugin factory execution (before markBooted)', async () => {
    const stream = createStream()
    const manager = new PluginManager({ agentDir: '/agent', stream })
    const plugin = definePlugin({ name: 'a' }, async (ctx) => {
      ctx.registerSubagent('worker', async () => {})
      await ctx.spawnSubagent('worker', {})
    })
    await expect(manager.loadOne(plugin)).rejects.toThrow(/during plugin loading/)
  })

  test('after markBooted, publishes a new-session message via the stream', async () => {
    const stream = createStream()
    const observed: Array<{ subagent: string | undefined; payload: unknown }> = []
    stream.subscribe({ target: { kind: 'new-session' } }, (msg) => {
      const target = msg.target as { kind: 'new-session'; subagent?: string }
      observed.push({ subagent: target.subagent, payload: msg.payload })
    })

    const manager = new PluginManager({ agentDir: '/agent', stream })
    let captured: ((name: string, payload: unknown) => Promise<void>) | null = null
    await manager.loadOne(
      definePlugin({ name: 'a' }, (ctx) => {
        ctx.registerSubagent('worker', async () => {})
        captured = ctx.spawnSubagent
      }),
    )
    manager.markBooted()
    await captured!('worker', { hello: 'world' })
    await sleep(0)

    expect(observed).toEqual([{ subagent: 'worker', payload: { hello: 'world' } }])
  })

  test('after markBooted, throws when no stream is configured', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    let captured: ((name: string, payload: unknown) => Promise<void>) | null = null
    await manager.loadOne(
      definePlugin({ name: 'a' }, (ctx) => {
        ctx.registerSubagent('worker', async () => {})
        captured = ctx.spawnSubagent
      }),
    )
    manager.markBooted()
    await expect(captured!('worker', {})).rejects.toThrow(/no stream is configured/)
  })

  test('after markBooted, throws when the subagent name is not registered', async () => {
    const stream = createStream()
    const manager = new PluginManager({ agentDir: '/agent', stream })
    let captured: ((name: string, payload: unknown) => Promise<void>) | null = null
    await manager.loadOne(
      definePlugin({ name: 'a' }, (ctx) => {
        captured = ctx.spawnSubagent
      }),
    )
    manager.markBooted()
    await expect(captured!('missing', {})).rejects.toThrow(/no spawner is registered/)
  })
})

describe('PluginManager.shutdown', () => {
  test('runs onShutdown handlers in reverse registration order', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    const order: string[] = []
    await manager.loadOne(
      definePlugin({ name: 'a' }, (ctx) =>
        ctx.onShutdown(() => {
          order.push('a')
        }),
      ),
    )
    await manager.loadOne(
      definePlugin({ name: 'b' }, (ctx) =>
        ctx.onShutdown(() => {
          order.push('b')
        }),
      ),
    )

    await manager.shutdown()
    expect(order).toEqual(['b', 'a'])
  })

  test('continues past a throwing shutdown handler', async () => {
    const logger = captureLogger()
    const manager = new PluginManager({ agentDir: '/agent', logger })
    const order: string[] = []
    await manager.loadOne(
      definePlugin({ name: 'a' }, (ctx) =>
        ctx.onShutdown(() => {
          order.push('a')
        }),
      ),
    )
    await manager.loadOne(
      definePlugin({ name: 'b' }, (ctx) =>
        ctx.onShutdown(() => {
          order.push('b')
          throw new Error('boom')
        }),
      ),
    )

    await manager.shutdown()
    expect(order).toEqual(['b', 'a'])
    expect(logger.errors.some((e) => /plugin 'b' shutdown handler failed: boom/.test(e))).toBe(true)
  })
})

describe('PluginManager.registeredPlugins', () => {
  test('returns the loaded plugins in load order with their source', async () => {
    const manager = new PluginManager({ agentDir: '/agent' })
    await manager.loadOne(
      definePlugin({ name: 'a', version: '1.0.0' }, () => {}),
      'pkg-a',
    )
    await manager.loadOne(
      definePlugin({ name: 'b' }, () => {}),
      'pkg-b',
    )

    const registered: RegisteredPlugin[] = manager.registeredPlugins()
    expect(registered).toEqual([
      { manifest: { name: 'a', version: '1.0.0' }, source: 'pkg-a' },
      { manifest: { name: 'b' }, source: 'pkg-b' },
    ])
  })
})
