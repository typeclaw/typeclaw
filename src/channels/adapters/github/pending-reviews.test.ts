import { afterEach, expect, test } from 'bun:test'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionManager } from '@earendil-works/pi-coding-agent'

import { createSessionWithDispose } from '@/agent'
import { githubReviewChecks } from '@/channels/github-review-check'
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
async function fixture(
  existingDir?: string,
  options: {
    prompt?: () => Promise<void>
    recoveredRemoval?: Record<string, unknown>
    recoveredDelivery?: Record<string, unknown>
    app?: true
  } = {},
) {
  const dir = existingDir ?? (await mkdtemp(join(tmpdir(), 'github-pending-reviews-')))
  const store = await loadPendingReviewStore(dir, logger)
  const calls: string[] = []
  const statuses: Array<Record<string, unknown>> = []
  const reviews: Array<Record<string, unknown>> = []
  const timeline: Array<Record<string, unknown>> = []
  const allowedAuthors = new Set<string>()
  const scanRead = Promise.withResolvers<void>()
  let recoveryFinished = Promise.withResolvers<void>()
  let recoveryTick: (() => void) | undefined
  const currentPull = { ...pull, assignees: [] as Array<{ login: string; id: number; type: string }> }
  const requestedReviewers = {
    users: [] as Array<{ login: string; id: number; type: string }>,
    teams: [] as Array<{ slug: string; id?: number }>,
  }
  const teamMemberships = new Map<string, string>()
  let pullFailure: (() => Response) | undefined
  let requestedReviewersFailure: (() => Response) | undefined
  let teamMembershipFailure: (() => Response) | undefined
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
      if (url.endsWith('/app')) return Response.json({ slug: 'bot' })
      if (url.endsWith('/users/bot%5Bbot%5D')) return Response.json({ login: 'bot[bot]', id: 1 })
      if (url.endsWith('/installation')) return Response.json({ id: 1 })
      if (url.endsWith('/app/installations/1'))
        return Response.json({ permissions: { pull_requests: 'write' }, events: ['pull_request'] })
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'test-installation-token' })
      if (url.endsWith('/hooks') && init?.method === 'POST') return Response.json({ id: 1 })
      if (url.includes('/hooks?')) return Response.json([])
      if (url.endsWith('/hooks/1') && init?.method === 'DELETE') return new Response(null, { status: 204 })
      if (url.includes('/hooks/1/deliveries?'))
        return Response.json([
          {
            id: 11,
            guid: 'old-removal',
            event: 'pull_request',
            status_code: 502,
            delivered_at: new Date().toISOString(),
          },
        ])
      if (url.endsWith('/hooks/1/deliveries/11'))
        return Response.json({ request: { payload: options.recoveredDelivery ?? options.recoveredRemoval } })
      if (url.endsWith('/requested_reviewers'))
        return requestedReviewersFailure?.() ?? Response.json(requestedReviewers)
      if (url.includes('/memberships/')) {
        if (teamMembershipFailure !== undefined) return teamMembershipFailure()
        const state = teamMemberships.get(url.split('/teams/')[1]!.split('/')[0]!)
        return state === undefined ? new Response(null, { status: 404 }) : Response.json({ state })
      }
      if (url.includes('/statuses/') && init?.method === 'POST') {
        statuses.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return Response.json({})
      }
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
      if (url.endsWith('/pulls/7')) return pullFailure?.() ?? Response.json(currentPull)
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
  const routeAttempts: InboundMessage[] = []
  const routeTasks: Promise<RouteReceipt>[] = []
  let routeSignal = Promise.withResolvers<RouteReceipt>()
  const route = router.route.bind(router)
  router.route = async (message, onAdmitted) => {
    routeAttempts.push(message)
    const task = route(message, onAdmitted)
    routeTasks.push(task)
    const receipt = await task
    routed.push(message)
    routeSignal.resolve(receipt)
    return receipt
  }
  let handler: ((req: Request) => Promise<Response>) | undefined
  let deliveryId = 0
  const adapter = createGithubAdapter({
    router,
    agentDir: dir,
    configRef: () => config,
    logger: {
      ...logger,
      info: (message) => {
        if (message.includes('recovered 1 missed delivery')) recoveryFinished.resolve()
      },
      warn: (message) => {
        if (message.includes('delivery recovery failed')) recoveryFinished.resolve()
      },
    },
    fetchImpl,
    secrets: {
      auth: options.app
        ? {
            type: 'app',
            appId: 1,
            privateKey: {
              value: generateKeyPairSync('rsa', { modulusLength: 2048 })
                .privateKey.export({ type: 'pkcs8', format: 'pem' })
                .toString(),
            },
          }
        : { type: 'pat', token: { value: 'test-token' } },
      webhookSecret: { value: 'test-secret' },
    },
    httpListenImpl: (_port, callback) => {
      handler = callback
      return { stop: async () => {} }
    },
    tokenRefreshIntervalMs: 0,
    deliveryRecoveryIntervalMs:
      options.recoveredRemoval === undefined && options.recoveredDelivery === undefined ? 0 : 1,
    setInterval: (callback) => {
      recoveryTick = callback
      return { clear: () => {} }
    },
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
    statuses,
    reviews,
    timeline,
    allowedAuthors,
    scanRead: scanRead.promise,
    pull: currentPull,
    requestedReviewers,
    teamMemberships,
    failTeamMembership: (failure?: () => Response) => {
      teamMembershipFailure = failure
    },
    failPull: (failure?: () => Response) => {
      pullFailure = failure
    },
    failRequestedReviewers: (failure?: () => Response) => {
      requestedReviewersFailure = failure
    },
    routed,
    routeAttempts,
    recoverRemoval: async () => {
      if (recoveryTick === undefined) throw new Error('Recovery not configured')
      recoveryFinished = Promise.withResolvers<void>()
      recoveryTick()
      await recoveryFinished.promise
      await Promise.allSettled(routeTasks)
    },
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
    deliver: async (action: string, event = 'pull_request', extra: Record<string, unknown> = {}, delivery?: string) => {
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
            'x-github-delivery': delivery ?? `${event}-${action}-${++deliveryId}`,
            'x-hub-signature-256': `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`,
          },
        }),
      )
    },
  }
}

