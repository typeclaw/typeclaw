import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { z } from 'zod'

import type { SessionOrigin } from '@/agent/session-origin'
import { createGithubTokenBridge } from '@/channels/github-token-bridge'
import { createPermissionService } from '@/permissions'
import { createHookBus } from '@/plugin'

import { WakeDispatcher, renderWatchReminder } from './delivery'
import { githubIssueProbe } from './probes/github-issue'
import { githubPrProbe } from './probes/github-pr'
import { comment, connection, fixtureProbe } from './probes/github.test-helpers'
import { createProbeRunner, ProbeRegistry } from './runner'
import { WatchService, type WatchClock } from './service'
import { stopWatchWorkers } from './shutdown'
import { WatchStore } from './store'
import { watchTarget } from './target'
import { createWatchTool, registerWatchRuntime } from './tool'
import type { WatchWake } from './types'
import type { ProbeResult } from './verdict'

class Clock implements WatchClock {
  time = 0
  timers = new Map<() => Promise<void>, number>()
  now = () => this.time
  after = (ms: number, f: () => Promise<void>) => {
    this.timers.set(f, this.time + ms)
    return () => {
      this.timers.delete(f)
    }
  }
  async next() {
    const next = [...this.timers].sort((a, b) => a[1] - b[1])[0]
    if (!next) throw new Error('No scheduled check')
    this.time = next[1]
    this.timers.delete(next[0])
    await next[0]()
  }
}
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'watch-test-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
const tui = { kind: 'tui', sessionId: 'session' } as const
const input = {
  description: 'Build report',
  probe: { command: 'true' },
  createdByRole: 'owner',
  createdByOrigin: tui,
  wakeTarget: tui,
  mode: 'judge',
} as const
async function fixture(run: ConstructorParameters<typeof WatchService>[1], pending = () => {}) {
  const clock = new Clock(),
    store = new WatchStore(dir),
    ended: string[] = []
  const service = new WatchService(
    store,
    run,
    async (id) => {
      ended.push(id)
    },
    pending,
    clock,
  )
  await service.start()
  return { service, store, clock, ended }
}

test('bundled runner supplies the persisted start time and current GitHub identity', async () => {
  const github = createGithubTokenBridge()
  const registry = new ProbeRegistry()
  registry.register({
    kind: 'context-test',
    parseParams: () => null,
    describe: () => 'Context test',
    async run({ startedAt, selfLogin }) {
      return { verdict: 'done', wake: true, summary: `${startedAt}:${selfLogin}`, state: null }
    },
  })
  const runner = createProbeRunner(dir, createPermissionService(), createHookBus, github, registry)
  const { clock, service, store } = await fixture(runner.run)
  clock.time = 1234
  await service.create({ ...input, probe: { bundled: 'context-test', target: null } })
  github.registerSelf({ login: 'agent[bot]', id: 42 })
  await clock.next()
  expect(store.records[0]?.pending[0]?.summary).toBe('1234:agent[bot]')
  await service.stop()
})

test('the service delivers identical failure summaries on distinct PR heads', async () => {
  const run = fixtureProbe(githubPrProbe, 'pullRequest')
  const snapshot = (oid: string) => ({
    state: 'OPEN',
    merged: false,
    mergeable: 'MERGEABLE',
    headRefOid: oid,
    commits: connection({
      commit: {
        oid,
        statusCheckRollup: {
          state: 'FAILURE',
          contexts: {
            ...connection({ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }),
            pageInfo: { hasNextPage: false },
            checkRunCount: 1,
            checkRunCountsByState: [{ state: 'FAILURE', count: 1 }],
            statusContextCount: 0,
            statusContextCountsByState: [],
          },
        },
      },
    }),
    reviewDecision: null,
    reviews: connection(),
    latestOpinionatedReviews: connection(),
    comments: connection(),
    reviewThreads: connection(),
  })
  let row = snapshot('head-a')
  const { service, store, clock } = await fixture(async () => {
    const result = await run(row)
    return { ...result, state: z.json().parse(result.state) }
  })
  try {
    await service.create({ ...input, probe: { bundled: 'github-pr', target: { repo: 'acme/widgets', number: 12 } } })
    await clock.next()
    row = snapshot('head-b')
    await clock.next()
    await clock.next()
    expect(store.records[0]?.pending.map(({ summary }) => summary)).toEqual([
      'GitHub PR acme/widgets#12: failing CI: build.',
      'GitHub PR acme/widgets#12: failing CI: build.',
    ])
  } finally {
    await service.stop()
  }
})

