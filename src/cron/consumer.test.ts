import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentSession } from '@/agent'
import { LiveSubagentRegistry } from '@/agent/live-subagents'
import { createHookBus, type HookBus } from '@/plugin'
import { createStream } from '@/stream'

import { createCronConsumer, CRON_COMPLETION_CHECK_PROMPT, type CronConsumerLogger, type CronSession } from './consumer'
import type { CronJob, ExecJob, HandlerJob, PromptJob } from './schema'

async function waitForFile(path: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    if (await Bun.file(path).exists()) {
      // A concurrent writer can create the inode before flushing content, so
      // reading on the existence edge can return an empty/partial file. Wait
      // for non-empty content before returning.
      const text = await Bun.file(path).text()
      if (text.length > 0) return text
    }
    await Bun.sleep(50)
  }
  throw new Error(`file was not created before timeout: ${path}`)
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await Bun.sleep(50)
  }
  throw new Error('condition was not met before timeout')
}

async function waitForConsumerIdle(consumer: ReturnType<typeof createCronConsumer>): Promise<void> {
  await waitForCondition(() => consumer.inFlightCount() === 0)
}

// Minimal AgentSession stub satisfying the surface the model-fallback helper
// uses: `subscribe` for soft-error detection (returns a no-op unsubscribe)
// and `prompt` for the actual turn call. Production code routes the prompt
// through CronSession.prompt (which itself calls AgentSession.prompt), but
// the fallback helper bypasses the wrapper and calls AgentSession.prompt
// directly — so the stub has to honor the same callback to keep the test
// fakes behaving like their pre-fallback predecessors.
function stubAgentSession(promptImpl: (text: string) => Promise<void> = async () => {}): AgentSession {
  return {
    subscribe: () => () => {},
    prompt: promptImpl,
  } as unknown as AgentSession
}

function fakeHooks(events: string[]): HookBus {
  return {
    ...createHookBus(),
    registerAll: () => {},
    unregisterAll: () => {},
    runSessionStart: async () => {},
    runSessionEnd: async (e) => {
      events.push(`end:${e.sessionId}`)
    },
    runSessionIdle: async (e) => {
      events.push(`idle:${e.sessionId}:${e.parentTranscriptPath ?? '-'}`)
    },
    runSessionPrompt: async () => {},
    runSessionTurnStart: async () => {},
    runSessionTurnEnd: async () => {},
    runToolBefore: async () => undefined,
    runToolAfter: async () => {},
    count: () => 0,
  }
}

const silentLogger: CronConsumerLogger = { info: () => {}, warn: () => {}, error: () => {} }

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-cron-consumer-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const promptJob = (id: string, prompt: string): PromptJob => ({
  id,
  schedule: '* * * * *',
  enabled: true,
  kind: 'prompt',
  prompt,
})

const execJob = (id: string, command: string[]): ExecJob => ({
  id,
  schedule: '* * * * *',
  enabled: true,
  kind: 'exec',
  command,
})

const handlerJob = (id: string): HandlerJob => ({
  id,
  schedule: '* * * * *',
  enabled: true,
  kind: 'handler',
  handler: async () => {},
})

function publishCron(stream: ReturnType<typeof createStream>, job: CronJob): string {
  return stream.publish({ target: { kind: 'cron', jobId: job.id }, payload: job })
}

function makeFakeSessionFactory(): {
  createSessionForCron: (job: PromptJob) => Promise<CronSession>
  callsByJob: Map<string, string[]>
} {
  const callsByJob = new Map<string, string[]>()
  return {
    callsByJob,
    createSessionForCron: async (job) => {
      const record = (text: string) => {
        const existing = callsByJob.get(job.id) ?? []
        existing.push(text)
        callsByJob.set(job.id, existing)
      }
      return {
        prompt: async (text) => record(text),
        session: stubAgentSession(async (text) => record(text)),
      }
    },
  }
}

