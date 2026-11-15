import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'

import { renderShard } from './frontmatter'
import { referenceFilePath, referencesDir, streamFilePath, streamsDir, topicShardPath, topicsDir } from './paths'
import { renderReference } from './references/frontmatter'
import { loadReference } from './references/load-references'
import { vectorDbPath } from './search-command'
import { createMemorySearchTool } from './search-tool'
import { appendEvents } from './stream-io'
import { DIMS, EMBEDDING_MODEL_ID } from './vector/embedder'
import type { EmbedFn } from './vector/hybrid'
import { VectorStore } from './vector/store'

let agentDir: string
const warnings: string[] = []
const aligned = new Float32Array(DIMS)
aligned[0] = 1
const embed: EmbedFn = async () => [aligned]

beforeEach(async () => {
  agentDir = await mkdtemp('/tmp/memory-tool-')
  warnings.length = 0
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

test.each(['satellite trajectories', '위성의 궤적'])('default query recalls a topic by meaning: %s', async (query) => {
  await topic('orbit', 'Orbital mechanics', 'Gravity keeps moons aloft.\n')
  seed('topic', 'orbit')

  const result = await call({ query, full: true })

  expect(result.details).toMatchObject({
    matches: [
      { source: 'topic', slug: 'orbit', heading: 'Orbital mechanics', fullBody: 'Gravity keeps moons aloft.\n' },
    ],
  })
  expect(warnings).toEqual([])
})

test.each([
  { query: 'moons missing', slugs: ['orbit'] },
  { query: 'satellite trajectories', slugs: [] },
])('lexical mode keeps the existing query behavior without embedding: %j', async ({ query, slugs }) => {
  await topic('orbit', 'Orbital mechanics', 'Gravity keeps moons aloft.\n')
  seed('topic', 'orbit')

  const result = await call({ query, mode: 'lexical' }, async () => {
    throw new Error('lexical must not embed')
  })

  expect(result.details).toEqual({
    matches: slugs.map((slug) => expect.objectContaining({ source: 'topic', slug })),
  })
  expect(warnings).toEqual([])
})

test.each([{ query: 'moons.*aloft', asRegex: true }, { topic: 'orbit' }])(
  'exact lookup bypasses embedding: %j',
  async (input) => {
    await topic('orbit', 'Orbital mechanics', 'Gravity keeps moons aloft.\n')
    seed('topic', 'orbit')

    const result = await call(input, async () => {
      throw new Error('exact lookup must not embed')
    })

    expect(result.details).toMatchObject({ matches: [{ source: 'topic', slug: 'orbit' }] })
    expect(warnings).toEqual([])
  },
)

test('missing index reports lexical fallback and preserves lexical results', async () => {
  await topic('orbit', 'Orbital mechanics', 'Gravity keeps moons aloft.\n')

  const result = await call({ query: 'moons' })

  expect(result.details).toMatchObject({ matches: [{ source: 'topic', slug: 'orbit' }] })
  expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('lexical results') })])
  expect(warnings).toEqual([expect.stringContaining('index.db is absent')])
})

test('embedding failure reports its cause and falls back for this call', async () => {
  await topic('orbit', 'Orbital mechanics', 'Gravity keeps moons aloft.\n')
  seed('topic', 'orbit')

  const result = await call({ query: 'moons' }, async () => {
    throw new Error('embedding offline')
  })

  expect(result.details).toMatchObject({ matches: [{ source: 'topic', slug: 'orbit' }] })
  expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('lexical results') })])
  expect(warnings).toEqual([expect.stringContaining('embedding offline')])
})

