import type {
  ReviewFinding,
  ReviewSubmitter,
  SubmitReviewErrorCode,
  SubmitReviewRequest,
  SubmitReviewResult,
} from '@/channels/types'

import type { GithubAuthContext } from './auth'
import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'

export function createGithubReviewSubmitter(deps: {
  token: (context?: GithubAuthContext) => Promise<string>
  allowApprove: () => boolean
  fetchImpl?: typeof fetch
}): ReviewSubmitter {
  const fetchImpl = deps.fetchImpl ?? fetch
  return async (req): Promise<SubmitReviewResult> => {
    if (req.adapter !== 'github') {
      return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'unsupported' }
    }
    const target = parseTarget(req)
    if (target === null) {
      return {
        ok: false,
        error: `unparseable github review target (workspace=${req.workspace}, chat=${req.chat})`,
        code: 'transient',
      }
    }

    const token = await deps.token({ repoSlug: `${target.owner}/${target.repo}` })
    const pr = await fetchPull(fetchImpl, token, target)
    if (!pr.ok) return pr
    const anchors = await fetchAnchors(fetchImpl, token, target)
    if (!anchors.ok) return anchors

    const partitioned = partitionComments(req.comments, anchors.anchors)
    const downgraded = req.event === 'APPROVE' && !deps.allowApprove()
    const event = downgraded ? 'COMMENT' : req.event
    const body = appendReanchored(req.body, partitioned.reanchored)
    const posted = await postReview(fetchImpl, token, target, {
      event,
      body,
      commitId: pr.headSha,
      comments: partitioned.inline,
    })
    if (!posted.ok) return posted

    const verified = await verifyReview(fetchImpl, token, target)
    if (!verified.ok) return verified
    return {
      ok: true,
      reviewId: verified.reviewId,
      state: verified.state,
      ...(downgraded ? { downgraded: true } : {}),
      ...(partitioned.reanchored.length > 0 ? { reanchored: partitioned.reanchored } : {}),
    }
  }
}

type ReviewTarget = { owner: string; repo: string; prNumber: number }

function parseTarget(req: SubmitReviewRequest): ReviewTarget | null {
  const [owner, repo, ...rest] = req.workspace.split('/')
  if (owner === undefined || owner === '' || repo === undefined || repo === '' || rest.length > 0) return null
  const prMatch = /^pr:(\d+)$/.exec(req.chat)
  if (prMatch === null) return null
  const prNumber = parseDecimalId(prMatch[1])
  if (prNumber === null) return null
  return { owner, repo, prNumber }
}

// Strict decimal-id parse: `Number()` would coerce '' -> 0, '1e2' -> 100, and
// silently round ids past 2^53. Demand plain safe-integer digits so malformed
// PR ids fail closed instead of posting to a collided target.
function parseDecimalId(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : null
}

async function fetchPull(
  fetchImpl: typeof fetch,
  token: string,
  target: ReviewTarget,
): Promise<{ ok: true; headSha: string } | (SubmitReviewResult & { ok: false })> {
  const response = await githubFetch(fetchImpl, token, pullUrl(target))
  if (!response.ok) return responseError(response, 'GitHub pull request fetch')
  const body = (await response.json().catch(() => null)) as PullResponse | null
  if (typeof body?.head?.sha !== 'string' || body.head.sha === '') {
    return { ok: false, error: 'GitHub pull request response missing head.sha', code: 'transient' }
  }
  return { ok: true, headSha: body.head.sha }
}

async function fetchAnchors(
  fetchImpl: typeof fetch,
  token: string,
  target: ReviewTarget,
): Promise<{ ok: true; anchors: Set<string> } | (SubmitReviewResult & { ok: false })> {
  const response = await githubFetch(fetchImpl, token, `${pullUrl(target)}/files?per_page=100`)
  if (!response.ok) return responseError(response, 'GitHub pull request files fetch')
  const body = (await response.json().catch(() => null)) as PullFilesResponse | null
  if (!Array.isArray(body))
    return { ok: false, error: 'GitHub pull request files response was not an array', code: 'transient' }
  const anchors = new Set<string>()
  for (const file of body) {
    if (typeof file.filename === 'string' && typeof file.patch === 'string')
      addPatchAnchors(anchors, file.filename, file.patch)
  }
  return { ok: true, anchors }
}

function addPatchAnchors(anchors: Set<string>, path: string, patch: string): void {
  let left = 0
  let right = 0
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk !== null) {
      left = Number(hunk[1])
      right = Number(hunk[2])
      continue
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue
    if (raw.startsWith('+')) {
      anchors.add(anchorKey(path, right, 'RIGHT'))
      right += 1
    } else if (raw.startsWith('-')) {
      anchors.add(anchorKey(path, left, 'LEFT'))
      left += 1
    } else if (raw.startsWith(' ')) {
      anchors.add(anchorKey(path, right, 'RIGHT'))
      left += 1
      right += 1
    }
  }
}

