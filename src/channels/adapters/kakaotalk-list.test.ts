import { describe, expect, test } from 'bun:test'

import type { KakaoChat } from 'agent-messenger/kakaotalk'

import { createKakaoListCallback } from './kakaotalk-list'

const chat = (id: string, type: KakaoChat['type'], fields: Partial<KakaoChat> = {}): KakaoChat => ({
  chat_id: id,
  type,
  display_name: null,
  title: null,
  active_members: 2,
  unread_count: 0,
  last_message: null,
  ...fields,
})

const silent = { warn: () => {} }

const chats: KakaoChat[] = [
  chat('1', 11, { display_name: '연규' }),
  chat('2', 10, { title: 'Team room', display_name: 'Alice, Bob', active_members: 5 }),
  chat('3', 'OM', { title: 'Open room', active_members: 40 }),
  chat('4', 11, { display_name: 'Alice' }),
]

// Mirrors the SDK: room titles come back only when title resolution is requested.
const listWith = (source: KakaoChat[]) =>
  createKakaoListCallback({
    client: {
      getChats: async (options) =>
        options?.resolveTitles === true ? source : source.map((c) => ({ ...c, title: null })),
    },
    logger: silent,
  })

describe('createKakaoListCallback', () => {
  test('lists only the chats in the requested workspace bucket', async () => {
    const list = listWith(chats)

    expect(await list({ workspace: '@kakao-dm', limit: 20 })).toEqual({
      ok: true,
      entries: [
        { chat: '1', name: '연규', kind: 'dm', isMember: true },
        { chat: '4', name: 'Alice', kind: 'dm', isMember: true },
      ],
    })
    expect(await list({ workspace: '@kakao-group', limit: 20 })).toEqual({
      ok: true,
      entries: [{ chat: '2', name: 'Team room', kind: 'group', isMember: true }],
    })
    expect(await list({ workspace: '@kakao-open', limit: 20 })).toEqual({
      ok: true,
      entries: [{ chat: '3', name: 'Open room', kind: 'group', isMember: true }],
    })
  })

  test('pages through a bucket with an offset cursor', async () => {
    const list = listWith(chats)

    const first = await list({ workspace: '@kakao-dm', limit: 1 })
    expect(first).toEqual({
      ok: true,
      entries: [{ chat: '1', name: '연규', kind: 'dm', isMember: true }],
      nextCursor: '1',
    })

    const second = await list({ workspace: '@kakao-dm', limit: 1, cursor: '1' })
    expect(second).toEqual({ ok: true, entries: [{ chat: '4', name: 'Alice', kind: 'dm', isMember: true }] })
  })

  test('rejects a workspace that is not a KakaoTalk bucket and names the valid ones', async () => {
    const result = await listWith(chats)({ workspace: '@dm', limit: 20 })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('@kakao-dm')
  })

  test('reports a getChats failure instead of throwing', async () => {
    const list = createKakaoListCallback({
      client: {
        getChats: async () => {
          throw new Error('LOCO session closed')
        },
      },
      logger: silent,
    })

    expect(await list({ workspace: '@kakao-dm', limit: 20 })).toEqual({ ok: false, error: 'LOCO session closed' })
  })
})
