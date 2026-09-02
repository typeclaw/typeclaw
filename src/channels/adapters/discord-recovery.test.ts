import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DiscordMessage } from 'agent-messenger/discord'

import {
  DISCORD_RECOVERY_MAX_AGE_MS,
  DISCORD_RECOVERY_MAX_ACCOUNTS,
  DISCORD_RECOVERY_MAX_CHANNELS_PER_ACCOUNT,
  DISCORD_RECOVERY_MAX_FILE_BYTES,
  DISCORD_RECOVERY_MAX_MESSAGES,
  DISCORD_RECOVERY_MAX_RECENT_IDS_PER_CHANNEL,
  discordRecoveryPath,
  fetchDiscordRecovery,
  loadDiscordRecoveryStore,
} from './discord-recovery'

describe('Discord user recovery store', () => {
  let agentDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-discord-user-recovery-'))
    await mkdir(join(agentDir, 'channels'))
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  test('persists monotonic per-channel cursors and retained replay anchors for one account', async () => {
    const store = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    await store.markProcessed({
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      messageId: '402',
      processedAt: 2,
    })
    await store.markProcessed({
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      messageId: '401',
      processedAt: 1,
    })
    await store.markDisconnected(3)
    await store.markProcessed({
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      messageId: '404',
      processedAt: 4,
    })

    const reloaded = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    expect(reloaded.listCursors()).toEqual([
      { channelId: '300000000000000001', workspace: '200000000000000001', messageId: '404', processedAt: 4 },
    ])
    expect(reloaded.listReplayCursors()).toEqual([
      { channelId: '300000000000000001', workspace: '200000000000000001', messageId: '402', processedAt: 2 },
    ])
    expect(reloaded.disconnectedAt()).toBe(3)
    expect(reloaded.isProcessed('300000000000000001', '403')).toBe(false)
    expect(reloaded.isProcessed('300000000000000001', '404')).toBe(true)

    const stat = await lstat(discordRecoveryPath(agentDir))
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600)
    }
  })

  test('persists a synthetic zero predecessor anchor for a first-message route failure', async () => {
    const store = await loadDiscordRecoveryStore(agentDir, '100000000000000001')

    await store.markRouteFailed({
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      failedMessageId: '1',
      failedAt: 10,
    })

    const reloaded = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    expect(reloaded.listCursors()).toEqual([])
    expect(reloaded.listReplayCursors()).toEqual([
      {
        channelId: '300000000000000001',
        workspace: '200000000000000001',
        messageId: '0',
        processedAt: 10,
      },
    ])
    expect(reloaded.disconnectedAt()).toBe(10)
  })

  test('route failure preserves an older replay anchor and snapshots other current channels', async () => {
    const store = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    await store.markProcessed({
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      messageId: '401',
      processedAt: 1,
    })
    await store.markProcessed({
      channelId: '300000000000000002',
      workspace: '@dm',
      messageId: '501',
      processedAt: 2,
    })
    await store.markDisconnected(3)
    await store.markProcessed({
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      messageId: '404',
      processedAt: 4,
    })

    await store.markRouteFailed({
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      failedMessageId: '403',
      failedAt: 5,
    })

    expect(store.listReplayCursors()).toEqual([
      {
        channelId: '300000000000000001',
        workspace: '200000000000000001',
        messageId: '401',
        processedAt: 1,
      },
      { channelId: '300000000000000002', workspace: '@dm', messageId: '501', processedAt: 2 },
    ])
    expect(store.disconnectedAt()).toBe(3)
  })

  test('route failure uses the prior successful cursor instead of a newer synthetic anchor', async () => {
    const store = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    await store.markProcessed({
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      messageId: '401',
      processedAt: 1,
    })

    await store.markRouteFailed({
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      failedMessageId: '405',
      failedAt: 2,
    })

    expect(store.listReplayCursors()).toEqual([
      {
        channelId: '300000000000000001',
        workspace: '200000000000000001',
        messageId: '401',
        processedAt: 1,
      },
    ])
  })

  test('stale completion cannot clear anchors after a newer disconnect epoch', async () => {
    const replay = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    await replay.markProcessed({
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      messageId: '401',
      processedAt: 1,
    })
    await replay.markDisconnected(2)
    const replayEpoch = replay.currentEpoch()
    const newer = await loadDiscordRecoveryStore(agentDir, '100000000000000001')

    await newer.markDisconnected(3)
    await replay.completeReplay('300000000000000001', replayEpoch)

    const reloaded = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    expect(reloaded.currentEpoch()).toBe(replayEpoch + 1)
    expect(reloaded.listReplayCursors()).toHaveLength(1)
    expect(reloaded.disconnectedAt()).toBe(2)
  })

  test('stale completion cannot clear anchors after a newer route-failure epoch', async () => {
    const replay = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    await replay.markProcessed({
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      messageId: '401',
      processedAt: 1,
    })
    await replay.markDisconnected(2)
    const replayEpoch = replay.currentEpoch()
    const newer = await loadDiscordRecoveryStore(agentDir, '100000000000000001')

    await newer.markRouteFailed({
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      failedMessageId: '402',
      failedAt: 3,
    })
    await replay.completeReplay('300000000000000001', replayEpoch)

    const reloaded = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    expect(reloaded.currentEpoch()).toBe(replayEpoch + 1)
    expect(reloaded.listReplayCursors()).toHaveLength(1)
  })

  test('same-epoch channel completions clear the final disconnect state', async () => {
    const store = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    await store.markProcessed({
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      messageId: '401',
      processedAt: 1,
    })
    await store.markProcessed({
      channelId: '300000000000000002',
      workspace: '200000000000000001',
      messageId: '402',
      processedAt: 2,
    })
    await store.markDisconnected(3)
    const epoch = store.currentEpoch()

    await store.completeReplay('300000000000000001', epoch)
    expect(store.disconnectedAt()).toBe(3)
    await store.completeReplay('300000000000000002', epoch)

    expect(store.listReplayCursors()).toEqual([])
    expect(store.disconnectedAt()).toBeNull()
  })

  test('does not expose one authenticated account cursor to another account', async () => {
    const first = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    await first.markProcessed({
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      messageId: '401',
      processedAt: 1,
    })
    await first.markDisconnected(2)

    const second = await loadDiscordRecoveryStore(agentDir, '100000000000000002')
    expect(second.listCursors()).toEqual([])
    expect(second.listReplayCursors()).toEqual([])
    await second.markProcessed({
      channelId: '300000000000000001',
      workspace: '200000000000000002',
      messageId: '501',
      processedAt: 3,
    })

    expect((await loadDiscordRecoveryStore(agentDir, '100000000000000001')).listReplayCursors()).toEqual([
      { channelId: '300000000000000001', workspace: '200000000000000001', messageId: '401', processedAt: 1 },
    ])
    const persisted = JSON.parse(await readFile(discordRecoveryPath(agentDir), 'utf8')) as { accounts: unknown[] }
    expect(persisted.accounts).toHaveLength(2)
  })

  test('merges concurrent writes from independently loaded account stores', async () => {
    const first = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    const second = await loadDiscordRecoveryStore(agentDir, '100000000000000002')

    await Promise.all([
      first.markProcessed({
        channelId: '300000000000000001',
        workspace: '200000000000000001',
        messageId: '400000000000000001',
        processedAt: 1,
      }),
      second.markProcessed({
        channelId: '300000000000000002',
        workspace: '200000000000000002',
        messageId: '400000000000000002',
        processedAt: 2,
      }),
    ])

    expect((await loadDiscordRecoveryStore(agentDir, '100000000000000001')).listCursors()).toHaveLength(1)
    expect((await loadDiscordRecoveryStore(agentDir, '100000000000000002')).listCursors()).toHaveLength(1)
  })

  test('applies concurrent same-account cursor writes to the latest locked state', async () => {
    const first = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    const second = await loadDiscordRecoveryStore(agentDir, '100000000000000001')

    await Promise.all([
      first.markProcessed({
        channelId: '300000000000000001',
        workspace: '200000000000000001',
        messageId: '400000000000000001',
        processedAt: 1,
      }),
      second.markProcessed({
        channelId: '300000000000000002',
        workspace: '200000000000000001',
        messageId: '400000000000000002',
        processedAt: 2,
      }),
    ])

    expect(
      (await loadDiscordRecoveryStore(agentDir, '100000000000000001'))
        .listCursors()
        .map((cursor) => cursor.channelId)
        .sort(),
    ).toEqual(['300000000000000001', '300000000000000002'])
  })

  test('rejects semantically inconsistent disconnect and replay state', async () => {
    const cursor = {
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      messageId: '400000000000000001',
      processedAt: 1,
    }
    for (const state of [
      { disconnectedAt: null, replayCursors: [cursor] },
      { disconnectedAt: 1, replayCursors: [] },
    ]) {
      await writeFile(
        discordRecoveryPath(agentDir),
        JSON.stringify({
          version: 1,
          accounts: [
            {
              accountId: '100000000000000001',
              recoveryEpoch: 0,
              cursors: [cursor],
              recentMessageIds: [],
              ...state,
            },
          ],
        }),
      )
      expect((await loadDiscordRecoveryStore(agentDir, '100000000000000001')).listCursors()).toEqual([])
    }

    await writeFile(
      discordRecoveryPath(agentDir),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            accountId: '100000000000000001',
            recoveryEpoch: Number.MAX_SAFE_INTEGER + 1,
            disconnectedAt: null,
            cursors: [cursor],
            replayCursors: [],
            recentMessageIds: [],
          },
        ],
      }),
    )
    expect((await loadDiscordRecoveryStore(agentDir, '100000000000000001')).listCursors()).toEqual([])
  })

  test('rejects malformed writes and malformed persisted identifiers', async () => {
    const store = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    await expect(
      store.markProcessed({ channelId: 'not-a-snowflake', workspace: '@dm', messageId: '401', processedAt: 1 }),
    ).rejects.toThrow('invalid Discord channel id')

    await writeFile(
      discordRecoveryPath(agentDir),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            accountId: 'invalid-account',
            recoveryEpoch: 0,
            disconnectedAt: -1,
            cursors: [],
            replayCursors: [],
            recentMessageIds: [],
          },
        ],
      }),
    )
    const lines: string[] = []
    const reloaded = await loadDiscordRecoveryStore(agentDir, '100000000000000001', {
      warn: (message) => lines.push(message),
      error: (message) => lines.push(message),
    })
    expect(reloaded.listCursors()).toEqual([])
    expect(lines.some((line) => line.includes('invalid'))).toBe(true)

    await writeFile(
      discordRecoveryPath(agentDir),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            accountId: '100000000000000001',
            recoveryEpoch: 0,
            disconnectedAt: null,
            cursors: [
              {
                channelId: '300000000000000001',
                workspace: 'invalid-workspace',
                messageId: '400000000000000001',
                processedAt: Number.POSITIVE_INFINITY,
              },
            ],
            replayCursors: [],
            recentMessageIds: [],
          },
        ],
      }),
    )
    expect((await loadDiscordRecoveryStore(agentDir, '100000000000000001')).listCursors()).toEqual([])
  })

  test('rejects oversized files and account cardinality before parsing into live state', async () => {
    await writeFile(discordRecoveryPath(agentDir), Buffer.alloc(DISCORD_RECOVERY_MAX_FILE_BYTES + 1, 0x20))
    const oversized = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    expect(oversized.listCursors()).toEqual([])

    await writeFile(
      discordRecoveryPath(agentDir),
      JSON.stringify({
        version: 1,
        accounts: Array.from({ length: DISCORD_RECOVERY_MAX_ACCOUNTS + 1 }, (_, index) => ({
          accountId: String(100000000000000001n + BigInt(index)),
          recoveryEpoch: 0,
          disconnectedAt: null,
          cursors: [],
          replayCursors: [],
          recentMessageIds: [],
        })),
      }),
    )
    const overCardinality = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    expect(overCardinality.listCursors()).toEqual([])

    const cursor = (index: number) => ({
      channelId: String(300000000000000001n + BigInt(index)),
      workspace: '200000000000000001',
      messageId: String(400000000000000001n + BigInt(index)),
      processedAt: index,
    })
    await writeFile(
      discordRecoveryPath(agentDir),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            accountId: '100000000000000001',
            recoveryEpoch: 0,
            disconnectedAt: 1,
            cursors: Array.from({ length: DISCORD_RECOVERY_MAX_CHANNELS_PER_ACCOUNT + 1 }, (_, index) => cursor(index)),
            replayCursors: [cursor(0)],
            recentMessageIds: [],
          },
        ],
      }),
    )
    expect((await loadDiscordRecoveryStore(agentDir, '100000000000000001')).listCursors()).toEqual([])

    await writeFile(
      discordRecoveryPath(agentDir),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            accountId: '100000000000000001',
            recoveryEpoch: 0,
            disconnectedAt: null,
            cursors: [],
            replayCursors: [],
            recentMessageIds: [
              {
                channelId: '300000000000000001',
                messageIds: Array.from({ length: DISCORD_RECOVERY_MAX_RECENT_IDS_PER_CHANNEL + 1 }, (_, index) =>
                  String(400000000000000001n + BigInt(index)),
                ),
              },
            ],
          },
        ],
      }),
    )
    expect((await loadDiscordRecoveryStore(agentDir, '100000000000000001')).listCursors()).toEqual([])
  })

  test('rejects a symlink recovery target on read and write', async () => {
    const target = join(agentDir, 'outside.json')
    await writeFile(target, JSON.stringify({ version: 1, accounts: [] }))
    await symlink(target, discordRecoveryPath(agentDir))

    const store = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
    expect(store.listCursors()).toEqual([])
    await expect(
      store.markProcessed({
        channelId: '300000000000000001',
        workspace: '200000000000000001',
        messageId: '400000000000000001',
        processedAt: 1,
      }),
    ).rejects.toThrow('symbolic link')
  })
})

