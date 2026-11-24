import { describe, expect, test } from 'bun:test'

import type { ChannelParticipant } from '@/agent/session-origin'

import {
  decideEngagement as decideEngagementRaw,
  grantStickyForReplyTargets,
  resolveEffectiveHumans,
  StickyLedger,
  type EngagementInput,
} from './engagement'
import type { EngagementConfig } from './schema'
import type { InboundMessage } from './types'

const KEY = 'discord-bot:g1:c1:'

const baseConfig: EngagementConfig = {
  trigger: ['mention', 'reply', 'dm'],
  stickiness: { perReply: { window: 5 * 60 * 1000 } },
}

function participant(authorId: string, lastMessageAt = 0): ChannelParticipant {
  return {
    authorId,
    authorName: authorId,
    firstMessageAt: lastMessageAt,
    lastMessageAt,
    messageCount: 1,
  }
}

const crowded: readonly ChannelParticipant[] = [participant('alice'), participant('bob')]

function decideEngagement(
  input: Omit<EngagementInput, 'membership' | 'selfAliases' | 'botInThread'> &
    Partial<Pick<EngagementInput, 'membership' | 'selfAliases' | 'botInThread'>>,
): ReturnType<typeof decideEngagementRaw> {
  return decideEngagementRaw({ membership: null, selfAliases: [], botInThread: false, ...input })
}

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    adapter: 'discord-bot',
    workspace: 'g1',
    chat: 'c1',
    thread: null,
    text: 'hi',
    externalMessageId: 'm1',
    authorId: 'alice',
    authorName: 'alice',
    authorIsBot: false,
    isBotMention: false,
    replyToBotMessageId: null,
    mentionsOthers: false,
    replyToOtherMessageId: null,
    isDm: false,
    ts: 0,
    ...over,
  }
}

describe('decideEngagement (explicit triggers)', () => {
  test('mention engages when trigger includes mention', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ isBotMention: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('mention does not engage if trigger excludes mention', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ isBotMention: true }),
      config: { trigger: ['reply', 'dm'], stickiness: 'off' },
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('observe')
  })

  test('reply to bot engages when trigger includes reply', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ replyToBotMessageId: 'msg42' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('DM engages when trigger includes dm', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ isDm: true, workspace: '@dm' }),
      config: baseConfig,
      key: 'discord-bot:@dm:d1:',
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('plain message in crowded channel observes', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('observe')
  })
})

describe('decideEngagement (explicit-only inbounds)', () => {
  test('engages an explicit-only inbound when it mentions the bot', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ suppressSticky: true, isBotMention: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('engages an explicit-only inbound when it replies to the bot', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ suppressSticky: true, replyToBotMessageId: 'parent-1' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('observes an explicit-only inbound with sticky credit and preserves the credit', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    const decision = decideEngagement({
      message: inbound({ suppressSticky: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: crowded,
    })
    expect(decision).toBe('observe')
    expect(ledger.has(KEY, 'alice', 1000)).toBe(true)
  })

  test('observes an explicit-only inbound whose text matches an alias', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ suppressSticky: true, text: 'Toto please look' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: ['toto'],
    })
    expect(decision).toBe('observe')
  })

  test('observes an explicit-only inbound authored by a peer bot', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ suppressSticky: true, authorId: 'peer-bot', authorName: 'peer-bot', authorIsBot: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('observe')
  })

  test('non-explicit sticky credit still engages a normal inbound', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: crowded,
    })
    expect(decision).toBe('engage')
    expect(ledger.has(KEY, 'alice', 1000)).toBe(true)
  })
})

describe('decideEngagement (alias)', () => {
  test('engages when text contains a self-alias (case-insensitive)', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ text: '토토아 check the cron' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: ['토토'],
    })
    expect(decision).toBe('engage')
  })

  test('engages on Latin alias regardless of case', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ text: 'Hey TOTO, deploy please' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: ['toto'],
    })
    expect(decision).toBe('engage')
  })

  test('observes when text does not contain any self-alias', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ text: 'general chatter, not addressed' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: ['토토', 'toto'],
    })
    expect(decision).toBe('observe')
  })

  test('empty alias list is a no-op (preserves prior behavior)', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ text: '토토아 check the cron' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: [],
    })
    expect(decision).toBe('observe')
  })

  test('alias engagement is NOT suppressed by mentionsOthers', () => {
    // The user can address two bots in one message; both should engage on
    // their own alias matches. Suppressing on mentionsOthers would break
    // multi-target addressing.
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ text: '토토아 라라아 both take a look', mentionsOthers: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: ['토토'],
    })
    expect(decision).toBe('engage')
  })

  test('matches any alias in the list (multi-name agents)', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ text: 'Hey Toto, what time?' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: ['토토', 'toto', 'bb'],
    })
    expect(decision).toBe('engage')
  })

  test('observes when alias appears only in referenceContext source text', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({
        text: 'following up on this',
        referenceContext: {
          kind: 'reply',
          sources: [{ adapter: 'discord-bot', authorId: 'bob', authorName: 'Bob', text: '토토아 please check' }],
        },
      }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: ['토토'],
    })
    expect(decision).toBe('observe')
  })

  test('engages when alias appears in raw message text even with referenceContext present', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({
        text: '토토아 following up',
        referenceContext: {
          kind: 'reply',
          sources: [{ adapter: 'discord-bot', authorId: 'bob', authorName: 'Bob', text: 'unrelated parent' }],
        },
      }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: ['토토'],
    })
    expect(decision).toBe('engage')
  })

  test('alias engagement runs after explicit triggers (mention still wins for sticky-credit grant)', () => {
    // Sanity: alias path doesn't break existing trigger ordering. A
    // message with both <@id> mention AND alias text engages, same as
    // mention-only would.
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ isBotMention: true, text: '<@123> 토토아 cron' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      selfAliases: ['토토'],
    })
    expect(decision).toBe('engage')
  })

  test('sticky check wins over the alias path and refreshes the credit', () => {
    // Sticky runs before the alias rule: when both match, sticky engages first
    // and slides its window forward (the alias path never runs), so the credit
    // stays live rather than being double-spent.
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    decideEngagement({
      message: inbound({ text: '토토아 cron' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: crowded,
      selfAliases: ['토토'],
    })
    expect(ledger.has(KEY, 'alice', 1000)).toBe(true)
  })
})

