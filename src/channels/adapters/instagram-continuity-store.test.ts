import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { instagramContinuityPath, loadInstagramContinuityStore } from './instagram-continuity-store'

const SILENT = { warn: () => {}, error: () => {} }
let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'instagram-continuity-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('InstagramContinuityStore', () => {
  test('persists seeded and delivered message ids across reloads', async () => {
    const first = await loadInstagramContinuityStore(agentDir, SILENT)
    await first.seedThread('account-1', 'thread-1', ['M1', 'M2'])
    await first.markMessage('account-1', 'thread-1', 'M3')

    const reloaded = await loadInstagramContinuityStore(agentDir, SILENT)

    expect(reloaded.knowsThread('account-1', 'thread-1')).toBe(true)
    expect(reloaded.hasMessage('account-1', 'thread-1', 'M1')).toBe(true)
    expect(reloaded.hasMessage('account-1', 'thread-1', 'M3')).toBe(true)
    expect(reloaded.hasMessage('account-2', 'thread-1', 'M3')).toBe(false)
  })

  test('keeps only the newest bounded set of ids', async () => {
    const store = await loadInstagramContinuityStore(agentDir, SILENT)
    const ids = Array.from({ length: 501 }, (_, index) => `M${index}`)

    await store.seedThread('account-1', 'thread-1', ids)

    expect(store.hasMessage('account-1', 'thread-1', 'M0')).toBe(false)
    expect(store.hasMessage('account-1', 'thread-1', 'M500')).toBe(true)
  })

  test('ignores a corrupted file and starts fresh', async () => {
    const path = instagramContinuityPath(agentDir)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{ invalid json', 'utf8')

    const store = await loadInstagramContinuityStore(agentDir, SILENT)

    expect(store.knowsThread('account-1', 'thread-1')).toBe(false)
  })

  test('rolls back and rethrows when persistence fails', async () => {
    await writeFile(join(agentDir, 'channels'), 'not a directory', 'utf8')
    const store = await loadInstagramContinuityStore(agentDir, SILENT)

    await expect(store.markMessage('account-1', 'thread-1', 'M1')).rejects.toThrow()

    expect(store.knowsThread('account-1', 'thread-1')).toBe(false)
  })
})
