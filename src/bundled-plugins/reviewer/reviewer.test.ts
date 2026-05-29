import { describe, expect, test } from 'bun:test'

import { REVIEWER_SKILLS, REVIEWER_SYSTEM_PROMPT, createReviewerSubagent, reviewerPayloadSchema } from './reviewer'
import { CODE_REVIEW_SKILL } from './skills/code-review'
import { GENERAL_REVIEW_SKILL } from './skills/general'

describe('reviewer subagent — load-bearing prompt phrases', () => {
  test.each(
    [
      'READ-ONLY',
      'STRICTLY PROHIBITED',
      'parallel',
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

  test('prompt forbids posting to channels (parent owns posting, reviewer is analysis-only)', () => {
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('posting to github')
    expect(lower).toContain('parent owns posting')
  })

  test('prompt forbids bash for write/mutating operations', () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain('mkdir')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('rm')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('git add')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('git commit')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('git push')
  })

  test('prompt names the dedicated tools by their exact runtime names', () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`read`')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`grep`')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`find`')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`ls`')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`bash`')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`websearch`')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`webfetch`')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('`load_skill`')
  })

  test('prompt is domain-neutral: does NOT inline code-review-specific workflow steps in the "how to review" section', () => {
    // Drift guard: the whole point of the skill refactor is that
    // code-specific guidance (correctness checklists, security checklists,
    // PR-fetching commands as workflow steps) lives in the code-review
    // skill, not in the base prompt. If a future edit pulls that back into
    // REVIEWER_SYSTEM_PROMPT, the reviewer becomes useless for plan/design
    // /docs review and this test catches it.
    expect(REVIEWER_SYSTEM_PROMPT).not.toContain('**Code review:**')
    expect(REVIEWER_SYSTEM_PROMPT).not.toContain('**Plan review:**')
    expect(REVIEWER_SYSTEM_PROMPT).not.toContain('**Design review:**')
    expect(REVIEWER_SYSTEM_PROMPT).not.toContain('**Docs review:**')
  })

  test('prompt instructs the reviewer to load a skill BEFORE forming findings (architectural intent)', () => {
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('load_skill')
    expect(lower).toContain('identify the target')
    expect(lower).toContain('domain')
    // "The first thing you do for any review is …" is the load-bearing
    // phrase that makes skill-loading the default, not the exception.
    expect(REVIEWER_SYSTEM_PROMPT).toContain('first thing you do')
  })

  test('prompt names the structured output shape explicitly (so the parent can rely on parseable findings)', () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain('<finding severity=')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('<issue>')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('<evidence>')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('<suggestion>')
  })

  test('prompt forbids recursive spawn (defense-in-depth alongside the tool-presence gate)', () => {
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('spawning further subagents')
  })

  test('prompt forbids generic LLM review noise (drift guard: the whole point of a deep-model reviewer)', () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain('generic LLM review noise')
    expect(REVIEWER_SYSTEM_PROMPT).toContain('cannot point at a line')
  })

  test('prompt tells reviewer to verify external claims with web tools (citations not vibes)', () => {
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('verify external claims')
    expect(lower).toContain('cite the source')
  })

  test('prompt frames the role as deep-model analysis (so token-spend is justified)', () => {
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('quality, not speed')
    expect(lower).toContain('spend tokens')
  })
})

