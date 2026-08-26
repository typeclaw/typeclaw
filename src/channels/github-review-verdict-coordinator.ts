import { randomUUID } from 'node:crypto'

import type { ReviewVerdict } from './github-review-turn-ledger'
import type { GithubReviewFollowupRound } from './types'

// Raw latest-decisive state. DISMISSED is kept DISTINCT from NONE on purpose: a
// genuine dismissal means a fresh same-verdict re-review is legitimate and must
// NOT be shadowed by the read-after-write-lag cache (which only overrides a bare
// NONE — "GitHub shows no decisive review, but we just landed one"). Collapsing
// DISMISSED into NONE would let the lag cache re-strand a dismiss-then-reapprove,
// the exact failure 35287f99 removed.
export type EffectiveVerdict = 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED' | 'NONE'

export type EffectiveApprovalResolver = (target: {
  workspace: string
  prNumber: number
}) => Promise<{ ok: true; effective: EffectiveVerdict } | { ok: false }>

// Resolves the PR's current head commit SHA. Called twice: once in guard() (the
// pre-submit head, resolved AFTER the in-flight lease so the await cannot widen the
// reserve-before-await race) and once in release() (the post-submit head, to detect
// a push that landed during the review). Fails soft (null). A null PRE-submit head
// skips the cache write entirely — the guard falls open to GitHub rather than ever
// stranding a genuine verdict on local memory. A null POST-submit head (or one that
// differs from the pre-submit head) is recorded as the uncertainty sentinel so a
// push-during-review still blocks a same-verdict duplicate for the lag window.
export type HeadShaResolver = (target: { workspace: string; prNumber: number }) => Promise<string | null>

export type ApproveBlock = {
  block: true
  kind: 'concurrent' | 'duplicate' | 'round-ineligible'
  reason: string
  duplicateSource?: 'standing' | 'recent'
  leaseRetained?: boolean
}

// What the reserved call actually published. `formal-landed` is a verified review
// on `/pulls/{n}/reviews`; `fallback-landed` is the PR-level comment a caller posts
// instead when a standing same verdict blocks the formal submit. Both are PR-level
// review publications and must arm the duplicate cooldown, but only the formal one
// may claim a verdict — hence an explicit outcome rather than a boolean `succeeded`,
// which could not tell the two landings apart.
export type ReviewOutputOutcome = 'failed' | 'formal-landed' | 'fallback-landed'

export type ReviewVerdictGuard = {
  guard: (args: {
    callId: string
    workspace: string
    prNumber: number
    verdict: ReviewVerdict
    round?: GithubReviewFollowupRound
    thread?: string | null
    retainDuplicateLease?: boolean
  }) => Promise<ApproveBlock | null>
  release: (args: { callId: string; outcome: ReviewOutputOutcome }) => Promise<void>
  // Arms the read-after-write lag shield for a verdict that landed WITHOUT a prior
  // guard() reservation. The pre-execution detector can miss a review-submission
  // command shape, so the verdict is only recovered post-hoc from the REST result
  // (review-recorder's backstop). Without this, `release()` has no reservation for
  // that callId and never writes `recentLandedByPr`, leaving the next same-commit
  // submission undeduped — the exact gap the backstop was meant to close.
  noteLandedReview: (args: { workspace: string; prNumber: number; verdict: ReviewVerdict }) => Promise<void>
}

// Back-compat alias: the guard now covers REQUEST_CHANGES too, not just APPROVE.
export type ApproveIdempotencyGuard = ReviewVerdictGuard

let processEffectiveResolver: EffectiveApprovalResolver = async () => ({ ok: false })
let processHeadShaResolver: HeadShaResolver = async () => null

// Installs the auth-bearing resolvers used by every auth-neutral review surface
// in this process. The bash interceptor and post_github_review each create a
// lightweight guard facade, but all facades use these resolvers and the single
// module-level lease/landed state below.
export function configureReviewVerdictCoordinator(deps: {
  resolveEffectiveApproval: EffectiveApprovalResolver
  resolveHeadSha: HeadShaResolver
}): void {
  processEffectiveResolver = deps.resolveEffectiveApproval
  processHeadShaResolver = deps.resolveHeadSha
}

export function createSharedReviewVerdictGuard(): ReviewVerdictGuard {
  return createApproveIdempotencyGuard({
    resolveEffectiveApproval: (target) => processEffectiveResolver(target),
    resolveHeadSha: (target) => processHeadShaResolver(target),
  })
}