describe('decideEngagement (sticky)', () => {
  // These cases isolate the sticky mechanic itself, so they run in a
  // one-human channel where sticky force-engages. Multi-human group
  // suppression is covered in the `(group-aware sticky)` block below.
  const solo: readonly ChannelParticipant[] = [participant('alice')]

  test('sticky credit consumed engages a follow-up message', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 1000)
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 500,
      participants: solo,
    })
    expect(decision).toBe('engage')
  })

  test('spending a live sticky credit slides its window forward', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 1000)
    decideEngagement({ message: inbound(), config: baseConfig, key: KEY, ledger, now: 100, participants: solo })
    // window = 5min, spent at now=100 → fresh expiry 100 + 5min, still live past
    // the original 1000 expiry.
    expect(ledger.has(KEY, 'alice', 1000)).toBe(true)
    expect(ledger.has(KEY, 'alice', 100 + 5 * 60 * 1000 + 1)).toBe(false)
  })

  test('expired sticky credit does not engage and is consumed', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 1000)
    const decision = decideEngagement({
      message: inbound({ mentionsOthers: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 5000,
      participants: solo,
    })
    expect(decision).toBe('observe')
    expect(ledger.has(KEY, 'alice', 5000)).toBe(false)
  })

  test('multi-human in-flight follow-up keeps engaging on a refreshed sticky credit', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 1000)
    const first = decideEngagement({
      message: inbound({ text: 'omo 만든 분이야' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 100,
      participants: crowded,
    })
    // A same-author follow-up landing before the reply re-grants the credit
    // (the engage→send gap) must still engage in a 2-human group, not observe.
    const followUp = decideEngagement({
      message: inbound({ text: 'ㅋㅋㅋㅋ' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 200,
      participants: crowded,
    })
    expect(first).toBe('engage')
    expect(followUp).toBe('engage')
  })

  test('sticky off makes follow-ups observe even with prior credits', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 1000)
    const decision = decideEngagement({
      message: inbound(),
      config: { trigger: ['mention'], stickiness: 'off' },
      key: KEY,
      ledger,
      now: 100,
      participants: crowded,
    })
    expect(decision).toBe('observe')
  })

  test('sticky is per-author (alice has credit, bob does not)', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 1000)
    expect(
      decideEngagement({
        message: inbound({ authorId: 'bob' }),
        config: baseConfig,
        key: KEY,
        ledger,
        now: 100,
        participants: crowded,
      }),
    ).toBe('observe')
  })
})

