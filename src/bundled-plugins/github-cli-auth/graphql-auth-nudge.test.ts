import { afterEach, describe, expect, test } from 'bun:test'

import type { ContentPart, ToolResult } from '@/plugin'

import { checkGraphqlAuthNudge, GRAPHQL_AUTH_NUDGE_TAG } from './graphql-auth-nudge'

const originalToken = process.env.GH_TOKEN

afterEach(() => {
  if (originalToken === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = originalToken
})

function bashResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

describe('checkGraphqlAuthNudge', () => {
  test('single-owner App auth with no process token explains the repo-scoped mint hint', () => {
    delete process.env.GH_TOKEN
    const result = bashResult('HTTP 401: Bad credentials')

    checkGraphqlAuthNudge({ tool: 'bash', command: 'gh api graphql -f query=...', result })

    expect(textOf(result)).toContain(GRAPHQL_AUTH_NUDGE_TAG)
    expect(textOf(result)).toContain('App credentials are not ambient')
    expect(textOf(result)).toContain('-R owner/repo')
    expect(textOf(result)).not.toContain('multi-owner')
  })

  test('matches the "Resource not accessible by integration" App-auth signature', () => {
    delete process.env.GH_TOKEN
    const result = bashResult('gh: Resource not accessible by integration')

    checkGraphqlAuthNudge({ tool: 'bash', command: 'gh api graphql -f query=...', result })

    expect(textOf(result)).toContain(GRAPHQL_AUTH_NUDGE_TAG)
  })

  test('does not fire when the invocation already carries -R (permission denial, not missing hint)', () => {
    delete process.env.GH_TOKEN
    const dashR = bashResult('gh: Resource not accessible by integration')
    const longRepo = bashResult('HTTP 401: Bad credentials')
    const eqRepo = bashResult('HTTP 401: Bad credentials')

    checkGraphqlAuthNudge({ tool: 'bash', command: 'gh api graphql -R acme/widgets -f query=...', result: dashR })
    checkGraphqlAuthNudge({
      tool: 'bash',
      command: 'gh api graphql --repo acme/widgets -f query=...',
      result: longRepo,
    })
    checkGraphqlAuthNudge({ tool: 'bash', command: 'gh api graphql --repo=acme/widgets -f query=...', result: eqRepo })

    expect(textOf(dashR)).not.toContain(GRAPHQL_AUTH_NUDGE_TAG)
    expect(textOf(longRepo)).not.toContain(GRAPHQL_AUTH_NUDGE_TAG)
    expect(textOf(eqRepo)).not.toContain(GRAPHQL_AUTH_NUDGE_TAG)
  })

  test('does not fire when a token is seeded (graphql already authenticates)', () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const result = bashResult('HTTP 401: Bad credentials')

    checkGraphqlAuthNudge({ tool: 'bash', command: 'gh api graphql -f query=...', result })

    expect(textOf(result)).not.toContain(GRAPHQL_AUTH_NUDGE_TAG)
  })

  test('does not fire on a graphql call that succeeded (no auth-failure signature)', () => {
    delete process.env.GH_TOKEN
    const result = bashResult('{"data":{"repository":{"id":"R_x"}}}')

    checkGraphqlAuthNudge({ tool: 'bash', command: 'gh api graphql -f query=...', result })

    expect(textOf(result)).not.toContain(GRAPHQL_AUTH_NUDGE_TAG)
  })

  test('does not fire on a non-graphql auth failure (REST path handled by tool.before)', () => {
    delete process.env.GH_TOKEN
    const result = bashResult('HTTP 401: Bad credentials')

    checkGraphqlAuthNudge({ tool: 'bash', command: 'gh api /repos/acme/widgets/pulls', result })

    expect(textOf(result)).not.toContain(GRAPHQL_AUTH_NUDGE_TAG)
  })

  test('does not fire on a graphql resolution error (bad node id / missing repo is not auth)', () => {
    delete process.env.GH_TOKEN
    const nodeError = bashResult("gh: Could not resolve to a node with the global id of 'PRRT_bad'")
    const repoError = bashResult("gh: Could not resolve to a Repository with the name 'acme/missing'")

    checkGraphqlAuthNudge({ tool: 'bash', command: 'gh api graphql -f query=...', result: nodeError })
    checkGraphqlAuthNudge({ tool: 'bash', command: 'gh api graphql -f query=...', result: repoError })

    expect(textOf(nodeError)).not.toContain(GRAPHQL_AUTH_NUDGE_TAG)
    expect(textOf(repoError)).not.toContain(GRAPHQL_AUTH_NUDGE_TAG)
  })

  test('does not double-append when the hint is already present', () => {
    delete process.env.GH_TOKEN
    const result = bashResult('HTTP 401')
    checkGraphqlAuthNudge({ tool: 'bash', command: 'gh api graphql -f query=...', result })
    const once = textOf(result)

    checkGraphqlAuthNudge({ tool: 'bash', command: 'gh api graphql -f query=...', result })

    expect(textOf(result)).toBe(once)
  })

  test('ignores non-bash tools', () => {
    delete process.env.GH_TOKEN
    const result = bashResult('HTTP 401: Bad credentials')

    checkGraphqlAuthNudge({ tool: 'read', command: 'gh api graphql', result })

    expect(textOf(result)).not.toContain(GRAPHQL_AUTH_NUDGE_TAG)
  })
})
