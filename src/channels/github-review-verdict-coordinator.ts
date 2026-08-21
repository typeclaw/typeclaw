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
  release: (args: { callId: string; succeeded: boolean }) => Promise<void>
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

type Reservation = {
  key: string
  token: number
  createdAt: number
  headSha: string | null
  verdict: ReviewVerdict
  workspace: string
  prNumber: number
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
  attemptedCarriers: Set<string | null>
}
let reviewRounds = new Map<string, ReviewRoundState>()
let tokenSeq = 0

export function githubReviewRoundKey(round: GithubReviewFollowupRound): string {
  return `${round.workspace}#${round.prNumber}#${round.headSha}`
}

export function registerGithubReviewRound(round: GithubReviewFollowupRound): GithubReviewFollowupRound {
  const key = githubReviewRoundKey(round)
  for (const [candidateKey, state] of reviewRounds) {
    if (candidateKey !== key && state.round.workspace === round.workspace && state.round.prNumber === round.prNumber) {
      reviewRounds.delete(candidateKey)
    }
  }
  const existing = reviewRounds.get(key)
  if (existing !== undefined) return existing.round
  reviewRounds.set(key, { round, status: 'pending', attemptedCarriers: new Set([round.carrierThread]) })
  return round
}

export function restoreGithubReviewRound(
  round: GithubReviewFollowupRound,
  status: ReviewRoundState['status'],
  attemptedCarriers: readonly (string | null)[] = [round.carrierThread],
): GithubReviewFollowupRound {
  const registered = registerGithubReviewRound(round)
  reviewRounds.set(githubReviewRoundKey(registered), {
    round: registered,
    status,
    attemptedCarriers: new Set(attemptedCarriers),
  })
  return registered
}

export function githubReviewRoundPersistence(round: GithubReviewFollowupRound): {
  status: ReviewRoundState['status']
  attemptedCarriers: (string | null)[]
} {
  const state = reviewRounds.get(githubReviewRoundKey(round))
  return {
    status: state?.status ?? 'pending',
    attemptedCarriers: Array.from(state?.attemptedCarriers ?? [round.carrierThread]),
  }
}

export function forgetGithubReviewRound(round: GithubReviewFollowupRound): void {
  reviewRounds.delete(githubReviewRoundKey(round))
}

export function completeGithubReviewRound(round: GithubReviewFollowupRound): void {
  const key = githubReviewRoundKey(round)
  const current = reviewRounds.get(key)
  reviewRounds.set(key, {
    round: current?.round ?? round,
    status: 'completed',
    attemptedCarriers: current?.attemptedCarriers ?? new Set([round.carrierThread]),
  })
}

export function isGithubReviewRoundComplete(round: GithubReviewFollowupRound): boolean {
  return reviewRounds.get(githubReviewRoundKey(round))?.status === 'completed'
}

export function promoteGithubReviewRound(
  round: GithubReviewFollowupRound,
  carrierThread: string | null,
): GithubReviewFollowupRound | null {
  const key = githubReviewRoundKey(round)
  const current = reviewRounds.get(key)
  if (current?.status === 'completed') return null
  const active = current?.round ?? round
  if (active.carrierThread !== round.carrierThread) return null
  if (current?.attemptedCarriers.has(carrierThread) === true) return null
  const promoted = { ...active, carrierThread }
  const attemptedCarriers = new Set(current?.attemptedCarriers ?? [active.carrierThread])
  attemptedCarriers.add(carrierThread)
  reviewRounds.set(key, { round: promoted, status: 'pending', attemptedCarriers })
  return promoted
}

export function canPromoteGithubReviewRoundTo(round: GithubReviewFollowupRound, thread: string | null): boolean {
  const current = reviewRounds.get(githubReviewRoundKey(round))
  return current?.status !== 'completed' && current?.attemptedCarriers.has(thread) !== true
}

