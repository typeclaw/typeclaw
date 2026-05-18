import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HookBus } from '@/plugin'
import { createStream } from '@/stream'

import {
  appendExecToPrompt,
  createCronConsumer,
  type CronConsumerLogger,
  type CronSession,
  type ExecResult,
  mergeExecIntoPayload,
  runExecForPrompt,
} from './consumer'
import type { CronJob, ExecJob, PromptJob } from './schema'

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
    createSessionForCron: async (job) => ({
      prompt: async (text) => {
        const existing = callsByJob.get(job.id) ?? []
        existing.push(text)
        callsByJob.set(job.id, existing)
      },
    }),
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

    expect(factory.callsByJob.get('greet')).toEqual(['say hi'])

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

    publishCron(stream, execJob('touch', ['sh', '-c', 'echo hello > out.txt']))
    await new Promise((r) => setTimeout(r, 50))

    const contents = await Bun.file(join(root, 'out.txt')).text()
    expect(contents.trim()).toBe('hello')

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

    publishCron(stream, execJob('fail', ['sh', '-c', 'exit 3']))
    await new Promise((r) => setTimeout(r, 50))

    expect(errors.some((e) => /exited with code 3/.test(e))).toBe(true)

    publishCron(stream, execJob('after', ['sh', '-c', 'echo ok > after.txt']))
    await new Promise((r) => setTimeout(r, 50))

    const contents = await Bun.file(join(root, 'after.txt')).text()
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

    expect(calls).toEqual(['slow:first'])
    expect(consumer.inFlightCount()).toBe(1)

    releaseBox.fn?.()
    await new Promise((r) => setImmediate(r))

    publishCron(stream, promptJob('slow', 'third'))
    await new Promise((r) => setImmediate(r))

    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls.includes('slow:third')).toBe(true)

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

    expect(factory.callsByJob.get('once')).toEqual(['hi'])

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
    expect(factory.callsByJob.get('plain')).toEqual(['hello'])
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
    expect(events).toEqual(['prompt:do work', 'idle:cron-sess-1:/tmp/transcript-1.jsonl', 'end:cron-sess-1'])

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
    expect(errors.some((e) => /\[cron\] soft-err: LLM call failed: rate limit exceeded/.test(e))).toBe(true)

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
})

describe('runExecForPrompt', () => {
  test('captures stdout, stderr, and exitCode from a successful command', async () => {
    const job: PromptJob = {
      id: 'j',
      schedule: '* * * * *',
      enabled: true,
      kind: 'prompt',
      prompt: 'p',
      exec: ['sh', '-c', 'echo out; echo err 1>&2; exit 0'],
    }
    const result = await runExecForPrompt(job, root)
    expect(result.stdin.trim()).toBe('out')
    expect(result.stderr.trim()).toBe('err')
    expect(result.exitCode).toBe(0)
  })

  test('captures non-zero exit code without throwing — LLM gets to see the failure', async () => {
    const job: PromptJob = {
      id: 'j',
      schedule: '* * * * *',
      enabled: true,
      kind: 'prompt',
      prompt: 'p',
      exec: ['sh', '-c', 'echo last-out; echo last-err 1>&2; exit 7'],
    }
    const result = await runExecForPrompt(job, root)
    expect(result.exitCode).toBe(7)
    expect(result.stdin.trim()).toBe('last-out')
    expect(result.stderr.trim()).toBe('last-err')
  })

  test('truncates stdout at execMaxOutputBytes with a marker', async () => {
    const job: PromptJob = {
      id: 'j',
      schedule: '* * * * *',
      enabled: true,
      kind: 'prompt',
      prompt: 'p',
      exec: ['sh', '-c', 'printf "%0.s." {1..2000}'],
      execMaxOutputBytes: 100,
    }
    const result = await runExecForPrompt(job, root)
    expect(result.stdin.length).toBeGreaterThan(100)
    expect(result.stdin).toContain('[truncated')
    expect(result.stdin).toContain('1900 bytes]')
  })

  test('truncates stderr independently with the same cap', async () => {
    const job: PromptJob = {
      id: 'j',
      schedule: '* * * * *',
      enabled: true,
      kind: 'prompt',
      prompt: 'p',
      exec: ['sh', '-c', 'printf "%0.s." {1..2000} 1>&2'],
      execMaxOutputBytes: 50,
    }
    const result = await runExecForPrompt(job, root)
    expect(result.stderr).toContain('[truncated')
    expect(result.stderr).toContain('1950 bytes]')
    expect(result.stdin).toBe('')
  })

  test('uses agent cwd so commands like `pwd` resolve to the agent folder', async () => {
    const job: PromptJob = {
      id: 'j',
      schedule: '* * * * *',
      enabled: true,
      kind: 'prompt',
      prompt: 'p',
      exec: ['pwd'],
    }
    const result = await runExecForPrompt(job, root)
    // On macOS, /tmp is a symlink to /private/tmp — accept either.
    expect(result.stdin.trim().endsWith(root) || result.stdin.trim() === root).toBe(true)
  })

  test('rejects when exec is absent (caller bug)', async () => {
    const job: PromptJob = { id: 'j', schedule: '* * * * *', enabled: true, kind: 'prompt', prompt: 'p' }
    await expect(runExecForPrompt(job, root)).rejects.toThrow(/exec is required/)
  })
})