describe('decideEngagement (solo-human fallback)', () => {
  test('engages on plain message when channel has only the current sender', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice')],
    })
    expect(decision).toBe('engage')
  })

  test('engages even when triggers exclude mention/reply/dm (trigger-less setup)', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: { trigger: [], stickiness: 'off' },
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice')],
    })
    expect(decision).toBe('engage')
  })

  test('engages on first-ever message before participants is updated', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [],
    })
    expect(decision).toBe('engage')
  })

  test('does NOT engage on plain message once a second human posts', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice'), participant('bob')],
    })
    expect(decision).toBe('observe')
  })

  test('keeps solo-human fallback even when peer bots are also participants', () => {
    // given
    const ledger = new StickyLedger()
    const peerBots: ChannelParticipant[] = [
      { ...participant('peer1'), isBot: true },
      { ...participant('peer2'), isBot: true },
      { ...participant('peer3'), isBot: true },
    ]

    // when
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice'), ...peerBots],
    })

    // then
    expect(decision).toBe('engage')
  })

  test('peer bot does NOT ride the solo-human fallback (prevents bot-to-bot loops)', () => {
    // given a 1-human + N-bot channel where another peer bot just spoke
    const ledger = new StickyLedger()
    const participants: ChannelParticipant[] = [
      participant('alice'),
      { ...participant('peer1'), isBot: true },
      { ...participant('peer2'), isBot: true },
    ]

    // when peer1 posts something that does NOT mention/reply to us
    const decision = decideEngagement({
      message: inbound({ authorId: 'peer1', authorName: 'peer1', authorIsBot: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants,
    })

    // then we observe — the fallback is for humans, not bots
    expect(decision).toBe('observe')
  })

  test('peer bot name inside referenceContext does not suppress solo-human fallback', () => {
    const ledger = new StickyLedger()
    const participants: ChannelParticipant[] = [
      participant('alice'),
      { ...participant('peer1'), authorName: 'Momo', isBot: true },
    ]

    const decision = decideEngagement({
      message: inbound({
        text: 'what do you think?',
        referenceContext: {
          kind: 'reply',
          sources: [{ adapter: 'discord-bot', authorId: 'bob', authorName: 'Bob', text: 'Momo should answer' }],
        },
      }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants,
    })

    expect(decision).toBe('engage')
  })

  test('peer bot still engages on explicit mention even in solo-human channel', () => {
    // The fallback fix must NOT firewall bots behind extra gates. Symmetric
    // triggers are part of the design contract (see PHILOSOPHY block in
    // engagement.ts) — a peer bot's @-mention engages exactly like a human's.
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ authorId: 'peer1', authorName: 'peer1', authorIsBot: true, isBotMention: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice'), { ...participant('peer1'), isBot: true }],
    })
    expect(decision).toBe('engage')
  })

  test('peer bot still engages on reply even in solo-human channel', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({
        authorId: 'peer1',
        authorName: 'peer1',
        authorIsBot: true,
        replyToBotMessageId: 'msg42',
      }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice'), { ...participant('peer1'), isBot: true }],
    })
    expect(decision).toBe('engage')
  })

  test('peer bot still engages on sticky credit even in solo-human channel', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'peer1', 10_000)
    const decision = decideEngagement({
      message: inbound({ authorId: 'peer1', authorName: 'peer1', authorIsBot: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: [participant('alice'), { ...participant('peer1'), isBot: true }],
    })
    expect(decision).toBe('engage')
  })

  test('exits solo-human fallback only when a SECOND human appears (bots do not count)', () => {
    const ledger = new StickyLedger()
    const oneBotPlusOneHuman = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice'), { ...participant('peer1'), isBot: true }],
    })
    expect(oneBotPlusOneHuman).toBe('engage')

    const twoHumans = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice'), participant('bob'), { ...participant('peer1'), isBot: true }],
    })
    expect(twoHumans).toBe('observe')
  })

  test('observes lurker channels when fresh exact membership has two humans', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 10_000,
      participants: [
        participant('alice'),
        { ...participant('peer1'), isBot: true },
        { ...participant('peer2'), isBot: true },
      ],
      membership: { humans: 2, bots: 2, fetchedAt: 10_000, truncated: false },
    })

    expect(decision).toBe('observe')
  })

  test('preserves legacy solo fallback when membership is unavailable', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice'), { ...participant('peer1'), isBot: true }],
      membership: null,
    })

    expect(decision).toBe('engage')
  })

  test('fresh exact membership wins when persisted speakers have left', () => {
    expect(resolveEffectiveHumans(3, { humans: 1, bots: 1, fetchedAt: 20_000, truncated: false }, 20_000)).toBe(1)
  })

  test('truncated and stale membership fall back to the max count', () => {
    expect(resolveEffectiveHumans(2, { humans: 1, bots: 1, fetchedAt: 0, truncated: true }, 10_000)).toBe(2)
    expect(resolveEffectiveHumans(2, { humans: 1, bots: 1, fetchedAt: 0, truncated: false }, 120_000)).toBe(2)
  })

  test('fresh complete membership overrides a stale duplicate participant and engages the solo human', () => {
    // Both participant rows are the SAME human under two keys (a legacy
    // email-keyed entry plus the platform-id inbound), so the raw count looks
    // like 2; a complete fresh membership read knows it is really 1 and wins.
    const ledger = new StickyLedger()
    const duplicatedSameHuman: readonly ChannelParticipant[] = [
      participant('alice@example.com', 20_000),
      participant('alice', 20_000),
    ]
    const decision = decideEngagement({
      message: inbound({ authorId: 'alice', text: 'Typeey Hi' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 20_000,
      participants: duplicatedSameHuman,
      membership: { humans: 1, bots: 1, fetchedAt: 20_000, truncated: false, humanMemberIds: ['alice'] },
    })
    expect(decision).toBe('engage')
  })

  test('large truncated channels observe even with one persisted human', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice')],
      membership: { humans: 30, bots: 5, fetchedAt: 0, truncated: true },
    })

    expect(decision).toBe('observe')
  })

  test('peer bots never qualify for fallback even with bot-only membership', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ authorId: 'peer1', authorName: 'peer1', authorIsBot: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [{ ...participant('peer1'), isBot: true }],
      membership: { humans: 0, bots: 5, fetchedAt: 0, truncated: false },
    })

    expect(decision).toBe('observe')
  })

  test('sticky credit bypasses high membership when only one human is present', () => {
    // Solo-human channel (one persisted speaker, membership confirms one
    // human among many bots): sticky still force-engages the follow-up.
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: [participant('alice')],
      membership: { humans: 1, bots: 5, fetchedAt: 1000, truncated: false },
    })

    expect(decision).toBe('engage')
  })
})

