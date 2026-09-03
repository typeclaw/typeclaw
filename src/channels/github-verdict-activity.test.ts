import { describe, expect, test } from 'bun:test'

import { parsePrVerdictActivityPayload, renderPrVerdictStandDownReminder } from './github-verdict-activity'

describe('parsePrVerdictActivityPayload', () => {
  test('parses a well-formed landed payload', () => {
    const parsed = parsePrVerdictActivityPayload({
      kind: 'pr.verdict-activity',
      workspace: 'acme/widgets',
      prNumber: 42,
      verdict: 'APPROVE',
      sessionId: 'ses_abc',
    })
    expect(parsed).toEqual({ workspace: 'acme/widgets', prNumber: 42, verdict: 'APPROVE', sessionId: 'ses_abc' })
  })

  test('rejects a payload whose kind is not pr.verdict-activity', () => {
    expect(parsePrVerdictActivityPayload({ kind: 'subagent.completed', workspace: 'a/b', prNumber: 1 })).toBeNull()
  })

  test('rejects a non-object payload', () => {
    expect(parsePrVerdictActivityPayload(null)).toBeNull()
    expect(parsePrVerdictActivityPayload('pr.verdict-activity')).toBeNull()
  })

  test('rejects a payload missing the routing key (workspace / prNumber)', () => {
    expect(
      parsePrVerdictActivityPayload({ kind: 'pr.verdict-activity', verdict: 'APPROVE', sessionId: 'ses_abc' }),
    ).toBeNull()
    expect(
      parsePrVerdictActivityPayload({
        kind: 'pr.verdict-activity',
        workspace: 'acme/widgets',
        verdict: 'APPROVE',
        sessionId: 'ses_abc',
      }),
    ).toBeNull()
  })

  test('rejects a non-verdict review state (only APPROVE / REQUEST_CHANGES carry duplicate risk)', () => {
    expect(
      parsePrVerdictActivityPayload({
        kind: 'pr.verdict-activity',
        workspace: 'acme/widgets',
        prNumber: 42,
        verdict: 'COMMENT',
        sessionId: 'ses_abc',
      }),
    ).toBeNull()
  })

  test('rejects a non-integer prNumber', () => {
    expect(
      parsePrVerdictActivityPayload({
        kind: 'pr.verdict-activity',
        workspace: 'acme/widgets',
        prNumber: 4.2,
        verdict: 'APPROVE',
        sessionId: 'ses_abc',
      }),
    ).toBeNull()
  })

  test('parses a REQUEST_CHANGES verdict', () => {
    const parsed = parsePrVerdictActivityPayload({
      kind: 'pr.verdict-activity',
      workspace: 'acme/widgets',
      prNumber: 7,
      verdict: 'REQUEST_CHANGES',
      sessionId: 'ses_xyz',
    })
    expect(parsed?.verdict).toBe('REQUEST_CHANGES')
  })
})

describe('renderPrVerdictStandDownReminder', () => {
  test('renders verified dismissal activity as permission to close addressed threads', () => {
    const text = renderPrVerdictStandDownReminder({ prNumber: 42, verdict: 'DISMISSED' })
    expect(text).toContain('DISMISSED')
    expect(text).toContain('exactly one participant-facing close-out')
    expect(text).toContain('Do not describe')
  })
  test('names the verdict and PR, and scopes the stand-down to redundant verdicts only', () => {
    const text = renderPrVerdictStandDownReminder({ prNumber: 42, verdict: 'APPROVE' })
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('#42')
    expect(text).toContain('APPROVE')
    expect(text).toContain('ONLY to formal PR-level verdicts')
    expect(text).toContain('exactly one participant-facing close-out')
    expect(text).toContain('short substantive acknowledgement')
    expect(text).toContain('specific technical reason')
    expect(text).toContain('Do not describe')
    expect(text).not.toContain('you must still reply to the inline thread as normal')
    expect(text).not.toMatch(/tell .*carrier|mention .*review round|report .*verdict registration/i)
    // soft wording: a genuine new-evidence verdict is not suppressed
    expect(text.toLowerCase()).toContain('unless new information')
  })

  test('renders the REQUEST_CHANGES wording', () => {
    const text = renderPrVerdictStandDownReminder({ prNumber: 7, verdict: 'REQUEST_CHANGES' })
    expect(text).toContain('REQUEST_CHANGES')
    expect(text).toContain('#7')
  })
})