test.each(['opened', 'ready_for_review', 'review_requested', 'assigned'])(
  'logs an admitted live %s trigger',
  async (action) => {
    // #given
    const f = await fixture()
    await f.adapter.start()
    const admitted = f.nextRoute()
    const target = { login: 'bot', id: 1, type: 'User' }

    // #when
    await f.deliver(
      action,
      'pull_request',
      action === 'assigned' ? { assignee: target } : { requested_reviewer: target },
    )

    // #then
    expect((await admitted).kind).toBe('accepted')
    expect(f.routed[0]?.eventKind).toBe(`pull_request:${action}`)
    expect(await f.store.list()).toMatchObject([
      { repo: pending.repo, prId: 700, prNumber: 7, kind: 'review', headSha: 'head-one' },
    ])
  },
)

test('a human assigning the bot its own PR records no pending review', async () => {
  // #given
  const f = await fixture()
  f.config.review.on = 'review_requested'
  await f.adapter.start()
  const admissions: Promise<RouteReceipt>[] = []
  const route = f.router.route.bind(f.router)
  f.router.route = (...args) => {
    const admission = route(...args)
    admissions.push(admission)
    return admission
  }

  // #when
  const response = await f.deliver('assigned', 'pull_request', {
    pull_request: { ...pull, user: { login: 'bot', id: 1, type: 'User' } },
    assignee: { login: 'bot', id: 1, type: 'User' },
  })
  await Promise.all(admissions)

  // #then
  expect(response.status).toBe(200)
  expect(await f.store.list()).toEqual([])
  expect(admissions).toHaveLength(0)
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
  { action: 'assigned', login: 'bot', app: false },
  { action: 'assigned', login: 'bot[bot]', app: true },
  { action: 'assigned', login: 'bot', app: true },
  { action: 'review_requested', login: 'bot', app: false },
])('admits a recovered current review trigger, %j', async ({ action, login, app }) => {
  // #given
  const bot = { login, id: 1, type: app && login.endsWith('[bot]') ? 'Bot' : 'User' }
  const f = await fixture(undefined, {
    ...(app ? { app: true as const } : {}),
    recoveredDelivery: {
      action,
      repository: { name: 'widgets', owner: { login: 'acme' } },
      pull_request: pull,
      assignee: bot,
      requested_reviewer: bot,
      sender: { login: 'alice', id: 10, type: 'User' },
    },
  })
  f.config.webhookUrl = 'https://example.com/github'
  f.config.review.on = 'review_requested'
  await f.adapter.start()
  await f.scanRead
  f.pull.assignees = [bot]
  f.requestedReviewers.users = [bot]

  // #when
  const admitted = f.nextRoute()
  await f.recoverRemoval()
  expect((await admitted).kind).toBe('accepted')

  // #then
  expect(await f.store.list()).toMatchObject([
    { headSha: 'head-one', ...(action === 'assigned' ? { assignmentTriggered: true } : {}) },
  ])
  expect(f.routed.map((message) => message.eventKind)).toEqual([`pull_request:${action}`])
})

test.each(
  ['assigned', 'review_requested', 'review_requested PR state'].flatMap((source) => [
    { source, name: 'HTTP failure', response: () => new Response('unavailable', { status: 503 }) },
    { source, name: 'invalid JSON', response: () => new Response('{') },
    { source, name: 'missing state', response: () => Response.json({}) },
    {
      source,
      name: 'invalid state',
      response: () => Response.json({ assignees: [{}], users: {}, teams: [] }),
    },
  ]),
)('retries a recovered $source after $name', async ({ source, response }) => {
  // #given
  const action = source === 'assigned' ? 'assigned' : 'review_requested'
  const bot = { login: 'bot', id: 1, type: 'User' }
  const f = await fixture(undefined, {
    recoveredDelivery: {
      action,
      repository: { name: 'widgets', owner: { login: 'acme' } },
      pull_request: { ...pull, assignees: [bot] },
      assignee: bot,
      requested_reviewer: bot,
      sender: { login: 'alice', id: 10, type: 'User' },
    },
  })
  f.config.webhookUrl = 'https://example.com/github'
  f.config.review.on = 'review_requested'
  await f.adapter.start()
  await f.scanRead
  f.pull.assignees = [bot]
  f.requestedReviewers.users = [bot]
  const failRead = source === 'review_requested' ? f.failRequestedReviewers : f.failPull
  failRead(response)

  // #when
  await f.recoverRemoval()

  // #then: no admission and neither dedup log consumes the failed GUID.
  expect(await f.store.list()).toEqual([])
  expect(f.routeAttempts).toEqual([])
  expect(f.statuses).toEqual([])
  failRead()
  const admitted = f.nextRoute()
  await f.recoverRemoval()
  expect((await admitted).kind).toBe('accepted')
  expect(await f.store.list()).toMatchObject([
    { headSha: 'head-one', ...(action === 'assigned' ? { assignmentTriggered: true } : {}) },
  ])
})

