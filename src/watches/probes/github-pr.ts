import { z } from 'zod'

import type { BundledProbe } from '../types'
import {
  authoredSchema,
  authorName,
  collectComments,
  commentConnection,
  commentSummary,
  connection,
  cursorSchema,
  type GithubParams,
  githubParams,
  githubQuery,
  githubTarget,
  isSelf,
  names,
  timestamp,
} from './github'

const query = `query WatchPullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      merged
      mergeable
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              state
              contexts(first: 100) {
                pageInfo { hasNextPage }
                checkRunCount
                checkRunCountsByState { count state }
                statusContextCount
                statusContextCountsByState { count state }
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
      reviewDecision
      reviews(last: 100) { nodes { ...WatchReview } }
      latestOpinionatedReviews(last: 100) { nodes { ...WatchReview } }
      comments(last: 100) { nodes { ...WatchComment } }
      reviewThreads(last: 100) {
        nodes {
          comments(last: 20) { nodes { id publishedAt author { __typename login } viewerDidAuthor } }
        }
      }
    }
  }
}
fragment WatchReview on PullRequestReview {
  id state submittedAt commit { oid } author { __typename login } viewerDidAuthor
}
fragment WatchComment on IssueComment {
  id createdAt author { __typename login } viewerDidAuthor
}`

const review = authoredSchema.extend({
  id: z.string(),
  state: z.string(),
  submittedAt: timestamp.nullable(),
  commit: z.object({ oid: z.string() }).nullable(),
})
const check = z.discriminatedUnion('__typename', [
  z.object({
    __typename: z.literal('CheckRun'),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
  }),
  z.object({ __typename: z.literal('StatusContext'), context: z.string(), state: z.string() }),
])
const inlineComment = authoredSchema.extend({ id: z.string(), publishedAt: timestamp.nullable() })
const stateCount = z.object({ state: z.string(), count: z.int().nonnegative() })
const checkRollup = z.object({
  state: z.string(),
  // A null node is a context the token cannot read, such as a commit status without
  // the Commit statuses permission; it is kept so it is never mistaken for a pass.
  contexts: z.object({
    nodes: z
      .array(check.nullable())
      .nullish()
      .transform((nodes) => nodes ?? []),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
    checkRunCount: z.int().nonnegative(),
    checkRunCountsByState: z.array(stateCount).nullable(),
    statusContextCount: z.int().nonnegative(),
    statusContextCountsByState: z.array(stateCount).nullable(),
  }),
})
const snapshot = z.object({
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  merged: z.boolean(),
  mergeable: z.enum(['UNKNOWN', 'MERGEABLE', 'CONFLICTING']),
  headRefOid: z.string(),
  commits: connection(
    z.object({
      commit: z.object({
        oid: z.string(),
        statusCheckRollup: checkRollup.nullable(),
      }),
    }),
  ),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  reviews: connection(review).nullable(),
  latestOpinionatedReviews: connection(review).nullable(),
  comments: commentConnection,
  reviewThreads: connection(z.object({ comments: connection(inlineComment) })),
})

const stateSchema = z.object({
  failingSets: z.array(z.string()),
  passedHead: z.string().nullish(),
  seenReviews: z.array(z.string()),
  reviewFloor: z.number().nullable(),
  comments: cursorSchema,
  inlineComments: cursorSchema,
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING']).nullable(),
})

