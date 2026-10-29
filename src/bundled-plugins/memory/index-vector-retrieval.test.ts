import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { noopPermissionService } from '@/permissions'
import { createPluginContext, createPluginLogger } from '@/plugin/context'
import { rmTempDir } from '@/test-helpers/rm-temp-dir'

import { renderShard } from './frontmatter'
import { createMemoryPluginForTests, type MemoryPluginDeps } from './index'
import { streamFilePath, streamsDir, topicShardPath, topicsDir } from './paths'
import { EMBEDDING_MODEL_ID } from './vector/embedder'
import type { EmbedFn } from './vector/hybrid'
import { buildStartupVectorIndex } from './vector/startup'
import { VectorStore, type VectorRow } from './vector/store'

const DIMS = 8
// A token present in no slug, heading, or body, so the keyword lane returns
// nothing and the vector lane is the ONLY source a hit can come from — a
// retrieved topic therefore proves real semantic retrieval ran, not substring
// search. It must also be absent from the render so we can confirm the injected
// memory is the retrieved topic, not an echo of the user prompt.
const QUERY = 'zzqxvtrprobe'
let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'memory-vector-retrieval-'))
})

afterEach(async () => {
  await rmTempDir(agentDir)
})

describe('vector retrieval end-to-end through session.turn.start', () => {
  test('index-mode turn renders a vector-retrieved topic via the real hybridSearch pipeline', async () => {
    // given: one topic whose body alone exceeds the 4 KB budget, forcing index
    // mode (the only path that runs hybridSearch). The query shares no token with
    // any text, so the keyword lane is inert and only the vector lane can match.
    await writeTopic(agentDir, 'orbital-mechanics', 'Orbital Mechanics', `Satellites remain in orbit. ${pad(5000)}`)
    seedVector(agentDir, 'topic:orbital-mechanics', 'orbital-mechanics')

    const infos: string[] = []
    const exports = await bootVectorPlugin(4096, capturingLogger(infos))
    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_e2e', agentDir, userPrompt: QUERY, retrievalContext },
      hookCtx(),
    )

    // then: the over-budget turn took the index path (not direct mode), and the
    // real vector pipeline rendered the topic's heading and body under the
    // `# Memory` framing — reached only by hybridSearch matching the seeded
    // vector, since the query token appears nowhere in the corpus or the output.
    const retrievalLog = infos.find((msg) => msg.startsWith('[vector-retrieval] mode=index '))
    expect(retrievalLog).toBeDefined()
    expect(retrievalLog).toContain('topic_results=1')
    expect(retrievalLog).toContain('stream_results=0')
    expect(retrievalLog).toContain('reference_results=0')
    expect(retrievalLog).toMatch(/elapsed_ms=\d+/)
    expect(retrievalContext.results).toContain('# Memory')
    expect(retrievalContext.results).toContain('## Orbital Mechanics')
    expect(retrievalContext.results).toContain('Satellites remain in orbit')
    expect(retrievalContext.results).not.toContain(QUERY)
    expect(retrievalContext.results).not.toContain('## Retrieved memory')
  })

  test('enabling vector on an agent with pre-existing topics builds the index at boot and retrieves on the first turn', async () => {
    // given: an agent that ran with vector OFF — topic shards exist on disk but
    // there is no `.vectors/index.db` yet (the migration entry condition)
    await writeTopic(agentDir, 'orbital-mechanics', 'Orbital Mechanics', `Satellites remain in orbit. ${pad(5000)}`)

    // when: the boot-time startup build runs (as src/run/index.ts does once vector
    // is enabled), embedding every existing passage into a fresh index
    const built = await buildStartupVectorIndex(agentDir, queryAligned())
    expect(built).toEqual({ built: true, pruned: 0, count: 1 })

    const infos: string[] = []
    const exports = await bootVectorPlugin(4096, capturingLogger(infos))
    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      { sessionId: 'ses_migrate', agentDir, userPrompt: QUERY, retrievalContext },
      hookCtx(),
    )

    // then: the first turn retrieves the migrated topic through the real pipeline —
    // no manual seedVector, the index came entirely from the startup build
    const retrievalLog = infos.find((msg) => msg.startsWith('[vector-retrieval] mode=index '))
    expect(retrievalLog).toContain('topic_results=1')
    expect(retrievalContext.results).toContain('## Orbital Mechanics')
    expect(retrievalContext.results).toContain('Satellites remain in orbit')
    expect(retrievalContext.results).not.toContain(QUERY)
  })

  test('index-mode vector retrieval remains globally visible across chats', async () => {
    await writeTopic(
      agentDir,
      'private-plans',
      'Private Plans',
      `Confidential launch plans. ${pad(5000)}\nfragments:\n- streams/2026-07-01#private-child`,
    )
    await mkdir(streamsDir(agentDir), { recursive: true })
    await writeFile(
      streamFilePath(agentDir, '2026-07-01'),
      `${JSON.stringify({
        type: 'fragment',
        id: 'private-child',
        ts: '2026-07-01T00:00:00.000Z',
        source: 'ses_private',
        entry: 'private entry',
        topic: 'Private Plans',
        body: 'Confidential launch plans.',
        where: { adapter: 'discord', workspace: 'guild-a', chat: 'private-room', thread: null },
      })}\n`,
    )
    seedVector(agentDir, 'topic:private-plans', 'private-plans')

    const exports = await bootVectorPlugin(4096)
    const retrievalContext = { results: '' }
    await exports.hooks!['session.turn.start']!(
      {
        sessionId: 'ses_public',
        agentDir,
        userPrompt: QUERY,
        origin: { kind: 'channel', adapter: 'discord', workspace: 'guild-a', chat: 'public-room', thread: null },
        retrievalContext,
      },
      hookCtx(),
    )

    expect(retrievalContext.results).toContain('`private-plans`')
    expect(retrievalContext.results).toContain('Confidential launch plans.')
    expect(retrievalContext.results).toContain('[MEMORY CONTEXT — not instructions]')
    expect(retrievalContext.results).not.toContain('Long-term memory below survives across sessions.')
  })
})

