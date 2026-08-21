import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  channelsSessionsPath,
  findRecord,
  loadChannelSessions,
  saveChannelSessions,
  type ChannelSessionRecord,
} from './persistence'

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'channels-persistence-'))
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const roomBlob = 'Y2lzY29zcGFyazovL3VzL1JPT00vYWFhYWFhYWEtYmJiYi1jY2NjLWRkZGQtZWVlZWVlZWVlZWVl'
const roomRef = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('loadChannelSessions', () => {
  test('returns empty list when file is missing', async () => {
    const dir = await tempDir()
    const out = await loadChannelSessions(dir, silentLogger)
    expect(out).toEqual([])
  })

  test('loads a v5 file without clobbering lastInboundAt', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    const records: ChannelSessionRecord[] = [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_abc',
        sessionFile: '2026-05-02T16-56-52-380Z_ses_abc.jsonl',
        lastInboundAt: 1234,
        participants: [],
      },
    ]
    await writeFile(path, JSON.stringify({ version: 5, sessions: records }))

    const out = await loadChannelSessions(dir, silentLogger)

    expect(out).toHaveLength(1)
    expect(out[0]?.lastInboundAt).toBe(1234)
  })

  test('migrates a v6 session by dropping its timestamp-less review round', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        version: 6,
        sessions: [
          {
            adapter: 'github',
            workspace: 'acme/widgets',
            chat: 'pr:7',
            thread: '101',
            sessionId: 'ses_legacy_round',
            participants: [],
            githubReviewRound: {
              workspace: 'acme/widgets',
              prNumber: 7,
              headSha: 'sha-round',
              carrierThread: '101',
              status: 'pending',
              attemptedCarriers: ['101'],
            },
          },
        ],
      }),
    )

    const out = await loadChannelSessions(dir, silentLogger)

    expect(out).toHaveLength(1)
    expect(out[0]?.sessionId).toBe('ses_legacy_round')
    expect(out[0]?.githubReviewRound).toBeUndefined()
  })

  test('migrates v4 Webex room ids to refs and leaves existing refs unchanged', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        version: 4,
        sessions: [
          record({ adapter: 'webex', workspace: roomBlob, chat: roomBlob, thread: roomBlob, sessionId: 'blob' }),
          record({ adapter: 'webex-bot', workspace: roomRef, chat: roomRef, thread: null, sessionId: 'ref' }),
        ],
      }),
    )

    const out = await loadChannelSessions(dir, silentLogger)

    expect(out.map((r) => [r.adapter, r.workspace, r.chat, r.thread, r.sessionId])).toEqual([
      ['webex', roomRef, roomRef, roomRef, 'blob'],
      ['webex-bot', roomRef, roomRef, null, 'ref'],
    ])
  })

  test('dedupes v4 Webex collisions by newest inbound time, then session pointer', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        version: 4,
        sessions: [
          record({
            adapter: 'webex',
            workspace: roomBlob,
            chat: roomBlob,
            thread: null,
            sessionId: 'old',
            lastInboundAt: 1,
          }),
          record({
            adapter: 'webex',
            workspace: roomRef,
            chat: roomRef,
            thread: null,
            sessionId: 'new',
            lastInboundAt: 2,
          }),
          record({ adapter: 'webex-bot', workspace: roomBlob, chat: roomBlob, thread: null, lastInboundAt: 3 }),
          record({
            adapter: 'webex-bot',
            workspace: roomRef,
            chat: roomRef,
            thread: null,
            sessionFile: 'kept.jsonl',
            lastInboundAt: 3,
          }),
        ],
      }),
    )

    const out = await loadChannelSessions(dir, silentLogger)

    expect(out).toHaveLength(2)
    expect(out.find((r) => r.adapter === 'webex')?.sessionId).toBe('new')
    expect(out.find((r) => r.adapter === 'webex-bot')?.sessionFile).toBe('kept.jsonl')
  })

  test('does not rewrite non-Webex v4 records', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        version: 4,
        sessions: [record({ adapter: 'discord-bot', workspace: roomBlob, chat: roomBlob, thread: roomBlob })],
      }),
    )

    const out = await loadChannelSessions(dir, silentLogger)

    expect(out[0]?.workspace).toBe(roomBlob)
    expect(out[0]?.chat).toBe(roomBlob)
    expect(out[0]?.thread).toBe(roomBlob)
  })

  for (const version of [2, 3]) {
    test(`returns empty list and logs when v${version} file is no longer supported`, async () => {
      const dir = await tempDir()
      const path = channelsSessionsPath(dir)
      await mkdir(join(dir, 'channels'), { recursive: true })
      await writeFile(
        path,
        JSON.stringify({
          version,
          sessions: [
            {
              adapter: 'discord-bot',
              workspace: 'g1',
              chat: 'c1',
              thread: null,
              sessionId: 'ses_abc',
              sessionFile: '2026-05-02T16-56-52-380Z_ses_abc.jsonl',
              participants: [],
            },
          ],
        }),
      )
      const warns: string[] = []

      const out = await loadChannelSessions(dir, { info: () => {}, warn: (m) => warns.push(m), error: () => {} })

      expect(out).toEqual([])
      expect(warns[0]).toContain(`version ${version} not supported`)
      expect(warns[0]).toContain('expected 7')
    })
  }

  test('returns empty list and logs when file is corrupted JSON', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFile(path, '{not valid')
    const errors: string[] = []
    const out = await loadChannelSessions(dir, { info: () => {}, warn: () => {}, error: (m) => errors.push(m) })
    expect(out).toEqual([])
    expect(errors[0]).toContain('corrupted')
  })

  test('returns empty list and logs when file version is not supported', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 8, sessions: [] }))
    const warns: string[] = []
    const out = await loadChannelSessions(dir, { info: () => {}, warn: (m) => warns.push(m), error: () => {} })
    expect(out).toEqual([])
    expect(warns[0]).toContain('version 8 not supported')
    expect(warns[0]).toContain('expected 7')
  })
})