const failedConclusions = new Set(['ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'STALE', 'STARTUP_FAILURE', 'TIMED_OUT'])
const failedStatuses = new Set(['ERROR', 'FAILURE'])
const passingConclusions = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

type Check = z.infer<typeof check>

function checksPassed(rollup: z.infer<typeof checkRollup> | null | undefined): boolean {
  if (rollup?.state !== 'SUCCESS') return false
  const page = rollup.contexts
  if (page.nodes.length === 0) return false
  const visible = page.nodes.filter((row) => row !== null)
  if (
    !visible.every((row) =>
      row.__typename === 'StatusContext'
        ? row.state === 'SUCCESS'
        : row.status === 'COMPLETED' && row.conclusion !== null && passingConclusions.has(row.conclusion),
    )
  )
    return false
  if (!page.pageInfo.hasNextPage && visible.length === page.nodes.length) return true
  // A green first page does not prove that the omitted or unreadable checks have finished.
  // Only counts with a known non-failing terminal outcome can cover the rest.
  const passedRuns = page.checkRunCountsByState
    ?.filter(({ state }) => passingConclusions.has(state))
    .reduce((total, { count }) => total + count, 0)
  const passedStatuses = page.statusContextCountsByState?.find(({ state }) => state === 'SUCCESS')?.count ?? 0
  return (page.checkRunCount === 0 || page.checkRunCount === passedRuns) && page.statusContextCount === passedStatuses
}

function failedCheckName(row: Check): string[] {
  switch (row.__typename) {
    case 'CheckRun':
      return row.status === 'COMPLETED' && row.conclusion !== null && failedConclusions.has(row.conclusion)
        ? [row.name]
        : []
    case 'StatusContext':
      return failedStatuses.has(row.state) ? [row.context] : []
  }
}

export const githubPrProbe: BundledProbe<GithubParams> = {
  kind: 'github-pr',
  parseParams: (raw) => githubParams.parse(raw),
  describe: (params) => `GitHub PR ${githubTarget(params)}`,
  async run(ctx) {
    const pr = await githubQuery(ctx, query, 'pullRequest', snapshot, ['statusCheckRollup'])
    const label = githubPrProbe.describe(ctx.params)
    const previous = stateSchema.nullable().parse(ctx.state ?? null)
    // Deduplication lasts only as long as this head, including while its checks are pending.
    const headKeyPrefix = `[${JSON.stringify(pr.headRefOid)},`
    const failingSets = new Set(previous?.failingSets.filter((key) => key.startsWith(headKeyPrefix)))
    let passedHead = previous?.passedHead === pr.headRefOid ? previous.passedHead : undefined
    if (pr.merged || pr.state !== 'OPEN') {
      return {
        verdict: 'done',
        wake: true,
        summary: `${label} ${pr.merged || pr.state === 'MERGED' ? 'merged' : 'closed'}.`,
        state:
          previous === null ? null : { ...previous, failingSets: [...failingSets], passedHead: passedHead ?? null },
      }
    }

    const changes: string[] = []
    const events: unknown[] = []
    const head = pr.commits.nodes.find(({ commit }) => commit.oid === pr.headRefOid)?.commit
    const rollup = head?.statusCheckRollup
    const checks = rollup?.contexts.nodes.filter((row) => row !== null) ?? []
    const failing = [...new Set(checks.flatMap(failedCheckName))].sort()
    const failureKey = JSON.stringify([pr.headRefOid, failing])
    if (failing.length > 0 && !failingSets.has(failureKey)) {
      changes.push(`failing CI: ${names(failing)}`)
      events.push(['failing CI', pr.headRefOid, failing])
      failingSets.add(failureKey)
    }
    if (passedHead === undefined && checksPassed(rollup)) {
      passedHead = pr.headRefOid
      changes.push(`checks passed on ${passedHead.slice(0, 7)}`)
      events.push(['checks passed', passedHead])
    }

    const seenReviews = new Set(previous?.seenReviews)
    const requests = []
    const approvals = []
    const active =
      pr.reviewDecision === 'CHANGES_REQUESTED' || pr.reviewDecision === null
        ? (pr.latestOpinionatedReviews?.nodes ?? [])
        : []
    const candidates = new Map([...(pr.reviews?.nodes ?? []), ...active].map((row) => [row.id, row]))
    const activeIds = new Set(active.map((row) => row.id))
    const reviewFloor = previous === null ? (ctx.startedAt ?? null) : previous.reviewFloor
    for (const row of candidates.values()) {
      if (
        (row.state !== 'CHANGES_REQUESTED' && row.state !== 'APPROVED') ||
        row.submittedAt === null ||
        seenReviews.has(row.id)
      )
        continue
      seenReviews.add(row.id)
      const isNew = reviewFloor === null ? previous !== null : row.submittedAt >= reviewFloor
      const isBlockingHead = previous === null && activeIds.has(row.id) && row.commit?.oid === pr.headRefOid
      if (isSelf(row, ctx.selfLogin)) continue
      if (row.state === 'CHANGES_REQUESTED' && (isNew || isBlockingHead)) requests.push(row)
      if (row.state === 'APPROVED' && isNew) approvals.push(row)
    }
    if (requests.length > 0) {
      changes.push(`changes requested by ${names(requests.map(authorName))}`)
      events.push(['changes requested', requests.map(({ id }) => id).sort()])
    }
    if (approvals.length > 0) {
      changes.push(`approved by ${names(approvals.map(authorName))}`)
      events.push(['approved', approvals.map(({ id }) => id).sort()])
    }

    const direct = collectComments(pr.comments.nodes, previous?.comments ?? null, ctx)
    // A drafted inline comment only becomes actionable when its review is published.
    const published = pr.reviewThreads.nodes.flatMap((thread) =>
      thread.comments.nodes.flatMap((row) =>
        row.publishedAt === null ? [] : [{ ...row, createdAt: row.publishedAt }],
      ),
    )
    const inline = collectComments(published, previous?.inlineComments ?? null, ctx)
    if (direct.fresh.length > 0) {
      changes.push(commentSummary(direct.fresh, 'comment'))
      events.push(['comments', direct.fresh.map(({ id }) => id).sort()])
    }
    if (inline.fresh.length > 0) {
      changes.push(commentSummary(inline.fresh, 'review comment'))
      events.push(['review comments', inline.fresh.map(({ id }) => id).sort()])
    }
    if (pr.mergeable === 'CONFLICTING' && previous?.mergeable === 'MERGEABLE') {
      changes.push('became conflicting')
      events.push(['conflict', pr.headRefOid, ctx.lastRunAt])
    }

    const state = {
      failingSets: [...failingSets],
      ...(passedHead === undefined ? {} : { passedHead }),
      seenReviews: [...seenReviews],
      reviewFloor,
      comments: direct.cursor,
      inlineComments: inline.cursor,
      mergeable: pr.mergeable === 'UNKNOWN' ? (previous?.mergeable ?? null) : pr.mergeable,
    }
    return changes.length === 0
      ? { verdict: 'quiet', state }
      : { verdict: 'wake', summary: `${label}: ${changes.join('; ')}.`, eventKey: JSON.stringify(events), state }
  },
}
