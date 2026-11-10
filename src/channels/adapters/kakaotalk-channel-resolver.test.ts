import { describe, expect, test } from 'bun:test'

import type { KakaoChat, KakaoMember, KakaoMemberSnapshot } from 'agent-messenger/kakaotalk'

import type { KakaoTalkClient } from './kakaotalk'
import { createKakaoChannelResolver, kakaoWorkspaceForType, provenKindFromMembers } from './kakaotalk-channel-resolver'

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

const member = (id: string, overrides: Partial<KakaoMember> = {}): KakaoMember => ({
  user_id: id,
  nickname: `member-${id}`,
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

type FakeClient = Pick<KakaoTalkClient, 'getChats' | 'getMemberSnapshot'>

const fakeClient = (chats: KakaoChat[], members: KakaoMember[] = []): FakeClient => ({
  getChats: async () => chats,
  getMemberSnapshot: async () => snapshot(members),
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
      client: { getChats: async () => chats, getMemberSnapshot: async () => snapshot([]) },
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
    const slowClient: FakeClient = {
      getChats: async () => {
        calls++
        await new Promise((r) => setTimeout(r, 20))
        return [dmChat('111', 'Alice')]
      },
      getMemberSnapshot: async () => snapshot([]),
    }
    const resolver = createKakaoChannelResolver({ client: slowClient })
    await Promise.all([resolver.refresh(), resolver.refresh(), resolver.refresh()])
    expect(calls).toBe(1)
  })

  test('reflects chat-type changes after a fresh refresh', async () => {
    let now = 1000
    let chats: KakaoChat[] = [dmChat('111', 'Alice')]
    const resolver = createKakaoChannelResolver({
      client: { getChats: async () => chats, getMemberSnapshot: async () => snapshot([]) },
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
  test('registers an unknown chat under the strictest bucket (@kakao-group)', async () => {
    const resolver = createKakaoChannelResolver({ client: fakeClient([]) })
    expect(resolver.lookupChat('468625891988320')).toBeNull()

    await resolver.ingestProvisional('468625891988320')

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
    await resolver.ingestProvisional('111')

    expect(resolver.lookupChat('111')).toEqual({ workspace: '@kakao-dm', isDm: true, provisional: false })
  })

  test('subsequent refresh upgrades a provisional entry to its real kind', async () => {
    let chats: KakaoChat[] = []
    const resolver = createKakaoChannelResolver({
      client: { getChats: async () => chats, getMemberSnapshot: async () => snapshot([]) },
    })

    // Simulates the production failure mode: getChats({all:true}) initially
    // does not return chat 468625891988320, but a push event from it arrives.
    await resolver.ingestProvisional('468625891988320')
    expect(resolver.lookupChat('468625891988320')).toEqual({
      workspace: '@kakao-group',
      isDm: false,
      provisional: true,
    })

    // Later, getChats catches up and starts returning it as a DM.
    chats = [dmChat('468625891988320', 'Alice')]
    await resolver.refresh()

    expect(resolver.lookupChat('468625891988320')).toEqual({ workspace: '@kakao-dm', isDm: true, provisional: false })
  })

  test('respects TTL so provisional entries do not live forever', async () => {
    let now = 1000
    const resolver = createKakaoChannelResolver({
      client: fakeClient([]),
      now: () => now,
      ttlMs: 100,
    })
    await resolver.ingestProvisional('111')
    expect(resolver.lookupChat('111')).toEqual({ workspace: '@kakao-group', isDm: false, provisional: true })

    now += 200
    expect(resolver.lookupChat('111')).toBeNull()
  })
})

describe('provenKindFromMembers', () => {
  const SELF = '100'

  test('two or more counterparts proves a group', () => {
    expect(provenKindFromMembers([member(SELF), member('200'), member('300')], SELF)).toBe('group')
  })

  test('a member list that omits self still proves a group from two counterparts', () => {
    expect(provenKindFromMembers([member('200'), member('300')], SELF)).toBe('group')
  })

  test('an open-chat marker proves an open chat regardless of member count', () => {
    expect(provenKindFromMembers([member(SELF), member('200', { open_token: 12345 })], SELF)).toBe('open')
  })

  test.each([
    ['open_profile_link_id', { open_profile_link_id: 'abc' }],
    ['open_permission', { open_permission: 1 }],
  ])('%s alone also proves an open chat', (_label, overrides) => {
    expect(provenKindFromMembers([member(SELF), member('200', overrides)], SELF)).toBe('open')
  })

  // A roster read can be truncated, so "one counterpart" may just mean the rest
  // went unobserved. Inferring a DM here would cache a large room as an
  // authoritative DM and relax `kakao:dm/*` matching.
  test('a lone counterpart proves nothing — a truncated roster could hide the rest', () => {
    expect(provenKindFromMembers([member(SELF), member('200')], SELF)).toBeNull()
  })

  test('a roster containing only self proves nothing', () => {
    expect(provenKindFromMembers([member(SELF)], SELF)).toBeNull()
  })

  test('an empty member list proves nothing', () => {
    expect(provenKindFromMembers([], SELF)).toBeNull()
  })

  test('an open marker still wins on a roster too small to prove a group', () => {
    expect(provenKindFromMembers([member('200', { open_permission: 4 })], SELF)).toBe('open')
  })
})

describe('createKakaoChannelResolver — provisional classification via members', () => {
  const SELF = '100'
  const withMembers = (members: KakaoMember[]): ReturnType<typeof createKakaoChannelResolver> =>
    createKakaoChannelResolver({ client: fakeClient([], members), selfUserId: () => SELF })

  // A truncated roster must never be cached as an authoritative DM — that
  // would relax both the engagement ladder and `kakao:dm/*` allow-rules for a
  // room that may actually be large.
  test('a roster showing a lone counterpart stays a provisional @kakao-group', async () => {
    const resolver = withMembers([member(SELF), member('200')])

    const bucket = await resolver.ingestProvisional('468625891988320')

    expect(bucket).toBe('@kakao-group')
    expect(resolver.lookupChat('468625891988320')).toEqual({
      workspace: '@kakao-group',
      isDm: false,
      provisional: true,
    })
  })

  test('a multi-member chat getChats omits resolves to an authoritative @kakao-group', async () => {
    const resolver = withMembers([member(SELF), member('200'), member('300')])

    expect(await resolver.ingestProvisional('777')).toBe('@kakao-group')
    expect(resolver.lookupChat('777')).toEqual({ workspace: '@kakao-group', isDm: false, provisional: false })
  })

  test('an open chat getChats omits resolves to @kakao-open, not the group guess', async () => {
    const resolver = withMembers([member(SELF), member('200', { open_token: 99 })])

    expect(await resolver.ingestProvisional('888')).toBe('@kakao-open')
    expect(resolver.lookupChat('888')).toEqual({ workspace: '@kakao-open', isDm: false, provisional: false })
  })

  test('falls back to the strict bucket when the member read fails', async () => {
    const warnings: string[] = []
    const resolver = createKakaoChannelResolver({
      client: {
        getChats: async () => [],
        getMemberSnapshot: async () => {
          throw new Error('GETMEM timeout')
        },
      },
      selfUserId: () => SELF,
      logger: { warn: (msg) => warnings.push(msg) },
    })

    expect(await resolver.ingestProvisional('999')).toBe('@kakao-group')
    expect(resolver.lookupChat('999')).toEqual({ workspace: '@kakao-group', isDm: false, provisional: true })
    expect(warnings.some((w) => w.includes('provisional member lookup failed chat=999'))).toBe(true)
  })

  test('falls back to the strict bucket when the member read returns nothing', async () => {
    const resolver = withMembers([])

    expect(await resolver.ingestProvisional('555')).toBe('@kakao-group')
    expect(resolver.lookupChat('555')).toEqual({ workspace: '@kakao-group', isDm: false, provisional: true })
  })

  test('does not clobber an authoritative entry a concurrent refresh installed mid-lookup', async () => {
    let releaseMembers: () => void = () => {}
    const membersPending = new Promise<void>((resolve) => {
      releaseMembers = resolve
    })
    const resolver = createKakaoChannelResolver({
      client: {
        getChats: async () => [dmChat('468625891988320', 'Counterpart')],
        getMemberSnapshot: async () => {
          await membersPending
          return snapshot([member(SELF), member('200'), member('300')])
        },
      },
      selfUserId: () => SELF,
    })

    const ingesting = resolver.ingestProvisional('468625891988320')
    await resolver.refresh()
    releaseMembers()

    expect(await ingesting).toBe('@kakao-dm')
    expect(resolver.lookupChat('468625891988320')).toEqual({
      workspace: '@kakao-dm',
      isDm: true,
      provisional: false,
    })
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
