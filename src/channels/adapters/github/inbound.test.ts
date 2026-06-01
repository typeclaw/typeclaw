import { describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'

import type { InboundMessage } from '@/channels/types'

import { createDeliveryDedup } from './dedup'
import { classifyGithubInbound, createGithubWebhookHandler, verifySignature } from './inbound'

const logger = { info: () => {}, warn: () => {}, error: () => {} }

describe('verifySignature', () => {
  it('accepts the GitHub docs test vector', async () => {
    const ok = await verifySignature(
      'Hello, World!',
      "It's a Secret to Everybody",
      'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
    )
    expect(ok).toBe(true)
  })
})

describe('classifyGithubInbound', () => {
  it('classifies issue comments on pull requests as PR chats', () => {
    const msg = classifyGithubInbound('issue_comment', issueCommentPayload({ pullRequest: true }), 'typeclaw-bot')
    expect(msg?.workspace).toBe('acme/project')
    expect(msg?.chat).toBe('pr:7')
    expect(msg?.thread).toBe(null)
    expect(msg?.authorName).toBe('alice')
  })

  it('classifies review comments into root-comment threads', () => {
    const msg = classifyGithubInbound('pull_request_review_comment', reviewCommentPayload(), 'typeclaw-bot')
    expect(msg?.chat).toBe('pr:7')
    expect(msg?.thread).toBe('101')
  })

  describe('pull_request.review_requested', () => {
    it('wakes the bot when it is the requested reviewer', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' }),
        'typeclaw-bot',
      )
      expect(msg?.chat).toBe('pr:7')
      expect(msg?.thread).toBe(null)
      expect(msg?.text).toContain('@alice')
      expect(msg?.text).toContain('requested your review on PR #7')
      expect(msg?.text).toContain('feat-branch → main')
      expect(msg?.text).toContain('Please review the changes line-by-line')
      expect(msg?.isBotMention).toBe(true)
      expect(msg?.authorName).toBe('alice')
    })

    it('drops requests targeting someone else', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'someone-else' }),
        'typeclaw-bot',
      )
      expect(msg).toBe(null)
    })

    it('drops self-loop when the bot requested itself', () => {
      const payload = reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' })
      ;(payload.sender as Record<string, unknown>).login = 'typeclaw-bot'
      const msg = classifyGithubInbound('pull_request', payload, 'typeclaw-bot')
      expect(msg).toBe(null)
    })

    it('wakes the bot when its team is requested and membership resolves true', () => {
      const msg = classifyGithubInbound('pull_request', reviewRequestedTeamPayload(), 'typeclaw-bot', {
        teamIsBotMember: true,
      })
      expect(msg?.chat).toBe('pr:7')
      expect(msg?.text).toContain("team @reviewers (you're a member of)")
    })

    it('drops team requests when membership resolves false', () => {
      const msg = classifyGithubInbound('pull_request', reviewRequestedTeamPayload(), 'typeclaw-bot', {
        teamIsBotMember: false,
      })
      expect(msg).toBe(null)
    })

    it('drops team requests when membership is unknown (handler did not resolve)', () => {
      const msg = classifyGithubInbound('pull_request', reviewRequestedTeamPayload(), 'typeclaw-bot')
      expect(msg).toBe(null)
    })

    it('mints distinct externalMessageIds for requested → removed → requested again', () => {
      const requested = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot', updatedAt: '2026-01-01T00:00:00Z' }),
        'typeclaw-bot',
      )
      const removed = classifyGithubInbound(
        'pull_request',
        reviewRequestRemovedPayload({ reviewerLogin: 'typeclaw-bot', updatedAt: '2026-01-01T00:01:00Z' }),
        'typeclaw-bot',
      )
      const requestedAgain = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot', updatedAt: '2026-01-01T00:02:00Z' }),
        'typeclaw-bot',
      )
      expect(requested?.externalMessageId).not.toBe(removed?.externalMessageId)
      expect(removed?.externalMessageId).not.toBe(requestedAgain?.externalMessageId)
      expect(requested?.externalMessageId).not.toBe(requestedAgain?.externalMessageId)
    })

    it('falls back to PR id when title/branch info is absent', () => {
      const payload = reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' })
      delete (payload.pull_request as Record<string, unknown>).title
      delete (payload.pull_request as Record<string, unknown>).head
      delete (payload.pull_request as Record<string, unknown>).base
      const msg = classifyGithubInbound('pull_request', payload, 'typeclaw-bot')
      expect(msg?.text).toContain('PR #7')
      expect(msg?.text).not.toContain('Branch:')
    })
  })

  describe('pull_request.review_request_removed', () => {
    it('emits a cleanup signal when the bot is un-requested', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestRemovedPayload({ reviewerLogin: 'typeclaw-bot' }),
        'typeclaw-bot',
      )
      expect(msg?.chat).toBe('pr:7')
      expect(msg?.text).toContain('removed your review request')
      expect(msg?.text).toContain('You can stop any in-progress review.')
    })

    it('drops removal events for other reviewers', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        reviewRequestRemovedPayload({ reviewerLogin: 'someone-else' }),
        'typeclaw-bot',
      )
      expect(msg).toBe(null)
    })
  })

  describe('pull_request.assigned', () => {
    it('wakes the bot when it is the assignee', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        assignedPayload({ assigneeLogin: 'typeclaw-bot' }),
        'typeclaw-bot',
      )
      expect(msg?.chat).toBe('pr:7')
      expect(msg?.thread).toBe(null)
      expect(msg?.text).toContain('@alice')
      expect(msg?.text).toContain('assigned you to PR #7')
      expect(msg?.text).toContain('feat-branch → main')
      expect(msg?.text).toContain('Please review the changes line-by-line')
      expect(msg?.isBotMention).toBe(true)
      expect(msg?.authorName).toBe('alice')
    })

    it('drops assignments targeting someone else', () => {
      const msg = classifyGithubInbound(
        'pull_request',
        assignedPayload({ assigneeLogin: 'someone-else' }),
        'typeclaw-bot',
      )
      expect(msg).toBe(null)
    })

    it('drops self-loop when the bot assigned itself', () => {
      const payload = assignedPayload({ assigneeLogin: 'typeclaw-bot' })
      ;(payload.sender as Record<string, unknown>).login = 'typeclaw-bot'
      const msg = classifyGithubInbound('pull_request', payload, 'typeclaw-bot')
      expect(msg).toBe(null)
    })

    it('does NOT treat unassigned as an assignment wake (no bot-mention)', () => {
      const payload = assignedPayload({ assigneeLogin: 'typeclaw-bot' })
      payload.action = 'unassigned'
      const msg = classifyGithubInbound('pull_request', payload, 'typeclaw-bot')
      expect(msg?.text).not.toContain('assigned you to PR')
      expect(msg?.isBotMention).not.toBe(true)
    })

    it('mints an externalMessageId distinct from a review_requested on the same PR', () => {
      const assigned = classifyGithubInbound(
        'pull_request',
        assignedPayload({ assigneeLogin: 'typeclaw-bot', updatedAt: '2026-01-01T00:00:00Z' }),
        'typeclaw-bot',
      )
      const requested = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot', updatedAt: '2026-01-01T00:00:00Z' }),
        'typeclaw-bot',
      )
      expect(assigned?.externalMessageId).not.toBe(requested?.externalMessageId)
    })

    it('falls back to PR id when title/branch info is absent', () => {
      const payload = assignedPayload({ assigneeLogin: 'typeclaw-bot' })
      delete (payload.pull_request as Record<string, unknown>).title
      delete (payload.pull_request as Record<string, unknown>).head
      delete (payload.pull_request as Record<string, unknown>).base
      const msg = classifyGithubInbound('pull_request', payload, 'typeclaw-bot')
      expect(msg?.text).toContain('PR #7')
      expect(msg?.text).not.toContain('Branch:')
    })
  })

  describe('pull_request.opened', () => {
    it('treats an opened PR as a review request in App mode', () => {
      const msg = classifyGithubInbound('pull_request', openedPayload(), 'typeclaw-bot', { authType: 'app' })
      expect(msg?.chat).toBe('pr:7')
      expect(msg?.thread).toBe(null)
      expect(msg?.text).toContain('@alice')
      expect(msg?.text).toContain('requested your review on PR #7')
      expect(msg?.text).toContain('feat-branch → main')
      expect(msg?.text).toContain('Please review the changes line-by-line')
      expect(msg?.isBotMention).toBe(true)
      expect(msg?.authorName).toBe('alice')
    })

    it('does NOT treat an opened PR as a review request in PAT mode', () => {
      // A PAT-backed bot is a real user that can be added to requested_reviewers,
      // so it waits for the explicit review_requested event instead of reviewing
      // every opened PR. The opened event lands as awareness-only context.
      const msg = classifyGithubInbound('pull_request', openedPayload(), 'typeclaw-bot', { authType: 'pat' })
      expect(msg?.chat).toBe('pr:7')
      expect(msg?.text).not.toContain('requested your review')
      expect(msg?.text).not.toContain('Please review the changes line-by-line')
      expect(msg?.isBotMention).toBe(false)
    })

    it('does NOT treat an opened PR as a review request when authType is unset', () => {
      const msg = classifyGithubInbound('pull_request', openedPayload(), 'typeclaw-bot')
      expect(msg?.text).not.toContain('requested your review')
    })

    it('drops a bot-opened PR in App mode (self-loop guard)', () => {
      const payload = openedPayload()
      ;(payload.sender as Record<string, unknown>).login = 'typeclaw-bot'
      const msg = classifyGithubInbound('pull_request', payload, 'typeclaw-bot', { authType: 'app' })
      expect(msg).toBe(null)
    })

    it('mints distinct externalMessageIds for opened vs a later review_requested on the same PR', () => {
      const opened = classifyGithubInbound('pull_request', openedPayload(), 'typeclaw-bot', { authType: 'app' })
      const requested = classifyGithubInbound(
        'pull_request',
        reviewRequestedPayload({ reviewerLogin: 'typeclaw-bot' }),
        'typeclaw-bot',
      )
      expect(opened?.externalMessageId).not.toBe(requested?.externalMessageId)
    })
  })
})

