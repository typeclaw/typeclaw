import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AdapterId } from '@/channels/schema'

import { renderShard } from '../frontmatter'
import { renderReference } from '../references/frontmatter'
import { EMBEDDING_MODEL_ID } from './embedder'
import { hybridSearch, type EmbedFn } from './hybrid'
import { VectorStore, type VectorRow } from './store'
import { boundEmbeddableText, TEXT_TOKEN_BUDGET } from './truncation'

const MODEL = EMBEDDING_MODEL_ID
const testDirs: string[] = []

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('hybridSearch', () => {
  it('QA 1.6: sums vector + keyword reciprocal ranks for a hit found by both lanes', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeTopic(agentDir, 'pr-651', 'PR 651 Review', 'PR #651 fixed channel reload handling.')
      writeTopic(
        agentDir,
        'semantic-cache',
        'Retrieval Cache',
        'Vector memory writes focused summaries after retrieval.',
      )
      store.upsert(row('topic:pr-651', 'pr-651', vector({ 0: 1 })))
      store.upsert(row('topic:semantic-cache', 'semantic-cache', vector({ 1: 1 })))

      const exactResults = await hybridSearch('PR #651', store, agentDir, 3, embedFrom({ 0: 1 }))
      const exact = exactResults.find((result) => result.key === 'pr-651')

      expect(exactResults.slice(0, 3).map((result) => result.key)).toContain('pr-651')
      expect(exact?.rrfScore).toBeCloseTo(1 / 61 + 1 / 61, 10)

      // A natural-language prompt whose words ('focused', 'memory', 'retrieval')
      // appear scattered in the body — never as the whole phrase. The token-OR
      // keyword fallback corroborates the vector hit, so both lanes sum (2/61).
      const semanticResults = await hybridSearch(
        'focused memory summary retrieval',
        store,
        agentDir,
        3,
        embedFrom({ 1: 1 }),
      )
      const semantic = semanticResults.find((result) => result.key === 'semantic-cache')

      expect(semanticResults.slice(0, 3).map((result) => result.key)).toContain('semantic-cache')
      expect(semantic?.rrfScore).toBeCloseTo(1 / 61 + 1 / 61, 10)
    } finally {
      store.close()
    }
  })

  it('lifts a low-vector-rank topic above pure-cosine noise when the keyword lane corroborates', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeTopic(agentDir, 'person-note', 'Person Note', 'Reply conventions for 홍길동 in the group chat.')
      writeTopic(agentDir, 'noise-a', 'Noise A', 'Unrelated English PR review note about channel reload.')
      writeTopic(agentDir, 'noise-b', 'Noise B', 'Another unrelated English note about docker builds.')

      store.upsert(row('topic:noise-a', 'noise-a', vector({ 0: 0.9 })))
      store.upsert(row('topic:noise-b', 'noise-b', vector({ 0: 0.8 })))
      store.upsert(row('topic:person-note', 'person-note', vector({ 0: 0.1 })))

      const results = await hybridSearch('홍길동', store, agentDir, 3, embedFrom({ 0: 1 }))

      expect(results[0]?.key).toBe('person-note')
      expect(results[0]?.rrfScore).toBeGreaterThan(results[1]?.rrfScore ?? 0)
    } finally {
      store.close()
    }
  })

  it('QA 1.7: multilingual query can retrieve an English shard through the vector lane', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeTopic(
        agentDir,
        'english-i18n',
        'Internationalization Notes',
        'The UI supports Japanese and Korean locale routing.',
      )
      writeTopic(agentDir, 'docker-builds', 'Docker Builds', 'The base image build uses GHCR before npm publication.')
      store.upsert(row('topic:english-i18n', 'english-i18n', vector({ 2: 1 })))
      store.upsert(row('topic:docker-builds', 'docker-builds', vector({ 3: 1 })))

      const results = await hybridSearch(
        '한국어와 일본어 로케일은 어디에서 처리돼?',
        store,
        agentDir,
        3,
        embedFrom({ 2: 1 }),
      )

      expect(results.slice(0, 3).map((result) => result.key)).toContain('english-i18n')
      expect(results.find((result) => result.key === 'english-i18n')?.rrfScore).toBeCloseTo(1 / 61, 10)
    } finally {
      store.close()
    }
  })

  it('collapses a matched stream fragment to the topic that cites it', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given a fragment cited by a topic, and a vector hit on that fragment
      const fragmentId = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
      writeTopic(
        agentDir,
        'package-manager',
        'Package Manager',
        ['User uses pnpm.', 'fragments:', `- streams/2026-06-10#${fragmentId}`].join('\n'),
      )
      writeStreamFragment(agentDir, '2026-06-10', fragmentId, 'pnpm', 'User installs with pnpm.')
      store.upsert(row(`stream:2026-06-10#${fragmentId}`, `2026-06-10#${fragmentId}`, vector({ 0: 1 }), 'stream'))
      // production always embeds every shard, so the citing topic has a vector;
      // it is off-query here so the stream hit (cosine 1) clearly stands above it
      store.upsert(row('topic:package-manager', 'package-manager', vector({ 5: 1 })))

      // when the fragment matches by vector
      const results = await hybridSearch('pnpm', store, agentDir, 5, embedFrom({ 0: 1 }))

      // then the result is the parent topic, not the standalone fragment
      const keys = results.map((result) => result.key)
      expect(keys).toContain('package-manager')
      expect(results.find((result) => result.source === 'stream')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('collapses a matched fragment to EVERY topic that cites it', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given one fragment cited by two distinct topics
      const fragmentId = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
      writeTopic(
        agentDir,
        'package-manager',
        'Package Manager',
        ['User uses pnpm.', 'fragments:', `- streams/2026-06-10#${fragmentId}`].join('\n'),
      )
      writeTopic(
        agentDir,
        'docker-preferences',
        'Docker Preferences',
        ['User prefers minimal images.', 'fragments:', `- streams/2026-06-10#${fragmentId}`].join('\n'),
      )
      writeStreamFragment(agentDir, '2026-06-10', fragmentId, 'pnpm', 'Uses pnpm and minimal Docker images.')
      store.upsert(row(`stream:2026-06-10#${fragmentId}`, `2026-06-10#${fragmentId}`, vector({ 0: 1 }), 'stream'))
      // production always embeds every shard; both citing topics carry off-query
      // vectors so the stream hit (cosine 1) clearly stands above them
      store.upsert(row('topic:package-manager', 'package-manager', vector({ 5: 1 })))
      store.upsert(row('topic:docker-preferences', 'docker-preferences', vector({ 6: 1 })))

      // when the shared fragment matches by vector
      const results = await hybridSearch('pnpm docker', store, agentDir, 5, embedFrom({ 0: 1 }))

      // then BOTH citing topics surface, and the fragment never appears standalone
      const keys = results.map((result) => result.key)
      expect(keys).toContain('package-manager')
      expect(keys).toContain('docker-preferences')
      expect(results.find((result) => result.source === 'stream')).toBeUndefined()
    } finally {
      store.close()
    }
  })

  it('ranks a parent by the MAX of its children, not the sum', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given a topic citing two fragments, both matched by the keyword lane
      const idA = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
      const idB = '019e2ecf-f2d5-70ee-83f6-005fb5451c51'
      writeTopic(
        agentDir,
        'editor',
        'Editor',
        ['User uses neovim.', 'fragments:', `- streams/2026-06-10#${idA}`, `- streams/2026-06-10#${idB}`].join('\n'),
      )
      writeStreamFragment(agentDir, '2026-06-10', idA, 'neovim', 'neovim is the editor.')
      writeStreamFragment(agentDir, '2026-06-10', idB, 'neovim', 'neovim config lives in lua.')

      // when both fragments match the keyword lane (no vector hits)
      const results = await hybridSearch('neovim', store, agentDir, 5, embedFrom({ 7: 1 }))
      const editor = results.find((result) => result.key === 'editor')

      // then the parent score is a single best-child RRF score, not the sum of both
      expect(editor).toBeDefined()
      expect(editor!.rrfScore).toBeLessThanOrEqual(1 / 61 + 1e-9)
    } finally {
      store.close()
    }
  })

  it('never returns a superseded fragment as a standalone keyword/stream result', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given a topic whose belief switched to pnpm, keeping the bun fragment superseded
      const activeId = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
      const supersededId = '019e2ecf-f2d5-70ee-83f6-005fb5451c51'
      writeTopic(
        agentDir,
        'package-manager',
        'Package Manager',
        [
          'User uses pnpm.',
          'fragments:',
          `- streams/2026-06-10#${activeId}`,
          'superseded:',
          `- streams/2026-06-10#${supersededId}`,
        ].join('\n'),
      )
      // both fragment bodies are on the live stream and both match the keyword "bun"
      writeStreamFragments(agentDir, '2026-06-10', [
        { id: activeId, topic: 'pnpm', body: 'User switched to pnpm from bun.' },
        { id: supersededId, topic: 'bun', body: 'User uses bun as the package manager.' },
      ])

      // when the query matches the superseded body (no vector hits)
      const results = await hybridSearch('bun', store, agentDir, 5, embedFrom({ 7: 1 }))

      // then the superseded fragment never appears as a standalone stream result
      expect(results.some((result) => result.source === 'stream')).toBe(false)
      expect(results.some((result) => result.key === `2026-06-10#${supersededId}`)).toBe(false)
    } finally {
      store.close()
    }
  })

  it('keeps an undreamed fragment (no citing topic) as a stream result', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given a fragment that no topic cites yet (freshness window)
      const fragmentId = '019e2ee8-bcc4-772f-8821-876162c5e601'
      writeStreamFragment(agentDir, '2026-06-11', fragmentId, 'deno', 'User is trying deno today.')
      store.upsert(row(`stream:2026-06-11#${fragmentId}`, `2026-06-11#${fragmentId}`, vector({ 0: 1 }), 'stream'))

      // when it matches
      const results = await hybridSearch('deno', store, agentDir, 5, embedFrom({ 0: 1 }))

      // then it resolves to itself as a stream result
      const hit = results.find((result) => result.source === 'stream')
      expect(hit?.key).toBe(`2026-06-11#${fragmentId}`)
    } finally {
      store.close()
    }
  })

  it('collapses a matched reference chunk to its parent reference', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeReference(agentDir, 'ref-a', 'Reference A', 'The reference body mentions a sardonyx deployment runbook.')
      store.upsert(row('reference:ref-a#0', 'ref-a', vector({ 0: 1 }), 'reference'))

      const results = await hybridSearch('sardonyx deployment', store, agentDir, 5, embedFrom({ 0: 1 }))

      expect(results).toContainEqual(expect.objectContaining({ source: 'reference', key: 'ref-a' }))
      expect(results.map((result) => result.key)).not.toContain('ref-a#0')
    } finally {
      store.close()
    }
  })
})