describe('reviewer subagent declaration', () => {
  test('is registered as visibility=public so spawn_subagent exposes it', () => {
    const sub = createReviewerSubagent()
    expect(sub.visibility).toBe('public')
  })

  test('uses the deep model profile (quality over speed for analysis)', () => {
    const sub = createReviewerSubagent()
    expect(sub.profile).toBe('deep')
  })

  test('does NOT require a specific permission (member with generic subagent.spawn can spawn it)', () => {
    const sub = createReviewerSubagent()
    expect(sub.requiresSpecificPermission ?? false).toBe(false)
  })

  test('tools list is read-only by whitelist: read/grep/find/ls/bash/websearch/webfetch with NO write/edit', () => {
    const sub = createReviewerSubagent()
    const toolNames = (sub.tools ?? []).map((t) => t.__builtinTool).sort()
    expect(toolNames).toEqual(['bash', 'find', 'grep', 'ls', 'read', 'webfetch', 'websearch'])
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
  })

  test('load_skill parameter schema accepts the shipped skill names and rejects unknown ones', () => {
    const sub = createReviewerSubagent()
    const loadSkill = sub.customTools?.[0]
    if (loadSkill === undefined) throw new Error('load_skill tool missing')
    expect(loadSkill.parameters.safeParse({ name: 'code-review' }).success).toBe(true)
    expect(loadSkill.parameters.safeParse({ name: 'general' }).success).toBe(true)
    expect(loadSkill.parameters.safeParse({ name: 'plan-review' }).success).toBe(false)
    expect(loadSkill.parameters.safeParse({ name: '' }).success).toBe(false)
  })

  test('REVIEWER_SKILLS includes code-review and general (initial ship set)', () => {
    const names = REVIEWER_SKILLS.map((s) => s.name)
    expect(names).toContain('code-review')
    expect(names).toContain('general')
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

  test('inFlightKey returns distinct values for distinct requestId payloads (parallel spawns must not coalesce)', () => {
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
  test('CODE_REVIEW_SKILL has the expected name/description/non-empty content', () => {
    expect(CODE_REVIEW_SKILL.name).toBe('code-review')
    expect(CODE_REVIEW_SKILL.description.length).toBeGreaterThan(0)
    expect(CODE_REVIEW_SKILL.content.length).toBeGreaterThan(0)
  })

  test('GENERAL_REVIEW_SKILL has the expected name/description/non-empty content', () => {
    expect(GENERAL_REVIEW_SKILL.name).toBe('general')
    expect(GENERAL_REVIEW_SKILL.description.length).toBeGreaterThan(0)
    expect(GENERAL_REVIEW_SKILL.content.length).toBeGreaterThan(0)
  })

  test('code-review skill body teaches code-specific craft (drift guard against neutralization)', () => {
    const lower = CODE_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('correctness')
    expect(lower).toContain('security')
    expect(lower).toContain('test coverage')
    // Drift guard for the post-#452 contract: bash is sandboxed without
    // network, so the parent fetches PR content and embeds it in the
    // prompt — the skill must teach this, not legacy `gh pr diff` calls.
    expect(lower).toContain('the parent fetched')
    expect(lower).not.toContain('gh pr diff')
  })

  test('general skill body teaches universal review craft (load-bearing audience-fit phrasing)', () => {
    const lower = GENERAL_REVIEW_SKILL.content.toLowerCase()
    expect(lower).toContain('load-bearing')
    expect(lower).toContain('hidden assumptions')
  })

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

  test('accepts a payload with only requestId (spawn-tool minimum)', () => {
    const result = reviewerPayloadSchema.safeParse({ requestId: 'bg_t1' })
    expect(result.success).toBe(true)
  })

  test('passes through unknown fields (forward-compat with future spawn-tool params, matches explorer/scout/operator)', () => {
    const result = reviewerPayloadSchema.safeParse({ requestId: 'bg_t1', futureField: 42 })
    expect(result.success).toBe(true)
  })

  test('accepts a github-pr reviewTarget', () => {
    const result = reviewerPayloadSchema.safeParse({
      requestId: 'bg_t1',
      reviewTarget: { kind: 'github-pr', owner: 'o', repo: 'r', pullNumber: 7 },
    })
    expect(result.success).toBe(true)
  })

  test('rejects a malformed reviewTarget (wrong kind / missing fields)', () => {
    expect(reviewerPayloadSchema.safeParse({ reviewTarget: { kind: 'gitlab-mr' } }).success).toBe(false)
    expect(reviewerPayloadSchema.safeParse({ reviewTarget: { kind: 'github-pr', owner: 'o' } }).success).toBe(false)
  })
})

describe('reviewer sandbox contract (deep-review staging)', () => {
  test('base sandbox no longer ro-mounts the agent nest .git', () => {
    const sub = createReviewerSubagent()
    const sandbox = sub.sandbox
    const mounts = typeof sandbox === 'object' ? (sandbox.mounts ?? []) : []
    expect(mounts.some((m) => m.src === '/agent/.git' || m.dst === '/work/.git')).toBe(false)
  })

  test('base sandbox keeps network none and cwd /work', () => {
    const sub = createReviewerSubagent()
    const sandbox = sub.sandbox
    if (typeof sandbox !== 'object') throw new Error('expected object sandbox')
    expect(sandbox.network).toBe('none')
    expect(sandbox.cwd).toBe('/work')
  })

  test('gh is NOT in the sandbox allowlist (token never enters the jail)', () => {
    const sub = createReviewerSubagent()
    const sandbox = sub.sandbox
    const allowlist = typeof sandbox === 'object' ? (sandbox.allowlist ?? []) : []
    expect(allowlist.some((p) => p.startsWith('gh'))).toBe(false)
    expect(allowlist).toContain('find')
    expect(allowlist).toContain('grep')
  })

  test('prompt teaches the staged /work tree for deep cross-file review', () => {
    const lower = REVIEWER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('/work')
    expect(lower).toContain('staged')
    expect(lower).not.toContain('/agent/.git')
  })

  test('declares a handler (parent-side staging runs before the reviewer session)', () => {
    const sub = createReviewerSubagent()
    expect(typeof sub.handler).toBe('function')
  })
})
