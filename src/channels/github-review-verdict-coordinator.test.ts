import { afterEach, describe, expect, test } from 'bun:test'

import {
  __resetReviewVerdictGuardForTest,
  configureReviewVerdictCoordinator,
  completeGithubReviewRound,
  canPromoteGithubReviewRoundTo,
  createApproveIdempotencyGuard,
  guardGithubReviewRoundDismissal,
  releaseGithubReviewRoundDismissal,
  registerGithubReviewRound,
  REVIEW_ROUND_TTL_MS,
  restoreGithubReviewRound,
  type EffectiveApprovalResolver,
  type EffectiveVerdict,
} from './github-review-verdict-coordinator'

const WS = 'acme/widgets'
const ROUND = { workspace: WS, prNumber: 60, headSha: 'sha-round', carrierThread: '101' } as const

function resolver(map: Record<string, EffectiveVerdict | 'error'>): EffectiveApprovalResolver {
  return async ({ workspace, prNumber }) => {
    const state = map[`${workspace}#${prNumber}`] ?? 'NONE'
    if (state === 'error') return { ok: false }
    return { ok: true, effective: state }
  }
}

describe('review verdict idempotency guard', () => {
  afterEach(() => {
    __resetReviewVerdictGuardForTest()
  })
  function makeGuard(map: Record<string, EffectiveVerdict | 'error'> = {}, now?: () => number) {
    return createApproveIdempotencyGuard({
      resolveEffectiveApproval: resolver(map),
      resolveHeadSha: async ({ prNumber }) => (prNumber === ROUND.prNumber ? ROUND.headSha : null),
      now,
    })
  }

  test('allows the first APPROVE when the bot has no prior verdict', async () => {
    const g = makeGuard()
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 5, verdict: 'APPROVE' })
    expect(decision).toBeNull()
  })

  test('rejects a non-carrier round verdict before any authoritative read', async () => {
    let reads = 0
    let headReads = 0
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => {
        reads += 1
        return { ok: true, effective: 'NONE' }
      },
      resolveHeadSha: async () => {
        headReads += 1
        return ROUND.headSha
      },
    })

    const decision = await g.guard({
      callId: 'round-non-carrier',
      workspace: WS,
      prNumber: 60,
      verdict: 'REQUEST_CHANGES',
      round: ROUND,
      thread: '202',
    })

    expect(decision).toMatchObject({ block: true, kind: 'round-ineligible' })
    expect(reads).toBe(0)
    expect(headReads).toBe(0)
  })

  test('rejects a non-carrier dismissal before the authoritative head read', async () => {
    let headReads = 0
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: resolver({}),
      resolveHeadSha: async () => {
        headReads += 1
        return ROUND.headSha
      },
    })
    registerGithubReviewRound(ROUND)

    const decision = await guardGithubReviewRoundDismissal({
      callId: 'dismiss-non-carrier',
      workspace: WS,
      prNumber: 60,
      round: ROUND,
      thread: '202',
    })

    expect(decision).toMatchObject({ block: true, kind: 'round-ineligible' })
    expect(headReads).toBe(0)
  })

  test('allows only one carrier dismissal attempt per round', async () => {
    configureReviewVerdictCoordinator({
      resolveEffectiveApproval: resolver({}),
      resolveHeadSha: async () => ROUND.headSha,
    })
    registerGithubReviewRound(ROUND)
    const first = await guardGithubReviewRoundDismissal({
      callId: 'dismiss-first',
      workspace: WS,
      prNumber: 60,
      round: ROUND,
      thread: '101',
    })
    expect(first).toBeNull()
    releaseGithubReviewRoundDismissal('dismiss-first')

    const second = await guardGithubReviewRoundDismissal({
      callId: 'dismiss-second',
      workspace: WS,
      prNumber: 60,
      round: ROUND,
      thread: '101',
    })
    expect(second).toMatchObject({ block: true, kind: 'round-ineligible' })
  })

  test('rejects a verdict with missing metadata while a round is pending for the PR', async () => {
    let reads = 0
    registerGithubReviewRound(ROUND)
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => {
        reads += 1
        return { ok: true, effective: 'NONE' }
      },
    })
    const decision = await g.guard({
      callId: 'round-missing',
      workspace: WS,
      prNumber: 60,
      verdict: 'APPROVE',
    })
    expect(decision).toMatchObject({ block: true, kind: 'round-ineligible' })
    expect(reads).toBe(0)
  })

  test('expires a pending round before it can deny a verdict with missing round metadata', async () => {
    let reads = 0
    let clock = Date.now()
    restoreGithubReviewRound(ROUND, 'pending', ['101'], false, false, clock)
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => {
        reads += 1
        return { ok: true, effective: 'NONE' }
      },
      now: () => clock,
    })
    clock += REVIEW_ROUND_TTL_MS + 1

    const decision = await g.guard({
      callId: 'expired-round-missing',
      workspace: WS,
      prNumber: 60,
      verdict: 'APPROVE',
    })

    expect(decision).toBeNull()
    expect(reads).toBe(1)
  })

  test('restores attempted carriers so failover does not retry them after restart', () => {
    restoreGithubReviewRound({ ...ROUND, carrierThread: '202' }, 'pending', ['101', '202'])
    expect(canPromoteGithubReviewRoundTo(ROUND, '101')).toBe(false)
    expect(canPromoteGithubReviewRoundTo(ROUND, '202')).toBe(false)
    expect(canPromoteGithubReviewRoundTo(ROUND, '303')).toBe(true)
  })

  test('allows only the designated carrier to acquire the ordinary verdict lease', async () => {
    const g = makeGuard()
    const decision = await g.guard({
      callId: 'round-carrier',
      workspace: WS,
      prNumber: 60,
      verdict: 'REQUEST_CHANGES',
      round: ROUND,
      thread: '101',
    })
    expect(decision).toBeNull()
  })

  test('allows one carrier REQUEST_CHANGES against a standing same-state verdict for the round', async () => {
    const g = makeGuard({ [`${WS}#60`]: 'CHANGES_REQUESTED' })
    const first = await g.guard({
      callId: 'round-same-state-first',
      workspace: WS,
      prNumber: 60,
      verdict: 'REQUEST_CHANGES',
      round: ROUND,
      thread: '101',
    })
    expect(first).toBeNull()
    await g.release({ callId: 'round-same-state-first', succeeded: true })

    const second = await g.guard({
      callId: 'round-same-state-second',
      workspace: WS,
      prNumber: 60,
      verdict: 'REQUEST_CHANGES',
      round: ROUND,
      thread: '101',
    })
    expect(second).toMatchObject({ block: true, kind: 'round-ineligible' })
  })

  test('still deduplicates a standing same-state REQUEST_CHANGES outside a round', async () => {
    const g = makeGuard({ [`${WS}#60`]: 'CHANGES_REQUESTED' })
    const decision = await g.guard({
      callId: 'same-state-no-round',
      workspace: WS,
      prNumber: 60,
      verdict: 'REQUEST_CHANGES',
    })
    expect(decision).toMatchObject({ block: true, kind: 'duplicate', duplicateSource: 'standing' })
  })

  test('rejects a designated carrier when the round head is no longer current', async () => {
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: resolver({}),
      resolveHeadSha: async () => 'sha-new',
    })
    const decision = await g.guard({
      callId: 'round-stale-carrier',
      workspace: WS,
      prNumber: 60,
      verdict: 'REQUEST_CHANGES',
      round: ROUND,
      thread: '101',
    })
    expect(decision).toMatchObject({ block: true, kind: 'round-ineligible' })
  })

  test('a completed round remains ineligible for another formal verdict', async () => {
    completeGithubReviewRound(ROUND)
    const g = makeGuard()
    const decision = await g.guard({
      callId: 'round-completed',
      workspace: WS,
      prNumber: 60,
      verdict: 'APPROVE',
      round: ROUND,
      thread: '101',
    })
    expect(decision).toMatchObject({ block: true, kind: 'round-ineligible' })
  })

  test('blocks a second verdict while the first is still in flight (concurrent sessions, same container)', async () => {
    const g = makeGuard()
    // given: a first APPROVE that reserved the PR but has not completed (tool.after not called yet)
    const first = await g.guard({ callId: 'a1', workspace: WS, prNumber: 7, verdict: 'APPROVE' })
    expect(first).toBeNull()
    // when: a second session attempts any formal verdict for the same PR
    const second = await g.guard({ callId: 'a2', workspace: WS, prNumber: 7, verdict: 'APPROVE' })
    // then: it is blocked while the first is mid-flight
    expect(second).toMatchObject({ block: true, kind: 'concurrent' })
  })

  test('separate plugin instances share the in-flight lease (process-wide singleton)', async () => {
    // given: two guards as two different plugin instances would create them
    const instanceA = makeGuard()
    const instanceB = makeGuard()
    // when: instance A reserves an APPROVE and never calls tool.after
    const a = await instanceA.guard({ callId: 'a1', workspace: WS, prNumber: 8, verdict: 'APPROVE' })
    expect(a).toBeNull()
    // then: instance B sees the in-flight lease and blocks — the regression that
    // let three concurrent sessions each land an APPROVE on the same PR
    const b = await instanceB.guard({ callId: 'b1', workspace: WS, prNumber: 8, verdict: 'APPROVE' })
    expect(b?.block).toBe(true)
  })

  test('two verdict calls racing through guard() before either awaits the remote check yield exactly one allow', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => {
        await gate
        return { ok: true, effective: 'NONE' }
      },
    })
    const both = Promise.all([
      g.guard({ callId: 'a1', workspace: WS, prNumber: 21, verdict: 'APPROVE' }),
      g.guard({ callId: 'a2', workspace: WS, prNumber: 21, verdict: 'APPROVE' }),
    ])
    release()
    const [r1, r2] = await both
    expect([r1, r2].filter((r) => r === null)).toHaveLength(1)
    expect([r1, r2].filter((r) => r !== null)).toHaveLength(1)
  })

  test('blocks an APPROVE when the bot already effectively approved the PR on GitHub', async () => {
    const g = makeGuard({ [`${WS}#9`]: 'APPROVED' })
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 9, verdict: 'APPROVE' })
    expect(decision).toMatchObject({ block: true, kind: 'duplicate', duplicateSource: 'standing' })
  })

  test('allows APPROVE when the bot previously requested changes (a real re-review)', async () => {
    const g = makeGuard({ [`${WS}#11`]: 'CHANGES_REQUESTED' })
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 11, verdict: 'APPROVE' })
    expect(decision).toBeNull()
  })

  test('blocks a REQUEST_CHANGES when the bot already holds a standing CHANGES_REQUESTED', async () => {
    const g = makeGuard({ [`${WS}#23`]: 'CHANGES_REQUESTED' })
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 23, verdict: 'REQUEST_CHANGES' })
    expect(decision).toMatchObject({ block: true, kind: 'duplicate', duplicateSource: 'standing' })
  })

  test('can retain a duplicate REQUEST_CHANGES lease through a caller-managed fallback', async () => {
    const g = makeGuard({ [`${WS}#54`]: 'CHANGES_REQUESTED' })
    const decision = await g.guard({
      callId: 'a1',
      workspace: WS,
      prNumber: 54,
      verdict: 'REQUEST_CHANGES',
      retainDuplicateLease: true,
    })
    expect(decision).toMatchObject({
      block: true,
      kind: 'duplicate',
      duplicateSource: 'standing',
      leaseRetained: true,
    })

    const concurrent = await g.guard({
      callId: 'a2',
      workspace: WS,
      prNumber: 54,
      verdict: 'REQUEST_CHANGES',
      retainDuplicateLease: true,
    })
    expect(concurrent).toMatchObject({ block: true, kind: 'concurrent' })

    await g.release({ callId: 'a1', succeeded: false })
    const next = await g.guard({ callId: 'a3', workspace: WS, prNumber: 54, verdict: 'REQUEST_CHANGES' })
    expect(next).toMatchObject({ block: true, kind: 'duplicate' })
  })

  test('allows REQUEST_CHANGES when the bot previously approved (a real demotion)', async () => {
    const g = makeGuard({ [`${WS}#24`]: 'APPROVED' })
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 24, verdict: 'REQUEST_CHANGES' })
    expect(decision).toBeNull()
  })

  test('blocks a concurrent REQUEST_CHANGES while the first is in flight (symmetry with APPROVE)', async () => {
    const g = makeGuard()
    const first = await g.guard({ callId: 'a1', workspace: WS, prNumber: 25, verdict: 'REQUEST_CHANGES' })
    expect(first).toBeNull()
    const second = await g.guard({ callId: 'a2', workspace: WS, prNumber: 25, verdict: 'REQUEST_CHANGES' })
    expect(second?.block).toBe(true)
  })

  test('releasing a failed verdict lets a later genuine verdict through', async () => {
    const g = makeGuard()
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 13, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: false })
    const retry = await g.guard({ callId: 'a2', workspace: WS, prNumber: 13, verdict: 'APPROVE' })
    expect(retry).toBeNull()
  })

  test('after a succeeded APPROVE the next attempt defers to the resolver, which blocks once GitHub reports APPROVED', async () => {
    const g = makeGuard({ [`${WS}#15`]: 'APPROVED' })
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 15, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: true })
    const dup = await g.guard({ callId: 'a2', workspace: WS, prNumber: 15, verdict: 'APPROVE' })
    expect(dup?.block).toBe(true)
  })

  test('a superseded approval no longer strands the bot: after a succeeded APPROVE is later demoted to CHANGES_REQUESTED, a re-APPROVE is allowed (35287f99 invariant)', async () => {
    // given: the first APPROVE landed and the in-flight lease was released
    const g = makeGuard({})
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 16, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: true })
    // when: GitHub's effective state has since moved off APPROVED (resolver defaults
    // to NONE) and a genuine re-approval fires — no headSha resolver, so the lag
    // shield cannot fire and GitHub stays authoritative
    const reapprove = await g.guard({ callId: 'a2', workspace: WS, prNumber: 16, verdict: 'APPROVE' })
    // then: no stale local memory blocks the genuine re-approval
    expect(reapprove).toBeNull()
  })

  test('a remote-already-approved block releases the in-flight lease so a later supersession can re-approve', async () => {
    let effective: EffectiveVerdict = 'APPROVED'
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => ({ ok: true, effective }),
    })
    const blocked = await g.guard({ callId: 'a1', workspace: WS, prNumber: 18, verdict: 'APPROVE' })
    expect(blocked?.block).toBe(true)
    // when: the standing approval is later superseded upstream
    effective = 'NONE'
    const reapprove = await g.guard({ callId: 'a2', workspace: WS, prNumber: 18, verdict: 'APPROVE' })
    // then: the earlier block did not leave a stale lease behind
    expect(reapprove).toBeNull()
  })

  test('an expired lease is reclaimable so a crashed tool.after never strands the PR forever', async () => {
    let clock = 1_000
    const g = makeGuard({}, () => clock)
    // given: a verdict reserved the PR but tool.after never fired (crash)
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 26, verdict: 'APPROVE' })
    // when: more than the lease TTL elapses
    clock += 5 * 60_000 + 1
    // then: a fresh verdict can reclaim the abandoned lease
    const reclaimed = await g.guard({ callId: 'a2', workspace: WS, prNumber: 26, verdict: 'APPROVE' })
    expect(reclaimed).toBeNull()
  })

  test('a fresh lease is not reclaimable before the TTL elapses', async () => {
    let clock = 1_000
    const g = makeGuard({}, () => clock)
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 27, verdict: 'APPROVE' })
    clock += 5 * 60_000 - 1
    const blocked = await g.guard({ callId: 'a2', workspace: WS, prNumber: 27, verdict: 'APPROVE' })
    expect(blocked?.block).toBe(true)
  })

  test('a stale tool.after for a reclaimed reservation does not drop the live session lease', async () => {
    let clock = 1_000
    const g = makeGuard({}, () => clock)
    // given: session 1 reserves, then its lease is reclaimed after TTL by session 2
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 28, verdict: 'APPROVE' })
    clock += 5 * 60_000 + 1
    await g.guard({ callId: 'a2', workspace: WS, prNumber: 28, verdict: 'APPROVE' })
    // when: session 1's tool.after finally fires (stale)
    await g.release({ callId: 'a1', succeeded: false })
    // then: session 2 still holds the lease, so a third attempt is blocked
    const third = await g.guard({ callId: 'a3', workspace: WS, prNumber: 28, verdict: 'APPROVE' })
    expect(third?.block).toBe(true)
  })

  test('ignores COMMENT-only / non-verdict review events', async () => {
    const g = makeGuard({ [`${WS}#17`]: 'APPROVED' })
    // The guard's caller only passes APPROVE / REQUEST_CHANGES; a non-verdict
    // value must never be treated as a duplicate. Cast simulates a future verdict
    // type slipping through.
    const decision = await g.guard({
      callId: 'a1',
      workspace: WS,
      prNumber: 17,
      verdict: 'COMMENT' as 'APPROVE',
    })
    expect(decision).toBeNull()
  })

  test('fails open on a resolver error so a genuine verdict is never permanently blocked', async () => {
    const g = makeGuard({ [`${WS}#19`]: 'error' })
    const decision = await g.guard({ callId: 'a1', workspace: WS, prNumber: 19, verdict: 'APPROVE' })
    // A transient GitHub read failure must not strand the bot; the in-flight
    // lease still guards the concurrent-duplicate case.
    expect(decision).toBeNull()
  })

  test('a concurrent verdict still blocks even when the remote read fails open', async () => {
    const g = makeGuard({ [`${WS}#29`]: 'error' })
    const first = await g.guard({ callId: 'a1', workspace: WS, prNumber: 29, verdict: 'APPROVE' })
    expect(first).toBeNull()
    const second = await g.guard({ callId: 'a2', workspace: WS, prNumber: 29, verdict: 'APPROVE' })
    expect(second?.block).toBe(true)
  })

  // The read-after-write-lag shield: a first verdict's lease is released (turn
  // done) but GitHub's reviews read still lags, reporting NONE — the exact gap that
  // landed two APPROVEs on PR #691. The resolver returns NONE so these exercise the
  // raw-NONE path the shield is allowed to override.
  const LAG_WINDOW_MS = 5 * 60_000
  function makeShaGuard(headSha: string | null, now?: () => number) {
    return createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
      resolveHeadSha: async () => headSha,
      now,
    })
  }

  test('blocks a second same-commit APPROVE inside the anti-lag window even when GitHub still reports NONE', async () => {
    // given: a first APPROVE landed and released, GitHub reviews read still stale (NONE)
    const g = makeShaGuard('sha-abc')
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 30, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: true })
    // when: a second engagement turn fires a fresh APPROVE on the same head
    const dup = await g.guard({ callId: 'a2', workspace: WS, prNumber: 30, verdict: 'APPROVE' })
    // then: the lag shield resolves the NONE as a not-yet-indexed duplicate and blocks
    expect(dup?.block).toBe(true)
  })

  test('allows a re-verdict on a NEW head SHA (a genuine re-review of a fresh push)', async () => {
    // given: an APPROVE landed at one commit
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
      resolveHeadSha: async ({ prNumber }) => (prNumber === 31 ? currentSha : 'unused'),
    })
    let currentSha = 'sha-old'
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 31, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: true })
    // when: the author pushes a new commit and a re-review fires on the new head
    currentSha = 'sha-new'
    const reapprove = await g.guard({ callId: 'a2', workspace: WS, prNumber: 31, verdict: 'APPROVE' })
    // then: the new head misses the cache, so the genuine re-review is allowed
    expect(reapprove).toBeNull()
  })

  test('allows a flipped verdict on the same commit (APPROVE then REQUEST_CHANGES is a real supersession)', async () => {
    const g = makeShaGuard('sha-abc')
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 32, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: true })
    const flip = await g.guard({ callId: 'a2', workspace: WS, prNumber: 32, verdict: 'REQUEST_CHANGES' })
    expect(flip).toBeNull()
  })

  test('push-during-review: head advances between guard and release, so the duplicate is still blocked on the new head', async () => {
    // given: the head is sha-old when the review is authorized, but a push lands
    // before the review does, so the post-submit re-resolve sees sha-new
    let currentSha = 'sha-old'
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
      resolveHeadSha: async () => currentSha,
    })
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 40, verdict: 'APPROVE' })
    // when: the PR head advances before the successful submit is recorded
    currentSha = 'sha-new'
    await g.release({ callId: 'a1', succeeded: true })
    // then: pre (sha-old) != post (sha-new), so the record stores the null
    // uncertainty sentinel; a second same-verdict review on the current head is
    // still caught as lag rather than slipping through on the SHA mismatch
    const dup = await g.guard({ callId: 'a2', workspace: WS, prNumber: 40, verdict: 'APPROVE' })
    expect(dup?.block).toBe(true)
  })

  test('a genuine new push after the uncertain landing still allows a re-review once GitHub shows the prior review', async () => {
    // given: an uncertain (null-head) landing, then GitHub catches up to APPROVED
    let currentSha = 'sha-old'
    let effective: EffectiveVerdict = 'NONE'
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => ({ ok: true, effective }),
      resolveHeadSha: async () => currentSha,
    })
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 41, verdict: 'APPROVE' })
    currentSha = 'sha-new'
    await g.release({ callId: 'a1', succeeded: true })
    // when: GitHub now reports the standing APPROVED and the author asks for a
    // re-review (REQUEST_CHANGES is a demotion) — layer 2 decides before the shield
    effective = 'APPROVED'
    const flip = await g.guard({ callId: 'a2', workspace: WS, prNumber: 41, verdict: 'REQUEST_CHANGES' })
    // then: the demotion passes; the null-head shield never blocks a flipped verdict
    expect(flip).toBeNull()
  })

  test('a failed first verdict leaves no landed record, so a genuine retry passes', async () => {
    const g = makeShaGuard('sha-abc')
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 33, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: false })
    const retry = await g.guard({ callId: 'a2', workspace: WS, prNumber: 33, verdict: 'APPROVE' })
    expect(retry).toBeNull()
  })

  test('the landed record expires after the anti-lag window so GitHub state retakes authority', async () => {
    let clock = 1_000
    const g = makeShaGuard('sha-abc', () => clock)
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 34, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: true })
    clock += LAG_WINDOW_MS + 1
    // with the record expired and the resolver reporting NONE, a re-approve passes
    const after = await g.guard({ callId: 'a2', workspace: WS, prNumber: 34, verdict: 'APPROVE' })
    expect(after).toBeNull()
  })

  test('the lag shield still fires one tick before the window expires', async () => {
    let clock = 1_000
    const g = makeShaGuard('sha-abc', () => clock)
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 39, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: true })
    clock += LAG_WINDOW_MS - 1
    const dup = await g.guard({ callId: 'a2', workspace: WS, prNumber: 39, verdict: 'APPROVE' })
    expect(dup?.block).toBe(true)
  })

  test('thread fan-out: four sequential same-commit APPROVEs ~5s apart land only the first', async () => {
    // The real incident: one channel session per inline review thread each fired a
    // formal APPROVE on the same head while GitHub's reviews read still lagged
    // (NONE). With detection now arming the shield on the first landed verdict, the
    // three followers within the window are blocked.
    let clock = 1_000
    const g = makeShaGuard('sha-abc', () => clock)
    const first = await g.guard({ callId: 't1', workspace: WS, prNumber: 224, verdict: 'APPROVE' })
    expect(first).toBeNull()
    await g.release({ callId: 't1', succeeded: true })
    for (const callId of ['t2', 't3', 't4']) {
      clock += 5_000
      const dup = await g.guard({ callId, workspace: WS, prNumber: 224, verdict: 'APPROVE' })
      expect(dup?.block).toBe(true)
    }
  })

  test('a legitimate re-APPROVE just past the 5-minute window is allowed', async () => {
    let clock = 1_000
    const g = makeShaGuard('sha-abc', () => clock)
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 42, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: true })
    clock += LAG_WINDOW_MS + 1
    const after = await g.guard({ callId: 'a2', workspace: WS, prNumber: 42, verdict: 'APPROVE' })
    expect(after).toBeNull()
  })

  // The cooldown extension (PR #1042 incident): thread fan-out spread three
  // same-commit APPROVEs over ~2 minutes, each AFTER GitHub had indexed the
  // prior ones — so the standing-verdict read no longer returned a bare NONE for
  // the lag shield to override, yet the redundant verdict still landed. The
  // cooldown now fires on any same-verdict + same-head land within the window,
  // regardless of what GitHub's effective read reports, and the window is 5 min.
  test('blocks a same-commit same-verdict re-APPROVE within the cooldown even when GitHub already reports the standing APPROVED', async () => {
    // given: an APPROVE landed at sha-abc and GitHub has since indexed it
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'APPROVED' }),
      resolveHeadSha: async () => 'sha-abc',
    })
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 50, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: true })
    // when: a fan-out sibling fires the same verdict on the same head minutes later
    const dup = await g.guard({ callId: 'a2', workspace: WS, prNumber: 50, verdict: 'APPROVE' })
    // then: the cooldown blocks the redundant duplicate (Layer 2 already blocks
    // this standing case too, but the cooldown must independently hold)
    expect(dup?.block).toBe(true)
  })

  test('the cooldown window is 5 minutes: a same-commit re-APPROVE blocks at 4m59s and passes at 5m01s', async () => {
    let clock = 1_000
    const g = makeShaGuard('sha-abc', () => clock)
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 51, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: true })
    // just inside the 5-minute window — still blocked
    clock += 5 * 60_000 - 1_000
    const inside = await g.guard({ callId: 'a2', workspace: WS, prNumber: 51, verdict: 'APPROVE' })
    expect(inside?.block).toBe(true)
    // just outside the 5-minute window — genuine re-review allowed
    clock += 2_000
    const outside = await g.guard({ callId: 'a3', workspace: WS, prNumber: 51, verdict: 'APPROVE' })
    expect(outside).toBeNull()
  })

  test('cooldown does not block a genuine DISMISSED-then-reapprove on the same commit (35287f99 invariant holds)', async () => {
    // given: an APPROVE landed at sha-abc
    let effective: EffectiveVerdict = 'NONE'
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => ({ ok: true, effective }),
      resolveHeadSha: async () => 'sha-abc',
    })
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 52, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: true })
    // when: the approval is genuinely dismissed and a fresh re-APPROVE fires on
    // the SAME commit inside the cooldown window
    effective = 'DISMISSED'
    const reapprove = await g.guard({ callId: 'a2', workspace: WS, prNumber: 52, verdict: 'APPROVE' })
    // then: a real dismissal is a legitimate reason to re-approve — the cooldown
    // must not strand it (DISMISSED is decisive, not a redundant duplicate)
    expect(reapprove).toBeNull()
  })

  test('cooldown allows a flipped verdict on the same commit even within the window', async () => {
    const g = makeShaGuard('sha-abc')
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 53, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: true })
    // a REQUEST_CHANGES after an APPROVE is a real supersession, never a duplicate
    const flip = await g.guard({ callId: 'a2', workspace: WS, prNumber: 53, verdict: 'REQUEST_CHANGES' })
    expect(flip).toBeNull()
  })

  test('noteLandedReview arms the shield with no prior reservation (backstop path)', async () => {
    // given: a verdict landed via a command shape pre-detection missed — no guard()
    // ran, so there is no reservation and release() could not arm the shield
    const g = makeShaGuard('sha-abc')
    await g.noteLandedReview({ workspace: WS, prNumber: 43, verdict: 'APPROVE' })
    // when: the next same-commit APPROVE fires while GitHub still reports NONE
    const dup = await g.guard({ callId: 'a1', workspace: WS, prNumber: 43, verdict: 'APPROVE' })
    // then: the lag shield blocks it — the gap the backstop was meant to close
    expect(dup?.block).toBe(true)
  })

  test('noteLandedReview respects head SHA: a re-review on a new head is still allowed', async () => {
    let currentSha = 'sha-old'
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
      resolveHeadSha: async () => currentSha,
    })
    await g.noteLandedReview({ workspace: WS, prNumber: 44, verdict: 'APPROVE' })
    currentSha = 'sha-new'
    const reapprove = await g.guard({ callId: 'a1', workspace: WS, prNumber: 44, verdict: 'APPROVE' })
    expect(reapprove).toBeNull()
  })

  test('noteLandedReview ignores a non-verdict event', async () => {
    const g = makeShaGuard('sha-abc')
    await g.noteLandedReview({ workspace: WS, prNumber: 45, verdict: 'COMMENT' as 'APPROVE' })
    const next = await g.guard({ callId: 'a1', workspace: WS, prNumber: 45, verdict: 'APPROVE' })
    expect(next).toBeNull()
  })

  test('the landed cache is process-wide: a second plugin instance sees the first instance landed verdict', async () => {
    const deps = {
      resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' as EffectiveVerdict }),
      resolveHeadSha: async () => 'sha-abc',
    }
    const instanceA = createApproveIdempotencyGuard(deps)
    const instanceB = createApproveIdempotencyGuard(deps)
    await instanceA.guard({ callId: 'a1', workspace: WS, prNumber: 35, verdict: 'APPROVE' })
    await instanceA.release({ callId: 'a1', succeeded: true })
    const dup = await instanceB.guard({ callId: 'b1', workspace: WS, prNumber: 35, verdict: 'APPROVE' })
    expect(dup?.block).toBe(true)
  })

  test('fails open to GitHub when the head SHA is unknown (resolver null) so a supersession is never blocked on local memory', async () => {
    // given: the head SHA could not be resolved on either attempt
    const g = makeShaGuard(null)
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 36, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: true })
    // when: a second same-verdict attempt arrives and GitHub reports NONE
    const dup = await g.guard({ callId: 'a2', workspace: WS, prNumber: 36, verdict: 'APPROVE' })
    // then: with no resolvable head to prove same-commit lag, the lag shield does
    // NOT fire — GitHub stays authoritative, preserving the supersession invariant
    expect(dup).toBeNull()
  })

  test('a genuine DISMISSED is not treated as lag: a same-commit re-APPROVE within the window is allowed (no 35287f99 regression)', async () => {
    let effective: EffectiveVerdict = 'NONE'
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => ({ ok: true, effective }),
      resolveHeadSha: async () => 'sha-abc',
    })
    // given: an APPROVE landed at sha-abc
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 37, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: true })
    // when: that approval is dismissed (GitHub now reports DISMISSED) and a
    // re-APPROVE on the SAME commit fires inside the lag window
    effective = 'DISMISSED'
    const reapprove = await g.guard({ callId: 'a2', workspace: WS, prNumber: 37, verdict: 'APPROVE' })
    // then: DISMISSED is decisive, not a bare NONE, so the lag shield is bypassed
    // and the genuine re-approval is allowed
    expect(reapprove).toBeNull()
  })

  test('a flipped verdict on the same commit is allowed even while GitHub still reports the prior standing verdict', async () => {
    let effective: EffectiveVerdict = 'NONE'
    const g = createApproveIdempotencyGuard({
      resolveEffectiveApproval: async () => ({ ok: true, effective }),
      resolveHeadSha: async () => 'sha-abc',
    })
    await g.guard({ callId: 'a1', workspace: WS, prNumber: 38, verdict: 'APPROVE' })
    await g.release({ callId: 'a1', succeeded: true })
    // GitHub now shows the standing APPROVED; a REQUEST_CHANGES is a demotion
    effective = 'APPROVED'
    const flip = await g.guard({ callId: 'a2', workspace: WS, prNumber: 38, verdict: 'REQUEST_CHANGES' })
    expect(flip).toBeNull()
  })
})
