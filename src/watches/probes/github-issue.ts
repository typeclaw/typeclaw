import { z } from 'zod'

import type { BundledProbe } from '../types'
import {
  collectComments,
  commentConnection,
  commentSummary,
  cursorSchema,
  type GithubParams,
  githubParams,
  githubQuery,
  githubTarget,
} from './github'

const query = `query WatchIssue($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      state
      stateReason
      comments(last: 100) {
        nodes { id createdAt author { __typename login } viewerDidAuthor }
      }
    }
  }
}`

const snapshot = z.object({
  state: z.enum(['OPEN', 'CLOSED']),
  stateReason: z.enum(['COMPLETED', 'NOT_PLANNED', 'DUPLICATE', 'REOPENED']).nullable(),
  comments: commentConnection,
})

const reasons = {
  COMPLETED: 'completed',
  NOT_PLANNED: 'not planned',
  DUPLICATE: 'duplicate',
  REOPENED: 'reopened',
} as const

export const githubIssueProbe: BundledProbe<GithubParams> = {
  kind: 'github-issue',
  parseParams: (raw) => githubParams.parse(raw),
  describe: (params) => `GitHub issue ${githubTarget(params)}`,
  async run(ctx) {
    const issue = await githubQuery(ctx, query, 'issue', snapshot)
    const label = githubIssueProbe.describe(ctx.params)
    const previous = cursorSchema.nullable().parse(ctx.state ?? null)
    if (issue.state === 'CLOSED') {
      const reason = issue.stateReason === null ? 'reason not provided' : reasons[issue.stateReason]
      return { verdict: 'done', wake: true, summary: `${label} closed (${reason}).`, state: previous }
    }
    const { fresh, cursor } = collectComments(issue.comments.nodes, previous, ctx)
    return fresh.length === 0
      ? { verdict: 'quiet', state: cursor }
      : {
          verdict: 'wake',
          summary: `${label}: ${commentSummary(fresh, 'comment')}.`,
          eventKey: JSON.stringify(fresh.map(({ id }) => id).sort()),
          state: cursor,
        }
  },
}
