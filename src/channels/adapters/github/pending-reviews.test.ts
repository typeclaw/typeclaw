import { afterEach, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionManager } from '@earendil-works/pi-coding-agent'

import { createSessionWithDispose } from '@/agent'
import { recordVerifiedDismissal } from '@/channels/github-review-turn-ledger'
import { createRecoveryNotice } from '@/channels/recovery-notice'
import { createChannelRouter } from '@/channels/router'
import { DEFAULT_GITHUB_EVENT_ALLOWLIST, defaultHistoryConfig, type GithubAdapterConfig } from '@/channels/schema'
import type { InboundMessage, RouteReceipt } from '@/channels/types'
import { noopPermissionService } from '@/permissions'

import { createGithubAdapter } from './index'
import { loadPendingReviewStore, type PendingReview } from './pending-review-store'
import { loadReconcileCooldownStore } from './reconcile-cooldown-store'
import { completePendingReview, reconcileOpenPrs, replayPendingReviews } from './reconcile-open-prs'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const pending: PendingReview = {
  repo: 'acme/widgets',
  prNumber: 7,
  prId: 700,
  kind: 'review',
  headSha: 'head-one',
  admittedAt: 1,
  authorId: '10',
  authorName: 'alice',
  authorIsBot: false,
}
const logger = { info: () => {}, warn: () => {}, error: () => {} }
const pull = {
  id: 700,
  number: 7,
  title: 'A change',
  state: 'open',
  draft: false,
  user: { login: 'alice', id: 10, type: 'User' },
  head: { sha: 'head-one', ref: 'feature' },
  base: { ref: 'main' },
  created_at: '2020-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

// Passing an existing dir starts the next process on the same agent folder.
async function fixture(existingDir?: string, options: { prompt?: () => Promise<void> } = {}) {
  const dir = existingDir ?? (await mkdtemp(join(tmpdir(), 'github-pending-reviews-')))
  const store = await loadPendingReviewStore(dir, logger)
  const calls: string[] = []
  const reviews: Array<Record<string, unknown>> = []
  const timeline: Array<Record<string, unknown>> = []
  const allowedAuthors = new Set<string>()
  const scanRead = Promise.withResolvers<void>()
  const currentPull = { ...pull }
  let comparison = 'behind'
  let fetchWaiters: Array<{ match: (url: string) => boolean; resolve: () => void }> = []
  let fetchHolds: Array<{ match: (url: string) => boolean; reached: () => void; released: Promise<void> }> = []
  const fetchImpl = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      for (const waiter of fetchWaiters) if (waiter.match(url)) waiter.resolve()
      fetchWaiters = fetchWaiters.filter((waiter) => !waiter.match(url))
      const hold = fetchHolds.find((candidate) => candidate.match(url))
      if (hold !== undefined) {
        fetchHolds = fetchHolds.filter((candidate) => candidate !== hold)
        hold.reached()
        await hold.released
      }
      if (url.endsWith('/user')) return Response.json({ login: 'bot', id: 1 })
      if (url.includes('/timeline?')) return Response.json(timeline)
      if (url.includes('/compare/')) return Response.json({ status: comparison })
      if (url.endsWith('/reviews/123')) return Response.json({ id: 123, state: 'COMMENTED' })
      if (url.endsWith('/reviews') && init?.method === 'POST') return Response.json({ id: 123 })
      if (url.includes('/reviews?')) {
        const response = Response.json(reviews)
        if (url.includes('/pulls/8/')) scanRead.resolve()
        return response
      }
      if (url.includes('/files?')) return Response.json([])
      if (url.endsWith('/pulls/7')) return Response.json(currentPull)
      if (url.includes('/pulls?')) return Response.json([pull, { ...pull, id: 800, number: 8 }])
      if (url.endsWith('/graphql'))
        return Response.json({
          data: {
            repository: {
              pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
            },
          },
        })
      throw new Error(`Unexpected request: ${url}`)
    },
    { preconnect: () => {} },
  )
  const config: GithubAdapterConfig & {
    enabled: boolean
    engagement: { trigger: Array<'mention'>; stickiness: 'off' }
    history: ReturnType<typeof defaultHistoryConfig>
  } = {
    enabled: true,
    engagement: { trigger: ['mention'], stickiness: 'off' },
    history: defaultHistoryConfig(),
    repos: ['acme/widgets'],
    eventAllowlist: [...DEFAULT_GITHUB_EVENT_ALLOWLIST],
    webhookPort: 0,
    review: { on: 'opened', approve: true, check: false },
  }
  const router = createChannelRouter({
    agentDir: dir,
    configForAdapter: () => config,
    logger,
    permissions: {
      ...noopPermissionService,
      has: (origin, permission) =>
        permission !== 'channel.respond' ||
        allowedAuthors.size === 0 ||
        (origin?.kind === 'channel' && allowedAuthors.has(origin.lastInboundAuthorId ?? '')),
    },
    createSessionForChannel: async () => {
      const session = await createSessionWithDispose({
        sessionManager: SessionManager.create(dir, join(dir, 'sessions')),
        systemPromptOverride: 'Use channel tools.',
        tools: [],
        customTools: [],
      })
      session.session.prompt = options.prompt ?? (async () => {})
      return { ...session, sessionId: session.session.sessionId }
    },
  })
  const routed: InboundMessage[] = []
  let routeSignal = Promise.withResolvers<RouteReceipt>()
  const route = router.route.bind(router)
  router.route = async (message, onAdmitted) => {
    const receipt = await route(message, onAdmitted)
    routed.push(message)
    routeSignal.resolve(receipt)
    return receipt
  }
  let handler: ((req: Request) => Promise<Response>) | undefined
  const adapter = createGithubAdapter({
    router,
    agentDir: dir,
    configRef: () => config,
    logger,
    fetchImpl,
    secrets: { auth: { type: 'pat', token: { value: 'test-token' } }, webhookSecret: { value: 'test-secret' } },
    httpListenImpl: (_port, callback) => {
      handler = callback
      return { stop: async () => {} }
    },
    tokenRefreshIntervalMs: 0,
    deliveryRecoveryIntervalMs: 0,
    reconcileIntervalMs: 0,
    webhookRegistrationDelayMs: 0,
  })
  cleanups.push(async () => {
    await adapter.stop()
    await router.stop()
    await rm(dir, { recursive: true, force: true })
  })
  return {
    dir,
    store,
    router,
    adapter,
    config,
    fetchImpl,
    calls,
    reviews,
    timeline,
    allowedAuthors,
    scanRead: scanRead.promise,
    pull: currentPull,
    routed,
    setComparison: (status: string) => {
      comparison = status
    },
    nextRoute: () => {
      routeSignal = Promise.withResolvers<RouteReceipt>()
      return routeSignal.promise
    },
    nextFetch: (match: (url: string) => boolean) => {
      const signal = Promise.withResolvers<void>()
      fetchWaiters.push({ match, resolve: signal.resolve })
      return signal.promise
    },
    holdFetch: (match: (url: string) => boolean) => {
      const reached = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      fetchHolds.push({ match, reached: reached.resolve, released: released.promise })
      return { reached: reached.promise, release: released.resolve }
    },
    deliver: async (action: string, event = 'pull_request', extra: Record<string, unknown> = {}) => {
      if (handler === undefined) throw new Error('Adapter not listening')
      const body = JSON.stringify({
        action,
        repository: { name: 'widgets', owner: { login: 'acme' } },
        pull_request: pull,
        sender: { login: 'alice', id: 10, type: 'User' },
        ...extra,
      })
      return handler(
        new Request('https://example.com/github', {
          method: 'POST',
          body,
          headers: {
            'x-github-event': event,
            'x-github-delivery': `${event}-${action}`,
            'x-hub-signature-256': `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`,
          },
        }),
      )
    },
  }
}

