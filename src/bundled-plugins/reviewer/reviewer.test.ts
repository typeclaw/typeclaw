import { describe, expect, test } from 'bun:test'

import { REVIEWER_SKILLS, REVIEWER_SYSTEM_PROMPT, createReviewerSubagent, reviewerPayloadSchema } from './reviewer'

describe('reviewer subagent — load-bearing prompt phrases', () => {
  test.each(
    [
      '<review>',
      '<summary>',
      '<findings>',
      '<finding',
      '<verdict>',
      'blocker',
      'concern',
      'praise',
      'approve',
      'request-changes',
      'comment',
    ].map((phrase) => [phrase] as const),
  )('prompt contains %s', (phrase) => {
    const haystack = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(haystack).toContain(phrase.toLowerCase())
  })

  test('prompt names the structured output shape explicitly (so the parent can rely on parseable findings)', () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain('<finding severity=')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('<issue>')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('<evidence>')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('<suggestion>')
  })
})

describe('reviewer subagent declaration', () => {
  test('uses the deep model profile (quality over speed for analysis)', () => {
    const sub = createReviewerSubagent()
    expect(sub.profile).toBe('deep')
  })

  test('does NOT require a specific permission (member with generic subagent.spawn can spawn it)', () => {
    const sub = createReviewerSubagent()
    expect(sub.requiresSpecificPermission ?? false).toBe(false)
  })

  test('declares canSpawnSubagents=true (deep-model reviewer offloads bulk gathering to cheaper workers)', () => {
    const sub = createReviewerSubagent()
    expect(sub.canSpawnSubagents).toBe(true)
  })

  test('declares the readonly-reviewer bash policy so its bash is fenced regardless of the spawning role (issue #452)', () => {
    const sub = createReviewerSubagent()
    expect(sub.bashPolicy).toEqual({ kind: 'readonly-reviewer' })
  })

  test('tools list is read-only by whitelist: read/grep/find/ls/bash/web_search/web_fetch with NO write/edit', () => {
    const sub = createReviewerSubagent()
    const toolNames = (sub.tools ?? []).map((t) => t.__builtinTool).sort()
    expect(toolNames).toEqual(['bash', 'find', 'grep', 'ls', 'read', 'web_fetch', 'web_search'])
    expect(toolNames).not.toContain('write')
    expect(toolNames).not.toContain('edit')
  })

  test('customTools contains exactly one tool: load_skill (the runtime-skill-loader)', () => {
    const sub = createReviewerSubagent()
    expect(sub.customTools).toBeDefined()
    expect(sub.customTools).toHaveLength(1)
    const loadSkill = sub.customTools?.[0]
    if (loadSkill === undefined) throw new Error('load_skill tool missing')
    // The factory builds a description that menus the skills. Verify the
    // names surface so the model can pick from the prompt-visible enum.
    expect(loadSkill.description).toContain('`code-review`')
    expect(loadSkill.description).toContain('`general`')
    expect(loadSkill.description).toContain('`security-audit`')
  })

  test('load_skill parameter schema accepts every shipped skill name and rejects unknown ones', () => {
    const sub = createReviewerSubagent()
    const loadSkill = sub.customTools?.[0]
    if (loadSkill === undefined) throw new Error('load_skill tool missing')
    for (const skill of REVIEWER_SKILLS) {
      expect(loadSkill.parameters.safeParse({ name: skill.name }).success).toBe(true)
    }
    expect(loadSkill.parameters.safeParse({ name: 'not-a-real-skill' }).success).toBe(false)
    expect(loadSkill.parameters.safeParse({ name: '' }).success).toBe(false)
  })

  test('REVIEWER_SKILLS has no duplicate names (load_skill enum stays unambiguous)', () => {
    const names = REVIEWER_SKILLS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('declares a tool-result budget so a runaway subagent cannot exhaust parent context', () => {
    const sub = createReviewerSubagent()
    expect(sub.toolResultBudget).toBeDefined()
    expect(sub.toolResultBudget?.maxTotalBytes).toBeGreaterThan(0)
  })

  test('tool-result budget covers load_skill so loaded skill bodies count against the same cap', () => {
    const sub = createReviewerSubagent()
    expect(sub.toolResultBudget?.toolNames).toContain('load_skill')
  })

  test('budget sits between explorer (256KB) and operator (1MB) — read-only deep analysis, larger than explorer but bounded', () => {
    const sub = createReviewerSubagent()
    const budget = sub.toolResultBudget?.maxTotalBytes ?? 0
    expect(budget).toBeGreaterThan(256_000)
    expect(budget).toBeLessThan(1_000_000)
  })

  test('declares a spawn timeout so a stalled review fails the parent loudly instead of hanging forever', () => {
    const sub = createReviewerSubagent()
    expect(sub.timeoutMs).toBeGreaterThan(0)
  })

  test('inFlightKey coalesces the same PR head and review kind regardless of requestId', () => {
    const sub = createReviewerSubagent()
    const reviewIdentity = {
      repo: 'Acme/Widgets',
      pullRequest: 42,
      headSha: 'A'.repeat(40),
      baseSha: 'B'.repeat(40),
      reviewKind: 'review' as const,
    }

    const k1 = sub.inFlightKey?.({ requestId: 'bg_a', reviewIdentity })
    const k2 = sub.inFlightKey?.({ requestId: 'bg_b', reviewIdentity, skill: 'code-review' })

    expect(k1).toBe(`acme/widgets#42#${'a'.repeat(40)}#${'b'.repeat(40)}#review`)
    expect(k2).toBe(k1)
  })

  test('inFlightKey keeps changed PR heads and review kinds independent', () => {
    const sub = createReviewerSubagent()
    const base = {
      repo: 'acme/widgets',
      pullRequest: 42,
      headSha: 'a'.repeat(40),
      baseSha: 'c'.repeat(40),
      reviewKind: 'review' as const,
    }

    const original = sub.inFlightKey?.({ requestId: 'bg_a', reviewIdentity: base })
    const changedHead = sub.inFlightKey?.({
      requestId: 'bg_b',
      reviewIdentity: { ...base, headSha: 'b'.repeat(40) },
    })
    const changedKind = sub.inFlightKey?.({
      requestId: 'bg_c',
      reviewIdentity: { ...base, reviewKind: 're-review' },
    })
    const changedBase = sub.inFlightKey?.({
      requestId: 'bg_d',
      reviewIdentity: { ...base, baseSha: 'd'.repeat(40) },
    })

    expect(changedHead).not.toBe(original)
    expect(changedKind).not.toBe(original)
    expect(changedBase).not.toBe(original)
    expect(changedHead).not.toBe(changedKind)
  })

  test('inFlightKey retains unique request identity for non-PR reviews', () => {
    const sub = createReviewerSubagent()
    const k1 = sub.inFlightKey?.({ requestId: 'bg_a' })
    const k2 = sub.inFlightKey?.({ requestId: 'bg_b' })
    expect(k1).toBe('bg_a')
    expect(k2).toBe('bg_b')
    expect(k1).not.toBe(k2)
  })

  test('inFlightKey falls back to a random value when no requestId is provided (no accidental coalescing)', () => {
    const sub = createReviewerSubagent()
    const k1 = sub.inFlightKey?.({})
    const k2 = sub.inFlightKey?.({})
    expect(k1).not.toBe(k2)
  })
})

describe('reviewer skill content', () => {
  test('every shipped skill references the reviewer neutral output contract (so domain skills compose with the universal shape)', () => {
    for (const skill of REVIEWER_SKILLS) {
      expect(skill.content).toContain('<review>')
    }
  })
})

describe('reviewerPayloadSchema', () => {
  test('accepts a full payload with requestId + prompt + description', () => {
    const result = reviewerPayloadSchema.safeParse({
      requestId: 'bg_t1',
      prompt: 'review PR #42 for security issues',
      description: 'PR review',
    })
    expect(result.success).toBe(true)
  })

  test('accepts a typed PR review identity', () => {
    const result = reviewerPayloadSchema.safeParse({
      requestId: 'bg_t1',
      prompt: 'review PR #42',
      reviewIdentity: {
        repo: 'acme/widgets',
        pullRequest: 42,
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        reviewKind: 'review',
      },
    })

    expect(result.success).toBe(true)
  })

  test('rejects malformed PR review identities instead of deriving identity from prompt prose', () => {
    expect(
      reviewerPayloadSchema.safeParse({
        prompt: 'review acme/widgets#42 at some moving branch',
        reviewIdentity: {
          repo: 'acme/widgets',
          pullRequest: 0,
          headSha: 'main',
          baseSha: 'main',
          reviewKind: '',
        },
      }).success,
    ).toBe(false)
  })

  test('accepts a payload with only requestId (spawn-tool minimum)', () => {
    const result = reviewerPayloadSchema.safeParse({ requestId: 'bg_t1' })
    expect(result.success).toBe(true)
  })

  test('passes through unknown fields (forward-compat with future spawn-tool params, matches explorer/scout/operator)', () => {
    const result = reviewerPayloadSchema.safeParse({ requestId: 'bg_t1', futureField: 42 })
    expect(result.success).toBe(true)
  })
})
