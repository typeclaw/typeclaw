import { afterEach, describe, expect, test } from 'bun:test'

import {
  __resetReviewObserverForTest,
  hasReview,
  resetReviewTurn,
  setReviewOutputObserver,
} from '@/channels/github-review-turn-ledger'
import {
  __resetReviewVerdictGuardForTest,
  configureReviewVerdictCoordinator,
} from '@/channels/github-review-verdict-coordinator'
import { createChannelRouter } from '@/channels/router'
import { defaultHistoryConfig } from '@/channels/schema'
import type { OutboundMessage, SubmitReviewRequest } from '@/channels/types'

import { createPostGithubReviewTool } from './post-github-review'

function router() {
  return createChannelRouter({
    agentDir: '/tmp/typeclaw-post-review-test',
    configForAdapter: () => ({
      allow: ['*'],
      engagement: { trigger: ['mention'], stickiness: 'off' },
      enabled: true,
      history: defaultHistoryConfig(),
    }),
  })
}

const githubOrigin = { adapter: 'github' as const, workspace: 'acme/widgets', chat: 'pr:7', thread: null }
const slackOrigin = { adapter: 'slack-bot' as const, workspace: 'T0', chat: 'C0', thread: null }
const fakeCtx = {} as Parameters<ReturnType<typeof createPostGithubReviewTool>['execute']>[4]
const sessionId = 'post-review-session'

async function run(tool: ReturnType<typeof createPostGithubReviewTool>, params: Parameters<typeof tool.execute>[1]) {
  return tool.execute('id', params, undefined, undefined, fakeCtx)
}