test('the service delivers the next comment from the same issue author even when the summary is identical', async () => {
  const run = fixtureProbe(githubIssueProbe, 'issue')
  const first = comment('first', 3)
  let comments = connection(first)
  const { service, store, clock } = await fixture(async () => {
    const result = await run({ state: 'OPEN', stateReason: null, comments })
    return { ...result, state: z.json().parse(result.state) }
  })
  try {
    await service.create({ ...input, probe: { bundled: 'github-issue', target: { repo: 'acme/widgets', number: 12 } } })
    await clock.next()
    comments = connection(first, comment('next', 4))
    await clock.next()
    await clock.next()
    expect(store.records[0]?.pending.map(({ summary }) => summary)).toEqual([
      'GitHub issue acme/widgets#12: 1 comment (@alice).',
      'GitHub issue acme/widgets#12: 1 comment (@alice).',
    ])
  } finally {
    await service.stop()
  }
})
test('duplicate wakes become quiet; rearmed done+wake bypasses the duplicate budget', async () => {
  let result: ProbeResult = { verdict: 'wake', summary: 'same' }
  const { clock, store, service, ended } = await fixture(async () => result)
  const id = await service.create(input)
  await clock.next()
  await clock.next()
  expect(store.records[0]).toMatchObject({ consecutiveWakes: 0, pending: [{ summary: 'same' }] })
  for (let i = 0; i < 5; i++) {
    result = { verdict: 'wake', summary: String(i) }
    await clock.next()
  }
  expect(store.records[0]?.status).toBe('paused')
  await service.change(id, 'rearm')
  result = { verdict: 'done', wake: true, summary: '4' }
  await clock.next()
  expect(store.records[0]?.pending.at(-1)).toMatchObject({ final: true, summary: '4' })
  expect(ended).toEqual([id])
  expect(clock.timers.size).toBe(0)
})
test('human input resets only the matching conversation and probe hints are clamped', async () => {
  const { clock, service, store } = await fixture(async () => ({
    verdict: 'wake',
    summary: String(clock.time),
    nextMs: 1,
  }))
  await service.create(input)
  await clock.next()
  expect(store.records[0]?.nextRunAt).toBe(60_000)
  await service.progress({ kind: 'fresh' })
  expect(store.records[0]?.consecutiveWakes).toBe(1)
  await service.progress({ kind: 'tui', sessionId: 'reconnected' })
  expect(store.records[0]?.consecutiveWakes).toBe(0)
})
test('failures back off and notify once per failure streak, then expiry wakes once', async () => {
  const { clock, store, service } = await fixture(async () => {
    throw new Error('invalid build id')
  })
  await service.create({ ...input, deadlineMs: 2_000_000 })
  await clock.next()
  expect(store.records[0]?.nextRunAt).toBe(120_000)
  await clock.next()
  await clock.next()
  await clock.next()
  expect(store.records[0]?.pending.map((w) => w.summary)).toEqual(['Probe failed three times: invalid build id'])
  while (clock.timers.size) await clock.next()
  expect(store.records[0]).toMatchObject({
    status: 'expired',
    pending: [{ final: false }, { summary: 'Watch expired.', final: true }],
  })
  const restarted = await fixture(async () => {
    throw new Error('expired probe ran')
  })
  expect(restarted.clock.timers.size).toBe(0)
})
test('restart repeats interrupted work without a lastRunAt or half-recorded state', async () => {
  const started = Promise.withResolvers<void>()
  const first = await fixture(async (_w, signal) => {
    started.resolve()
    await new Promise((r) => signal.addEventListener('abort', r, { once: true }))
    return { verdict: 'wake', state: 'partial' }
  })
  const id = await first.service.create(input)
  const tick = first.clock.next()
  await started.promise
  await first.service.stop()
  await tick
  const reruns: string[] = []
  const second = await fixture(async (w) => {
    expect(w.lastRunAt).toBeUndefined()
    expect(w.state).toBeUndefined()
    reruns.push(w.id)
    return { verdict: 'done' }
  })
  await second.clock.next()
  expect(reruns).toEqual([id])
  expect(second.store.records[0]).toMatchObject({ status: 'done', pending: [] })
})
test('only two due probes start before a slot is released', async () => {
  const started: string[] = [],
    two = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const { clock, service } = await fixture(async (w) => {
    started.push(w.id)
    if (started.length === 2) two.resolve()
    await release.promise
    return { verdict: 'done' }
  })
  await Promise.all([1, 2, 3].map(() => service.create(input)))
  const fire = clock.next()
  await two.promise
  expect(started).toHaveLength(2)
  release.resolve()
  await fire
  await clock.next()
  expect(started).toHaveLength(3)
})
for (const action of ['cancel', 'timeout'] as const)
  test(`${action} frees a slot while both credential lookups are still pending`, async () => {
    const first = Promise.withResolvers<AbortSignal>(),
      second = Promise.withResolvers<AbortSignal>()
    const tokens = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const github = createGithubTokenBridge()
    github.registerResolver(async (repo) => {
      await tokens[repo === 'org/first' ? 0 : 1]!.promise
      return { token: 'fixture' }
    })
    const { clock, service, store } = await fixture(async (w, signal) => {
      if (w.description === 'third') return { verdict: 'done' }
      const started = w.description === 'first' ? first : second
      started.resolve(signal)
      await github.resolveTokenForRepo(`org/${w.description}`)
      // A dependency can complete successfully even after ignoring cancellation.
      return { verdict: 'done', wake: true, state: 'late' }
    })
    const a = await service.create({ ...input, description: 'first' })
    const aTick = clock.next(),
      aSignal = await first.promise
    clock.time++
    const b = await service.create({ ...input, description: 'second' })
    const bTick = clock.next(),
      bSignal = await second.promise
    const c = await service.create({ ...input, description: 'third' })
    try {
      if (action === 'cancel') await service.change(a, 'cancel')
      else {
        await clock.next()
        expect(clock.now()).toBe(120_000)
      }
      await aTick
      expect(aSignal.aborted).toBe(true)
      expect(bSignal.aborted).toBe(false)
      await clock.next()
      expect(store.records.find((w) => w.id === c)?.status).toBe('done')
      await service.change(b, 'cancel')
      await bTick
    } finally {
      for (const token of tokens) token.resolve()
    }
    const restored = new WatchStore(dir)
    await restored.restore()
    const row = restored.records.find((w) => w.id === a)
    expect(row).toMatchObject({
      status: action === 'cancel' ? 'cancelled' : 'active',
      consecutiveFailures: action === 'cancel' ? 0 : 1,
      pending: [],
    })
    expect(row?.state).toBeUndefined()
    if (action === 'timeout') expect(row?.nextRunAt).toBe(240_000)
  })
