import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentSession } from '@/agent'
import { createCronReloadable, createScheduler, loadCron, type Scheduler } from '@/cron'
import { ReloadRegistry } from '@/reload'
import { createServer } from '@/server'

import { requestReload } from './client'

let agentDir: string
let server: ReturnType<ReturnType<typeof createServer>['start']> | null = null

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-reload-e2e-'))
})

afterEach(async () => {
  server?.stop(true)
  server = null
  await rm(agentDir, { recursive: true, force: true })
})

const stubSession: AgentSession = {
  subscribe: () => () => {},
  prompt: async () => {},
} as unknown as AgentSession

async function startTestAgent(scheduler: Scheduler): Promise<{ url: string }> {
  const reloadRegistry = new ReloadRegistry()
  reloadRegistry.register(createCronReloadable({ cwd: agentDir, scheduler }))

  const built = createServer({
    port: 0,
    reloadAll: () => reloadRegistry.reloadAll(),
    reloadRegistry,
    createSession: async () => ({ session: stubSession, dispose: async () => {} }),
  }).start()
  server = built
  return { url: `ws://localhost:${built.port}` }
}

describe('reload end-to-end via ws', () => {
  test('edit cron.json + requestReload -> scheduler.replaceJobs receives the new jobs', async () => {
    const replacements: Array<Array<{ id: string }>> = []
    const scheduler: Scheduler = {
      start: () => {},
      stop: () => {},
      replaceJobs: (jobs) => {
        replacements.push(jobs.map((j) => ({ id: j.id })))
        return { added: jobs, removed: [], updated: [], unchanged: [] }
      },
    }
    await writeFile(join(agentDir, 'cron.json'), JSON.stringify({ jobs: [] }))
    const { url } = await startTestAgent(scheduler)

    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [
          { id: 'a', schedule: '* * * * *', kind: 'prompt', prompt: 'x' },
          { id: 'b', schedule: '0 * * * *', kind: 'prompt', prompt: 'y' },
        ],
      }),
    )

    const results = await requestReload({ url })

    expect(results).toHaveLength(1)
    const cron = results[0]
    if (!cron || !cron.ok) throw new Error(`expected cron ok, got: ${JSON.stringify(cron)}`)
    expect(cron.summary).toMatch(/2 jobs/)
    expect(replacements).toHaveLength(1)
    expect(replacements[0]?.map((j) => j.id)).toEqual(['a', 'b'])
  })

  test('reload preserves the live schedule when the new cron.json is invalid', async () => {
    const replacements: Array<Array<{ id: string }>> = []
    const realScheduler = createScheduler({
      jobs: [],
      onFire: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    const scheduler: Scheduler = {
      ...realScheduler,
      replaceJobs: (jobs) => {
        replacements.push(jobs.map((j) => ({ id: j.id })))
        return realScheduler.replaceJobs(jobs)
      },
    }
    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [{ id: 'good', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }],
      }),
    )
    const initial = await loadCron(agentDir)
    if (!initial.ok || !initial.file) throw new Error('setup failed')
    scheduler.replaceJobs(initial.file.jobs)
    replacements.length = 0
    scheduler.start()

    const { url } = await startTestAgent(scheduler)

    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({ jobs: [{ id: 'broken', schedule: 'not-a-cron', kind: 'prompt', prompt: 'x' }] }),
    )

    const results = await requestReload({ url })

    const cron = results[0]
    if (!cron || cron.ok) throw new Error(`expected failure, got: ${JSON.stringify(cron)}`)
    expect(cron.reason).toMatch(/not-a-cron/)
    expect(replacements).toHaveLength(0)

    scheduler.stop()
  })

  test('removing cron.json reloads to zero jobs', async () => {
    const scheduler: Scheduler & { current: { id: string }[] } = {
      current: [],
      start: () => {},
      stop: () => {},
      replaceJobs: function (jobs) {
        this.current = jobs.map((j) => ({ id: j.id }))
        return { added: jobs, removed: [], updated: [], unchanged: [] }
      },
    } as Scheduler & { current: { id: string }[] }

    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({ jobs: [{ id: 'a', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] }),
    )
    const { url } = await startTestAgent(scheduler)

    await rm(join(agentDir, 'cron.json'))
    const results = await requestReload({ url })

    const cron = results[0]
    if (!cron || !cron.ok) throw new Error(`expected ok, got: ${JSON.stringify(cron)}`)
    expect(cron.summary).toMatch(/0 jobs/)
  })

  test('multiple reloads in succession each reflect the latest cron.json', async () => {
    const seen: string[][] = []
    const scheduler: Scheduler = {
      start: () => {},
      stop: () => {},
      replaceJobs: (jobs) => {
        seen.push(jobs.map((j) => j.id))
        return { added: jobs, removed: [], updated: [], unchanged: [] }
      },
    }
    await writeFile(join(agentDir, 'cron.json'), JSON.stringify({ jobs: [] }))
    const { url } = await startTestAgent(scheduler)

    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({ jobs: [{ id: 'one', schedule: '* * * * *', kind: 'prompt', prompt: 'x' }] }),
    )
    await requestReload({ url })

    await writeFile(
      join(agentDir, 'cron.json'),
      JSON.stringify({
        jobs: [
          { id: 'one', schedule: '* * * * *', kind: 'prompt', prompt: 'x' },
          { id: 'two', schedule: '0 * * * *', kind: 'prompt', prompt: 'y' },
        ],
      }),
    )
    await requestReload({ url })

    expect(seen).toEqual([['one'], ['one', 'two']])
  })
})