test.each(['opened', 'ready_for_review', 'review_requested'])('logs an admitted live %s trigger', async (action) => {
  const f = await fixture()
  await f.adapter.start()
  const admitted = f.nextRoute()
  await f.deliver(action, 'pull_request', { requested_reviewer: { login: 'bot', id: 1, type: 'User' } })
  expect((await admitted).kind).toBe('accepted')
  expect(f.routed[0]?.eventKind).toBe(`pull_request:${action}`)
  expect(await f.store.list()).toMatchObject([
    { repo: pending.repo, prId: 700, prNumber: 7, kind: 'review', headSha: 'head-one' },
  ])
})

test('logs an admitted synchronize blocking re-review', async () => {
  const f = await fixture()
  await f.adapter.start()
  // The boot scan must finish reading its non-blocking snapshot before the
  // live push introduces a blocking review. Neither path wins by timing luck.
  await f.scanRead
  f.reviews.push({ id: 5, state: 'CHANGES_REQUESTED', commit_id: 'old-head', user: { login: 'bot', type: 'User' } })
  const admitted = f.nextRoute()
  await f.deliver('synchronize')
  expect((await admitted).kind).toBe('accepted')
  expect(f.routed[0]?.eventKind).toBe('pull_request:synchronize:review-followup')
  expect(await f.store.list()).toMatchObject([{ kind: 'rereview', headSha: 'head-one', prId: 700 }])
})

