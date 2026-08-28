import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentSession } from '@/agent'
import type { HookBus } from '@/plugin'
import { createStream } from '@/stream'

import { createCronConsumer, type CronConsumerClock, type CronConsumerLogger, type CronSession } from './consumer'
import type { CronJob, ExecJob, PromptJob } from './schema'

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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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

const promptJob = (id: string, prompt: string, overrides: Partial<PromptJob> = {}): PromptJob => ({
  id,
  schedule: '* * * * *',
  enabled: true,
  kind: 'prompt',
  prompt,
  ...overrides,
})

const execJob = (id: string, command: string[]): ExecJob => ({
  id,
  schedule: '* * * * *',
  enabled: true,
  kind: 'exec',
  command,
})

function publishCron(stream: ReturnType<typeof createStream>, job: CronJob): string {
  return stream.publish({ target: { kind: 'cron', jobId: job.id }, payload: job })
}

function createFakeClock(start = 1_000): CronConsumerClock & { advance: (ms: number) => Promise<void> } {
  let now = start
  let nextHandle = 1
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => now,
    setTimeout: (callback, ms) => {
      const handle = nextHandle++
      timers.set(handle, { at: now + ms, callback })
      return handle
    },
    clearTimeout: (handle) => {
      timers.delete(handle)
    },
    advance: async (ms) => {
      const target = now + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort(([, a], [, b]) => a.at - b.at)[0]
        if (due === undefined) break
        const [handle, timer] = due
        timers.delete(handle)
        now = timer.at
        timer.callback()
        await new Promise((resolve) => setImmediate(resolve))
      }
      now = target
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
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

    expect(factory.callsByJob.get('greet')).toEqual([expect.stringContaining('say hi')])

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

  test('bounds a hung occurrence and allows the next occurrence of that job to run', async () => {
    const stream = createStream()
    const clock = createFakeClock()
    const infos: string[] = []
    let calls = 0
    let disposals = 0
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      clock,
      createSessionForCron: async () => {
        calls += 1
        if (calls === 1) {
          return {
            prompt: async () => new Promise<void>(() => {}),
            dispose: () => {
              disposals += 1
            },
          }
        }
        return { prompt: async () => {} }
      },
      logger: { ...silentLogger, info: (message) => infos.push(message) },
    })
    consumer.start()
    const job = promptJob('bounded', 'run', { timeoutMs: 100 })

    publishCron(stream, job)
    await new Promise((resolve) => setImmediate(resolve))
    await clock.advance(100)
    expect(consumer.inFlightCount()).toBe(0)
    expect(disposals).toBe(1)

    publishCron(stream, job)
    await waitForConsumerIdle(consumer)

    expect(calls).toBe(2)
    expect(infos.some((line) => /run-start fire_id=/.test(line))).toBe(true)
    expect(infos.some((line) => /run-end .*elapsed_ms=100 outcome=timeout/.test(line))).toBe(true)
    expect(infos.some((line) => /run-end .*outcome=success/.test(line))).toBe(true)
    consumer.stop()
  })

  test('does not prompt a session whose creation finishes after the occurrence deadline', async () => {
    const stream = createStream()
    const clock = createFakeClock()
    let finishCreation: ((session: CronSession) => void) | undefined
    let prompts = 0
    let disposals = 0
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      clock,
      createSessionForCron: async () =>
        new Promise<CronSession>((resolve) => {
          finishCreation = resolve
        }),
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, promptJob('slow-create', 'run', { timeoutMs: 100 }))
    await new Promise((resolve) => setImmediate(resolve))
    await clock.advance(100)
    finishCreation?.({
      prompt: async () => {
        prompts += 1
      },
      dispose: () => {
        disposals += 1
      },
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(prompts).toBe(0)
    expect(disposals).toBe(1)
    consumer.stop()
  })

  test('does not prompt after a turn-start hook finishes past the occurrence deadline', async () => {
    const stream = createStream()
    const clock = createFakeClock()
    const hooks = fakeHooks([])
    let finishTurnStart: (() => void) | undefined
    let prompts = 0
    let disposals = 0
    hooks.runSessionTurnStart = async () =>
      new Promise<void>((resolve) => {
        finishTurnStart = resolve
      })
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      clock,
      createSessionForCron: async () => ({
        prompt: async () => {
          prompts += 1
        },
        hooks,
        sessionId: 'slow-hook-session',
        agentDir: root,
        dispose: () => {
          disposals += 1
        },
      }),
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, promptJob('slow-hook', 'run', { timeoutMs: 100 }))
    await new Promise((resolve) => setImmediate(resolve))
    await clock.advance(100)
    finishTurnStart?.()
    await new Promise((resolve) => setImmediate(resolve))

    expect(prompts).toBe(0)
    expect(disposals).toBe(1)
    consumer.stop()
  })

  test.skipIf(process.platform === 'win32')(
    'kills a timed-out exec process group after the abort grace period',
    async () => {
      const stream = createStream()
      const clock = createFakeClock()
      const consumer = createCronConsumer({
        stream,
        cwd: root,
        clock,
        createSessionForCron: makeFakeSessionFactory().createSessionForCron,
        logger: silentLogger,
      })
      consumer.start()
      const script = [
        'trap "" TERM',
        'echo $$ > parent.pid',
        `sh -c 'trap "" TERM; echo $$ > child.pid; while :; do sleep 1; done' &`,
        'wait',
      ].join('\n')

      publishCron(stream, { ...execJob('stubborn-tree', ['sh', '-c', script]), timeoutMs: 100 })
      const parentPid = Number((await waitForFile(join(root, 'parent.pid'))).trim())
      const childPid = Number((await waitForFile(join(root, 'child.pid'))).trim())
      await clock.advance(100)

      expect(consumer.inFlightCount()).toBe(0)
      expect(isProcessAlive(parentPid)).toBe(true)
      expect(isProcessAlive(childPid)).toBe(true)

      await clock.advance(5_000)
      await waitForCondition(() => !isProcessAlive(parentPid) && !isProcessAlive(childPid))

      consumer.stop()
    },
  )

  test.skipIf(process.platform === 'win32')(
    'keeps exec SIGKILL escalation when the parent exits but a resistant child survives',
    async () => {
      const stream = createStream()
      const clock = createFakeClock()
      const consumer = createCronConsumer({
        stream,
        cwd: root,
        clock,
        createSessionForCron: makeFakeSessionFactory().createSessionForCron,
        logger: silentLogger,
      })
      consumer.start()
      const script = [
        `const child = Bun.spawn({ cmd: ['sh', '-c', 'trap "" TERM; while :; do sleep 1; done'], stdout: 'ignore', stderr: 'ignore' })`,
        `await Bun.write('parent.pid', String(process.pid))`,
        `await Bun.write('child.pid', String(child.pid))`,
        `await child.exited`,
      ].join('; ')

      publishCron(stream, { ...execJob('exiting-parent', [process.execPath, '-e', script]), timeoutMs: 100 })
      const parentPid = Number((await waitForFile(join(root, 'parent.pid'))).trim())
      const childPid = Number((await waitForFile(join(root, 'child.pid'))).trim())
      await clock.advance(100)
      await waitForCondition(() => !isProcessAlive(parentPid))

      expect(isProcessAlive(childPid)).toBe(true)

      await clock.advance(5_000)
      await waitForCondition(() => !isProcessAlive(childPid))

      consumer.stop()
    },
  )

  test('does not time out a long occurrence that finishes within its configured deadline', async () => {
    const stream = createStream()
    const clock = createFakeClock()
    const infos: string[] = []
    let release: (() => void) | undefined
    let disposals = 0
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      clock,
      createSessionForCron: async () => ({
        prompt: async () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
        dispose: () => {
          disposals += 1
        },
      }),
      logger: { ...silentLogger, info: (message) => infos.push(message) },
    })
    consumer.start()

    publishCron(stream, promptJob('long-valid', 'run', { timeoutMs: 1_000 }))
    await new Promise((resolve) => setImmediate(resolve))
    await clock.advance(900)
    expect(consumer.inFlightCount()).toBe(1)
    expect(disposals).toBe(0)

    release?.()
    await waitForConsumerIdle(consumer)

    expect(disposals).toBe(1)
    expect(infos.some((line) => /run-end .*elapsed_ms=900 outcome=success/.test(line))).toBe(true)
    expect(infos.some((line) => /outcome=timeout/.test(line))).toBe(false)
    consumer.stop()
  })

  test('skip logs identify the blocking fire and how long it has been active', async () => {
    const stream = createStream()
    const clock = createFakeClock()
    const warnings: string[] = []
    let release: (() => void) | undefined
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      clock,
      createSessionForCron: async () => ({
        prompt: async () =>
          new Promise<void>((resolve) => {
            release = resolve
          }),
      }),
      logger: { ...silentLogger, warn: (message) => warnings.push(message) },
    })
    consumer.start()
    const job = promptJob('busy-observable', 'run')

    publishCron(stream, job)
    await new Promise((resolve) => setImmediate(resolve))
    await clock.advance(250)
    publishCron(stream, job)
    await new Promise((resolve) => setImmediate(resolve))

    expect(warnings).toEqual([
      expect.stringMatching(/busy-observable: previous run fire_id=.* active_for_ms=250, skipping/),
    ])
    release?.()
    await waitForConsumerIdle(consumer)
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

    expect(factory.callsByJob.get('once')).toEqual([expect.stringContaining('hi')])

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
    expect(factory.callsByJob.get('plain')).toEqual([expect.stringContaining('hello')])
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
    expect(events).toHaveLength(3)
    expect(events[0]).toStartWith('prompt:')
    expect(events[0]).toContain('do work')
    expect(events[1]).toBe('idle:cron-sess-1:/tmp/transcript-1.jsonl')
    expect(events[2]).toBe('end:cron-sess-1')

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
    expect(warns).toEqual([expect.stringMatching(/busy: previous run fire_id=.* active_for_ms=\d+, skipping/)])

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
      expect(calls).toHaveLength(3)
      expect(calls[0]).toBe('fb:openai/gpt-5.4-nano')
      expect(calls[1]).toBe('fb:fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
      expect(calls[2]).toMatch(/^fb:fireworks\/accounts\/fireworks\/routers\/kimi-k2p6-turbo:ok:/)
      expect(calls[2]).toContain('do thing')

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
      const infos: string[] = []
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
        logger: { ...silentLogger, info: (m) => infos.push(m), error: (m) => errors.push(m) },
      })
      consumer.start()

      // when
      publishCron(stream, promptJob('all-down', 'attempt'))
      await new Promise((r) => setImmediate(r))

      // then
      expect(attempted).toEqual(['openai/gpt-5.4-nano', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'])
      expect(errors.some((e) => /all 2 model\(s\) failed/.test(e))).toBe(true)
      expect(errors.some((e) => /down: fireworks/.test(e))).toBe(true)
      expect(infos.some((line) => /run-end .*outcome=failed/.test(line))).toBe(true)

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
