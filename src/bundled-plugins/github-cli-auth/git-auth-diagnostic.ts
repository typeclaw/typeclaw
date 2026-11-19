import { createHash } from 'node:crypto'

import { GITHUB_API_BASE, githubJsonHeaders } from '@/channels/adapters/github/auth-pat'
import type { ToolResult } from '@/plugin'

export type GitAuthCredential = { source: string; token: string }
export type GitAuthLoginResolver = (token: string) => Promise<string | null>

let loginResolverForTests: GitAuthLoginResolver | undefined

export function setGitAuthLoginResolverForTests(resolver: GitAuthLoginResolver | undefined): void {
  loginResolverForTests = resolver
}

export function createGitAuthLoginResolver(
  lookup: GitAuthLoginResolver = async (token) => {
    if (loginResolverForTests !== undefined) return await loginResolverForTests(token)
    const response = await fetch(`${GITHUB_API_BASE}/user`, {
      headers: githubJsonHeaders(token),
      signal: AbortSignal.timeout(2_000),
      redirect: 'error',
    })
    if (!response.ok) return null
    const user: unknown = await response.json()
    return user !== null && typeof user === 'object' && 'login' in user && typeof user.login === 'string'
      ? user.login
      : null
  },
): GitAuthLoginResolver {
  const cache = new Map<string, Promise<string | null>>()
  return (token) => {
    const key = createHash('sha256').update(token).digest('hex')
    let login = cache.get(key)
    if (login === undefined) {
      // Lookup is advisory: neither network errors nor response bodies may replace
      // the git failure or expose a credential through an exception.
      login = Promise.resolve()
        .then(() => lookup(token))
        .catch(() => null)
      cache.set(key, login)
    }
    return login
  }
}

// git's own protocol message when GitHub asked for a login and no askpass or
// credential helper could answer it.
const GITHUB_LOGIN_PROMPT_FAILURE = /could not read Username for 'https:\/\/github\.com'/

const UNBROKERED_GIT_HINT =
  '[github-cli-auth:gitCredential] TypeClaw gave this command no GitHub credential, so git could not answer ' +
  "GitHub's login prompt. This alone does not mean GitHub access is missing. The broker funds clone, fetch, pull, " +
  'push, and ls-remote only when the remote step runs as its own bare command, such as ' +
  '`git -C <dir> fetch origin main` or `cd <dir> && git pull --rebase origin main`. Chained or grouped commands, ' +
  'unrecognized flags, and env prefixes other than GIT_TERMINAL_PROMPT run without one. Run the remote step by ' +
  'itself, then run the local steps separately.'

const UNBROKERED_MULTI_REPO_GIT_HINT =
  '[github-cli-auth:gitCredential] TypeClaw gave this command no GitHub credential because it reads more than one ' +
  'GitHub repository, and one GitHub App token covers a single repository. This alone does not mean GitHub access ' +
  'is missing. Fetch each remote in its own command, such as `git -C <dir> fetch origin` and then ' +
  '`git -C <dir> fetch upstream`.'

export function appendUnbrokeredGitHint(result: ToolResult, options: { multiRepo: boolean }): void {
  // Only authoritative status counts: the tool wrapper reports a failed bash as
  // details.error, while a successful `cat` of an old log can print the same text.
  if (structuredFailure(result) !== true) return
  const text = resultText(result)
  if (GITHUB_LOGIN_PROMPT_FAILURE.test(text)) {
    result.content.push({
      type: 'text',
      text: options.multiRepo ? UNBROKERED_MULTI_REPO_GIT_HINT : UNBROKERED_GIT_HINT,
    })
  }
}

function resultText(result: ToolResult): string {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

// undefined when the result carries no structured status at all.
function structuredFailure(result: ToolResult): boolean | undefined {
  const details = result.details
  if (details === null || typeof details !== 'object') return undefined
  if ('error' in details && typeof details.error === 'string') return true
  if ('exitCode' in details && typeof details.exitCode === 'number') return details.exitCode !== 0
  return undefined
}

export async function appendGitAuthDiagnostic(options: {
  result: ToolResult
  credentials: readonly GitAuthCredential[]
  ghCredential?: GitAuthCredential
  push: boolean
  resolveLogin: GitAuthLoginResolver
}): Promise<void> {
  const { result } = options
  const text = resultText(result)
  const failed = structuredFailure(result) ?? /Command (?:failed|exited) with (?:exit )?code [1-9]\d*/i.test(text)
  if (!failed) return
  // These are git/GitHub protocol errors, not natural-language intent matching.
  if (
    !/\b(?:401|403)\b|Permission to .+ denied to |Authentication failed|Invalid username or password|Resource not accessible/i.test(
      text,
    ) &&
    !(options.push && /Repository not found/i.test(text))
  )
    return

  const used = await Promise.all(
    options.credentials.map(async (credential) => ({
      source: credential.source,
      login: (await options.resolveLogin(credential.token)) ?? 'unknown',
    })),
  )
  let advice = `[github-cli-auth:gitCredential] Git used ${used.map(({ source, login }) => `${source} (login: ${login})`).join('; ')}.`
  if (options.ghCredential !== undefined) {
    const ghLogin = (await options.resolveLogin(options.ghCredential.token)) ?? 'unknown'
    if (used.some(({ login }) => login !== ghLogin)) {
      advice += ` gh for this repo would use ${options.ghCredential.source} (login: ${ghLogin}).`
    }
  }
  advice +=
    ' Operator: fix or remove the mismatched credential (github in secrets.json for the repo token, GH_TOKEN in the agent .env for the declared PAT), then run typeclaw restart. The host gh login never funds git push.'
  // Do not trust lookup output to be secret-free, even when provided by /user.
  for (const credential of [...options.credentials, ...(options.ghCredential ? [options.ghCredential] : [])]) {
    advice = advice.replaceAll(credential.token, '[redacted]')
  }
  result.content.push({ type: 'text', text: advice })
}