describe('hybridSearch keyword lane', () => {
  it('matches dreamed topic provenance and collapses the keyword hit to its parent topic', async () => {
    const { agentDir, store } = createFixture()
    try {
      const fragmentId = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
      writeTopic(
        agentDir,
        'shared-workspace-policy',
        'Server policy',
        `Keep replies concise.\nfragments:\n- streams/2026-06-10#${fragmentId}`,
      )
      writeStreamFragments(agentDir, '2026-06-10', [
        {
          id: fragmentId,
          topic: 'Unrelated capture topic',
          body: 'No workspace words in content.',
          where: {
            adapter: 'discord',
            workspace: 'guild-example',
            workspaceName: 'Example Guild',
            chat: 'room-1',
            thread: null,
          },
        },
      ])
      store.upsert(row('topic:shared-workspace-policy', 'shared-workspace-policy', vector({ 5: 1 })))

      const results = await hybridSearch('Example Guild', store, agentDir, 5, embedFrom({ 0: 1 }))

      expect(results.map((result) => result.key)).toContain('shared-workspace-policy')
      expect(results.find((result) => result.key === 'shared-workspace-policy')?.provenance?.[0]).toMatchObject({
        citation: `streams/2026-06-10#${fragmentId}`,
        where: { workspaceName: 'Example Guild' },
      })
    } finally {
      store.close()
    }
  })

  it('workspace scope filters provenance without hiding a topic that has matching evidence', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeStreamFragments(agentDir, '2026-06-10', [
        {
          id: 'local-child',
          topic: 'Marker',
          body: 'scope marker local',
          where: { adapter: 'discord', workspace: '201', chat: '301', thread: null },
        },
        {
          id: 'foreign-child',
          topic: 'Marker',
          body: 'scope marker foreign',
          where: { adapter: 'discord', workspace: '202', chat: '302', thread: null },
        },
      ])
      writeTopic(
        agentDir,
        'mixed-topic',
        'Mixed topic',
        'scope marker mixed body\nfragments:\n- streams/2026-06-10#local-child\n- streams/2026-06-10#foreign-child',
      )
      writeTopic(
        agentDir,
        'local-topic',
        'Local topic',
        'scope marker local body\nfragments:\n- streams/2026-06-10#local-child',
      )

      const results = await hybridSearch('scope marker', store, agentDir, 10, embedFrom({ 7: 1 }), {
        scope: { workspace: '201' },
      })

      expect(results.map((result) => result.key)).toContain('local-topic')
      expect(results.map((result) => result.key)).toContain('mixed-topic')
      expect(results.some((result) => result.where?.workspace === '202')).toBe(false)
    } finally {
      store.close()
    }
  })

  it('workspace scope rejects a mixed topic reached only through a foreign child vector', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeStreamFragments(agentDir, '2026-06-10', [
        {
          id: 'mixed-local-child',
          topic: 'Mixed local',
          body: 'Local evidence.',
          where: { adapter: 'discord', workspace: '201', chat: '301', thread: null },
        },
        {
          id: 'mixed-foreign-child',
          topic: 'Mixed foreign',
          body: 'Foreign evidence.',
          where: { adapter: 'discord', workspace: '202', chat: '302', thread: null },
        },
        {
          id: 'local-baseline-a',
          topic: 'Local baseline A',
          body: 'Local baseline A.',
          where: { adapter: 'discord', workspace: '201', chat: '301', thread: null },
        },
        {
          id: 'local-baseline-b',
          topic: 'Local baseline B',
          body: 'Local baseline B.',
          where: { adapter: 'discord', workspace: '201', chat: '301', thread: null },
        },
      ])
      writeTopic(
        agentDir,
        'mixed-vector-topic',
        'Mixed vector topic',
        'Mixed belief.\nfragments:\n- streams/2026-06-10#mixed-local-child\n- streams/2026-06-10#mixed-foreign-child',
      )
      writeTopic(
        agentDir,
        'local-baseline-a',
        'Local baseline A',
        'Local baseline A.\nfragments:\n- streams/2026-06-10#local-baseline-a',
      )
      writeTopic(
        agentDir,
        'local-baseline-b',
        'Local baseline B',
        'Local baseline B.\nfragments:\n- streams/2026-06-10#local-baseline-b',
      )
      store.upsert(
        row('stream:2026-06-10#mixed-foreign-child', '2026-06-10#mixed-foreign-child', vector({ 0: 1 }), 'stream'),
      )
      store.upsert(row('topic:local-baseline-a', 'local-baseline-a', vector({ 0: 0.8, 1: 0.6 })))
      store.upsert(row('topic:local-baseline-b', 'local-baseline-b', vector({ 0: 0.79, 1: 0.61 })))

      const results = await hybridSearch('zz-foreign-vector-only', store, agentDir, 10, embedFrom({ 0: 1 }), {
        scope: { workspace: '201' },
      })

      expect(results.map((result) => result.key)).not.toContain('mixed-vector-topic')
    } finally {
      store.close()
    }
  })

  it('derives superseded state from excluded shards before scoped stream eligibility', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeStreamFragments(agentDir, '2026-06-10', [
        {
          id: 'local-stale',
          topic: 'Old policy',
          body: 'superseded-only-marker',
          where: { adapter: 'discord', workspace: '201', chat: '301', thread: null },
        },
        {
          id: 'foreign-active',
          topic: 'Current policy',
          body: 'foreign current evidence',
          where: { adapter: 'discord', workspace: '202', chat: '302', thread: null },
        },
      ])
      writeTopic(
        agentDir,
        'excluded-parent',
        'Excluded parent',
        'Foreign current policy.\nfragments:\n- streams/2026-06-10#foreign-active\nsuperseded:\n- streams/2026-06-10#local-stale',
      )

      const results = await hybridSearch('superseded-only-marker', store, agentDir, 10, embedFrom({ 7: 1 }), {
        scope: { workspace: '201' },
      })

      expect(results.some((result) => result.source === 'stream' && result.key.endsWith('#local-stale'))).toBe(false)
      expect(results.some((result) => result.key === 'excluded-parent')).toBe(false)
    } finally {
      store.close()
    }
  })

  it('treats Discord DM chat scope as immutable inside the shared @dm workspace', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeStreamFragments(agentDir, '2026-06-10', [
        {
          id: 'dm-a-child',
          topic: 'DM A',
          body: 'local-dm-marker',
          where: { adapter: 'discord', workspace: '@dm', chat: 'dm-a', thread: null },
        },
        {
          id: 'dm-b-child',
          topic: 'DM B',
          body: 'foreign-dm-marker',
          where: { adapter: 'discord', workspace: '@dm', chat: 'dm-b', thread: null },
        },
      ])
      writeTopic(agentDir, 'dm-a-topic', 'DM A', 'local-dm-marker\nfragments:\n- streams/2026-06-10#dm-a-child')
      writeTopic(agentDir, 'dm-b-topic', 'DM B', 'foreign-dm-marker\nfragments:\n- streams/2026-06-10#dm-b-child')

      const results = await hybridSearch('foreign-dm-marker', store, agentDir, 10, embedFrom({ 7: 1 }), {
        scope: { workspace: '@dm', chat: 'dm-a' },
      })

      expect(results.some((result) => result.key === 'dm-b-topic')).toBe(false)
      expect(results.some((result) => result.where?.chat === 'dm-b')).toBe(false)
    } finally {
      store.close()
    }
  })

  it('isolates every shared-workspace adapter shape inside hybrid retrieval', async () => {
    const { agentDir, store } = createFixture()
    try {
      const workspaces = {
        discord: '@dm',
        'discord-bot': '@dm',
        slack: '@dm',
        'slack-bot': '@dm',
        webex: '@dm',
        'webex-bot': '@dm',
        instagram: '@instagram-dm',
        line: '@line-dm',
        kakaotalk: '@kakao-dm',
        teams: 'teams',
        'telegram-bot': 'telegram',
      } satisfies Partial<Record<AdapterId, string>>
      const fragments: Parameters<typeof writeStreamFragments>[2] = []
      for (const [adapter, workspace] of Object.entries(workspaces) as Array<[AdapterId, string]>) {
        fragments.push(
          {
            id: `${adapter}-local`,
            topic: 'Local',
            body: `${adapter}-local-hybrid-marker`,
            where: { adapter, workspace, chat: 'chat-a', thread: null },
          },
          {
            id: `${adapter}-foreign`,
            topic: 'Foreign',
            body: `${adapter}-foreign-hybrid-marker`,
            where: { adapter, workspace, chat: 'chat-b', thread: null },
          },
        )
        writeTopic(
          agentDir,
          `${adapter}-local-hybrid`,
          'Local',
          `${adapter}-local-hybrid-marker\nfragments:\n- streams/2026-06-10#${adapter}-local`,
        )
        writeTopic(
          agentDir,
          `${adapter}-foreign-hybrid`,
          'Foreign',
          `${adapter}-foreign-hybrid-marker\nfragments:\n- streams/2026-06-10#${adapter}-foreign`,
        )
      }
      writeStreamFragments(agentDir, '2026-06-10', fragments)

      for (const [adapter, workspace] of Object.entries(workspaces) as Array<[AdapterId, string]>) {
        const results = await hybridSearch(
          `${adapter}-foreign-hybrid-marker`,
          store,
          agentDir,
          10,
          embedFrom({ 7: 1 }),
          {
            scope: { workspace, chat: 'chat-a' },
          },
        )
        expect(results.some((result) => result.key === `${adapter}-foreign-hybrid`)).toBe(false)
        expect(results.some((result) => result.where?.chat === 'chat-b')).toBe(false)
      }
    } finally {
      store.close()
    }
  })

  it('isolates Slack MPIM group-DM topics by immutable chat ID', async () => {
    const { agentDir, store } = createFixture()
    try {
      const fragments: Parameters<typeof writeStreamFragments>[2] = []
      for (const adapter of ['slack', 'slack-bot'] as const) {
        fragments.push(
          {
            id: `${adapter}-mpim-local`,
            topic: 'Local MPIM',
            body: `${adapter}-mpim-local-hybrid`,
            where: { adapter, workspace: '@dm', chat: 'GLOCAL', thread: null },
          },
          {
            id: `${adapter}-mpim-foreign`,
            topic: 'Foreign MPIM',
            body: `${adapter}-mpim-foreign-hybrid`,
            where: { adapter, workspace: '@dm', chat: 'GFOREIGN', thread: null },
          },
        )
        writeTopic(
          agentDir,
          `${adapter}-mpim-local-topic`,
          'Local MPIM',
          `${adapter}-mpim-local-hybrid\nfragments:\n- streams/2026-06-10#${adapter}-mpim-local`,
        )
        writeTopic(
          agentDir,
          `${adapter}-mpim-foreign-topic`,
          'Foreign MPIM',
          `${adapter}-mpim-foreign-hybrid\nfragments:\n- streams/2026-06-10#${adapter}-mpim-foreign`,
        )
      }
      writeStreamFragments(agentDir, '2026-06-10', fragments)

      for (const adapter of ['slack', 'slack-bot'] as const) {
        const results = await hybridSearch(`${adapter}-mpim-foreign-hybrid`, store, agentDir, 10, embedFrom({ 7: 1 }), {
          scope: { workspace: '@dm', chat: 'GLOCAL' },
        })
        expect(results.some((result) => result.key === `${adapter}-mpim-foreign-topic`)).toBe(false)
        expect(results.some((result) => result.where?.chat === 'GFOREIGN')).toBe(false)
      }
    } finally {
      store.close()
    }
  })

  it('explicit scope excludes a foreign standalone undreamed stream', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeStreamFragments(agentDir, '2026-06-10', [
        {
          id: 'local-standalone',
          topic: 'Local standalone',
          body: 'shared-standalone-marker local',
          where: { adapter: 'slack', workspace: '@dm', chat: 'chat-a', thread: null },
        },
        {
          id: 'foreign-standalone',
          topic: 'Foreign standalone',
          body: 'shared-standalone-marker foreign',
          where: { adapter: 'slack', workspace: '@dm', chat: 'chat-b', thread: null },
        },
      ])

      const results = await hybridSearch('shared-standalone-marker', store, agentDir, 10, embedFrom({ 7: 1 }), {
        scope: { workspace: '@dm', chat: 'chat-a' },
      })

      expect(results.some((result) => result.source === 'stream' && result.where?.chat === 'chat-a')).toBe(true)
      expect(results.some((result) => result.source === 'stream' && result.where?.chat === 'chat-b')).toBe(false)
    } finally {
      store.close()
    }
  })

  it('explicit scope excludes standalone references without channel provenance', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeReference(agentDir, 'foreign-reference', 'Foreign Reference', 'foreign-reference-marker')

      const results = await hybridSearch('foreign-reference-marker', store, agentDir, 10, embedFrom({ 7: 1 }), {
        scope: { workspace: '@dm', chat: 'chat-a' },
      })

      expect(results.some((result) => result.source === 'reference')).toBe(false)
    } finally {
      store.close()
    }
  })

  it('retrieves a shard via token-OR fallback for a full natural-language prompt', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given a shard whose terms all appear, but never as the whole prompt phrase
      writeTopic(agentDir, 'channel-reload', 'Channel Reload', 'PR #651 fixed channel reload handling.')

      // when the query is a full sentence that never appears verbatim (no vector hit)
      const results = await hybridSearch(
        'where did we discuss the channel reload handling change',
        store,
        agentDir,
        5,
        embedFrom({ 7: 1 }),
      )

      // then the keyword lane still finds it via OR-matched tokens
      expect(results.map((r) => r.key)).toContain('channel-reload')
    } finally {
      store.close()
    }
  })

  it('ranks a multi-token match above an alphabetically-earlier single-token match', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given an alphabetically-early shard hitting one token and a late shard hitting two
      writeTopic(agentDir, 'aaa-single', 'AAA Single', 'Mentions only docker here.')
      writeTopic(agentDir, 'zzz-double', 'ZZZ Double', 'Mentions docker and reload together.')

      // when the prompt's tokens hit both (no vector hit, no verbatim phrase)
      const results = await hybridSearch('how do docker and reload interact', store, agentDir, 5, embedFrom({ 7: 1 }))

      // then the richer (two-token) match outranks the alphabetically-earlier one-token match
      const single = results.findIndex((r) => r.key === 'aaa-single')
      const double = results.findIndex((r) => r.key === 'zzz-double')
      expect(double).toBeGreaterThanOrEqual(0)
      expect(single).toBeGreaterThanOrEqual(0)
      expect(double).toBeLessThan(single)
    } finally {
      store.close()
    }
  })

  it('truncates the keyword lane after ranking, not alphabetically', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given many alphabetically-early one-token shards and one late two-token shard
      for (let i = 0; i < 12; i++) {
        writeTopic(agentDir, `aaa-${i}`, `Weak ${i}`, 'Only docker is mentioned here.')
      }
      writeTopic(agentDir, 'zzz-strong', 'Strong', 'Mentions docker and reload together.')

      // when topK=1 forces the lane to keep a single best result (no vector hit)
      const results = await hybridSearch('docker reload', store, agentDir, 1, embedFrom({ 7: 1 }))

      // then the late two-token match survives instead of an alphabetically-early weak one
      expect(results[0]?.key).toBe('zzz-strong')
    } finally {
      store.close()
    }
  })

  it('keeps exact-phrase precision when the whole query appears verbatim', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given two shards both containing every token, but only one the exact phrase
      writeTopic(agentDir, 'exact', 'Exact', 'The runbook says docker reload first.')
      writeTopic(agentDir, 'scattered', 'Scattered', 'Docker is here; reload is mentioned far away.')

      // when the query IS a verbatim phrase in one shard (no vector hit)
      const results = await hybridSearch('docker reload', store, agentDir, 5, embedFrom({ 7: 1 }))

      // then the phrase path returns the exact match and never widens to token-OR
      expect(results.map((r) => r.key)).toContain('exact')
      expect(results.map((r) => r.key)).not.toContain('scattered')
    } finally {
      store.close()
    }
  })

  it('injects no keyword-only memory for a low-information prompt of only common words', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given shards that happen to contain common function words in their bodies
      writeTopic(agentDir, 'note-a', 'Note A', 'We did say that it was about the thing here.')
      writeTopic(agentDir, 'note-b', 'Note B', 'What we have is over there with them.')

      // when the whole prompt carries no content token (vector lane gated out)
      const results = await hybridSearch('what did we say about it', store, agentDir, 5, embedFrom({ 7: 1 }))

      // then the keyword lane contributes nothing — no arbitrary memory is injected
      expect(results).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('keeps content tokens when a prompt mixes stopwords with real terms', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given a shard whose content words ('pr', '#651', 'reload') the prompt shares
      writeTopic(agentDir, 'pr-651', 'PR 651', 'PR #651 fixed channel reload handling.')

      // when the prompt buries those terms among stopwords (no vector hit)
      const results = await hybridSearch('how does the PR #651 reload work', store, agentDir, 5, embedFrom({ 7: 1 }))

      // then the surviving content tokens still retrieve the shard
      expect(results.map((r) => r.key)).toContain('pr-651')
    } finally {
      store.close()
    }
  })

  it('retrieves a non-ASCII (CJK) content token that the English stopword filter must not drop', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given a shard keyed on a Korean name
      writeTopic(agentDir, 'person-note', 'Person Note', 'Reply conventions for 홍길동 in the group chat.')

      // when a Korean prompt mixes the name with function words (no vector hit)
      const results = await hybridSearch('어디서 홍길동 얘기했지', store, agentDir, 5, embedFrom({ 7: 1 }))

      // then the non-ASCII token survives filtering and retrieves the shard
      expect(results.map((r) => r.key)).toContain('person-note')
    } finally {
      store.close()
    }
  })

  it('does not let a function-word-heavy legacy shard outrank the real content match', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given a verbose shard echoing ONLY the prompt's function words, and a
      // terse shard carrying the actual content terms
      writeTopic(agentDir, 'aaa-legacy', 'Legacy', 'Can you what we about the it over here they had this that.')
      writeTopic(agentDir, 'zzz-real', 'Real', 'The deploy schedule moved to Friday.')

      // when the prompt buries 'deploy schedule' among function words (no vector hit)
      const results = await hybridSearch(
        'can you what we about the deploy schedule',
        store,
        agentDir,
        5,
        embedFrom({ 7: 1 }),
      )

      // then only the real content shard surfaces; function words score nothing,
      // so the legacy shard never enters the lane
      expect(results[0]?.key).toBe('zzz-real')
      expect(results.map((r) => r.key)).not.toContain('aaa-legacy')
    } finally {
      store.close()
    }
  })

  it('does not match a short token inside an unrelated word (ascii-boundary)', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given a noise shard where 'in'/'do' only appear INSIDE other words
      writeTopic(agentDir, 'noise', 'Noise', 'Ongoing documentation lives in the index folder.')
      // and a real shard where the tokens stand alone
      writeTopic(agentDir, 'real', 'Real', 'CI uses Go for the deploy helper.')

      // when the query's tokens are short standalone words (no vector hit)
      const results = await hybridSearch('ci go', store, agentDir, 5, embedFrom({ 7: 1 }))

      // then only the shard with standalone tokens matches; the substring noise does not
      expect(results.map((r) => r.key)).toContain('real')
      expect(results.map((r) => r.key)).not.toContain('noise')
    } finally {
      store.close()
    }
  })

  it('still retrieves standalone short content tokens (pr, ci) under ascii-boundary', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given a shard whose body carries standalone short tokens
      writeTopic(agentDir, 'short-tokens', 'Short Tokens', 'The PR landed after CI went green.')

      // when the prompt asks about them among function words (no vector hit)
      const results = await hybridSearch('what about the pr and ci', store, agentDir, 5, embedFrom({ 7: 1 }))

      // then boundary matching keeps the standalone short tokens retrievable
      expect(results.map((r) => r.key)).toContain('short-tokens')
    } finally {
      store.close()
    }
  })
})