test.each(['assigned', 'review_requested'])(
  'does not resurrect withdrawn work from a recovered %s delivery',
  async (action) => {
    // #given: the original trigger failed at ingress; only the separate request arrived.
    const turn = Promise.withResolvers<void>()
    const bot = { login: 'bot', id: 1, type: 'User' }
    const f = await fixture(undefined, {
      prompt: () => turn.promise,
      recoveredDelivery: {
        action,
        repository: { name: 'widgets', owner: { login: 'acme' } },
        pull_request: { ...pull, assignees: [bot] },
        assignee: bot,
        requested_reviewer: bot,
        sender: { login: 'alice', id: 10, type: 'User' },
      },
    })
    cleanups.push(async () => turn.resolve())
    f.config.webhookUrl = 'https://example.com/github'
    f.config.review.on = 'review_requested'
    f.config.review.check = true
    await f.adapter.start()
    await f.scanRead
    f.pull.assignees = [bot]
    let routed = f.nextRoute()
    await f.deliver('review_requested', 'pull_request', {
      requested_reviewer: bot,
      pull_request: { ...f.pull, updated_at: '2026-01-01T00:01:00Z' },
    })
    await routed
    await githubReviewChecks.beginReview(
      { repo: pending.repo, pullRequest: pending.prNumber, headSha: pending.headSha },
      `withdrawn-recovered-${action}`,
    )
    try {
      // #when: unassignment and removal succeed before the failed trigger is swept.
      f.pull.assignees = []
      await f.deliver('unassigned', 'pull_request', { assignee: bot, pull_request: f.pull })
      routed = f.nextRoute()
      await f.deliver('review_request_removed', 'pull_request', { requested_reviewer: bot })
      await routed
      await githubReviewChecks.sweep()
      expect(await f.store.list()).toEqual([])
      expect(f.statuses.map((status) => status.state)).toEqual(['pending', 'success'])
      const beforeRoutes = [...f.routed]
      const beforeAttempts = f.routeAttempts.length
      const beforeStatuses = [...f.statuses]
      const recoveredRoute = f.nextRoute()
      await f.recoverRemoval()
      if (f.routeAttempts.length > beforeAttempts) await recoveredRoute

      // #then: recovery cannot create pending work, checks, or even a router call.
      expect(await f.store.list()).toEqual([])
      expect(f.routeAttempts).toHaveLength(beforeAttempts)
      expect(f.routed).toEqual(beforeRoutes)
      expect(f.statuses).toEqual(beforeStatuses)
    } finally {
      await githubReviewChecks.reviewerSettled(`withdrawn-recovered-${action}`, {
        kind: 'cancelled',
        reason: 'test cleanup',
      })
    }
  },
)