function duplicateReason(verdict: ReviewVerdict): string {
  if (verdict === 'APPROVE') {
    return (
      'This bot already holds a standing APPROVED review on this pull request. A second APPROVE would ' +
      'post a redundant review. If you intended to change your verdict, request changes or dismiss the ' +
      'prior review instead of re-approving.'
    )
  }
  return (
    'This bot already holds a standing CHANGES_REQUESTED review on this pull request. A second ' +
    'REQUEST_CHANGES would post a redundant blocking review. The prior review is still live — push a fix ' +
    'and APPROVE, or reply in the existing thread, instead of re-requesting changes.'
  )
}

const CONCURRENT_REASON =
  'Another session in this agent is already submitting a formal review verdict for this pull request. ' +
  'Only one verdict may land per PR — do not submit a second review; the in-flight one will post.'

const ROUND_INELIGIBLE_REASON =
  'This review follow-up round assigned the formal verdict to another sibling thread session. ' +
  'Do not submit a formal verdict from this session; wait for the designated sibling verdict activity, then close out only this thread.'

// The standing verdict a fresh attempt would duplicate. APPROVE duplicates a
// standing APPROVED; REQUEST_CHANGES duplicates a standing CHANGES_REQUESTED.
function duplicatesStanding(verdict: ReviewVerdict, effective: EffectiveVerdict): boolean {
  return verdict === 'APPROVE' ? effective === 'APPROVED' : effective === 'CHANGES_REQUESTED'
}

// Whether the duplicate-review cooldown may fire for this GitHub state. Only the
// AMBIGUOUS states qualify: a bare NONE (read lag) or the SAME standing verdict
// (post-indexing fan-out). A DISMISSED or the opposite decisive verdict is a real
// supersession that legitimizes a fresh same-verdict review, so the cooldown is
// skipped — preserving the 35287f99 invariant against stranding a re-verdict.
function cooldownApplies(verdict: ReviewVerdict, effective: EffectiveVerdict): boolean {
  return effective === 'NONE' || duplicatesStanding(verdict, effective)
}

// How long a reservation may sit before it is treated as abandoned. A normal
// `gh` review submit completes in seconds; this only guards against a tool.after
// that never fires (crash mid-command), so it must outlast a slow command yet
// never strand a PR for long.
const LEASE_TTL_MS = 5 * 60_000

// A review round spans human-paced sibling sessions and can legitimately take
// much longer than one command lease. Two hours leaves room for a careful PR
// re-review while still guaranteeing that an abandoned round cannot gate later
// verdicts indefinitely.
export const REVIEW_ROUND_TTL_MS = 2 * 60 * 60_000

// Reply fan-out only needs to cover one reviewer run, its prescribed retry,
// and carrier promotion; keeping it short prevents a later conversation about
// the same review from inheriting an abandoned gate.
export const REPLY_REVIEW_ROUND_TTL_MS = 30 * 60_000

// How long a just-landed verdict suppresses a redundant same-verdict re-submit on
// the same head — a duplicate-review cooldown. It started as a narrow lag shield
// for GitHub's ~10-18s read-after-write lag (the original ~10-18s-apart duplicates
// on PR #691), but the PR #1042 thread fan-out spread same-commit APPROVEs over ~2
// minutes — each one AFTER GitHub had already indexed the prior, so the
// standing-verdict read no longer returned a bare NONE for a lag-only shield to
// catch, yet the redundant verdict still landed. So the window now also fires when
// GitHub reports the standing verdict, and is widened to 5 minutes to cover slow
// sequential fan-out. It only ever shadows the SAME verdict on the SAME (or
// uncertain) head: a DISMISSED, the opposite decisive verdict, a flipped verdict,
// and a new-push head all bypass it, so a genuine re-review is never stranded. 5min
// stays well under the lease TTL and short enough that a deliberate human-driven
// re-approval of the identical commit is the only thing it can delay.
const RECENT_LANDED_TTL_MS = 5 * 60_000
const COMPLETED_REPLY_REVIEW_ROUND_GRACE_MS = 5 * 60_000

type Reservation = {
  key: string
  token: number
  createdAt: number
  headSha: string | null
  verdict: ReviewVerdict | 'DISMISSED'
  workspace: string
  prNumber: number
  roundKey?: string
}

// headSha === null is the UNCERTAINTY sentinel: the command succeeded but the head
// the review actually attached to is unknown (the PR head advanced between the
// pre-submit capture and the write, or the post-submit re-resolve failed). A null
// record matches any current head for the window — same verdict + raw NONE only —
// so a push-during-review cannot let a same-verdict duplicate slip past on the new
// head. A resolved string keys precise same-head matching for the normal case.
type LandedVerdict = { verdict: ReviewVerdict; headSha: string | null; landedAt: number }

