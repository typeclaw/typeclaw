import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __resetForwardRequestForTesting as resetDashboardForwardRequest } from '@/bundled-plugins/agent-browser'
import type { LoadCronResult } from '@/cron'
import { rmTempDir } from '@/test-helpers/rm-temp-dir'

import { startAgent, type LoadCronFn } from './index'

const noCron: LoadCronFn = async () => ({ ok: true, file: null }) as LoadCronResult

let running: Awaited<ReturnType<typeof startAgent>> | null = null
let agentDir: string | null = null
let savedBrokerToken: string | undefined

async function stopRunningAgent(): Promise<void> {
  if (!running) return
  running.tuiPromise?.catch(() => {})
  await running.stop()
  running = null
}

beforeEach(() => {
  // startAgent boots the agent-browser plugin. Keep the broker token absent so
  // these run-loop tests do not publish a reserved dashboard forward request
  // into an unrelated in-process bus subscriber.
  savedBrokerToken = process.env['TYPECLAW_HOSTD_BROKER_TOKEN']
  delete process.env['TYPECLAW_HOSTD_BROKER_TOKEN']
})

afterEach(async () => {
  await stopRunningAgent()
  if (agentDir) {
    await rmTempDir(agentDir)
    agentDir = null
  }
  resetDashboardForwardRequest()
  if (savedBrokerToken === undefined) delete process.env['TYPECLAW_HOSTD_BROKER_TOKEN']
  else process.env['TYPECLAW_HOSTD_BROKER_TOKEN'] = savedBrokerToken
})

async function writePlugin(dir: string, body: string) {
  await writeFile(join(dir, 'plugin.ts'), body)
}

