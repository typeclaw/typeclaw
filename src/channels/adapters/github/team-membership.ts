// Best-effort "is the bot a member of this team?" lookup, used to gate
// `pull_request.review_requested` inbounds when GitHub assigns a *team*
// rather than a user as the reviewer.
//
// Cached per (org, slug, login) for the adapter's lifetime: team membership
// changes rarely, and a stale cache costs us one missed review (the next
// request rebuilds it). Errors fall closed (return false): we'd rather drop
// a real review request than wake the agent on a team the bot isn't in.

import type { GithubAuthContext } from './auth'

const ACTIVE_MEMBERSHIP_STATE = 'active'

export type TeamMembershipChecker = (input: {
  org: string
  slug: string
  login: string
  requireCurrent?: true
}) => Promise<boolean>

export function createTeamMembershipChecker(options: {
  token: (context?: GithubAuthContext) => Promise<string>
  fetchImpl?: typeof fetch
}): TeamMembershipChecker {
  const fetchImpl = options.fetchImpl ?? fetch
  const cache = new Map<string, boolean>()

  return async ({ org, slug, login, requireCurrent }) => {
    // Withdrawal bypasses cached membership and retries transient failures.
    // Definitive access denials cannot establish a qualifying team request,
    // matching the review-trigger path's fail-closed membership convention.
    if (requireCurrent) return lookup(fetchImpl, await options.token({ owner: org }), org, slug, login, true)
    const key = `${org}/${slug}#${login}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached

    const result = await lookup(fetchImpl, await options.token({ owner: org }), org, slug, login)
    cache.set(key, result)
    return result
  }
}

async function lookup(
  fetchImpl: typeof fetch,
  token: string,
  org: string,
  slug: string,
  login: string,
  requireCurrent = false,
): Promise<boolean> {
  const url = `https://api.github.com/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/memberships/${encodeURIComponent(login)}`
  let res: Response
  try {
    res = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    })
  } catch (error) {
    if (requireCurrent) throw error
    return false
  }
  if (res.status === 403 || res.status === 404) return false
  if (!res.ok) {
    if (requireCurrent) throw new Error(`GitHub team membership ${res.status}`)
    return false
  }
  const body = (await res.json().catch(() => null)) as { state?: unknown } | null
  if (requireCurrent && body?.state !== 'active' && body?.state !== 'pending')
    throw new Error('GitHub team membership missing or invalid state')
  return typeof body?.state === 'string' && body.state === ACTIVE_MEMBERSHIP_STATE
}