// MODULE-LEVEL singletons, shared by every plugin instance in this process. The
// github-cli-auth plugin's `plugin: async (ctx) => ...` factory may run once per
// session, giving each its own closure — but all of those closures import THIS
// module, so they coordinate through one Map. A closure-local Set (the prior
// design) could not see a concurrent session's in-flight verdict, which is how
// three sessions each landed an APPROVE on the same PR within ten seconds.
const inFlightByPr = new Map<string, Reservation>()
const reservationByCall = new Map<string, Reservation>()
const recentLandedByPr = new Map<string, LandedVerdict>()
type ReviewRoundState = {
  round: GithubReviewFollowupRound
  status: 'pending' | 'completed'
  createdAt: number
  attemptedCarriers: Set<string | null>
  dismissalAttempted: boolean
  requestChangesAttempted: boolean
}
let reviewRounds = new Map<string, ReviewRoundState>()
let expiredReviewRoundKeys = new Set<string>()
type ReplyReviewRoundGeneration = { round: GithubReviewFollowupRound; createdAt: number }
let replyReviewRoundGenerations = new Map<string, ReplyReviewRoundGeneration>()
let tokenSeq = 0

export function githubReviewRoundKey(round: GithubReviewFollowupRound): string {
  return `${round.workspace}#${round.prNumber}#${round.headSha}#${round.roundId}`
}

export function registerOrJoinReplyReviewRound(input: {
  workspace: string
  prNumber: number
  headSha: string
  blockingReviewId: number
  thread: string
  now?: () => number
  generateRoundId?: () => string
}): GithubReviewFollowupRound {
  const now = input.now ?? Date.now
  const currentTime = now()
  const correlationKey = JSON.stringify([input.workspace, input.prNumber, input.headSha, input.blockingReviewId])
  const existing = replyReviewRoundGenerations.get(correlationKey)
  if (existing !== undefined) {
    const state = activeReviewRoundState(githubReviewRoundKey(existing.round), now)
    const completedGraceExpired =
      state?.status === 'completed' && currentTime - existing.createdAt >= COMPLETED_REPLY_REVIEW_ROUND_GRACE_MS
    if (state !== undefined && !completedGraceExpired) return existing.round
    replyReviewRoundGenerations.delete(correlationKey)
  }

  const round: GithubReviewFollowupRound = {
    kind: 'reply',
    roundId: (input.generateRoundId ?? randomUUID)(),
    workspace: input.workspace,
    prNumber: input.prNumber,
    headSha: input.headSha,
    carrierThread: input.thread,
  }
  replyReviewRoundGenerations.set(correlationKey, { round, createdAt: currentTime })
  registerGithubReviewRound(round, currentTime, now)
  return round
}

export function registerGithubReviewRound(
  round: GithubReviewFollowupRound,
  createdAt = Date.now(),
  now: () => number = Date.now,
): GithubReviewFollowupRound | null {
  const key = githubReviewRoundKey(round)
  if (expiredReviewRoundKeys.has(key)) return null
  for (const [candidateKey, state] of reviewRounds) {
    if (activeReviewRoundState(candidateKey, now) === undefined) continue
    if (candidateKey !== key && state.round.workspace === round.workspace && state.round.prNumber === round.prNumber) {
      reviewRounds.delete(candidateKey)
    }
  }
  const existing = activeReviewRoundState(key, now)
  if (existing !== undefined) return existing.round
  if (now() - createdAt >= reviewRoundTtlMs(round)) {
    expiredReviewRoundKeys.add(key)
    return null
  }
  reviewRounds.set(key, {
    round,
    status: 'pending',
    createdAt,
    attemptedCarriers: new Set([round.carrierThread]),
    dismissalAttempted: false,
    requestChangesAttempted: false,
  })
  return round
}

export function restoreGithubReviewRound(
  round: GithubReviewFollowupRound,
  status: ReviewRoundState['status'],
  attemptedCarriers: readonly (string | null)[] = [round.carrierThread],
  dismissalAttempted = false,
  requestChangesAttempted = false,
  createdAt = Date.now(),
): GithubReviewFollowupRound | null {
  const registered = registerGithubReviewRound(round, createdAt)
  if (registered === null) return null
  const key = githubReviewRoundKey(registered)
  // Restoration is monotonic: a persisted `pending` record must never overwrite
  // an unexpired round this process already completed. A sibling session that
  // was idle-GC'd before completion still carries the stale status, and letting
  // it regress would re-arm failover and permit a second blocking review.
  // Expiry still wins — `activeReviewRoundState` drops the state first, so an
  // expired round is never resurrected by a late restore.
  const existing = activeReviewRoundState(key)
  if (existing !== undefined && existing.status === 'completed' && status === 'pending') return registered
  reviewRounds.set(key, {
    round: registered,
    status,
    createdAt,
    attemptedCarriers: new Set(attemptedCarriers),
    dismissalAttempted,
    requestChangesAttempted,
  })
  return registered
}