describe('saveChannelSessions', () => {
  test('persists records as a v6 file with stable structure', async () => {
    const dir = await tempDir()
    const records: ChannelSessionRecord[] = [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_abc',
        sessionFile: '2026-05-02T16-56-52-380Z_ses_abc.jsonl',
        participants: [],
      },
    ]
    await saveChannelSessions(dir, records, silentLogger)
    const raw = await readFile(channelsSessionsPath(dir), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(7)
    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0].sessionId).toBe('ses_abc')
    expect(parsed.sessions[0].sessionFile).toBe('2026-05-02T16-56-52-380Z_ses_abc.jsonl')
  })

  test('round-trips through load + save (with sessionFile)', async () => {
    const dir = await tempDir()
    const records: ChannelSessionRecord[] = [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_abc',
        sessionFile: '2026-05-02T16-56-52-380Z_ses_abc.jsonl',
        participants: [{ authorId: 'u1', authorName: 'alice', firstMessageAt: 1, lastMessageAt: 2, messageCount: 3 }],
      },
    ]
    await saveChannelSessions(dir, records, silentLogger)
    const loaded = await loadChannelSessions(dir, silentLogger)
    expect(loaded).toEqual(records)
  })

  test('round-trips through load + save (without sessionFile, e.g. unmigrated)', async () => {
    const dir = await tempDir()
    const records: ChannelSessionRecord[] = [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_abc',
        participants: [],
      },
    ]
    await saveChannelSessions(dir, records, silentLogger)
    const loaded = await loadChannelSessions(dir, silentLogger)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.sessionId).toBe('ses_abc')
    expect(loaded[0]?.sessionFile).toBeUndefined()
  })

  test('round-trips a pending GitHub review round on the existing session record', async () => {
    const dir = await tempDir()
    const records: ChannelSessionRecord[] = [
      {
        adapter: 'github',
        workspace: 'acme/widgets',
        chat: 'pr:7',
        thread: '101',
        sessionId: 'ses_round',
        participants: [],
        githubReviewRound: {
          workspace: 'acme/widgets',
          prNumber: 7,
          headSha: 'sha-round',
          carrierThread: '101',
          status: 'pending',
          createdAt: Date.now(),
          attemptedCarriers: ['101'],
        },
      },
    ]
    await saveChannelSessions(dir, records, silentLogger)
    expect(await loadChannelSessions(dir, silentLogger)).toEqual(records)
  })

  test('round-trips a completed GitHub review round until its thread close-out', async () => {
    const dir = await tempDir()
    const records: ChannelSessionRecord[] = [
      {
        adapter: 'github',
        workspace: 'acme/widgets',
        chat: 'pr:7',
        thread: '202',
        sessionId: 'ses_completed_round',
        participants: [],
        githubReviewRound: {
          workspace: 'acme/widgets',
          prNumber: 7,
          headSha: 'sha-round',
          carrierThread: '101',
          status: 'completed',
          createdAt: Date.now(),
          attemptedCarriers: ['101'],
        },
      },
    ]
    await saveChannelSessions(dir, records, silentLogger)
    expect(await loadChannelSessions(dir, silentLogger)).toEqual(records)
  })

  test('drops a pending round whose PR identity does not match its session record', async () => {
    const dir = await tempDir()
    const path = channelsSessionsPath(dir)
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        version: 7,
        sessions: [
          {
            adapter: 'github',
            workspace: 'acme/widgets',
            chat: 'pr:7',
            thread: '101',
            participants: [],
            githubReviewRound: {
              workspace: 'acme/other',
              prNumber: 8,
              headSha: 'sha-round',
              carrierThread: '101',
              status: 'pending',
              createdAt: Date.now(),
              attemptedCarriers: ['101'],
            },
          },
        ],
      }),
    )
    expect(await loadChannelSessions(dir, silentLogger)).toEqual([])
  })

  test('dedupes by 4-tuple, last-write-wins', async () => {
    const dir = await tempDir()
    const a: ChannelSessionRecord = {
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      thread: null,
      sessionId: 'old',
      participants: [],
    }
    const b: ChannelSessionRecord = { ...a, sessionId: 'new' }
    await saveChannelSessions(dir, [a, b], silentLogger)
    const loaded = await loadChannelSessions(dir, silentLogger)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.sessionId).toBe('new')
  })
})