describe('createCronConsumer', () => {
  test('logs correlated start and successful end lines with elapsed time', async () => {
    const stream = createStream()
    const info: string[] = []
    let time = 1_000
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({ prompt: async () => {} }),
      invokeHandler: async () => {
        time = 1_125
      },
      intervalNow: () => time,
      logger: { ...silentLogger, info: (message) => info.push(message) },
    })
    consumer.start()

    publishCron(stream, handlerJob('observed-success'))
    await waitForConsumerIdle(consumer)

    expect(info).toHaveLength(2)
    const fireId = info[0]?.match(/fire_id=(\S+)/)?.[1]
    expect(fireId).toBeTruthy()
    expect(info[0]).toBe(`[cron] observed-success: run started fire_id=${fireId}`)
    expect(info[1]).toBe(`[cron] observed-success: run ended fire_id=${fireId} outcome=success elapsed_ms=125`)

    consumer.stop()
  })

  test('logs a failed end line when dispatch throws', async () => {
    const stream = createStream()
    const info: string[] = []
    let time = 2_000
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({ prompt: async () => {} }),
      invokeHandler: async () => {
        time = 2_075
        throw new Error('synthetic failure')
      },
      intervalNow: () => time,
      logger: { ...silentLogger, info: (message) => info.push(message) },
    })
    consumer.start()

    publishCron(stream, handlerJob('observed-failure'))
    await waitForConsumerIdle(consumer)

    expect(info).toHaveLength(2)
    const fireId = info[0]?.match(/fire_id=(\S+)/)?.[1]
    expect(fireId).toBeTruthy()
    expect(info[1]).toBe(`[cron] observed-failure: run ended fire_id=${fireId} outcome=failed elapsed_ms=75`)

    consumer.stop()
  })

  test('logs the blocking fire id and active duration for an overlapping skip', async () => {
    const stream = createStream()
    const info: string[] = []
    const warnings: string[] = []
    let time = 3_000
    let release: (() => void) | undefined
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({ prompt: async () => {} }),
      invokeHandler: async () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      intervalNow: () => time,
      logger: {
        ...silentLogger,
        info: (message) => info.push(message),
        warn: (message) => warnings.push(message),
      },
    })
    consumer.start()

    const job = handlerJob('observed-overlap')
    publishCron(stream, job)
    await new Promise((resolve) => setImmediate(resolve))
    time = 3_250
    publishCron(stream, job)
    await new Promise((resolve) => setImmediate(resolve))

    const blockingFireId = info[0]?.match(/fire_id=(\S+)/)?.[1]
    expect(blockingFireId).toBeTruthy()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('previous run still in progress, skipping')
    expect(warnings[0]).toContain(`blocking_fire_id=${blockingFireId}`)
    expect(warnings[0]).toContain('active_for_ms=250')

    release?.()
    await waitForConsumerIdle(consumer)
    consumer.stop()
  })

  test('releases the in-flight reservation when the completion logger throws', async () => {
    const stream = createStream()
    let runs = 0
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({ prompt: async () => {} }),
      invokeHandler: async () => {
        runs++
      },
      logger: {
        ...silentLogger,
        info: (message) => {
          if (message.includes('run ended')) throw new Error('synthetic logger failure')
        },
      },
    })
    consumer.start()

    const job = handlerJob('throwing-logger')
    publishCron(stream, job)
    await waitForConsumerIdle(consumer)
    publishCron(stream, job)
    await waitForConsumerIdle(consumer)

    expect(runs).toBe(2)

    consumer.stop()
  })

  test('dispatches a prompt job to createSessionForCron and forwards the prompt text', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, promptJob('greet', 'say hi'))
    await new Promise((r) => setImmediate(r))

    expect(factory.callsByJob.get('greet')).toEqual([expect.stringContaining('say hi'), CRON_COMPLETION_CHECK_PROMPT])

    consumer.stop()
  })

  test('dispatches an exec job and runs the configured command in cwd', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, execJob('touch', [process.execPath, '-e', 'await Bun.write("out.txt", "hello")']))
    const contents = await waitForFile(join(root, 'out.txt'))
    await waitForConsumerIdle(consumer)

    expect(contents.trim()).toBe('hello')

    consumer.stop()
  })

  test.skipIf(process.platform !== 'linux')(
    'exec job and its grandchild inherit OOM priority without raising the runtime',
    async () => {
      const stream = createStream()
      const consumer = createCronConsumer({
        stream,
        cwd: root,
        createSessionForCron: makeFakeSessionFactory().createSessionForCron,
        logger: silentLogger,
      })
      consumer.start()
      try {
        const before = (await Bun.file('/proc/self/oom_score_adj').text()).trim()
        publishCron(
          stream,
          execJob('score', [
            '/bin/sh',
            '-c',
            // Publish both lines atomically: waitForFile returns as soon as the file exists.
            '{ cat /proc/self/oom_score_adj; /bin/sh -c "cat /proc/self/oom_score_adj"; } > score.tmp && mv score.tmp score.txt',
          ]),
        )
        const scores = await waitForFile(join(root, 'score.txt'))
        await waitForConsumerIdle(consumer)
        expect(scores.trim().split('\n')).toEqual(['600', '600'])
        expect((await Bun.file('/proc/self/oom_score_adj').text()).trim()).toBe(before)
      } finally {
        consumer.stop()
      }
    },
  )

  test('exec job spawn injects TYPECLAW_PARENT_ORIGIN_JSON describing the cron job', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    const job: ExecJob = {
      id: 'nightly-checks',
      schedule: '* * * * *',
      enabled: true,
      kind: 'exec',
      command: [
        process.execPath,
        '-e',
        'await Bun.write("origin.json", process.env.TYPECLAW_PARENT_ORIGIN_JSON ?? "")',
      ],
      scheduledByRole: 'member',
    }
    publishCron(stream, job)
    const captured = await waitForFile(join(root, 'origin.json'))
    await waitForConsumerIdle(consumer)

    const parsed = JSON.parse(captured) as { kind?: string; jobId?: string; scheduledByRole?: string }
    expect(parsed.kind).toBe('cron')
    expect(parsed.jobId).toBe('nightly-checks')
    expect(parsed.scheduledByRole).toBe('member')

    consumer.stop()
  })

  test('exec job runs with the per-fire env lease and releases it after the process exits', async () => {
    // given
    const stream = createStream()
    const leases: Array<{ jobId: string; role: string | undefined; fireId: string }> = []
    const released: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: makeFakeSessionFactory().createSessionForCron,
      execEnv: async (origin, fireId) => {
        leases.push({ jobId: origin.jobId, role: origin.scheduledByRole, fireId })
        return {
          env: { CRON_LEASE_VALUE: `lease-${fireId}` },
          release: async () => {
            released.push(fireId)
          },
        }
      },
      logger: silentLogger,
    })
    consumer.start()

    // when
    publishCron(stream, {
      ...execJob('leased', [
        process.execPath,
        '-e',
        'await Bun.write("lease.txt", process.env.CRON_LEASE_VALUE ?? "")',
      ]),
      scheduledByRole: 'member',
    })
    const contents = await waitForFile(join(root, 'lease.txt'))
    await waitForConsumerIdle(consumer)

    // then
    expect(leases).toEqual([{ jobId: 'leased', role: 'member', fireId: expect.any(String) }])
    expect(contents).toBe(`lease-${leases[0]!.fireId}`)
    expect(released).toEqual([leases[0]!.fireId])

    consumer.stop()
  })

  test('exec job still runs when its env lease cannot be prepared', async () => {
    const stream = createStream()
    const warnings: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: makeFakeSessionFactory().createSessionForCron,
      execEnv: async () => {
        throw new Error('vault daemon unreachable')
      },
      logger: { ...silentLogger, warn: (m) => warnings.push(m) },
    })
    consumer.start()

    publishCron(stream, execJob('unleased', [process.execPath, '-e', 'await Bun.write("ran.txt", "ok")']))
    const contents = await waitForFile(join(root, 'ran.txt'))
    await waitForConsumerIdle(consumer)

    expect(contents).toBe('ok')
    expect(warnings.some((w) => w.includes('vault daemon unreachable'))).toBe(true)

    consumer.stop()
  })

  test('exec job exiting non-zero is logged but does not crash the consumer', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const errors: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    consumer.start()

    publishCron(stream, execJob('fail', [process.execPath, '-e', 'process.exit(3)']))
    await waitForCondition(() => errors.some((e) => /exited with code 3/.test(e)))

    expect(errors.some((e) => /exited with code 3/.test(e))).toBe(true)

    publishCron(stream, execJob('after', [process.execPath, '-e', 'await Bun.write("after.txt", "ok")']))
    const contents = await waitForFile(join(root, 'after.txt'))
    await waitForConsumerIdle(consumer)

    expect(contents.trim()).toBe('ok')

    consumer.stop()
  })

  test('exec job with empty command array fails with a clear error', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const errors: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    consumer.start()

    publishCron(stream, { id: 'empty', schedule: '* * * * *', enabled: true, kind: 'exec', command: [] } as ExecJob)
    await new Promise((r) => setTimeout(r, 20))

    expect(errors.some((e) => /empty command/.test(e))).toBe(true)

    consumer.stop()
  })

  test('coalesces a second fire for the same jobId while the first is in flight', async () => {
    const stream = createStream()
    const calls: string[] = []
    const releaseBox: { fn: (() => void) | null } = { fn: null }
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async (job) => ({
        prompt: async (text) => {
          if (text === CRON_COMPLETION_CHECK_PROMPT) return
          calls.push(`${job.id}:${text}`)
          await new Promise<void>((resolve) => {
            releaseBox.fn = resolve
          })
        },
      }),
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, promptJob('slow', 'first'))
    await new Promise((r) => setImmediate(r))
    publishCron(stream, promptJob('slow', 'second'))
    await new Promise((r) => setImmediate(r))

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('slow:')
    expect(calls[0]).toContain('first')
    expect(consumer.inFlightCount()).toBe(1)

    releaseBox.fn?.()
    await new Promise((r) => setImmediate(r))

    publishCron(stream, promptJob('slow', 'third'))
    await new Promise((r) => setImmediate(r))

    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.some((c) => c.startsWith('slow:') && c.includes('third'))).toBe(true)

    consumer.stop()
  })

  test('different jobIds run concurrently — coalescing is per-job, not global', async () => {
    const stream = createStream()
    const released = new Set<string>()
    const releases: { a: (() => void) | null; b: (() => void) | null } = { a: null, b: null }
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async (job) => ({
        prompt: async () => {
          await new Promise<void>((resolve) => {
            if (job.id === 'a')
              releases.a = () => {
                released.add('a')
                resolve()
              }
            if (job.id === 'b')
              releases.b = () => {
                released.add('b')
                resolve()
              }
          })
        },
      }),
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, promptJob('a', 'go-a'))
    publishCron(stream, promptJob('b', 'go-b'))
    await new Promise((r) => setImmediate(r))

    expect(consumer.inFlightCount()).toBe(2)

    releases.a?.()
    releases.b?.()
    await new Promise((r) => setImmediate(r))
    expect(released).toEqual(new Set(['a', 'b']))

    consumer.stop()
  })

  test('an in-flight job survives cleanly even after stop() is called', async () => {
    const stream = createStream()
    const releaseBox: { fn: (() => void) | null } = { fn: null }
    let completed = false
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({
        prompt: async () => {
          await new Promise<void>((resolve) => {
            releaseBox.fn = resolve
          })
          completed = true
        },
      }),
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, promptJob('long', 'wait'))
    await new Promise((r) => setImmediate(r))
    expect(consumer.inFlightCount()).toBe(1)

    consumer.stop()
    releaseBox.fn?.()
    await new Promise((r) => setImmediate(r))

    expect(completed).toBe(true)
  })

  test('after stop(), new published cron messages are ignored', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()
    consumer.stop()

    publishCron(stream, promptJob('lost', 'no-one-home'))
    await new Promise((r) => setImmediate(r))

    expect(factory.callsByJob.size).toBe(0)
  })

  test('start() is idempotent', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()
    consumer.start()

    publishCron(stream, promptJob('once', 'hi'))
    await new Promise((r) => setImmediate(r))

    expect(factory.callsByJob.get('once')).toEqual([expect.stringContaining('hi'), CRON_COMPLETION_CHECK_PROMPT])

    consumer.stop()
  })

  test('ignores cron messages with malformed payloads', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const warnings: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: { ...silentLogger, warn: (m) => warnings.push(m) },
    })
    consumer.start()

    stream.publish({ target: { kind: 'cron', jobId: 'bogus' }, payload: { wrong: true } })
    await new Promise((r) => setImmediate(r))

    expect(warnings.some((w) => /invalid payload/.test(w))).toBe(true)
    expect(factory.callsByJob.size).toBe(0)

    consumer.stop()
  })

  test('a prompt job with a subagent field publishes a new-session message instead of running the prompt', async () => {
    // given
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const newSessionMessages: Array<{ subagent: string; payload: unknown }> = []
    stream.subscribe({ target: { kind: 'new-session' } }, (msg) => {
      const target = msg.target as { kind: 'new-session'; subagent: string }
      newSessionMessages.push({ subagent: target.subagent, payload: msg.payload })
    })
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    // when
    publishCron(stream, {
      id: 'sub-job',
      schedule: '* * * * *',
      enabled: true,
      kind: 'prompt',
      prompt: 'fallback user prompt',
      subagent: 'dreaming',
      payload: { agentDir: '/some/path' },
    })
    await new Promise((r) => setImmediate(r))

    // then
    expect(newSessionMessages).toEqual([{ subagent: 'dreaming', payload: { agentDir: '/some/path' } }])
    expect(factory.callsByJob.size).toBe(0)

    consumer.stop()
  })

  test('a prompt job without a subagent runs createSessionForCron and never publishes new-session', async () => {
    // given
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const newSessionMessages: unknown[] = []
    stream.subscribe({ target: { kind: 'new-session' } }, (msg) => newSessionMessages.push(msg))
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    // when
    publishCron(stream, promptJob('plain', 'hello'))
    await new Promise((r) => setImmediate(r))

    // then
    expect(factory.callsByJob.get('plain')).toEqual([expect.stringContaining('hello'), CRON_COMPLETION_CHECK_PROMPT])
    expect(newSessionMessages).toEqual([])

    consumer.stop()
  })

  test('does not consume non-cron-targeted messages', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    stream.publish({ target: { kind: 'broadcast' }, payload: promptJob('would-not-run', 'x') })
    stream.publish({
      target: { kind: 'session', sessionId: 'sess-1' },
      payload: promptJob('also-not', 'x'),
    })
    await new Promise((r) => setImmediate(r))

    expect(factory.callsByJob.size).toBe(0)

    consumer.stop()
  })

  test('fires session.idle and session.end on the supplied HookBus around each prompt run', async () => {
    // given
    const stream = createStream()
    const events: string[] = []
    const hooks = fakeHooks(events)
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({
        prompt: async (text: string) => {
          events.push(`prompt:${text}`)
        },
        hooks,
        sessionId: 'cron-sess-1',
        getTranscriptPath: () => '/tmp/transcript-1.jsonl',
      }),
      logger: silentLogger,
    })
    consumer.start()

    // when
    publishCron(stream, promptJob('hooked', 'do work'))
    await new Promise((r) => setImmediate(r))

    // then
    expect(events).toHaveLength(4)
    expect(events[0]).toStartWith('prompt:')
    expect(events[0]).toContain('do work')
    expect(events[1]).toBe(`prompt:${CRON_COMPLETION_CHECK_PROMPT}`)
    expect(events[2]).toBe('idle:cron-sess-1:/tmp/transcript-1.jsonl')
    expect(events[3]).toBe('end:cron-sess-1')

    consumer.stop()
  })

  test('appends retrievalContext.results from session.turn.start to the cron prompt text', async () => {
    // given: a hook that injects per-turn memory (as the vector memory plugin does)
    const stream = createStream()
    const events: string[] = []
    const hooks = fakeHooks(events)
    hooks.runSessionTurnStart = async (e) => {
      if (e.retrievalContext !== undefined) e.retrievalContext.results = '# Memory\n\nremembered fact'
    }
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({
        prompt: async (text: string) => {
          events.push(`prompt:${text}`)
        },
        hooks,
        sessionId: 'cron-sess-mem',
        agentDir: '/agent',
        getTranscriptPath: () => '/tmp/transcript-mem.jsonl',
      }),
      logger: silentLogger,
    })
    consumer.start()

    // when
    publishCron(stream, promptJob('mem-job', 'do work'))
    await new Promise((r) => setImmediate(r))

    // then: the prompt carries both the user text and the injected memory block
    const promptEvent = events.find((e) => e.startsWith('prompt:'))
    expect(promptEvent).toContain('do work')
    expect(promptEvent).toContain('# Memory\n\nremembered fact')

    consumer.stop()
  })

  test('fires session.end even when prompt throws so plugins can react to abnormal termination', async () => {
    // given
    const stream = createStream()
    const events: string[] = []
    const hooks = fakeHooks(events)
    const errors: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({
        prompt: async () => {
          throw new Error('llm down')
        },
        hooks,
        sessionId: 'cron-boom',
      }),
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    consumer.start()

    // when
    publishCron(stream, promptJob('boom', 'go'))
    await new Promise((r) => setImmediate(r))

    // then
    expect(events).toEqual(['end:cron-boom'])
    expect(errors.some((e) => /llm down/.test(e))).toBe(true)

    consumer.stop()
  })

  test('logs LLM soft errors (stopReason=error encoded in message_end) so `typeclaw logs` surfaces them', async () => {
    // given: a fake CronSession whose .session emits a message_end with
    // stopReason=error during prompt(), simulating a billing/rate-limit
    // failure from pi-coding-agent that resolves normally instead of throwing.
    const stream = createStream()
    const errors: string[] = []
    type Listener = (event: { type: string; message?: unknown }) => void
    const listeners = new Set<Listener>()
    const fakeAgentSession = {
      subscribe: (cb: Listener) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    } as unknown as import('@/agent').AgentSession

    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({
        prompt: async () => {
          for (const cb of listeners) {
            cb({
              type: 'message_end',
              message: {
                role: 'assistant',
                stopReason: 'error',
                errorMessage: 'rate limit exceeded',
              },
            })
          }
        },
        session: fakeAgentSession,
      }),
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    consumer.start()

    // when
    publishCron(stream, promptJob('soft-err', 'go'))
    await new Promise((r) => setImmediate(r))

    // then
    expect(errors.some((e) => /\[cron\] soft-err:.*rate limit exceeded/.test(e))).toBe(true)

    consumer.stop()
  })

  test('does not log when .session is omitted (test fakes that only need prompt keep working)', async () => {
    // given
    const stream = createStream()
    const errors: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({
        prompt: async () => {},
      }),
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    consumer.start()

    // when
    publishCron(stream, promptJob('no-session', 'go'))
    await new Promise((r) => setImmediate(r))

    // then
    expect(errors).toEqual([])

    consumer.stop()
  })

  test('dispatches a handler job through invokeHandler', async () => {
    // given
    const stream = createStream()
    const seen: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({ prompt: async () => {} }),
      invokeHandler: async (job) => {
        seen.push(job.id)
      },
      logger: silentLogger,
    })
    consumer.start()

    // when
    const handlerJob: CronJob = {
      id: 'inbox-watch',
      schedule: '* * * * *',
      enabled: true,
      kind: 'handler',
      handler: async () => {},
      scheduledByRole: 'owner',
    }
    publishCron(stream, handlerJob)
    await new Promise((r) => setImmediate(r))

    // then
    expect(seen).toEqual(['inbox-watch'])

    consumer.stop()
  })

  test('handler job errors are caught and logged, not propagated', async () => {
    // given
    const stream = createStream()
    const errors: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({ prompt: async () => {} }),
      invokeHandler: async () => {
        throw new Error('handler exploded')
      },
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    consumer.start()

    // when
    const handlerJob: CronJob = {
      id: 'broken',
      schedule: '* * * * *',
      enabled: true,
      kind: 'handler',
      handler: async () => {
        throw new Error('handler exploded')
      },
      scheduledByRole: 'owner',
    }
    publishCron(stream, handlerJob)
    await new Promise((r) => setImmediate(r))

    // then
    expect(errors).toEqual([expect.stringContaining('broken failed: handler exploded')])

    consumer.stop()
  })

  test('handler job dispatched without invokeHandler logs a precise error', async () => {
    // given
    const stream = createStream()
    const errors: string[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({ prompt: async () => {} }),
      logger: { ...silentLogger, error: (m) => errors.push(m) },
    })
    consumer.start()

    // when
    const handlerJob: CronJob = {
      id: 'orphan',
      schedule: '* * * * *',
      enabled: true,
      kind: 'handler',
      handler: async () => {},
      scheduledByRole: 'owner',
    }
    publishCron(stream, handlerJob)
    await new Promise((r) => setImmediate(r))

    // then
    expect(errors).toEqual([expect.stringContaining('no invokeHandler wired')])

    consumer.stop()
  })

  test('handler jobs respect in-flight coalescing keyed by jobId', async () => {
    // given
    const stream = createStream()
    const warns: string[] = []
    const resolvers: (() => void)[] = []
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: async () => ({ prompt: async () => {} }),
      invokeHandler: async () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve)
        }),
      logger: { ...silentLogger, warn: (m) => warns.push(m) },
    })
    consumer.start()

    // when - first publish blocks; second arrives before first resolves
    const handlerJob: CronJob = {
      id: 'busy',
      schedule: '* * * * *',
      enabled: true,
      kind: 'handler',
      handler: async () => {},
      scheduledByRole: 'owner',
    }
    publishCron(stream, handlerJob)
    await new Promise((r) => setImmediate(r))
    publishCron(stream, handlerJob)
    await new Promise((r) => setImmediate(r))

    // then
    expect(warns).toEqual([expect.stringContaining('busy: previous run still in progress, skipping')])

    for (const r of resolvers) r()
    consumer.stop()
  })
})