describe('Discord user bounded recovery fetch', () => {
  test('uses the user client history API and returns only newer messages oldest-first', async () => {
    const calls: unknown[][] = []
    const client = recoveryClient([message('403', 'third'), message('401', 'old'), message('402', 'second')], calls)

    const result = await fetchDiscordRecovery({
      client,
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      after: '401',
      now: Date.parse('2026-08-28T10:05:00.000Z'),
    })

    expect(result).toMatchObject({ ok: true, outcome: 'succeeded', skippedByAge: 0, skippedByCount: 0 })
    if (!result.ok) throw new Error('expected recovery success')
    expect(result.messages.map((item) => item.id)).toEqual(['402', '403'])
    expect(calls).toEqual([
      ['getChannel', '300000000000000001'],
      ['getMessages', '300000000000000001', DISCORD_RECOVERY_MAX_MESSAGES + 1],
    ])
  })

  test('retains an unavailable result on REST failure', async () => {
    const result = await fetchDiscordRecovery({
      client: {
        getChannel: async () => ({
          id: '300000000000000001',
          guild_id: '200000000000000001',
          name: 'general',
          type: 0,
        }),
        getMessages: async () => {
          throw new Error('network unavailable')
        },
      },
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      after: '401',
      now: 0,
    })

    expect(result).toEqual({ ok: false, outcome: 'unavailable', error: 'network unavailable' })
  })

  test('bounds replay by age and per-channel message count', async () => {
    const now = Date.parse('2026-08-28T12:00:00.000Z')
    const messages = Array.from({ length: DISCORD_RECOVERY_MAX_MESSAGES + 1 }, (_, index) =>
      message(
        String(400000000000000001n + BigInt(index)),
        `message-${index}`,
        new Date(now - index * 1_000).toISOString(),
      ),
    )
    messages[messages.length - 1]!.timestamp = new Date(now - DISCORD_RECOVERY_MAX_AGE_MS - 1).toISOString()

    const result = await fetchDiscordRecovery({
      client: recoveryClient(messages),
      channelId: '300000000000000001',
      workspace: '200000000000000001',
      after: '400000000000000000',
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
    if (!result.ok) throw new Error('expected recovery success')
    expect(result.messages).toHaveLength(DISCORD_RECOVERY_MAX_MESSAGES)
  })

  test('rejects malformed recovery identifiers without authenticated client calls', async () => {
    const cases = [
      { channelId: '../messages', workspace: '@dm', after: '400000000000000001', error: 'invalid Discord channel id' },
      {
        channelId: '300000000000000001',
        workspace: 'invalid-workspace',
        after: '400000000000000001',
        error: 'invalid Discord workspace id',
      },
      {
        channelId: '300000000000000001',
        workspace: '@dm',
        after: 'invalid-message',
        error: 'invalid Discord message id',
      },
    ]
    for (const item of cases) {
      const calls: unknown[][] = []
      const result = await fetchDiscordRecovery({
        client: recoveryClient([], calls),
        channelId: item.channelId,
        workspace: item.workspace,
        after: item.after,
        now: 0,
      })
      expect(result).toEqual({ ok: false, outcome: 'unavailable', error: item.error })
      expect(calls).toEqual([])
    }
  })
})

function message(id: string, content: string, timestamp = '2026-08-28T10:00:00.000Z'): DiscordMessage {
  return {
    id,
    channel_id: '300000000000000001',
    author: { id: '500000000000000001', username: 'alice' },
    content,
    timestamp,
  }
}

function recoveryClient(messages: DiscordMessage[], calls: unknown[][] = []) {
  return {
    getChannel: async (channelId: string) => {
      calls.push(['getChannel', channelId])
      return { id: channelId, guild_id: '200000000000000001', name: 'general', type: 0 }
    },
    getMessages: async (channelId: string, limit: number) => {
      calls.push(['getMessages', channelId, limit])
      return messages
    },
  }
}