describe('hybridSearch relevance gate', () => {
  it.each(['topic', 'reference'] as const)(
    'does not inject %s rows for 뭔소리야 when reference chunks inflate the topic contrast',
    async (source) => {
      const { agentDir, store } = createFixture()
      try {
        seedReferenceHub(agentDir, store)

        const results = await hybridSearch('뭔소리야', store, agentDir, 10, embedFrom({ 0: 1 }))

        expect(results.filter((result) => result.source === source)).toEqual([])
      } finally {
        store.close()
      }
    },
  )

  it('keeps a semantic reference match above both bands when no topic matches', async () => {
    const { agentDir, store } = createFixture()
    try {
      seedReferenceHub(agentDir, store)
      writeReference(agentDir, 'deployment-guide', 'Deployment guide', 'A specific release procedure.')
      store.upsert(row('reference:deployment-guide#0', 'deployment-guide', bandedVector(0.92), 'reference'))

      const results = await hybridSearch('배포 절차', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results.map((result) => result.key)).toEqual(['deployment-guide'])
    } finally {
      store.close()
    }
  })

  it('keeps a keyword reference hit when its vector chunks are suppressed', async () => {
    const { agentDir, store } = createFixture()
    try {
      seedReferenceHub(agentDir, store)

      const results = await hybridSearch('보관 문서', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results.map((result) => result.key)).toEqual(['archive'])
      expect(results[0]?.rrfScore).toBeCloseTo(1 / 61, 10)
    } finally {
      store.close()
    }
  })

  it('admits a sole reference against the topic band without requiring reference siblings', async () => {
    const { agentDir, store } = createFixture()
    try {
      for (let i = 0; i < 30; i++) {
        writeTopic(agentDir, `band-${i}`, `Band ${i}`, 'Unrelated note.')
        store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVector(0.7)))
      }
      writeReference(agentDir, 'deployment-guide', 'Deployment guide', 'A specific release procedure.')
      store.upsert(row('reference:deployment-guide#0', 'deployment-guide', bandedVector(0.9), 'reference'))

      const results = await hybridSearch('배포 절차', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results.map((result) => result.key)).toEqual(['deployment-guide'])
    } finally {
      store.close()
    }
  })

  it('preserves semantic retrieval in a tiny reference-only index', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeReference(agentDir, 'deployment-guide', 'Deployment guide', 'A specific release procedure.')
      store.upsert(row('reference:deployment-guide#0', 'deployment-guide', bandedVector(0.78), 'reference'))
      store.upsert(row('reference:deployment-guide#1', 'deployment-guide', bandedVector(0.77), 'reference'))

      const results = await hybridSearch('배포 절차', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results.map((result) => result.key)).toEqual(['deployment-guide'])
    } finally {
      store.close()
    }
  })

  it('computes the relevance baseline only from authorized candidates', async () => {
    const { agentDir, store } = createFixture()
    try {
      const fragments: Parameters<typeof writeStreamFragments>[2] = [
        {
          id: 'local-evidence',
          topic: 'Local semantic fact',
          body: 'A locally authorized semantic fact.',
          where: { adapter: 'discord', workspace: 'local-workspace', chat: 'local-chat', thread: null },
        },
      ]
      writeTopic(
        agentDir,
        'local-semantic-topic',
        'Local semantic topic',
        'A locally authorized semantic fact.\nfragments:\n- streams/2026-06-10#local-evidence',
      )
      store.upsert(row('topic:local-semantic-topic', 'local-semantic-topic', bandedVector(0.79)))

      for (let index = 0; index < 30; index++) {
        const id = `foreign-evidence-${index}`
        const slug = `foreign-semantic-${index}`
        fragments.push({
          id,
          topic: 'Foreign semantic fact',
          body: `Foreign fact ${index}.`,
          where: { adapter: 'discord', workspace: 'foreign-workspace', chat: `foreign-${index}`, thread: null },
        })
        writeTopic(
          agentDir,
          slug,
          `Foreign semantic ${index}`,
          `Foreign fact ${index}.\nfragments:\n- streams/2026-06-10#${id}`,
        )
        store.upsert(row(`topic:${slug}`, slug, bandedVector(0.8 + (index % 3) * 0.001)))
      }
      writeStreamFragments(agentDir, '2026-06-10', fragments)

      const results = await hybridSearch('zz-scoped-semantic-probe', store, agentDir, 5, embedFrom({ 0: 1 }), {
        scope: { workspace: 'local-workspace', chat: 'local-chat' },
      })

      expect(results.map((result) => result.key)).toContain('local-semantic-topic')
      expect(results.some((result) => result.key.startsWith('foreign-semantic-'))).toBe(false)
    } finally {
      store.close()
    }
  })

  it('suppresses the vector lane when no topic clears the per-query baseline (no-match)', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: a flat band of topics, none meaningfully closer to the query than
      // the rest — the E5 no-match shape. Query has no keyword hit either.
      for (let i = 0; i < 30; i++) {
        writeTopic(agentDir, `band-${i}`, `Band ${i}`, `Unrelated English note number ${i}.`)
        store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVector(0.78 + (i % 3) * 0.001)))
      }

      const results = await hybridSearch('zxqw nonexistent gibberish token', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('keeps a topic whose vector clearly stands above the baseline (real match)', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: a flat band plus one topic that aligns strongly with the query
      for (let i = 0; i < 30; i++) {
        writeTopic(agentDir, `band-${i}`, `Band ${i}`, `Unrelated English note number ${i}.`)
        store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVector(0.78 + (i % 3) * 0.001)))
      }
      writeTopic(agentDir, 'winner', 'Winner', 'The clearly matching topic for the query.')
      store.upsert(row('topic:winner', 'winner', vector({ 0: 1 })))

      const results = await hybridSearch('the matching query', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results[0]?.key).toBe('winner')
    } finally {
      store.close()
    }
  })

  it('lets a keyword hit survive even when the vector lane is fully suppressed', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: a flat no-match vector band, but ONE topic literally contains the
      // rare token the user typed — high-precision lexical evidence must survive
      // the cosine no-match veto.
      for (let i = 0; i < 30; i++) {
        writeTopic(agentDir, `band-${i}`, `Band ${i}`, `Unrelated English note number ${i}.`)
        store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVector(0.78 + (i % 3) * 0.001)))
      }
      writeTopic(agentDir, 'pr-851', 'PR 851', 'Notes about PR #851 zxqw-marker handling.')
      store.upsert(row('topic:pr-851', 'pr-851', bandedVector(0.779)))

      const results = await hybridSearch('zxqw-marker', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results.map((r) => r.key)).toContain('pr-851')
    } finally {
      store.close()
    }
  })

  it('never suppresses a below-floor corpus to zero', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: only 3 shards — too few to estimate a baseline
      writeTopic(agentDir, 'a', 'A', 'Note A.')
      writeTopic(agentDir, 'b', 'B', 'Note B.')
      writeTopic(agentDir, 'c', 'C', 'Note C.')
      store.upsert(row('topic:a', 'a', bandedVector(0.78)))
      store.upsert(row('topic:b', 'b', bandedVector(0.779)))
      store.upsert(row('topic:c', 'c', bandedVector(0.778)))

      const results = await hybridSearch('anything', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results.length).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })

  it('keeps a stream-vector match even when the topic distribution is a flat no-match', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: a full flat topic band (no topic clears the baseline) PLUS one
      // undreamed stream fragment that the query semantically matches, and NO
      // keyword hit — the freshness-window case. The topic no-match must not
      // veto the relevant stream candidate.
      for (let i = 0; i < 30; i++) {
        writeTopic(agentDir, `band-${i}`, `Band ${i}`, `Unrelated English note number ${i}.`)
        store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVector(0.78 + (i % 3) * 0.001)))
      }
      const fragmentId = '019e2ee8-bcc4-772f-8821-876162c5e601'
      writeStreamFragment(agentDir, '2026-06-11', fragmentId, 'fresh', 'A brand new undreamed observation.')
      store.upsert(row(`stream:2026-06-11#${fragmentId}`, `2026-06-11#${fragmentId}`, vector({ 0: 1 }), 'stream'))

      const results = await hybridSearch('zxqw nonexistent gibberish token', store, agentDir, 10, embedFrom({ 0: 1 }))

      const streamHit = results.find((r) => r.source === 'stream')
      expect(streamHit?.key).toBe(`2026-06-11#${fragmentId}`)
    } finally {
      store.close()
    }
  })

  it('suppresses an in-band stream neighbor on a no-match query (no closest-neighbor leak)', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: a flat topic no-match band AND a stream fragment that also sits
      // inside the band (an irrelevant nearest neighbor, not a real match), with
      // no keyword hit. The stream row must NOT inject — otherwise the no-match
      // query leaks closest-neighbors-regardless through the stream partition.
      for (let i = 0; i < 30; i++) {
        writeTopic(agentDir, `band-${i}`, `Band ${i}`, `Unrelated English note number ${i}.`)
        store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVector(0.78 + (i % 3) * 0.001)))
      }
      const fragmentId = '019e2ee8-bcc4-772f-8821-876162c5e601'
      writeStreamFragment(agentDir, '2026-06-11', fragmentId, 'noise', 'An unrelated undreamed fragment.')
      store.upsert(row(`stream:2026-06-11#${fragmentId}`, `2026-06-11#${fragmentId}`, bandedVector(0.781), 'stream'))

      const results = await hybridSearch('zxqw nonexistent gibberish token', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('drops a semantic-only stream row when there is no topic baseline to judge it', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: too few topics to form a baseline, plus an in-band stream neighbor
      // with no keyword corroboration — with no band to measure against, an
      // uncorroborated semantic-only stream row must not inject on a no-match.
      writeTopic(agentDir, 'a', 'A', 'Note A.')
      writeTopic(agentDir, 'b', 'B', 'Note B.')
      store.upsert(row('topic:a', 'a', bandedVector(0.5)))
      store.upsert(row('topic:b', 'b', bandedVector(0.49)))
      const fragmentId = '019e2ee8-bcc4-772f-8821-876162c5e601'
      writeStreamFragment(agentDir, '2026-06-11', fragmentId, 'noise', 'An unrelated undreamed fragment.')
      store.upsert(row(`stream:2026-06-11#${fragmentId}`, `2026-06-11#${fragmentId}`, bandedVector(0.5), 'stream'))

      const results = await hybridSearch('zxqw nonexistent gibberish token', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results.some((r) => r.source === 'stream')).toBe(false)
    } finally {
      store.close()
    }
  })

  it('recovers a cross-script topic match whose head band is the matching script (loosened margin)', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: a flat English no-match band, plus ONE English topic the Korean
      // query matches with a compressed cross-script contrast (~0.045 — below the
      // strict 0.06, above the loosened 0.04). The head of the scored band IS the
      // English winner, so the query (Korean) is cross-script against it and the
      // margin loosens. No keyword hit (Korean shares no tokens with English).
      for (let i = 0; i < 30; i++) {
        writeTopic(agentDir, `band-${i}`, `Band ${i}`, `Unrelated English note number ${i}.`)
        store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVector(0.755 + (i % 3) * 0.001)))
      }
      writeTopic(agentDir, 'proc-bind', 'Sandbox proc-bind strategy', 'The container binds a real procfs.')
      store.upsert(row('topic:proc-bind', 'proc-bind', bandedVector(0.8)))

      const results = await hybridSearch(
        '\uC0CC\uB4DC\uBC15\uC2A4 proc \uBC14\uC778\uB4DC \uC804\uB7B5',
        store,
        agentDir,
        10,
        embedFrom({ 0: 1 }),
      )

      expect(results[0]?.key).toBe('proc-bind')
    } finally {
      store.close()
    }
  })

  it('does NOT loosen when an unrelated same-script shard is the corpus but the head band matches the query script', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: the same English compressed-contrast no-match band, queried in
      // ENGLISH (same script as the band head). The contrast (~0.045) is below the
      // strict margin and must STILL suppress — same-script pairs never loosen, so
      // a real English no-match is not rescued by the cross-script path.
      for (let i = 0; i < 30; i++) {
        writeTopic(agentDir, `band-${i}`, `Band ${i}`, `Unrelated English note number ${i}.`)
        store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVector(0.755 + (i % 3) * 0.001)))
      }
      writeTopic(agentDir, 'near', 'Near Miss', 'A barely-elevated topic.')
      store.upsert(row('topic:near', 'near', bandedVector(0.8)))

      const results = await hybridSearch('zxqw gibberish nonmatching token', store, agentDir, 10, embedFrom({ 0: 1 }))

      expect(results).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it('keeps stream admission strict under a cross-script query (no closest-neighbor leak via loosened margin)', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: a Korean cross-script query that loosens the TOPIC gate, plus an
      // in-band English stream neighbor sitting ~0.045 above the band (between the
      // loosened 0.04 and the strict 0.06). Stream admission must stay on the
      // STRICT margin, so this irrelevant neighbor is still suppressed — the
      // cross-script topic loosening must not weaken the stream leak guard.
      for (let i = 0; i < 30; i++) {
        writeTopic(agentDir, `band-${i}`, `Band ${i}`, `Unrelated English note number ${i}.`)
        store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVector(0.755 + (i % 3) * 0.001)))
      }
      const fragmentId = '019e2ee8-bcc4-772f-8821-876162c5e601'
      writeStreamFragment(agentDir, '2026-06-11', fragmentId, 'noise', 'An unrelated English fragment.')
      store.upsert(row(`stream:2026-06-11#${fragmentId}`, `2026-06-11#${fragmentId}`, bandedVector(0.8), 'stream'))

      const results = await hybridSearch(
        '\uBD07\uB07C\uB9AC \uBB34\uD55C \uB8E8\uD504 \uAC00\uB4DC',
        store,
        agentDir,
        10,
        embedFrom({ 0: 1 }),
      )

      expect(results.some((r) => r.source === 'stream')).toBe(false)
    } finally {
      store.close()
    }
  })
})

