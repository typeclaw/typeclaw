import { afterEach, describe, expect, test } from 'bun:test'

import { Agent } from '@earendil-works/pi-agent-core'
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
} from '@earendil-works/pi-ai'
import { AgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import FakeTimers from '@sinonjs/fake-timers'

import { resolveModel } from '@/config'

import { compactionTriggerTokens, createCompactionSettingsManager } from './compaction'
import { attachIdleCompaction } from './idle-compaction'

const model = resolveModel('anthropic/claude-sonnet-5')
// Above the 90% warmup threshold but below the trigger itself, so pi's own
// threshold compaction stays out of the way and only idle warmup can act.
const NEAR_TRIGGER_TOKENS = Math.round(compactionTriggerTokens(model) * 0.94)
const BELOW_WARMUP_TOKENS = Math.round(compactionTriggerTokens(model) * 0.6)
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function response(text: string, tokens = NEAR_TRIGGER_TOKENS): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: 'text', text }],
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: {
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: tokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

async function fixture(tokens = NEAR_TRIGGER_TOKENS) {
  const manager = SessionManager.inMemory()
  for (let i = 0; i < 8; i++) {
    manager.appendMessage({ role: 'user', content: 'history '.repeat(2_500), timestamp: i * 2 })
    manager.appendMessage({ ...response('answer '.repeat(2_500)), timestamp: i * 2 + 1 })
  }
  const settings = createCompactionSettingsManager(model)
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  })
  await runtime.setRuntimeApiKey(model.provider, 'test-key')
  let summaryCalls = 0
  let summarySignal: AbortSignal | undefined
  const summaryStarted = Promise.withResolvers<void>()
  let summaryResult = Promise.resolve(response('summary', 100))
  let summaryFailure: AssistantMessage | undefined
  let persistentFailure = false
  const agent = new Agent({
    initialState: { model, messages: manager.buildSessionContext().messages },
    streamFn: (_model, _context, options) => {
      const stream = createAssistantMessageEventStream()
      const summarizing = options?.signal !== agent.signal
      if (summarizing) {
        summaryCalls++
        summarySignal = options?.signal
        summaryStarted.resolve()
      }
      const result = summarizing
        ? summaryFailure
          ? Promise.resolve(summaryFailure)
          : summaryResult
        : Promise.resolve(response('answer', tokens))
      if (!persistentFailure) summaryFailure = undefined
      void result.then((message) => {
        if (message.stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message })
        else stream.push({ type: 'done', reason: 'stop', message })
        stream.end()
      })
      return stream
    },
  })
  const session = new AgentSession({
    agent,
    modelRuntime: runtime,
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      settingsManager: settings,
    }),
    cwd: process.cwd(),
    initialActiveToolNames: [],
  })
  const tasks: { run: () => Promise<void>; cancelled: boolean }[] = []
  let applied = 0
  const stop = attachIdleCompaction(session, {
    onApplied: () => {
      applied += 1
    },
    schedule: (run) => {
      const task = { run, cancelled: false }
      tasks.push(task)
      return () => {
        task.cancelled = true
      }
    },
  })
  cleanups.push(() => {
    stop()
    session.dispose()
  })
  return {
    session,
    manager,
    tasks,
    applied: () => applied,
    summaryCalls: () => summaryCalls,
    summarySignal: () => summarySignal,
    summaryStarted: summaryStarted.promise,
    failSummary: (persistent = false) => {
      persistentFailure = persistent
      summaryFailure = { ...response(''), stopReason: 'error', errorMessage: 'terminated' }
    },
    holdSummary: () => {
      const deferred = Promise.withResolvers<AssistantMessage>()
      summaryResult = deferred.promise
      return () => deferred.resolve(response('summary', 100))
    },
    compactions: () => manager.getBranch().filter((entry) => entry.type === 'compaction'),
    runWarmup: () => {
      const task = tasks.find((item) => !item.cancelled)
      if (!task) throw new Error('No idle compaction scheduled')
      task.cancelled = true
      return task.run()
    },
  }
}

