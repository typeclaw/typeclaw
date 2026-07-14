import { describe, expect, test } from 'bun:test'

import type { KakaoChat } from 'agent-messenger/kakaotalk'

import type { KakaoTalkClient } from './kakaotalk'
import { createKakaoChannelResolver, kakaoWorkspaceForType } from './kakaotalk-channel-resolver'

// Modern KakaoTalk LOCO type codes — t=11 for normal 1:1 DMs and t=10 for
// normal groups. The earlier `t=0/1/2` fixtures matched a stale assumption
// and let the previous classifier pass even though it misclassified every
// real-world DM as `@kakao-group`.
const dmChat = (id: string, name: string, overrides: Partial<KakaoChat> = {}): KakaoChat => ({
  chat_id: id,
  type: 11,
  display_name: name,
  title: null,
  active_members: 2,
  unread_count: 0,
  last_message: null,
  ...overrides,
})

const groupChat = (id: string, name: string, overrides: Partial<KakaoChat> = {}): KakaoChat => ({
  chat_id: id,
  type: 10,
  display_name: name,
  title: null,
  active_members: 5,
  unread_count: 0,
  last_message: null,
  ...overrides,
})

const fakeClient = (chats: KakaoChat[]): Pick<KakaoTalkClient, 'getChats'> => ({
  getChats: async () => chats,
})

describe('createKakaoChannelResolver', () => {
  test('lookupChat returns null for unknown chats', () => {
    const resolver = createKakaoChannelResolver({ client: fakeClient([]) })
    expect(resolver.lookupChat('999')).toBeNull()
  })

  test('lookupChat returns workspace + isDm after refresh', async () => {
    const resolver = createKakaoChannelResolver({
      client: fakeClient([dmChat('111', 'Alice'), groupChat('222', 'Team')]),
    })
    await resolver.refresh()
    expect(resolver.lookupChat('111')).toEqual({ workspace: '@kakao-dm', isDm: true, provisional: false })
    expect(resolver.lookupChat('222')).toEqual({ workspace: '@kakao-group', isDm: false, provisional: false })
  })

  test('lookupChat returns null for stale entries (TTL expired)', async () => {
    let now = 1000
    const resolver = createKakaoChannelResolver({
      client: fakeClient([dmChat('111', 'Alice')]),
      now: () => now,
      ttlMs: 100,
    })
    await resolver.refresh()
    expect(resolver.lookupChat('111')).toEqual({ workspace: '@kakao-dm', isDm: true, provisional: false })

    // Advance past the TTL. lookupChat must NOT keep returning the stale
    // entry — callers depend on null to trigger a refresh.
    now += 200
    expect(resolver.lookupChat('111')).toBeNull()
  })

  test('resolve refreshes the cache when entries are stale', async () => {
    let now = 1000
    let chats: KakaoChat[] = [dmChat('111', 'Alice')]
    const resolver = createKakaoChannelResolver({
      client: { getChats: async () => chats },
      now: () => now,
      ttlMs: 100,
    })
    await resolver.refresh()

    chats = [dmChat('111', 'Alice updated')]
    now += 200

    const result = await resolver.resolve({ adapter: 'kakaotalk', workspace: '@kakao-dm', chat: '111', thread: null })
    expect(result.chatName).toBe('Alice updated')
  })

  test('refresh coalesces concurrent calls', async () => {
    let calls = 0
    const slowClient: Pick<KakaoTalkClient, 'getChats'> = {
      getChats: async () => {
        calls++
        await new Promise((r) => setTimeout(r, 20))
        return [dmChat('111', 'Alice')]
      },
    }
    const resolver = createKakaoChannelResolver({ client: slowClient })
    await Promise.all([resolver.refresh(), resolver.refresh(), resolver.refresh()])
    expect(calls).toBe(1)
  })

  test('reflects chat-type changes after a fresh refresh', async () => {
    let now = 1000
    let chats: KakaoChat[] = [dmChat('111', 'Alice')]
    const resolver = createKakaoChannelResolver({
      client: { getChats: async () => chats },
      now: () => now,
      ttlMs: 100,
    })
    await resolver.refresh()
    expect(resolver.lookupChat('111')).toEqual({ workspace: '@kakao-dm', isDm: true, provisional: false })

    chats = [groupChat('111', 'Alice, Bob')]
    now += 200
    await resolver.refresh()
    expect(resolver.lookupChat('111')).toEqual({ workspace: '@kakao-group', isDm: false, provisional: false })
  })
})

describe('createKakaoChannelResolver — ingestProvisional', () => {
  test('registers an unknown chat under the strictest bucket (@kakao-group)', () => {
    const resolver = createKakaoChannelResolver({ client: fakeClient([]) })
    expect(resolver.lookupChat('468625891988320')).toBeNull()

    resolver.ingestProvisional('468625891988320')

    expect(resolver.lookupChat('468625891988320')).toEqual({
      workspace: '@kakao-group',
      isDm: false,
      provisional: true,
    })
  })

  test('is a no-op when a real cache entry already exists', async () => {
    const resolver = createKakaoChannelResolver({
      client: fakeClient([dmChat('111', 'Alice')]),
    })
    await resolver.refresh()
    expect(resolver.lookupChat('111')).toEqual({ workspace: '@kakao-dm', isDm: true, provisional: false })

    // ingestProvisional must NOT overwrite the authoritative DM classification
    // with the provisional @kakao-group fallback — otherwise a flap in
    // getChats availability could downgrade a known DM to group bucket and
    // silently change allow-rule semantics.
    resolver.ingestProvisional('111')

    expect(resolver.lookupChat('111')).toEqual({ workspace: '@kakao-dm', isDm: true, provisional: false })
  })

  test('subsequent refresh upgrades a provisional entry to its real kind', async () => {
    let chats: KakaoChat[] = []
    const resolver = createKakaoChannelResolver({
      client: { getChats: async () => chats },
    })

    // Simulates the production failure mode: getChats({all:true}) initially
    // does not return chat 468625891988320, but a push event from it arrives.
    resolver.ingestProvisional('468625891988320')
    expect(resolver.lookupChat('468625891988320')).toEqual({
      workspace: '@kakao-group',
      isDm: false,
      provisional: true,
    })

    // Later, getChats catches up and starts returning it as a DM.
    chats = [dmChat('468625891988320', 'Alice')]
    await resolver.refresh()

    expect(resolver.lookupChat('468625891988320')).toEqual({
      workspace: '@kakao-dm',
      isDm: true,
      provisional: false,
    })
  })

  test('respects TTL so provisional entries do not live forever', async () => {
    let now = 1000
    const resolver = createKakaoChannelResolver({
      client: fakeClient([]),
      now: () => now,
      ttlMs: 100,
    })
    resolver.ingestProvisional('111')
    expect(resolver.lookupChat('111')).toEqual({ workspace: '@kakao-group', isDm: false, provisional: true })

    now += 200
    expect(resolver.lookupChat('111')).toBeNull()
  })
})

describe('kakaoWorkspaceForType', () => {
  test('maps each KakaoChatKind to its workspace label', () => {
    expect(kakaoWorkspaceForType('dm')).toBe('@kakao-dm')
    expect(kakaoWorkspaceForType('group')).toBe('@kakao-group')
    expect(kakaoWorkspaceForType('open')).toBe('@kakao-open')
  })

  test('falls back to @kakao-group for unknown', () => {
    expect(kakaoWorkspaceForType('unknown')).toBe('@kakao-group')
  })
})