describe('hybridSearch query chunking', () => {
  it('a short (in-budget) query embeds as one chunk — single-vector path preserved', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeTopic(agentDir, 'pr-651', 'PR 651 Review', 'PR #651 fixed channel reload handling.')
      store.upsert(row('topic:pr-651', 'pr-651', vector({ 0: 1 })))

      let embedCallCount = 0
      const countingEmbed: EmbedFn = async (texts) => {
        embedCallCount += 1
        expect(texts).toHaveLength(1)
        return [vector({ 0: 1 })]
      }

      const results = await hybridSearch('PR #651', store, agentDir, 3, countingEmbed)

      expect(embedCallCount).toBe(1)
      expect(results.map((r) => r.key)).toContain('pr-651')
    } finally {
      store.close()
    }
  })

  it('retrieves a topic relevant to the TAIL of an over-budget query (tail no longer truncated)', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeTopic(agentDir, 'tail-topic', 'Tail Topic', 'A belief only the tail of the prompt is about.')
      store.upsert(row('topic:tail-topic', 'tail-topic', vector({ 5: 1 })))

      // A long prompt: a benign head followed by the tail that actually matches.
      // The head chunk(s) embed to an off-axis vector; the LAST chunk embeds to
      // the topic's axis. Pre-fix (single truncated vector) the head won and the
      // tail topic was unreachable; chunking + MAX-collapse surfaces it.
      const head = 'word '.repeat(TEXT_TOKEN_BUDGET * 2)
      const query = `${head} TAIL-PAYLOAD`
      const embedPerChunk: EmbedFn = async (texts) =>
        texts.map((text) => (text.includes('TAIL-PAYLOAD') ? vector({ 5: 1 }) : vector({ 7: 1 })))

      const results = await hybridSearch(query, store, agentDir, 3, embedPerChunk)

      expect(results.map((r) => r.key)).toContain('tail-topic')
    } finally {
      store.close()
    }
  })

  it('caps the number of embedded chunks for a pathological prompt, keeping the tail', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeTopic(agentDir, 'noise', 'Noise', 'Unrelated.')
      store.upsert(row('topic:noise', 'noise', vector({ 1: 1 })))

      // ~40 budgets of text → far more than the cap of 10 chunks.
      const query = `${'word '.repeat(TEXT_TOKEN_BUDGET * 40)} FINAL-TAIL`
      let seenChunks = 0
      let tailEmbedded = false
      const capProbe: EmbedFn = async (texts) => {
        seenChunks = texts.length
        tailEmbedded = texts.some((t) => t.includes('FINAL-TAIL'))
        return texts.map(() => vector({ 1: 1 }))
      }

      await hybridSearch(query, store, agentDir, 3, capProbe)

      expect(seenChunks).toBeLessThanOrEqual(10)
      expect(seenChunks).toBe(10)
      expect(tailEmbedded).toBe(true)
    } finally {
      store.close()
    }
  })

  it('loosens the cross-script margin from the chunk that won the TOP row, not the head majority', async () => {
    const { agentDir, store } = createFixture()
    try {
      // given: an English framing head chunk that wins a crowd of ambient English
      // noise rows (~0.755 on axis 0), and a Korean tail chunk that wins the ONE
      // real English topic at a compressed cross-script contrast (~0.045: axis-2
      // target 0.8 vs the 0.755 band). The head band is majority English, so a
      // majority vote would pick `latin`, keep the margin strict, and suppress the
      // real match. Deriving the script from the TOP row's winning chunk (Korean)
      // loosens the margin and recovers it.
      for (let i = 0; i < 30; i++) {
        writeTopic(agentDir, `band-${i}`, `Band ${i}`, `Unrelated English note number ${i}.`)
        store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVectorOnAxis(0.755 + (i % 3) * 0.001, 0)))
      }
      writeTopic(agentDir, 'proc-bind', 'Sandbox proc-bind strategy', 'The container binds a real procfs.')
      store.upsert(row('topic:proc-bind', 'proc-bind', bandedVectorOnAxis(0.8, 2)))

      // Align the English head to chunk boundaries so the Korean payload lands in
      // its OWN (cjk-dominant) trailing chunk — otherwise the greedy splitter
      // appends it to a latin-dominant chunk and dominantScript reads latin.
      const head = budgetAlignedText('unrelated english framing prose ', 2)
      const query = `${head}\uC0CC\uB4DC\uBC15\uC2A4 proc \uBC14\uC778\uB4DC \uC804\uB7B5 \uD655\uC778`
      const embedPerChunk: EmbedFn = async (texts) =>
        texts.map((text) => (/[\uAC00-\uD7AF]/.test(text) ? vector({ 2: 1 }) : vector({ 0: 1 })))

      const results = await hybridSearch(query, store, agentDir, 10, embedPerChunk)

      // proc-bind can ONLY enter results via the vector lane admitting it under the
      // loosened margin — the Korean payload shares no tokens with it, so it never
      // reaches the keyword lane. Under the old head-majority vote the margin stays
      // strict and proc-bind is suppressed entirely.
      expect(results.some((r) => r.key === 'proc-bind')).toBe(true)
    } finally {
      store.close()
    }
  })

  it('decodes the corpus once per search regardless of chunk count', async () => {
    const { agentDir, store } = createFixture()
    try {
      writeTopic(agentDir, 'noise', 'Noise', 'Unrelated.')
      store.upsert(row('topic:noise', 'noise', vector({ 1: 1 })))

      const loadRows = store.loadRows.bind(store)
      let loadRowsCalls = 0
      store.loadRows = (modelId, dims) => {
        loadRowsCalls += 1
        return loadRows(modelId, dims)
      }

      // An over-budget prompt that fans out to the 10-chunk cap.
      const query = `${'word '.repeat(TEXT_TOKEN_BUDGET * 40)} FINAL-TAIL`
      let seenChunks = 0
      const embedPerChunk: EmbedFn = async (texts) => {
        seenChunks = texts.length
        return texts.map(() => vector({ 1: 1 }))
      }

      await hybridSearch(query, store, agentDir, 3, embedPerChunk)

      expect(seenChunks).toBe(10)
      expect(loadRowsCalls).toBe(1)
    } finally {
      store.close()
    }
  })
})

