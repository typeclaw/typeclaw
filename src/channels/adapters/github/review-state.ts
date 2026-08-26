import type { ReviewStateResolver, ReviewStateResult } from '@/channels/types'

import { describeError } from '../../describe-error'
import type { GithubAuthContext } from './auth'
import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'

// Answers the re-review stranding guard's question: is the bot's latest
// EFFECTIVE formal review on this PR a sticky CHANGES_REQUESTED? GitHub clears a
// same-reviewer CHANGES_REQUESTED only with a later APPROVED or DISMISSED from
// the same reviewer — a later COMMENTED review does NOT clear it (the PR #644
// trap). So we walk the bot's own reviews in chronological order, ignore
// COMMENTED/PENDING, and read the last decisive one.
export function createGithubReviewStateResolver(deps: {
  token: (context?: GithubAuthContext) => Promise<string>
  selfLogin: () => string | null
  approve: () => boolean
  fetchImpl?: typeof fetch
}): ReviewStateResolver {
  const fetchImpl = deps.fetchImpl ?? fetch
  return async (req): Promise<ReviewStateResult> => {
    const approve = deps.approve()
    if (req.adapter !== 'github') {
      return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'unsupported' }
    }
    const target = parseTarget(req.workspace, req.chat)
    if (target === null) {
      return { ok: false, error: `unparseable github PR target (chat=${req.chat})`, code: 'transient' }
    }
    const selfLogin = deps.selfLogin()
    if (selfLogin === null) {
      return { ok: false, error: 'github self-identity not resolved; cannot read review state', code: 'transient' }
    }

    const token = await deps.token({ repoSlug: `${target.owner}/${target.repo}` })
    const [reviews, reviewDecision] = await Promise.all([
      fetchSelfReviews(fetchImpl, token, target, selfLogin),
      fetchReviewDecision(fetchImpl, token, target),
    ])
    if (!reviews.ok) return { ok: false, error: reviews.error, code: reviews.code }
    if (!reviewDecision.ok) return { ok: false, error: reviewDecision.error, code: reviewDecision.code }

    const lastDecisive = reviews.reviews.filter((review) => isDecisive(review.state)).at(-1) ?? null
    const selfBlocking = lastDecisive?.state === 'CHANGES_REQUESTED'
    return {
      ok: true,
      selfBlocking,
      selfBlockingReviewId: selfBlocking ? lastDecisive.id : null,
      approve,
      ...(reviewDecision.reviewDecision !== null ? { reviewDecision: reviewDecision.reviewDecision } : {}),
    }
  }
}

export type SelfReviewBlockingResult =
  | { ok: true; selfBlocking: boolean; selfBlockingReviewId: number | null }
  | { ok: false; error: string; code: 'not-found' | 'permission-denied' | 'transient' }

// Last DECISIVE self review == CHANGES_REQUESTED? (COMMENTED/PENDING ignored, as
// in createGithubReviewStateResolver.) Standalone so the synchronize follow-up
// skips the reviewDecision round-trip the stranding guard needs but this doesn't.
export async function fetchSelfReviewBlocking(deps: {
  token: string
  selfLogin: string
  owner: string
  repo: string
  prNumber: number
  fetchImpl?: typeof fetch
}): Promise<SelfReviewBlockingResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const reviews = await fetchSelfReviews(
    fetchImpl,
    deps.token,
    { owner: deps.owner, repo: deps.repo, prNumber: deps.prNumber },
    deps.selfLogin,
  )
  if (!reviews.ok) return { ok: false, error: reviews.error, code: reviews.code }
  const lastDecisive = reviews.reviews.filter((review) => isDecisive(review.state)).at(-1) ?? null
  const selfBlocking = lastDecisive?.state === 'CHANGES_REQUESTED'
  return { ok: true, selfBlocking, selfBlockingReviewId: selfBlocking ? lastDecisive.id : null }
}

type Target = { owner: string; repo: string; prNumber: number }

function parseTarget(workspace: string, chat: string): Target | null {
  const [owner, repo, ...rest] = workspace.split('/')
  if (owner === undefined || owner === '' || repo === undefined || repo === '' || rest.length > 0) return null
  const m = /^pr:(\d+)$/.exec(chat)
  if (m === null) return null
  const prNumber = Number(m[1])
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null
  return { owner, repo, prNumber }
}

type SelfReviewsResult =
  | { ok: true; reviews: Array<{ state: string; id: number | null }> }
  | { ok: false; error: string; code: 'not-found' | 'permission-denied' | 'transient' }

type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'

type ReviewDecisionResult =
  | { ok: true; reviewDecision: ReviewDecision | null }
  | { ok: false; error: string; code: 'not-found' | 'permission-denied' | 'transient' }