describe('createGithubWebhookHandler — pull_request.opened auth gating', () => {
  it('routes an opened PR as a review request when authType is app', async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.opened'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      authType: () => 'app',
      logger,
      route: (msg) => {
        routed.push(msg)
      },
    })

    await handler(signedRequest(JSON.stringify(openedPayload()), 'pull_request', 'opened-app'))
    expect(routed).toHaveLength(1)
    expect(routed[0]?.text).toContain('requested your review on PR #7')
    expect(routed[0]?.isBotMention).toBe(true)
  })

  it('routes an opened PR as awareness-only context when authType is pat', async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.opened'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      authType: () => 'pat',
      logger,
      route: (msg) => {
        routed.push(msg)
      },
    })

    await handler(signedRequest(JSON.stringify(openedPayload()), 'pull_request', 'opened-pat'))
    expect(routed).toHaveLength(1)
    expect(routed[0]?.text).not.toContain('requested your review')
    expect(routed[0]?.isBotMention).toBe(false)
  })
})

describe('createGithubWebhookHandler — review_requested team gating', () => {
  it('consults isBotInTeam and routes when membership is active', async () => {
    const routed: InboundMessage[] = []
    const calls: Array<{ org: string; slug: string; login: string }> = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.review_requested'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      isBotInTeam: async (input) => {
        calls.push(input)
        return true
      },
      logger,
      route: (msg) => {
        routed.push(msg)
      },
    })

    const body = JSON.stringify(reviewRequestedTeamPayload())
    const response = await handler(signedRequest(body, 'pull_request', 'team-1'))

    expect(response.status).toBe(200)
    expect(calls).toEqual([{ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' }])
    expect(routed[0]?.chat).toBe('pr:7')
  })

  it('drops the event when isBotInTeam resolves false', async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.review_requested'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      isBotInTeam: async () => false,
      logger,
      route: (msg) => {
        routed.push(msg)
      },
    })

    await handler(signedRequest(JSON.stringify(reviewRequestedTeamPayload()), 'pull_request', 'team-2'))
    expect(routed).toHaveLength(0)
  })

  it('drops the event when isBotInTeam throws', async () => {
    const routed: InboundMessage[] = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['pull_request.review_requested'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      isBotInTeam: async () => {
        throw new Error('boom')
      },
      logger,
      route: (msg) => {
        routed.push(msg)
      },
    })

    await handler(signedRequest(JSON.stringify(reviewRequestedTeamPayload()), 'pull_request', 'team-3'))
    expect(routed).toHaveLength(0)
  })
})

