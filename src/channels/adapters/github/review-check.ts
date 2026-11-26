import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  type PersistedReviewCheckLease,
  REVIEW_CHECK_NAME,
  type ReviewCheckFinding,
  type ReviewCheckKey,
  type ReviewCheckLeaseStore,
  type ReviewCheckOutcome,
  type ReviewCheckProgress,
  type ReviewCheckPublisher,
  type ReviewCheckPublishResult,
  type ReviewCheckRef,
  type ReviewCheckTiming,
  type ReviewCheckVerdictDetails,
} from '@/channels/github-review-check'

import { describeError } from '../../describe-error'
import type { GithubAuthContext } from './auth'
import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'
import { classifyGithubLookupFailure } from './lookup-failure'

// After a 401/403/404 the repo is skipped for this long, so a missing
// permission costs one warning per window instead of one failed call per review.
export const REVIEW_CHECK_DENIAL_TTL_MS = 60 * 60_000

const STATUS_DESCRIPTION_MAX = 140

const GITHUB_WEB_BASE = 'https://github.com'

// Findings kept with a persisted outcome; the rest is only counted.
export const REVIEW_CHECK_MAX_FINDINGS = 20

// Progress holds the per-commit publish lock the completion needs, so a stalled
// progress request is aborted rather than left to block the verdict.
export const REVIEW_CHECK_PROGRESS_TIMEOUT_MS = 15_000
const FINDING_TITLE_MAX = 100

// The check is named after the agent's GitHub identity (an App's `slug[bot]`
// login shows as `slug`), so a PR reviewed by several agents gets one check per
// agent. Before the identity is known the generic name is used.
export function reviewCheckName(selfLogin: string | null): string {
  const name = selfLogin?.replace(/\[bot\]$/i, '').trim()
  return name !== undefined && name !== '' ? name : REVIEW_CHECK_NAME
}

