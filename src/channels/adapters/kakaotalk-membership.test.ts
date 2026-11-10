import { describe, expect, test } from 'bun:test'

import type { KakaoMember, KakaoMemberSnapshot, KakaoPartialMemberSnapshot } from 'agent-messenger/kakaotalk'

import { resolveEffectiveHumans } from '@/channels/engagement'
import type { ChannelKey } from '@/channels/types'

import { createKakaoMembershipResolver } from './kakaotalk-membership'

const member = (user_id: string): KakaoMember => ({
  user_id,
  nickname: `name-${user_id}`,
  profile_image_url: null,
  full_profile_image_url: null,
  original_profile_image_url: null,
  status_message: null,
  country_iso: null,
  user_type: 100,
  open_token: null,
  open_profile_link_id: null,
  open_permission: null,
})

const snapshot = (members: KakaoMember[]): KakaoMemberSnapshot => ({
  chat_id: 'chat',
  active_members: members.length,
  members,
  complete: true,
  consistency_basis: 'stable_double_read_chatinfo_getmem',
})

const groupKey: ChannelKey = { adapter: 'kakaotalk', workspace: '@kakao-group', chat: 'chat-1', thread: null }

const logger = () => ({ warn: () => {} })

describe('createKakaoMembershipResolver', () => {
  test('counts every roster member except the agent as a human', async () => {
    // given: a group of the agent (self) plus three humans
    const resolver = createKakaoMembershipResolver({
      client: { getMemberSnapshot: async () => snapshot([member('self'), member('m1'), member('m2'), member('m3')]) },
      selfUserIdRef: () => 'self',
      logger: logger(),
      now: () => 123,
    })

    // when
    const result = await resolver(groupKey)

    // then: self is excluded; the group reports >1 human so engagement stays strict
    expect(result).toEqual({
      humans: 3,
      bots: 1,
      fetchedAt: 123,
      truncated: false,
      humanMemberIds: ['m1', 'm2', 'm3'],
    })
  })

  test('a real group never collapses to the solo-human fallback (regression)', async () => {
    // given: the incident shape — a multi-member group where only one human
    // has posted; the roster must still report >1 human
    const resolver = createKakaoMembershipResolver({
      client: { getMemberSnapshot: async () => snapshot([member('self'), member('mom'), member('son')]) },
      selfUserIdRef: () => 'self',
      logger: logger(),
      now: () => 0,
    })

    const result = await resolver(groupKey)

    expect(result).not.toHaveProperty('kind')
    if ('humans' in result) expect(result.humans).toBeGreaterThan(1)
  })

  test('dedupes a member listed twice in the roster', async () => {
    const resolver = createKakaoMembershipResolver({
      client: { getMemberSnapshot: async () => snapshot([member('self'), member('m1'), member('m1'), member('m2')]) },
      selfUserIdRef: () => 'self',
      logger: logger(),
      now: () => 5,
    })

    const result = await resolver(groupKey)

    expect(result).toEqual({
      humans: 2,
      bots: 1,
      fetchedAt: 5,
      truncated: false,
      humanMemberIds: ['m1', 'm2'],
    })
  })

  test('reports a 1:1 chat as exactly one human (self excluded)', async () => {
    const resolver = createKakaoMembershipResolver({
      client: { getMemberSnapshot: async () => snapshot([member('self'), member('peer')]) },
      selfUserIdRef: () => 'self',
      logger: logger(),
      now: () => 1,
    })

    expect(await resolver(groupKey)).toEqual({
      humans: 1,
      bots: 1,
      fetchedAt: 1,
      truncated: false,
      humanMemberIds: ['peer'],
    })
  })

  test('reports a partial roster from a capped open chat as truncated, without member ids', async () => {
    // given: GETMEM returned fewer records than the room's active member count
    const requested: Array<{ allowPartial: true }> = []
    const partial: KakaoPartialMemberSnapshot = {
      chat_id: 'chat-1',
      active_members: 1414,
      members: [member('self'), member('m1'), member('m2')],
      complete: false,
      consistency_basis: 'stable_double_read_chatinfo_getmem',
      incomplete_reason: 'member_count_mismatch',
    }
    const resolver = createKakaoMembershipResolver({
      client: {
        getMemberSnapshot: async (_chatId, options) => {
          requested.push(options)
          return partial
        },
      },
      selfUserIdRef: () => 'self',
      logger: logger(),
      now: () => 7,
    })

    // when
    const result = await resolver(groupKey)

    // then: the strict read would have thrown; the partial roster still counts,
    // but is flagged truncated and carries no completeness proof
    expect(requested).toEqual([{ allowPartial: true }])
    expect(result).toEqual({ humans: 1413, bots: 1, fetchedAt: 7, truncated: true })
  })

  test('a large room whose partial roster returns one human never reads as solo-human to engagement', async () => {
    // given: GETMEM returned only the agent and one human out of 1,414 members
    const resolver = createKakaoMembershipResolver({
      client: {
        getMemberSnapshot: async () => ({
          chat_id: 'chat-1',
          active_members: 1414,
          members: [member('self'), member('m1')],
          complete: false,
          consistency_basis: 'stable_double_read_chatinfo_getmem',
          incomplete_reason: 'member_count_mismatch',
        }),
      },
      selfUserIdRef: () => 'self',
      logger: logger(),
      now: () => 1_000,
    })

    // when: a cold session (one persisted speaker) combines it with the roster
    const result = await resolver(groupKey)
    if (!('humans' in result)) throw new Error('expected a membership count')
    const effective = resolveEffectiveHumans(1, result, 1_000)

    // then
    expect(effective).toBeGreaterThan(1)
  })

  test('fails transient before login resolves a self id', async () => {
    let called = false
    const resolver = createKakaoMembershipResolver({
      client: {
        getMemberSnapshot: async () => {
          called = true
          return snapshot([])
        },
      },
      selfUserIdRef: () => null,
      logger: logger(),
    })

    expect(await resolver(groupKey)).toEqual({ kind: 'transient' })
    expect(called).toBe(false)
  })

  test('fails transient when the roster fetch throws', async () => {
    const resolver = createKakaoMembershipResolver({
      client: {
        getMemberSnapshot: async () => {
          throw new Error('GETMEM failed')
        },
      },
      selfUserIdRef: () => 'self',
      logger: logger(),
    })

    expect(await resolver(groupKey)).toEqual({ kind: 'transient' })
  })

  test('rejects a non-kakaotalk key as a permanent failure', async () => {
    const resolver = createKakaoMembershipResolver({
      client: { getMemberSnapshot: async () => snapshot([]) },
      selfUserIdRef: () => 'self',
      logger: logger(),
    })

    expect(await resolver({ adapter: 'discord-bot', workspace: 'w', chat: 'c', thread: null })).toEqual({
      kind: 'permanent',
    })
  })
})
