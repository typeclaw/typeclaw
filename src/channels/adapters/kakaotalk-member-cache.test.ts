import { describe, expect, test } from 'bun:test'

import type { KakaoMemberSnapshot } from 'agent-messenger/kakaotalk'

import { createKakaoMemberSnapshotCache } from './kakaotalk-member-cache'
import { createKakaoMembershipResolver } from './kakaotalk-membership'

const snapshot = (chatId: string): KakaoMemberSnapshot => ({
  chat_id: chatId,
  active_members: 0,
  members: [],
  complete: true,
  consistency_basis: 'stable_double_read_chatinfo_getmem',
})

const read = { allowPartial: true } as const

function harness(fail = false) {
  let now = 0
  const calls: string[] = []
  const cache = createKakaoMemberSnapshotCache({
    client: {
      getMemberSnapshot: async (chatId) => {
        calls.push(chatId)
        if (fail) throw new Error('member_snapshot_changed_or_incomplete')
        return snapshot(chatId)
      },
    },
    now: () => now,
    ttlMs: 1_000,
    failureTtlMs: 100,
  })
  return { cache, calls, advance: (ms: number) => (now += ms) }
}

describe('createKakaoMemberSnapshotCache', () => {
  test('serves concurrent and repeat reads of one chat from a single GETMEM', async () => {
    const h = harness()
    await Promise.all([h.cache.getMemberSnapshot('1', read), h.cache.getMemberSnapshot('1', read)])
    await h.cache.getMemberSnapshot('1', read)
    await h.cache.getMemberSnapshot('2', read)
    expect(h.calls).toEqual(['1', '2'])
  })

  test('reads again once the entry expires', async () => {
    const h = harness()
    await h.cache.getMemberSnapshot('1', read)
    h.advance(1_000)
    await h.cache.getMemberSnapshot('1', read)
    expect(h.calls).toEqual(['1', '1'])
  })

  test('replays a failed read until the shorter failure window passes', async () => {
    const h = harness(true)
    await expect(h.cache.getMemberSnapshot('1', read)).rejects.toThrow(/incomplete/)
    await expect(h.cache.getMemberSnapshot('1', read)).rejects.toThrow(/incomplete/)
    expect(h.calls).toEqual(['1'])

    h.advance(100)
    await expect(h.cache.getMemberSnapshot('1', read)).rejects.toThrow(/incomplete/)
    expect(h.calls).toEqual(['1', '1'])
  })

  test('a cache hit reports when the server answered, not when it was served', async () => {
    const h = harness()
    h.advance(5)
    await h.cache.getMemberSnapshot('1', read)
    h.advance(500)
    expect((await h.cache.readMemberSnapshot('1')).fetchedAt).toBe(5)
  })

  test('membership derived from a cached roster stays as old as the roster', async () => {
    let now = 0
    const cache = createKakaoMemberSnapshotCache({
      client: { getMemberSnapshot: async (chatId) => snapshot(chatId) },
      now: () => now,
    })
    const resolve = createKakaoMembershipResolver({
      client: cache,
      roster: cache,
      selfUserIdRef: () => '999',
      logger: { warn: () => {} },
      now: () => now,
    })
    const key = { adapter: 'kakaotalk', workspace: '@kakao-group', chat: '1', thread: null } as const

    await resolve(key)
    now = 2 * 60 * 1000
    const later = await resolve(key)

    expect(later).toMatchObject({ fetchedAt: 0 })
  })

  test('invalidate forces the next read to hit the server', async () => {
    const h = harness()
    await h.cache.getMemberSnapshot('1', read)
    h.cache.invalidate('1')
    await h.cache.getMemberSnapshot('1', read)
    expect(h.calls).toEqual(['1', '1'])
  })
})
