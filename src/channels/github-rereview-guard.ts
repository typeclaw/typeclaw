import { classifyReviewClaim, isPositiveWarnCloseout } from './github-review-claim'
import { isGithubReviewRoundComplete } from './github-review-verdict-coordinator'
import type { GithubReviewFollowupRound } from './types'
import type { ReviewStateResult } from './types'

// The re-review stranding guard. A bot that resolves a review thread (or posts a
// close-out ack) while it still holds its own sticky CHANGES_REQUESTED leaves the
// PR blocked forever — the resolve/ack carries no review state, so GitHub's
// reviewDecision never clears (PR #644). This guard blocks that close-out and
// tells the model to land a formal APPROVE / dismissal first.
//
// It is the same enforcement seam as the false-receipt guard and the
// resolve-thread author check: BLOCK and instruct, never act on the model's
// behalf — the runtime cannot prove a semantic approval from "one thread closed".

export type RereviewGuardInput = {
  adapter: string
  chat: string
  thread: string | null
  text: string | undefined
  wantsResolve: boolean
  // A mid-turn status reply (more_work_this_turn:true) is not the turn's receipt,
  // so it suppresses the warn-tier escalation below — but never the explicit
  // resolve, which is a real mutation. Mirrors the false-receipt guard's rule.
  moreWorkThisTurn: boolean
  getReviewState: (req: { adapter: 'github'; workspace: string; chat: string }) => Promise<ReviewStateResult>
  workspace: string
  round?: GithubReviewFollowupRound
}

export type RereviewGuardDecision = { block: false } | { block: true; reason: string }

const ALLOW: RereviewGuardDecision = { block: false }

export async function evaluateRereviewGuard(input: RereviewGuardInput): Promise<RereviewGuardDecision> {
  if (input.adapter !== 'github') return ALLOW
  if (!/^pr:\d+$/.test(input.chat)) return ALLOW
  // No `thread === null` exemption: a top-level PR comment carries no thread but
  // a close-out ack in it ("Verified — that closes it") strands the block just
  // as a thread reply would. Only the resolve ACTION needs a thread; the
  // text-claim path fires regardless (caught by isCloseoutAttempt below).
  if (!isCloseoutAttempt(input)) return ALLOW

  const round = matchingRound(input)
  if (round !== null && !isGithubReviewRoundComplete(round) && round.carrierThread !== input.thread) {
    return { block: true, reason: WAIT_FOR_ROUND_CARRIER }
  }

  const state = await input.getReviewState({ adapter: 'github', workspace: input.workspace, chat: input.chat })

  // Fail closed: an unverifiable review state is treated as a live block, so the
  // bot never strands a re-review on a transient API failure.
  if (!state.ok) return { block: true, reason: unverifiableReason(state.error) }
  if (!state.selfBlocking) {
    if (state.reviewDecision === 'REVIEW_REQUIRED' && isPositiveWarnCloseout(input.text ?? '')) {
      return { block: true, reason: INITIAL_REVIEW_REQUIRED }
    }
    return ALLOW
  }

  if (round !== null && isGithubReviewRoundComplete(round) && input.wantsResolve && input.thread !== null) {
    return ALLOW
  }

  return { block: true, reason: state.approve ? STICKY_BLOCK_APPROVE_ENABLED : STICKY_BLOCK_APPROVE_DISABLED }
}

function matchingRound(input: RereviewGuardInput): GithubReviewFollowupRound | null {
  const round = input.round
  if (round === undefined) return null
  const match = /^pr:(\d+)$/.exec(input.chat)
  if (match === null || Number(match[1]) !== round.prNumber || input.workspace !== round.workspace) return null
  return round
}

// Trigger when the model asks to resolve a thread (only meaningful with a
// thread), OR when its reply reads as a close-out/verdict claim — the latter
// strands the block whether or not it sits in a thread, so it fires for any PR
// chat. Unlike the pure false-receipt classifier, this guard has the objective
// review state available, so an approval-shaped warn reply ("looks good"/"lgtm")
// is escalated to a closeout too: it only blocks when the bot actually holds a
// live CHANGES_REQUESTED, so casual approval-shaped chatter on an unblocked PR
// still posts. Only POSITIVE warn phrases escalate — negative ones ("needs
// changes", "still needs work") re-assert a block rather than strand it, so they
// stay non-firing. `more_work_this_turn:true` exempts the warn escalation
// (mid-turn planning, not the receipt), but never the explicit resolve action.
// Plain `ignore` text never fires.
function isCloseoutAttempt(input: RereviewGuardInput): boolean {
  if (input.wantsResolve && input.thread !== null) return true
  const claim = classifyReviewClaim(input.text ?? '')
  if (claim === 'block-resolve' || claim === 'block-approve') return true
  return !input.moreWorkThisTurn && isPositiveWarnCloseout(input.text ?? '')
}

function unverifiableReason(error: string): string {
  return (
    'Could not verify whether your prior CHANGES_REQUESTED on this PR is still live ' +
    `(${error}). Refusing to close out the thread while the block state is unknown — ` +
    'retry once the GitHub API is reachable, or land a formal review verdict first.'
  )
}

const STICKY_BLOCK_APPROVE_ENABLED =
  'You still hold a CHANGES_REQUESTED on this PR. Resolving the thread (or posting a close-out ack) ' +
  'does NOT clear it — only a fresh formal review does. Submit `APPROVE` via ' +
  '`gh api -X POST /repos/<owner>/<repo>/pulls/<N>/reviews` (event: APPROVE) if the blockers are fixed, ' +
  'or `REQUEST_CHANGES` if not, THEN resolve the thread / reply.'

const STICKY_BLOCK_APPROVE_DISABLED =
  'You still hold a CHANGES_REQUESTED on this PR and resolving the thread does NOT clear it. ' +
  'Approval is disabled for this agent (channels.github.review.approve: false), so you cannot APPROVE — ' +
  'dismiss your prior review via ' +
  '`gh api -X PUT /repos/<owner>/<repo>/pulls/<N>/reviews/<review_id>/dismissals -f message="..." -f event=DISMISS` ' +
  'if the blockers are fixed (or submit REQUEST_CHANGES if not), THEN resolve the thread / reply.'

const INITIAL_REVIEW_REQUIRED =
  'This PR still requires a formal GitHub review. A flat `LGTM` / `looks good` PR comment does not create ' +
  'review state, so it leaves the PR awaiting review. Submit the reviewer verdict via ' +
  '`gh api -X POST /repos/<owner>/<repo>/pulls/<N>/reviews` with event `APPROVE` when approval is enabled, ' +
  'or event `COMMENT` when approval is disabled, then narrate only if needed.'

const WAIT_FOR_ROUND_CARRIER =
  'Another sibling thread session is designated to submit the formal verdict for this review follow-up round. ' +
  'Do not submit a verdict or close out this thread yet. Wait for the verified sibling verdict activity, then resolve only this thread.'
