import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { defineCommand, defineSubagent, defineTool } from './define'
import { createHookBus } from './hooks'
import {
  buildPluginCronGlobalId,
  discardRegistrationsBy,
  emptyRegistry,
  RESERVED_COMMAND_NAMES,
  registerContributions,
} from './registry'
import type { PluginCommand, PluginExports, PluginMcpServer } from './types'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }
const stdioMcpServer: PluginMcpServer = { transport: { type: 'stdio', command: 'server' } }

function makeOptions(pluginName: string, ex: PluginExports, commands?: Record<string, PluginCommand>) {
  return {
    pluginName,
    logger: noopLogger,
    exports: ex,
    ...(commands !== undefined ? { commands } : {}),
    registry: emptyRegistry(),
    hooks: createHookBus(),
    agentDir: '/tmp',
    pluginConfig: undefined,
  }
}

describe('registerContributions', () => {
  test('records tools, subagents, cron jobs, skills, skillsDirs', () => {
    const tool = defineTool({
      description: 'echo',
      parameters: z.object({ msg: z.string() }),
      async execute(args) {
        return { content: [{ type: 'text', text: args.msg }] }
      },
    })
    const sub = defineSubagent({ systemPrompt: 'you' })
    const opts = makeOptions('p1', {
      tools: { echo: tool },
      subagents: { worker: sub },
      cronJobs: {
        nightly: { schedule: '0 0 * * *', kind: 'prompt', prompt: 'go' },
      },
      skills: { howto: { description: 'h', content: 'hello' } },
      skillsDirs: ['/abs/skills'],
    })
    registerContributions(opts)

    expect(opts.registry.tools.map((t) => t.toolName)).toEqual(['echo'])
    expect(opts.registry.subagents.map((s) => s.subagentName)).toEqual(['worker'])
    expect(opts.registry.cronJobs[0]?.globalId).toBe('__plugin_p1_nightly')
    expect(opts.registry.skills.map((s) => s.localName)).toEqual(['howto'])
    expect(opts.registry.skillsDirs.map((d) => d.path)).toEqual(['/abs/skills'])
  })

  test('records doctor checks, rejects duplicates within a plugin', () => {
    const opts = makeOptions('memory', {
      doctorChecks: {
        'dir-writable': {
          description: 'memory/ is writable',
          run: async () => ({ status: 'ok', message: 'ok' }),
        },
      },
    })
    registerContributions(opts)
    expect(opts.registry.doctorChecks.map((c) => `${c.pluginName}.${c.checkName}`)).toEqual(['memory.dir-writable'])

    expect(() => registerContributions(opts)).toThrow(/doctor check "dir-writable" already registered/)
  })

  test('records plugin disposers', () => {
    const onDispose = () => {}
    const opts = makeOptions('p1', { onDispose })
    registerContributions(opts)

    expect(opts.registry.disposers).toEqual([{ pluginName: 'p1', logger: noopLogger, dispose: onDispose }])
  })

  test('rejects duplicate tool name across plugins', () => {
    const tool = defineTool({
      description: 'echo',
      parameters: z.object({}),
      async execute() {
        return { content: [] }
      },
    })
    const opts1 = makeOptions('p1', { tools: { same: tool } })
    registerContributions(opts1)

    expect(() => registerContributions({ ...opts1, pluginName: 'p2' })).toThrow(/already registered by plugin p1/)
  })

  test('rejects duplicate subagent name across plugins', () => {
    const sub = defineSubagent({ systemPrompt: 'x' })
    const opts1 = makeOptions('p1', { subagents: { worker: sub } })
    registerContributions(opts1)
    expect(() => registerContributions({ ...opts1, pluginName: 'p2' })).toThrow(/subagent "worker" already registered/)
  })

  test('rejects duplicate cron suffix when the same plugin is registered twice', () => {
    const opts = makeOptions('p1', {
      cronJobs: {
        a: { schedule: '* * * * *', kind: 'prompt', prompt: 'x' },
      },
    })
    registerContributions(opts)
    expect(() => registerContributions(opts)).toThrow(/conflicts with plugin p1/)
  })

  test('records plugin mcp servers', () => {
    const opts = makeOptions('vision', {
      mcpServers: {
        vision: {
          description: 'Vision MCP',
          timeoutMs: 5000,
          transport: { type: 'stdio', command: 'vision-mcp', args: ['serve'] },
        },
      },
    })

    registerContributions(opts)

    expect(opts.registry.mcpServers).toEqual([
      {
        pluginName: 'vision',
        name: 'vision',
        server: opts.exports.mcpServers!.vision!,
        logger: noopLogger,
      },
    ])
  })

  test("rejects plugin mcp server names containing the reserved '__' separator", () => {
    const opts = makeOptions('vision', { mcpServers: { bad__name: stdioMcpServer } })

    expect(() => registerContributions(opts)).toThrow(/plugin vision: mcp server "bad__name" must not contain '__'/)
  })

  test('rejects plugin mcp server names that do not match config server names', () => {
    for (const bad of ['Bad-Name', 'has spaces', '-leading-dash', '']) {
      const opts = makeOptions('vision', { mcpServers: { [bad]: stdioMcpServer } })
      expect(() => registerContributions(opts)).toThrow(/plugin vision: mcp server .* must match/)
    }
  })

  test('rejects duplicate mcp server names across plugins', () => {
    const registry = emptyRegistry()
    const hooks = createHookBus()
    registerContributions({
      ...makeOptions('p1', { mcpServers: { shared: stdioMcpServer } }),
      registry,
      hooks,
    })

    expect(() =>
      registerContributions({
        ...makeOptions('p2', { mcpServers: { shared: stdioMcpServer } }),
        registry,
        hooks,
      }),
    ).toThrow(/plugin p2: mcp server "shared" already registered by plugin p1/)
  })

  test('cron globalId uses __plugin_<name>_<key> format', () => {
    expect(buildPluginCronGlobalId('standup-log', 'weekly-digest')).toBe('__plugin_standup-log_weekly-digest')
  })

  test('handler cron job is transformed to a HandlerJob carrying the function reference', () => {
    const handler = async () => {}
    const opts = makeOptions('inbox-watch', {
      cronJobs: {
        watch: { schedule: '*/15 * * * *', kind: 'handler', handler },
      },
    })
    registerContributions(opts)

    const job = opts.registry.cronJobs[0]?.job
    expect(opts.registry.cronJobs[0]?.globalId).toBe('__plugin_inbox-watch_watch')
    expect(job?.kind).toBe('handler')
    if (job?.kind === 'handler') {
      expect(job.handler).toBe(handler)
      expect(job.scheduledByRole).toBe('owner')
    }
  })

  test('records plugin commands declared on DefinedPlugin', () => {
    const cmd = defineCommand({
      surface: 'host',
      description: 'echo',
      run: async () => 0,
    })
    const opts = makeOptions('p1', {}, { 'echo-cmd': cmd })
    registerContributions(opts)
    expect(opts.registry.commands.map((c) => c.commandName)).toEqual(['echo-cmd'])
    expect(opts.registry.commands[0]?.pluginName).toBe('p1')
    expect(opts.registry.commands[0]?.command).toBe(cmd)
  })

  test('rejects two plugins declaring the same command name', () => {
    const cmd: PluginCommand = { surface: 'host', description: 'a', run: async () => 0 }
    const opts1 = makeOptions('p1', {}, { foo: cmd })
    registerContributions(opts1)
    expect(() => registerContributions({ ...opts1, pluginName: 'p2' })).toThrow(
      /command "foo" already registered by plugin p1/,
    )
  })

  test('rejects command name that shadows a built-in subcommand', () => {
    const cmd: PluginCommand = { surface: 'host', description: 'evil', run: async () => 0 }
    const opts = makeOptions('p1', {}, { start: cmd })
    expect(() => registerContributions(opts)).toThrow(/command "start" shadows a built-in/)
  })

  test('rejects every kebab-shaped reserved built-in name', () => {
    const cmd: PluginCommand = { surface: 'host', description: '', run: async () => 0 }
    // Iterate the full RESERVED_COMMAND_NAMES set (filtered to kebab-shaped
    // entries that get past the regex check). Hidden internals like `_hostd`
    // hit the regex check first; tested separately in the kebab-case test.
    const kebabReserved = Array.from(RESERVED_COMMAND_NAMES).filter((n) => /^[a-z][a-z0-9-]*$/.test(n))
    expect(kebabReserved.length).toBeGreaterThan(10)
    for (const reserved of kebabReserved) {
      const opts = makeOptions('p1', {}, { [reserved]: cmd })
      expect(() => registerContributions(opts)).toThrow(/shadows a built-in/)
    }
  })

  test('rejects command names that do not match the kebab-case regex', () => {
    const cmd: PluginCommand = { surface: 'host', description: '', run: async () => 0 }
    for (const bad of ['Bad-Name', '1invalid', 'has_underscore', 'has spaces', '-leading-dash', '']) {
      const opts = makeOptions('p1', {}, { [bad]: cmd })
      if (bad.length === 0) {
        expect(() => registerContributions(opts)).toThrow(/empty command name/)
      } else {
        expect(() => registerContributions(opts)).toThrow(/does not match/)
      }
    }
  })

  test('accepts valid kebab-case command names', () => {
    const cmd: PluginCommand = { surface: 'host', description: '', run: async () => 0 }
    for (const good of ['a', 'foo', 'foo-bar', 'foo-bar-baz', 'a1', 'cmd-2']) {
      const opts = makeOptions('p1', {}, { [good]: cmd })
      registerContributions(opts)
      expect(opts.registry.commands.map((c) => c.commandName)).toEqual([good])
    }
  })

  test('rejects args schema that is not z.object with primitive leaves', () => {
    // Bypass the public defineCommand overload (which constrains args to
    // z.ZodObject) to simulate a misbehaving plugin that hand-built the
    // command object with a non-object schema.
    const nonObject = {
      surface: 'host' as const,
      description: '',
      args: z.string() as unknown as z.ZodObject<z.ZodRawShape>,
      run: async () => 0,
    }
    expect(() => registerContributions(makeOptions('p1', {}, { broken: nonObject as PluginCommand }))).toThrow(
      /must be a z\.object\(\{\.\.\.\}\) with primitive/,
    )

    const nestedObject = defineCommand({
      surface: 'host',
      description: '',
      args: z.object({ inner: z.object({ x: z.string() }) }) as unknown as z.ZodObject<z.ZodRawShape>,
      run: async () => 0,
    })
    expect(() => registerContributions(makeOptions('p1', {}, { 'bad-leaf': nestedObject as PluginCommand }))).toThrow(
      /must be a z\.object/,
    )
  })

  test("discardRegistrationsBy removes the plugin's commands and leaves others", () => {
    const cmd: PluginCommand = { surface: 'host', description: '', run: async () => 0 }
    const registry = emptyRegistry()
    const hooks = createHookBus()
    registerContributions({
      pluginName: 'p1',
      logger: noopLogger,
      exports: {},
      commands: { 'p1-cmd': cmd },
      registry,
      hooks,
      agentDir: '/tmp',
      pluginConfig: undefined,
    })
    registerContributions({
      pluginName: 'p2',
      logger: noopLogger,
      exports: {},
      commands: { 'p2-cmd': cmd },
      registry,
      hooks,
      agentDir: '/tmp',
      pluginConfig: undefined,
    })
    discardRegistrationsBy('p1', registry, hooks)
    expect(registry.commands.map((c) => c.commandName)).toEqual(['p2-cmd'])
  })
})