describe('decideEngagement (thread solo-fallback fail-closed gate)', () => {
  const THREAD_KEY = 'slack-bot:g1:c1:t-root'

  function threadInbound(over: Partial<InboundMessage> = {}): InboundMessage {
    return inbound({ adapter: 'slack-bot', thread: 't-root', ...over })
  }

  test('observes an un-addressed thread message when membership is unknown (null)', () => {
    // given a freshly-opened thread in a busy channel: only the opener has
    // spoken (persistedHumans === 1) and the thread-scoped membership fetch has
    // not resolved yet
    const ledger = new StickyLedger()

    // when a bare human message arrives with no membership evidence
    const decision = decideEngagement({
      message: threadInbound(),
      config: baseConfig,
      key: THREAD_KEY,
      ledger,
      now: 0,
      participants: [participant('alice')],
      membership: null,
    })

    // then it fails closed rather than treating the fresh thread as solo
    expect(decision).toBe('observe')
  })

  test('observes an un-addressed thread message when membership is truncated', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: threadInbound(),
      config: baseConfig,
      key: THREAD_KEY,
      ledger,
      now: 10_000,
      participants: [participant('alice')],
      membership: { humans: 1, bots: 0, fetchedAt: 10_000, truncated: true },
    })
    expect(decision).toBe('observe')
  })

  test('observes an un-addressed thread message when membership is stale', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: threadInbound(),
      config: baseConfig,
      key: THREAD_KEY,
      ledger,
      now: 120_000,
      participants: [participant('alice')],
      membership: { humans: 1, bots: 0, fetchedAt: 0, truncated: false },
    })
    expect(decision).toBe('observe')
  })

  test('reproduces the reported incident: bare compare link plus a request in a fresh thread stays silent', () => {
    // given the exact production shape: a mention-less, alias-less, reply-less
    // link + a Japanese "please" opening a thread in a busy multi-human channel
    const ledger = new StickyLedger()

    // when it lands with no fresh-complete membership proof
    const decision = decideEngagement({
      message: threadInbound({
        text: 'https://github.com/org/repo/compare\n\nお願いします',
        authorId: 'user-a',
        authorName: 'user-a',
      }),
      config: baseConfig,
      key: THREAD_KEY,
      ledger,
      now: 0,
      participants: [participant('user-a')],
      membership: null,
    })

    // then the bot observes instead of engaging on a message not aimed at it
    expect(decision).toBe('observe')
  })

  test('engages a thread only when a fresh complete membership read proves a solo room', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: threadInbound(),
      config: baseConfig,
      key: THREAD_KEY,
      ledger,
      now: 20_000,
      participants: [participant('alice')],
      membership: { humans: 1, bots: 0, fetchedAt: 20_000, truncated: false, humanMemberIds: ['alice'] },
    })
    expect(decision).toBe('engage')
  })

  test('observes a thread when fresh complete membership shows two humans', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: threadInbound(),
      config: baseConfig,
      key: THREAD_KEY,
      ledger,
      now: 20_000,
      participants: [participant('alice')],
      membership: { humans: 2, bots: 0, fetchedAt: 20_000, truncated: false },
    })
    expect(decision).toBe('observe')
  })

  test('an explicit mention still engages in a thread despite unknown membership', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: threadInbound({ isBotMention: true }),
      config: baseConfig,
      key: THREAD_KEY,
      ledger,
      now: 0,
      participants: [participant('alice')],
      membership: null,
    })
    expect(decision).toBe('engage')
  })

  test('a plain-text alias (Korean) still engages in a thread despite unknown membership', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: threadInbound({ text: '비서 이거 확인해줄 수 있어?', authorId: 'user-a', authorName: 'user-a' }),
      config: baseConfig,
      key: THREAD_KEY,
      ledger,
      now: 0,
      participants: [participant('user-a')],
      selfAliases: ['비서', 'assistant'],
      membership: null,
    })
    expect(decision).toBe('engage')
  })

  test('a sticky follow-up still engages in a thread despite unknown membership', () => {
    const ledger = new StickyLedger()
    ledger.grant(THREAD_KEY, 'alice', 10_000)
    const decision = decideEngagement({
      message: threadInbound(),
      config: baseConfig,
      key: THREAD_KEY,
      ledger,
      now: 1000,
      participants: [participant('alice')],
      membership: null,
    })
    expect(decision).toBe('engage')
  })

  test('a DM with a typing-surface thread id still engages (DMs are exempt)', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ adapter: 'slack-bot', isDm: true, thread: 'dm-typing-ts' }),
      config: baseConfig,
      key: 'slack-bot:@dm:d1:dm-typing-ts',
      ledger,
      now: 0,
      participants: [participant('alice')],
      membership: null,
    })
    expect(decision).toBe('engage')
  })

  test('non-thread solo channels keep the legacy answer-everything fallback', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ adapter: 'slack-bot', thread: null }),
      config: baseConfig,
      key: 'slack-bot:g1:c1:',
      ledger,
      now: 0,
      participants: [participant('alice')],
      membership: null,
    })
    expect(decision).toBe('engage')
  })

  test('a thread the bot already participates in still engages despite unknown membership', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: threadInbound({ authorId: 'user-a', authorName: 'user-a', text: 'follow-up question' }),
      config: baseConfig,
      key: THREAD_KEY,
      ledger,
      now: 0,
      participants: [participant('user-a')],
      botInThread: true,
      membership: null,
    })
    expect(decision).toBe('engage')
  })

  test('a bot-joined thread with one human engages even when the parent channel is crowded', () => {
    // given: a Slack thread inside a channel whose fresh membership reports many humans
    const crowdedChannel = { humans: 5, bots: 1, fetchedAt: 10_000, truncated: false }

    // when: the only human in the thread follows up without mentioning the bot, past any sticky window
    const decision = decideEngagement({
      message: threadInbound({ authorId: 'user-a', authorName: 'user-a', text: '이거 다시 확인해줘' }),
      config: baseConfig,
      key: THREAD_KEY,
      ledger: new StickyLedger(),
      now: 10_000,
      participants: [participant('user-a')],
      botInThread: true,
      membership: crowdedChannel,
    })

    // then
    expect(decision).toBe('engage')
  })

  test('a bot-joined thread observes un-addressed messages once a second human posts', () => {
    const crowdedChannel = { humans: 5, bots: 1, fetchedAt: 10_000, truncated: false }

    const decision = decideEngagement({
      message: threadInbound({ authorId: 'user-b', authorName: 'user-b', text: 'agreed' }),
      config: baseConfig,
      key: THREAD_KEY,
      ledger: new StickyLedger(),
      now: 10_000,
      participants: [participant('user-a'), participant('user-b')],
      botInThread: true,
      membership: crowdedChannel,
    })

    expect(decision).toBe('observe')
  })

  test('a thread the bot has not joined still uses the crowded parent membership', () => {
    const crowdedChannel = { humans: 5, bots: 1, fetchedAt: 10_000, truncated: false }

    const decision = decideEngagement({
      message: threadInbound({ authorId: 'user-a', authorName: 'user-a' }),
      config: baseConfig,
      key: THREAD_KEY,
      ledger: new StickyLedger(),
      now: 10_000,
      participants: [participant('user-a')],
      botInThread: false,
      membership: crowdedChannel,
    })

    expect(decision).toBe('observe')
  })

  // Discord models a thread as its own channel: `thread` is null and the thread
  // id rides `chat`, so the gate must key on the structural `room` signal, not
  // `thread !== null`. Without this the Discord half of the incident bypasses
  // the gate entirely.
  function discordThreadInbound(over: Partial<InboundMessage> = {}): InboundMessage {
    return inbound({
      adapter: 'discord-bot',
      chat: 'thread-t1',
      thread: null,
      room: { kind: 'thread', parentChat: 'parent-c1' },
      ...over,
    })
  }

  test('observes an un-addressed Discord thread message (thread=null, room set) when membership is unknown', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: discordThreadInbound(),
      config: baseConfig,
      key: 'discord-bot:g1:thread-t1:',
      ledger,
      now: 0,
      participants: [participant('alice')],
      membership: null,
    })
    expect(decision).toBe('observe')
  })

  test('observes an un-addressed Discord thread message when membership is truncated (history-derived)', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: discordThreadInbound(),
      config: baseConfig,
      key: 'discord-bot:g1:thread-t1:',
      ledger,
      now: 10_000,
      participants: [participant('alice')],
      membership: { humans: 1, bots: 0, fetchedAt: 10_000, truncated: true },
    })
    expect(decision).toBe('observe')
  })

  test('engages a Discord thread only when a fresh complete membership read proves a solo room', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: discordThreadInbound(),
      config: baseConfig,
      key: 'discord-bot:g1:thread-t1:',
      ledger,
      now: 20_000,
      participants: [participant('alice')],
      membership: { humans: 1, bots: 0, fetchedAt: 20_000, truncated: false, humanMemberIds: ['alice'] },
    })
    expect(decision).toBe('engage')
  })

  test('an explicit mention still engages in a Discord thread despite unknown membership', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: discordThreadInbound({ isBotMention: true }),
      config: baseConfig,
      key: 'discord-bot:g1:thread-t1:',
      ledger,
      now: 0,
      participants: [participant('alice')],
      membership: null,
    })
    expect(decision).toBe('engage')
  })

  test('a Discord thread the bot already participates in still engages despite unknown membership', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: discordThreadInbound({ authorId: 'user-a', authorName: 'user-a' }),
      config: baseConfig,
      key: 'discord-bot:g1:thread-t1:',
      ledger,
      now: 0,
      participants: [participant('user-a')],
      botInThread: true,
      membership: null,
    })
    expect(decision).toBe('engage')
  })
})