export function githubReviewRoundPersistence(round: GithubReviewFollowupRound): {
  status: ReviewRoundState['status']
  createdAt: number
  attemptedCarriers: (string | null)[]
  dismissalAttempted?: true
  requestChangesAttempted?: true
} | null {
  const state = activeReviewRoundState(githubReviewRoundKey(round))
  if (state === undefined) return null
  return {
    status: state.status,
    createdAt: state.createdAt,
    attemptedCarriers: Array.from(state.attemptedCarriers),
    ...(state.dismissalAttempted === true ? { dismissalAttempted: true as const } : {}),
    ...(state.requestChangesAttempted === true ? { requestChangesAttempted: true as const } : {}),
  }
}

export function forgetGithubReviewRound(round: GithubReviewFollowupRound): void {
  reviewRounds.delete(githubReviewRoundKey(round))
}

export function completeGithubReviewRound(round: GithubReviewFollowupRound): void {
  const key = githubReviewRoundKey(round)
  let current = activeReviewRoundState(key)
  if (current === undefined) {
    const registered = registerGithubReviewRound(round)
    if (registered === null) return
    current = activeReviewRoundState(key)
    if (current === undefined) return
  }
  reviewRounds.set(key, {
    round: current.round,
    status: 'completed',
    createdAt: current.createdAt,
    attemptedCarriers: current.attemptedCarriers,
    dismissalAttempted: current.dismissalAttempted,
    requestChangesAttempted: current.requestChangesAttempted,
  })
}

export function isGithubReviewRoundComplete(round: GithubReviewFollowupRound): boolean {
  return activeReviewRoundState(githubReviewRoundKey(round))?.status === 'completed'
}

export function promoteGithubReviewRound(
  round: GithubReviewFollowupRound,
  carrierThread: string | null,
): GithubReviewFollowupRound | null {
  const key = githubReviewRoundKey(round)
  const current = activeReviewRoundState(key)
  if (current === undefined || current.status === 'completed') return null
  const active = current.round
  if (active.carrierThread !== round.carrierThread) return null
  if (current.attemptedCarriers.has(carrierThread)) return null
  const promoted = { ...active, carrierThread }
  const attemptedCarriers = new Set(current.attemptedCarriers)
  attemptedCarriers.add(carrierThread)
  reviewRounds.set(key, {
    round: promoted,
    status: 'pending',
    createdAt: current.createdAt,
    attemptedCarriers,
    dismissalAttempted: current.dismissalAttempted,
    requestChangesAttempted: current.requestChangesAttempted,
  })
  return promoted
}

export function canPromoteGithubReviewRoundTo(round: GithubReviewFollowupRound, thread: string | null): boolean {
  const current = activeReviewRoundState(githubReviewRoundKey(round))
  return current !== undefined && current.status !== 'completed' && !current.attemptedCarriers.has(thread)
}

export async function validateGithubReviewRound(
  round: GithubReviewFollowupRound,
  createdAt?: number,
): Promise<boolean> {
  if (createdAt !== undefined && Date.now() - createdAt >= reviewRoundTtlMs(round)) return false
  if (expiredReviewRoundKeys.has(githubReviewRoundKey(round))) return false
  const currentHead = await processHeadShaResolver({ workspace: round.workspace, prNumber: round.prNumber })
  return currentHead !== null && currentHead === round.headSha
}

export async function guardGithubReviewRoundDismissal(args: {
  callId: string
  workspace: string
  prNumber: number
  round?: GithubReviewFollowupRound
  thread?: string | null
}): Promise<ApproveBlock | null> {
  const blocked = await evaluateRoundEligibility(args, processHeadShaResolver)
  if (blocked !== null) return blocked
  if (args.round === undefined) return null

  const roundKey = githubReviewRoundKey(args.round)
  const roundState = activeReviewRoundState(roundKey)
  if (roundState === undefined) return null
  if (roundState?.dismissalAttempted === true) {
    return { block: true, kind: 'round-ineligible', reason: ROUND_INELIGIBLE_REASON }
  }

  const key = prKey(args.workspace, args.prNumber)
  const held = inFlightByPr.get(key)
  if (held !== undefined && Date.now() - held.createdAt < LEASE_TTL_MS) {
    return { block: true, kind: 'concurrent', reason: CONCURRENT_REASON }
  }
  const reservation: Reservation = {
    key,
    token: ++tokenSeq,
    createdAt: Date.now(),
    headSha: args.round.headSha,
    verdict: 'DISMISSED',
    workspace: args.workspace,
    prNumber: args.prNumber,
    roundKey,
  }
  inFlightByPr.set(key, reservation)
  reservationByCall.set(args.callId, reservation)
  if (roundState !== undefined) roundState.dismissalAttempted = true
  return null
}