test.each([
  { order: 'remove-first', membershipStatus: undefined },
  { order: 'unassign-first', membershipStatus: undefined },
  { order: 'remove-first', membershipStatus: 403 },
  { order: 'remove-first', membershipStatus: 404 },
])(
  'retires both withdrawals in $order order with team status $membershipStatus',
  async ({ order, membershipStatus }) => {
    // #given
    const turn = Promise.withResolvers<void>()
    const bot = { login: 'bot', id: 1, type: 'User' }
    const f = await fixture(undefined, { prompt: () => turn.promise })
    cleanups.push(async () => turn.resolve())
    f.config.review.on = 'review_requested'
    f.config.review.check = true
    await f.adapter.start()
    await f.scanRead
    f.pull.assignees = [bot]
    f.requestedReviewers.users = [bot]
    for (const action of ['assigned', 'review_requested']) {
      const admitted = f.nextRoute()
      await f.deliver(action, 'pull_request', { assignee: bot, requested_reviewer: bot, pull_request: f.pull })
      await admitted
    }
    const recorded = await f.store.list()
    const reviewer = `withdraw-order-${order}`
    await githubReviewChecks.beginReview(
      { repo: pending.repo, pullRequest: pending.prNumber, headSha: pending.headSha },
      reviewer,
    )
    try {
      // #when: the first withdrawal must preserve the remaining request.
      const actions =
        order === 'remove-first' ? ['review_request_removed', 'unassigned'] : ['unassigned', 'review_request_removed']
      for (const [index, action] of actions.entries()) {
        if (action === 'unassigned') f.pull.assignees = []
        else f.requestedReviewers.users = []
        if (membershipStatus !== undefined) {
          f.requestedReviewers.teams = [{ slug: 'unrelated-codeowners' }]
          f.failTeamMembership(() => new Response(null, { status: membershipStatus }))
        }
        const stopped = f.nextRoute()
        await f.deliver(action, 'pull_request', {
          assignee: bot,
          requested_reviewer: bot,
          // Deliberately stale: the API, rather than this payload, owns current state.
          pull_request: { ...pull, assignees: [bot], updated_at: `2026-01-01T00:0${index + 1}:00Z` },
        })
        if (index === 0) {
          expect(await f.store.list()).toEqual(recorded)
          expect(f.routed).toHaveLength(2)
          if (action === 'unassigned') expect(f.calls.some((url) => url.endsWith('/requested_reviewers'))).toBe(true)
        } else {
          expect(await f.store.list()).toEqual([])
          await stopped
        }
      }
      await githubReviewChecks.sweep()

      // #then
      expect(f.statuses.map((status) => status.state)).toEqual(['pending', 'success'])
      expect(f.routed.at(-1)?.text).toContain('You can stop any in-progress review.')
      await f.adapter.stop()
      await f.router.stop()
      const next = await fixture(f.dir)
      next.config.review.on = 'review_requested'
      await next.adapter.start()
      await next.scanRead
      expect(await next.store.list()).toEqual([])
      expect(next.routed).toEqual([])
    } finally {
      await githubReviewChecks.reviewerSettled(reviewer, { kind: 'cancelled', reason: 'test cleanup' })
    }
  },
)

test.each([
  { login: 'bot', app: false },
  { login: 'bot[bot]', app: true },
  { login: 'bot', app: true },
])('unassignment checks current requests and assignments for $login under app=$app', async ({ login, app }) => {
  // #given
  const f = await fixture(undefined, app ? { app: true } : {})
  f.config.review.on = 'review_requested'
  await f.adapter.start()
  await f.scanRead
  await f.store.record({ ...pending, assignmentTriggered: true })
  const assignee = { login, id: 1, type: 'User' }
  const stalePayload = { assignee, pull_request: { ...pull, assignees: [assignee] } }
  f.pull.assignees = [assignee]

  // #when: a newer assignment defeats the stale unassignment.
  await f.deliver('unassigned', 'pull_request', stalePayload)

  // #then
  expect(await f.store.list()).toHaveLength(1)
  expect(f.routed).toEqual([])

  // #when: a separate current team request still owns the work.
  f.pull.assignees = []
  f.requestedReviewers.teams = [{ slug: 'reviewers' }]
  f.teamMemberships.set('reviewers', 'active')
  await f.deliver('unassigned', 'pull_request', stalePayload)

  // #then
  expect(await f.store.list()).toHaveLength(1)
  expect(f.routed).toEqual([])

  // #when: the last request is withdrawn.
  f.requestedReviewers.teams = []
  const stopped = f.nextRoute()
  await f.deliver('unassigned', 'pull_request', stalePayload)

  // #then
  expect(await f.store.list()).toEqual([])
  await stopped
  expect(f.routed.at(-1)?.eventKind).toBe('pull_request:unassigned')
  expect(f.routed.at(-1)?.githubPendingReview).toBeUndefined()
})

test.each(['reviewers', 'assignees', 'team', 'team-network'])(
  'retries the same unassignment after a failed current %s read',
  async (read) => {
    // #given
    const f = await fixture()
    await f.adapter.start()
    await f.scanRead
    await f.store.record({ ...pending, assignmentTriggered: true })
    const payload = { assignee: { login: 'bot', id: 1, type: 'User' } }
    const fail = read.startsWith('team')
      ? f.failTeamMembership
      : read === 'reviewers'
        ? f.failRequestedReviewers
        : f.failPull
    if (read.startsWith('team')) f.requestedReviewers.teams = [{ slug: 'reviewers' }]
    fail(() => {
      if (read === 'team-network') throw new Error('network 503')
      return new Response('unavailable', { status: 503 })
    })

    // #when
    await expect(f.deliver('unassigned', 'pull_request', payload, 'retry-unassign')).rejects.toThrow('503')

    // #then
    expect(await f.store.list()).toHaveLength(1)
    expect(f.routeAttempts).toEqual([])
    fail()
    const stopped = f.nextRoute()
    await f.deliver('unassigned', 'pull_request', payload, 'retry-unassign')
    await stopped
    expect(await f.store.list()).toEqual([])
    await f.deliver('unassigned', 'pull_request', payload, 'retry-unassign')
    expect(f.routeAttempts).toHaveLength(1)
  },
)