describe('startAgent + plugin loading', () => {
  // 60s, not the global 30s: this is the first test to boot a full agent
  // (startAgent → server + agent-browser + memory plugins) and `await import()`
  // a temp plugin, paying Bun's cold transpile + graph resolution. ~hundreds of
  // ms in isolation, but starves past 30s under full 18-worker contention.
  test('loads a local plugin and merges its cron job under __plugin_<name>_<key>', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({
        models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
        plugins: ['./plugin.ts'],
      }),
    )
    await writePlugin(
      agentDir,
      `export default {
  plugin: async () => ({
    cronJobs: {
      'weekly-digest': { schedule: '0 9 * * 1', kind: 'prompt', prompt: 'go' },
    },
  }),
}`,
    )

    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })

    const ids = running.pluginRuntime.get().registry.cronJobs.map((j) => j.globalId)
    expect(ids).toContain('__plugin_plugin_weekly-digest')
    expect(running.loadedPlugins.map((p) => p.name)).toContain('plugin')
    expect(running.loadedPlugins.map((p) => p.name)).toContain('memory')
  }, 60_000)

  test('a user plugin whose factory throws is skipped — startAgent still boots, no leaked registrations', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({
        models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
        plugins: ['./plugin.ts'],
      }),
    )
    await writePlugin(
      agentDir,
      `export default {
  plugin: async () => {
    throw new Error('boom')
  },
}`,
    )

    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })
    // The broken user plugin is skipped: startAgent boots, the plugin is absent
    // from the loaded set, and it leaked no registrations keyed to its name.
    expect(running.loadedPlugins.map((p) => p.name)).not.toContain('plugin')
    const registry = running.pluginRuntime.get().registry
    expect(registry.tools.filter((t) => t.pluginName === 'plugin')).toEqual([])
    expect(registry.cronJobs.filter((j) => j.pluginName === 'plugin')).toEqual([])
  })

  test('plugin session.start hook fires when a websocket session opens', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    const sentinelFile = join(agentDir, 'session-start.log')
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({
        models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
        plugins: ['./plugin.ts'],
      }),
    )
    await writePlugin(
      agentDir,
      `import { writeFile } from 'node:fs/promises'
export default {
  plugin: async () => ({
    hooks: {
      'session.start': async (event) => {
        await writeFile(${JSON.stringify(sentinelFile)}, \`opened: \${event.sessionId}\`)
      },
    },
  }),
}`,
    )

    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })

    const ws = new WebSocket(`ws://localhost:${running.server.port}`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
    })

    const TIMEOUT_MS = 5000
    const POLL_MS = 25
    const iterations = Math.ceil(TIMEOUT_MS / POLL_MS)
    for (let i = 0; i < iterations; i++) {
      try {
        const content = await Bun.file(sentinelFile).text()
        if (content.startsWith('opened:')) {
          ws.close()
          return
        }
      } catch {}
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
    ws.close()
    throw new Error(`session.start hook never fired within ${TIMEOUT_MS}ms (sentinel ${sentinelFile} missing)`)
  })

  test('plugin skill is materialized and present in the resource loader for new sessions', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({
        models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
        plugins: ['./plugin.ts'],
      }),
    )
    await writePlugin(
      agentDir,
      `export default {
  plugin: async () => ({
    skills: {
      'how-to-x': { description: 'how to do X', content: '# X\\n\\nSteps...' },
    },
  }),
}`,
    )

    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })
    expect(running.pluginRuntime.get().registry.skills.map((s) => s.localName)).toEqual(['how-to-x'])
  })

  test('bundled agent-browser plugin contributes the agent-browser skill directory', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({ models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' } }),
    )

    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })

    expect(running.loadedPlugins.map((p) => p.name)).toContain('agent-browser')
    const skillDirs = running.pluginRuntime.get().registry.skillsDirs
    expect(skillDirs).toContainEqual(
      expect.objectContaining({
        pluginName: 'agent-browser',
        path: expect.stringMatching(/bundled-plugins[/\\]agent-browser[/\\]skills/),
      }),
    )
  })

  test('plugin subagent is registered and its tools are forwarded to the spawned session', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({
        models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
        plugins: ['./plugin.ts'],
      }),
    )
    await writePlugin(
      agentDir,
      `export default {
  plugin: async () => ({
    subagents: {
      worker: {
        systemPrompt: 'you are a worker',
        tools: [{ __builtinTool: 'read' }],
      },
    },
  }),
}`,
    )

    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })
    const subagent = running.pluginRuntime.get().registry.subagents.find((s) => s.subagentName === 'worker')
    expect(subagent).toBeDefined()
    expect(subagent?.subagent.tools).toEqual([{ __builtinTool: 'read' }])
  })

  test('ctx.spawnSubagent dispatches plugin subagents end-to-end (handler runs with validated payload)', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    await symlink(join(process.cwd(), 'node_modules'), join(agentDir, 'node_modules'), 'dir')
    const sentinelFile = join(agentDir, 'spawn-sentinel.json')
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({
        models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
        plugins: ['./plugin.ts'],
      }),
    )
    // The plugin defines a subagent with `customTools` and a `session.start`
    // hook that calls `ctx.spawnSubagent('probe', ...)`. The probe's handler
    // records the payload it received. This pins that the spawn path:
    //   1. Reaches the registered subagent's handler (no silent drop).
    //   2. Validates the payload against the declared schema.
    //   3. Surfaces the agentDir from the runtime context.
    // It does NOT verify deep tool wiring (that requires a live LLM session);
    // the cron-consumer path, which uses the same plugin-aware session factory,
    // is exercised separately by the cron tests.
    await writePlugin(
      agentDir,
      `import { z } from 'zod'
import { writeFile } from 'node:fs/promises'
const probeTool = {
  description: 'probe tool',
  parameters: z.object({}),
  async execute() { return { content: [{ type: 'text', text: 'ok' }] } },
}
export default {
  plugin: async (ctx) => ({
    subagents: {
      probe: {
        systemPrompt: 'probe',
        customTools: [probeTool],
        payloadSchema: z.object({ source: z.string() }),
        handler: async (subCtx) => {
          await writeFile(${JSON.stringify(sentinelFile)}, JSON.stringify({
            handlerRan: true,
            payload: subCtx.payload,
            agentDir: subCtx.agentDir,
          }))
        },
      },
    },
    hooks: {
      'session.start': async () => {
        await ctx.spawnSubagent('probe', { source: 'session-start' })
      },
    },
  }),
}`,
    )

    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })

    const ws = new WebSocket(`ws://localhost:${running.server.port}`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
    })

    const TIMEOUT_MS = 5000
    const POLL_MS = 25
    const iterations = Math.ceil(TIMEOUT_MS / POLL_MS)
    let written: { handlerRan: boolean; payload: unknown; agentDir: string } | null = null
    for (let i = 0; i < iterations; i++) {
      try {
        written = JSON.parse(await Bun.file(sentinelFile).text())
        if (written?.handlerRan) break
      } catch {}
      await new Promise((r) => setTimeout(r, POLL_MS))
    }
    ws.close()

    expect(written).not.toBeNull()
    expect(written?.handlerRan).toBe(true)
    expect(written?.payload).toEqual({ source: 'session-start' })
    expect(written?.agentDir).toBe(agentDir!)
  })

  test('kind: handler cron job fires with a well-formed CronHandlerContext when published to the cron stream', async () => {
    // given a plugin contributing a kind: 'handler' cron job that records what
    // it received in ctx
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    await symlink(join(process.cwd(), 'node_modules'), join(agentDir, 'node_modules'), 'dir')
    const sentinelFile = join(agentDir, 'handler-ran.json')
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({
        models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
        plugins: ['./plugin.ts'],
      }),
    )
    await writePlugin(
      agentDir,
      `import { writeFile } from 'node:fs/promises'
export default {
  plugin: async () => ({
    cronJobs: {
      watch: {
        schedule: '*/5 * * * *',
        kind: 'handler',
        handler: async (ctx) => {
          await writeFile(
            ${JSON.stringify(sentinelFile)},
            JSON.stringify({
              jobId: ctx.jobId,
              name: ctx.name,
              agentDir: ctx.agentDir,
              originKind: ctx.origin.kind,
              originJobKind: ctx.origin.kind === 'cron' ? ctx.origin.jobKind : null,
              scheduledByRole: ctx.origin.kind === 'cron' ? ctx.origin.scheduledByRole ?? null : null,
              hasPrompt: typeof ctx.prompt,
              hasSubagent: typeof ctx.subagent,
              hasExec: typeof ctx.exec,
              hasSignal: ctx.signal instanceof AbortSignal,
              hasLogger: typeof ctx.logger?.info,
              hasPermissions: typeof ctx.permissions?.has,
            }),
          )
        },
      },
    },
  }),
}`,
    )

    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })

    // when we publish the handler job to the cron stream directly (bypassing
    // the scheduler so the test stays deterministic — the scheduler's clock
    // would otherwise require waiting for the next */5 boundary)
    const registered = running.pluginRuntime.get().registry.cronJobs.find((j) => j.localId === 'watch')
    if (!registered) throw new Error('plugin handler cron job not registered')
    running.stream.publish({ target: { kind: 'cron', jobId: registered.globalId }, payload: registered.job })
    // Budget must clear CI --parallel scheduling jitter against a real startAgent
    // boot; a fixed 1 s window flaked (#763). Matches the session.start test above.
    const TIMEOUT_MS = 5000
    const POLL_MS = 25
    const iterations = Math.ceil(TIMEOUT_MS / POLL_MS)
    for (let i = 0; i < iterations && !(await Bun.file(sentinelFile).exists()); i++) {
      await new Promise((r) => setTimeout(r, POLL_MS))
    }

    // then the handler observed a well-formed ctx
    const observed = JSON.parse(await Bun.file(sentinelFile).text())
    expect(observed.jobId).toBe('__plugin_plugin_watch')
    expect(observed.name).toBe('plugin')
    expect(observed.agentDir).toBe(agentDir)
    expect(observed.originKind).toBe('cron')
    expect(observed.originJobKind).toBe('handler')
    expect(observed.scheduledByRole).toBe('owner')
    expect(observed.hasPrompt).toBe('function')
    expect(observed.hasSubagent).toBe('function')
    expect(observed.hasExec).toBe('function')
    expect(observed.hasSignal).toBe(true)
    expect(observed.hasLogger).toBe('function')
    expect(observed.hasPermissions).toBe('function')
  })

  test('plugin config block is validated against configSchema and exposed as ctx.config', async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-plugin-e2e-'))
    await symlink(join(process.cwd(), 'node_modules'), join(agentDir, 'node_modules'), 'dir')
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({
        models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' },
        plugins: ['./plugin.ts'],
        plugin: { magicNumber: 7 },
      }),
    )
    await writePlugin(
      agentDir,
      `import { z } from 'zod'
export default {
  configSchema: z.object({ magicNumber: z.number() }),
  plugin: async (ctx) => ({
    cronJobs: {
      magic: { schedule: \`\${ctx.config.magicNumber} * * * *\`, kind: 'prompt', prompt: 'tick' },
    },
  }),
}`,
    )

    running = await startAgent({ port: 0, attachTui: false, cwd: agentDir, loadCron: noCron })

    const job = running.pluginRuntime.get().registry.cronJobs.find((entry) => entry.localId === 'magic')?.job
    expect(job?.kind).toBe('prompt')
    expect(job?.schedule).toBe('7 * * * *')
  })
})
