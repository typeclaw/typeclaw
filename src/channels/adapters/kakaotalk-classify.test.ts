import { describe, expect, test } from 'bun:test'

import type { KakaoTalkPushMessageEvent } from 'agent-messenger/kakaotalk'

import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'

import { classifyInbound, type KakaoChatLookup } from './kakaotalk-classify'

const dmConfig = (): ChannelAdapterConfig => ({
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
})

const groupConfig = (): ChannelAdapterConfig => ({
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
})

const event = (overrides: Partial<KakaoTalkPushMessageEvent> = {}): KakaoTalkPushMessageEvent => ({
  type: 'MSG',
  chat_id: '111',
  log_id: 'L1',
  author_id: 222,
  author_name: null,
  message: 'hello',
  message_type: 1,
  attachment: null,
  sent_at: 1_730_000_000,
  ...overrides,
})

const dmLookup: KakaoChatLookup = (id) => (id === '111' ? { workspace: '@kakao-dm', isDm: true } : null)
const groupLookup: KakaoChatLookup = (id) => (id === '111' ? { workspace: '@kakao-group', isDm: false } : null)

describe('classifyInbound', () => {
  test('drops pre_connect when selfUserId is null', () => {
    const verdict = classifyInbound(event(), dmConfig(), { selfUserId: null, lookupChat: dmLookup })
    expect(verdict).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })

  test('drops self_author when authored by self', () => {
    const verdict = classifyInbound(event({ author_id: 999 }), dmConfig(), {
      selfUserId: '999',
      lookupChat: dmLookup,
    })
    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('drops empty_text when message is empty', () => {
    const verdict = classifyInbound(event({ message: '' }), dmConfig(), {
      selfUserId: '999',
      lookupChat: dmLookup,
    })
    expect(verdict).toEqual({ kind: 'drop', reason: 'empty_text' })
  })

  test('drops unknown_chat when lookup returns null', () => {
    const verdict = classifyInbound(event(), dmConfig(), {
      selfUserId: '999',
      lookupChat: () => null,
    })
    expect(verdict).toEqual({ kind: 'drop', reason: 'unknown_chat' })
  })

  test('drops bot_message when LOCO message_type=71 (kakao notification feed)', () => {
    const verdict = classifyInbound(
      event({ message_type: 71, author_id: 406180744, author_name: '카카오 고객센터', message: '시스템 알림' }),
      groupConfig(),
      { selfUserId: '999', lookupChat: groupLookup },
    )
    expect(verdict).toEqual({ kind: 'drop', reason: 'bot_message' })
  })

  test('bot_message drop wins over unknown_chat (independent of resolver state)', () => {
    const verdict = classifyInbound(event({ message_type: 71 }), groupConfig(), {
      selfUserId: '999',
      lookupChat: () => null,
    })
    expect(verdict).toEqual({ kind: 'drop', reason: 'bot_message' })
  })

  test('self_author still wins over bot_message (defense in depth)', () => {
    const verdict = classifyInbound(event({ message_type: 71, author_id: 999 }), groupConfig(), {
      selfUserId: '999',
      lookupChat: groupLookup,
    })
    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('normal text (message_type=1) is not dropped as bot_message', () => {
    const verdict = classifyInbound(event({ message_type: 1 }), dmConfig(), {
      selfUserId: '999',
      lookupChat: dmLookup,
    })
    expect(verdict.kind).toBe('route')
  })

  test('routes a 1:1 message and stamps the dm workspace + isDm', () => {
    const verdict = classifyInbound(event(), dmConfig(), {
      selfUserId: '999',
      lookupChat: dmLookup,
    })
    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.adapter).toBe('kakaotalk')
    expect(verdict.payload.workspace).toBe('@kakao-dm')
    expect(verdict.payload.chat).toBe('111')
    expect(verdict.payload.isDm).toBe(true)
    expect(verdict.payload.thread).toBeNull()
    expect(verdict.payload.text).toBe('hello')
    expect(verdict.payload.externalMessageId).toBe('L1')
    expect(verdict.payload.authorId).toBe('222')
    expect(verdict.payload.ts).toBe(1_730_000_000_000)
    expect(new Date(verdict.payload.ts).getUTCFullYear()).toBe(2024)
    expect(verdict.payload.authorIsBot).toBe(false)
    expect(verdict.payload.replyToBotMessageId).toBeNull()
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
    expect(verdict.payload.mentionsOthers).toBe(false)
  })

  test('routes a group message and marks isDm=false', () => {
    const verdict = classifyInbound(event(), groupConfig(), {
      selfUserId: '999',
      lookupChat: groupLookup,
    })
    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.workspace).toBe('@kakao-group')
    expect(verdict.payload.isDm).toBe(false)
  })

  test('alias match in text sets isBotMention=true', () => {
    const verdict = classifyInbound(event({ message: 'hey claudie, are you there?' }), dmConfig(), {
      selfUserId: '999',
      lookupChat: dmLookup,
      selfAliases: ['claudie'],
    })
    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.isBotMention).toBe(true)
  })

  test('a native @-tag of the bot sets isBotMention without any alias configured', () => {
    const verdict = classifyInbound(
      event({ message: '@타입이 오늘 일정 알려줘', mentions: [{ user_id: '999', at: [1], len: 3 }] }),
      groupConfig(),
      { selfUserId: '999', lookupChat: groupLookup },
    )
    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.mentionsOthers).toBe(false)
  })

  test('a native @-tag of someone else marks mentionsOthers and not isBotMention', () => {
    const verdict = classifyInbound(
      event({ message: '@Alice can you check?', mentions: [{ user_id: '333', at: [1], len: 5 }] }),
      groupConfig(),
      { selfUserId: '999', lookupChat: groupLookup },
    )
    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.isBotMention).toBe(false)
    expect(verdict.payload.mentionsOthers).toBe(true)
  })

  test('tagging the bot together with someone else is a bot mention, not mentionsOthers', () => {
    const verdict = classifyInbound(
      event({
        message: '@Alice @타입이 둘 다 봐줘',
        mentions: [
          { user_id: '333', at: [1], len: 5 },
          { user_id: '999', at: [2], len: 3 },
        ],
      }),
      groupConfig(),
      { selfUserId: '999', lookupChat: groupLookup },
    )
    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.mentionsOthers).toBe(false)
  })

  test('threads structured attachments from context into the routed payload', () => {
    const attachments = [{ id: 1, kind: 'photo' as const, ref: 'https://example.com/p.jpg', mimetype: 'image/jpeg' }]
    const verdict = classifyInbound(event({ message: '[KakaoTalk attachment #1: photo image/jpeg]' }), dmConfig(), {
      selfUserId: '999',
      lookupChat: dmLookup,
      attachments,
    })

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.attachments).toBe(attachments)
  })

  test('keeps raw text and sets referenceContext for replies to the bot', () => {
    const verdict = classifyInbound(
      event({
        message: 'yes, please',
        message_type: 26,
        attachment: {
          attach_only: false,
          src_logId: 'BOT-L1',
          src_userId: 999,
          src_message: 'Do you want me to summarize this?',
          src_type: 1,
        },
      }),
      dmConfig(),
      { selfUserId: '999', lookupChat: dmLookup },
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.text).toBe('yes, please')
    expect(verdict.payload.referenceContext).toEqual({
      kind: 'reply',
      sources: [
        { adapter: 'kakaotalk', authorId: '999', authorName: '999', text: 'Do you want me to summarize this?' },
      ],
    })
    expect(verdict.payload.replyToBotMessageId).toBe('BOT-L1')
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
  })

  test('engages reply-to-bot when LOCO sends src_userId as a string (production shape)', () => {
    const verdict = classifyInbound(
      event({
        message: 'yes, please',
        message_type: 26,
        attachment: {
          attach_only: false,
          src_logId: 'BOT-L1',
          src_userId: '999',
          src_message: 'Do you want me to summarize this?',
          src_type: 1,
        },
      }),
      dmConfig(),
      { selfUserId: '999', lookupChat: dmLookup },
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.replyToBotMessageId).toBe('BOT-L1')
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
  })

  test('compares large string ids without precision loss', () => {
    const bigId = '9007199254740993123'
    const verdict = classifyInbound(
      event({
        message: 'thanks',
        message_type: 26,
        attachment: {
          attach_only: false,
          src_logId: 'BOT-L9',
          src_userId: bigId,
          src_message: 'sure',
          src_type: 1,
        },
      }),
      dmConfig(),
      { selfUserId: bigId, lookupChat: dmLookup },
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.replyToBotMessageId).toBe('BOT-L9')
  })

  test('ignores a non-numeric src_userId rather than crediting the bot', () => {
    const verdict = classifyInbound(
      event({
        message: 'hm',
        message_type: 26,
        attachment: {
          attach_only: false,
          src_logId: 'L-X',
          src_userId: 'not-a-number',
          src_message: 'context',
          src_type: 1,
        },
      }),
      dmConfig(),
      { selfUserId: '999', lookupChat: dmLookup },
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.replyToBotMessageId).toBeNull()
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
  })

  test('keeps raw text and sets referenceContext for replies to another user', () => {
    const verdict = classifyInbound(
      event({
        message: 'I agree with this',
        message_type: 26,
        attachment: {
          attach_only: false,
          src_logId: 'USER-L1',
          src_userId: 333,
          src_message: 'We should ship the smaller fix first.',
          src_type: 1,
        },
      }),
      groupConfig(),
      { selfUserId: '999', lookupChat: groupLookup },
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.text).toBe('I agree with this')
    expect(verdict.payload.referenceContext).toEqual({
      kind: 'reply',
      sources: [
        { adapter: 'kakaotalk', authorId: '333', authorName: '333', text: 'We should ship the smaller fix first.' },
      ],
    })
    expect(verdict.payload.replyToBotMessageId).toBeNull()
    expect(verdict.payload.replyToOtherMessageId).toBe('USER-L1')
  })

  test('sets reply ids but skips the quote block when quoted text is empty', () => {
    const verdict = classifyInbound(
      event({
        message: 'what was attached?',
        message_type: 26,
        attachment: {
          attach_only: true,
          src_logId: 'BOT-L2',
          src_userId: 999,
          src_message: '',
          src_type: 2,
        },
      }),
      dmConfig(),
      { selfUserId: '999', lookupChat: dmLookup },
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.text).toBe('what was attached?')
    expect(verdict.payload.referenceContext).toBeUndefined()
    expect(verdict.payload.replyToBotMessageId).toBe('BOT-L2')
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
  })

  test('keeps full quoted text in referenceContext without adapter-side truncation', () => {
    const longQuote = `${'a'.repeat(280)}${'b'.repeat(20)}`
    const verdict = classifyInbound(
      event({
        message: 'short answer',
        message_type: 26,
        attachment: {
          attach_only: false,
          src_logId: 'USER-L2',
          src_userId: 333,
          src_message: longQuote,
          src_type: 1,
        },
      }),
      groupConfig(),
      { selfUserId: '999', lookupChat: groupLookup },
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.text).toBe('short answer')
    expect(verdict.payload.referenceContext?.sources[0]?.text).toBe(longQuote)
  })

  test('does not treat aliases inside the quoted text as a fresh mention', () => {
    const verdict = classifyInbound(
      event({
        message: 'following up',
        message_type: 26,
        attachment: {
          attach_only: false,
          src_logId: 'USER-L3',
          src_userId: 333,
          src_message: 'claudie should look at this',
          src_type: 1,
        },
      }),
      groupConfig(),
      { selfUserId: '999', lookupChat: groupLookup, selfAliases: ['claudie'] },
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.isBotMention).toBe(false)
  })

  test('absent alias keeps isBotMention=false on plain message', () => {
    const verdict = classifyInbound(event({ message: 'random thought' }), dmConfig(), {
      selfUserId: '999',
      lookupChat: dmLookup,
      selfAliases: ['claudie'],
    })
    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.isBotMention).toBe(false)
  })
})
