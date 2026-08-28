import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DISCORD_BACKFILL_MAX_AGE_MS,
  DISCORD_BACKFILL_MAX_MESSAGES,
  fetchDiscordBackfill,
  loadDiscordBotRecoveryStore,
} from './discord-bot-recovery'

describe('discord-bot recovery store', () => {
  let agentDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-discord-recovery-'))
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  test('persists the newest processed snowflake per channel and disconnect start', async () => {
    const store = await loadDiscordBotRecoveryStore(agentDir)
    expect(store.listCursors()).toEqual([])
    expect(store.disconnectedAt()).toBeNull()

    await store.markProcessed({
      channelId: 'channel-1',
      workspace: 'guild-1',
      messageId: '100000000000000001',
      processedAt: 1_000,
    })
    await store.markProcessed({
      channelId: 'channel-1',
      workspace: 'guild-1',
      messageId: '100000000000000000',
      processedAt: 900,
    })
    await store.markDisconnected(1_500)

    const reloaded = await loadDiscordBotRecoveryStore(agentDir)
    expect(reloaded.listCursors()).toEqual([
      {
        channelId: 'channel-1',
        workspace: 'guild-1',
        messageId: '100000000000000001',
        processedAt: 1_000,
      },
    ])
    expect(reloaded.listReplayCursors()).toEqual(reloaded.listCursors())
    expect(reloaded.disconnectedAt()).toBe(1_500)

    await reloaded.markProcessed({
      channelId: 'channel-1',
      workspace: 'guild-1',
      messageId: '100000000000000003',
      processedAt: 2_000,
    })
    expect(reloaded.isReplayProcessed('channel-1', '100000000000000002')).toBe(false)
    expect(reloaded.isReplayProcessed('channel-1', '100000000000000003')).toBe(true)
    expect(reloaded.listReplayCursors()[0]?.messageId).toBe('100000000000000001')

    await reloaded.completeReplay('channel-1')
    expect((await loadDiscordBotRecoveryStore(agentDir)).disconnectedAt()).toBeNull()
  })

  test('clears only completed replay anchors', async () => {
    const store = await loadDiscordBotRecoveryStore(agentDir)
    await store.markProcessed({ channelId: 'channel-1', workspace: 'guild-1', messageId: '101', processedAt: 1 })
    await store.markProcessed({ channelId: 'channel-2', workspace: 'guild-1', messageId: '102', processedAt: 2 })
    await store.markDisconnected(3)

    await store.completeReplay('channel-2')

    expect(store.listReplayCursors().map((cursor) => cursor.channelId)).toEqual(['channel-1'])
    expect(store.disconnectedAt()).toBe(3)
    await store.completeReplay('channel-1')
    expect(store.listReplayCursors()).toEqual([])
    expect(store.disconnectedAt()).toBeNull()
  })

  test('merges fresh channel cursors into retained replay anchors on a later disconnect', async () => {
    const store = await loadDiscordBotRecoveryStore(agentDir)
    await store.markProcessed({ channelId: 'channel-1', workspace: 'guild-1', messageId: '101', processedAt: 1 })
    await store.markProcessed({ channelId: 'channel-2', workspace: 'guild-1', messageId: '102', processedAt: 2 })
    await store.markDisconnected(3)
    await store.completeReplay('channel-2')
    await store.markProcessed({ channelId: 'channel-2', workspace: 'guild-1', messageId: '103', processedAt: 4 })

    await store.markDisconnected(5)

    expect(store.listReplayCursors()).toEqual([
      { channelId: 'channel-1', workspace: 'guild-1', messageId: '101', processedAt: 1 },
      { channelId: 'channel-2', workspace: 'guild-1', messageId: '103', processedAt: 4 },
    ])
    expect(store.disconnectedAt()).toBe(3)
  })
})

