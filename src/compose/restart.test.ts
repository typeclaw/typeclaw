import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Controller, RestartOptions } from '@/container'
import { rmTempDir } from '@/test-helpers/rm-temp-dir'

import { composeRestart, type ComposeRestartEvent } from './restart'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-compose-restart-'))
})

afterEach(async () => {
  await rmTempDir(root)
})

// Malformed JSON so validateConfig short-circuits before real Docker calls;
// see src/compose/start.test.ts for the full rationale.
async function makeInvalidAgent(parent: string, name: string): Promise<void> {
  const dir = join(parent, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'typeclaw.json'), 'this is not json\n')
}

async function makeValidAgent(parent: string, name: string): Promise<void> {
  const dir = join(parent, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'typeclaw.json'), '{}\n')
}

describe('composeRestart events', () => {
  test('emits agent-start then agent-done for every discovered agent', async () => {
    await makeInvalidAgent(root, 'alpha')
    await makeInvalidAgent(root, 'bravo')

    const events: ComposeRestartEvent[] = []
    const { results } = await composeRestart({
      rootCwd: root,
      preferredHostPort: 8973,
      onProgress: (event) => events.push(event),
    })

    expect(results).toHaveLength(2)
    expect(results.every((r) => !r.ok)).toBe(true)

    const starts = events.filter((e) => e.kind === 'agent-start').map((e) => e.name)
    const dones = events.filter((e) => e.kind === 'agent-done').map((e) => e.name)
    expect(new Set(starts)).toEqual(new Set(['alpha', 'bravo']))
    expect(new Set(dones)).toEqual(new Set(['alpha', 'bravo']))
  })

  test('does not emit agent-stopped when validateConfig rejects (guard ordering)', async () => {
    await makeInvalidAgent(root, 'alpha')

    const events: ComposeRestartEvent[] = []
    await composeRestart({
      rootCwd: root,
      preferredHostPort: 8973,
      onProgress: (event) => events.push(event),
    })

    expect(events.some((e) => e.kind === 'agent-stopped')).toBe(false)
  })

  test('per-agent event ordering: start < (optional stopped) < done', async () => {
    await makeInvalidAgent(root, 'alpha')
    await makeInvalidAgent(root, 'bravo')

    const events: ComposeRestartEvent[] = []
    await composeRestart({
      rootCwd: root,
      preferredHostPort: 8973,
      onProgress: (event) => events.push(event),
    })

    for (const name of ['alpha', 'bravo']) {
      const startIdx = events.findIndex((e) => e.kind === 'agent-start' && e.name === name)
      const doneIdx = events.findIndex((e) => e.kind === 'agent-done' && e.name === name)
      expect(startIdx).toBeGreaterThanOrEqual(0)
      expect(doneIdx).toBeGreaterThan(startIdx)

      const stoppedIdx = events.findIndex((e) => e.kind === 'agent-stopped' && e.name === name)
      if (stoppedIdx >= 0) {
        expect(stoppedIdx).toBeGreaterThan(startIdx)
        expect(stoppedIdx).toBeLessThan(doneIdx)
      }
    }
  })

  test('agent-done carries the same AgentResult as the returned results', async () => {
    await makeInvalidAgent(root, 'alpha')

    const events: ComposeRestartEvent[] = []
    const { results } = await composeRestart({
      rootCwd: root,
      preferredHostPort: 8973,
      onProgress: (event) => events.push(event),
    })

    const done = events.find((e) => e.kind === 'agent-done')
    expect(done).toBeDefined()
    if (done?.kind !== 'agent-done') throw new Error('unreachable')
    expect(done.result).toEqual(results[0]!)
  })

  test('emits no events when no agents are discovered', async () => {
    const events: ComposeRestartEvent[] = []
    const { agents, results } = await composeRestart({
      rootCwd: root,
      preferredHostPort: 8973,
      onProgress: (event) => events.push(event),
    })

    expect(agents).toEqual([])
    expect(results).toEqual([])
    expect(events).toEqual([])
  })

  test('runs without onProgress', async () => {
    await makeInvalidAgent(root, 'alpha')
    const { results } = await composeRestart({ rootCwd: root, preferredHostPort: 8973 })
    expect(results).toHaveLength(1)
  })

  test('keeps inherited build output away from the live compose board', async () => {
    await makeValidAgent(root, 'alpha')
    let restartOptions: RestartOptions | undefined
    const restart: Controller['restart'] = async (options) => {
      restartOptions = options
      options.onWarning?.('captured warning')
      return { ok: false, reason: 'simulated failure' }
    }

    const { results } = await composeRestart({ rootCwd: root, preferredHostPort: 8973 }, { restart })

    expect(restartOptions?.streamOutput).toBe(false)
    expect(results[0]).toEqual({
      name: 'alpha',
      ok: false,
      reason: 'simulated failure',
      warnings: ['captured warning'],
    })
  })
})