test.each(
  [
    { trigger: 'assigned', action: 'closed' },
    { trigger: 'assigned', action: 'unassigned' },
    { trigger: 'review_requested', action: 'closed' },
  ].flatMap((input) => ['freshness', 'router'].map((pause) => ({ ...input, pause }))),
)('rejects recovered $trigger admission after intervening $action at $pause', async ({ trigger, action, pause }) => {
  // #given
  const bot = { login: 'bot', id: 1, type: 'User' }
  const f = await fixture(undefined, {
    recoveredDelivery: {
      action: trigger,
      repository: { name: 'widgets', owner: { login: 'acme' } },
      pull_request: { ...pull, assignees: [bot] },
      assignee: bot,
      requested_reviewer: bot,
      sender: { login: 'alice', id: 10, type: 'User' },
    },
  })
  f.config.webhookUrl = 'https://example.com/github'
  f.config.review.on = 'review_requested'
  f.config.review.check = true
  await f.adapter.start()
  await f.scanRead
  f.pull.assignees = [bot]
  if (trigger === 'review_requested') f.requestedReviewers.users = [bot]
  await f.store.record({ ...pending, assignmentTriggered: true })
  const reached = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const settled = Promise.withResolvers<void>()
  if (pause === 'router') {
    const route = f.router.route.bind(f.router)
    f.router.route = async (message, onAdmitted) => {
      if (message.eventKind !== `pull_request:${trigger}`) return route(message, onAdmitted)
      reached.resolve()
      await resume.promise
      try {
        return await route(message, onAdmitted)
      } finally {
        settled.resolve()
      }
    }
  }
  let reads = 0
  f.failPull(() => {
    const snapshot = { ...f.pull }
    const response = Response.json(snapshot)
    if (++reads === 1 && pause === 'freshness') {
      response.json = async () => {
        reached.resolve()
        await resume.promise
        return snapshot
      }
    }
    return response
  })

  // #when: pause after the recovery freshness read but before durable admission.
  const recovery = f.recoverRemoval()
  await reached.promise
  if (action === 'closed') f.pull.state = 'closed'
  else f.pull.assignees = []
  await f.deliver(action, 'pull_request', { assignee: bot, pull_request: f.pull })
  expect(await f.store.list()).toEqual([])
  resume.resolve()
  if (pause === 'router') await settled.promise
  await recovery

  // #then
  expect(await f.store.list()).toEqual([])
  expect(f.statuses).toEqual([])
})

test.each(
  ['assigned', 'review_requested PR state', 'review_requested', 'team'].flatMap((source) => [
    { source, failure: '503', response: () => new Response('unavailable', { status: 503 }) },
    { source, failure: 'invalid JSON', response: () => new Response('{') },
    { source, failure: 'missing fields', response: () => Response.json({}) },
    {
      source,
      failure: 'network',
      response: (): Response => {
        throw new Error('network unavailable')
      },
    },
  ]),
)(
  'retries the same recovered GUID after admission-time $source $failure without journaling it',
  async ({ source, response }) => {
    // #given
    const bot = { login: 'bot', id: 1, type: 'User' }
    const f = await fixture(undefined, {
      recoveredDelivery: {
        action: source === 'assigned' ? 'assigned' : 'review_requested',
        repository: { name: 'widgets', owner: { login: 'acme' } },
        pull_request: { ...pull, assignees: [bot] },
        assignee: bot,
        ...(source === 'team' ? { requested_team: { slug: 'reviewers', id: 1 } } : { requested_reviewer: bot }),
        sender: { login: 'alice', id: 10, type: 'User' },
      },
    })
    f.config.webhookUrl = 'https://example.com/github'
    f.config.review.on = 'review_requested'
    await f.adapter.start()
    await f.scanRead
    f.pull.assignees = [bot]
    f.requestedReviewers.users = [bot]
    f.requestedReviewers.teams = [{ slug: 'reviewers', id: 1 }]
    f.teamMemberships.set('reviewers', 'active')
    let reads = 0
    const failRead =
      source === 'team' ? f.failTeamMembership : source === 'review_requested' ? f.failRequestedReviewers : f.failPull
    failRead(() => {
      if (++reads === 2) return response()
      return Response.json(
        source === 'team' ? { state: 'active' } : source === 'review_requested' ? f.requestedReviewers : f.pull,
      )
    })

    // #when: the initial lookup succeeds; only admission-time validation fails.
    await f.recoverRemoval()

    // #then: no router journal row exists and the next sweep admits this GUID once.
    expect(await f.store.list()).toEqual([])
    expect(f.routeAttempts).toEqual([])
    const admitted = f.nextRoute()
    await f.recoverRemoval()
    expect((await admitted).kind).toBe('accepted')
    expect(await f.store.list()).toMatchObject([{ headSha: 'head-one' }])
    expect(f.routed).toHaveLength(1)
    await f.deliver(
      source === 'assigned' ? 'assigned' : 'review_requested',
      'pull_request',
      {
        assignee: bot,
        requested_reviewer: bot,
        pull_request: f.pull,
      },
      'old-removal',
    )
    expect(f.routed).toHaveLength(1)
  },
)

