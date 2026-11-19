import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as flushTasks, setTimeout as pollDelay } from 'node:timers/promises'

import * as FakeTimers from '@sinonjs/fake-timers'

import { EmbedderProcess } from './embedder-process'
import { EMBED_BATCH_SIZE, embedRequest } from './embedder-wire'

const entry = join(import.meta.dir, 'embedder-process-fixture.ts')

type Launch = NonNullable<NonNullable<ConstructorParameters<typeof EmbedderProcess>[0]>['launch']>

function controlledChild(events: Parameters<Launch>[0]) {
  const exit = Promise.withResolvers<number>()
  const requests: ReturnType<typeof embedRequest.parse>[] = []
  let sendError: Error | undefined
  return {
    process: {
      exited: exit.promise,
      kill: () => undefined,
      unref: () => undefined,
      send(message: unknown) {
        if (sendError !== undefined) throw sendError
        requests.push(embedRequest.parse(message))
      },
    },
    exit,
    events,
    requests,
    failSend() {
      sendError = new Error('pipe closed')
    },
  }
}

test('a progressing rebuild completes beyond one passage watchdog interval', async () => {
  const clock = FakeTimers.install({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  const launched = Promise.withResolvers<ReturnType<typeof controlledChild>>()
  const worker = new EmbedderProcess({
    passageStallMs: 100,
    launch(events) {
      const child = controlledChild(events)
      launched.resolve(child)
      return child.process
    },
  })
  let child: ReturnType<typeof controlledChild> | undefined
  try {
    const count = 2 * EMBED_BATCH_SIZE
    const result = worker.embed(
      Array.from({ length: count }, () => 'passage'),
      'passage',
    )
    const outcome = result.catch((error: unknown) => error)
    child = await launched.promise
    const id = child.requests[0]?.id
    clock.tick(75)
    child.events.message({ id, kind: 'progress', completed: EMBED_BATCH_SIZE })
    clock.tick(75)
    child.events.message({ id, kind: 'progress', completed: count })
    child.events.message({ id, kind: 'result', vectors: Array.from({ length: count }, () => new Float32Array(768)) })
    expect(await outcome).toHaveLength(count)
  } finally {
    child?.exit.resolve(0)
    await worker.dispose()
    clock.uninstall()
  }
})

test('a waiting request never starts a worker while a failed replacement is retiring', async () => {
  const clock = FakeTimers.install({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  const children: ReturnType<typeof controlledChild>[] = []
  const worker = new EmbedderProcess({
    queryTimeoutMs: 100,
    launch(events) {
      const child = controlledChild(events)
      if (children.length === 1) child.failSend()
      children.push(child)
      return child.process
    },
  })
  try {
    const first = worker.embed(['first'], 'query')
    const firstFailure = first.catch((error: unknown) => error)
    const original = children[0]
    if (original === undefined) throw new Error('original worker did not start')
    original.events.exit(new Error('worker crashed'))
    expect(await firstFailure).toEqual(new Error('worker crashed'))

    const replacementFailure = worker.embed(['second'], 'query').catch((error: unknown) => error)
    const waitingTimeout = worker.embed(['third'], 'query').catch((error: unknown) => error)
    clock.tick(75)
    original.exit.resolve(1)
    expect(await replacementFailure).toMatchObject({ message: 'could not send embedding request' })
    await flushTasks()
    // The second worker has been killed but is deliberately not reaped.
    expect(children).toHaveLength(2)
    clock.tick(25)
    expect(await waitingTimeout).toMatchObject({ message: 'query embedding request timed out' })
    expect(children).toHaveLength(2)

    const replacement = children[1]
    if (replacement === undefined) throw new Error('replacement worker did not start')
    replacement.exit.resolve(1)
    const retry = worker.embed(['retry'], 'query')
    await flushTasks()
    const fresh = children[2]
    if (fresh === undefined) throw new Error('fresh worker did not start')
    fresh.events.message({ id: fresh.requests[0]?.id, kind: 'result', vectors: [new Float32Array(768)] })
    await expect(retry).resolves.toHaveLength(1)
  } finally {
    for (const child of children) child.exit.resolve(0)
    await worker.dispose()
    clock.uninstall()
  }
})

test('the default child returns the model cache validation error over IPC', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'typeclaw-empty-model-cache-'))
  const previous = process.env.TYPECLAW_MODEL_CACHE
  process.env.TYPECLAW_MODEL_CACHE = dir
  const worker = new EmbedderProcess()
  try {
    await expect(worker.embed(['query'], 'query')).rejects.toThrow(/model cache.*missing|sentinel.*missing/i)
  } finally {
    await worker.dispose()
    if (previous === undefined) delete process.env.TYPECLAW_MODEL_CACHE
    else process.env.TYPECLAW_MODEL_CACHE = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the idle process exits, and the next request starts a fresh process', async () => {
  const worker = new EmbedderProcess({ entry, idleMs: 30 })
  try {
    const [first] = await worker.embed(['first'], 'query')
    const pid = Number(first?.[0])
    expect(pid).toBeGreaterThan(0)
    await waitForExit(pid)
    const [next] = await worker.embed(['next'], 'query')
    expect(next?.[0]).not.toBe(pid)
  } finally {
    await worker.dispose()
  }
})

test.skipIf(process.platform !== 'linux')(
  'Linux kills the child when the runtime dies during blocked inference',
  async () => {
    const parent = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        '-e',
        `
        import { EmbedderProcess } from ${JSON.stringify(new URL('./embedder-process.ts', import.meta.url).href)}
        const worker = new EmbedderProcess({ entry: ${JSON.stringify(entry)} })
        const [vector] = await worker.embed(['query'], 'query')
        console.log(vector[0])
        await worker.embed(['hang'], 'query')
      `,
      ],
      { env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' },
    )
    const reader = parent.stdout.getReader()
    let pid: number | undefined
    try {
      const { value } = await reader.read()
      pid = Number(new TextDecoder().decode(value).trim())
      expect(pid).toBeGreaterThan(0)
      process.kill(pid, 'SIGSTOP')
      parent.kill('SIGKILL')
      await parent.exited
      await waitForExit(pid)
    } finally {
      parent.kill('SIGKILL')
      if (pid !== undefined && pid > 0 && isAlive(pid)) process.kill(pid, 'SIGKILL')
      await reader.cancel()
      await parent.exited
    }
  },
)

function isAlive(pid: number): boolean {
  try {
    if (process.platform === 'linux') return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8'))
    return process.kill(pid, 0)
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')) return false
    throw error
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = performance.now() + 2_000
  // The grandchild has no wait handle in this process, so poll its OS state.
  while (isAlive(pid) && performance.now() < deadline) await pollDelay(10)
  expect(isAlive(pid)).toBe(false)
}

test('a crashed request rejects and the next request starts a working process', async () => {
  const worker = new EmbedderProcess({ entry })
  try {
    await expect(worker.embed(['crash'], 'query')).rejects.toThrow(/embedding subprocess (exited|disconnected)/)
    const [next] = await worker.embed(['日本語'], 'query')
    expect(next?.[1]).toBe(3)
  } finally {
    await worker.dispose()
  }
})

test('a hung request times out and a restarted process serves the next request', async () => {
  const worker = new EmbedderProcess({ entry, queryTimeoutMs: 500 })
  try {
    await expect(worker.embed(['hang'], 'query')).rejects.toThrow('query embedding request timed out')
    const [next] = await worker.embed(['다시'], 'query')
    expect(next?.[1]).toBe(2)
  } finally {
    await worker.dispose()
  }
})

test('a query can finish during indexing and only receives its own vectors', async () => {
  const worker = new EmbedderProcess({ entry })
  try {
    const indexing = worker.embed(['first passage', 'second passage'], 'passage')
    const query = worker.embed(['query'], 'query')
    const [queryVectors, passageVectors] = await Promise.all([query, indexing])
    expect(queryVectors.map((vector) => vector[1])).toEqual([5])
    expect(passageVectors.map((vector) => vector[1])).toEqual([13, 14])
    expect(passageVectors.map((vector) => vector[0])).toEqual([queryVectors[0]?.[0], queryVectors[0]?.[0]])
  } finally {
    await worker.dispose()
  }
})

test('the embedder gets no parent secret and disposal reaps its process', async () => {
  const worker = new EmbedderProcess({ entry })
  const previous = process.env.TYPECLAW_EMBED_TEST_SECRET
  process.env.TYPECLAW_EMBED_TEST_SECRET = 'not-for-the-embedder'
  try {
    const [result] = await worker.embed(['query'], 'query')
    expect(result?.[2]).toBe(0)
    const pid = Number(result?.[0])
    await worker.dispose()
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    if (previous === undefined) delete process.env.TYPECLAW_EMBED_TEST_SECRET
    else process.env.TYPECLAW_EMBED_TEST_SECRET = previous
    await worker.dispose()
  }
})
