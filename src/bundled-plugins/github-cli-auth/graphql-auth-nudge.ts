import type { ContentPart, ToolResult } from '@/plugin'

import { classifyGhToken } from './token-class'

export const GRAPHQL_AUTH_NUDGE_TAG = 'github-cli-auth:graphqlRepoHint'

const NUDGE_TEXT =
  `\n\n[${GRAPHQL_AUTH_NUDGE_TAG}] That looked like a GitHub auth failure on a ` +
  '`gh api graphql` call. GitHub App credentials are not ambient process tokens, ' +
  'and graphql carries its repo inside the query — not an inspectable path — so ' +
  'TypeClaw needs a repo hint before it can mint a repo-scoped installation token. ' +
  'Re-run with an explicit repo, e.g. `gh api graphql -R owner/repo -f query=...`. ' +
  '`gh api` does not accept `-R/--repo`; TypeClaw consumes it as the mint hint and ' +
  'strips it before running the command with the right token injected.'

// Matched against the command the agent ran, not the tool output: a bash result
// carries only the process output, so gh's "gh auth login" stderr never names the
// graphql call that produced it. The nudge is advisory, so a loose substring match
// is acceptable. Captured through to end of line so we can inspect the SAME
// invocation's flags (see REPO_FLAG).
const GRAPHQL_INVOCATION = /\bgh\b[^\n]*\bapi\b[^\n]*\bgraphql\b[^\n]*/

// `-R foo`, `-R=foo`, `--repo foo`, `--repo=foo`. Word-boundary anchored so a
// path or token merely containing "repo" does not count as a repo hint.
const REPO_FLAG = /(?:^|\s)(?:-R|--repo)(?:[=\s]|$)/

// Concrete auth-rejection strings only — gh / the API emit these when the
// request itself was rejected for auth. Deliberately excludes resolution
// errors like "Could not resolve to ...", which graphql also returns for an
// ordinary bad node ID or missing repo (not auth) and would misroute the nudge.
const AUTH_FAILURE_SIGNATURES = [
  'HTTP 401',
  'Bad credentials',
  'Resource not accessible by integration',
  'Resource not accessible by personal access token',
  'must be authenticated',
  'authentication required',
  'gh auth login',
]

export function checkGraphqlAuthNudge(options: {
  tool: string
  command: string | undefined
  result: ToolResult
}): void {
  if (options.tool !== 'bash' || options.command === undefined) return

  // Only meaningful when no usable process token exists. An operator token or a
  // runtime-seeded PAT means graphql already authenticates, so the advice would
  // be wrong.
  const tokenClass = classifyGhToken(process.env.GH_TOKEN)
  if (tokenClass !== 'none') return

  const text = collectText(options.result.content)
  const invocation = GRAPHQL_INVOCATION.exec(options.command)
  if (invocation === null) return
  if (!AUTH_FAILURE_SIGNATURES.some((sig) => text.includes(sig))) return
  if (text.includes(GRAPHQL_AUTH_NUDGE_TAG)) return

  // The nudge's only message is "add the repo hint". If the failing invocation
  // already carries -R/--repo, the hint is present and the failure is an
  // authorization/permission denial (e.g. the App token lacks a scope), not a
  // missing-repo one — so "re-run with -R" would be misleading, repeated advice.
  if (REPO_FLAG.test(invocation[0])) return

  appendAdviceToContent(options.result.content, NUDGE_TEXT)
}

function collectText(content: readonly ContentPart[]): string {
  return content
    .filter((p): p is ContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}

function appendAdviceToContent(content: ContentPart[], advice: string): void {
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i]
    if (part && part.type === 'text') {
      content[i] = { ...part, text: `${part.text}${advice}` }
      return
    }
  }
  content.push({ type: 'text', text: advice.trimStart() })
}