test.each([
  { status: 403, headers: new Headers({ 'x-ratelimit-remaining': '0' }), message: 'API rate limit exceeded' },
  { status: 403, headers: new Headers({ 'retry-after': '60' }), message: 'Forbidden' },
  { status: 403, headers: new Headers(), message: 'You have exceeded a secondary rate limit.' },
  { status: 429, headers: new Headers(), message: 'Too many requests' },
])('preserves a requested team across throttled unassignment %j', async ({ status, headers, message }) => {
  // #given
  const f = await fixture()
  await f.adapter.start()
  await f.scanRead
  await f.store.record({ ...pending, assignmentTriggered: true })
  f.requestedReviewers.teams = [{ slug: 'reviewers' }]
  f.teamMemberships.set('reviewers', 'active')
  f.failTeamMembership(() => Response.json({ message }, { status, headers }))
  const payload = { assignee: { login: 'bot', id: 1, type: 'User' } }

  // #when
  await expect(f.deliver('unassigned', 'pull_request', payload, 'throttled-unassign')).rejects.toThrow(String(status))

  // #then: the same GUID retries the current lookup and preserves active membership.
  expect(await f.store.list()).toEqual([{ ...pending, assignmentTriggered: true }])
  expect(f.routeAttempts).toEqual([])
  f.failTeamMembership()
  await f.deliver('unassigned', 'pull_request', payload, 'throttled-unassign')
  expect(await f.store.list()).toEqual([{ ...pending, assignmentTriggered: true }])
  expect(f.routeAttempts).toEqual([])
})