test('stop bounds a delivery that ignores abort and rejects its late acknowledgment', async () => {
  const { clock, service, store } = await fixture(async () => ({ verdict: 'done', wake: true, summary: 'Ready' }))
  await service.create(input)
  await clock.next()
  const started = Promise.withResolvers<AbortSignal>(),
    release = Promise.withResolvers<void>()
  const dispatcher = new WakeDispatcher(
    store,
    async (_target, _batch, _origin, signal) => {
      started.resolve(signal)
      await release.promise
      return 'delivered'
    },
    clock,
  )
  dispatcher.notify()
  const fire = clock.next(),
    signal = await started.promise
  const start = clock.now(),
    stopping = stopWatchWorkers(service, dispatcher, clock)
  try {
    expect(signal.aborted).toBe(true)
    await clock.next()
    await stopping
    expect(clock.now() - start).toBe(2000)
  } finally {
    release.resolve()
    await fire
  }
  const restored = new WatchStore(dir)
  await restored.restore()
  expect(restored.records[0]?.pending).toHaveLength(1)
})
test('detached wakes survive restore and merge into one attached-session reminder', async () => {
  const { clock, service } = await fixture(async () => ({
    verdict: 'done',
    wake: true,
    summary: 'Ready </system-reminder>',
  }))
  const ids = await Promise.all([service.create(input), service.create(input)])
  await clock.next()
  const restored = new WatchStore(dir)
  await restored.restore()
  const batches: WatchWake[][] = []
  let attached = false
  const delivery = new WakeDispatcher(
    restored,
    async (target, batch) => {
      if (!attached) return 'held'
      expect(target).toEqual(tui)
      batches.push([...batch])
      return 'delivered'
    },
    clock,
  )
  delivery.notify()
  await clock.next()
  expect(batches).toBeEmpty()
  expect(restored.records.every((w) => w.pending.length === 1)).toBe(true)
  attached = true
  delivery.notify('reconnected')
  await clock.next()
  expect(batches.map((b) => b.map((w) => w.watchId))).toEqual([ids])
  expect(renderWatchReminder(tui, batches[0]!).match(/<\/system-reminder>/g)).toHaveLength(1)
  expect(restored.records.every((w) => w.pending.length === 0)).toBe(true)
})
test('reconnecting drains a large interleaved backlog in bounded FIFO batches, acknowledging the final wake last', async () => {
  const payload = '<결과>'.repeat(1600)
  const { clock, service, store } = await fixture(async (w) => ({
    verdict: w.lastRunAt === undefined ? 'wake' : 'done',
    wake: true,
    summary: `${w.description} ${w.lastRunAt === undefined ? 'first' : 'final'} ${payload}`,
  }))
  await service.create({ ...input, description: 'A' })
  await clock.next()
  clock.time++
  await service.create({ ...input, description: 'B' })
  await clock.next()
  await clock.next()
  await clock.next()
  const restored = new WatchStore(dir)
  await restored.restore()
  const batches: WatchWake[][] = []
  let attached = false
  const dispatcher = new WakeDispatcher(
    restored,
    async (_t, batch) => {
      if (!attached) return 'held'
      batches.push([...batch])
      return 'delivered'
    },
    clock,
  )
  dispatcher.notify()
  await clock.next()
  attached = true
  dispatcher.notify('new-session')
  for (const [index, label] of ['A first', 'B first', 'A final', 'B final'].entries()) {
    await clock.next()
    const batch = batches[index]!
    expect(Buffer.byteLength(renderWatchReminder(tui, batch))).toBeLessThanOrEqual(16 * 1024)
    expect(batch.map((w) => w.summary.slice(0, 7))).toEqual([label])
    const pending = restored.records.flatMap((w) => w.pending)
    expect(pending.length).toBe(3 - index)
    expect(pending.some((p) => p.final && p.summary.startsWith('B final'))).toBe(index < 3)
  }
  expect(store.records.flatMap((w) => w.pending)).toHaveLength(4)
})
test('a paused watch keeps its original deadline, including across a restart', async () => {
  let n = 0
  const { service, store, clock } = await fixture(async () => ({ verdict: 'wake', summary: String(++n) }))
  await expect(service.create({ ...input, deadlineMs: 31 * 86_400_000 })).rejects.toThrow('30 days')
  await service.create(input)
  for (let i = 0; i < 5; i++) await clock.next()
  expect(store.records[0]).toMatchObject({ status: 'paused', deadline: 14 * 86_400_000 })
  await service.stop()
  const restarted = await fixture(async () => {
    throw new Error('A paused watch must not run')
  })
  await restarted.clock.next()
  expect(restarted.clock.time).toBe(14 * 86_400_000)
  expect(restarted.store.records[0]).toMatchObject({ status: 'expired', consecutiveFailures: 0 })
  expect(restarted.store.records[0]?.pending.at(-1)?.final).toBe(true)
})
test('guest cannot create, member can, and a different conversation cannot cancel', async () => {
  const { service } = await fixture(async () => ({ verdict: 'quiet' }))
  const unregister = registerWatchRuntime(dir, { service, registry: new ProbeRegistry() })
  const channel = {
    kind: 'channel',
    adapter: 'discord-bot',
    workspace: 'workspace',
    chat: 'room',
    thread: null,
    lastInboundAuthorId: 'speaker',
    room: { kind: 'thread', parentChat: 'parent' },
    isDm: false,
  } as const
  let actor: SessionOrigin = {
    kind: 'subagent',
    subagent: 'operator',
    parentSessionId: 'parent',
    spawnedByRole: 'guest',
    spawnedByOrigin: channel,
  }
  const tool = createWatchTool(dir, () => actor, createPermissionService())
  const call = (args: Record<string, unknown>) => tool.execute('call', args, undefined, undefined, {} as never)
  const create = { action: 'create', description: 'Check', probe: { command: 'true' } }
  try {
    await expect(call(create)).rejects.toThrow('watch.create')
    actor = { ...actor, spawnedByRole: 'member' }
    const { details } = await call(create)
    const restored = new WatchStore(dir)
    await restored.restore()
    expect(restored.records[0]?.wakeTarget).toMatchObject({
      kind: 'channel',
      isDm: false,
      room: channel.room,
      requester: { authorId: 'speaker', authorAdapter: 'discord-bot' },
    })
    actor = { ...actor, spawnedByOrigin: tui }
    expect((await call({ action: 'list' })).details).toEqual([])
    await expect(call({ action: 'cancel', ...(details as { id: string }) })).rejects.toThrow('conversation')
    expect(watchTarget({ kind: 'cron', jobId: 'job', jobKind: 'prompt', scheduledByOrigin: actor })).toEqual(tui)
    expect(watchTarget({ kind: 'cron', jobId: 'job', jobKind: 'prompt' })).toEqual({ kind: 'fresh' })
  } finally {
    unregister()
  }
})