describe('discord-bot bounded backfill', () => {
  test('returns missed messages exactly once in chronological snowflake order', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input))
      if (!String(input).includes('/messages?')) return Response.json({ id: 'channel-1', guild_id: 'guild-1' })
      return Response.json([
        discordMessage('100000000000000003', 'third', '2026-08-28T10:03:00.000Z'),
        discordMessage('100000000000000001', 'first', '2026-08-28T10:01:00.000Z'),
        discordMessage('100000000000000002', 'second', '2026-08-28T10:02:00.000Z'),
      ])
    }) as typeof fetch

    const result = await fetchDiscordBackfill({
      channelId: 'channel-1',
      workspace: 'guild-1',
      after: '100000000000000000',
      token: 'test-token',
      fetchImpl,
      now: Date.parse('2026-08-28T10:04:00.000Z'),
    })

    expect(result).toMatchObject({
      ok: true,
      outcome: 'succeeded',
      skipped: 0,
      skippedByAge: 0,
      skippedByCount: 0,
    })
    if (!result.ok) throw new Error('expected backfill success')
    expect(result.messages.map((message) => message.id)).toEqual([
      '100000000000000001',
      '100000000000000002',
      '100000000000000003',
    ])
    const request = new URL(calls.find((call) => call.includes('/messages?'))!)
    expect(request.searchParams.get('after')).toBe('100000000000000000')
    expect(request.searchParams.get('limit')).toBe(String(DISCORD_BACKFILL_MAX_MESSAGES + 1))
  })

  test('caps a long outage to recent messages and reports every observed skip', async () => {
    const now = Date.parse('2026-08-28T12:00:00.000Z')
    const raw = Array.from({ length: DISCORD_BACKFILL_MAX_MESSAGES + 1 }, (_, index) => {
      const id = String(100000000000000001n + BigInt(index))
      const timestamp = new Date(now - index * 1_000).toISOString()
      return discordMessage(id, `message-${index}`, timestamp)
    })
    raw[raw.length - 1]!.timestamp = new Date(now - DISCORD_BACKFILL_MAX_AGE_MS - 1).toISOString()

    const result = await fetchDiscordBackfill({
      channelId: 'channel-1',
      workspace: 'guild-1',
      after: '100000000000000000',
      token: 'test-token',
      fetchImpl: backfillFetch(raw),
      now,
    })

    expect(result).toMatchObject({
      ok: true,
      outcome: 'capped',
      skipped: 1,
      skippedByAge: 1,
      skippedByCount: 0,
      moreMayExist: true,
    })
    if (!result.ok) throw new Error('expected backfill success')
    expect(result.messages).toHaveLength(DISCORD_BACKFILL_MAX_MESSAGES)
  })

  test('reports count overflow separately from age trimming', async () => {
    const now = Date.parse('2026-08-28T12:00:00.000Z')
    const raw = Array.from({ length: DISCORD_BACKFILL_MAX_MESSAGES + 1 }, (_, index) =>
      discordMessage(
        String(100000000000000001n + BigInt(index)),
        `message-${index}`,
        new Date(now - index * 1_000).toISOString(),
      ),
    )

    const result = await fetchDiscordBackfill({
      channelId: 'channel-1',
      workspace: 'guild-1',
      after: '100000000000000000',
      token: 'test-token',
      fetchImpl: backfillFetch(raw),
      now,
    })

    expect(result).toMatchObject({
      ok: true,
      outcome: 'capped',
      skipped: 1,
      skippedByAge: 0,
      skippedByCount: 1,
      moreMayExist: true,
    })
  })

  test('reports unavailable history instead of pretending replay succeeded', async () => {
    const result = await fetchDiscordBackfill({
      channelId: 'channel-1',
      workspace: 'guild-1',
      after: '100000000000000000',
      token: 'test-token',
      fetchImpl: backfillFetch([], 403),
      now: 0,
    })

    expect(result).toEqual({ ok: false, outcome: 'unavailable', error: 'http 403' })
  })

  test('rejects a persisted workspace that does not own the channel', async () => {
    const result = await fetchDiscordBackfill({
      channelId: 'channel-1',
      workspace: 'guild-other',
      after: '100000000000000000',
      token: 'test-token',
      fetchImpl: backfillFetch([]),
      now: 0,
    })

    expect(result).toEqual({ ok: false, outcome: 'unavailable', error: 'channel workspace mismatch' })
  })
})

function discordMessage(id: string, content: string, timestamp: string) {
  return {
    id,
    channel_id: 'channel-1',
    guild_id: 'guild-1',
    author: { id: 'user-1', username: 'test-user', bot: false },
    content,
    timestamp,
  }
}

function backfillFetch(messages: ReturnType<typeof discordMessage>[], historyStatus = 200): typeof fetch {
  return (async (input: string | URL | Request) => {
    if (!String(input).includes('/messages?')) return Response.json({ id: 'channel-1', guild_id: 'guild-1' })
    return historyStatus === 200 ? Response.json(messages) : new Response(null, { status: historyStatus })
  }) as typeof fetch
}
