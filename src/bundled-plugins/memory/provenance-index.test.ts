import { afterEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { saveDreamingState } from './dreaming-state'
import { renderShard } from './frontmatter'
import { streamFilePath, streamsDir, topicShardPath, topicsDir } from './paths'
import { buildProvenanceIndex, buildProvenanceIndexFrom, enrichHistoricalProvenance } from './provenance-index'
import type { FragmentEvent, FragmentProvenance } from './stream-events'
import { appendEvents } from './stream-io'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('buildProvenanceIndex', () => {
  test('indexes active cited children with deterministic canonical citations and leaves unresolved citations explicit', async () => {
    const root = await makeRoot()
    const active = fragment('active-id', {
      adapter: 'discord',
      workspace: 'guild-example',
      workspaceName: 'Example Guild',
      chat: '9001',
      chatName: '개발실',
      thread: 'thread-1',
      parentChat: '9001',
      parentChatName: '개발실',
    })
    active.who = '민수'
    await writeStream(root, '2026-07-01', [active, fragment('superseded-id', active.where)])
    await writeTopic(
      root,
      'coding-lab-notes',
      [
        'The team uses a shared workspace.',
        'fragments:',
        '- streams/2026-07-01#active-id',
        '- streams/2026-07-01#missing-id',
        'superseded:',
        '- streams/2026-07-01#superseded-id',
      ].join('\n'),
    )

    const index = await buildProvenanceIndex(root)

    expect(index.childrenForTopic('coding-lab-notes')).toEqual([
      {
        citation: 'streams/2026-07-01#active-id',
        resolved: true,
        who: '민수',
        when: '2026-07-01T12:00:00.000Z',
        where: active.where,
      },
      { citation: 'streams/2026-07-01#missing-id', resolved: false },
    ])
    expect(index.childrenForTopic('coding-lab-notes').some((child) => child.citation.includes('superseded-id'))).toBe(
      false,
    )
  })

  test('enriches missing historical names and parent coordinates from the runtime registry without rewriting JSONL', async () => {
    const root = await makeRoot()
    const old = fragment('old-id', {
      adapter: 'discord',
      workspace: 'guild-1',
      chat: 'thread-1',
      thread: null,
    })
    const current = fragment('current-id', {
      adapter: 'discord',
      workspace: 'guild-1',
      workspaceName: 'Example Guild',
      chat: 'thread-1',
      chatName: '토론방',
      thread: null,
      parentChat: 'parent-1',
      parentChatName: '개발실',
    })
    await writeStream(root, '2026-07-01', [old, current])
    await writeTopic(root, 'historical', 'Historical fact.\nfragments:\n- streams/2026-07-01#old-id')
    const before = await readFile(streamFilePath(root, '2026-07-01'))

    const index = await buildProvenanceIndex(root)
    const after = await readFile(streamFilePath(root, '2026-07-01'))

    expect(after.equals(before)).toBe(true)
    expect(index.childrenForTopic('historical')[0]?.where).toMatchObject({
      workspaceName: 'Example Guild',
      chatName: '토론방',
      parentChat: 'parent-1',
      parentChatName: '개발실',
    })
    await expect(readFile(legacySidecarPath(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('ignores a stale legacy sidecar and refreshes when stream files change', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'memory'), { recursive: true })
    await writeFile(legacySidecarPath(root), '{broken', 'utf8')
    await writeStream(root, '2026-07-01', [
      fragment('first', {
        adapter: 'discord',
        workspace: 'guild-1',
        workspaceName: 'Old Guild',
        chat: 'room-1',
        thread: null,
      }),
    ])
    await writeTopic(root, 'cached', 'Cached.\nfragments:\n- streams/2026-07-01#first\n- streams/2026-07-01#second')

    const first = await buildProvenanceIndex(root)
    expect(first.childrenForTopic('cached')[0]?.where?.workspaceName).toBe('Old Guild')

    await writeStream(root, '2026-07-01', [
      fragment('second', {
        adapter: 'discord',
        workspace: 'guild-1',
        workspaceName: 'Renamed Guild',
        chat: 'room-1',
        thread: null,
      }),
    ])
    const refreshed = await buildProvenanceIndex(root)
    expect(refreshed.lexicalTextForTopic('cached')).toContain('Renamed Guild')
  })

  test('keeps dreamed active fragments available and marks undreamed fragments independently', async () => {
    const root = await makeRoot()
    await writeStream(root, '2026-07-01', [fragment('dreamed', undefined), fragment('fresh', undefined)])
    await saveDreamingState(root, {
      version: 2,
      dreamedThrough: { '2026-07-01': { dreamedIds: ['dreamed'], ts: '2026-07-01T00:00:00Z' } },
    })
    await writeTopic(root, 'dreamed-topic', 'Dreamed.\nfragments:\n- streams/2026-07-01#dreamed')

    const index = await buildProvenanceIndex(root)

    expect(index.childrenForTopic('dreamed-topic')[0]).toMatchObject({ resolved: true, dreamed: true })
    expect(index.undreamedChildren().map((child) => child.citation)).toEqual(['streams/2026-07-01#fresh'])
  })

  test('returns an ID-only usable index when bounded runtime enrichment times out', async () => {
    const root = await makeRoot()
    await writeStream(root, '2026-07-01', [
      fragment('timed', { adapter: 'discord', workspace: 'guild-1', chat: 'room-1', thread: null }),
    ])
    await writeTopic(root, 'timed-topic', 'Timed.\nfragments:\n- streams/2026-07-01#timed')

    const index = await buildProvenanceIndex(root, { timeoutMs: -1 })

    expect(index.childrenForTopic('timed-topic')[0]).toMatchObject({
      citation: 'streams/2026-07-01#timed',
      where: { workspace: 'guild-1', chat: 'room-1' },
    })
    await expect(readFile(legacySidecarPath(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('learns the newest coordinate before a shared deadline drops older work', async () => {
    const root = await makeRoot()
    const events = Array.from({ length: 3 }, (_, index) =>
      fragment(`deadline-${index}`, {
        adapter: 'discord',
        workspace: 'guild-deadline',
        chat: 'room-deadline',
        thread: null,
        ...(index === 2 ? { chatName: 'Newest Alias' } : {}),
      }),
    )
    let clockReads = 0
    const index = await buildProvenanceIndexFrom(
      root,
      [
        {
          path: topicShardPath(root, 'deadline-topic'),
          slug: 'deadline-topic',
          frontmatter: { heading: 'Deadline', cites: 1, days: 1, lastReinforced: '2026-07-01' },
          body: 'Deadline.\nfragments:\n- streams/2026-07-01#deadline-0',
        },
      ],
      [{ date: '2026-07-01', path: 'stream', name: 'stream', events, dreamedIds: new Set() }],
      {
        timeoutMs: 1,
        now: () => [0, 0, 2][clockReads++] ?? 2,
      },
    )

    expect(index.childrenForTopic('deadline-topic')[0]?.where?.chatName).toBe('Newest Alias')
  })

  test('bounds aliases by freshness and evicts the oldest distinct name', async () => {
    const root = await makeRoot()
    const events = Array.from({ length: 13 }, (_, index) =>
      fragment(`bounded-alias-${index}`, {
        adapter: 'discord',
        workspace: 'guild-aliases',
        chat: 'room-aliases',
        chatName: `Alias ${index}`,
        thread: null,
      }),
    )
    events.push(
      fragment('bounded-alias-probe', {
        adapter: 'discord',
        workspace: 'guild-aliases',
        chat: 'room-aliases',
        thread: null,
      }),
    )

    const index = await buildProvenanceIndexFrom(
      root,
      [],
      [{ date: '2026-07-01', path: 'stream', name: 'stream', events, dreamedIds: new Set() }],
      { timeoutMs: 60_000 },
    )
    const text = index.lexicalTextForUndreamed('streams/2026-07-01#bounded-alias-probe')

    expect(index.undreamedChild('streams/2026-07-01#bounded-alias-probe')?.where?.chatName).toBe('Alias 12')
    expect(text).toContain('Alias 12')
    expect(text).toContain('Alias 1')
    expect(text).not.toContain('Alias 0\n')
  })

  test('refreshes a re-observed alias so the next distinct alias evicts the truly oldest name', async () => {
    const root = await makeRoot()
    const aliases = [...Array.from({ length: 12 }, (_, index) => index), 0, 12]
    const events = aliases.map((alias, index) =>
      fragment(`refreshed-alias-${index}`, {
        adapter: 'discord',
        workspace: 'guild-refreshed',
        chat: 'room-refreshed',
        chatName: `Alias ${alias}`,
        thread: null,
      }),
    )
    events.push(
      fragment('refreshed-alias-probe', {
        adapter: 'discord',
        workspace: 'guild-refreshed',
        chat: 'room-refreshed',
        thread: null,
      }),
    )

    const index = await buildProvenanceIndexFrom(
      root,
      [],
      [{ date: '2026-07-01', path: 'stream', name: 'stream', events, dreamedIds: new Set() }],
      { timeoutMs: 60_000 },
    )
    const text = index.lexicalTextForUndreamed('streams/2026-07-01#refreshed-alias-probe')

    expect(index.undreamedChild('streams/2026-07-01#refreshed-alias-probe')?.where?.chatName).toBe('Alias 12')
    expect(text).toContain('Alias 0')
    expect(text).not.toContain('Alias 1\n')
  })

  test('historical alias replay cannot evict a fresher resolver-only alias', async () => {
    const root = await makeRoot()
    const historical = Array.from({ length: 12 }, (_, index) =>
      fragment(`historical-alias-${index}`, {
        adapter: 'discord',
        workspace: 'guild-resolved',
        chat: 'room-resolved',
        chatName: `Historical Alias ${index}`,
        thread: null,
      }),
    )
    historical.push(
      fragment('resolver-probe', {
        adapter: 'discord',
        workspace: 'guild-resolved',
        chat: 'room-resolved',
        thread: null,
      }),
    )
    await writeStream(root, '2026-07-01', historical)
    await enrichHistoricalProvenance(
      root,
      async (where) => ({
        where: { ...where, workspaceName: 'Current Guild', chatName: 'Current Resolver Room' },
        parentChecked: true,
      }),
      { adapter: 'discord' },
    )

    const index = await buildProvenanceIndex(root)
    const probe = index.undreamedChild('streams/2026-07-01#resolver-probe')
    const text = index.lexicalTextForUndreamed('streams/2026-07-01#resolver-probe')

    expect(probe?.where?.chatName).toBe('Current Resolver Room')
    expect(text).toContain('Current Resolver Room')
    expect(text).toContain('Historical Alias 11')
    expect(text).not.toContain('Historical Alias 0\n')
  })

  test('builds a high-cardinality registry without repeated whole-registry counting', async () => {
    const root = await makeRoot()
    const events = Array.from({ length: 10_000 }, (_, index) =>
      fragment(`bulk-${index}`, {
        adapter: 'discord',
        workspace: 'guild-bulk',
        workspaceName: 'Example Guild',
        chat: `room-${index}`,
        chatName: `Room ${index}`,
        thread: null,
      }),
    )

    const index = await buildProvenanceIndexFrom(
      root,
      [],
      [{ date: '2026-07-01', path: 'stream', name: 'stream', events, dreamedIds: new Set() }],
      { timeoutMs: 1, now: () => 0 },
    )

    expect(index.undreamedChildren()).toHaveLength(10_000)
    let matched = 0
    for (let item = 0; item < 10_000; item++) {
      if (index.lexicalTextForUndreamed(`streams/2026-07-01#bulk-${item}`).includes(`Room ${item}`)) matched++
    }
    expect(matched).toBe(10_000)
  })

  test('prioritizes the newest bounded coordinate observations during the initial build', async () => {
    const root = await makeRoot()
    const fillerEvents = Array.from({ length: 19_999 }, (_, index) =>
      fragment(`filler-${index}`, {
        adapter: 'discord',
        workspace: 'guild-bounded',
        chat: `room-${index}`,
        chatName: `Room ${index}`,
        thread: null,
      }),
    )
    const freshEvents = [
      fragment('fresh-probe', {
        adapter: 'discord',
        workspace: 'guild-bounded',
        chat: 'fresh-room',
        thread: null,
      }),
      fragment('fresh-alias', {
        adapter: 'discord',
        workspace: 'guild-bounded',
        chat: 'fresh-room',
        chatName: 'Newest Room',
        thread: null,
      }),
    ]
    const index = await buildProvenanceIndexFrom(
      root,
      [
        {
          path: topicShardPath(root, 'fresh-topic'),
          slug: 'fresh-topic',
          frontmatter: { heading: 'Fresh', cites: 1, days: 1, lastReinforced: '2026-07-01' },
          body: 'Fresh.\nfragments:\n- streams/2026-07-01#fresh-probe',
        },
      ],
      [
        {
          date: '2026-06-30',
          path: 'older-stream',
          name: 'older-stream',
          events: fillerEvents,
          dreamedIds: new Set(),
        },
        {
          date: '2026-07-01',
          path: 'newer-stream',
          name: 'newer-stream',
          events: freshEvents,
          dreamedIds: new Set(),
        },
      ],
      { timeoutMs: 60_000 },
    )

    expect(index.childrenForTopic('fresh-topic')[0]?.where?.chatName).toBe('Newest Room')
  })

  test('admits a fresh resolved origin into a full runtime registry and preserves evicted raw-ID recall', async () => {
    const root = await makeRoot()
    await writeStream(
      root,
      '2026-07-01',
      Array.from({ length: 20_000 }, (_, index) =>
        fragment(`capacity-${index}`, {
          adapter: 'discord',
          workspace: 'guild-capacity',
          chat: `room-${index}`,
          chatName: `Capacity Room ${index}`,
          thread: null,
        }),
      ),
    )
    await writeTopic(root, 'old-capacity', 'Old.\nfragments:\n- streams/2026-07-01#capacity-0')
    await writeTopic(root, 'fresh-capacity', 'Fresh.\nfragments:\n- streams/2026-07-01#fresh-capacity')
    await buildProvenanceIndex(root, { timeoutMs: 60_000 })
    await writeStream(root, '2026-07-01', [
      fragment('fresh-capacity', {
        adapter: 'discord',
        workspace: 'guild-capacity',
        chat: 'fresh-room',
        thread: null,
      }),
    ])
    const index = await buildProvenanceIndex(root, { timeoutMs: -1 })

    const enrichment = await enrichHistoricalProvenance(
      root,
      async (where) => ({
        where: { ...where, workspaceName: 'Current Guild', chatName: 'Current Room' },
        parentChecked: true,
      }),
      { maxOrigins: 1 },
    )

    expect(enrichment).toMatchObject({ scanned: 1, attempted: 1, resolved: 1, changed: true })
    expect(index.lexicalTextForTopic('fresh-capacity')).toContain('Current Room')
    expect(index.topicEligible('old-capacity', { workspace: 'guild-capacity', chat: 'room-0' })).toBe(true)
  })

  test('unresolvable Discord DMs do not starve resolvable guild origins from the enrichment batch', async () => {
    const root = await makeRoot()
    const dmEvents = Array.from({ length: 110 }, (_, index) =>
      fragment(`dm-${index}`, {
        adapter: 'discord',
        workspace: '@dm',
        chat: `dm-${index}`,
        thread: null,
      }),
    )
    await writeStream(root, '2026-07-01', [
      ...dmEvents,
      fragment('guild-origin', {
        adapter: 'discord',
        workspace: 'guild-resolvable',
        chat: 'room-resolvable',
        thread: null,
      }),
    ])
    const attempted: string[] = []

    const result = await enrichHistoricalProvenance(
      root,
      async (where) => {
        attempted.push(where.workspace)
        return {
          where: { ...where, workspaceName: 'Example Guild', chatName: 'general' },
          parentChecked: true,
        }
      },
      { maxOrigins: 1 },
    )

    expect(attempted).toEqual(['guild-resolvable'])
    expect(result).toMatchObject({ scanned: 1, attempted: 1, resolved: 1 })
  })

  test('more than 100 unresolved oldest origins do not starve a newer resolvable origin', async () => {
    const root = await makeRoot()
    await writeStream(
      root,
      '2026-06-01',
      Array.from({ length: 101 }, (_, index) =>
        fragment(`old-${index}`, {
          adapter: 'discord',
          workspace: `guild-old-${index}`,
          chat: `room-old-${index}`,
          thread: null,
        }),
      ),
    )
    await writeStream(root, '2026-07-01', [
      fragment('new-resolvable', {
        adapter: 'discord',
        workspace: 'guild-new',
        chat: 'room-new',
        thread: null,
      }),
    ])
    const attempted: string[] = []

    const result = await enrichHistoricalProvenance(
      root,
      async (where) => {
        attempted.push(where.workspace)
        if (where.workspace !== 'guild-new') throw new Error('unresolvable historical channel')
        return {
          where: { ...where, workspaceName: 'New Guild', chatName: 'new-room' },
          parentChecked: true,
        }
      },
      { maxOrigins: 100 },
    )

    expect(attempted).toContain('guild-new')
    expect(result).toMatchObject({ scanned: 100, attempted: 100, resolved: 1, failed: 99 })
  })

  test('keeps retrieval usable without creating an on-disk enrichment file', async () => {
    const root = await makeRoot()
    await writeStream(root, '2026-07-01', [
      fragment('persist-failure', {
        adapter: 'discord',
        workspace: 'guild-1',
        workspaceName: 'Example Guild',
        chat: 'room-1',
        thread: null,
      }),
    ])
    await writeTopic(root, 'failure-topic', 'Failure.\nfragments:\n- streams/2026-07-01#persist-failure')

    const index = await buildProvenanceIndex(root)

    expect(index.lexicalTextForTopic('failure-topic')).toContain('Example Guild')
    await expect(readFile(legacySidecarPath(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('resolver-backed maintenance makes an old ID-only dreamed fragment searchable by server name without rewriting JSONL', async () => {
    const root = await makeRoot()
    await writeStream(root, '2026-07-01', [
      fragment('historical-id-only', {
        adapter: 'discord',
        workspace: 'guild-example',
        chat: 'thread-1',
        thread: null,
      }),
    ])
    await saveDreamingState(root, {
      version: 2,
      dreamedThrough: {
        '2026-07-01': { dreamedIds: ['historical-id-only'], ts: '2026-07-01T12:00:00.000Z' },
      },
    })
    await writeTopic(
      root,
      'coding-lab-history',
      'Historical policy.\nfragments:\n- streams/2026-07-01#historical-id-only',
    )
    const streamBefore = await readFile(streamFilePath(root, '2026-07-01'))

    const result = await enrichHistoricalProvenance(root, async (where) => ({
      where: {
        ...where,
        workspaceName: 'Example Guild',
        chatName: 'release-thread',
        parentChat: 'room-1',
        parentChatName: 'development',
      },
      parentChecked: true,
    }))

    expect(result).toEqual({ scanned: 1, attempted: 1, resolved: 1, failed: 0, timedOut: 0, changed: true })
    expect((await readFile(streamFilePath(root, '2026-07-01'))).equals(streamBefore)).toBe(true)
    const index = await buildProvenanceIndex(root)
    expect(index.lexicalTextForTopic('coding-lab-history')).toContain('Example Guild')
  })

  test('resolver failure preserves ID-only scoped recall and reports the failed maintenance attempt', async () => {
    const root = await makeRoot()
    await writeStream(root, '2026-07-01', [
      fragment('resolver-failure', {
        adapter: 'discord',
        workspace: 'guild-raw',
        chat: 'room-raw',
        thread: null,
      }),
    ])
    await writeTopic(root, 'raw-topic', 'Raw policy.\nfragments:\n- streams/2026-07-01#resolver-failure')

    const result = await enrichHistoricalProvenance(root, async () => {
      throw new Error('network unavailable')
    })
    const index = await buildProvenanceIndex(root)

    expect(result).toEqual({ scanned: 1, attempted: 1, resolved: 0, failed: 1, timedOut: 0, changed: false })
    expect(index.topicEligible('raw-topic', { workspace: 'guild-raw', chat: 'room-raw' })).toBe(true)
  })

  test('resolver maintenance is bounded and timeout-safe', async () => {
    const root = await makeRoot()
    await writeStream(root, '2026-07-01', [
      fragment('resolver-timeout', {
        adapter: 'discord',
        workspace: 'guild-timeout',
        chat: 'room-timeout',
        thread: null,
      }),
    ])

    const result = await enrichHistoricalProvenance(root, async () => await new Promise<never>(() => {}), {
      timeoutMs: 100,
      perOriginTimeoutMs: 1,
      maxOrigins: 1,
    })

    // Under oversubscribed CI, stream loading can consume the 100ms deadline before the first
    // resolver attempt, yielding attempted=0. Under normal load, the attempt fires and times out,
    // yielding attempted=1. Both are valid: one candidate is scanned, nothing resolves, timeout
    // is reported, and no state changes. The key invariant is that the resolver is bounded and
    // doesn't hang or retry indefinitely.
    expect(result).toMatchObject({ scanned: 1, resolved: 0, timedOut: 1, changed: false })
    expect(result.attempted).toBeGreaterThanOrEqual(0)
    expect(result.attempted).toBeLessThanOrEqual(1)
  })

  test('persists a successful non-thread check so the origin is not retried', async () => {
    const root = await makeRoot()
    await writeStream(root, '2026-07-01', [
      fragment('plain-room', { adapter: 'discord-bot', workspace: '123', chat: '456', thread: null }),
    ])
    let calls = 0
    const resolve = async (where: FragmentProvenance) => {
      calls += 1
      return {
        where: { ...where, workspaceName: 'Example Guild', chatName: 'general' },
        parentChecked: true,
      }
    }

    expect(await enrichHistoricalProvenance(root, resolve)).toMatchObject({ resolved: 1, changed: true })
    expect(await enrichHistoricalProvenance(root, resolve)).toMatchObject({ scanned: 0, attempted: 0 })
    expect(calls).toBe(1)
  })

  test('keeps independently resolved runtime aliases in one bounded registry', async () => {
    const root = await makeRoot()
    await writeStream(
      root,
      '2026-07-01',
      Array.from({ length: 8 }, (_, index) =>
        fragment(`alias-${index}`, {
          adapter: 'discord-bot',
          workspace: '123',
          chat: `${456 + index}`,
          thread: null,
        }),
      ),
    )

    await enrichHistoricalProvenance(root, async (where) => ({
      where: { ...where, workspaceName: `Guild ${where.chat}`, chatName: `Room ${where.chat}` },
      parentChecked: true,
    }))

    const index = await buildProvenanceIndex(root)
    for (let alias = 0; alias < 8; alias++) {
      const chat = `${456 + alias}`
      const text = index.lexicalTextForUndreamed(`streams/2026-07-01#alias-${alias}`)
      expect(text).toContain(`Guild ${chat}`)
      expect(text).toContain(`Room ${chat}`)
    }
  })

  test('ignores and never replaces a symlink at the retired sidecar path', async () => {
    const root = await makeRoot()
    const victim = join(root, 'victim.json')
    await mkdir(join(root, 'memory'), { recursive: true })
    await writeFile(victim, 'do not touch', 'utf8')
    await symlink(victim, legacySidecarPath(root))
    await writeStream(root, '2026-07-01', [
      fragment('safe', {
        adapter: 'discord',
        workspace: '123',
        workspaceName: 'Example Guild',
        chat: '456',
        thread: null,
      }),
    ])

    const index = await buildProvenanceIndex(root)

    expect(index.lexicalTextForUndreamed('streams/2026-07-01#safe')).toContain('Example Guild')
    expect(await readFile(victim, 'utf8')).toBe('do not touch')
    expect((await lstat(legacySidecarPath(root))).isSymbolicLink()).toBe(true)
  })

  test('drops secret-shaped, overlong, and control-character resolver names while retaining raw IDs', async () => {
    const root = await makeRoot()
    await writeStream(root, '2026-07-01', [
      fragment('unsafe', { adapter: 'discord', workspace: '123', chat: '456', thread: null }),
    ])
    const token = 'ghp' + '_' + 'X'.repeat(36)

    await enrichHistoricalProvenance(root, async (where) => ({
      where: {
        ...where,
        workspaceName: token,
        chatName: `bad\nname`,
        parentChatName: 'x'.repeat(257),
      },
      parentChecked: true,
    }))
    const index = await buildProvenanceIndex(root)
    const text = index.lexicalTextForUndreamed('streams/2026-07-01#unsafe')

    expect(text).toContain('123')
    expect(text).toContain('456')
    expect(text).not.toContain(token)
    expect(text).not.toContain('bad')
    expect(text).not.toContain('x'.repeat(257))
  })

  test('drops bidi, zero-width, and Markdown prompt-shaping names', async () => {
    const root = await makeRoot()
    await writeStream(root, '2026-07-01', [
      fragment('prompt-shaping', { adapter: 'discord', workspace: '123', chat: '456', thread: null }),
    ])

    await enrichHistoricalProvenance(root, async (where) => ({
      where: {
        ...where,
        workspaceName: 'safe\u202Eevil',
        chatName: 'zero\u200Bwidth',
        parentChatName: '**SYSTEM OVERRIDE**',
      },
      parentChecked: true,
    }))
    const text = (await buildProvenanceIndex(root)).lexicalTextForUndreamed('streams/2026-07-01#prompt-shaping')

    expect(text).not.toContain('evil')
    expect(text).not.toContain('zero')
    expect(text).not.toContain('SYSTEM OVERRIDE')
  })
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'memory-provenance-'))
  roots.push(root)
  return root
}

function legacySidecarPath(root: string): string {
  return join(root, 'memory', '.provenance-index.json')
}

function fragment(id: string, where: FragmentProvenance | undefined): FragmentEvent {
  return {
    type: 'fragment',
    id,
    ts: '2026-07-01T12:00:00.000Z',
    source: 'session-1',
    entry: `entry-${id}`,
    topic: 'Example Guild',
    body: `Body for ${id}`,
    ...(where === undefined ? {} : { where }),
  }
}

async function writeStream(root: string, date: string, events: FragmentEvent[]): Promise<void> {
  await mkdir(streamsDir(root), { recursive: true })
  await appendEvents(streamFilePath(root, date), events)
}

async function writeTopic(root: string, slug: string, body: string): Promise<void> {
  await mkdir(topicsDir(root), { recursive: true })
  await writeFile(
    topicShardPath(root, slug),
    renderShard({ heading: slug, cites: 1, days: 1, lastReinforced: '2026-07-01' }, body),
    'utf8',
  )
}