describe('createGithubWebhookHandler', () => {
  it('acks before the fire-and-forget route promise settles', async () => {
    const routed: InboundMessage[] = []
    const routeWait = Promise.withResolvers<void>()
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['issue_comment.created'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      logger,
      route: (msg) => {
        routed.push(msg)
        void routeWait.promise
      },
    })

    const body = JSON.stringify(issueCommentPayload({ pullRequest: false }))
    const response = await handler(signedRequest(body, 'issue_comment', 'delivery-1'))

    expect(response.status).toBe(200)
    expect(routed[0]?.chat).toBe('issue:7')
    routeWait.resolve()
  })

  it('drops duplicate deliveries without routing twice', async () => {
    let count = 0
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['issue_comment.created'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      logger,
      route: () => {
        count++
      },
    })
    const body = JSON.stringify(issueCommentPayload({ pullRequest: false }))

    await handler(signedRequest(body, 'issue_comment', 'same-delivery'))
    await handler(signedRequest(body, 'issue_comment', 'same-delivery'))

    expect(count).toBe(1)
  })
})

describe('createGithubWebhookHandler — self-author drop', () => {
  function selfAuthoredHandler(
    routed: InboundMessage[],
    overrides: { selfId?: string | null; selfLogin?: string | null; allowlist?: readonly string[] } = {},
  ): (req: Request) => Promise<Response> {
    return createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () =>
        overrides.allowlist ?? ['issue_comment.created', 'pull_request_review_comment.created', 'issues.opened'],
      selfId: () => overrides.selfId ?? '99',
      selfLogin: () => overrides.selfLogin ?? 'typeclaw-bot',
      logger,
      route: (msg) => {
        routed.push(msg)
      },
    })
  }

  it('drops issue_comment authored by self (matched by id)', async () => {
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed)
    const payload = issueCommentPayload({ pullRequest: false })
    ;(payload.comment as Record<string, unknown>).user = { login: 'typeclaw-bot', id: 99, type: 'Bot' }
    await handler(signedRequest(JSON.stringify(payload), 'issue_comment', 'self-by-id'))
    expect(routed).toHaveLength(0)
  })

  it('drops issue_comment authored by self (matched by login when id differs)', async () => {
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed)
    const payload = issueCommentPayload({ pullRequest: false })
    // Same login, different id — simulates the issue #452 case where the
    // id-only guard would have let the webhook through.
    ;(payload.comment as Record<string, unknown>).user = { login: 'typeclaw-bot', id: 12345, type: 'Bot' }
    await handler(signedRequest(JSON.stringify(payload), 'issue_comment', 'self-by-login'))
    expect(routed).toHaveLength(0)
  })

  it('drops pull_request_review_comment authored by self (matched by login)', async () => {
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed)
    const payload = reviewCommentPayload()
    ;(payload.comment as Record<string, unknown>).user = { login: 'typeclaw-bot', id: 54321, type: 'Bot' }
    await handler(signedRequest(JSON.stringify(payload), 'pull_request_review_comment', 'self-review-by-login'))
    expect(routed).toHaveLength(0)
  })

  it('drops issues.opened authored by self (matched by login)', async () => {
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed)
    const payload = {
      action: 'opened',
      repository: repo(),
      issue: {
        number: 11,
        id: 1100,
        body: 'opened by the bot',
        created_at: '2026-01-01T00:00:00Z',
        user: { login: 'typeclaw-bot', id: 12345, type: 'Bot' },
      },
    }
    await handler(signedRequest(JSON.stringify(payload), 'issues', 'self-issue-by-login'))
    expect(routed).toHaveLength(0)
  })

  it('routes issue_comment from a different author when neither id nor login matches', async () => {
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed)
    const body = JSON.stringify(issueCommentPayload({ pullRequest: false }))
    await handler(signedRequest(body, 'issue_comment', 'other-author'))
    expect(routed).toHaveLength(1)
    expect(routed[0]?.authorName).toBe('alice')
  })

  it('still drops by login when selfId is null (e.g. id getter not yet resolved)', async () => {
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed, { selfId: null })
    const payload = issueCommentPayload({ pullRequest: false })
    ;(payload.comment as Record<string, unknown>).user = { login: 'typeclaw-bot', id: 99, type: 'Bot' }
    await handler(signedRequest(JSON.stringify(payload), 'issue_comment', 'self-id-null'))
    expect(routed).toHaveLength(0)
  })

  it('drops pull_request_review authored by self even when the PR was opened by someone else', async () => {
    // Regression for PR #460: the bot submits a review on alice's PR. The
    // payload's `pull_request.user` is alice, but `review.user` is the bot.
    // The drop must read the review author, not the PR author, or the bot
    // wakes a session on its own review and loops.
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed, {
      allowlist: ['pull_request_review.submitted'],
    })
    const payload = {
      action: 'submitted',
      repository: repo(),
      pull_request: { number: 7, id: 700, user: { login: 'alice', id: 10, type: 'User' } },
      review: {
        id: 5001,
        body: 'looks good',
        submitted_at: '2026-01-01T00:00:00Z',
        user: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
      },
    }
    await handler(signedRequest(JSON.stringify(payload), 'pull_request_review', 'self-review-submitted'))
    expect(routed).toHaveLength(0)
  })

  it('routes a pull_request_review from another reviewer on the bot-authored PR', async () => {
    // Guard against over-dropping: the inverse case must still wake the bot.
    // alice reviews the bot's PR — `pull_request.user` is the bot, but the
    // review author is alice, so the event must route.
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed, {
      allowlist: ['pull_request_review.submitted'],
    })
    const payload = {
      action: 'submitted',
      repository: repo(),
      pull_request: { number: 7, id: 700, user: { login: 'typeclaw-bot', id: 99, type: 'Bot' } },
      review: { id: 5002, body: 'please fix', submitted_at: '2026-01-01T00:00:00Z', user: user() },
    }
    await handler(signedRequest(JSON.stringify(payload), 'pull_request_review', 'other-review-submitted'))
    expect(routed).toHaveLength(1)
    expect(routed[0]?.authorName).toBe('alice')
  })

  it('drops self-authored events with no enumerated entity via the sender fallback', async () => {
    const drops: string[] = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['commit_comment'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      logger: { ...logger, info: (m) => drops.push(m) },
      route: (msg) => {
        routedSink.push(msg)
      },
    })
    const routedSink: InboundMessage[] = []
    const payload = {
      action: 'created',
      repository: repo(),
      sender: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
    }
    await handler(signedRequest(JSON.stringify(payload), 'commit_comment', 'self-sender-fallback'))
    expect(routedSink).toHaveLength(0)
    expect(drops.some((m) => m.includes('dropped self-authored'))).toBe(true)
  })

  it('drops self-authored events for an unknown event type via the sender fallback', async () => {
    const drops: string[] = []
    const routedSink: InboundMessage[] = []
    const handler = createGithubWebhookHandler({
      webhookSecret: 'secret',
      dedup: createDeliveryDedup(),
      allowlist: () => ['some_future_event'],
      selfId: () => '99',
      selfLogin: () => 'typeclaw-bot',
      logger: { ...logger, info: (m) => drops.push(m) },
      route: (msg) => {
        routedSink.push(msg)
      },
    })
    const payload = {
      action: 'created',
      repository: repo(),
      sender: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
    }
    await handler(signedRequest(JSON.stringify(payload), 'some_future_event', 'self-unknown-event'))
    expect(routedSink).toHaveLength(0)
    expect(drops.some((m) => m.includes('dropped self-authored'))).toBe(true)
  })

  it('routes a pull_request action from a human on a bot-opened PR', async () => {
    // Regression for the over-drop on `pull_request` events: PR #462 resolved
    // the author from `pull_request.user` (the OPENER), so a human action on a
    // bot-opened PR matched the bot by login and was wrongly dropped — the
    // comment landed as awareness-only "Recent context" and the agent never
    // replied. The self-author identity for a `pull_request` action is the
    // ACTOR (`sender`), not the opener.
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed, {
      allowlist: ['pull_request.review_requested'],
    })
    const payload = {
      action: 'review_requested',
      repository: repo(),
      sender: { login: 'alice', id: 10, type: 'User' },
      requested_reviewer: { login: 'typeclaw-bot', id: 99, type: 'User' },
      pull_request: {
        number: 7,
        id: 700,
        title: 'Add feature',
        user: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
        head: { ref: 'feat-branch' },
        base: { ref: 'main' },
      },
    }
    await handler(signedRequest(JSON.stringify(payload), 'pull_request', 'human-action-bot-pr'))
    expect(routed).toHaveLength(1)
    expect(routed[0]?.authorName).toBe('alice')
  })

  it('drops a pull_request action the bot itself triggered on its own PR', async () => {
    // Self-loop guard must still fire: the bot requesting a review on its own
    // PR is `sender = bot`, and that delivery must not wake a session.
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed, {
      allowlist: ['pull_request.review_requested'],
    })
    const payload = {
      action: 'review_requested',
      repository: repo(),
      sender: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
      requested_reviewer: { login: 'someone-else', id: 20, type: 'User' },
      pull_request: {
        number: 7,
        id: 700,
        title: 'Add feature',
        user: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
        head: { ref: 'feat-branch' },
        base: { ref: 'main' },
      },
    }
    await handler(signedRequest(JSON.stringify(payload), 'pull_request', 'bot-action-own-pr'))
    expect(routed).toHaveLength(0)
  })

  it('drops a pull_request_review_thread the bot itself resolved', async () => {
    // pull_request_review_thread carries only the `pull_request` container
    // (opener), so the self-author identity must come from `sender`. A bot
    // resolving its own review thread must not wake a session.
    const routed: InboundMessage[] = []
    const handler = selfAuthoredHandler(routed, {
      allowlist: ['pull_request_review_thread.resolved'],
    })
    const payload = {
      action: 'resolved',
      repository: repo(),
      sender: { login: 'typeclaw-bot', id: 99, type: 'Bot' },
      pull_request: { number: 7, id: 700, user: { login: 'alice', id: 10, type: 'User' } },
      thread: { id: 333 },
    }
    await handler(signedRequest(JSON.stringify(payload), 'pull_request_review_thread', 'bot-thread-resolved'))
    expect(routed).toHaveLength(0)
  })
})