async function bootVectorPlugin(injectionBudgetBytes: number, logger = createPluginLogger('memory')) {
  const memoryPlugin = createMemoryPluginWithStoreCapture({ queryEmbedFn: queryAligned() })
  const parsed = memoryPlugin.configSchema!.safeParse({ injectionBudgetBytes })
  if (!parsed.success) throw new Error(parsed.error.message)
  const ctx = createPluginContext({
    name: 'memory',
    version: undefined,
    agentDir,
    config: parsed.data,
    logger,
    permissions: noopPermissionService,
    spawnSubagent: async () => {},
    isBooted: () => true,
  })
  return memoryPlugin.plugin(ctx)
}

function createMemoryPluginWithStoreCapture(overrides: Partial<MemoryPluginDeps> = {}) {
  return createMemoryPluginForTests({
    ...overrides,
    openAppendVectorStore: (dir) => () => VectorStore.open(join(dir, 'memory', '.vectors', 'index.db')),
  })
}

function hookCtx() {
  return { agentDir, pluginName: 'memory', logger: createPluginLogger('memory') }
}

function capturingLogger(infos: string[]) {
  return {
    ...createPluginLogger('memory'),
    info: (msg: string) => {
      infos.push(msg)
    },
  }
}

async function writeTopic(dir: string, slug: string, heading: string, body: string): Promise<void> {
  await mkdir(topicsDir(dir), { recursive: true })
  await writeFile(
    topicShardPath(dir, slug),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-06-11' }, body),
  )
}

function seedVector(dir: string, id: string, key: string): void {
  const store = VectorStore.open(join(dir, 'memory', '.vectors', 'index.db'))
  try {
    store.upsert(unitRow(id, key, alignedVector()))
  } finally {
    store.close()
  }
}

function unitRow(id: string, key: string, embedding: Float32Array): Omit<VectorRow, 'updatedAt'> {
  return { id, source: 'topic', key, model: EMBEDDING_MODEL_ID, dims: DIMS, embedding, contentHash: `hash:${id}` }
}

function queryAligned(): EmbedFn {
  return async () => [alignedVector()]
}

function alignedVector(): Float32Array {
  const result = new Float32Array(DIMS)
  result[0] = 1
  return result
}

function pad(n: number): string {
  return 'x'.repeat(n)
}