export function releaseGithubReviewRoundDismissal(callId: string, attempted = true): void {
  const reservation = reservationByCall.get(callId)
  if (reservation?.verdict !== 'DISMISSED') return
  if (!attempted && reservation.roundKey !== undefined) {
    const state = activeReviewRoundState(reservation.roundKey)
    if (state !== undefined) state.dismissalAttempted = false
  }
  releaseReservation(callId, reservation)
}

export function hasGithubReviewRoundDismissalAttempt(round: GithubReviewFollowupRound): boolean {
  return activeReviewRoundState(githubReviewRoundKey(round))?.dismissalAttempted === true
}

export function resetGithubReviewRoundCompletion(round: GithubReviewFollowupRound): void {
  const state = activeReviewRoundState(githubReviewRoundKey(round))
  if (state === undefined || state.status === 'completed') return
  // A verified mutation may outlive its publishing session or hit a transient
  // head read before the observer can record completion. Release operation
  // latches so the carrier can retry and failover remains available instead of
  // leaving the pending round permanently stranded.
  state.dismissalAttempted = false
  state.requestChangesAttempted = false
}

export function resetGithubReviewRoundCompletionForPr(
  workspace: string,
  prNumber: number,
): GithubReviewFollowupRound | null {
  expireReviewRounds()
  const state = Array.from(reviewRounds.values()).find(
    (candidate) =>
      candidate.status === 'pending' &&
      candidate.round.workspace === workspace &&
      candidate.round.prNumber === prNumber,
  )
  if (state === undefined) return null
  resetGithubReviewRoundCompletion(state.round)
  return state.round
}