describe('createCronConsumer model fallback', () => {
  test('retries with the next ref when the first model throws, and the factory receives the override', async () => {
    // given: a multi-ref default chain on disk + reloaded into the live config
    const { writeFile } = await import('node:fs/promises')
    const { reloadConfig, __resetConfigForTesting } = await import('@/config/config')
    await writeFile(
      join(root, 'typeclaw.json'),
      JSON.stringify({
        models: {
          default: ['openai/gpt-5.4-nano', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'],
        },
      }),
    )
    reloadConfig(root)
    try {
      const stream = createStream()
      const calls: string[] = []
      const consumer = createCronConsumer({
        stream,
        cwd: root,
        createSessionForCron: async (job, ref) => {
          calls.push(`${job.id}:${ref}`)
          const fail = ref === 'openai/gpt-5.4-nano'
          return {
            prompt: async (text) => {
              if (fail) throw new Error(`provider error on ${ref}`)
              calls.push(`${job.id}:${ref}:ok:${text}`)
            },
            session: stubAgentSession(async (text) => {
              if (fail) throw new Error(`provider error on ${ref}`)
              calls.push(`${job.id}:${ref}:ok:${text}`)
            }),
          }
        },
        logger: silentLogger,
      })
      consumer.start()

      // when
      publishCron(stream, promptJob('fb', 'do thing'))
      await new Promise((r) => setImmediate(r))

      // then: the consumer called createSessionForCron once per ref in chain
      // order, and the second attempt's prompt was actually invoked
      expect(calls).toHaveLength(4)
      expect(calls[0]).toBe('fb:openai/gpt-5.4-nano')
      expect(calls[1]).toBe('fb:fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
      expect(calls[2]).toMatch(/^fb:fireworks\/accounts\/fireworks\/routers\/kimi-k2p6-turbo:ok:/)
      expect(calls[2]).toContain('do thing')
      // the completion check runs on the session that handled the turn
      expect(calls[3]).toBe(
        `fb:fireworks/accounts/fireworks/routers/kimi-k2p6-turbo:ok:${CRON_COMPLETION_CHECK_PROMPT}`,
      )

      consumer.stop()
    } finally {
      __resetConfigForTesting()
    }
  })

  test('logs final-attempt failure when every ref in the chain fails, and attempts every ref in order', async () => {
    // given
    const { writeFile } = await import('node:fs/promises')
    const { reloadConfig, __resetConfigForTesting } = await import('@/config/config')
    await writeFile(
      join(root, 'typeclaw.json'),
      JSON.stringify({
        models: {
          default: ['openai/gpt-5.4-nano', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'],
        },
      }),
    )
    reloadConfig(root)
    try {
      const stream = createStream()
      const errors: string[] = []
      const info: string[] = []
      const attempted: string[] = []
      const consumer = createCronConsumer({
        stream,
        cwd: root,
        createSessionForCron: async (_job, ref) => {
          attempted.push(ref!)
          return {
            prompt: async () => {
              throw new Error(`down: ${ref}`)
            },
            session: stubAgentSession(async () => {
              throw new Error(`down: ${ref}`)
            }),
          }
        },
        logger: { ...silentLogger, error: (m) => errors.push(m), info: (m) => info.push(m) },
      })
      consumer.start()

      // when
      publishCron(stream, promptJob('all-down', 'attempt'))
      await waitForConsumerIdle(consumer)

      // then
      expect(attempted).toEqual(['openai/gpt-5.4-nano', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'])
      expect(errors.some((e) => /all 2 model\(s\) failed/.test(e))).toBe(true)
      expect(errors.some((e) => /down: fireworks/.test(e))).toBe(true)
      expect(info.some((line) => /run ended .* outcome=failed elapsed_ms=\d+$/.test(line))).toBe(true)

      consumer.stop()
    } finally {
      __resetConfigForTesting()
    }
  })

  test('disposes the successful final session and fires session.end exactly once per attempted session', async () => {
    // given: a 2-ref chain where the first fails and the second succeeds.
    // We track disposal calls per session and assert that BOTH sessions get
    // their dispose+end hooks fired — without that, security plugin taint
    // state and memory plugin debounce timers would orphan for the failed
    // first attempt, and the successful session's resources would leak.
    const { writeFile } = await import('node:fs/promises')
    const { reloadConfig, __resetConfigForTesting } = await import('@/config/config')
    await writeFile(
      join(root, 'typeclaw.json'),
      JSON.stringify({
        models: {
          default: ['openai/gpt-5.4-nano', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'],
        },
      }),
    )
    reloadConfig(root)
    try {
      const stream = createStream()
      const events: string[] = []
      const consumer = createCronConsumer({
        stream,
        cwd: root,
        createSessionForCron: async (_job, ref) => {
          const fail = ref === 'openai/gpt-5.4-nano'
          const sessionId = `sess:${ref}`
          const hooks: HookBus = {
            ...createHookBus(),
            registerAll: () => {},
            unregisterAll: () => {},
            runSessionStart: async () => {},
            runSessionEnd: async (e) => {
              events.push(`end:${e.sessionId}`)
            },
            runSessionIdle: async (e) => {
              events.push(`idle:${e.sessionId}`)
            },
            runSessionPrompt: async () => {},
            runSessionTurnStart: async () => {},
            runSessionTurnEnd: async () => {},
            runToolBefore: async () => undefined,
            runToolAfter: async () => {},
            count: () => 0,
          }
          return {
            prompt: async () => {
              if (fail) throw new Error(`down on ${ref}`)
            },
            session: stubAgentSession(async () => {
              if (fail) throw new Error(`down on ${ref}`)
            }),
            hooks,
            sessionId,
            agentDir: '/agent',
            dispose: () => {
              events.push(`dispose:${sessionId}`)
            },
          }
        },
        logger: silentLogger,
      })
      consumer.start()

      // when
      publishCron(stream, promptJob('fb', 'go'))
      await new Promise((r) => setImmediate(r))

      // then: failed session gets end+dispose (no idle), successful session
      // gets idle+end+dispose, all in the right order
      expect(events).toEqual([
        'end:sess:openai/gpt-5.4-nano',
        'dispose:sess:openai/gpt-5.4-nano',
        'idle:sess:fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
        'end:sess:fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
        'dispose:sess:fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
      ])

      consumer.stop()
    } finally {
      __resetConfigForTesting()
    }
  })
})

function fakeCountStore(): {
  get: (id: string, job: CronJob) => number
  increment: (id: string, job: CronJob, at: number) => Promise<boolean>
  counts: Map<string, number>
  inactive: Set<string>
} {
  const counts = new Map<string, number>()
  // ids the test has marked as no longer live: increment returns false (dropped)
  // and does not count, mirroring a job removed/replaced during the await.
  const inactive = new Set<string>()
  return {
    counts,
    inactive,
    get: (id) => counts.get(id) ?? 0,
    increment: async (id) => {
      if (inactive.has(id)) return false
      counts.set(id, (counts.get(id) ?? 0) + 1)
      return true
    },
  }
}

const countedPromptJob = (id: string, count: number): PromptJob => ({
  id,
  schedule: '* * * * *',
  enabled: true,
  kind: 'prompt',
  prompt: `run ${id}`,
  count,
})

describe('createCronConsumer count gate', () => {
  test('increments the durable count for an accepted run', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const countStore = fakeCountStore()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      countStore,
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, countedPromptJob('limited', 3))
    await new Promise((r) => setImmediate(r))

    expect(countStore.counts.get('limited')).toBe(1)

    consumer.stop()
  })

  test('skips and does NOT increment once the count boundary is reached', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const countStore = fakeCountStore()
    countStore.counts.set('limited', 3)
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      countStore,
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, countedPromptJob('limited', 3))
    await new Promise((r) => setImmediate(r))

    expect(countStore.counts.get('limited')).toBe(3)
    expect(factory.callsByJob.get('limited')).toBeUndefined()

    consumer.stop()
  })

  test('a coalesced (in-flight) fire does NOT consume a count', async () => {
    const stream = createStream()
    const countStore = fakeCountStore()
    // Hold the first run open so the second publish coalesces against it.
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const createSessionForCron = async (): Promise<CronSession> => ({
      prompt: async () => {
        await gate
      },
      session: stubAgentSession(),
    })
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron,
      countStore,
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, countedPromptJob('limited', 5))
    await new Promise((r) => setImmediate(r))
    // second fire while the first is still in flight -> coalesced skip
    publishCron(stream, countedPromptJob('limited', 5))
    await new Promise((r) => setImmediate(r))

    expect(countStore.counts.get('limited')).toBe(1)

    release?.()
    consumer.stop()
  })

  test('does NOT dispatch when increment reports the job is no longer live', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const countStore = fakeCountStore()
    // job removed/replaced while the durable increment was awaiting
    countStore.inactive.add('limited')
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      countStore,
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, countedPromptJob('limited', 3))
    await new Promise((r) => setImmediate(r))

    expect(countStore.counts.get('limited')).toBeUndefined()
    expect(factory.callsByJob.get('limited')).toBeUndefined()

    consumer.stop()
  })

  describe('attention escalation', () => {
    function thinkingTrackingSession(levels: string[], sessionDefault: 'low' | 'medium'): AgentSession {
      return {
        subscribe: () => () => {},
        prompt: async () => {},
        thinkingLevel: sessionDefault,
        setThinkingLevel: (level: string) => {
          levels.push(level)
        },
      } as unknown as AgentSession
    }

    test('bumps thinking level to xhigh on an escalation prompt and to the default otherwise', async () => {
      const levelsByJob = new Map<string, string[]>()
      const factory = {
        createSessionForCron: async (job: PromptJob): Promise<CronSession> => {
          const levels: string[] = []
          levelsByJob.set(job.id, levels)
          return {
            prompt: async () => {},
            session: thinkingTrackingSession(levels, 'low'),
          }
        },
      }
      const stream = createStream()
      const consumer = createCronConsumer({
        stream,
        cwd: root,
        createSessionForCron: factory.createSessionForCron,
        logger: silentLogger,
      })
      consumer.start()

      publishCron(stream, promptJob('frustrated', '제대로 해'))
      publishCron(stream, promptJob('routine', 'post the daily summary'))
      await waitForConsumerIdle(consumer)

      expect(levelsByJob.get('frustrated')).toEqual(['xhigh'])
      expect(levelsByJob.get('routine')).toEqual(['low'])

      consumer.stop()
    })
  })
})