describe('post_github_review', () => {
  afterEach(() => {
    resetReviewTurn(sessionId)
    resetReviewTurn('concurrent-session')
    __resetReviewObserverForTest()
    __resetReviewVerdictGuardForTest()
  })

  test('is gated to GitHub-origin sessions', async () => {
    const result = await run(createPostGithubReviewTool({ router: router(), origin: slackOrigin, sessionId }), {
      event: 'COMMENT',
      body: 'summary',
    })
    expect(result.details).toMatchObject({ ok: false })
  })

  test('maps snake_case anchors and returns adapter verification details', async () => {
    const channelRouter = router()
    const requests: SubmitReviewRequest[] = []
    channelRouter.registerReviewSubmitter('github', async (request) => {
      requests.push(request)
      return {
        ok: true,
        reviewId: 44,
        state: 'COMMENTED',
        downgraded: true,
        reanchored: [{ path: 'src/app.ts', line: 99, body: 'outside' }],
      }
    })
    const output: unknown[] = []
    setReviewOutputObserver((event) => output.push(event))
    const result = await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'APPROVE',
      body: 'summary',
      comments: [{ path: 'src/app.ts', line: 10, side: 'RIGHT', start_line: 8, start_side: 'RIGHT', body: 'finding' }],
    })

    expect(requests[0]?.comments).toEqual([
      { path: 'src/app.ts', line: 10, side: 'RIGHT', startLine: 8, startSide: 'RIGHT', body: 'finding' },
    ])
    expect(result.details).toMatchObject({ ok: true, reviewId: 44, downgraded: true })
    expect(hasReview({ sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict: 'APPROVE' })).toBe(false)
    expect(output).toEqual([{ sessionId, workspace: githubOrigin.workspace, prNumber: 7, state: 'COMMENT' }])
    expect(result.content[0]).toMatchObject({ type: 'text' })
    if (result.content[0]?.type === 'text') expect(result.content[0].text).toContain('out-of-diff')
  })

  test.each([
    ['APPROVE', 'APPROVED', 'APPROVE'],
    ['REQUEST_CHANGES', 'CHANGES_REQUESTED', 'REQUEST_CHANGES'],
  ] as const)('credits the verified effective %s state to the session ledger', async (event, state, verdict) => {
    const channelRouter = router()
    channelRouter.registerReviewSubmitter('github', async () => ({ ok: true, reviewId: 45, state }))
    const output: unknown[] = []
    setReviewOutputObserver((value) => output.push(value))

    const result = await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event,
      body: 'summary',
    })

    expect(result.details).toMatchObject({ ok: true, state })
    expect(hasReview({ sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict })).toBe(true)
    expect(output).toEqual([{ sessionId, workspace: githubOrigin.workspace, prNumber: 7, state: verdict }])
  })

  test('failed or unknown verification receives no ledger credit', async () => {
    const channelRouter = router()
    let state: 'failure' | 'unknown' = 'failure'
    channelRouter.registerReviewSubmitter('github', async () =>
      state === 'failure'
        ? { ok: false, error: 'verification failed', code: 'transient' }
        : { ok: true, reviewId: 46, state: 'PENDING' },
    )
    const tool = createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId })

    expect((await run(tool, { event: 'APPROVE', body: 'summary' })).details).toMatchObject({ ok: false })
    state = 'unknown'
    expect((await run(tool, { event: 'APPROVE', body: 'summary' })).details).toMatchObject({ ok: false })
    expect(hasReview({ sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict: 'APPROVE' })).toBe(false)
  })

  test('shares effective-state and in-flight coordination with the github-cli-auth guard', async () => {
    let effective: 'NONE' | 'APPROVED' = 'APPROVED'
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    let submissions = 0
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    channelRouter.registerReviewSubmitter('github', async () => {
      submissions += 1
      await firstGate
      return { ok: true, reviewId: 47, state: 'APPROVED' }
    })

    const effectiveDuplicate = await run(
      createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }),
      { event: 'APPROVE', body: 'summary' },
    )
    expect(effectiveDuplicate.details).toMatchObject({ ok: false })
    expect(submissions).toBe(0)

    effective = 'NONE'
    const first = run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'APPROVE',
      body: 'summary',
    })
    await Bun.sleep(0)
    const concurrent = await run(
      createPostGithubReviewTool({
        router: channelRouter,
        origin: githubOrigin,
        sessionId: 'concurrent-session',
      }),
      { event: 'REQUEST_CHANGES', body: 'summary' },
    )
    expect(concurrent.details).toMatchObject({ ok: false })
    expect(submissions).toBe(1)
    releaseFirst()
    expect((await first).details).toMatchObject({ ok: true })
  })

  test('serializes concurrent formal verdicts from sibling thread sessions', async () => {
    const resolverStarted = Promise.withResolvers<void>()
    const releaseResolver = Promise.withResolvers<void>()
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => {
        resolverStarted.resolve()
        await releaseResolver.promise
        return { ok: true, effective: 'NONE' }
      },
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    let submissions = 0
    channelRouter.registerReviewSubmitter('github', async () => {
      submissions += 1
      return { ok: true, reviewId: 50, state: 'APPROVED' }
    })
    const first = run(
      createPostGithubReviewTool({
        router: channelRouter,
        origin: { ...githubOrigin, thread: '101' },
        sessionId,
      }),
      { event: 'APPROVE', body: 'summary' },
    )
    const second = run(
      createPostGithubReviewTool({
        router: channelRouter,
        origin: { ...githubOrigin, thread: '202' },
        sessionId: 'concurrent-session',
      }),
      { event: 'APPROVE', body: 'summary' },
    )
    await resolverStarted.promise
    releaseResolver.resolve()
    const [landed, concurrent] = await Promise.all([first, second])

    expect(landed.details).toMatchObject({ ok: true })
    expect(concurrent.details).toMatchObject({
      ok: false,
      error:
        'Another session in this agent is already submitting a formal review verdict for this pull request. ' +
        'Only one verdict may land per PR — do not submit a second review; the in-flight one will post.',
    })
    expect(submissions).toBe(1)
  })

  test('posts a duplicate REQUEST_CHANGES as one top-level PR comment', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'CHANGES_REQUESTED' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    const reviews: SubmitReviewRequest[] = []
    const comments: OutboundMessage[] = []
    channelRouter.registerReviewSubmitter('github', async (request) => {
      reviews.push(request)
      return { ok: true, reviewId: 48, state: 'CHANGES_REQUESTED' }
    })
    channelRouter.registerOutbound('github', async (message) => {
      comments.push(message)
      return { ok: true, messageId: '91', messageIds: ['91'] }
    })
    const output: unknown[] = []
    setReviewOutputObserver((value) => output.push(value))

    const result = await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'REQUEST_CHANGES',
      body: 'The overall flow still needs revision.',
      comments: [
        { path: 'src/rules.ts', line: 12, side: 'RIGHT', body: 'Evaluate only the selected offer here.' },
        {
          path: 'src/search.ts',
          line: 30,
          side: 'RIGHT',
          start_line: 26,
          start_side: 'RIGHT',
          body: 'Keep exhaustive discovery in the automatic path.',
        },
        { path: 'src/legacy.ts', line: 14, side: 'LEFT', body: 'This deleted line still carries the bug.' },
        {
          path: 'src/removed.ts',
          line: 24,
          side: 'LEFT',
          start_line: 20,
          start_side: 'LEFT',
          body: 'This removed block needs a replacement.',
        },
      ],
    })

    expect(reviews).toEqual([])
    expect(comments).toEqual([
      {
        adapter: 'github',
        workspace: githubOrigin.workspace,
        chat: githubOrigin.chat,
        thread: null,
        text: [
          'The overall flow still needs revision.',
          '',
          '---',
          '',
          '**`src/rules.ts:12`**',
          '',
          'Evaluate only the selected offer here.',
          '',
          '**`src/search.ts:26-30`**',
          '',
          'Keep exhaustive discovery in the automatic path.',
          '',
          '**`src/legacy.ts:14 (old revision)`**',
          '',
          'This deleted line still carries the bug.',
          '',
          '**`src/removed.ts:20-24 (old revision)`**',
          '',
          'This removed block needs a replacement.',
        ].join('\n'),
      },
    ])
    expect(result.details).toEqual({ ok: true, fallback: 'comment', messageId: '91', messageIds: ['91'] })
    expect(hasReview({ sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict: 'REQUEST_CHANGES' })).toBe(
      false,
    )
    expect(output).toEqual([{ sessionId, workspace: githubOrigin.workspace, prNumber: 7, state: 'COMMENT' }])
  })

  test('serializes duplicate REQUEST_CHANGES fallbacks until outbound delivery completes', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'CHANGES_REQUESTED' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    let releaseFirst: () => void = () => {}
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    const comments: OutboundMessage[] = []
    channelRouter.registerOutbound('github', async (message) => {
      comments.push(message)
      await firstGate
      return { ok: true }
    })

    const first = run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'REQUEST_CHANGES',
      body: 'first',
    })
    await Bun.sleep(0)
    const second = await run(
      createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId: 'concurrent-session' }),
      { event: 'REQUEST_CHANGES', body: 'second' },
    )

    expect(second.details).toMatchObject({ ok: false })
    expect(comments).toHaveLength(1)
    releaseFirst()
    expect((await first).details).toMatchObject({ ok: true, fallback: 'comment' })
  })

  test('keeps a recent-landed REQUEST_CHANGES cooldown duplicate denied without an authoritative standing block', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    let submissions = 0
    channelRouter.registerReviewSubmitter('github', async () => {
      submissions += 1
      return { ok: true, reviewId: 49, state: 'CHANGES_REQUESTED' }
    })
    const comments: OutboundMessage[] = []
    channelRouter.registerOutbound('github', async (message) => {
      comments.push(message)
      return { ok: true }
    })
    const tool = createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId })

    expect((await run(tool, { event: 'REQUEST_CHANGES', body: 'first' })).details).toMatchObject({ ok: true })
    expect((await run(tool, { event: 'REQUEST_CHANGES', body: 'follow-up' })).details).toMatchObject({ ok: false })
    expect(submissions).toBe(1)
    expect(comments).toHaveLength(0)
  })

  test('blocks a sequential sibling verdict on the recent-landed cooldown', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    let submissions = 0
    channelRouter.registerReviewSubmitter('github', async () => {
      submissions += 1
      return { ok: true, reviewId: 51, state: 'APPROVED' }
    })
    const firstTool = createPostGithubReviewTool({
      router: channelRouter,
      origin: { ...githubOrigin, thread: '101' },
      sessionId,
    })
    const secondTool = createPostGithubReviewTool({
      router: channelRouter,
      origin: { ...githubOrigin, thread: '202' },
      sessionId: 'concurrent-session',
    })

    expect((await run(firstTool, { event: 'APPROVE', body: 'first' })).details).toMatchObject({ ok: true })
    const second = await run(secondTool, { event: 'APPROVE', body: 'follow-up' })

    expect(second.details).toMatchObject({
      ok: false,
      error: expect.stringContaining('already holds a standing APPROVED review'),
    })
    expect(submissions).toBe(1)
  })

  test('keeps adversarial finding paths inside a single Markdown code span', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'CHANGES_REQUESTED' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    const comments: OutboundMessage[] = []
    channelRouter.registerOutbound('github', async (message) => {
      comments.push(message)
      return { ok: true }
    })

    await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'REQUEST_CHANGES',
      body: 'summary',
      comments: [{ path: '`@team\n## injected.ts`', line: 4, body: 'finding' }],
    })

    expect(comments[0]?.text).toContain('`` `@team ## injected.ts`:4 ``')
    expect(comments[0]?.text).not.toContain('\n## injected.ts')
  })

  test('keeps concurrent REQUEST_CHANGES blocked instead of posting a fallback comment', async () => {
    const channelRouter = router()
    const comments: OutboundMessage[] = []
    channelRouter.registerOutbound('github', async (message) => {
      comments.push(message)
      return { ok: true }
    })
    const verdictGuard = {
      guard: async () => ({ block: true as const, kind: 'concurrent' as const, reason: 'already submitting' }),
      release: async () => {},
      noteLandedReview: async () => {},
    }

    const result = await run(
      createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId, verdictGuard }),
      { event: 'REQUEST_CHANGES', body: 'summary' },
    )

    expect(result.details).toMatchObject({ ok: false, error: 'already submitting' })
    expect(comments).toEqual([])
  })

  test('reports a failed duplicate-review comment fallback', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'CHANGES_REQUESTED' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    channelRouter.registerOutbound('github', async () => ({
      ok: false,
      error: 'GitHub API 403: Issues permission required',
      code: 'callback-rejected',
    }))

    const result = await run(createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId }), {
      event: 'REQUEST_CHANGES',
      body: 'summary',
    })

    expect(result.details).toEqual({
      ok: false,
      error: 'GitHub API 403: Issues permission required',
      code: 'callback-rejected',
    })
  })

  test('retains a conservative dedupe shield when POST succeeded but verification outcome is unknown', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
      resolveHeadSha: async () => 'sha-1',
    })
    const channelRouter = router()
    let submissions = 0
    channelRouter.registerReviewSubmitter('github', async () => {
      submissions += 1
      return { ok: false, error: 'verification timed out', code: 'transient', submitted: true }
    })
    const tool = createPostGithubReviewTool({ router: channelRouter, origin: githubOrigin, sessionId })

    expect((await run(tool, { event: 'APPROVE', body: 'summary' })).details).toMatchObject({ ok: false })
    expect((await run(tool, { event: 'APPROVE', body: 'retry' })).details).toMatchObject({ ok: false })
    expect(submissions).toBe(1)
    expect(hasReview({ sessionId, workspace: githubOrigin.workspace, prNumber: 7, verdict: 'APPROVE' })).toBe(false)
  })
})