function signedRequest(body: string, event: string, delivery: string): Request {
  const sig = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
  return new Request('https://example.com/github', {
    method: 'POST',
    headers: {
      'x-hub-signature-256': sig,
      'x-github-event': event,
      'x-github-delivery': delivery,
    },
    body,
  })
}

function repo(): Record<string, unknown> {
  return { name: 'project', owner: { login: 'acme' } }
}

function user(): Record<string, unknown> {
  return { login: 'alice', id: 10, type: 'User' }
}

function issueCommentPayload(options: { pullRequest: boolean }): Record<string, unknown> {
  return {
    action: 'created',
    repository: repo(),
    issue: { number: 7, ...(options.pullRequest ? { pull_request: {} } : {}) },
    comment: { id: 99, body: '@typeclaw-bot hello', created_at: '2026-01-01T00:00:00Z', user: user() },
  }
}

function reviewCommentPayload(): Record<string, unknown> {
  return {
    action: 'created',
    repository: repo(),
    pull_request: { number: 7 },
    comment: { id: 102, in_reply_to_id: 101, body: 'review', created_at: '2026-01-01T00:00:00Z', user: user() },
  }
}

function pullRequestForReview(updatedAt: string): Record<string, unknown> {
  return {
    number: 7,
    id: 700,
    title: 'Add the thing',
    updated_at: updatedAt,
    head: { ref: 'feat-branch' },
    base: { ref: 'main' },
    user: user(),
  }
}