function createFixture(): { agentDir: string; store: VectorStore } {
  const agentDir = join(tmpdir(), `typeclaw-hybrid-${randomUUID()}`)
  testDirs.push(agentDir)
  mkdirSync(join(agentDir, 'memory', 'topics'), { recursive: true })
  mkdirSync(join(agentDir, 'memory', 'references'), { recursive: true })
  const store = VectorStore.open(join(agentDir, 'memory', '.vectors', 'index.db'))
  return { agentDir, store }
}

function seedReferenceHub(agentDir: string, store: VectorStore): void {
  for (let i = 0; i < 30; i++) {
    writeTopic(agentDir, `band-${i}`, `기록 ${i}`, 'Unrelated note.')
    store.upsert(row(`topic:band-${i}`, `band-${i}`, bandedVector(0.7 + (i % 3) * 0.001)))
  }
  writeTopic(agentDir, 'nearby', '주변 기록', 'An unrelated nearest neighbour.')
  store.upsert(row('topic:nearby', 'nearby', bandedVector(0.75)))
  writeReference(agentDir, 'archive', '보관 문서', 'An archived payload.')
  // Several chunks from one verbatim artifact form an elevated, flat cluster.
  // The pooled gate lets that cluster carry the unrelated nearby topic over its
  // knee, even though the topics alone have no match.
  for (let i = 0; i < 6; i++) {
    store.upsert(row(`reference:archive#${i}`, 'archive', bandedVector(0.78 - i * 0.001), 'reference'))
  }
}

