import { describe, expect, test } from 'bun:test'

import type { ChannelRouter } from '@/channels/router'
import type { SubmitReviewRequest, SubmitReviewResult } from '@/channels/types'

import { createPostGithubReviewTool } from './post-github-review'

function fakeRouter(handler: (req: SubmitReviewRequest) => Promise<SubmitReviewResult>): ChannelRouter {
  return {
    route: async () => {},
    send: async () => ({ ok: true }),
    getConsecutiveSendCount: () => 0,
    getSendRate: () => ({ count: 0, windowMs: 5_000 }),
    registerOutbound: () => {},
    unregisterOutbound: () => {},
    registerReaction: () => {},
    unregisterReaction: () => {},
    react: async () => ({ ok: true }),
    registerRemoveReaction: () => {},
    unregisterRemoveReaction: () => {},
    removeReaction: async () => ({ ok: true }),
    registerTyping: () => {},
    unregisterTyping: () => {},
    registerChannelNameResolver: () => {},
    unregisterChannelNameResolver: () => {},
    registerSelfIdentity: () => {},
    unregisterSelfIdentity: () => {},
    registerMembership: () => {},
    unregisterMembership: () => {},
    registerHistory: () => {},
    unregisterHistory: () => {},
    fetchHistory: async () => ({ ok: false, error: 'history-not-supported' }),
    registerFetchAttachment: () => {},
    unregisterFetchAttachment: () => {},
    fetchAttachment: async () => ({ ok: false, error: 'no fetchAttachment callback registered for "github"' }),
    registerReviewThreadResolver: () => {},
    unregisterReviewThreadResolver: () => {},
    resolveReviewThread: async () => ({ ok: true }),
    registerReviewSubmitter: () => {},
    unregisterReviewSubmitter: () => {},
    submitReview: handler,
    lookupInboundAttachment: () => null,
    listInboundAttachmentIds: () => [],
    getSelfAliases: () => [],
    stop: async () => {},
    tearDownAllLive: async () => {},
    liveCount: () => 0,
    executeCommand: async () => ({ kind: 'no-live-session' }),
    injectSubagentCompletionReminder: () => ({ kind: 'no-live-session' }),
    markTurnSkipped: () => ({ kind: 'no-live-session' }),
    reserveRestartHandoff: () => null,
    resumeRestartHandoff: async () => {},
  }
}

const githubOrigin = { adapter: 'github' as const, workspace: 'acme/widgets', chat: 'pr:7', thread: null }
const slackOrigin = { adapter: 'slack-bot' as const, workspace: 'T0', chat: 'C0', thread: null }
const fakeCtx = {} as Parameters<ReturnType<typeof createPostGithubReviewTool>['execute']>[4]

async function runTool(
  tool: ReturnType<typeof createPostGithubReviewTool>,
  params: Parameters<ReturnType<typeof createPostGithubReviewTool>['execute']>[1],
) {
  return tool.execute('id', params, undefined, undefined, fakeCtx)
}

describe('createPostGithubReviewTool', () => {
  test('denies use outside github channel sessions', async () => {
    const tool = createPostGithubReviewTool({
      router: fakeRouter(async () => ({ ok: true, reviewId: 1, state: 'COMMENTED' })),
      origin: slackOrigin,
    })

    const result = await runTool(tool, { event: 'COMMENT', body: 'summary' })

    expect(result.details).toEqual({
      ok: false,
      error: 'post_github_review is only supported on github channel sessions.',
    })
  })

  test('maps snake_case multiline params to ReviewFinding camelCase', async () => {
    const captured: SubmitReviewRequest[] = []
    const tool = createPostGithubReviewTool({
      router: fakeRouter(async (req) => {
        captured.push(req)
        return { ok: true, reviewId: 1, state: 'COMMENTED' }
      }),
      origin: githubOrigin,
    })

    await runTool(tool, {
      event: 'COMMENT',
      body: 'summary',
      comments: [{ path: 'src/app.ts', line: 10, side: 'RIGHT', start_line: 8, start_side: 'RIGHT', body: 'finding' }],
    })

    expect(captured[0]?.comments).toEqual([
      { path: 'src/app.ts', line: 10, side: 'RIGHT', startLine: 8, startSide: 'RIGHT', body: 'finding' },
    ])
  })

  test('receipt mentions downgraded approval and reanchored findings', async () => {
    const tool = createPostGithubReviewTool({
      router: fakeRouter(async () => ({
        ok: true,
        reviewId: 44,
        state: 'COMMENTED',
        downgraded: true,
        reanchored: [{ path: 'src/app.ts', line: 99, body: 'out' }],
      })),
      origin: githubOrigin,
    })

    const result = await runTool(tool, { event: 'APPROVE', body: 'summary' })
    const text = (result.content[0] as { text: string }).text

    expect(text).toContain('id=44')
    expect(text).toContain('downgraded')
    expect(text).toContain('out-of-diff')
    expect(text).toContain('src/app.ts:99')
  })
})
