import { expect, test } from 'bun:test'

import { canonicalGithubRepo, githubReviewerWorkKey } from './github-repo'

test('review identity and GitHub channel workspace resolve to the same reviewer work key', () => {
  const reviewIdentity = { repo: 'Acme/Widgets', pullRequest: 42 }
  const workspace = 'acme/widgets'

  expect(canonicalGithubRepo(reviewIdentity.repo)).toBe(canonicalGithubRepo(workspace))
  expect(githubReviewerWorkKey(reviewIdentity.repo, reviewIdentity.pullRequest)).toBe(
    githubReviewerWorkKey(workspace, 42),
  )
})
