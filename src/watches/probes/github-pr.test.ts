import { expect, test } from 'bun:test'

import { githubPrProbe } from './github-pr'
import { comment, connection, fixtureProbe } from './github.test-helpers'

function head(conclusion: string | null, order = false, oid = 'head-a', rollupState?: string, omittedState?: string) {
  const contexts = [
    { __typename: 'CheckRun', name: 'build', status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED', conclusion },
    { __typename: 'StatusContext', context: 'lint', state: conclusion === 'FAILURE' ? 'ERROR' : 'SUCCESS' },
  ]
  return connection({
    commit: {
      oid,
      statusCheckRollup: {
        state: rollupState ?? (conclusion === null ? 'PENDING' : conclusion === 'FAILURE' ? 'FAILURE' : 'SUCCESS'),
        contexts: {
          ...connection(...(order ? contexts.reverse() : contexts)),
          pageInfo: { hasNextPage: omittedState !== undefined },
          checkRunCount: omittedState === undefined ? 1 : 101,
          checkRunCountsByState: [
            { count: 1, state: conclusion ?? 'IN_PROGRESS' },
            ...(omittedState === undefined ? [] : [{ count: 100, state: omittedState }]),
          ],
          statusContextCount: 1,
          statusContextCountsByState: [{ count: 1, state: conclusion === 'FAILURE' ? 'ERROR' : 'SUCCESS' }],
        },
      },
    },
  })
}

function pr(overrides = {}) {
  return {
    state: 'OPEN',
    merged: false,
    mergeable: 'MERGEABLE',
    headRefOid: 'head-a',
    commits: head(null),
    reviewDecision: null,
    reviews: connection(),
    latestOpinionatedReviews: connection(),
    comments: connection(),
    reviewThreads: connection(),
    ...overrides,
  }
}

function review(id: string, state: string, oid: string, day: number) {
  return {
    id,
    state,
    commit: { oid },
    submittedAt: `2026-01-0${day}T00:00:00Z`,
    author: { login: 'alice', __typename: 'User' },
    viewerDidAuthor: false,
  }
}

test('reports existing failing CI, dedupes reordered and recurring sets, and re-arms on a force-push', async () => {
  const run = fixtureProbe(githubPrProbe, 'pullRequest')
  const failing = pr({ commits: head('FAILURE') })
  expect((await run(failing)).summary).toContain('build, lint')
  expect((await run(pr({ commits: head('FAILURE', true) }))).verdict).toBe('quiet')
  expect((await run(pr({ commits: head(null) }))).verdict).toBe('quiet')
  expect((await run(pr({ commits: head('SUCCESS') }))).verdict).toBe('wake')
  expect((await run(failing)).verdict).toBe('quiet')
  const pushed = await run({ ...failing, headRefOid: 'head-b' })
  expect(pushed.verdict).toBe('quiet')
  expect(JSON.stringify(pushed.state)).not.toContain('head-a')
  const failingAfterPush = await run(pr({ headRefOid: 'head-b', commits: head('FAILURE', false, 'head-b') }))
  expect(failingAfterPush.verdict).toBe('wake')
  expect(JSON.stringify(failingAfterPush.state)).not.toContain('head-a')
  expect((await run(pr({ headRefOid: 'head-b', commits: head('CANCELLED', false, 'head-b') }))).summary).toContain(
    'build',
  )
})

test('reports current-head blocking reviews at baseline and new changes requested but not stale reviews', async () => {
  const run = fixtureProbe(githubPrProbe, 'pullRequest')
  const current = review('current', 'CHANGES_REQUESTED', 'head-a', 1)
  const stale = review('stale', 'CHANGES_REQUESTED', 'head-before', 1)
  const baseline = pr({
    reviewDecision: 'CHANGES_REQUESTED',
    latestOpinionatedReviews: connection(current),
    reviews: connection(stale, current),
  })
  expect(await run(baseline)).toMatchObject({ verdict: 'wake', summary: expect.stringContaining('@alice') })
  expect((await run(baseline)).verdict).toBe('quiet')
  expect((await run(pr({ reviews: connection(stale) }))).verdict).toBe('quiet')
  const request = pr({ reviews: connection(review('new', 'CHANGES_REQUESTED', 'head-before', 4)) })
  expect((await run(request)).verdict).toBe('wake')
  expect((await run(request)).verdict).toBe('quiet')
})

test('wakes once for green CI per head, even across reruns, and re-arms on a push', async () => {
  const run = fixtureProbe(githubPrProbe, 'pullRequest')
  const green = pr({ commits: head('SUCCESS') })
  expect((await run(pr({ commits: connection({ commit: { oid: 'head-a', statusCheckRollup: null } }) }))).verdict).toBe(
    'quiet',
  )
  expect((await run(pr())).verdict).toBe('quiet')
  expect((await run(pr({ commits: head('SUCCESS', false, 'head-a', 'PENDING') }))).verdict).toBe('quiet')
  const passed = await run(green)
  expect(passed.verdict).toBe('wake')
  expect(passed.summary).toContain('checks passed on head-a')
  expect((await run(green)).verdict).toBe('quiet')
  expect((await run(pr())).verdict).toBe('quiet')
  expect((await run(green)).verdict).toBe('quiet')

  const pushed = await run(pr({ headRefOid: 'head-b', commits: head(null, false, 'head-b') }))
  expect(pushed.verdict).toBe('quiet')
  expect(JSON.stringify(pushed.state)).not.toContain('head-a')
  expect((await run(pr({ headRefOid: 'head-b', commits: head('SUCCESS', false, 'head-b') }))).verdict).toBe('wake')
})

test('ignores standing and self approvals but reports a new external approval once', async () => {
  const run = fixtureProbe(githubPrProbe, 'pullRequest', { selfLogin: 'agent[bot]' })
  const standing = review('standing', 'APPROVED', 'head-a', 1)
  const pending = pr({
    reviewDecision: 'APPROVED',
    reviews: connection(standing),
    latestOpinionatedReviews: connection(standing),
  })
  expect((await run(pending)).verdict).toBe('quiet')
  const own = {
    ...review('own', 'APPROVED', 'head-a', 3),
    author: { login: 'agent[bot]', __typename: 'Bot' },
  }
  expect((await run({ ...pending, reviews: connection(standing, own) })).verdict).toBe('quiet')
  const approved = { ...pending, reviews: connection(standing, own, review('new', 'APPROVED', 'head-a', 4)) }
  const result = await run(approved)
  expect(result.verdict).toBe('wake')
  expect(result.summary).toContain('approved by @alice')
  expect((await run(approved)).verdict).toBe('quiet')
})

test('a green page only reports success when the rollup counts also cover omitted checks', async () => {
  const run = fixtureProbe(githubPrProbe, 'pullRequest')
  expect((await run(pr({ commits: head('SUCCESS', false, 'head-a', 'SUCCESS', 'IN_PROGRESS') }))).verdict).toBe('quiet')
  expect((await run(pr({ commits: head('SUCCESS', false, 'head-a', 'SUCCESS', 'SUCCESS') }))).verdict).toBe('wake')
})

test('does not report historical changes requests already superseded on the current head', async () => {
  const run = fixtureProbe(githubPrProbe, 'pullRequest')
  expect(
    (
      await run(
        pr({
          reviewDecision: 'APPROVED',
          reviews: connection(review('stale', 'CHANGES_REQUESTED', 'head-a', 1)),
          latestOpinionatedReviews: connection(review('approved', 'APPROVED', 'head-a', 1)),
        }),
      )
    ).verdict,
  ).toBe('quiet')
})

test('reports the outstanding current-head request without an aggregate review decision', async () => {
  const run = fixtureProbe(githubPrProbe, 'pullRequest')
  const outstanding = review('outstanding', 'CHANGES_REQUESTED', 'head-a', 1)
  const row = pr({ reviews: connection(outstanding), latestOpinionatedReviews: connection(outstanding) })
  const result = await run(row)
  expect(result.verdict).toBe('wake')
  expect(result.summary).toContain('changes requested by @alice')
  expect((await run(row)).verdict).toBe('quiet')
})

test('reports comments and replies since registration, including comments with identical timestamps, but not self', async () => {
  const run = fixtureProbe(githubPrProbe, 'pullRequest', { selfLogin: 'agent[bot]' })
  const history = comment('old', 1)
  const own = comment('own', 3, 'agent[bot]')
  const direct = comment('direct', 3, 'bob')
  const inline = comment('inline', 3, 'alice')
  const row = pr({
    comments: connection(history, own, direct),
    reviewThreads: connection({
      comments: connection(
        { ...history, publishedAt: history.createdAt },
        { ...inline, createdAt: history.createdAt, publishedAt: inline.createdAt },
        { ...comment('pending', 4), publishedAt: null },
      ),
    }),
  })
  const first = await run(row)
  expect(first.verdict).toBe('wake')
  expect(first.summary ?? '').toContain('1 comment (@bob)')
  expect(first.summary ?? '').toContain('1 review comment (@alice)')
  expect(first.summary ?? '').not.toContain('agent')
  expect((await run(row)).verdict).toBe('quiet')
  expect((await run({ ...row, comments: connection(own, direct, comment('same-second', 3)) })).verdict).toBe('wake')
})

test('wakes on becoming conflicting, not on baseline or intermediate unknown states', async () => {
  const run = fixtureProbe(githubPrProbe, 'pullRequest')
  const conflict = pr({ mergeable: 'CONFLICTING' })
  expect((await run(conflict)).verdict).toBe('quiet')
  expect((await run(pr({ mergeable: 'UNKNOWN' }))).verdict).toBe('quiet')
  expect((await run(conflict)).verdict).toBe('quiet')
  await run(pr())
  expect(await run(conflict)).toMatchObject({ verdict: 'wake', summary: expect.stringContaining('conflict') })
})

test.each([
  [pr({ state: 'CLOSED', merged: true }), 'merged'],
  [pr({ state: 'CLOSED' }), 'closed'],
])('ends and wakes on terminal PR state %#', async (row, reason) => {
  const run = fixtureProbe(githubPrProbe, 'pullRequest')
  expect(await run(row)).toMatchObject({ verdict: 'done', wake: true, summary: expect.stringContaining(reason) })
})

test.each([
  [Response.json({ message: 'Forbidden' }, { status: 403 }), '403'],
  [Response.json({ message: 'Slow down' }, { status: 429, headers: { 'retry-after': '60' } }), '429'],
  [Response.json({ message: 'You have exceeded a secondary rate limit' }, { status: 403 }), 'secondary rate limit'],
  [
    Response.json({ data: { repository: null }, errors: [{ message: 'API rate limit exceeded' }] }),
    'rate limit exceeded',
  ],
  [Response.json({ data: { repository: null }, errors: [{ message: 'Resource not accessible' }] }), 'not accessible'],
  [new Response('invalid JSON'), 'invalid JSON'],
])('propagates GitHub failure %# instead of emitting a verdict', async (response, reason) => {
  const run = fixtureProbe(githubPrProbe, 'pullRequest')
  await expect(run(response)).rejects.toThrow(reason)
})

test('propagates token failures without polling', async () => {
  const run = fixtureProbe(githubPrProbe, 'pullRequest', {
    resolveTokenForRepo: async () => ({ kind: 'unavailable', reason: 'installation unavailable' }),
  })
  await expect(run(pr())).rejects.toThrow('installation unavailable')
})

test('accepts only a canonical GitHub repo and a positive GraphQL Int', () => {
  expect(githubPrProbe.parseParams({ repo: 'Acme/Widgets', number: 12 })).toEqual({ repo: 'acme/widgets', number: 12 })
  expect(() => githubPrProbe.parseParams({ repo: 'https://github.com/acme/widgets', number: 12 })).toThrow()
  expect(() => githubPrProbe.parseParams({ repo: 'acme/widgets', number: 2 ** 31 })).toThrow()
})