describe('appendExecToPrompt', () => {
  test('appends stdout as a fenced block under the prompt text', () => {
    const exec: ExecResult = { stdin: 'hello\nworld', stderr: '', exitCode: 0 }
    const result = appendExecToPrompt('Summarize:', exec)
    expect(result).toBe('Summarize:\n\n```\nhello\nworld\n```')
  })

  test('omits stderr block when stderr is empty', () => {
    const exec: ExecResult = { stdin: 'out', stderr: '', exitCode: 0 }
    expect(appendExecToPrompt('p', exec)).not.toContain('stderr')
  })

  test('includes a stderr fenced block when stderr is non-empty', () => {
    const exec: ExecResult = { stdin: 'out', stderr: 'warning: foo', exitCode: 0 }
    const result = appendExecToPrompt('p', exec)
    expect(result).toContain('stderr:')
    expect(result).toContain('warning: foo')
  })

  test('appends "exit code: N" only when exitCode is non-zero', () => {
    const ok: ExecResult = { stdin: 'out', stderr: '', exitCode: 0 }
    expect(appendExecToPrompt('p', ok)).not.toContain('exit code')

    const fail: ExecResult = { stdin: 'out', stderr: '', exitCode: 7 }
    expect(appendExecToPrompt('p', fail)).toContain('exit code: 7')
  })
})

describe('mergeExecIntoPayload', () => {
  test('returns { exec } when no original payload', () => {
    const exec: ExecResult = { stdin: 'x', stderr: '', exitCode: 0 }
    expect(mergeExecIntoPayload(undefined, exec)).toEqual({ exec })
  })

  test('merges into an existing object payload without overwriting unrelated fields', () => {
    const exec: ExecResult = { stdin: 'x', stderr: '', exitCode: 0 }
    const merged = mergeExecIntoPayload({ branch: 'main', limit: 10 }, exec)
    expect(merged).toEqual({ branch: 'main', limit: 10, exec })
  })

  test('overwrites a prior `exec` key — most-recent run wins', () => {
    const exec: ExecResult = { stdin: 'fresh', stderr: '', exitCode: 0 }
    const merged = mergeExecIntoPayload({ exec: { stdin: 'stale', stderr: '', exitCode: 99 } }, exec)
    expect(merged).toEqual({ exec })
  })

  test('wraps non-object payload (string) under `payload` so it is preserved', () => {
    const exec: ExecResult = { stdin: 'x', stderr: '', exitCode: 0 }
    expect(mergeExecIntoPayload('a string', exec)).toEqual({ payload: 'a string', exec })
  })

  test('wraps array payload under `payload` (zod object schemas reject arrays anyway, but data is preserved)', () => {
    const exec: ExecResult = { stdin: 'x', stderr: '', exitCode: 0 }
    expect(mergeExecIntoPayload([1, 2, 3], exec)).toEqual({ payload: [1, 2, 3], exec })
  })

  test('wraps null payload (null is typeof object but should not be merged into)', () => {
    const exec: ExecResult = { stdin: 'x', stderr: '', exitCode: 0 }
    expect(mergeExecIntoPayload(null, exec)).toEqual({ payload: null, exec })
  })
})

