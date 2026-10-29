import { expect, test } from 'bun:test'
import { watch } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { testLaunch } from './fixtures.test'
import { EvalKernel } from './kernel'

test('raw output from an old kernel cannot enter a new authority cell during preparation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-eval-authority-'))
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const acknowledged = Promise.withResolvers<void>()
  const ack = join(dir, 'ack')
  let changed = false
  const kernel = new EvalKernel(async () => {
    if (changed) {
      entered.resolve()
      await resume.promise
    }
    return testLaunch(dir, changed ? 'new-authority' : 'old-authority')
  })
  const dispatch = async () => null
  const watcher = watch(dir, (_event, filename) => {
    if (filename === 'ack') acknowledged.resolve()
  })
  watcher.on('error', acknowledged.reject)
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    // The write callback proves stdout entered the pipe before the ack appears.
    // Kernel teardown drains that pipe before the replacement starts, so this
    // detects misattribution regardless of which host I/O callback runs first.
    const first = await kernel.run(
      `process.on("SIGUSR2", () => process.stdout.write("prior-private-value\\n", () => require("node:fs").writeFileSync(${JSON.stringify(ack)}, "ready"))); print(process.pid)`,
      { dispatch },
    )
    expect(first.isError).toBe(false)
    const pid = Number(first.text.trim())
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
    changed = true
    const next = kernel.run('print("fresh-cell")', { dispatch })
    await entered.promise
    deadline = setTimeout(() => acknowledged.reject(new Error('child did not acknowledge output')), 5000)
    process.kill(pid, 'SIGUSR2')
    await acknowledged.promise
    resume.resolve()
    const result = await next
    expect(result.isError).toBe(false)
    expect(result.restarted).toBe(true)
    expect(result.text).toContain('fresh-cell')
    expect(result.text).not.toContain('prior-private-value')
  } finally {
    clearTimeout(deadline)
    watcher.close()
    resume.resolve()
    await kernel.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}, 10_000)
