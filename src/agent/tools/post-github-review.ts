import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'
import type { ReviewFinding, SubmitReviewRequest } from '@/channels/types'

import { type ChannelToolLogger, consoleChannelLogger, formatChannelToolFailure } from './channel-log'
import { type ChannelReplyOrigin, TOOL_RESULT_PREFIX } from './channel-reply'
import { fenceToolResult } from './runtime-notice'

type PostGithubReviewDetails = {
  ok: boolean
  error?: string
  code?: string
  reviewId?: number
  state?: string
  downgraded?: boolean
  reanchored?: ReviewFinding[]
}

export type CreatePostGithubReviewToolOptions = {
  router: ChannelRouter
  origin: ChannelReplyOrigin
  logger?: ChannelToolLogger
}

export function createPostGithubReviewTool({
  router,
  origin,
  logger = consoleChannelLogger,
}: CreatePostGithubReviewToolOptions) {
  return defineTool({
    name: 'post_github_review',
    label: 'Post GitHub PR Review',
    description:
      'GitHub channel sessions only. Submit a formal PR review with inline comments. The tool resolves the PR head SHA, validates diff anchors, demotes out-of-diff findings into the review body, enforces approval policy, and verifies the review landed.',
    parameters: Type.Object({
      event: Type.Union([Type.Literal('APPROVE'), Type.Literal('REQUEST_CHANGES'), Type.Literal('COMMENT')], {
        description: 'GitHub review event to submit.',
      }),
      body: Type.String({ description: 'Top-level review body/summary.', minLength: 1 }),
      comments: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ minLength: 1 }),
            line: Type.Integer({ minimum: 1 }),
            side: Type.Optional(Type.Union([Type.Literal('LEFT'), Type.Literal('RIGHT')])),
            start_line: Type.Optional(Type.Integer({ minimum: 1 })),
            start_side: Type.Optional(Type.Union([Type.Literal('LEFT'), Type.Literal('RIGHT')])),
            body: Type.String({ minLength: 1 }),
          }),
          { description: 'Inline review findings anchored by file path and file line.', minItems: 1 },
        ),
      ),
    }),

    async execute(_toolCallId, params) {
      if (origin.adapter !== 'github') {
        const error = 'post_github_review is only supported on github channel sessions.'
        logger.warn(formatChannelToolFailure('post_github_review', error))
        const details: PostGithubReviewDetails = { ok: false, error }
        return {
          content: [{ type: 'text' as const, text: `${TOOL_RESULT_PREFIX}post_github_review denied: ${error}` }],
          details,
        }
      }

      const comments = (params.comments ?? []).map(toReviewFinding)
      const request: SubmitReviewRequest = {
        adapter: origin.adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        event: params.event,
        body: params.body,
        comments,
      }
      const result = await router.submitReview(request)
      if (!result.ok) {
        logger.warn(
          formatChannelToolFailure('post_github_review', `${origin.workspace}/${origin.chat}: ${result.error}`),
        )
        const details: PostGithubReviewDetails = { ok: false, error: result.error, code: result.code }
        return {
          content: [{ type: 'text' as const, text: `${TOOL_RESULT_PREFIX}post_github_review denied: ${result.error}` }],
          details,
        }
      }

      const receipt = renderReceipt(result.reviewId, result.state, result.downgraded === true, result.reanchored ?? [])
      const details: PostGithubReviewDetails = {
        ok: true,
        reviewId: result.reviewId,
        state: result.state,
        ...(result.downgraded === true ? { downgraded: true } : {}),
        ...(result.reanchored !== undefined ? { reanchored: result.reanchored } : {}),
      }
      return {
        content: [{ type: 'text' as const, text: fenceToolResult(receipt) }],
        details,
      }
    },
  })
}

function toReviewFinding(comment: {
  path: string
  line: number
  side?: 'LEFT' | 'RIGHT'
  start_line?: number
  start_side?: 'LEFT' | 'RIGHT'
  body: string
}): ReviewFinding {
  return {
    path: comment.path,
    line: comment.line,
    ...(comment.side !== undefined ? { side: comment.side } : {}),
    ...(comment.start_line !== undefined ? { startLine: comment.start_line } : {}),
    ...(comment.start_side !== undefined ? { startSide: comment.start_side } : {}),
    body: comment.body,
  }
}

function renderReceipt(
  reviewId: number,
  state: string,
  downgraded: boolean,
  reanchored: readonly ReviewFinding[],
): string {
  const notes = [
    downgraded ? 'APPROVE was downgraded to COMMENT by operator policy.' : null,
    reanchored.length > 0
      ? `${reanchored.length} out-of-diff finding(s) were moved into the top-level review body: ${reanchored.map((f) => `${f.path}:${f.line}`).join(', ')}.`
      : null,
  ].filter((note): note is string => note !== null)
  return [`GitHub review posted: id=${reviewId}, state=${state}.`, ...notes].join('\n')
}
