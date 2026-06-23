import { afterEach, describe, expect, test } from 'bun:test'

import { recordReview, resetReviewTurn } from '@/channels/github-review-turn-ledger'
import type { ChannelRouter } from '@/channels/router'
import type { OutboundMessage, SendResult } from '@/channels/types'

import { createChannelReplyTool, type ChannelReplyOrigin } from './channel-reply'

const SESSION = 'ses_cr_fr'
const WS = 'acme/widgets'

afterEach(() => resetReviewTurn(SESSION))

function fakeRouter(onSend: (msg: OutboundMessage) => SendResult = () => ({ ok: true })): ChannelRouter {
  return {
    route: async () => {},
    send: async (msg) => onSend(msg),
    getConsecutiveSendCount: () => 0,
    getSendRate: () => ({ count: 0, windowMs: 5_000 }),
    registerOutbound: () => {},
    unregisterOutbound: () => {},
    registerConfig: () => {},
    unregisterConfig: () => {},
    registerReaction: () => {},
    unregisterReaction: () => {},
    react: async () => ({ ok: true }),
    registerRemoveReaction: () => {},
    unregisterRemoveReaction: () => {},
    removeReaction: async () => ({ ok: true }),
    registerTyping: () => {},
    unregisterTyping: () => {},
    setTypingCapability: () => {},
    registerChannelNameResolver: () => {},
    unregisterChannelNameResolver: () => {},
    registerSelfIdentity: () => {},
    unregisterSelfIdentity: () => {},
    registerMembership: () => {},
    unregisterMembership: () => {},
    registerHistory: () => {},
    unregisterHistory: () => {},
    fetchHistory: async () => ({ ok: false, error: 'x' }),
    registerFetchAttachment: () => {},
    unregisterFetchAttachment: () => {},
    fetchAttachment: async () => ({ ok: false, error: 'x' }),
    registerReviewThreadResolver: () => {},
    unregisterReviewThreadResolver: () => {},
    resolveReviewThread: async () => ({ ok: true }),
    registerReviewStateResolver: () => {},
    unregisterReviewStateResolver: () => {},
    getReviewState: async () => ({ ok: true, selfBlocking: false, approve: true }),
    lookupInboundAttachment: () => null,
    listInboundAttachmentIds: () => [],
    registerHistoryAttachments: () => {},
    getSelfAliases: () => [],
    stop: async () => {},
    tearDownAllLive: async () => {},
    liveCount: () => 0,
    executeCommand: async () => ({ kind: 'no-live-session' }),
    injectSubagentCompletionReminder: () => ({ kind: 'no-live-session' }),
    injectPrVerdictActivity: () => ({ kind: 'delivered', count: 0 }),
    markTurnSkipped: () => ({ kind: 'no-live-session' }),
    clearSticky: () => ({ keyId: '', cleared: 0 }),
    reserveRestartHandoff: () => null,
    resumeRestartHandoff: async () => {},
  }
}

const prOrigin: ChannelReplyOrigin = { adapter: 'github', workspace: WS, chat: 'pr:12', thread: null }
const fakeCtx = {} as Parameters<ReturnType<typeof createChannelReplyTool>['execute']>[4]

function tool(onSend?: (msg: OutboundMessage) => SendResult, origin: ChannelReplyOrigin = prOrigin) {
  return createChannelReplyTool({ router: fakeRouter(onSend), origin, sessionId: SESSION })
}

async function run(
  t: ReturnType<typeof createChannelReplyTool>,
  params: Omit<Parameters<ReturnType<typeof createChannelReplyTool>['execute']>[1], 'continue'> & {
    continue?: boolean
  },
) {
  return t.execute('id', { ...params, continue: params.continue ?? false }, undefined, undefined, fakeCtx)
}

describe('channel_reply false-receipt guard', () => {
  test('blocks a terminal "Approved" with no review this turn — and posts nothing', async () => {
    let sent = 0
    const result = await run(
      tool(() => {
        sent++
        return { ok: true }
      }),
      { text: 'Approved! 🎉' },
    )
    expect(sent).toBe(0)
    expect((result.details as { ok: boolean }).ok).toBe(false)
  })

  test('allows "Approved" once a real APPROVE review was recorded this turn', async () => {
    recordReview({ sessionId: SESSION, workspace: WS, prNumber: 12, verdict: 'APPROVE' })
    let sent = 0
    const result = await run(
      tool(() => {
        sent++
        return { ok: true }
      }),
      { text: 'Approved — thanks for the fix!' },
    )
    expect(sent).toBe(1)
    expect((result.details as { ok: boolean }).ok).toBe(true)
  })

  test('warns (allows + appends notice) on a soft "looks good"', async () => {
    const result = await run(tool(), { text: 'looks good to me' })
    expect((result.details as { ok: boolean }).ok).toBe(true)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('does not create a formal GitHub review')
  })

  test('does not guard non-github replies', async () => {
    const slackOrigin: ChannelReplyOrigin = { adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null }
    let sent = 0
    await run(
      tool(() => {
        sent++
        return { ok: true }
      }, slackOrigin),
      { text: 'Approved!' },
    )
    expect(sent).toBe(1)
  })
})