function openedPayload(options: { updatedAt?: string } = {}): Record<string, unknown> {
  return {
    action: 'opened',
    repository: repo(),
    pull_request: pullRequestForReview(options.updatedAt ?? '2026-01-01T00:00:00Z'),
    sender: { login: 'alice', id: 10, type: 'User' },
  }
}

function reviewRequestedPayload(options: { reviewerLogin: string; updatedAt?: string }): Record<string, unknown> {
  return {
    action: 'review_requested',
    repository: repo(),
    pull_request: pullRequestForReview(options.updatedAt ?? '2026-01-01T00:00:00Z'),
    requested_reviewer: { login: options.reviewerLogin, id: 42, type: 'User' },
    sender: { login: 'alice', id: 10, type: 'User' },
  }
}

function reviewRequestRemovedPayload(options: { reviewerLogin: string; updatedAt?: string }): Record<string, unknown> {
  return {
    action: 'review_request_removed',
    repository: repo(),
    pull_request: pullRequestForReview(options.updatedAt ?? '2026-01-01T00:01:00Z'),
    requested_reviewer: { login: options.reviewerLogin, id: 42, type: 'User' },
    sender: { login: 'alice', id: 10, type: 'User' },
  }
}

function reviewRequestedTeamPayload(): Record<string, unknown> {
  return {
    action: 'review_requested',
    repository: repo(),
    pull_request: pullRequestForReview('2026-01-01T00:00:00Z'),
    requested_team: { slug: 'reviewers', id: 5000 },
    sender: { login: 'alice', id: 10, type: 'User' },
  }
}

function assignedPayload(options: { assigneeLogin: string; updatedAt?: string }): Record<string, unknown> {
  return {
    action: 'assigned',
    repository: repo(),
    pull_request: pullRequestForReview(options.updatedAt ?? '2026-01-01T00:00:00Z'),
    assignee: { login: options.assigneeLogin, id: 42, type: 'User' },
    sender: { login: 'alice', id: 10, type: 'User' },
  }
}
