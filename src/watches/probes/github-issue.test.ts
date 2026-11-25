import { expect, test } from 'bun:test'

import { githubIssueProbe } from './github-issue'
import { comment, connection, fixtureProbe } from './github.test-helpers'

test('baselines old comments, ignores the authenticated viewer, and wakes once for a new comment', async () => {
  const run = fixtureProbe(githubIssueProbe, 'issue', { startedAt: undefined })
  const old = comment('old', 1)
  const self = comment('self', 2, 'agent[bot]', true)
  const fresh = comment('fresh', 3, 'bob')
  expect((await run({ state: 'OPEN', stateReason: null, comments: connection(old) })).verdict).toBe('quiet')
  expect((await run({ state: 'OPEN', stateReason: null, comments: connection(old, self) })).verdict).toBe('quiet')
  const issue = { state: 'OPEN', stateReason: null, comments: connection(old, self, fresh) }
  expect(await run(issue)).toMatchObject({ verdict: 'wake', summary: expect.stringContaining('1 comment (@bob)') })
  expect((await run(issue)).verdict).toBe('quiet')
})

test.each([
  ['COMPLETED', 'completed'],
  ['NOT_PLANNED', 'not planned'],
  ['DUPLICATE', 'duplicate'],
])('ends and wakes on a closed issue with reason %s', async (stateReason, label) => {
  const run = fixtureProbe(githubIssueProbe, 'issue')
  expect(await run({ state: 'CLOSED', stateReason, comments: connection() })).toMatchObject({
    verdict: 'done',
    wake: true,
    summary: expect.stringContaining(label),
  })
})