describe('decideEngagement (sticky in groups)', () => {
  test('sticky credit force-engages in a DM', () => {
    const ledger = new StickyLedger()
    ledger.grant('discord-bot:@dm:d1:', 'alice', 10_000)
    const decision = decideEngagement({
      message: inbound({ isDm: true, workspace: '@dm' }),
      config: baseConfig,
      key: 'discord-bot:@dm:d1:',
      ledger,
      now: 1000,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('sticky credit force-engages when at most one human is present', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: [participant('alice')],
    })
    expect(decision).toBe('engage')
  })

  test('sticky credit force-engages a plain follow-up in a multi-human group and stays live', () => {
    // given a multi-human group and a held credit for alice
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)

    // when alice posts a plain follow-up (no mention/reply/alias)
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: crowded,
    })

    // then we engage (selectivity is the model's job via the prompt nudge),
    // and the credit slides forward instead of being spent
    expect(decision).toBe('engage')
    expect(ledger.has(KEY, 'alice', 1000)).toBe(true)
  })

  test('a refreshed group credit keeps engaging successive plain follow-ups', () => {
    // given a credit refreshed by the first group follow-up
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    decideEngagement({ message: inbound(), config: baseConfig, key: KEY, ledger, now: 1000, participants: crowded })

    // when alice posts again before any reply re-grants the credit
    const second = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 2000,
      participants: crowded,
    })

    // then engage — the rolling credit keeps the active conversation alive
    expect(second).toBe('engage')
  })

  test('an expired group credit is consumed but does not engage', () => {
    // given a credit that has already expired
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 1000)

    // when alice posts after expiry in a multi-human group
    const decision = decideEngagement({
      message: inbound(),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 5000,
      participants: crowded,
    })

    // then observe, and the stale credit is cleared
    expect(decision).toBe('observe')
    expect(ledger.has(KEY, 'alice', 5000)).toBe(false)
  })

  test('explicit mention engages in a multi-human group', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    const decision = decideEngagement({
      message: inbound({ isBotMention: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('alias engages in a multi-human group', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ text: '토토아 deploy please' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: crowded,
      selfAliases: ['토토'],
    })
    expect(decision).toBe('engage')
  })

  test('peer bot sticky engages symmetrically in both solo and multi-human groups', () => {
    // given a peer bot holding a credit in a one-human channel
    const soloLedger = new StickyLedger()
    soloLedger.grant(KEY, 'peer1', 10_000)
    const solo = decideEngagement({
      message: inbound({ authorId: 'peer1', authorName: 'peer1', authorIsBot: true }),
      config: baseConfig,
      key: KEY,
      ledger: soloLedger,
      now: 1000,
      participants: [participant('alice'), { ...participant('peer1'), isBot: true }],
    })
    expect(solo).toBe('engage')

    // when the same peer bot holds a credit in a two-human group
    const groupLedger = new StickyLedger()
    groupLedger.grant(KEY, 'peer1', 10_000)
    const group = decideEngagement({
      message: inbound({ authorId: 'peer1', authorName: 'peer1', authorIsBot: true }),
      config: baseConfig,
      key: KEY,
      ledger: groupLedger,
      now: 1000,
      participants: [participant('alice'), participant('bob'), { ...participant('peer1'), isBot: true }],
    })

    // then symmetric with humans — sticky wakes us in both (the peer-bot loop
    // guard, not the engagement gate, is what stops a runaway bot-to-bot chain)
    expect(group).toBe('engage')
  })
})