test('a permitted requester on an external contributor PR replays under the admitted requester', async () => {
  const f = await fixture()
  f.allowedAuthors.add('20')
  f.config.review.on = 'review_requested'
  await f.adapter.start()
  let admitted = f.nextRoute()
  await f.deliver('review_requested', 'pull_request', {
    sender: { id: 20, login: 'maintainer', type: 'User' },
    requested_reviewer: { login: 'bot', id: 1, type: 'User' },
  })
  expect((await admitted).kind).toBe('accepted')
  expect(await f.store.list()).toMatchObject([{ authorId: '20', authorName: 'maintainer', authorIsBot: false }])
  await f.adapter.stop()
  await f.router.stop()
  const next = await fixture(f.dir)
  next.allowedAuthors.add('20')
  next.config.review.on = 'review_requested'
  admitted = next.nextRoute()
  await next.adapter.start()
  expect((await admitted).kind).toBe('accepted')
  expect(next.routed.at(-1)).toMatchObject({ authorId: '20', authorName: 'maintainer', authorIsBot: false })
})

test('an adapter restart in the same process does not replay pending work it already re-admitted', async () => {
  const f = await fixture()
  await f.store.record(pending)
  const admitted = f.nextRoute()
  await f.adapter.start()
  expect((await admitted).kind).toBe('accepted')
  await f.scanRead
  await f.adapter.stop()
  // The reconcile scan lists open PRs only after the pending replay pass settles.
  const rescanned = f.nextFetch((url) => url.includes('/pulls?'))
  await f.adapter.start()
  await rescanned
  expect(f.routed.map((message) => message.chat)).toEqual(['pr:7'])
})

test('a redelivered trigger from a dead process does not suppress its boot replay', async () => {
  // given a review the previous process admitted and never finished
  const turn = Promise.withResolvers<void>()
  const f = await fixture(undefined, { prompt: () => turn.promise })
  cleanups.push(async () => turn.resolve())
  await f.adapter.start()
  await f.scanRead
  let admitted = f.nextRoute()
  await f.deliver('opened')
  expect((await admitted).kind).toBe('accepted')
  await f.adapter.stop()
  await f.router.stop()

  // when the next process gets GitHub's redelivery before its boot replay runs
  const next = await fixture(f.dir)
  next.config.webhookUrl = 'https://example.com/hook'
  const registering = next.holdFetch((url) => url.includes('/hooks'))
  const starting = next.adapter.start()
  await registering.reached
  admitted = next.nextRoute()
  await next.deliver('opened')
  expect((await admitted).kind).toBe('duplicate')
  const replayed = next.nextRoute()
  registering.release()
  await starting

  // then the boot replay still re-admits the interrupted review
  expect((await replayed).kind).toBe('accepted')
  expect(next.routed.at(-1)?.eventKind).toBe('pull_request:reconcile')
})

test('an adapter restart in the same process leaves a live admission to its running turn', async () => {
  const f = await fixture()
  await f.adapter.start()
  await f.scanRead
  const admitted = f.nextRoute()
  await f.deliver('opened')
  expect((await admitted).kind).toBe('accepted')
  await f.adapter.stop()
  const rescanned = f.nextFetch((url) => url.includes('/pulls?'))
  await f.adapter.start()
  await rescanned
  expect(f.routed.map((message) => message.eventKind)).toEqual(['pull_request:opened'])
})

test('replay rechecks permissions and does not authorize the unpermitted PR author', async () => {
  const f = await fixture()
  f.allowedAuthors.add('20')
  await f.store.record(pending)
  const admitted = f.nextRoute()
  await f.adapter.start()
  expect((await admitted).kind).toBe('denied')
  expect(await f.store.list()).toEqual([pending])
})

test('a permitted PR author cannot replace a requester whose permission was revoked', async () => {
  const f = await fixture()
  f.allowedAuthors.add('10')
  const requested = { ...pending, authorId: '20', authorName: 'maintainer' }
  await f.store.record(requested)
  const admitted = f.nextRoute()
  await f.adapter.start()
  expect((await admitted).kind).toBe('denied')
  expect(await f.store.list()).toEqual([requested])
})

test('verified dismissal completes only the matching pending re-review', async () => {
  const f = await fixture()
  f.config.review.approve = false
  await f.adapter.start()
  await f.store.record({ ...pending, kind: 'rereview' })
  const dismissal = {
    sessionId: 'review-session',
    workspace: pending.repo,
    prNumber: 7,
    commitSha: pending.headSha,
    startedAt: 100,
  }
  await recordVerifiedDismissal(dismissal)
  expect(await f.store.list()).toEqual([])
})

