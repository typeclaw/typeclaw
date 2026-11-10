import { describe, expect, test } from 'bun:test'

import type { KakaoMember, KakaoMemberSnapshot } from 'agent-messenger/kakaotalk'

import type { KakaoTalkClient } from './kakaotalk'
import { createKakaoAuthorResolver } from './kakaotalk-author-resolver'

const member = (overrides: Partial<KakaoMember>): KakaoMember => ({
  user_id: '0',
  nickname: '',
  profile_image_url: null,
  full_profile_image_url: null,
  original_profile_image_url: null,
  status_message: null,
  country_iso: null,
  user_type: 100,
  open_token: null,
  open_profile_link_id: null,
  open_permission: null,
  ...overrides,
})

const snapshot = (members: KakaoMember[]): KakaoMemberSnapshot => ({
  chat_id: 'chat',
  active_members: members.length,
  members,
  complete: true,
  consistency_basis: 'stable_double_read_chatinfo_getmem',
})

type FakeMembersClient = Pick<KakaoTalkClient, 'getMemberSnapshot'> & {
  calls: string[]
  failWith?: Error
}

const fakeClient = (membersByChat: Record<string, KakaoMember[]> = {}): FakeMembersClient => {
  const map = new Map(Object.entries(membersByChat))
  const calls: string[] = []
  return {
    calls,
    getMemberSnapshot(chatId: string): Promise<KakaoMemberSnapshot> {
      calls.push(chatId)
      if (this.failWith !== undefined) return Promise.reject(this.failWith)
      return Promise.resolve(snapshot(map.get(chatId) ?? []))
    },
  }
}

describe('createKakaoAuthorResolver', () => {
  test('returns null when GETMEM has no entry for the requested user', async () => {
    const client = fakeClient({ '111': [member({ user_id: '777', nickname: 'Bob' })] })
    const resolver = createKakaoAuthorResolver({ client })

    expect(await resolver.resolve('999', '111')).toBeNull()
  })

  test('resolves a known member nickname via GETMEM', async () => {
    const client = fakeClient({
      '111': [member({ user_id: '222', nickname: 'Alice' }), member({ user_id: '333', nickname: 'Bob' })],
    })
    const resolver = createKakaoAuthorResolver({ client })

    expect(await resolver.resolve('222', '111')).toBe('Alice')
    expect(await resolver.resolve('333', '111')).toBe('Bob')
  })

  test('caches member list per chat — second hit on same chat does not re-fetch', async () => {
    const client = fakeClient({ '111': [member({ user_id: '222', nickname: 'Alice' })] })
    const resolver = createKakaoAuthorResolver({ client })

    await resolver.resolve('222', '111')
    await resolver.resolve('222', '111')
    await resolver.resolve('222', '111')

    expect(client.calls).toEqual(['111'])
  })

  test('refetches after the TTL expires', async () => {
    let now = 1_000_000
    const client = fakeClient({ '111': [member({ user_id: '222', nickname: 'Alice' })] })
    const resolver = createKakaoAuthorResolver({ client, now: () => now, ttlMs: 100 })

    await resolver.resolve('222', '111')
    expect(client.calls).toEqual(['111'])

    now += 50
    await resolver.resolve('222', '111')
    expect(client.calls).toEqual(['111'])

    now += 100
    await resolver.resolve('222', '111')
    expect(client.calls).toEqual(['111', '111'])
  })

  test('does not poison the cache on a single chat failure — next call retries', async () => {
    const logs: string[] = []
    const client = fakeClient({ '111': [member({ user_id: '222', nickname: 'Alice' })] })
    client.failWith = new Error('socket reset')

    const resolver = createKakaoAuthorResolver({
      client,
      logger: { warn: (msg) => logs.push(msg) },
    })

    expect(await resolver.resolve('222', '111')).toBeNull()
    expect(logs.some((l) => l.includes('socket reset'))).toBe(true)

    client.failWith = undefined
    expect(await resolver.resolve('222', '111')).toBe('Alice')
    expect(client.calls).toEqual(['111', '111'])
  })

  test('caches negative results within the TTL window', async () => {
    const client = fakeClient({ '111': [member({ user_id: '222', nickname: 'Alice' })] })
    const resolver = createKakaoAuthorResolver({ client })

    expect(await resolver.resolve('999', '111')).toBeNull()
    expect(await resolver.resolve('999', '111')).toBeNull()
    // The chat's full member list was already fetched on the first miss;
    // the second miss reads from the cached list (which legitimately has
    // no entry for 999) without firing another GETMEM.
    expect(client.calls).toEqual(['111'])
  })

  test('coalesces concurrent resolve() calls on the same chat into one GETMEM', async () => {
    let resolveBatch: ((value: KakaoMemberSnapshot) => void) | null = null
    const client: Pick<KakaoTalkClient, 'getMemberSnapshot'> & { calls: string[] } = {
      calls: [],
      getMemberSnapshot(chatId: string): Promise<KakaoMemberSnapshot> {
        this.calls.push(chatId)
        return new Promise((res) => {
          resolveBatch = res
        })
      },
    }
    const resolver = createKakaoAuthorResolver({ client })

    const inflight = Promise.all([
      resolver.resolve('222', '111'),
      resolver.resolve('333', '111'),
      resolver.resolve('444', '111'),
    ])

    // Give the resolver a tick to start the underlying request.
    await new Promise((r) => setTimeout(r, 0))
    expect(client.calls).toEqual(['111'])

    resolveBatch!(
      snapshot([member({ user_id: '222', nickname: 'Alice' }), member({ user_id: '333', nickname: 'Bob' })]),
    )

    const results = await inflight
    expect(results).toEqual(['Alice', 'Bob', null])
    expect(client.calls).toEqual(['111'])
  })
})