describe('decideEngagement (peer-bot-name suppressor)', () => {
  test('observes when text contains a peer-bot authorName from participants', () => {
    const ledger = new StickyLedger()
    const participants: readonly ChannelParticipant[] = [participant('alice'), { ...participant('라라'), isBot: true }]
    const decision = decideEngagement({
      message: inbound({ text: '라라아 check the cron' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants,
      selfAliases: ['토토'],
    })
    expect(decision).toBe('observe')
  })

  test('case-insensitive peer-name match', () => {
    const ledger = new StickyLedger()
    const participants: readonly ChannelParticipant[] = [
      participant('alice'),
      { ...participant('Pengpeng'), isBot: true },
    ]
    const decision = decideEngagement({
      message: inbound({ text: 'Hey PENGPENG, deploy please' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants,
      selfAliases: ['toto'],
    })
    expect(decision).toBe('observe')
  })

  test('peer-name in text does NOT block self-alias engagement (own claim wins)', () => {
    // Mixed-target message: "토토아 라라아 both take a look" — self matches AND
    // peer matches. The alias trigger fires earlier in the gate chain
    // and engages cleanly; we never reach the peer suppressor. The Korean
    // names + vocative particle '아' exercise substring alias matching.
    const ledger = new StickyLedger()
    const participants: readonly ChannelParticipant[] = [participant('alice'), { ...participant('라라'), isBot: true }]
    const decision = decideEngagement({
      message: inbound({ text: '토토아 라라아 both take a look' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants,
      selfAliases: ['토토'],
    })
    expect(decision).toBe('engage')
  })

  test('human authorName in text does NOT trigger suppression (only peer bots)', () => {
    // Solo-human channel where alice writes "bob, hi" — bob has never
    // spoken so participants only has alice. The peer suppressor MUST
    // not fire on alice's own name (she's authoring), and a non-bot
    // 'bob' wouldn't trigger it even if present. Solo-human fallback
    // engages.
    const ledger = new StickyLedger()
    const participants: readonly ChannelParticipant[] = [participant('alice')]
    const decision = decideEngagement({
      message: inbound({ authorId: 'alice', text: 'bob, can you check this?' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants,
      selfAliases: [],
    })
    expect(decision).toBe('engage')
  })

  test('first-message-before-peer-spoken slips through (known limitation)', () => {
    // Documents the limitation: if the user names a peer bot before that
    // peer has ever spoken in this channel, participants[] doesn't yet
    // contain it and the suppressor can't fire. The solo-human fallback
    // engages. Follow-up message after the peer has spoken once is fine.
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ text: '라라아 check the cron' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice')],
      selfAliases: ['토토'],
    })
    expect(decision).toBe('engage')
  })

  test('peer suppressor fires before solo-human fallback even with effectiveHumans=1', () => {
    const ledger = new StickyLedger()
    const participants: readonly ChannelParticipant[] = [participant('alice'), { ...participant('라라'), isBot: true }]
    const decision = decideEngagement({
      message: inbound({ text: '라라아 any update on that?' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants,
      selfAliases: [],
      membership: { humans: 1, bots: 4, fetchedAt: 0, truncated: false },
    })
    expect(decision).toBe('observe')
  })

  test('peer suppressor does not block explicit triggers (mention still wins)', () => {
    const ledger = new StickyLedger()
    const participants: readonly ChannelParticipant[] = [participant('alice'), { ...participant('라라'), isBot: true }]
    const decision = decideEngagement({
      message: inbound({ isBotMention: true, text: '<@me> hi, also 라라아 fyi' }),
      // '라라아' = peer name '라라' + Korean particle; keeps peer-name suppression coverage.
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants,
      selfAliases: [],
    })
    expect(decision).toBe('engage')
  })
})

describe('decideEngagement (targets-others suppressors)', () => {
  test('observes a solo-human message that mentions someone other than us', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ mentionsOthers: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice')],
    })
    expect(decision).toBe('observe')
  })

  test('observes a solo-human reply whose parent is someone else', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ replyToOtherMessageId: 'parent-from-bob' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('alice')],
    })
    expect(decision).toBe('observe')
  })

  test('observes a thread side-conversation between two humans in a busy channel (incident regression)', () => {
    // Incident: a thread root authored by Jiyoung mentions Rio (a human peer).
    // Rio replies in the thread. The bot was engaging on Rio's reply because
    // the Slack adapter set replyToBotMessageId for every threaded reply
    // regardless of parent author. Once the adapter correctly populates
    // replyToOtherMessageId from parent_user_id, this gate fires and the bot
    // stays out of the human-to-human side-conversation.
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({
        authorId: 'rio',
        text: 'i finished the cancellation work',
        thread: 'jiyoung-thread-root-ts',
        replyToBotMessageId: null,
        replyToOtherMessageId: 'jiyoung-thread-root-ts',
      }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('rio')],
    })
    expect(decision).toBe('observe')
  })

  test('engages in a thread we already participate in even when parent_user_id resolves to a human (PR #58 follow-up)', () => {
    // Incident: a human starts a thread by @-mentioning the bot. The bot
    // replies (mention trigger). The human follows up in the thread. Slack
    // surfaces parent_user_id = the human (the thread ROOT author, not the
    // immediate parent), so the adapter sets replyToOtherMessageId. Without
    // botInThread, the suppressor at the bottom of decideEngagement drops
    // the follow-up — silently, with no log line — and the bot appears dead
    // for the rest of the thread. The fix: once botInThread is true, the
    // replyToOtherMessageId suppressor stops firing, because this is no
    // longer a side conversation between humans. The two-humans regression
    // test above still passes because that case has botInThread=false.
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({
        authorId: 'human-asker',
        text: 'follow-up question',
        thread: 'human-asker-thread-root-ts',
        replyToBotMessageId: null,
        replyToOtherMessageId: 'human-asker-thread-root-ts',
      }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: [participant('human-asker')],
      botInThread: true,
    })
    expect(decision).toBe('engage')
  })

  test('mentionsOthers still suppresses even when bot is in the thread (only the replyToOther gate is conditional)', () => {
    // botInThread relaxes the parent-author gate (which is wrong-ish for
    // Slack semantics) but NOT the explicit-tag-of-someone-else gate. If
    // the human is now @-mentioning a third party in the thread, the bot
    // should stay quiet — explicit tagging is unambiguous, parent_user_id
    // is not.
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({
        authorId: 'human-asker',
        text: 'hey <@UBOB> can you help here?',
        thread: 'thread-root-ts',
        mentionsOthers: true,
      }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
      botInThread: true,
    })
    expect(decision).toBe('observe')
  })

  test('mention-of-us still engages even when the message also tags others', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ isBotMention: true, mentionsOthers: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('reply-to-us still engages even when other users are also tagged', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ replyToBotMessageId: 'msg42', mentionsOthers: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 0,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('DM still engages even with mentions-of-others present', () => {
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ isDm: true, workspace: '@dm', mentionsOthers: true }),
      config: baseConfig,
      key: 'discord-bot:@dm:d1:',
      ledger,
      now: 0,
      participants: [participant('alice')],
    })
    expect(decision).toBe('engage')
  })

  test('sticky credit still engages with mentions-of-others present in a SOLO-human channel', () => {
    // given a solo-human channel (effectiveHumans <= 1): the multi-human
    // pre-sticky target check does not apply, so sticky engages as before even
    // when the message tags someone else. The multi-human variant is covered
    // in the "sticky pre-sticky target check" suite below.
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    const decision = decideEngagement({
      message: inbound({ mentionsOthers: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: [participant('alice')],
    })
    expect(decision).toBe('engage')
  })
})