function writeTopic(agentDir: string, slug: string, heading: string, body: string): void {
  writeFileSync(
    join(agentDir, 'memory', 'topics', `${slug}.md`),
    renderShard({ heading, cites: 1, days: 1, lastReinforced: '2026-06-11' }, body),
  )
}

function writeReference(agentDir: string, slug: string, title: string, body: string): void {
  writeFileSync(
    join(agentDir, 'memory', 'references', `${slug}.md`),
    renderReference(
      {
        title,
        origin: 'episode',
        created: '2026-06-10T00:00:00Z',
        lastAccessed: '2026-06-10T00:00:00Z',
        accessCount: 0,
        pinned: false,
        demoted: false,
        tags: [],
      },
      body,
    ),
  )
}

function writeStreamFragment(agentDir: string, date: string, id: string, topic: string, body: string): void {
  writeStreamFragments(agentDir, date, [{ id, topic, body }])
}

function writeStreamFragments(
  agentDir: string,
  date: string,
  fragments: Array<{
    id: string
    topic: string
    body: string
    where?: {
      adapter: string
      workspace: string
      workspaceName?: string
      chat: string
      chatName?: string
      thread?: string | null
    }
  }>,
): void {
  const streamsDir = join(agentDir, 'memory', 'streams')
  mkdirSync(streamsDir, { recursive: true })
  const lines = fragments
    .map(({ id, topic, body, where }) =>
      JSON.stringify({
        type: 'fragment',
        id,
        ts: `${date}T12:00:00.000Z`,
        source: 'ses_test',
        entry: 'e1',
        topic,
        body,
        ...(where === undefined ? {} : { where }),
      }),
    )
    .join('\n')
  writeFileSync(join(streamsDir, `${date}.jsonl`), `${lines}\n`)
}