// Signals the first registry read after `arm()`: the drain's whole first
// iteration (expire, collect, running check, wait setup) is synchronous, so a
// test resuming on this signal observes the drain parked on its wakeup.
class ObservedRegistry extends LiveSubagentRegistry {
  private onRead: (() => void) | undefined
  arm(): Promise<void> {
    const read = Promise.withResolvers<void>()
    this.onRead = () => {
      this.onRead = undefined
      read.resolve()
    }
    return read.promise
  }
  override list(...args: Parameters<LiveSubagentRegistry['list']>): ReturnType<LiveSubagentRegistry['list']> {
    this.onRead?.()
    return super.list(...args)
  }
}

function registerBackgroundChild(registry: LiveSubagentRegistry, parentSessionId: string): void {
  registry.register({
    taskId: 'bg_child',
    sessionId: 'ses_child',
    subagentName: 'browser',
    parentSessionId,
    background: true,
    startedAt: Date.now(),
    status: 'running',
    abort: async () => {},
  })
}

function completeBackgroundChild(
  stream: ReturnType<typeof createStream>,
  registry: LiveSubagentRegistry,
  parentSessionId: string,
): void {
  registry.recordCompletion('bg_child', { ok: true, durationMs: 5 })
  stream.publish({
    target: { kind: 'broadcast' },
    payload: {
      kind: 'subagent.completed',
      taskId: 'bg_child',
      subagent: 'browser',
      parentSessionId,
      ok: true,
      durationMs: 5,
    },
  })
}