describe('discardRegistrationsBy', () => {
  test('removes all registrations for the named plugin and leaves others intact', () => {
    const registry = emptyRegistry()
    const hooks = createHookBus()
    const tool = defineTool({
      description: '',
      parameters: z.object({}),
      async execute() {
        return { content: [] }
      },
    })

    registerContributions({
      pluginName: 'p1',
      logger: noopLogger,
      exports: {
        tools: { t1: tool },
        subagents: { s1: defineSubagent({ systemPrompt: '' }) },
        cronJobs: { c1: { schedule: '* * * * *', kind: 'prompt', prompt: '' } },
        mcpServers: { m1: stdioMcpServer },
        skills: { sk1: { description: '', content: '' } },
        skillsDirs: ['/p1/skills'],
        hooks: { 'session.start': () => {} },
        onDispose: () => {},
        doctorChecks: {
          ping: {
            description: 'always ok',
            run: async () => ({ status: 'ok', message: 'ok' }),
          },
        },
      },
      registry,
      hooks,
      agentDir: '/tmp',
      pluginConfig: undefined,
    })
    registerContributions({
      pluginName: 'p2',
      logger: noopLogger,
      exports: {
        tools: { t2: tool },
        hooks: { 'session.end': () => {} },
      },
      registry,
      hooks,
      agentDir: '/tmp',
      pluginConfig: undefined,
    })

    expect(hooks.count('session.start')).toBe(1)
    expect(hooks.count('session.end')).toBe(1)

    discardRegistrationsBy('p1', registry, hooks)

    expect(registry.tools.map((t) => t.pluginName)).toEqual(['p2'])
    expect(registry.subagents).toEqual([])
    expect(registry.cronJobs).toEqual([])
    expect(registry.mcpServers).toEqual([])
    expect(registry.skills).toEqual([])
    expect(registry.skillsDirs).toEqual([])
    expect(registry.doctorChecks).toEqual([])
    expect(registry.disposers).toEqual([])
    expect(hooks.count('session.start')).toBe(0)
    expect(hooks.count('session.end')).toBe(1)
  })
})