// Makes a formal `gh ... event=APPROVE|REQUEST_CHANGES` idempotent per PR across
// turns, sessions, and (in-process) concurrent fan-out. Three layers, in order:
//
//   1. A process-wide in-flight lease keyed by `workspace#prNumber`, held from
//      tool.before through tool.after. While one verdict is mid-flight, every
//      other session's verdict for the same PR is blocked — even though GitHub
//      has not yet recorded the in-flight review. This is the layer the old
//      closure-local Set could not provide: separate plugin instances meant
//      separate Sets, so concurrent sessions never saw each other.
//
//   2. The authoritative GitHub effective-state read, consulted AFTER the lease.
//      It is the SOLE source of truth for a standing verdict and for supersession:
//      a later CHANGES_REQUESTED/DISMISSED demotes an earlier APPROVED, so a
//      genuine re-verdict is allowed (the 35287f99 invariant — never block a
//      re-verdict on stale LOCAL memory). A standing same verdict blocks; DISMISSED
//      and the opposite decisive verdict pass. Reads fail OPEN.
//
//   3. A read-after-write-lag shield, consulted ONLY when layer 2 returns a raw
//      NONE. The lease (layer 1) covers two OVERLAPPING in-flight commands, but a
//      second engagement turn ~10s later starts after the first's lease released,
//      and GitHub's reviews list still lags the write (reports NONE). A short-lived
//      `recentLandedByPr` record — same verdict + (same OR uncertain head), written
//      on any landed release (formal or fallback), RECENT_LANDED_TTL_MS —
//      disambiguates "NONE because lag" from "NONE because genuinely absent": only
//      the former blocks. The head
//      is re-resolved at release time; if the PR head advanced during the submit the
//      record stores a null head (uncertainty), which matches the current head so a
//      push-during-review cannot leak a duplicate. Because it fires after a raw
//      NONE, a real DISMISSED/CHANGES_REQUESTED already allowed the re-verdict at
//      layer 2, so this cannot re-strand a supersession.
//
// The lease is released only in release() (tool.after) or on a terminal block,
// never after the remote read — releasing early reopens the TOCTOU the lease
// exists to close. Release is keyed by a per-call token so a late/stale
// tool.after for a superseded reservation cannot drop a newer session's lease.
export function createApproveIdempotencyGuard(deps: {
  resolveEffectiveApproval: EffectiveApprovalResolver
  resolveHeadSha?: HeadShaResolver
  now?: () => number
}): ReviewVerdictGuard {
  const now = deps.now ?? Date.now

  return {
    async guard(args): Promise<ApproveBlock | null> {
      if (args.verdict !== 'APPROVE' && args.verdict !== 'REQUEST_CHANGES') return null
      expireRecentLanded(now)
      const blocked = await evaluateRoundEligibility(args, deps.resolveHeadSha ?? processHeadShaResolver, now)
      if (blocked !== null) return blocked
      const key = prKey(args.workspace, args.prNumber)

      const roundState =
        args.round === undefined ? undefined : activeReviewRoundState(githubReviewRoundKey(args.round), now)
      if (args.verdict === 'REQUEST_CHANGES' && roundState?.requestChangesAttempted === true) {
        return { block: true, kind: 'round-ineligible', reason: ROUND_INELIGIBLE_REASON }
      }

      // Reserve BEFORE the await so two calls racing into guard() for the same PR
      // cannot both observe an empty map: the loser sees the winner's in-flight
      // lease and is blocked. An expired lease (tool.after never fired) is
      // reclaimable so a crash cannot permanently strand the PR.
      const held = inFlightByPr.get(key)
      if (held !== undefined && now() - held.createdAt < LEASE_TTL_MS) {
        return { block: true, kind: 'concurrent', reason: CONCURRENT_REASON }
      }
      const reservation: Reservation = {
        key,
        token: ++tokenSeq,
        createdAt: now(),
        headSha: null,
        verdict: args.verdict,
        workspace: args.workspace,
        prNumber: args.prNumber,
        ...(roundState !== undefined ? { roundKey: githubReviewRoundKey(roundState.round) } : {}),
      }
      inFlightByPr.set(key, reservation)
      reservationByCall.set(args.callId, reservation)
      if (args.verdict === 'REQUEST_CHANGES' && roundState !== undefined) roundState.requestChangesAttempted = true

      // Resolve the head SHA only AFTER the lease is held, so this await cannot
      // widen the reserve-before-await race the lease closes above.
      const headSha = (await deps.resolveHeadSha?.({ workspace: args.workspace, prNumber: args.prNumber })) ?? null
      reservation.headSha = headSha

      // Layer 2: GitHub is the authoritative, sole source of truth for a standing
      // verdict. A standing same verdict is a real duplicate except for the one
      // carrier REQUEST_CHANGES required to complete a new-head follow-up round;
      // DISMISSED and the opposite decisive verdict are genuine supersessions
      // that must pass here (the 35287f99 invariant). A read error fails OPEN.
      const remote = await deps.resolveEffectiveApproval({ workspace: args.workspace, prNumber: args.prNumber })
      const allowedRoundSameStateRequest =
        args.verdict === 'REQUEST_CHANGES' &&
        roundState !== undefined &&
        remote.ok &&
        remote.effective === 'CHANGES_REQUESTED'

      // Layer 3 — duplicate-review cooldown. A recently-landed SAME verdict on the
      // SAME (or uncertain) head blocks a redundant re-publication for the window. It
      // fires on a bare NONE (read-after-write lag, the original shield) AND on the
      // now-indexed SAME standing verdict (the PR #1042 fan-out, where siblings fired
      // minutes apart, each after GitHub had already indexed the prior). It must NOT
      // fire on a DISMISSED or the opposite decisive verdict: those are genuine
      // supersessions, so the cooldown is gated to the ambiguous states (NONE, or the
      // same standing verdict) and skipped for any decisive state that contradicts a
      // redundant re-submit. A read error skips it (fails open) so a transient failure
      // cannot strand a re-verdict.
      //
      // This is checked BEFORE the standing block below, and the order is load-bearing.
      // `standing` is the one block a caller may answer by publishing a PR-level
      // fallback comment instead, so a `standing` verdict on a PR that already got that
      // comment would let every sibling thread session publish its own copy, which is
      // how one PR collected two full reviews. Reporting `recent` here denies the whole publication
      // instead, which is the accurate answer once a same-verdict output already landed.
      if (
        !allowedRoundSameStateRequest &&
        remote.ok &&
        cooldownApplies(args.verdict, remote.effective) &&
        recentlyLandedSame(key, args.verdict, headSha, now)
      ) {
        resetRoundRequestChangesAttempt(reservation)
        releaseReservation(args.callId, reservation)
        return {
          block: true,
          kind: 'duplicate',
          reason: duplicateReason(args.verdict),
          duplicateSource: 'recent',
        }
      }

      if (remote.ok && duplicatesStanding(args.verdict, remote.effective) && !allowedRoundSameStateRequest) {
        // Standing verdict upstream already matches. Block, and release the lease
        // now: a blocked command never reaches tool.after, so release() won't run
        // for this callId. Leaving the lease set would resurrect the strand bug —
        // the GitHub read is authoritative for the standing case.
        if (args.retainDuplicateLease !== true) {
          resetRoundRequestChangesAttempt(reservation)
          releaseReservation(args.callId, reservation)
        }
        return {
          block: true,
          kind: 'duplicate',
          reason: duplicateReason(args.verdict),
          duplicateSource: 'standing',
          ...(args.retainDuplicateLease === true ? { leaseRetained: true } : {}),
        }
      }

      return null
    },

    async release(args): Promise<void> {
      const reservation = reservationByCall.get(args.callId)
      if (reservation === undefined) return
      try {
        // A FORMAL review's pre-submit head can go stale: if the PR head advanced
        // between the guard() capture and the review landing, GitHub attaches the
        // review to the NEWER head while reservation.headSha holds the older one.
        // Re-resolve the head AFTER a successful submit and store what we can prove:
        // the resolved head only when pre==post, else the null uncertainty sentinel
        // (matches any current head for the lag window) so a push-during-review
        // cannot let a same-verdict duplicate slip past on the new head. The lease
        // stays held across this await (finally below), so the window is not reopened.
        //
        // A FALLBACK comment has no such ambiguity and must NOT take the sentinel.
        // It is an issue comment, which GitHub associates with no head at all, and
        // its body was written for reservation.headSha. Storing the sentinel for it
        // would make a push landing mid-delivery shadow EVERY head, so the first
        // genuine review of the new head would be denied as `recent` — an
        // over-broad guard blocking real work. Pin it to the head it was written for.
        if (args.outcome !== 'failed' && reservation.headSha !== null && reservation.verdict !== 'DISMISSED') {
          const postHeadSha =
            args.outcome === 'fallback-landed'
              ? reservation.headSha
              : ((await deps.resolveHeadSha?.({ workspace: reservation.workspace, prNumber: reservation.prNumber })) ??
                null)
          const landedHeadSha = postHeadSha !== null && postHeadSha === reservation.headSha ? postHeadSha : null
          recentLandedByPr.set(reservation.key, {
            verdict: reservation.verdict,
            headSha: landedHeadSha,
            landedAt: now(),
          })
        }
      } finally {
        if (args.outcome !== 'formal-landed') resetRoundRequestChangesAttempt(reservation)
        releaseReservation(args.callId, reservation)
      }
    },

    async noteLandedReview(args): Promise<void> {
      if (args.verdict !== 'APPROVE' && args.verdict !== 'REQUEST_CHANGES') return
      // No pre-submit head was captured (guard() never ran), so the best pin we
      // can prove is the CURRENT head. A null resolve becomes the uncertainty
      // sentinel, which still matches the current head for the lag window — the
      // same conservative behaviour release() uses for a push-during-review.
      const headSha = (await deps.resolveHeadSha?.({ workspace: args.workspace, prNumber: args.prNumber })) ?? null
      recentLandedByPr.set(prKey(args.workspace, args.prNumber), {
        verdict: args.verdict,
        headSha,
        landedAt: now(),
      })
    },
  }
}