describe('cron prompt job with `exec` pre-LLM command', () => {
  test('without subagent: appends exec stdout to the prompt text the session receives', async () => {
    // given
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    // when
    publishCron(stream, {
      id: 'with-exec',
      schedule: '* * * * *',
      enabled: true,
      kind: 'prompt',
      prompt: 'Summarize:',
      exec: ['sh', '-c', 'echo from-exec'],
    })
    // exec spawning needs setTimeout, not setImmediate, to let the
    // subprocess actually finish.
    await new Promise((r) => setTimeout(r, 100))

    // then
    const calls = factory.callsByJob.get('with-exec')
    if (!calls || calls.length === 0) throw new Error('expected a prompt call')
    expect(calls[0]).toContain('Summarize:')
    expect(calls[0]).toContain('from-exec')
    expect(calls[0]).toContain('```')

    consumer.stop()
  })

  test('without subagent: non-zero exit code is appended to the prompt', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, {
      id: 'failing-exec',
      schedule: '* * * * *',
      enabled: true,
      kind: 'prompt',
      prompt: 'Investigate:',
      exec: ['sh', '-c', 'echo did-something; exit 4'],
    })
    await new Promise((r) => setTimeout(r, 100))

    const calls = factory.callsByJob.get('failing-exec')
    if (!calls || calls.length === 0) throw new Error('expected a prompt call')
    expect(calls[0]).toContain('did-something')
    expect(calls[0]).toContain('exit code: 4')

    consumer.stop()
  })

  test('with subagent: exec result is merged into the new-session payload', async () => {
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

    publishCron(stream, {
      id: 'sub-exec',
      schedule: '* * * * *',
      enabled: true,
      kind: 'prompt',
      prompt: 'fallback',
      subagent: 'commit-summarizer',
      payload: { branch: 'main' },
      exec: ['sh', '-c', 'echo three-commits'],
    })
    await new Promise((r) => setTimeout(r, 100))

    expect(newSessionMessages).toHaveLength(1)
    const payload = newSessionMessages[0]?.payload as {
      branch: string
      exec: { stdin: string; stderr: string; exitCode: number }
    }
    expect(payload.branch).toBe('main')
    expect(payload.exec.stdin.trim()).toBe('three-commits')
    expect(payload.exec.exitCode).toBe(0)
    expect(factory.callsByJob.size).toBe(0)

    consumer.stop()
  })

  test('without exec: prompt and payload pass through unchanged (regression guard)', async () => {
    const stream = createStream()
    const factory = makeFakeSessionFactory()
    const consumer = createCronConsumer({
      stream,
      cwd: root,
      createSessionForCron: factory.createSessionForCron,
      logger: silentLogger,
    })
    consumer.start()

    publishCron(stream, promptJob('no-exec', 'plain prompt'))
    await new Promise((r) => setImmediate(r))

    expect(factory.callsByJob.get('no-exec')).toEqual(['plain prompt'])

    consumer.stop()
  })

  test('exec command spawn failure (ENOENT) is logged and does not crash the consumer', async () => {
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

    publishCron(stream, {
      id: 'enoent',
      schedule: '* * * * *',
      enabled: true,
      kind: 'prompt',
      prompt: 'p',
      exec: ['no-such-binary-exists-12345'],
    })
    await new Promise((r) => setTimeout(r, 100))

    expect(errors.length).toBeGreaterThan(0)
    expect(factory.callsByJob.size).toBe(0)

    // Consumer survives — a subsequent job runs normally.
    publishCron(stream, promptJob('after', 'still alive'))
    await new Promise((r) => setImmediate(r))
    expect(factory.callsByJob.get('after')).toEqual(['still alive'])

    consumer.stop()
  })
})