test.each(['new-head', 'new-admission'] as const)('verified dismissal preserves a %s obligation', async (change) => {
  const f = await fixture()
  await f.adapter.start()
  const newer = {
    ...pending,
    kind: 'rereview' as const,
    headSha: change === 'new-head' ? 'head-two' : pending.headSha,
    admittedAt: 200,
  }
  await f.store.record(newer)
  const dismissal = {
    sessionId: 'review-session',
    workspace: pending.repo,
    prNumber: 7,
    commitSha: pending.headSha,
    startedAt: 100,
  }
  await recordVerifiedDismissal(dismissal)
  expect(await f.store.list()).toEqual([newer])
})

test.each([
  ['2026-01-03T00:00:00Z', 'DISMISSED', true],
  ['2026-01-01T00:00:00Z', 'DISMISSED', false],
  ['2026-01-03T00:00:00Z', 'CHANGES_REQUESTED', false],
] as const)(
  'boot only retires the latest decisive dismissal after the obligation (%s, %s)',
  async (dismissedAt, latest, done) => {
    const f = await fixture()
    await f.store.record({ ...pending, kind: 'rereview', admittedAt: Date.parse('2026-01-02T00:00:00Z') })
    f.reviews.push({
      id: 5,
      state: 'DISMISSED',
      commit_id: 'old-head',
      submitted_at: '2026-01-01T00:00:00Z',
      user: { login: 'bot', type: 'User' },
    })
    if (latest === 'CHANGES_REQUESTED')
      f.reviews.push({
        id: 6,
        state: latest,
        commit_id: 'old-head',
        submitted_at: '2026-01-01T01:00:00Z',
        user: { login: 'bot', type: 'User' },
      })
    f.timeline.push({ event: 'review_dismissed', created_at: dismissedAt, dismissed_review: { review_id: 5 } })
    const replays: InboundMessage[] = []
    await replayPendingReviews({
      repos: [pending.repo],
      reviewOn: 'review_requested',
      selfLogin: 'bot',
      authType: 'pat',
      token: async () => 'test-token',
      fetchImpl: f.fetchImpl,
      logger,
      pendingStore: f.store,
      replayId: 'test-boot',
      route: async (message) => {
        replays.push(message)
        return { kind: 'observed' }
      },
    })
    expect(replays).toHaveLength(done ? 0 : 1)
    expect(await f.store.list()).toHaveLength(done ? 0 : 1)
  },
)

test.each(['closed', 'converted_to_draft'])('clears pending work on %s, even without a live turn', async (action) => {
  const f = await fixture()
  await f.adapter.start()
  await f.store.record(pending)
  await f.deliver(action)
  expect(await f.store.list()).toEqual([])
})

test('clears pending work when the review request for the bot is removed', async () => {
  const f = await fixture()
  await f.adapter.start()
  await f.store.record(pending)
  await f.deliver('review_request_removed', 'pull_request', {
    requested_reviewer: { login: 'bot', id: 1, type: 'User' },
  })
  expect(await f.store.list()).toEqual([])
})

test('keeps pending work when another reviewer is removed', async () => {
  const f = await fixture()
  await f.adapter.start()
  await f.store.record(pending)
  await f.deliver('review_request_removed', 'pull_request', {
    requested_reviewer: { login: 'other-reviewer', id: 2, type: 'User' },
  })
  expect(await f.store.list()).toEqual([pending])
})

test('clears pending work through the registered review submitter before it returns', async () => {
  const f = await fixture()
  await f.adapter.start()
  await f.store.record(pending)
  const result = await f.router.submitReview({
    adapter: 'github',
    workspace: 'acme/widgets',
    chat: 'pr:7',
    event: 'COMMENT',
    body: 'Reviewed',
    comments: [],
  })
  expect(result.ok).toBe(true)
  expect(await f.store.list()).toEqual([])
})

test.each(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'])(
  'clears pending work on the bot submitted %s webhook outside the conversational allowlist',
  async (state) => {
    const f = await fixture()
    await f.adapter.start()
    await f.store.record(pending)
    f.config.eventAllowlist = []
    await f.deliver('submitted', 'pull_request_review', {
      review: {
        id: 123,
        state,
        commit_id: 'head-one',
        submitted_at: '2026-01-01T00:00:00Z',
        user: { login: 'bot', id: 1, type: 'User' },
      },
    })
    expect(await f.store.list()).toEqual([])
    expect(f.routed).toEqual([])
  },
)

