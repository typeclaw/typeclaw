import { afterEach, describe, expect, test } from 'bun:test'

import FakeTimers from '@sinonjs/fake-timers'

import { testKernel } from './fixtures.test'
import type { EvalKernel } from './kernel'
import { EVAL_LIMITS, EvalError } from './protocol'

// These exercise the real subprocess and Bun interpreter, NOT sandbox claims.
// Boundary tests use createSandboxedEvalKernel and require real Linux bwrap.
const kernels: EvalKernel[] = []
function kernel(): EvalKernel {
  const instance = testKernel(process.cwd())
  kernels.push(instance)
  return instance
}
afterEach(async () => {
  await Promise.all(kernels.splice(0).map((instance) => instance.dispose()))
})

const dispatch = async () => {
  throw new EvalError('refused', 'test has no tools')
}

// The kernel spawns bash and kills POSIX process groups; eval only runs in the
// Linux container stage.
describe.skipIf(process.platform === 'win32')('persistent Bun kernel', () => {
  test('top-level bindings survive subsequent cells including awaited declarations', async () => {
    const instance = kernel()
    const first = await instance.run('const answer = await Promise.resolve(41)', { dispatch })
    expect(first.isError).toBe(false)
    const second = await instance.run('print(answer + 1)', { dispatch })
    expect(second.isError).toBe(false)
    expect(second.text.trim()).toBe('42')
  })

  test('parallel calls return only explicitly selected output', async () => {
    const instance = kernel()
    const seen: string[] = []
    const result = await instance.run(
      'const values = await parallel([() => tool.read({path:"one"}), () => tool.grep({pattern:"two"})]); print(values.map(v => v.selected))',
      {
        dispatch: async ({ name }) => {
          seen.push(name)
          return { selected: name, large: 'omitted intermediate' }
        },
      },
    )
    expect(result.isError).toBe(false)
    expect(seen.sort()).toEqual(['grep', 'read'])
    expect(result.text).toContain('read')
    expect(result.text).not.toContain('omitted intermediate')
  })

  test('text() extracts only the text parts of a tool result and caps them', async () => {
    const instance = kernel()
    const result = await instance.run('const r = await tool.read({path:"x"}); print(text(r)); print(text(r, 5))', {
      dispatch: async () => ({
        content: [
          { type: 'text', text: '배포 메모' },
          { type: 'image', data: 'BASE64BLOB' },
          { type: 'text', text: 'second line' },
        ],
        details: { secretDetail: 'not for the transcript' },
      }),
    })
    expect(result.isError).toBe(false)
    expect(result.text).toContain('배포 메모\nsecond line')
    expect(result.text).toContain('…[')
    expect(result.text).not.toContain('BASE64BLOB')
    expect(result.text).not.toContain('secretDetail')
  })

  test('a busy loop times out and the next cell recovers without old bindings', async () => {
    const instance = kernel()
    await instance.run('const beforeTimeout = 1', { dispatch })
    const timed = await instance.run('while (true) {}', { dispatch, timeoutMs: 100 })
    expect(timed.isError).toBe(true)
    const recovered = await instance.run('print(typeof beforeTimeout)', { dispatch })
    expect(recovered.restarted).toBe(true)
    expect(recovered.text).toContain('undefined')
    expect(recovered.isError).toBe(false)
  })

  test('large printed output is capped by the host', async () => {
    const instance = kernel()
    const result = await instance.run(`print("x".repeat(${EVAL_LIMITS.outputBytes * 2}))`, { dispatch })
    expect(result.isError).toBe(false)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text)).toBeLessThan(EVAL_LIMITS.outputBytes + 100)
  })

  test('raw stdout without a newline cannot swallow control frames', async () => {
    const instance = kernel()
    const result = await instance.run('process.stdout.write("raw"); print("helper")', { dispatch })
    expect(result.isError).toBe(false)
    expect(result.text).toBe('raw\nhelper\n')
  })

  test('a rejected top-level await completes with the original error', async () => {
    const instance = kernel()
    const result = await instance.run('await Promise.reject(new Error("cell-rejection"))', { dispatch })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('cell-rejection')
    expect(result.text).not.toContain('timed out')
  })

  test('a failed cell keeps the kernel and its earlier bindings', async () => {
    const instance = kernel()
    await instance.run('const kept = 5', { dispatch })
    const failed = await instance.run('await tool.grep({pattern:"("})', { dispatch })
    expect(failed.isError).toBe(true)
    expect(failed.text).toContain('test has no tools')
    expect(failed.text).toContain('bindings kept')
    const next = await instance.run('print(kept)', { dispatch })
    expect(next.restarted).toBe(false)
    expect(next.text.trim()).toBe('5')
  })

  test('a failed parallel batch settles delayed workers before the cell ends', async () => {
    const instance = kernel()
    const seen: string[] = []
    const failed = await instance.run(
      'await parallel([() => tool.grep({}), async () => { await Bun.sleep(100); return tool.read({}) }])',
      {
        dispatch: async ({ name }) => {
          seen.push(name)
          if (name === 'grep') throw new EvalError('refused', 'bad regex')
          return 'late'
        },
      },
    )
    expect(failed.isError).toBe(true)
    expect(failed.text).toContain('bad regex')
    // The delayed worker ran inside the failed cell, not after it.
    expect(seen.sort()).toEqual(['grep', 'read'])
  })

  test('idle expiry discards bindings before the next cell', async () => {
    const instance = kernel()
    const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await instance.run('const idleValue = 7', { dispatch })
      await clock.tickAsync(EVAL_LIMITS.idleMs)
      const result = await instance.run('print(typeof idleValue)', { dispatch })
      expect(result.isError).toBe(false)
      expect(result.restarted).toBe(true)
      expect(result.text).toContain('undefined')
    } finally {
      clock.uninstall()
    }
  })

  test('process death is reported and the next cell restarts', async () => {
    const instance = kernel()
    const failed = await instance.run('process.exit(3)', { dispatch })
    expect(failed.isError).toBe(true)
    const result = await instance.run('print(42)', { dispatch })
    expect(result.isError).toBe(false)
    expect(result.restarted).toBe(true)
    expect(result.text).toContain('42')
  })

  test('errors after large output still respect the output budget', async () => {
    const instance = kernel()
    const result = await instance.run(
      `print("x".repeat(${EVAL_LIMITS.outputBytes})); throw new Error("y".repeat(4096))`,
      { dispatch },
    )
    expect(result.isError).toBe(true)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text)).toBeLessThan(EVAL_LIMITS.outputBytes + 200)
  })

  test('cancellation aborts in-flight bridge work before a fresh cell', async () => {
    const instance = kernel()
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const controller = new AbortController()
    const result = instance.run('await tool.pending({})', {
      signal: controller.signal,
      dispatch: async (_request, signal) => {
        const cancelled = new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted.resolve()
              resolve()
            },
            { once: true },
          )
        })
        started.resolve()
        await cancelled
        signal.throwIfAborted()
      },
    })
    await started.promise
    controller.abort(new Error('test cancellation'))
    await aborted.promise
    expect((await result).isError).toBe(true)
    const next = await instance.run('print(42)', { dispatch })
    expect(next.isError).toBe(false)
    expect(next.restarted).toBe(true)
  })

  test('session disposal refuses further cells', async () => {
    const instance = kernel()
    await instance.run('const retained = 1', { dispatch })
    await instance.dispose()
    await expect(instance.run('print(retained)', { dispatch })).rejects.toThrow(EvalError)
  })
})
