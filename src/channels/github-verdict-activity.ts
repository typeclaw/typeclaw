import type { ReviewRoundOutcome } from './github-review-turn-ledger'

// A formal review verdict (APPROVE / REQUEST_CHANGES) that LANDED on a PR, fanned
// out over the broadcast bus so the OTHER live sessions reviewing the same PR
// stand down from posting their own redundant verdict. The duplicate-review
// incident was driven by per-thread session fan-out: N sessions for one PR each
// independently submitted a verdict, blind to the others. The hard idempotency
// lease + cooldown catch overlapping/near-simultaneous submits; this advisory
// signal covers the SEQUENTIAL case — a sibling that wakes after another already
// landed the verdict and would otherwise re-derive and re-submit it.
//
// Routing is by { workspace, prNumber } only (the PR is the unit), with sessionId
// carried so the publisher excludes itself. No channel key — the publish seam is
// the turn-ledger's recordReview(), which has no channel coordinate, and Oracle's
// review favored not expanding plugin coupling just to mirror subagent.completed.

export type PrVerdictActivityPayload = {
  workspace: string
  prNumber: number
  verdict: ReviewRoundOutcome
  sessionId: string
}

export function parsePrVerdictActivityPayload(payload: unknown): PrVerdictActivityPayload | null {
  if (payload === null || typeof payload !== 'object') return null
  const p = payload as {
    kind?: unknown
    workspace?: unknown
    prNumber?: unknown
    verdict?: unknown
    sessionId?: unknown
  }
  if (p.kind !== 'pr.verdict-activity') return null
  if (typeof p.workspace !== 'string' || p.workspace === '') return null
  if (typeof p.prNumber !== 'number' || !Number.isInteger(p.prNumber)) return null
  if (typeof p.sessionId !== 'string' || p.sessionId === '') return null
  const verdict = parseVerdict(p.verdict)
  if (verdict === null) return null
  return { workspace: p.workspace, prNumber: p.prNumber, verdict, sessionId: p.sessionId }
}

function parseVerdict(value: unknown): ReviewRoundOutcome | null {
  return value === 'APPROVE' || value === 'REQUEST_CHANGES' || value === 'DISMISSED' ? value : null
}

// Advisory and deliberately soft (per the design review): it must not suppress a
// genuine flipped verdict or a re-review after new commits/evidence, so it forbids
// only a REDUNDANT same-intent verdict and explicitly preserves inline-thread
// replies. The hard guards remain the correctness boundary; this only trims wasted
// sibling work before they fire.
export function renderPrVerdictStandDownReminder(args: { prNumber: number; verdict: ReviewRoundOutcome }): string {
  if (args.verdict === 'DISMISSED') {
    return (
      `<system-reminder>\n` +
      `The designated carrier verified that its blocking review for PR #${args.prNumber} is DISMISSED. ` +
      `Do not submit another formal verdict for this follow-up round. Close out this session's addressed ` +
      `review thread as normal; leave it open if its concern remains unresolved.\n` +
      `</system-reminder>`
    )
  }
  return (
    `<system-reminder>\n` +
    `Another session in this agent has already posted a formal ${args.verdict} review for PR #${args.prNumber}. ` +
    `Do not submit your own ${args.verdict} (or any redundant verdict) for this PR this turn unless new ` +
    `information genuinely invalidates that result (e.g. new commits, or a different verdict warranted by ` +
    `fresh evidence). You may still reply to inline review comments / threads as normal.\n` +
    `</system-reminder>`
  )
}
