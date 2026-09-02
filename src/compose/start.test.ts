import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Controller, StartOptions } from '@/container'
import { rmTempDir } from '@/test-helpers/rm-temp-dir'

import { composeStart, type ComposeStartEvent } from './start'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-compose-start-'))
})

afterEach(async () => {
  await rmTempDir(root)
})

// validateConfig rejects malformed JSON before any Docker call, which is
// what we need to test event emission deterministically without spinning up
// real containers. An empty `{}` would *pass* validation (all fields default)
// and accidentally drive composeStart through a real `start()`.
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

describe('composeStart events', () => {
  test('emits agent-start then agent-done for every discovered agent', async () => {
    await makeInvalidAgent(root, 'alpha')
    await makeInvalidAgent(root, 'bravo')

    const events: ComposeStartEvent[] = []
    const { results } = await composeStart({
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

  test('agent-start precedes agent-done for each agent name', async () => {
    await makeInvalidAgent(root, 'solo')

    const events: ComposeStartEvent[] = []
    await composeStart({
      rootCwd: root,
      preferredHostPort: 8973,
      onProgress: (event) => events.push(event),
    })

    const startIdx = events.findIndex((e) => e.kind === 'agent-start' && e.name === 'solo')
    const doneIdx = events.findIndex((e) => e.kind === 'agent-done' && e.name === 'solo')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(doneIdx).toBeGreaterThan(startIdx)
  })

  test('agent-done carries the same AgentResult as the returned results', async () => {
    await makeInvalidAgent(root, 'alpha')

    const events: ComposeStartEvent[] = []
    const { results } = await composeStart({
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
    const events: ComposeStartEvent[] = []
    const { agents, results } = await composeStart({
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
    const { results } = await composeStart({ rootCwd: root, preferredHostPort: 8973 })
    expect(results).toHaveLength(1)
  })

  test('keeps inherited build output away from the live compose board', async () => {
    await makeValidAgent(root, 'alpha')
    let startOptions: StartOptions | undefined
    const start: Controller['start'] = async (options) => {
      startOptions = options
      options.onWarning?.('captured warning')
      return { ok: false, reason: 'simulated failure' }
    }

    const { results } = await composeStart({ rootCwd: root, preferredHostPort: 8973 }, { start })

    expect(startOptions?.streamOutput).toBe(false)
    expect(results[0]).toEqual({
      name: 'alpha',
      ok: false,
      reason: 'simulated failure',
      warnings: ['captured warning'],
    })
  })
})