export async function validateGithubReviewRound(round: GithubReviewFollowupRound): Promise<boolean> {
  const currentHead = await processHeadShaResolver({ workspace: round.workspace, prNumber: round.prNumber })
  return currentHead !== null && currentHead === round.headSha
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
//      on a succeeded release, RECENT_LANDED_TTL_MS — disambiguates "NONE because
//      lag" from "NONE because genuinely absent": only the former blocks. The head
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
      const pendingRoundForPr = Array.from(reviewRounds.values()).find(
        (state) =>
          state.status === 'pending' &&
          state.round.workspace === args.workspace &&
          state.round.prNumber === args.prNumber,
      )
      if (args.round === undefined && pendingRoundForPr !== undefined) {
        return { block: true, kind: 'round-ineligible', reason: ROUND_INELIGIBLE_REASON }
      }
      if (args.round !== undefined) {
        if (args.round.workspace !== args.workspace || args.round.prNumber !== args.prNumber) {
          return { block: true, kind: 'round-ineligible', reason: ROUND_INELIGIBLE_REASON }
        }
        const existing = reviewRounds.get(githubReviewRoundKey(args.round))
        const activeRound = existing?.round ?? args.round
        if (existing?.status === 'completed') {
          return { block: true, kind: 'round-ineligible', reason: ROUND_INELIGIBLE_REASON }
        }
        if (activeRound.carrierThread !== (args.thread ?? null)) {
          return { block: true, kind: 'round-ineligible', reason: ROUND_INELIGIBLE_REASON }
        }
        const currentRoundHead = await (deps.resolveHeadSha ?? processHeadShaResolver)({
          workspace: activeRound.workspace,
          prNumber: activeRound.prNumber,
        })
        if (currentRoundHead === null || currentRoundHead !== activeRound.headSha) {
          return { block: true, kind: 'round-ineligible', reason: ROUND_INELIGIBLE_REASON }
        }
        registerGithubReviewRound(activeRound)
      }
      const key = prKey(args.workspace, args.prNumber)

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
      }
      inFlightByPr.set(key, reservation)
      reservationByCall.set(args.callId, reservation)

      // Resolve the head SHA only AFTER the lease is held, so this await cannot
      // widen the reserve-before-await race the lease closes above.
      const headSha = (await deps.resolveHeadSha?.({ workspace: args.workspace, prNumber: args.prNumber })) ?? null
      reservation.headSha = headSha

      // Layer 2: GitHub is the authoritative, sole source of truth for a standing
      // verdict. A standing same verdict is a real duplicate; DISMISSED and the
      // opposite decisive verdict are genuine supersessions that must pass here
      // (the 35287f99 invariant). A read error fails OPEN.
      const remote = await deps.resolveEffectiveApproval({ workspace: args.workspace, prNumber: args.prNumber })
      if (remote.ok && duplicatesStanding(args.verdict, remote.effective)) {
        // Standing verdict upstream already matches. Block, and release the lease
        // now: a blocked command never reaches tool.after, so release() won't run
        // for this callId. Leaving the lease set would resurrect the strand bug —
        // the GitHub read is authoritative for the standing case.
        if (args.retainDuplicateLease !== true) releaseReservation(args.callId, reservation)
        return {
          block: true,
          kind: 'duplicate',
          reason: duplicateReason(args.verdict),
          duplicateSource: 'standing',
          ...(args.retainDuplicateLease === true ? { leaseRetained: true } : {}),
        }
      }

      // Layer 3 — duplicate-review cooldown. A recently-landed SAME verdict on the
      // SAME (or uncertain) head blocks a redundant re-submit for the window. It
      // fires on a bare NONE (read-after-write lag, the original shield) AND on the
      // now-indexed SAME standing verdict (the PR #1042 fan-out, where siblings fired
      // minutes apart after indexing) — `duplicatesStanding` above already returned
      // here for that case, so reaching this line on a same-standing-verdict means
      // only that the lease-released duplicate is being re-tried; either way the
      // cooldown holds. It must NOT fire on a DISMISSED or the opposite decisive
      // verdict: those are genuine supersessions, so the cooldown is gated to the
      // ambiguous states (NONE, or the same standing verdict) and skipped for any
      // decisive state that contradicts a redundant re-submit. A read error skips it
      // (fails open) so a transient failure cannot strand a re-verdict.
      if (
        remote.ok &&
        cooldownApplies(args.verdict, remote.effective) &&
        recentlyLandedSame(key, args.verdict, headSha, now)
      ) {
        releaseReservation(args.callId, reservation)
        return {
          block: true,
          kind: 'duplicate',
          reason: duplicateReason(args.verdict),
          duplicateSource: 'recent',
        }
      }

      return null
    },

    async release(args): Promise<void> {
      const reservation = reservationByCall.get(args.callId)
      if (reservation === undefined) return
      try {
        // The pre-submit head can go stale: if the PR head advanced between the
        // guard() capture and the review landing, GitHub attaches the review to the
        // NEWER head while reservation.headSha holds the older one. Re-resolve the
        // head AFTER a successful submit and store what we can prove: the resolved
        // head only when pre==post, else the null uncertainty sentinel (matches any
        // current head for the lag window) so a push-during-review cannot let a
        // same-verdict duplicate slip past on the new head. The lease stays held
        // across this await (finally below), so the window is not reopened.
        if (args.succeeded && reservation.headSha !== null) {
          const postHeadSha =
            (await deps.resolveHeadSha?.({ workspace: reservation.workspace, prNumber: reservation.prNumber })) ?? null
          const landedHeadSha = postHeadSha !== null && postHeadSha === reservation.headSha ? postHeadSha : null
          recentLandedByPr.set(reservation.key, {
            verdict: reservation.verdict,
            headSha: landedHeadSha,
            landedAt: now(),
          })
        }
      } finally {
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

function prKey(workspace: string, prNumber: number): string {
  return `${workspace}#${prNumber}`
}

// Test-only: clear the process-wide lease state between cases.
export function __resetReviewVerdictGuardForTest(): void {
  inFlightByPr.clear()
  reservationByCall.clear()
  recentLandedByPr.clear()
  reviewRounds = new Map<string, ReviewRoundState>()
  tokenSeq = 0
  processEffectiveResolver = async () => ({ ok: false })
  processHeadShaResolver = async () => null
}
