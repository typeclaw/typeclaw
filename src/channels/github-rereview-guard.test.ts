import { afterEach, describe, expect, it } from 'bun:test'

import { evaluateRereviewGuard, type RereviewGuardInput } from './github-rereview-guard'
import { __resetReviewVerdictGuardForTest, registerGithubReviewRound } from './github-review-verdict-coordinator'

const ROUND = { workspace: 'acme/widgets', prNumber: 644, headSha: 'sha-round', carrierThread: '12345' } as const

function input(overrides: Partial<RereviewGuardInput> = {}): RereviewGuardInput {
  return {
    adapter: 'github',
    chat: 'pr:644',
    thread: '12345',
    text: 'Verified — that closes it, thanks!',
    wantsResolve: true,
    moreWorkThisTurn: false,
    workspace: 'acme/widgets',
    getReviewState: async () => ({ ok: true, selfBlocking: true, approve: true }),
    ...overrides,
  }
}

const stateOk =
  (
    selfBlocking: boolean,
    approve = true,
    reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED',
  ): RereviewGuardInput['getReviewState'] =>
  async () => ({ ok: true, selfBlocking, approve, ...(reviewDecision !== undefined ? { reviewDecision } : {}) })

describe('re-review stranding guard', () => {
  afterEach(() => __resetReviewVerdictGuardForTest())

  it('blocks a resolve while the bot holds a live CHANGES_REQUESTED (PR #644 scenario)', async () => {
    const decision = await evaluateRereviewGuard(input({ getReviewState: stateOk(true) }))
    expect(decision.block).toBe(true)
    if (decision.block) expect(decision.reason).toContain('APPROVE')
  })

  it('allows the resolve once the bot no longer blocks the PR', async () => {
    const decision = await evaluateRereviewGuard(input({ getReviewState: stateOk(false) }))
    expect(decision).toEqual({ block: false })
  })

  it('allows a non-carrier close-out when authoritative state says the block is gone', async () => {
    registerGithubReviewRound(ROUND)
    let queried = false
    const decision = await evaluateRereviewGuard(
      input({
        thread: '202',
        round: ROUND,
        getReviewState: async () => {
          queried = true
          return { ok: true, selfBlocking: false, approve: true }
        },
      }),
    )
    expect(decision).toEqual({ block: false })
    expect(queried).toBe(true)
  })

  it('uses the authoritative sticky-block guard for a non-carrier close-out during a pending round', async () => {
    registerGithubReviewRound(ROUND)
    const decision = await evaluateRereviewGuard(
      input({
        round: ROUND,
        thread: '202',
        getReviewState: stateOk(true),
      }),
    )
    expect(decision.block).toBe(true)
    if (decision.block) expect(decision.reason).toContain('APPROVE')
  })

  it('branches the denial to dismissal when approval is disabled', async () => {
    const decision = await evaluateRereviewGuard(input({ getReviewState: stateOk(true, false) }))
    expect(decision.block).toBe(true)
    if (decision.block) {
      expect(decision.reason).toContain('dismiss')
      expect(decision.reason).not.toContain('event: APPROVE')
    }
  })

  it('fails closed when review state cannot be verified', async () => {
    const decision = await evaluateRereviewGuard(
      input({ getReviewState: async () => ({ ok: false, error: 'GitHub reviews 503', code: 'transient' }) }),
    )
    expect(decision.block).toBe(true)
    if (decision.block) expect(decision.reason).toContain('Could not verify')
  })

  it('fires on a close-out claim even without the resolve flag', async () => {
    const decision = await evaluateRereviewGuard(
      input({ wantsResolve: false, text: 'Confirmed fixed — that resolves it.', getReviewState: stateOk(true) }),
    )
    expect(decision.block).toBe(true)
  })

  it('allows a mixed verdict that keeps the thread open while the bot still blocks the PR', async () => {
    const decision = await evaluateRereviewGuard(
      input({
        wantsResolve: false,
        text:
          'Verified: the original status-send latch issue is fixed at `2290b80`. ' +
          'I can’t resolve this thread yet because the PR still has a blocking issue in the recovered-final-prose path.',
        getReviewState: stateOk(true),
      }),
    )

    expect(decision).toEqual({ block: false })
  })

  it('still blocks a genuine close-out while the bot holds a live CHANGES_REQUESTED', async () => {
    const decision = await evaluateRereviewGuard(
      input({
        wantsResolve: false,
        text: 'Verified, all fixed. Resolving this thread.',
        getReviewState: stateOk(true),
      }),
    )

    expect(decision.block).toBe(true)
  })

  it('does not fire on ordinary discussion replies', async () => {
    let queried = false
    const decision = await evaluateRereviewGuard(
      input({
        wantsResolve: false,
        text: 'Thanks for the context, I think this approach makes sense.',
        getReviewState: async () => {
          queried = true
          return { ok: true, selfBlocking: true, approve: true }
        },
      }),
    )
    expect(decision).toEqual({ block: false })
    expect(queried).toBe(false)
  })

  it('never fires on non-github adapters', async () => {
    const decision = await evaluateRereviewGuard(input({ adapter: 'slack-bot' }))
    expect(decision).toEqual({ block: false })
  })

  it('never fires on a non-PR chat', async () => {
    const decision = await evaluateRereviewGuard(input({ chat: 'issue:5' }))
    expect(decision).toEqual({ block: false })
  })

  it('allows a no-thread plain discussion reply on a PR', async () => {
    const decision = await evaluateRereviewGuard(
      input({ thread: null, wantsResolve: false, text: 'Thanks — I think this approach works.' }),
    )
    expect(decision).toEqual({ block: false })
  })

  it('blocks a no-thread close-out PR comment while the bot still blocks the PR', async () => {
    const decision = await evaluateRereviewGuard(
      input({
        thread: null,
        wantsResolve: false,
        text: 'Verified — that resolves it, thanks!',
        getReviewState: stateOk(true),
      }),
    )
    expect(decision.block).toBe(true)
  })

  // Regression: PR #649. The bot held a live CHANGES_REQUESTED, the author said
  // "Addressed", and the bot replied "Looks good — … solid cleanup ✨" as a plain
  // PR comment. That text classifies as warn-tier, not block-approve, so the old
  // guard short-circuited to ALLOW and the comment stranded the block.
  it('blocks a warn-tier "looks good" re-review reply while the bot still blocks the PR', async () => {
    const decision = await evaluateRereviewGuard(
      input({
        thread: null,
        wantsResolve: false,
        text: 'Looks good — the remaining leak paths are fixed. Tests are green, so this is a solid cleanup. ✨',
        getReviewState: stateOk(true),
      }),
    )
    expect(decision.block).toBe(true)
    if (decision.block) expect(decision.reason).toContain('APPROVE')
  })

  it('allows a warn-tier "looks good" when the bot holds no outstanding block', async () => {
    const decision = await evaluateRereviewGuard(
      input({ thread: null, wantsResolve: false, text: 'lgtm, nice work', getReviewState: stateOk(false) }),
    )
    expect(decision).toEqual({ block: false })
  })

  it('blocks a warn-tier LGTM when GitHub still requires a formal review (PR #653)', async () => {
    const decision = await evaluateRereviewGuard(
      input({
        thread: null,
        wantsResolve: false,
        text: 'LGTM — the dedupe is scoped to the per-session turn boundary exactly as described.',
        getReviewState: stateOk(false, true, 'REVIEW_REQUIRED'),
      }),
    )
    expect(decision.block).toBe(true)
    if (decision.block) expect(decision.reason).toContain('formal GitHub review')
  })

  it('does not query review state for casual discussion even when reviews may be required', async () => {
    let queried = false
    const decision = await evaluateRereviewGuard(
      input({
        thread: null,
        wantsResolve: false,
        text: 'Thanks for the context — that makes sense.',
        getReviewState: async () => {
          queried = true
          return { ok: true, selfBlocking: false, approve: true, reviewDecision: 'REVIEW_REQUIRED' }
        },
      }),
    )
    expect(decision).toEqual({ block: false })
    expect(queried).toBe(false)
  })

  it('fails closed on a warn-tier reply when review state cannot be verified', async () => {
    const decision = await evaluateRereviewGuard(
      input({
        thread: null,
        wantsResolve: false,
        text: 'looks good to me',
        getReviewState: async () => ({ ok: false, error: 'GitHub reviews 503', code: 'transient' }),
      }),
    )
    expect(decision.block).toBe(true)
    if (decision.block) expect(decision.reason).toContain('Could not verify')
  })

  it('exempts a mid-turn warn-tier status reply (more_work_this_turn:true) from the state query', async () => {
    let queried = false
    const decision = await evaluateRereviewGuard(
      input({
        thread: null,
        wantsResolve: false,
        moreWorkThisTurn: true,
        text: 'Looks good so far — spawning the reviewer now, back shortly.',
        getReviewState: async () => {
          queried = true
          return { ok: true, selfBlocking: true, approve: true }
        },
      }),
    )
    expect(decision).toEqual({ block: false })
    expect(queried).toBe(false)
  })

  it('still resolves-blocks an explicit thread resolve even mid-turn (more_work_this_turn:true)', async () => {
    const decision = await evaluateRereviewGuard(
      input({
        thread: '999',
        wantsResolve: true,
        moreWorkThisTurn: true,
        text: 'one sec',
        getReviewState: stateOk(true),
      }),
    )
    expect(decision.block).toBe(true)
  })

  // A negative warn phrase re-asserts the block instead of stranding it, so the
  // guard must not query state or block it (PR #652 review). Only positive,
  // approval-shaped warns are closeout attempts.
  it.each(['still needs work', 'this needs changes before it lands'])(
    'does not fire on a negative warn reply that re-asserts the block: %p',
    async (text) => {
      let queried = false
      const decision = await evaluateRereviewGuard(
        input({
          thread: null,
          wantsResolve: false,
          text,
          getReviewState: async () => {
            queried = true
            return { ok: true, selfBlocking: true, approve: true }
          },
        }),
      )
      expect(decision).toEqual({ block: false })
      expect(queried).toBe(false)
    },
  )
})
