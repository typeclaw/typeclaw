import { expect, test } from 'bun:test'

import { detectCreatedGithubTargets } from './detect-created'

const pr = 'https://github.com/acme/widgets/pull/12'
const issue = 'https://github.com/acme/widgets/issues/13'
const prTarget = { kind: 'github-pr', repo: 'acme/widgets', number: 12 } as const
const issueTarget = { kind: 'github-issue', repo: 'acme/widgets', number: 13 } as const
const issueJson = JSON.stringify({ html_url: issue })
const prJson = JSON.stringify({ html_url: pr })
const mutation = `mutation Open($id: ID!) {
  newPr: createPullRequest(input: {repositoryId: $id, title: "새 PR"}) { pullRequest { url } }
  createIssue(input: {repositoryId: $id, title: "새 이슈"}) { issue { url } }
  another: createIssue(input: {repositoryId: $id, title: "두 번째 이슈"}) { issue { url } }
}`
const gqlJson = JSON.stringify({
  data: {
    newPr: { pullRequest: { url: pr } },
    createIssue: { issue: { url: issue } },
    another: { issue: { url: issue } },
  },
})

test.each([
  ['gh pr create --title "새 PR" --body "본문"', `${pr}\n${pr}`, [prTarget]],
  ['gh issue create --title "새 이슈"', 'https://github.com/ACME/Widgets/issues/13\n', [issueTarget]],
  ['gh api --method=POST /repos/acme/widgets/pulls -f title="새 PR"', prJson, [prTarget]],
  ["gh api '/repos/{owner}/{repo}/issues' --raw-field title=bug", issueJson, [issueTarget]],
  ['gh api repos/acme/widgets/issues -XPOST --input request.json', issueJson, [issueTarget]],
  ['gh api repos/acme/widgets/issues --input request.json', issueJson, [issueTarget]],
  [
    'gh api -i repos/acme/widgets/issues -f title=bug',
    `HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n${issueJson}`,
    [issueTarget],
  ],
  [`gh api graphql -f query='${mutation}' -F id=example`, gqlJson, [prTarget, issueTarget]],
])('detects and dedupes created resources from command and stdout %#', (command, output, targets) => {
  expect(detectCreatedGithubTargets(command, output)).toEqual(targets)
})

test.each([
  ['gh pr view 12', pr],
  ['gh pr list', pr],
  ['echo gh pr create', pr],
  ["gh pr create --title 'x'; printf '%s' arbitrary", pr],
  ['gh pr create', `An existing PR is at ${pr}`],
  ['gh issue create', pr],
  ['gh issue create', 'https://git.example.com/acme/widgets/issues/13'],
  ['gh issue create', 'https://github.com/acme/widgets/issues/13#issuecomment-42'],
  ['gh api repos/acme/widgets/issues', issueJson],
  ['gh api repos/acme/widgets/issues --method GET -f title=bug', issueJson],
  ['gh api repos/acme/widgets/issues/13/comments -X POST', issueJson],
  ['gh api repos/acme/other/issues -X POST', issueJson],
  ['gh api repos/acme/widgets/issues --hostname git.example.com -X POST', issueJson],
  ['gh api repos/acme/widgets/pulls -X POST', JSON.stringify({ other: { html_url: pr } })],
  [`gh api graphql -f query='query { createIssue: repository(owner:"acme",name:"widgets") { url } }'`, gqlJson],
  [`gh api graphql -f query='mutation { addComment(input:{body:"createIssue"}) { clientMutationId } }'`, gqlJson],
  [`gh api graphql -X GET -f query='${mutation}'`, gqlJson],
])('does not register targets from unrelated or ambiguous output %#', (command, output) => {
  expect(detectCreatedGithubTargets(command, output)).toEqual([])
})