test('older-head completion preserves pending work while a descendant review clears it', async () => {
  const f = await fixture()
  await f.store.record(pending)
  const submitted = { repo: pending.repo, prNumber: 7, headSha: 'different-head', submittedAt: 100 }
  await completePendingReview(f.store, submitted, async () => 'test-token', f.fetchImpl)
  expect(await f.store.list()).toEqual([pending])
  f.setComparison('ahead')
  await completePendingReview(f.store, submitted, async () => 'test-token', f.fetchImpl)
  expect(await f.store.list()).toEqual([])
})

test.each(['review', 'rereview'] as const)(
  'boot retries a logged old %s despite cooldown, but not unlogged backlog, without a restart notice',
  async (kind) => {
    const f = await fixture()
    await f.store.record({ ...pending, kind })
    const cooldown = await loadReconcileCooldownStore(f.dir, logger)
    await cooldown.markReplayed(pending.repo, pending.prId, { now: Date.now(), cooldownMs: 86_400_000 })
    let admitted = f.nextRoute()
    await f.adapter.start()
    expect((await admitted).kind).toBe('accepted')
    const first = f.routed[0]
    await f.adapter.stop()
    await f.router.stop()
    const next = await fixture(f.dir)
    admitted = next.nextRoute()
    await next.adapter.start()
    expect((await admitted).kind).toBe('accepted')
    expect(next.routed.map((m) => m.chat)).toEqual(['pr:7'])
    expect(next.routed[0]?.externalMessageId).not.toBe(first?.externalMessageId)
    if (kind === 'rereview')
      expect(next.routed[0]?.githubReviewRound).toMatchObject({ kind: 'push', headSha: 'head-one' })
    const scanRoutes: string[] = []
    await reconcileOpenPrs({
      repos: [pending.repo],
      reviewOn: 'opened',
      selfLogin: 'bot',
      authType: 'pat',
      token: async () => 'test-token',
      fetchImpl: f.fetchImpl,
      logger,
      pendingStore: f.store,
      createdSince: Date.now(),
      includeHeldReviews: true,
      route: async (message) => {
        scanRoutes.push(message.chat)
        return { kind: 'observed' }
      },
    })
    expect(scanRoutes).toEqual([])
    const notice = createRecoveryNotice({
      target: { adapter: 'github', workspace: pending.repo, chat: 'pr:7', thread: null },
      accountIdentity: 'github:1',
      principal: { kind: 'channel', adapter: 'github', workspace: pending.repo, chat: 'pr:7' },
      covers: [{ store: 'inbound', id: 'test-input', generation: 1 }],
      recoveryGeneration: 'boot',
      transferId: 'test',
    })
    expect(next.router.recoveryRedelivery?.(notice, ['pull_request:synchronize:review-followup'])).toBe('redelivered')
    expect(next.router.recoveryRedelivery?.(notice, ['pull_request:reconcile:rereview'])).toBe('redelivered')
    expect(next.router.recoveryRedelivery?.(notice, ['issue_comment:created'])).toBe('not-redelivered')
  },
)

test.each(['closed', 'draft'])('boot drops a logged PR that is now %s', async (status) => {
  const f = await fixture()
  await f.store.record(pending)
  f.pull.state = status === 'closed' ? 'closed' : 'open'
  f.pull.draft = status === 'draft'
  await replayPendingReviews({
    repos: [pending.repo],
    reviewOn: 'opened',
    selfLogin: 'bot',
    authType: 'pat',
    token: async () => 'test-token',
    fetchImpl: f.fetchImpl,
    logger,
    pendingStore: f.store,
    replayId: 'test-boot',
    route: async () => {
      throw new Error('Closed or draft work must not replay')
    },
  })
  expect(await f.store.list()).toEqual([])
})

test('boot drops work already reviewed remotely without replaying it', async () => {
  const f = await fixture()
  await f.store.record(pending)
  f.reviews.push({
    state: 'COMMENTED',
    commit_id: pending.headSha,
    submitted_at: '2026-01-01T00:00:00Z',
    user: { login: 'bot', type: 'User' },
  })
  await replayPendingReviews({
    repos: [pending.repo],
    reviewOn: 'opened',
    selfLogin: 'bot',
    authType: 'pat',
    token: async () => 'test-token',
    fetchImpl: f.fetchImpl,
    logger,
    pendingStore: f.store,
    replayId: 'test-boot',
    route: async () => {
      throw new Error('Completed work must not replay')
    },
  })
  expect(await f.store.list()).toEqual([])
})