function partitionComments(
  comments: readonly ReviewFinding[],
  anchors: ReadonlySet<string>,
): { inline: ReviewFinding[]; reanchored: ReviewFinding[] } {
  const inline: ReviewFinding[] = []
  const reanchored: ReviewFinding[] = []
  for (const comment of comments) {
    const side = comment.side ?? 'RIGHT'
    const lineOk = anchors.has(anchorKey(comment.path, comment.line, side))
    const startOk =
      comment.startLine === undefined ||
      anchors.has(anchorKey(comment.path, comment.startLine, comment.startSide ?? side))
    if (lineOk && startOk) inline.push(comment)
    else reanchored.push(comment)
  }
  return { inline, reanchored }
}

function appendReanchored(body: string, reanchored: readonly ReviewFinding[]): string {
  if (reanchored.length === 0) return body
  const prose = reanchored
    .map((finding) => `- ${finding.path}:${finding.line} (${finding.side ?? 'RIGHT'}): ${finding.body}`)
    .join('\n')
  return `${body}\n\nOut-of-diff findings moved from inline comments:\n${prose}`
}

async function postReview(
  fetchImpl: typeof fetch,
  token: string,
  target: ReviewTarget,
  review: { event: SubmitReviewRequest['event']; body: string; commitId: string; comments: ReviewFinding[] },
): Promise<{ ok: true } | (SubmitReviewResult & { ok: false })> {
  const response = await githubFetch(fetchImpl, token, `${pullUrl(target)}/reviews`, {
    method: 'POST',
    body: JSON.stringify({
      event: review.event,
      body: review.body,
      commit_id: review.commitId,
      comments: review.comments.map(toGithubComment),
    }),
  })
  if (!response.ok) return responseError(response, 'GitHub review submit')
  return { ok: true }
}

function toGithubComment(comment: ReviewFinding): GithubReviewComment {
  return {
    path: comment.path,
    line: comment.line,
    side: comment.side ?? 'RIGHT',
    body: comment.body,
    ...(comment.startLine !== undefined ? { start_line: comment.startLine } : {}),
    ...(comment.startSide !== undefined ? { start_side: comment.startSide } : {}),
  }
}

async function verifyReview(
  fetchImpl: typeof fetch,
  token: string,
  target: ReviewTarget,
): Promise<{ ok: true; reviewId: number; state: string } | (SubmitReviewResult & { ok: false })> {
  const response = await githubFetch(fetchImpl, token, `${pullUrl(target)}/reviews`)
  if (!response.ok) return responseError(response, 'GitHub review verify')
  const body = (await response.json().catch(() => null)) as ReviewsResponse | null
  const last = Array.isArray(body) ? body.at(-1) : undefined
  if (typeof last?.id !== 'number' || typeof last.state !== 'string') {
    return { ok: false, error: 'GitHub review verification response missing last review id/state', code: 'transient' }
  }
  return { ok: true, reviewId: last.id, state: last.state }
}

async function githubFetch(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, headers: { ...githubJsonHeaders(token), ...headersRecord(init.headers) } })
  } catch (err) {
    return new Response(err instanceof Error ? err.message : String(err), { status: 599 })
  }
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return headers
}

async function responseError(response: Response, label: string): Promise<SubmitReviewResult & { ok: false }> {
  const text = await response.text().catch(() => '')
  return {
    ok: false,
    error: `${label} ${response.status}${text !== '' ? `: ${text}` : ''}`,
    code: response.status === 422 ? 'bad-anchor' : classifyStatus(response.status),
  }
}

function classifyStatus(status: number): SubmitReviewErrorCode {
  if (status === 401 || status === 403) return 'permission-denied'
  if (status === 404) return 'not-found'
  return 'transient'
}

function pullUrl(target: ReviewTarget): string {
  return `${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}/pulls/${target.prNumber}`
}

function anchorKey(path: string, line: number, side: 'LEFT' | 'RIGHT'): string {
  return `${path}\0${side}\0${line}`
}

type PullResponse = { head?: { sha?: unknown } }
type PullFilesResponse = Array<{ filename?: unknown; patch?: unknown }>
type ReviewsResponse = Array<{ id?: unknown; state?: unknown }>
type GithubReviewComment = {
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  body: string
  start_line?: number
  start_side?: 'LEFT' | 'RIGHT'
}
