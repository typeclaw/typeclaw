import { describe, expect, test } from 'bun:test'

import type { TurnResult } from './client'
import { scoreTask } from './score'
import type { Task } from './task'
import type { VerifyResult } from './verify'
import type { WorkspaceProvider } from './workspace'

const TASK: Task = {
  id: 'demo',
  dir: '/tmp/demo',
  instruction: 'do it',
  verifyCommand: ['true'],
  timeoutMs: 1000,
}

const emptyTurn: TurnResult = { text: '', toolCalls: [], usage: null, error: null }
const runTurn = async () => emptyTurn
const verifyWith = (passed: boolean) => async (): Promise<VerifyResult> => ({
  passed,
  exitCode: passed ? 0 : 1,
  stdout: '',
  stderr: '',
})

describe('scoreTask', () => {
  test('pass^k is true only when every run passes', async () => {
    const score = await scoreTask({ task: TASK, url: 'ws://x', runs: 3, runTurn, verify: verifyWith(true) })

    expect(score.passHatK).toBe(true)
    expect(score.passAt1).toBe(1)
    expect(score.passRate).toBe(1)
    expect(score.outcomes).toHaveLength(3)
  })

  test('pass^k is false when any run fails', async () => {
    let call = 0
    const flaky = async (): Promise<VerifyResult> => {
      call += 1
      const passed = call !== 2
      return { passed, exitCode: passed ? 0 : 1, stdout: '', stderr: '' }
    }

    const score = await scoreTask({ task: TASK, url: 'ws://x', runs: 3, runTurn, verify: flaky })

    expect(score.passHatK).toBe(false)
    expect(score.passAt1).toBe(1)
    expect(score.passRate).toBeCloseTo(2 / 3)
  })

  test('a failing first run yields passAt1 = 0', async () => {
    const score = await scoreTask({ task: TASK, url: 'ws://x', runs: 1, runTurn, verify: verifyWith(false) })

    expect(score.passAt1).toBe(0)
    expect(score.passHatK).toBe(false)
  })

  // Regression for the container-path isolation bug: models each run's workspace
  // as a distinct in-memory filesystem keyed by path. Run 0 writes the artifact,
  // run 1 does nothing. Because each run gets its own fresh path (seeded before
  // the turn) and the verifier checks THAT path, run 1 sees no leftover and
  // pass^k is false. Also asserts the ordering: prepare -> turn -> verify, same
  // path per run — the exact invariant the reviewer flagged.
  test('pass^k is false when a later run relies on a prior run artifact', async () => {
    const files = new Map<string, Set<string>>()
    const events: string[] = []

    const workspaceProvider: WorkspaceProvider = {
      async prepare(i) {
        const path = `/tmp/bench-run-${i}`
        events.push(`prepare:${path}`)
        files.set(path, new Set(['seed']))
        return { path }
      },
    }
    const runTurn = async (_url: string, prompt: string) => {
      const path = /Work in this directory: (.+)$/m.exec(prompt)?.[1] ?? ''
      events.push(`turn:${path}`)
      if (path === '/tmp/bench-run-0') files.get(path)!.add('artifact')
      return emptyTurn
    }
    const verify = async (_cmd: string[], cwd: string): Promise<VerifyResult> => {
      events.push(`verify:${cwd}`)
      const passed = files.get(cwd)?.has('artifact') ?? false
      return { passed, exitCode: passed ? 0 : 1, stdout: '', stderr: '' }
    }

    const score = await scoreTask({ task: TASK, url: 'ws://x', runs: 2, workspaceProvider, runTurn, verify })

    expect(score.passAt1).toBe(1)
    expect(score.passHatK).toBe(false)
    expect(events).toEqual([
      'prepare:/tmp/bench-run-0',
      'turn:/tmp/bench-run-0',
      'verify:/tmp/bench-run-0',
      'prepare:/tmp/bench-run-1',
      'turn:/tmp/bench-run-1',
      'verify:/tmp/bench-run-1',
    ])
  })
})
