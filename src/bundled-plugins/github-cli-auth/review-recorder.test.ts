import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __resetReviewObserverForTest,
  hasReview,
  resetReviewTurn,
  type ReviewOutputState,
  setReviewOutputObserver,
} from '@/channels/github-review-turn-ledger'
import {
  __resetReviewVerdictGuardForTest,
  createApproveIdempotencyGuard,
} from '@/channels/github-review-verdict-coordinator'
import type { ToolResult } from '@/plugin'

import { commitReviewIfSucceeded, dismissalMutationSucceeded, noteReviewCommand } from './review-recorder'

const SESSION = 'ses_recorder'
const WS = 'acme/widgets'

afterEach(() => {
  resetReviewTurn(SESSION)
  __resetReviewVerdictGuardForTest()
  __resetReviewObserverForTest()
})

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

const SUCCESS_OUTPUT = '{"id":1,"node_id":"PRR_abc","state":"APPROVED"}'
const FAILURE_OUTPUT = 'gh: Validation Failed (HTTP 422)'

describe('review recorder', () => {
  test('accepts only an explicit DISMISSED mutation result', () => {
    expect(dismissalMutationSucceeded(textResult('{"id":1,"state":"DISMISSED"}'))).toBe(true)
    expect(dismissalMutationSucceeded(textResult('gh: Validation Failed (HTTP 422)'))).toBe(false)
    expect(dismissalMutationSucceeded(textResult('{"id":1,"state":"CHANGES_REQUESTED"}'))).toBe(false)
  })
  test('credits the ledger when an inline-field APPROVE succeeds', async () => {
    await noteReviewCommand({
      callId: 'c1',
      command: `gh api /repos/${WS}/pulls/5/reviews -f event=APPROVE`,
    })
    commitReviewIfSucceeded({ sessionId: SESSION, callId: 'c1', result: textResult(SUCCESS_OUTPUT) })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(true)
  })

  test('does NOT credit when the command failed', async () => {
    await noteReviewCommand({
      callId: 'c2',
      command: `gh api /repos/${WS}/pulls/5/reviews -f event=APPROVE`,
    })
    commitReviewIfSucceeded({ sessionId: SESSION, callId: 'c2', result: textResult(FAILURE_OUTPUT) })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(false)
  })

  test('does NOT credit on an ambiguous result (fail closed)', async () => {
    await noteReviewCommand({
      callId: 'c3',
      command: `gh api /repos/${WS}/pulls/5/reviews -f event=APPROVE`,
    })
    commitReviewIfSucceeded({ sessionId: SESSION, callId: 'c3', result: textResult('(no recognizable output)') })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(false)
  })

  test('reads the verdict from an --input file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-rec-'))
    const file = join(dir, 'review.json')
    writeFileSync(file, '{"event":"REQUEST_CHANGES","body":"x"}')
    try {
      await noteReviewCommand({
        callId: 'c4',
        command: `gh api -X POST /repos/${WS}/pulls/9/reviews --input ${file}`,
      })
      commitReviewIfSucceeded({
        sessionId: SESSION,
        callId: 'c4',
        result: textResult('{"node_id":"PRR_z","state":"CHANGES_REQUESTED"}'),
      })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 9, verdict: 'REQUEST_CHANGES' })).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a non-review gh command is ignored', async () => {
    await noteReviewCommand({ callId: 'c5', command: `gh pr view 5 -R ${WS}` })
    commitReviewIfSucceeded({ sessionId: SESSION, callId: 'c5', result: textResult(SUCCESS_OUTPUT) })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 5, verdict: 'APPROVE' })).toBe(false)
  })

  test('credits a `gh pr review --approve` from its porcelain confirmation line', async () => {
    await noteReviewCommand({ callId: 'c6', command: `gh pr review 42 --approve -R ${WS}` })
    commitReviewIfSucceeded({
      sessionId: SESSION,
      callId: 'c6',
      result: textResult(`✓ Approved pull request ${WS}#42`),
    })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 42, verdict: 'APPROVE' })).toBe(true)
  })

  test('credits a `gh pr review --request-changes` from its porcelain confirmation line', async () => {
    await noteReviewCommand({ callId: 'c7', command: `gh pr review 42 --request-changes -R ${WS}` })
    commitReviewIfSucceeded({
      sessionId: SESSION,
      callId: 'c7',
      result: textResult(`+ Requested changes to pull request ${WS}#42`),
    })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 42, verdict: 'REQUEST_CHANGES' })).toBe(true)
  })

  test('does NOT credit a porcelain command whose output is missing the confirmation (fail closed)', async () => {
    await noteReviewCommand({ callId: 'c8', command: `gh pr review 42 --approve -R ${WS}` })
    commitReviewIfSucceeded({ sessionId: SESSION, callId: 'c8', result: textResult('(no recognizable output)') })
    expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 42, verdict: 'APPROVE' })).toBe(false)
  })

  describe('post-execution backstop (pre-detection missed)', () => {
    const LANDED_APPROVED = `{"id":7,"node_id":"PRR_x","state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/77"}`

    // The backstop now fires only after tool.before saw a real POST submission
    // attempt whose verdict it could not extract. A heredoc-bodied POST with the
    // payload in a separate file the before-detector did not resolve is the
    // canonical "attempt seen, verdict missed" case used to arm these tests.
    async function noteMissedAttempt(callId: string, prNumber: number): Promise<void> {
      await noteReviewCommand({
        callId,
        command: `gh api -X POST /repos/${WS}/pulls/${prNumber}/reviews --input /tmp/missing-${prNumber}.json`,
      })
    }

    test('credits a landed APPROVE from the REST response for an attempted POST whose verdict was missed', async () => {
      await noteMissedAttempt('b1', 77)
      commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b1', result: textResult(LANDED_APPROVED) })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 77, verdict: 'APPROVE' })).toBe(true)
    })

    test('credits a landed CHANGES_REQUESTED from the REST response', async () => {
      await noteMissedAttempt('b2', 78)
      const out = `{"state":"CHANGES_REQUESTED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/78"}`
      commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b2', result: textResult(out) })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 78, verdict: 'REQUEST_CHANGES' })).toBe(true)
    })

    test('does NOT credit a reviews-list READ whose response array carries a decisive state', async () => {
      // given: a GET that LISTS existing reviews (no -X POST) — not a submission
      await noteReviewCommand({ callId: 'bread', command: `gh api /repos/${WS}/pulls/84/reviews` })
      // when: the response array contains an existing APPROVED review + a pulls URL
      const out = `[{"state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/84"}]`
      const result = commitReviewIfSucceeded({ sessionId: SESSION, callId: 'bread', result: textResult(out) })
      // then: no attempt marker was recorded, so the backstop never runs
      expect(result.committed).toBe(false)
      expect(result.landedFromResult).toBeNull()
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 84, verdict: 'APPROVE' })).toBe(false)
    })

    test('does NOT credit when no submission attempt was recorded at all', () => {
      const result = commitReviewIfSucceeded({
        sessionId: SESSION,
        callId: 'bnone',
        result: textResult(LANDED_APPROVED),
      })
      expect(result.committed).toBe(false)
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 77, verdict: 'APPROVE' })).toBe(false)
    })

    test('does NOT credit when the attempted PR does not match the PR in the response', async () => {
      await noteMissedAttempt('bmismatch', 85)
      const out = `{"state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/999"}`
      const result = commitReviewIfSucceeded({ sessionId: SESSION, callId: 'bmismatch', result: textResult(out) })
      expect(result.committed).toBe(false)
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 999, verdict: 'APPROVE' })).toBe(false)
    })

    test('does NOT credit when the state is present but a failure marker is also present (fail closed)', async () => {
      await noteMissedAttempt('b3', 79)
      const out = `gh: Validation Failed (HTTP 422) {"state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/79"}`
      commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b3', result: textResult(out) })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 79, verdict: 'APPROVE' })).toBe(false)
    })

    test('does NOT credit a decisive state with no recoverable PR url', async () => {
      await noteMissedAttempt('b4', 77)
      commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b4', result: textResult('{"state":"APPROVED"}') })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 77, verdict: 'APPROVE' })).toBe(false)
    })

    test('does NOT credit a COMMENT review state', async () => {
      await noteMissedAttempt('b5', 80)
      const out = `{"state":"COMMENTED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/80"}`
      commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b5', result: textResult(out) })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 80, verdict: 'APPROVE' })).toBe(false)
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 80, verdict: 'REQUEST_CHANGES' })).toBe(false)
    })

    test('the pending-entry path takes precedence over the backstop', async () => {
      await noteReviewCommand({ callId: 'b6', command: `gh api /repos/${WS}/pulls/81/reviews -f event=APPROVE` })
      commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b6', result: textResult(SUCCESS_OUTPUT) })
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 81, verdict: 'APPROVE' })).toBe(true)
    })

    test('a pending-path commit returns no landedFromResult (release arms the shield)', async () => {
      await noteReviewCommand({ callId: 'b7', command: `gh api /repos/${WS}/pulls/82/reviews -f event=APPROVE` })
      const result = commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b7', result: textResult(SUCCESS_OUTPUT) })
      expect(result.committed).toBe(true)
      expect(result.landedFromResult).toBeNull()
    })

    test('the backstop result returns landedFromResult for the caller to arm the shield', async () => {
      await noteMissedAttempt('b8', 83)
      const out = `{"state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/83"}`
      const result = commitReviewIfSucceeded({ sessionId: SESSION, callId: 'b8', result: textResult(out) })
      expect(result.committed).toBe(true)
      expect(result.landedFromResult).toEqual({ workspace: WS, prNumber: 83, verdict: 'APPROVE', source: 'api' })
    })
  })

  // Mirrors the plugin's tool.after wiring (index.ts): commitReviewIfSucceeded ->
  // verdictGuard.noteLandedReview for the backstop path, then the next submission
  // hits guard(). Proves the advertised "arm the dedupe window" actually holds for
  // the fallback path — the gap the reviewer flagged.
  describe('integration: backstop arms the idempotency lag shield', () => {
    function makeGuard(headSha: string | null) {
      return createApproveIdempotencyGuard({
        resolveEffectiveApproval: async () => ({ ok: true, effective: 'NONE' }),
        resolveHeadSha: async () => headSha,
      })
    }

    test('pre-detection missed, REST response detected, next same-commit APPROVE is blocked while GitHub returns NONE', async () => {
      const guard = makeGuard('sha-abc')
      // given: a POST create-review whose verdict the before-detector missed (no
      // pending, no guard() reservation) but whose submission intent it DID record
      await noteReviewCommand({
        callId: 'i1',
        command: `gh api -X POST /repos/${WS}/pulls/90/reviews --input /tmp/missing-90.json`,
      })
      // and: only the REST result proves the landed verdict
      const out = `{"state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/90"}`
      const result = commitReviewIfSucceeded({ sessionId: SESSION, callId: 'i1', result: textResult(out) })
      // when: the plugin wires the recovered verdict into the guard, as tool.after does
      expect(result.landedFromResult).not.toBeNull()
      if (result.landedFromResult !== null) await guard.noteLandedReview(result.landedFromResult)
      // then: a second engagement turn's same-commit APPROVE is deduped even though
      // GitHub's reviews read still lags (NONE)
      const dup = await guard.guard({ callId: 'i2', workspace: WS, prNumber: 90, verdict: 'APPROVE' })
      expect(dup?.block).toBe(true)
    })
  })

  describe('COMMENT review output', () => {
    function captureOutput(): ReviewOutputState[] {
      const states: ReviewOutputState[] = []
      setReviewOutputObserver((args) => states.push(args.state))
      return states
    }

    test('credits review output (not the verdict ledger) for a successful COMMENT', async () => {
      const states = captureOutput()
      await noteReviewCommand({
        callId: 'cm1',
        command: `gh api -X POST /repos/${WS}/pulls/91/reviews -f event=COMMENT -f body=notes`,
      })
      const out = `{"state":"COMMENTED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/91"}`
      commitReviewIfSucceeded({ sessionId: SESSION, callId: 'cm1', result: textResult(out) })

      // the output observer sees the COMMENT, but it never enters the verdict ledger
      expect(states).toEqual(['COMMENT'])
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 91, verdict: 'APPROVE' })).toBe(false)
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 91, verdict: 'REQUEST_CHANGES' })).toBe(false)
    })

    test('a POST COMMENT does not leave a stale submission-attempt entry behind', async () => {
      captureOutput()
      // given: a COMMENT POST that succeeds — this is also a POST to the reviews
      // endpoint, so the OLD code armed the backstop attempt AND returned early,
      // never clearing it
      await noteReviewCommand({
        callId: 'cm2',
        command: `gh api -X POST /repos/${WS}/pulls/92/reviews -f event=COMMENT -f body=notes`,
      })
      commitReviewIfSucceeded({ sessionId: SESSION, callId: 'cm2', result: textResult('{"state":"COMMENTED"}') })

      // when: a later commit reuses the same callId with a decisive-verdict response,
      // a stale attempt would let the backstop credit a verdict that no command posted
      const landed = `{"state":"APPROVED","pull_request_url":"https://api.github.com/repos/${WS}/pulls/92"}`
      const result = commitReviewIfSucceeded({ sessionId: SESSION, callId: 'cm2', result: textResult(landed) })

      // then: no stale attempt remained, so nothing is credited
      expect(result.committed).toBe(false)
      expect(hasReview({ sessionId: SESSION, workspace: WS, prNumber: 92, verdict: 'APPROVE' })).toBe(false)
    })

    test('does NOT credit output when the COMMENT command failed (fail closed)', async () => {
      const states = captureOutput()
      await noteReviewCommand({
        callId: 'cm3',
        command: `gh api -X POST /repos/${WS}/pulls/93/reviews -f event=COMMENT -f body=notes`,
      })
      commitReviewIfSucceeded({ sessionId: SESSION, callId: 'cm3', result: textResult(FAILURE_OUTPUT) })
      expect(states).toEqual([])
    })
  })
})