export function createGithubReviewCheckPublisher(deps: {
  token: (context?: GithubAuthContext) => Promise<string>
  authType: 'pat' | 'app'
  enabled: () => boolean
  checkName: () => string
  logger: { warn: (m: string) => void }
  fetchImpl?: typeof fetch
  now?: () => number
  progressTimeoutMs?: number
}): ReviewCheckPublisher {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const deniedUntil = new Map<string, number>()
  const rateLimitedUntil = new Map<string, number>()

  const isDenied = (repo: string): boolean => (deniedUntil.get(repo) ?? 0) > now()

  const send = async (
    key: ReviewCheckKey,
    path: string,
    method: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<SendResult> => {
    if ((rateLimitedUntil.get(key.repo) ?? 0) > now()) return { kind: 'transient' }
    let response: Response
    try {
      const token = await abortable(deps.token({ repoSlug: key.repo }), signal)
      response = await fetchImpl(`${GITHUB_API_BASE}/repos/${key.repo}${path}`, {
        method,
        headers: githubJsonHeaders(token),
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (err) {
      deps.logger.warn(`[github] review check ${method} ${path} failed for ${key.repo}: ${describeError(err)}`)
      return { kind: 'transient' }
    }
    if (response.ok) return { kind: 'ok', response }
    const text = await response.text().catch(() => '')
    // GitHub reports primary and secondary rate limits as 403 (or 429); those
    // clear on their own, so they must be retried rather than cached as denials.
    const failure = classifyGithubLookupFailure(response, text)
    if (failure === 'rate-limit') {
      const until = rateLimitResetAt(response, now())
      rateLimitedUntil.set(key.repo, until)
      deps.logger.warn(
        `[github] review check ${method} ${path} rate-limited for ${key.repo}; retrying after ${new Date(until).toISOString()}`,
      )
      return { kind: 'transient' }
    }
    if (failure === 'denied') {
      deniedUntil.set(key.repo, now() + REVIEW_CHECK_DENIAL_TTL_MS)
      deps.logger.warn(
        `[github] review check skipped for ${key.repo}: GitHub returned ${response.status}. ` +
          `${permissionHint(deps.authType)} Reviews still post; set channels.github.review.check to false to silence this.`,
      )
      return { kind: 'denied' }
    }
    deps.logger.warn(`[github] review check ${method} ${path} failed for ${key.repo}: ${response.status} ${text}`)
    return { kind: 'transient' }
  }

  return {
    name: deps.checkName,

    async start(key) {
      if (!deps.enabled() || isDenied(key.repo)) return null
      if (deps.authType === 'app') {
        const result = await send(key, '/check-runs', 'POST', {
          name: deps.checkName(),
          head_sha: key.headSha,
          status: 'in_progress',
          started_at: new Date(now()).toISOString(),
          output: renderProgress(key, { phase: 'reviewing', startedAt: now(), now: now(), activity: null }),
        })
        if (result.kind !== 'ok') return null
        const body = (await result.response.json().catch(() => null)) as { id?: unknown } | null
        return typeof body?.id === 'number' ? { mode: 'check-run', checkRunId: body.id } : null
      }
      const context = deps.checkName()
      const result = await send(key, `/statuses/${key.headSha}`, 'POST', {
        state: 'pending',
        context,
        description: 'TypeClaw is reviewing this commit',
      })
      return result.kind === 'ok' ? { mode: 'status', context } : null
    },

    async progress(key, ref, progress) {
      if (ref.mode !== 'check-run' || !deps.enabled() || isDenied(key.repo)) return
      await send(
        key,
        `/check-runs/${ref.checkRunId}`,
        'PATCH',
        { output: renderProgress(key, progress) },
        AbortSignal.timeout(deps.progressTimeoutMs ?? REVIEW_CHECK_PROGRESS_TIMEOUT_MS),
      )
    },

    async finish(key, ref, outcome, timing) {
      if (ref === null && (outcome.kind !== 'verdict' || !deps.enabled() || isDenied(key.repo))) return 'published'
      const mode: ReviewCheckRef['mode'] = ref?.mode ?? (deps.authType === 'app' ? 'check-run' : 'status')
      const reviewUrl = outcome.kind === 'verdict' ? reviewLink(key, outcome.details) : undefined
      if (mode === 'status') {
        return publishResult(
          await send(key, `/statuses/${key.headSha}`, 'POST', {
            state: statusState(outcome),
            // A pending status is only replaced by one with the same context, so
            // finish under the name it started with (leases from before
            // per-agent names carry none and started as the generic name).
            context: ref?.mode === 'status' ? (ref.context ?? REVIEW_CHECK_NAME) : deps.checkName(),
            description: truncate(describeOutcome(outcome), STATUS_DESCRIPTION_MAX),
            ...(reviewUrl !== undefined ? { target_url: reviewUrl } : {}),
          }),
        )
      }
      const completion = {
        status: 'completed',
        conclusion: checkRunConclusion(outcome),
        completed_at: new Date(now()).toISOString(),
        output: renderOutcome(key, outcome, timing),
        ...(reviewUrl !== undefined ? { details_url: reviewUrl } : {}),
      }
      if (ref?.mode === 'check-run') {
        return publishResult(await send(key, `/check-runs/${ref.checkRunId}`, 'PATCH', completion))
      }
      return publishResult(
        await send(key, '/check-runs', 'POST', { name: deps.checkName(), head_sha: key.headSha, ...completion }),
      )
    },
  }
}

export function reviewCheckDetails(
  reviewId: number,
  comments: readonly { path: string; line: number; side?: 'LEFT' | 'RIGHT'; body: string }[],
): ReviewCheckVerdictDetails {
  return {
    reviewId,
    findings: comments.slice(0, REVIEW_CHECK_MAX_FINDINGS).map((comment) => ({
      path: comment.path,
      line: comment.line,
      ...(comment.side === 'LEFT' ? { side: 'LEFT' as const } : {}),
      title: findingTitle(comment.body),
    })),
    findingCount: comments.length,
  }
}

export function reviewCheckLeasePath(agentDir: string): string {
  return join(agentDir, 'channels', 'github-review-checks.json')
}

export function createReviewCheckLeaseStore(agentDir: string): ReviewCheckLeaseStore {
  const path = reviewCheckLeasePath(agentDir)
  return {
    async load() {
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
      const parsed = JSON.parse(raw) as { leases?: unknown }
      return Array.isArray(parsed.leases) ? parsed.leases.filter(isPersistedLease) : []
    },
    async save(leases) {
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      await writeFile(tmp, `${JSON.stringify({ version: 1, leases }, null, 2)}\n`)
      await rename(tmp, path)
    },
  }
}

const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000

function rateLimitResetAt(response: Response, now: number): number {
  const retryAfter = Number(response.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1000
  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset * 1000 > now) return reset * 1000
  return now + DEFAULT_RATE_LIMIT_BACKOFF_MS
}

type SendResult = { kind: 'ok'; response: Response } | { kind: 'denied' } | { kind: 'transient' }

// A denial cannot be fixed by retrying, so only a transient failure keeps the
// outcome pending.
function publishResult(result: SendResult): ReviewCheckPublishResult {
  return result.kind === 'transient' ? 'retry' : 'published'
}

function checkRunConclusion(outcome: ReviewCheckOutcome): 'success' | 'failure' | 'neutral' {
  if (outcome.kind === 'failed') return 'failure'
  if (outcome.kind === 'cancelled') return 'neutral'
  if (outcome.state === 'APPROVED') return 'success'
  if (outcome.state === 'CHANGES_REQUESTED') return 'failure'
  return 'neutral'
}

// Commit statuses have no neutral state; a cancellation or comment-only review
// must not block a merge, so both map to success with an explicit description.
function statusState(outcome: ReviewCheckOutcome): 'success' | 'failure' {
  return checkRunConclusion(outcome) === 'failure' ? 'failure' : 'success'
}

function describeOutcome(outcome: ReviewCheckOutcome): string {
  if (outcome.kind === 'failed') return `Review failed: ${outcome.reason}`
  if (outcome.kind === 'cancelled') return `Not reviewed: ${outcome.reason}`
  if (outcome.state === 'APPROVED') return 'TypeClaw approved this commit'
  if (outcome.state === 'CHANGES_REQUESTED') return 'TypeClaw requested changes'
  return 'TypeClaw left review comments'
}

type CheckOutput = { title: string; summary: string }

function renderProgress(key: ReviewCheckKey, progress: ReviewCheckProgress): CheckOutput {
  const elapsedMs = progress.now - progress.startedAt
  const elapsed = elapsedMs >= 1000 ? ` (${formatDuration(elapsedMs)})` : ''
  const commit = shortSha(key.headSha)
  if (progress.phase === 'posting') {
    return {
      title: `Posting review…${elapsed}`,
      summary: `The review of ${commit} is written and is being posted to the pull request.`,
    }
  }
  const activity = progress.activity
  if (activity === null || !activity.started) {
    const intro =
      elapsedMs >= 1000
        ? `TypeClaw started reviewing ${commit} **${formatDuration(elapsedMs)} ago**.`
        : `TypeClaw started reviewing ${commit}.`
    return { title: `Reviewing…${elapsed}`, summary: `${intro}\n\n⏳ Reading the pull request` }
  }
  const kind = progress.reviewKind === 're-review' ? ' · re-review after new commits' : ''
  const files = activity.filesRead > 0 ? ` (${plural(activity.filesRead, 'file')})` : ''
  const steps: [string, string][] = [
    ['✅', 'Read the pull request'],
    [stepMark(activity.current === 'reading', activity.filesRead > 0), `Read the code${files}`],
    [stepMark(activity.current === 'commands', activity.commandsRun > 0), 'Running commands (tests, builds)'],
    [activity.current === 'writing' ? '⏳' : '⬜', 'Write up findings'],
    ['⬜', 'Post review'],
  ]
  const lines = [
    `TypeClaw is reviewing ${commit}${kind}`,
    '',
    '| | Step |',
    '|---|---|',
    ...steps.map(([mark, label]) => `| ${mark} | ${label} |`),
  ]
  if (activity.lastActivityAt !== null) {
    lines.push('', `Last activity: ${formatAgo(progress.now - activity.lastActivityAt)}`)
  }
  return { title: `Reviewing…${elapsed}`, summary: lines.join('\n') }
}

function stepMark(active: boolean, done: boolean): string {
  if (active) return '⏳'
  return done ? '✅' : '⬜'
}

function renderOutcome(key: ReviewCheckKey, outcome: ReviewCheckOutcome, timing?: ReviewCheckTiming): CheckOutput {
  const commit = shortSha(key.headSha)
  const durationMs = timing !== undefined && timing.tracked ? timing.decidedAt - timing.startedAt : 0
  const after = durationMs >= 1000 ? ` after a ${formatDuration(durationMs)} review` : ''
  if (outcome.kind === 'failed') {
    const stopped = durationMs >= 1000 ? ` stopped after ${formatDuration(durationMs)}` : ' stopped'
    return {
      title: "Review didn't finish",
      summary: [
        `The review of ${commit}${stopped} without posting a result.`,
        '',
        `Reason: ${sentence(outcome.reason)}`,
        'To retry, re-request a review from TypeClaw.',
      ].join('\n'),
    }
  }
  if (outcome.kind === 'cancelled') {
    return {
      title: 'Review skipped',
      summary: [
        `TypeClaw stopped reviewing ${commit} before posting a result.`,
        '',
        `Reason: ${sentence(outcome.reason)}`,
        'To review it later, re-request a review from TypeClaw.',
      ].join('\n'),
    }
  }
  const findings = outcome.details?.findings ?? []
  const count = Math.max(outcome.details?.findingCount ?? 0, findings.length)
  const reviewUrl = reviewLink(key, outcome.details)
  const sections: string[] = []
  let title: string
  if (outcome.state === 'APPROVED') {
    title = 'Approved'
    sections.push(`TypeClaw approved ${commit}${after}.`)
    if (count === 0) sections.push('No blocking issues found.')
  } else if (outcome.state === 'CHANGES_REQUESTED') {
    title = count > 0 ? `Changes requested · ${plural(count, 'finding')}` : 'Changes requested'
    sections.push(`TypeClaw requested changes on ${commit}${after}.`)
  } else {
    title = count > 0 ? `Reviewed with comments · ${plural(count, 'note')}` : 'Reviewed with comments'
    sections.push(`TypeClaw left non-blocking comments on ${commit}${after}.`)
  }
  if (findings.length > 0) {
    const header = outcome.state === 'CHANGES_REQUESTED' ? 'Finding' : 'Note'
    const rows = findings.map((finding) => `| ${findingLocation(key, finding)} | ${tableCell(finding.title)} |`)
    const more = count > findings.length ? [``, `…and ${count - findings.length} more in the review.`] : []
    sections.push([`| File | ${header} |`, '|---|---|', ...rows, ...more].join('\n'))
  }
  if (reviewUrl !== undefined) {
    sections.push(`[${findings.length > 0 ? 'View the full review' : 'View the review'} →](${reviewUrl})`)
  }
  return { title, summary: sections.join('\n\n') }
}

function reviewLink(key: ReviewCheckKey, details: ReviewCheckVerdictDetails | undefined): string | undefined {
  if (details?.reviewId === undefined) return undefined
  return `${pullUrl(key)}#pullrequestreview-${details.reviewId}`
}

function pullUrl(key: ReviewCheckKey): string {
  return `${GITHUB_WEB_BASE}/${key.repo}/pull/${key.pullRequest}`
}

// GitHub anchors a file in the PR diff by the SHA-256 of its path.
function findingLocation(key: ReviewCheckKey, finding: ReviewCheckFinding): string {
  const anchor = createHash('sha256').update(finding.path).digest('hex')
  const label = `${finding.path}:${finding.line}`.replaceAll('`', '')
  const side = finding.side === 'LEFT' ? 'L' : 'R'
  return `[\`${label}\`](${pullUrl(key)}/files#diff-${anchor}${side}${finding.line})`
}

// The first meaningful line of a review comment, stripped of leading Markdown
// markers so it reads as a one-line title.
function findingTitle(body: string): string {
  const line =
    body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '' && !l.startsWith('```')) ?? ''
  const stripped = line
    .replace(/^(?:(?:#+|>|[-+*](?=\s))\s*)+/, '')
    .replace(/^(\*\*|__)(.+?)\1/, '$2')
    .trim()
  return truncate(stripped === '' ? 'See the review comment' : stripped, FINDING_TITLE_MAX)
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function tableCell(text: string): string {
  return text.replaceAll('|', '\\|').replace(/\s+/g, ' ')
}

function shortSha(sha: string): string {
  return `\`${sha.slice(0, 7)}\``
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min === 0) return `${sec}s`
  return `${min}m ${String(sec).padStart(2, '0')}s`
}

function formatAgo(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return sec === 1 ? '1 second ago' : `${sec} seconds ago`
  const min = Math.floor(sec / 60)
  return min === 1 ? '1 minute ago' : `${min} minutes ago`
}

function permissionHint(authType: 'pat' | 'app'): string {
  return authType === 'app'
    ? 'Grant the GitHub App "Checks: Read and write" permission.'
    : 'The token needs commit status write access (classic PAT `repo:status`, or fine-grained "Commit statuses: Read and write").'
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function isPersistedLease(value: unknown): value is PersistedReviewCheckLease {
  if (typeof value !== 'object' || value === null) return false
  const lease = value as Record<string, unknown>
  const ref = lease.ref as Record<string, unknown> | undefined
  return (
    typeof lease.repo === 'string' &&
    typeof lease.pullRequest === 'number' &&
    typeof lease.headSha === 'string' &&
    typeof lease.startedAt === 'number' &&
    (lease.outcome === undefined || isOutcome(lease.outcome)) &&
    (lease.outcomeAt === undefined || typeof lease.outcomeAt === 'number') &&
    (lease.tracked === undefined || typeof lease.tracked === 'boolean') &&
    (ref === null
      ? lease.outcome !== undefined
      : typeof ref === 'object' &&
        ((ref.mode === 'status' && (ref.context === undefined || typeof ref.context === 'string')) ||
          (ref.mode === 'check-run' && typeof ref.checkRunId === 'number')))
  )
}

function isVerdictDetails(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const details = value as Record<string, unknown>
  return (
    (details.reviewId === undefined || typeof details.reviewId === 'number') &&
    (details.findingCount === undefined || typeof details.findingCount === 'number') &&
    (details.findings === undefined ||
      (Array.isArray(details.findings) &&
        details.findings.every(
          (f: unknown) =>
            typeof f === 'object' &&
            f !== null &&
            typeof (f as Record<string, unknown>).path === 'string' &&
            typeof (f as Record<string, unknown>).line === 'number' &&
            [undefined, 'LEFT', 'RIGHT'].includes((f as Record<string, unknown>).side as string | undefined) &&
            typeof (f as Record<string, unknown>).title === 'string',
        )))
  )
}

function isOutcome(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const outcome = value as Record<string, unknown>
  if (outcome.kind === 'verdict') {
    return (
      (outcome.state === 'APPROVED' || outcome.state === 'CHANGES_REQUESTED' || outcome.state === 'COMMENTED') &&
      (outcome.details === undefined || isVerdictDetails(outcome.details))
    )
  }
  return (outcome.kind === 'failed' || outcome.kind === 'cancelled') && typeof outcome.reason === 'string'
}