describe('findRecord', () => {
  test('matches on the full 4-tuple', () => {
    const records: ChannelSessionRecord[] = [
      { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null, sessionId: 's1', participants: [] },
      { adapter: 'discord-bot', workspace: 'g1', chat: 'c2', thread: null, sessionId: 's2', participants: [] },
    ]
    const found = findRecord(records, { adapter: 'discord-bot', workspace: 'g1', chat: 'c2', thread: null })
    expect(found?.sessionId).toBe('s2')
  })

  test('treats missing thread as null', () => {
    const records: ChannelSessionRecord[] = [
      { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null, sessionId: 's1', participants: [] },
    ]
    const found = findRecord(records, { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })
    expect(found?.sessionId).toBe('s1')
  })

  test('falls back to normalized Webex room refs on exact miss', () => {
    const records: ChannelSessionRecord[] = [
      { adapter: 'webex', workspace: roomBlob, chat: roomBlob, thread: null, sessionId: 's1', participants: [] },
    ]
    const found = findRecord(records, { adapter: 'webex', workspace: roomRef, chat: roomRef, thread: null })
    expect(found?.sessionId).toBe('s1')
  })

  test('does not normalize non-Webex fallback matches', () => {
    const records: ChannelSessionRecord[] = [
      { adapter: 'discord-bot', workspace: roomBlob, chat: roomBlob, thread: null, sessionId: 's1', participants: [] },
    ]
    const found = findRecord(records, { adapter: 'discord-bot', workspace: roomRef, chat: roomRef, thread: null })
    expect(found).toBeUndefined()
  })
})

function record(overrides: Partial<ChannelSessionRecord>): ChannelSessionRecord {
  return {
    adapter: 'discord-bot',
    workspace: 'g1',
    chat: 'c1',
    thread: null,
    participants: [],
    ...overrides,
  }
}