describe('createCronConsumer background subagents', () => {
  test('keeps the session live while a background child runs, then delivers its completion before disposing', async () => {
    // given: a cron turn that spawns a background child and ends while it still runs
    const stream = createStream()
    const liveRegistry = new ObservedRegistry()
    const sessionId = 'ses_cron'
    const prompts: string[] = []
    const events: string[] = []
    // Nothing reads the registry before the drain's first iteration.
    const drainParked = liveRegistry.arm()
    const disposal = Promise.withResolvers<void>()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      logger: silentLogger,
      createSessionForCron: async () => ({
        prompt: async (text) => {
          prompts.push(text)
          if (prompts.length > 1) return
          registerBackgroundChild(liveRegistry, sessionId)
        },
        dispose: () => {
          events.push('dispose')
          disposal.resolve()
        },
        backgroundDrain: { stream, sessionId, liveRegistry },
      }),
    })
    consumer.start()
    publishCron(stream, promptJob('drain', 'check the results'))
    await drainParked

    // then: the turn has settled, but the session is live and the fire still in flight
    expect(prompts).toHaveLength(1)
    expect(events).toEqual([])
    expect(consumer.inFlightCount()).toBe(1)

    // when: the child completes
    completeBackgroundChild(stream, liveRegistry, sessionId)
    await disposal.promise

    // then: the session got the completion reminder, then the completion check, before it was disposed
    expect(prompts).toHaveLength(3)
    expect(prompts[1]).toContain('bg_child')
    expect(prompts[2]).toBe(CRON_COMPLETION_CHECK_PROMPT)
    expect(events).toEqual(['dispose'])
  })

  test('a background child the completion check spawns is drained before the session is disposed', async () => {
    // given: the job turn spawns nothing; the completion check turn spawns a background child
    const stream = createStream()
    const liveRegistry = new LiveSubagentRegistry()
    const sessionId = 'ses_cron'
    const prompts: string[] = []
    const disposal = Promise.withResolvers<void>()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      logger: silentLogger,
      createSessionForCron: async () => ({
        prompt: async (text) => {
          prompts.push(text)
          if (text !== CRON_COMPLETION_CHECK_PROMPT) return
          registerBackgroundChild(liveRegistry, sessionId)
          completeBackgroundChild(stream, liveRegistry, sessionId)
        },
        dispose: () => disposal.resolve(),
        backgroundDrain: { stream, sessionId, liveRegistry },
      }),
    })
    consumer.start()

    // when
    publishCron(stream, promptJob('check-spawns', 'retry the export'))
    await disposal.promise

    // then: the child's completion reached the session after the check and before disposal
    expect(prompts).toHaveLength(3)
    expect(prompts[1]).toBe(CRON_COMPLETION_CHECK_PROMPT)
    expect(prompts[2]).toContain('bg_child')
  })

  test('a failed completion check turn is logged and does not fail a run whose own turn succeeded', async () => {
    // given: the job turn succeeds and only the completion check throws
    const stream = createStream()
    const info: string[] = []
    const warnings: string[] = []
    const runEnded = Promise.withResolvers<void>()
    let disposed = false
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      logger: {
        ...silentLogger,
        info: (m) => {
          info.push(m)
          if (m.includes('run ended')) runEnded.resolve()
        },
        warn: (m) => warnings.push(m),
      },
      createSessionForCron: async () => ({
        prompt: async (text) => {
          if (text === CRON_COMPLETION_CHECK_PROMPT) throw new Error('provider overloaded')
        },
        dispose: () => {
          disposed = true
        },
      }),
    })
    consumer.start()

    // when
    publishCron(stream, promptJob('check-fails', 'send the digest'))
    await runEnded.promise

    // then
    expect(info.at(-1)).toContain('outcome=success')
    expect(warnings.some((w) => w.includes('completion check turn failed') && w.includes('provider overloaded'))).toBe(
      true,
    )
    expect(disposed).toBe(true)
  })

  test('a provider soft error on the reminder turn fails the cron run and still disposes the session', async () => {
    // given: the initial turn succeeds and leaves a completed background child;
    // only the reminder turn ends in a soft provider error
    const stream = createStream()
    const liveRegistry = new LiveSubagentRegistry()
    const sessionId = 'ses_cron'
    const info: string[] = []
    const errors: string[] = []
    const runEnded = Promise.withResolvers<void>()
    let disposed = false
    type Listener = (event: { type: string; message?: unknown }) => void
    const listeners = new Set<Listener>()
    const agentSession = {
      subscribe: (cb: Listener) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      prompt: async () => {
        for (const cb of listeners) {
          cb({
            type: 'message_end',
            message: { role: 'assistant', stopReason: 'error', errorMessage: 'insufficient credits' },
          })
        }
      },
    } as unknown as AgentSession
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      logger: {
        ...silentLogger,
        info: (m) => {
          info.push(m)
          if (m.includes('run ended')) runEnded.resolve()
        },
        error: (m) => errors.push(m),
      },
      createSessionForCron: async () => ({
        prompt: async () => {
          registerBackgroundChild(liveRegistry, sessionId)
          completeBackgroundChild(stream, liveRegistry, sessionId)
        },
        dispose: () => {
          disposed = true
        },
        session: agentSession,
        backgroundDrain: { stream, sessionId, liveRegistry },
      }),
    })
    consumer.start()

    // when
    publishCron(stream, promptJob('reminder-fails', 'check the results'))
    await runEnded.promise

    // then
    expect(info.at(-1)).toContain('outcome=failed')
    expect(errors.some((e) => e.includes('reminder turn failed') && e.includes('insufficient credits'))).toBe(true)
    expect(disposed).toBe(true)
  })
})