async function evaluateRoundEligibility(
  args: {
    workspace: string
    prNumber: number
    round?: GithubReviewFollowupRound
    thread?: string | null
  },
  resolveHeadSha: HeadShaResolver,
  now: () => number = Date.now,
): Promise<ApproveBlock | null> {
  expireReviewRounds(now)
  const pendingRoundForPr = Array.from(reviewRounds.values()).find(
    (state) =>
      state.status === 'pending' &&
      state.round.kind === 'push' &&
      state.round.workspace === args.workspace &&
      state.round.prNumber === args.prNumber,
  )
  // Pushes invalidate the whole PR's prior verdict, so their round legitimately
  // owns every verdict attempt until one sibling carries it. Reply rounds only
  // coordinate the stamped siblings answering one blocking review: their
  // non-carriers are rejected below, while unrelated round-less sessions remain
  // covered by the in-flight, standing, and recent-landing duplicate guards.
  if (args.round === undefined) {
    return pendingRoundForPr === undefined
      ? null
      : { block: true, kind: 'round-ineligible', reason: ROUND_INELIGIBLE_REASON }
  }
  if (args.round.workspace !== args.workspace || args.round.prNumber !== args.prNumber) {
    if (expiredReviewRoundKeys.has(githubReviewRoundKey(args.round))) return null
    return { block: true, kind: 'round-ineligible', reason: ROUND_INELIGIBLE_REASON }
  }
  const roundKey = githubReviewRoundKey(args.round)
  if (expiredReviewRoundKeys.has(roundKey)) return null
  const existing = activeReviewRoundState(roundKey, now)
  const activeRound = existing?.round ?? args.round
  if (existing?.status === 'completed' || activeRound.carrierThread !== (args.thread ?? null)) {
    return { block: true, kind: 'round-ineligible', reason: ROUND_INELIGIBLE_REASON }
  }
  const currentRoundHead = await resolveHeadSha({
    workspace: activeRound.workspace,
    prNumber: activeRound.prNumber,
  })
  if (currentRoundHead === null || currentRoundHead !== activeRound.headSha) {
    return { block: true, kind: 'round-ineligible', reason: ROUND_INELIGIBLE_REASON }
  }
  registerGithubReviewRound(activeRound, now())
  return null
}

