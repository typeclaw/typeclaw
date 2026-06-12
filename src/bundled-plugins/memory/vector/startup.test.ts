import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fragmentContentHash } from '../fragment-parser'
import { renderShard } from '../frontmatter'
import { EMBEDDING_MODEL_ID } from './embedder'
import type { EmbedFn } from './hybrid'
import { buildStartupVectorIndex } from './startup'
import { VectorStore } from './store'

const testDirs: string[] = []

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('buildStartupVectorIndex', () => {
  it('embeds topics only and never the stream fragment alongside them', async () => {
    const agentDir = createAgentDir()
    writeTopic(agentDir, 'startup-topic', 'Startup Topic', 'This topic is pre-warmed at boot.')
    writeFragment(agentDir, '2026-06-11', 'frag-1', 'Recent Stream', 'This stream fragment is NOT indexed.')
    const embeddedTexts: string[] = []

    const result = await buildStartupVectorIndex(agentDir, async (texts, type) => {
      expect(type).toBe('passage')
      embeddedTexts.push(...texts)
      return texts.map((_, index) => vector({ [index]: 1 }))
    })

    const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    try {
      expect(result).toEqual({ built: true, pruned: 0, count: 1 })
      expect(embeddedTexts).toEqual(['Startup Topic\nThis topic is pre-warmed at boot.'])
      expect(store.getAll().map((stored) => [stored.id, stored.source, stored.key, stored.dims])).toEqual([
        ['topic:startup-topic', 'topic', 'startup-topic', 8],
      ])
    } finally {
      store.close()
    }
  })

  it('no-ops when the startup index is already current', async () => {
    const agentDir = createAgentDir()
    writeTopic(agentDir, 'current-topic', 'Current Topic', 'Already indexed content.')
    let calls = 0
    const embedFn: EmbedFn = async (texts) => {
      calls += 1
      return texts.map(() => vector({ 0: 1 }))
    }

    await buildStartupVectorIndex(agentDir, embedFn)
    const result = await buildStartupVectorIndex(agentDir, embedFn)

    expect(result).toEqual({ built: false, pruned: 0, count: 0 })
    expect(calls).toBe(1)
  })

  it('embeds only missing passages when the startup index is partial', async () => {
    const agentDir = createAgentDir()
    writeTopic(agentDir, 'current-topic', 'Current Topic', 'Already indexed content.')
    await buildStartupVectorIndex(agentDir, async (texts) => texts.map(() => vector({ 0: 1 })))
    writeTopic(agentDir, 'missing-topic', 'Missing Topic', 'New content needs a vector.')
    const embeddedTexts: string[] = []

    const result = await buildStartupVectorIndex(agentDir, async (texts, type) => {
      expect(type).toBe('passage')
      embeddedTexts.push(...texts)
      return texts.map(() => vector({ 1: 1 }))
    })

    const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
    try {
      expect(result).toEqual({ built: true, pruned: 0, count: 1 })
      expect(embeddedTexts).toEqual(['Missing Topic\nNew content needs a vector.'])
      expect(store.getAll().map((stored) => stored.id)).toEqual(['topic:current-topic', 'topic:missing-topic'])
    } finally {
      store.close()
    }
  })

  it('re-embeds and purges rows from a previous model/dtype variant', async () => {
    const agentDir = createAgentDir()
    writeTopic(agentDir, 'carried-over', 'Carried Over', 'Content unchanged across a dtype switch.')

    // given: an index built by a previous embedding variant (e.g. fp32), same
    // content, stamped with a different model id
    const dbPath = join(agentDir, 'memory', '.vectors', 'index.db')
    const seed = VectorStore.open(dbPath)
    seed.upsert({
      id: 'topic:carried-over',
      source: 'topic',
      key: 'carried-over',
      model: 'Xenova/multilingual-e5-base@fp32',
      dims: 8,
      embedding: vector({ 0: 1 }),
      contentHash: fragmentContentHash({ topic: 'Carried Over', body: 'Content unchanged across a dtype switch.' }),
    })
    seed.close()
    const embeddedTexts: string[] = []

    // when: the new variant builds the startup index
    const result = await buildStartupVectorIndex(agentDir, async (texts) => {
      embeddedTexts.push(...texts)
      return texts.map(() => vector({ 1: 1 }))
    })

    const store = VectorStore.open(dbPath)
    try {
      // then: the unchanged content is re-embedded under the new stamp, and the
      // stale fp32 row is gone (one row, current variant only)
      expect(result).toEqual({ built: true, pruned: 0, count: 1 })
      expect(embeddedTexts).toEqual(['Carried Over\nContent unchanged across a dtype switch.'])
      const rows = store.getAll()
      expect(rows.map((stored) => stored.id)).toEqual(['topic:carried-over'])
      expect(rows[0]?.model).toBe(EMBEDDING_MODEL_ID)
    } finally {
      store.close()
    }
  })

  it('prunes legacy stream rows since the index is topic-only', async () => {
    const agentDir = createAgentDir()
    const fragmentId = '019e2eca-6fc5-71ef-add9-67a0955a4b35'

    // given: a topic and a leftover stream vector row from before stream embedding was removed
    writeTopic(agentDir, 'package-manager', 'Package Manager', 'User uses pnpm.')
    const dbPath = join(agentDir, 'memory', '.vectors', 'index.db')
    const seed = VectorStore.open(dbPath)
    seed.upsert({
      id: `stream:2026-06-11#${fragmentId}`,
      source: 'stream',
      key: `2026-06-11#${fragmentId}`,
      model: EMBEDDING_MODEL_ID,
      dims: 8,
      embedding: vector({ 0: 1 }),
      contentHash: 'legacy',
    })
    seed.close()

    // when: startup runs
    const result = await buildStartupVectorIndex(agentDir, async (texts) => texts.map(() => vector({ 1: 1 })))

    // then: every stream row is pruned; only the topic vector remains
    const store = VectorStore.open(dbPath)
    try {
      expect(result.pruned).toBe(1)
      const ids = store.getAll().map((stored) => stored.id)
      expect(ids).toEqual(['topic:package-manager'])
    } finally {
      store.close()
    }
  })
})

function createAgentDir(): string {
  const agentDir = join(tmpdir(), `typeclaw-startup-vector-${randomUUID()}`)
  testDirs.push(agentDir)
  mkdirSync(join(agentDir, 'memory', 'topics'), { recursive: true })
  return agentDir
}

function writeTopic(agentDir: string, slug: string, heading: string, body: string): void {
  writeFileSync(
    join(agentDir, 'memory', 'topics', `${slug}.md`),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-06-11' }, body),
  )
}

function writeFragment(agentDir: string, date: string, id: string, topic: string, body: string): void {
  mkdirSync(join(agentDir, 'memory', 'streams'), { recursive: true })
  writeFileSync(
    join(agentDir, 'memory', 'streams', `${date}.jsonl`),
    `${JSON.stringify({ type: 'fragment', id, ts: '2026-06-11T00:00:00.000Z', source: 'test', entry: 'test', topic, body })}\n`,
  )
}

function vector(values: Record<number, number>): Float32Array {
  const result = new Float32Array(8)
  for (const [index, value] of Object.entries(values)) {
    result[Number(index)] = value
  }
  return result
}