test.each(['assigned', 'review_requested'])('does not recover %s after the PR closes', async (action) => {
  // #given
  const bot = { login: 'bot', id: 1, type: 'User' }
  const f = await fixture(undefined, {
    recoveredDelivery: {
      action,
      repository: { name: 'widgets', owner: { login: 'acme' } },
      pull_request: { ...pull, assignees: [bot] },
      assignee: bot,
      requested_reviewer: bot,
      sender: { login: 'alice', id: 10, type: 'User' },
    },
  })
  f.config.webhookUrl = 'https://example.com/github'
  f.config.review.on = 'review_requested'
  f.config.review.check = true
  await f.adapter.start()
  await f.scanRead
  f.pull.assignees = [bot]
  f.requestedReviewers.users = [bot]
  await f.store.record({ ...pending, assignmentTriggered: true })

  // #when
  f.pull.state = 'closed'
  await f.deliver('closed', 'pull_request', { pull_request: f.pull })
  expect(await f.store.list()).toEqual([])
  const recovered = f.nextRoute()
  await f.recoverRemoval()
  if (f.routeAttempts.length > 0) await recovered

  // #then
  expect(f.routeAttempts).toEqual([])
  expect(await f.store.list()).toEqual([])
  expect(f.statuses).toEqual([])
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
  // #given
  const f = await fixture()
  await f.adapter.start()
  await f.store.record({ ...pending, assignmentTriggered: true })
  // #when
  await f.deliver(action)
  // #then
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

test('keeps the pending review and check after assignment then reviewer removal while still assigned', async () => {
  // #given
  const f = await fixture()
  f.config.review.check = true
  await f.adapter.start()
  const assigned = f.nextRoute()
  const bot = { login: 'bot', id: 1, type: 'User' }
  f.pull.assignees = [bot]
  await f.deliver('assigned', 'pull_request', {
    assignee: bot,
    pull_request: { ...pull, assignees: [bot] },
  })
  expect((await assigned).kind).toBe('accepted')
  const recorded = await f.store.list()
  expect(recorded).toHaveLength(1)
  await githubReviewChecks.beginReview(
    { repo: pending.repo, pullRequest: pending.prNumber, headSha: pending.headSha },
    'assigned-removal-review',
  )
  expect(f.statuses.map((status) => status.state)).toEqual(['pending'])

  try {
    // #when
    const response = await f.deliver('review_request_removed', 'pull_request', {
      requested_reviewer: bot,
      pull_request: { ...pull, assignees: [bot], updated_at: '2026-01-01T00:01:00Z' },
    })
    await githubReviewChecks.sweep()

    // #then
    expect(response.status).toBe(200)
    expect(await f.store.list()).toEqual(recorded)
    expect(f.statuses.map((status) => status.state)).toEqual(['pending'])
    expect(f.routed.map((message) => message.eventKind)).toEqual(['pull_request:assigned'])
  } finally {
    await githubReviewChecks.reviewerSettled('assigned-removal-review', {
      kind: 'cancelled',
      reason: 'test cleanup',
    })
  }
})

test.each([
  { reassign: false, recovered: false },
  { reassign: false, recovered: true },
  { reassign: true, recovered: false },
])('withdraws both requests after unassign, %j', async ({ reassign, recovered }) => {
  // #given
  const turn = Promise.withResolvers<void>()
  const bot = { login: 'bot', id: 1, type: 'User' }
  const f = await fixture(undefined, {
    prompt: () => turn.promise,
    ...(recovered
      ? {
          recoveredRemoval: {
            action: 'review_request_removed',
            repository: { name: 'widgets', owner: { login: 'acme' } },
            pull_request: { ...pull, assignees: [bot] },
            requested_reviewer: bot,
            sender: { login: 'alice', id: 10, type: 'User' },
          },
        }
      : {}),
  })
  cleanups.push(async () => turn.resolve())
  if (recovered) f.config.webhookUrl = 'https://example.com/github'
  f.config.review.on = 'review_requested'
  f.config.review.check = true
  await f.adapter.start()
  await f.scanRead
  f.pull.assignees = [bot]
  f.requestedReviewers.users = [bot]
  let admitted = f.nextRoute()
  await f.deliver('assigned', 'pull_request', { assignee: bot, pull_request: f.pull })
  expect((await admitted).kind).toBe('accepted')
  admitted = f.nextRoute()
  await f.deliver('review_requested', 'pull_request', { requested_reviewer: bot, pull_request: f.pull })
  expect((await admitted).kind).toBe('accepted')
  const recorded = await f.store.list()
  expect(recorded).toMatchObject([{ assignmentTriggered: true }])
  await githubReviewChecks.beginReview(
    { repo: pending.repo, pullRequest: pending.prNumber, headSha: pending.headSha },
    'unassigned-review',
  )

  try {
    // #when
    f.pull.assignees = []
    await f.deliver('unassigned', 'pull_request', { assignee: bot, pull_request: f.pull })
    if (reassign) {
      f.pull.assignees = [bot]
      admitted = f.nextRoute()
      await f.deliver('assigned', 'pull_request', {
        assignee: bot,
        pull_request: { ...f.pull, updated_at: '2026-01-01T00:02:00Z' },
      })
      await admitted
    }
    const stopped = f.nextRoute()
    f.requestedReviewers.users = []
    if (recovered) await f.recoverRemoval()
    else
      await f.deliver('review_request_removed', 'pull_request', {
        requested_reviewer: bot,
        pull_request: { ...f.pull, updated_at: '2026-01-01T00:03:00Z' },
      })
    await githubReviewChecks.sweep()

    // #then
    expect(await f.store.list()).toEqual(reassign ? recorded : [])
    if (reassign) {
      expect(f.statuses.map((status) => status.state)).toEqual(['pending'])
      expect(f.routed.some((message) => message.eventKind === 'pull_request:review_request_removed')).toBe(false)
    } else {
      await stopped
      expect(f.statuses.map((status) => status.state)).toEqual(['pending', 'success'])
      expect(f.statuses[1]?.description).toBe('Not reviewed: the review request was removed')
      expect(f.routed.at(-1)?.text).toContain('You can stop any in-progress review.')
      expect(f.routed.at(-1)?.eventKind).toBe('pull_request:review_request_removed')
      await f.adapter.stop()
      await f.router.stop()
      const next = await fixture(f.dir)
      next.config.review.on = 'review_requested'
      await next.adapter.start()
      await next.scanRead
      expect(await next.store.list()).toEqual([])
      expect(next.routed).toEqual([])
    }
  } finally {
    await githubReviewChecks.reviewerSettled('unassigned-review', { kind: 'cancelled', reason: 'test cleanup' })
  }
})

test.each(['bot[bot]', 'bot'])('App assignment cancellation uses current assignee %s', async (login) => {
  // #given
  const turn = Promise.withResolvers<void>()
  const f = await fixture(undefined, { app: true, prompt: () => turn.promise })
  cleanups.push(async () => turn.resolve())
  f.config.review.on = 'review_requested'
  await f.adapter.start()
  await f.scanRead
  const assignee = { login, id: 1, type: 'User' }
  const reviewer = { login: 'bot', id: 2, type: 'User' }
  f.pull.assignees = [assignee]
  f.requestedReviewers.users = [reviewer]
  let routed = f.nextRoute()
  await f.deliver('assigned', 'pull_request', { assignee, pull_request: f.pull })
  expect((await routed).kind).toBe('accepted')
  routed = f.nextRoute()
  await f.deliver('review_requested', 'pull_request', { requested_reviewer: reviewer, pull_request: f.pull })
  expect((await routed).kind).toBe('accepted')
  const pending = await f.store.list()

  // #when
  await f.deliver('review_request_removed', 'pull_request', {
    requested_reviewer: reviewer,
    pull_request: { ...f.pull, assignees: [] },
  })

  // #then
  expect(await f.store.list()).toEqual(pending)
  expect(f.routed).toHaveLength(2)

  // #when
  f.pull.assignees = [{ login: 'someone-else', id: 3, type: 'User' }]
  await f.deliver('unassigned', 'pull_request', { assignee, pull_request: f.pull })
  routed = f.nextRoute()
  f.requestedReviewers.users = []
  await f.deliver('review_request_removed', 'pull_request', {
    requested_reviewer: reviewer,
    pull_request: { ...f.pull, assignees: [assignee], updated_at: '2026-01-01T00:04:00Z' },
  })
  await routed

  // #then
  expect(await f.store.list()).toEqual([])
  expect(f.routed.at(-1)?.text).toContain('You can stop any in-progress review.')
})

test('boot replay on a newer head preserves assignment work after reviewer removal', async () => {
  // #given
  const turn = Promise.withResolvers<void>()
  const f = await fixture(undefined, { prompt: () => turn.promise })
  cleanups.push(async () => turn.resolve())
  await f.adapter.start()
  await f.scanRead
  const bot = { login: 'bot', id: 1, type: 'User' }
  let admitted = f.nextRoute()
  await f.deliver('assigned', 'pull_request', {
    assignee: bot,
    pull_request: { ...pull, assignees: [bot] },
  })
  expect((await admitted).kind).toBe('accepted')
  admitted = f.nextRoute()
  await f.deliver('review_requested', 'pull_request', {
    requested_reviewer: bot,
    pull_request: { ...pull, assignees: [bot] },
  })
  expect((await admitted).kind).toBe('accepted')
  expect(await f.store.list()).toMatchObject([{ headSha: 'head-one', assignmentTriggered: true }])
  await f.adapter.stop()
  await f.router.stop()

  // #when
  const next = await fixture(f.dir, { prompt: () => turn.promise })
  next.pull.assignees = [bot]
  next.pull.head = { ...pull.head, sha: 'head-two' }
  next.config.review.check = true
  admitted = next.nextRoute()
  await next.adapter.start()
  expect((await admitted).kind).toBe('accepted')
  await next.scanRead
  const replayed = await next.store.list()
  const routed = [...next.routed]
  await githubReviewChecks.beginReview(
    { repo: pending.repo, pullRequest: pending.prNumber, headSha: 'head-two' },
    'boot-assignment-review',
  )
  try {
    await next.deliver('review_request_removed', 'pull_request', {
      requested_reviewer: bot,
      pull_request: { ...next.pull, assignees: [bot], updated_at: '2026-01-01T00:01:00Z' },
    })
    await githubReviewChecks.sweep()

    // #then
    expect(await next.store.list()).toEqual(replayed)
    expect(replayed).toMatchObject([{ headSha: 'head-two', assignmentTriggered: true }])
    expect(next.statuses.map((status) => status.state)).toEqual(['pending'])
    expect(next.routed).toEqual(routed)
    expect(routed).toHaveLength(1)
    expect(routed[0]?.eventKind).toBe('pull_request:reconcile')
  } finally {
    await githubReviewChecks.reviewerSettled('boot-assignment-review', {
      kind: 'cancelled',
      reason: 'test cleanup',
    })
  }
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

test('cancels a withdrawn request when assignment was not admitted by the allowlist', async () => {
  // #given
  const f = await fixture()
  f.config.review.on = 'review_requested'
  f.config.review.check = true
  f.config.eventAllowlist = ['pull_request.review_requested', 'pull_request.review_request_removed']
  await f.adapter.start()
  const bot = { login: 'bot', id: 1, type: 'User' }
  const requested = f.nextRoute()
  await f.deliver('review_requested', 'pull_request', { requested_reviewer: bot })
  expect((await requested).kind).toBe('accepted')
  f.pull.assignees = [bot]
  await f.deliver('assigned', 'pull_request', { assignee: bot, pull_request: { ...pull, assignees: [bot] } })
  await githubReviewChecks.beginReview(
    { repo: pending.repo, pullRequest: pending.prNumber, headSha: pending.headSha },
    'unadmitted-assignment-review',
  )

  try {
    // #when
    await f.deliver('review_request_removed', 'pull_request', {
      requested_reviewer: bot,
      pull_request: { ...pull, assignees: [bot] },
    })
    await githubReviewChecks.sweep()

    // #then
    expect(await f.store.list()).toEqual([])
    expect(f.statuses.map((status) => status.state)).toEqual(['pending', 'success'])
    expect(f.statuses[1]?.description).toBe('Not reviewed: the review request was removed')
  } finally {
    await githubReviewChecks.reviewerSettled('unadmitted-assignment-review', {
      kind: 'cancelled',
      reason: 'test cleanup',
    })
  }
})

test('preserves a newer assignment obligation when an older removal is recovered', async () => {
  // #given
  const bot = { login: 'bot', id: 1, type: 'User' }
  const f = await fixture(undefined, {
    recoveredRemoval: {
      action: 'review_request_removed',
      repository: { name: 'widgets', owner: { login: 'acme' } },
      pull_request: { ...pull, assignees: [] },
      requested_reviewer: bot,
      sender: { login: 'alice', id: 10, type: 'User' },
    },
  })
  f.config.webhookUrl = 'https://example.com/github'
  f.config.review.on = 'review_requested'
  f.config.review.check = true
  await f.adapter.start()
  const assigned = f.nextRoute()
  f.pull.assignees = [bot]
  await f.deliver('assigned', 'pull_request', {
    assignee: bot,
    pull_request: { ...pull, assignees: [bot], updated_at: '2026-01-01T00:01:00Z' },
  })
  expect((await assigned).kind).toBe('accepted')
  const recorded = await f.store.list()
  await githubReviewChecks.beginReview(
    { repo: pending.repo, pullRequest: pending.prNumber, headSha: pending.headSha },
    'recovered-assignment-review',
  )

  try {
    // #when
    await f.recoverRemoval()
    await githubReviewChecks.sweep()

    // #then
    expect(await f.store.list()).toEqual(recorded)
    expect(f.statuses.map((status) => status.state)).toEqual(['pending'])
    expect(f.routed.map((message) => message.eventKind)).toEqual(['pull_request:assigned'])
  } finally {
    await githubReviewChecks.reviewerSettled('recovered-assignment-review', {
      kind: 'cancelled',
      reason: 'test cleanup',
    })
  }
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