// True only when a recently-landed record proves the GitHub NONE is read lag: same
// verdict, within the window, AND the heads agree. Head agreement holds when the
// stored head equals the current head, OR the stored head is the null uncertainty
// sentinel (the landed commit could not be pinned, so it conservatively matches the
// current head for the window). A flipped verdict or an expired/absent record
// returns false so the genuine re-verdict passes; a different KNOWN head also
// returns false so a real new push is never blocked.
function recentlyLandedSame(key: string, verdict: ReviewVerdict, headSha: string | null, now: () => number): boolean {
  const landed = recentLandedByPr.get(key)
  if (landed === undefined) return false
  if (now() - landed.landedAt >= RECENT_LANDED_TTL_MS) return false
  if (verdict !== landed.verdict) return false
  return landed.headSha === null || landed.headSha === headSha
}

// Drop the lease only if THIS reservation still owns the key. A stale tool.after
// for a reservation that was already superseded (e.g. reclaimed after TTL by a
// newer session) must not yank the live session's lease.
function releaseReservation(callId: string, reservation: Reservation): void {
  reservationByCall.delete(callId)
  const current = inFlightByPr.get(reservation.key)
  if (current !== undefined && current.token === reservation.token) {
    inFlightByPr.delete(reservation.key)
  }
}

function resetRoundRequestChangesAttempt(reservation: Reservation): void {
  if (reservation.verdict !== 'REQUEST_CHANGES' || reservation.roundKey === undefined) return
  const state = activeReviewRoundState(reservation.roundKey)
  if (state !== undefined && state.status === 'pending') state.requestChangesAttempted = false
}

function prKey(workspace: string, prNumber: number): string {
  return `${workspace}#${prNumber}`
}

function activeReviewRoundState(key: string, now: () => number = Date.now): ReviewRoundState | undefined {
  const state = reviewRounds.get(key)
  if (state === undefined) return undefined
  if (now() - state.createdAt < reviewRoundTtlMs(state.round)) return state
  reviewRounds.delete(key)
  expiredReviewRoundKeys.add(key)
  return undefined
}

function reviewRoundTtlMs(round: GithubReviewFollowupRound): number {
  return round.kind === 'reply' ? REPLY_REVIEW_ROUND_TTL_MS : REVIEW_ROUND_TTL_MS
}

function expireReviewRounds(now: () => number = Date.now): void {
  for (const key of reviewRounds.keys()) activeReviewRoundState(key, now)
}

// `recentlyLandedSame` only reports a miss on an expired record, so a PR that is
// reviewed once leaves an entry nothing ever reads or drops again — one dead record
// per PR for the life of the process. Sweeping on each guard bounds the map to PRs
// still inside the window, and only a process that keeps reviewing can grow it.
function expireRecentLanded(now: () => number): void {
  for (const [key, landed] of recentLandedByPr) {
    if (now() - landed.landedAt >= RECENT_LANDED_TTL_MS) recentLandedByPr.delete(key)
  }
}

export function __recentLandedRecordCountForTest(): number {
  return recentLandedByPr.size
}

// Test-only: clear the process-wide lease state between cases.
export function __resetReviewVerdictGuardForTest(): void {
  inFlightByPr.clear()
  reservationByCall.clear()
  recentLandedByPr.clear()
  reviewRounds = new Map<string, ReviewRoundState>()
  expiredReviewRoundKeys = new Set<string>()
  replyReviewRoundGenerations = new Map<string, ReplyReviewRoundGeneration>()
  tokenSeq = 0
  processEffectiveResolver = async () => ({ ok: false })
  processHeadShaResolver = async () => null
}
