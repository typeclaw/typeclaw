import { afterEach, describe, expect, test } from 'bun:test'

import type { CronFile, CronJob, LoadCronResult } from '@/cron'
import { startAgent, type LoadCronFn } from '@/run'

import { definePlugin } from './index'
import { PluginManager } from './manager'

const noCron: LoadCronFn = async () => ({ ok: true, file: null }) as LoadCronResult

let running: Awaited<ReturnType<typeof startAgent>> | null = null

afterEach(async () => {
  if (!running) return
  await running.stop()
  running = null
})

describe('startAgent + PluginManager', () => {
  test('plugin cron jobs are merged with cron.json jobs into the real default scheduler', async () => {
    const pluginJob: CronJob = {
      id: '__plugin_a_heartbeat',
      schedule: '*/5 * * * *',
      enabled: true,
      kind: 'subagent',
      subagent: 'worker',
      payload: { tick: 1 },
    }
    const userJob: CronJob = { id: 'user-job', schedule: '* * * * *', kind: 'prompt', prompt: 'x', enabled: true }

    const pluginManager = new PluginManager({ agentDir: process.cwd() })
    await pluginManager.loadOne(
      definePlugin({ name: 'a' }, (ctx) => {
        ctx.registerSubagent('worker', async () => {})
        ctx.registerCronJob(pluginJob)
      }),
    )

    const loadCron: LoadCronFn = async () =>
      ({ ok: true, file: { jobs: [userJob] } satisfies CronFile }) as LoadCronResult

    running = await startAgent({ port: 0, attachTui: false, loadCron, pluginManager })

    expect(running.scheduler).not.toBeNull()
    const diff = running.scheduler!.replaceJobs([])
    const registeredIds = diff.removed.map((j) => j.id).sort()
    expect(registeredIds).toEqual(['__plugin_a_heartbeat', 'user-job'])
  })
  test('exposes the same PluginManager passed in via the result', async () => {
    const pluginManager = new PluginManager({ agentDir: process.cwd() })
    running = await startAgent({ port: 0, attachTui: false, loadCron: noCron, pluginManager })
    expect(running.pluginManager).toBe(pluginManager)
  })

  test('subagent spawners from plugins are dispatched alongside core spawners', async () => {
    const pluginManager = new PluginManager({ agentDir: process.cwd() })
    let workerCalls = 0
    let workerPayload: unknown = null
    await pluginManager.loadOne(
      definePlugin({ name: 'a' }, (ctx) =>
        ctx.registerSubagent('worker', async (payload) => {
          workerCalls++
          workerPayload = payload
        }),
      ),
    )

    running = await startAgent({ port: 0, attachTui: false, loadCron: noCron, pluginManager })

    running.stream.publish({
      target: { kind: 'new-session', subagent: 'worker' },
      payload: { hello: 'world' },
    })
    await new Promise((r) => setTimeout(r, 20))

    expect(workerCalls).toBe(1)
    expect(workerPayload).toEqual({ hello: 'world' })
  })

  test('a subagent name conflict between core and plugin is loud at startAgent', async () => {
    const pluginManager = new PluginManager({ agentDir: process.cwd() })
    await pluginManager.loadOne(
      definePlugin({ name: 'a' }, (ctx) => ctx.registerSubagent('memory-logger', async () => {})),
    )

    await expect(startAgent({ port: 0, attachTui: false, loadCron: noCron, pluginManager })).rejects.toThrow(
      /subagent name conflict.*memory-logger/,
    )
  })

  test('plugin shutdown handlers run when the agent stops', async () => {
    const pluginManager = new PluginManager({ agentDir: process.cwd() })
    let shutdownCalled = false
    await pluginManager.loadOne(
      definePlugin({ name: 'a' }, (ctx) =>
        ctx.onShutdown(() => {
          shutdownCalled = true
        }),
      ),
    )

    running = await startAgent({ port: 0, attachTui: false, loadCron: noCron, pluginManager })
    await running.stop()
    running = null
    expect(shutdownCalled).toBe(true)
  })
})