test.each([{ chat: 'room' }, { where: 'room' }])(
  'hybrid scope restricts topics and returned children: %j',
  async (chat) => {
    await mkdir(streamsDir(agentDir), { recursive: true })
    await appendEvents(streamFilePath(agentDir, '2026-06-01'), [
      {
        type: 'fragment',
        id: 'yes',
        ts: '2026-06-01T00:00:00Z',
        source: 'session',
        entry: '1',
        topic: 'Physics',
        body: 'Moons follow gravity.',
        who: 'Alice',
        where: { adapter: 'slack', workspace: 'space', chat: 'room', thread: 'thread' },
      },
      {
        type: 'fragment',
        id: 'no',
        ts: '2026-06-01T00:00:00Z',
        source: 'session',
        entry: '2',
        topic: 'Physics',
        body: 'Planets follow gravity.',
        where: { adapter: 'slack', workspace: 'other', chat: 'elsewhere', thread: 'other' },
      },
    ])
    await topic(
      'orbit',
      'Orbital mechanics',
      'Current belief.\nfragments:\n- streams/2026-06-01#yes\n- streams/2026-06-01#no\n',
    )
    await topic('excluded', 'Other mechanics', 'Other belief.\nfragments:\n- streams/2026-06-01#no\n')
    seed('topic', 'orbit')
    seed('topic', 'excluded')

    const result = await call({ query: 'satellite trajectories', workspace: 'space', thread: 'thread', ...chat })

    expect(result.details).toEqual({
      matches: [
        expect.objectContaining({
          source: 'topic',
          slug: 'orbit',
          provenance: [expect.objectContaining({ citation: 'streams/2026-06-01#yes', who: 'Alice' })],
        }),
      ],
    })
  },
)

test.each([0, 1])('maxResults bounds hybrid results: %i', async (maxResults) => {
  await topic('a', 'First', 'Gravity keeps moons aloft.\n')
  await topic('b', 'Second', 'Planets remain stable.\n')
  seed('topic', 'a')
  seed('topic', 'b')

  const result = await call({ query: 'satellite trajectories', maxResults })

  expect(result.details).toEqual({
    matches: Array.from({ length: maxResults }, () => expect.objectContaining({ source: 'topic' })),
  })
})

test('full reference hits load the body and record access', async () => {
  await mkdir(referencesDir(agentDir), { recursive: true })
  await writeFile(
    referenceFilePath(agentDir, 'manual'),
    renderReference(
      {
        title: 'Mechanics manual',
        origin: 'episode',
        created: '2026-06-01T00:00:00Z',
        lastAccessed: '2026-06-01T00:00:00Z',
        accessCount: 0,
        pinned: false,
        demoted: false,
        tags: [],
      },
      'Gravity keeps moons aloft.\n',
    ),
  )
  seed('reference', 'manual')

  const result = await call({ query: 'satellite trajectories', full: true })

  expect(result.details).toMatchObject({
    matches: [
      { source: 'reference', slug: 'manual', title: 'Mechanics manual', fullBody: 'Gravity keeps moons aloft.\n' },
    ],
  })
  expect((await loadReference(agentDir, 'manual'))?.frontmatter.accessCount).toBe(1)
})

test('full stream hits retain canonical event IDs and captured provenance', async () => {
  await mkdir(streamsDir(agentDir), { recursive: true })
  await appendEvents(streamFilePath(agentDir, '2026-06-01'), [
    {
      type: 'fragment',
      id: 'fresh',
      ts: '2026-06-01T00:00:00Z',
      source: 'session',
      entry: '1',
      topic: 'Physics',
      body: 'Gravity keeps moons aloft.\n',
      who: 'Alice',
      where: { adapter: 'slack', workspace: 'space', chat: 'room' },
    },
  ])
  const store = VectorStore.open(vectorDbPath(agentDir))
  store.close()

  const result = await call({ query: 'moons', full: true })

  expect(result.details).toMatchObject({
    matches: [
      {
        source: 'stream',
        eventId: 'streams/2026-06-01#fresh',
        topic: 'Physics',
        fullBody: 'Gravity keeps moons aloft.\n',
        who: 'Alice',
        where: { chat: 'room' },
      },
    ],
  })
})

async function call(input: unknown, embedFn = embed) {
  const tool = createMemorySearchTool(embedFn)
  return tool.execute(tool.parameters.parse(input), {
    agentDir,
    sessionId: 'test',
    signal: undefined,
    logger: {
      info() {},
      warn(message) {
        warnings.push(message)
      },
      error() {},
    },
  })
}

async function topic(slug: string, heading: string, body: string) {
  await mkdir(topicsDir(agentDir), { recursive: true })
  await writeFile(
    topicShardPath(agentDir, slug),
    renderShard(
      {
        heading,
        cites: 1,
        days: 1,
        lastReinforced: '2026-06-01',
      },
      body,
    ),
  )
}

function seed(source: 'topic' | 'reference', key: string) {
  const store = VectorStore.open(vectorDbPath(agentDir))
  try {
    store.upsert({
      id: `${source}:${key}`,
      source,
      key,
      model: EMBEDDING_MODEL_ID,
      dims: DIMS,
      embedding: aligned,
      contentHash: `hash:${key}`,
    })
  } finally {
    store.close()
  }
}