async function fetchSelfReviews(
  fetchImpl: typeof fetch,
  token: string,
  target: Target,
  selfLogin: string,
): Promise<SelfReviewsResult> {
  const reviews: Array<{ state: string; id: number | null }> = []
  let url: string | null =
    `${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}/pulls/${target.prNumber}/reviews?per_page=100`
  while (url !== null) {
    let response: Response
    try {
      response = await fetchImpl(url, { headers: githubJsonHeaders(token) })
    } catch (err) {
      return { ok: false, error: describeError(err), code: 'transient' }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return {
        ok: false,
        error: `GitHub reviews ${response.status}${text !== '' ? `: ${text}` : ''}`,
        code: classifyStatus(response.status),
      }
    }
    const page = (await response.json().catch(() => null)) as ReviewRow[] | null
    if (page === null) return { ok: false, error: 'GitHub reviews returned non-JSON', code: 'transient' }
    for (const row of page) {
      if (typeof row.state !== 'string') continue
      const login = row.user?.login ?? null
      if (login === null) continue
      const isBot = row.user?.type === 'Bot'
      if (!isSelfReviewer(login, isBot, selfLogin)) continue
      const id = typeof row.id === 'number' && Number.isSafeInteger(row.id) && row.id > 0 ? row.id : null
      reviews.push({ state: row.state, id })
    }
    url = nextLink(response.headers.get('link'))
  }
  return { ok: true, reviews }
}

async function fetchReviewDecision(
  fetchImpl: typeof fetch,
  token: string,
  target: Target,
): Promise<ReviewDecisionResult> {
  let response: Response
  try {
    response = await fetchImpl(`${GITHUB_API_BASE}/graphql`, {
      method: 'POST',
      headers: githubJsonHeaders(token),
      body: JSON.stringify({
        query:
          'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewDecision}}}',
        variables: { owner: target.owner, repo: target.repo, number: target.prNumber },
      }),
    })
  } catch (err) {
    return { ok: false, error: describeError(err), code: 'transient' }
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return {
      ok: false,
      error: `GitHub reviewDecision ${response.status}${text !== '' ? `: ${text}` : ''}`,
      code: classifyStatus(response.status),
    }
  }
  const raw = (await response.json().catch(() => null)) as ReviewDecisionResponse | null
  if (raw === null) return { ok: false, error: 'GitHub reviewDecision returned non-JSON', code: 'transient' }
  if (Array.isArray(raw.errors) && raw.errors.length > 0) {
    return {
      ok: false,
      error: `GitHub reviewDecision errors: ${raw.errors.map(describeGraphqlError).join('; ')}`,
      code: 'transient',
    }
  }
  const value = raw.data?.repository?.pullRequest?.reviewDecision ?? null
  if (value === null || isReviewDecision(value)) return { ok: true, reviewDecision: value }
  return { ok: false, error: `GitHub reviewDecision returned unknown value: ${String(value)}`, code: 'transient' }
}

// A formal CHANGES_REQUESTED is sticky until a later APPROVED/DISMISSED; only
// these three states decide the block. COMMENTED and PENDING are non-deciding
// noise that must NOT shadow an earlier CHANGES_REQUESTED.
const DECISIVE = new Set(['CHANGES_REQUESTED', 'APPROVED', 'DISMISSED'])

function isDecisive(state: string): boolean {
  return DECISIVE.has(state)
}

// A GitHub App's own login differs across REST (`slug[bot]`) and GraphQL (bare
// `slug`). The REST reviews endpoint returns `slug[bot]` for the App, but the
// suffix-strip must be gated on the reviewer actually being a Bot: a human User
// can own the bare slug as a login, and stripping `[bot]` off the App's
// selfLogin to match a human would wrongly attribute their review to the bot.
const BOT_LOGIN_SUFFIX = '[bot]'

function isSelfReviewer(login: string, isBot: boolean, selfLogin: string): boolean {
  if (isBot) return normalizeBotLogin(login) === normalizeBotLogin(selfLogin)
  return login === selfLogin
}

function normalizeBotLogin(login: string): string {
  return login.endsWith(BOT_LOGIN_SUFFIX) ? login.slice(0, -BOT_LOGIN_SUFFIX.length) : login
}

function nextLink(linkHeader: string | null): string | null {
  if (linkHeader === null) return null
  for (const part of linkHeader.split(',')) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part)
    if (m !== null) return m[1] ?? null
  }
  return null
}

function classifyStatus(status: number): 'not-found' | 'permission-denied' | 'transient' {
  if (status === 401 || status === 403) return 'permission-denied'
  if (status === 404) return 'not-found'
  return 'transient'
}

type ReviewRow = { id?: number; state?: unknown; user?: { login?: string; type?: string } }

type ReviewDecisionResponse = {
  data?: { repository?: { pullRequest?: { reviewDecision?: unknown } | null } | null }
  errors?: Array<{ message?: unknown }>
}

function isReviewDecision(value: unknown): value is ReviewDecision {
  return value === 'APPROVED' || value === 'CHANGES_REQUESTED' || value === 'REVIEW_REQUIRED'
}

function describeGraphqlError(error: { message?: unknown }): string {
  return typeof error.message === 'string' ? error.message : JSON.stringify(error)
}