describe('idle compaction', () => {
  test('applies a pi summary while idle just below the normal trigger', async () => {
    const f = await fixture()
    await f.session.prompt('finish this turn')
    const before = f.manager
      .getBranch()
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.id)

    await f.runWarmup()

    expect(f.summaryCalls()).toBeGreaterThan(0)
    expect(f.compactions()).toHaveLength(1)
    expect(f.compactions()[0]?.summary).toContain('summary')
    expect(f.applied()).toBe(1)
    expect(f.session.messages).toEqual(f.manager.buildSessionContext().messages)
    expect(
      f.manager
        .getBranch()
        .filter((entry) => entry.type === 'message')
        .map((entry) => entry.id),
    ).toEqual(before)
    expect(f.session.getContextUsage()?.tokens).toBeNull()
  })

  test('does not schedule below the warmup threshold', async () => {
    const f = await fixture(BELOW_WARMUP_TOKENS)

    await f.session.prompt('small turn')

    expect(f.tasks).toHaveLength(0)
    expect(f.summaryCalls()).toBe(0)
    expect(f.compactions()).toHaveLength(0)
  })

  test('cancels and discards a summary when a new prompt starts', async () => {
    const f = await fixture()
    await f.session.prompt('first turn')
    const release = f.holdSummary()
    const work = f.runWarmup()
    await f.summaryStarted

    const next = f.session.prompt('new user message')
    expect(f.summarySignal()?.aborted).toBe(true)
    release()
    await Promise.all([work, next])

    expect(f.compactions()).toHaveLength(0)
    expect(f.manager.buildSessionContext().messages).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'new user message' }],
      }),
    )
  })

  test('discards a summary if a message is appended without a new turn', async () => {
    const f = await fixture()
    await f.session.prompt('first turn')
    const release = f.holdSummary()
    const work = f.runWarmup()
    await f.summaryStarted

    f.manager.appendMessage({ role: 'user', content: 'late context', timestamp: Date.now() })
    release()
    await work

    expect(f.compactions()).toHaveLength(0)
    expect(f.applied()).toBe(0)
    expect(f.manager.buildSessionContext().messages.at(-1)).toMatchObject({ content: 'late context' })
  })

  test('disposal cancels a pending summary without applying it', async () => {
    const f = await fixture()
    await f.session.prompt('first turn')
    const release = f.holdSummary()
    const work = f.runWarmup()
    await f.summaryStarted

    f.session.dispose()
    release()
    await work

    expect(f.compactions()).toHaveLength(0)
  })

  test('the next turn does not compact again using stale pre-compaction usage', async () => {
    const f = await fixture(Math.round(compactionTriggerTokens(model) * 0.91))
    await f.session.prompt('first turn')
    await f.runWarmup()
    const summaries = f.summaryCalls()

    await f.session.prompt('next turn')

    expect(f.compactions()).toHaveLength(1)
    expect(f.summaryCalls()).toBe(summaries)
  })

  test('retries a transient summary failure through pi before applying', async () => {
    const f = await fixture()
    await f.session.prompt('first turn')
    f.failSummary()
    const clock = FakeTimers.install()
    try {
      const work = f.runWarmup()
      await f.summaryStarted

      await clock.runAllAsync()
      await work

      expect(f.summaryCalls()).toBeGreaterThan(1)
      expect(f.compactions()).toHaveLength(1)
    } finally {
      clock.uninstall()
    }
  })

  test('manual compaction wins over an in-flight idle summary', async () => {
    const f = await fixture()
    await f.session.prompt('first turn')
    const release = f.holdSummary()
    const work = f.runWarmup()
    await f.summaryStarted

    const manual = f.session.compact()
    release()
    await Promise.all([work, manual])

    expect(f.compactions()).toHaveLength(1)
  })

  test('stops retrying after the bounded transient failure budget', async () => {
    const f = await fixture()
    await f.session.prompt('first turn')
    const leaf = f.manager.getLeafId()
    f.failSummary(true)
    const clock = FakeTimers.install()
    try {
      const work = f.runWarmup()
      await f.summaryStarted

      await clock.runAllAsync()
      await work

      expect(f.summaryCalls()).toBeGreaterThan(1)
      expect(f.summaryCalls()).toBeLessThanOrEqual(6)
      expect(f.compactions()).toHaveLength(0)
      expect(f.manager.getLeafId()).toBe(leaf)
    } finally {
      clock.uninstall()
    }
  })

  test('does not run a queued warmup after immediate session disposal', async () => {
    const f = await fixture()
    await f.session.prompt('first turn')

    f.session.dispose()

    expect(f.tasks.every((task) => task.cancelled)).toBe(true)
    expect(f.summaryCalls()).toBe(0)
  })
})