describe('decideEngagement (multi-human sticky target check)', () => {
  test('a credited author who @-mentions a third party observes, and the credit is PRESERVED', () => {
    // given a credited author in a two-human group
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)

    // when alice posts a message structurally aimed at bob (mentionsOthers)
    const decision = decideEngagement({
      message: inbound({ authorId: 'alice', text: 'hey <@UBOB> what do you think?', mentionsOthers: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: crowded,
    })

    // then we stay out of the third-party-directed message, and the credit
    // survives for alice's next untargeted follow-up
    expect(decision).toBe('observe')
    expect(ledger.has(KEY, 'alice', 1000)).toBe(true)
  })

  test("a credited author's reply to another human's message observes, credit preserved", () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    const decision = decideEngagement({
      message: inbound({ authorId: 'alice', replyToOtherMessageId: 'bob-msg', text: 'sounds good' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: crowded,
    })
    expect(decision).toBe('observe')
    expect(ledger.has(KEY, 'alice', 1000)).toBe(true)
  })

  test('a credited author naming a known peer bot in plain text still engages (the model decides)', () => {
    // given a credited human in a two-human group with a known peer bot
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    const participants: readonly ChannelParticipant[] = [
      participant('alice'),
      participant('bob'),
      { ...participant('라라'), isBot: true },
    ]

    // when alice names the peer bot in plain text, with no mention or reply
    const decision = decideEngagement({
      message: inbound({ authorId: 'alice', text: '라라아 그거 어떻게 됐어?' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants,
    })

    // then sticky engages exactly as for a plain-text human name; the
    // group-chat nudge leaves the stay-silent call to the model
    expect(decision).toBe('engage')
  })

  test('a credited peer bot whose message contains its own name engages', () => {
    // given a peer bot holding a credit in a two-human group
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'peer1', 10_000)
    const participants: readonly ChannelParticipant[] = [
      participant('alice'),
      participant('bob'),
      { ...participant('라라'), authorId: 'peer1', isBot: true },
    ]

    // when it posts a self-labelled report, as a human would
    const decision = decideEngagement({
      message: inbound({
        authorId: 'peer1',
        authorName: '라라',
        authorIsBot: true,
        text: '라라 리뷰: v5를 수정 요청으로 돌렸어',
      }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants,
    })

    // then the credit engages; a name in text is not structural addressing
    expect(decision).toBe('engage')
  })

  test('a credited peer bot that @-mentions a third party still observes, credit preserved', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'peer1', 10_000)
    const decision = decideEngagement({
      message: inbound({
        authorId: 'peer1',
        authorIsBot: true,
        text: '<@UBOB> 확인해줘',
        mentionsOthers: true,
      }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: [...crowded, { ...participant('peer1'), isBot: true }],
    })
    expect(decision).toBe('observe')
    expect(ledger.has(KEY, 'peer1', 1000)).toBe(true)
  })

  test("after a suppressed third-party message, the same author's next plain follow-up consumes the preserved credit and engages", () => {
    // given a credit that survives a third-party-directed message
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    decideEngagement({
      message: inbound({ authorId: 'alice', text: 'hey <@UBOB>?', mentionsOthers: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: crowded,
    })

    // when alice then posts a plain, untargeted follow-up
    const second = decideEngagement({
      message: inbound({ authorId: 'alice', text: 'anyway, back to the deploy' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 2000,
      participants: crowded,
    })

    // then the preserved credit wakes us and slides forward
    expect(second).toBe('engage')
    expect(ledger.has(KEY, 'alice', 2000)).toBe(true)
  })

  test('a plain multi-human follow-up from a credited author still engages (no suppressor set)', () => {
    // regression guard: the pre-check must only step aside for STRUCTURALLY
    // third-party-directed messages, never for plain follow-ups
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    const decision = decideEngagement({
      message: inbound({ authorId: 'alice', text: 'and what about staging?' }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: crowded,
    })
    expect(decision).toBe('engage')
    expect(ledger.has(KEY, 'alice', 1000)).toBe(true)
  })

  test('a credited author who names a third party BUT also aliases us engages (alias precedence)', () => {
    // "토토아 라라아 both take a look" — names us AND a peer. The alias rule must win;
    // the pre-sticky check must not steal engagement from an explicit address.
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    const participants: readonly ChannelParticipant[] = [
      participant('alice'),
      participant('bob'),
      { ...participant('라라'), isBot: true },
    ]
    const decision = decideEngagement({
      message: inbound({ authorId: 'alice', text: '토토아 라라아 both take a look', mentionsOthers: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants,
      selfAliases: ['토토'],
    })
    expect(decision).toBe('engage')
  })

  test('explicit mention-of-us still engages in a multi-human group even when also tagging others', () => {
    const ledger = new StickyLedger()
    ledger.grant(KEY, 'alice', 10_000)
    const decision = decideEngagement({
      message: inbound({ authorId: 'alice', isBotMention: true, mentionsOthers: true }),
      config: baseConfig,
      key: KEY,
      ledger,
      now: 1000,
      participants: crowded,
    })
    expect(decision).toBe('engage')
  })

  test('with stickiness OFF the pre-check is inert (no credit to protect)', () => {
    // given stickiness off and a third-party-directed message: the pre-check
    // is gated on stickiness, so it does not fire here; the existing
    // post-alias suppressor still observes
    const ledger = new StickyLedger()
    const decision = decideEngagement({
      message: inbound({ authorId: 'alice', text: 'hey <@UBOB>?', mentionsOthers: true }),
      config: { trigger: ['mention', 'reply', 'dm'], stickiness: 'off' },
      key: KEY,
      ledger,
      now: 1000,
      participants: crowded,
    })
    expect(decision).toBe('observe')
  })
})

describe('grantStickyForReplyTargets', () => {
  test('grants credit per author when stickiness is on', () => {
    const ledger = new StickyLedger()
    grantStickyForReplyTargets(ledger, KEY, ['alice', 'bob'], baseConfig, 1000)
    expect(ledger.has(KEY, 'alice', 1000)).toBe(true)
    expect(ledger.has(KEY, 'bob', 1000)).toBe(true)
  })

  test('does not grant when stickiness is off', () => {
    const ledger = new StickyLedger()
    grantStickyForReplyTargets(ledger, KEY, ['alice'], { trigger: ['mention'], stickiness: 'off' }, 1000)
    expect(ledger.has(KEY, 'alice', 1000)).toBe(false)
  })

  test('granted credit expires after the configured window', () => {
    const ledger = new StickyLedger()
    grantStickyForReplyTargets(ledger, KEY, ['alice'], baseConfig, 0)
    expect(
      ledger.has(KEY, 'alice', baseConfig.stickiness === 'off' ? 0 : baseConfig.stickiness.perReply.window - 1),
    ).toBe(true)
    expect(
      ledger.has(KEY, 'alice', baseConfig.stickiness === 'off' ? 0 : baseConfig.stickiness.perReply.window + 1),
    ).toBe(false)
  })
})

describe('StickyLedger.clear', () => {
  test('drops every credit for the key and reports how many were held', () => {
    const ledger = new StickyLedger()
    grantStickyForReplyTargets(ledger, KEY, ['alice', 'bob'], baseConfig, 0)

    const cleared = ledger.clear(KEY)

    expect(cleared).toBe(2)
    expect(ledger.has(KEY, 'alice', 0)).toBe(false)
    expect(ledger.has(KEY, 'bob', 0)).toBe(false)
  })

  test('returns 0 when the key holds no credits', () => {
    const ledger = new StickyLedger()
    expect(ledger.clear(KEY)).toBe(0)
  })

  test('leaves other keys untouched', () => {
    const ledger = new StickyLedger()
    const otherKey = 'discord-bot:g1:c2:'
    grantStickyForReplyTargets(ledger, KEY, ['alice'], baseConfig, 0)
    grantStickyForReplyTargets(ledger, otherKey, ['alice'], baseConfig, 0)

    ledger.clear(KEY)

    expect(ledger.has(KEY, 'alice', 0)).toBe(false)
    expect(ledger.has(otherKey, 'alice', 0)).toBe(true)
  })

  test('a re-grant after clear restores stickiness', () => {
    const ledger = new StickyLedger()
    grantStickyForReplyTargets(ledger, KEY, ['alice'], baseConfig, 0)
    ledger.clear(KEY)

    grantStickyForReplyTargets(ledger, KEY, ['alice'], baseConfig, 0)

    expect(ledger.has(KEY, 'alice', 0)).toBe(true)
  })
})