function row(
  id: string,
  key: string,
  embedding: Float32Array,
  source: 'topic' | 'stream' | 'reference' = 'topic',
): Omit<VectorRow, 'updatedAt'> {
  return {
    id,
    source,
    key,
    model: MODEL,
    dims: embedding.length,
    embedding,
    contentHash: `hash:${id}`,
  }
}

function embedFrom(values: Record<number, number>): EmbedFn {
  return async () => [vector(values)]
}

// A unit vector whose cosine against the query unit vector vector({ 0: 1 }) is
// exactly `target`: put `target` on axis 0 and the remaining magnitude on a
// shared off-query axis, so a whole band of these sits at near-identical cosine
// to the query — the flat E5 no-match distribution.
function bandedVector(target: number): Float32Array {
  const result = new Float32Array(8)
  result[0] = target
  result[1] = Math.sqrt(Math.max(0, 1 - target * target))
  return result
}

// bandedVector with the on-query component on an arbitrary axis, so two query
// chunks pointing at different axes can each win a different band of store rows
// (the cross-script top-row test needs the noise band and the real topic to be
// selected by different chunks). The shared off-query axis stays 7 to avoid
// colliding with any on-query axis a caller picks.
function bandedVectorOnAxis(target: number, axis: number): Float32Array {
  const result = new Float32Array(8)
  result[axis] = target
  result[7] = Math.sqrt(Math.max(0, 1 - target * target))
  return result
}

// `chunkCount` full budget-sized chunks of `unit`, cut exactly on the splitter's
// own boundaries so a following non-Latin payload starts a fresh chunk instead of
// tailing a Latin-dominant one.
function budgetAlignedText(unit: string, chunkCount: number): string {
  let remaining = unit.repeat(TEXT_TOKEN_BUDGET)
  let head = ''
  for (let i = 0; i < chunkCount; i++) {
    const chunk = boundEmbeddableText(remaining).text
    head += chunk
    remaining = remaining.slice(chunk.length)
  }
  return head
}

function vector(values: Record<number, number>): Float32Array {
  const result = new Float32Array(8)
  for (const [index, value] of Object.entries(values)) {
    result[Number(index)] = value
  }
  return result
}
