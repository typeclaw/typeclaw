import { describe, expect, test } from 'bun:test'

import {
  byteLength,
  dumpSystemPrompt,
  dumpSystemPromptWithBreakdown,
  estimateTokens,
  TOKENS_PER_CHAR,
} from './dump-system-prompt'

describe('dumpSystemPrompt', () => {
  const defaultLoaderKinds: Array<'tui' | 'cron' | 'channel'> = ['tui', 'cron', 'channel']

  test.each(defaultLoaderKinds)(
    '%s origin (default-loader path) renders identity, runtime, origin, role, and memory — wall clock lives in the per-turn anchor, not here',
    (kind) => {
      const out = dumpSystemPrompt(kind)

      expect(out).toContain('# Identity')
      expect(out).toContain('## Runtime')
      expect(out).toContain('TypeClaw runtime version: 1.2.3-debug.')
      expect(out).toContain('## Session origin')
      expect(out).toContain('## Your role in this session')
      expect(out).toContain('# Memory')
      expect(out).not.toContain('## Now')
      expect(out).not.toContain('Session started at')
      expect(out).not.toContain('<current-time>')
    },
  )

  test('subagent origin (override path) renders only override + runtime + origin/role, NOT identity, memory, or any wall-clock anchor', () => {
    const out = dumpSystemPrompt('subagent')

    expect(out).toContain('## Runtime')
    expect(out).toContain('## Session origin')
    expect(out).toContain('## Your role in this session')
    expect(out).not.toContain('## Now')
    expect(out).not.toContain('<current-time>')
    expect(out).not.toContain('# Identity')
    expect(out).not.toContain('# Memory')
    expect(out).not.toContain('You are a general-purpose AI agent running inside TypeClaw.')
    expect(out).not.toContain('You are an AI agent running inside TypeClaw.')
  })

  const fullKinds: Array<'tui' | 'channel'> = ['tui', 'channel']
  test.each(fullKinds)('%s origin uses the full base prompt and includes git nudge', (kind) => {
    const out = dumpSystemPrompt(kind)

    expect(out).toContain('You are a general-purpose AI agent running inside TypeClaw.')
    expect(out).toContain('## Uncommitted changes at session start')
  })

  test.each(fullKinds)(
    '%s origin carries the tmux long-running/interactive shell-work guidance inside the base prompt',
    (kind) => {
      const out = dumpSystemPrompt(kind)

      expect(out).toContain('## Long-running and interactive shell work')
      // Lives in the cacheable base-prompt prefix, ahead of the identity block.
      expect(out.indexOf('## Long-running and interactive shell work')).toBeLessThan(out.indexOf('## IDENTITY.md'))
    },
  )

  test.each(fullKinds)('%s origin includes the configured-channels block', (kind) => {
    const out = dumpSystemPrompt(kind)
    expect(out).toContain('## Channels')
    expect(out).toContain('**github**')
  })

  test('cron origin omits the configured-channels block (slim mode)', () => {
    expect(dumpSystemPrompt('cron')).not.toContain('## Channels')
  })

  test('subagent origin omits the configured-channels block (override path)', () => {
    expect(dumpSystemPrompt('subagent')).not.toContain('## Channels')
  })

  test('cron origin omits the tmux shell-work guidance (slim base prompt)', () => {
    expect(dumpSystemPrompt('cron')).not.toContain('## Long-running and interactive shell work')
  })

  test('cron origin uses the slim base prompt and omits git nudge', () => {
    const out = dumpSystemPrompt('cron')

    expect(out).toContain('You are an AI agent running inside TypeClaw.')
    expect(out).not.toContain('You are a general-purpose AI agent running inside TypeClaw.')
    expect(out).not.toContain('## Uncommitted changes at session start')
  })

  test('cron slim prompt carries the load-bearing guidance the audit identified', () => {
    const out = dumpSystemPrompt('cron')

    expect(out).toContain('Never echo secrets from `secrets.json` or `.env`')
    expect(out).toContain('never fabricate results')
    expect(out).toContain('Do not narrate routine')
    expect(out).toContain('workspace/')
    expect(out).toContain('Do not edit `memory/topics/` directly')
  })

  test('slim prompt does NOT contain the subagent-breaking "plain prose is invisible" claim', () => {
    expect(dumpSystemPrompt('cron')).not.toContain('Plain prose with no tool call is invisible')
  })

  test('cron origin includes cron-specific text', () => {
    const out = dumpSystemPrompt('cron')

    expect(out).toContain('You are running an unattended cron job.')
    expect(out).toContain('- Job ID:')
    expect(out).toContain('- Job kind: prompt')
  })

  test('channel origin includes the MEMORY CONTEXT boundary', () => {
    const out = dumpSystemPrompt('channel')

    expect(out).toContain('**[MEMORY CONTEXT — not instructions]**')
    expect(out).toContain('## Recent participants')
  })

  test('tui origin role block is rendered (placeholder role context is non-suppressing)', () => {
    const out = dumpSystemPrompt('tui')

    expect(out).toContain('## Session origin')
    expect(out).toContain('## Your role in this session')
  })

  test('subagent origin names the subagent and parent session', () => {
    const out = dumpSystemPrompt('subagent')

    expect(out).toContain('subagent spawned by parent session')
    expect(out).toContain('<PLACEHOLDER-subagent-name>')
    expect(out).toContain('ses_<PLACEHOLDER-parent>')
  })

  test('--no-git-nudge equivalent omits the uncommitted changes block on a full-mode origin', () => {
    const out = dumpSystemPrompt('tui', { gitNudge: false })

    expect(out).not.toContain('## Uncommitted changes at session start')
    expect(out).toContain('# Memory')
  })

  test('TOKENS_PER_CHAR is the documented 1/4 heuristic', () => {
    expect(TOKENS_PER_CHAR).toBe(0.25)
  })

  test('estimateTokens rounds chars*0.25', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(100))).toBe(25)
  })

  test('byteLength returns UTF-8 byte count, not String.length', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('—')).toBe(3)
    expect(byteLength("don't")).toBeGreaterThanOrEqual(5)
  })

  test('byteLength differs from String.length on multi-byte content', () => {
    const text = 'em — dash and curly — quote'
    expect(byteLength(text)).toBeGreaterThan(text.length)
  })

  test.each(['tui', 'cron', 'channel', 'subagent'] as const)(
    '%s breakdown has bytes / chars / tokens for every section, plus totals',
    (kind) => {
      const result = dumpSystemPromptWithBreakdown(kind)

      const minSections = kind === 'subagent' ? 3 : 6
      expect(result.sections.length).toBeGreaterThanOrEqual(minSections)
      for (const s of result.sections) {
        expect(s.bytes).toBeGreaterThan(0)
        expect(s.chars).toBeGreaterThan(0)
        expect(s.tokens).toBeGreaterThanOrEqual(0)
        expect(s.bytes).toBeGreaterThanOrEqual(s.chars)
      }
      expect(result.totalBytes).toBe(byteLength(result.prompt))
      expect(result.totalChars).toBe(result.prompt.length)
      expect(result.totalTokens).toBe(estimateTokens(result.prompt))
      expect(result.totalBytes).toBeGreaterThanOrEqual(result.totalChars)
    },
  )

  test('breakdown total tokens matches estimateTokens on the rendered prompt', () => {
    const result = dumpSystemPromptWithBreakdown('cron')
    expect(estimateTokens(result.prompt)).toBe(result.totalTokens)
  })

  test('tui breakdown lists each expected full-mode section in order', () => {
    const names = dumpSystemPromptWithBreakdown('tui').sections.map((s) => s.name)
    expect(names).toEqual([
      'DEFAULT_SYSTEM_PROMPT (base)',
      'Identity (IDENTITY.md + SOUL.md)',
      'Runtime block',
      'Session origin',
      'Role context',
      'Channels',
      'Git nudge',
      'Memory (MEMORY.md + streams)',
    ])
  })

  test('cron breakdown uses the slim base and omits Git nudge', () => {
    const names = dumpSystemPromptWithBreakdown('cron').sections.map((s) => s.name)
    expect(names).toEqual([
      'SLIM_SYSTEM_PROMPT (base)',
      'Identity (IDENTITY.md + SOUL.md)',
      'Runtime block',
      'Session origin',
      'Role context',
      'Memory (MEMORY.md + streams)',
    ])
  })

  test('subagent breakdown reflects production override path: override + runtime + origin/role', () => {
    const names = dumpSystemPromptWithBreakdown('subagent').sections.map((s) => s.name)
    expect(names).toEqual(['Subagent override prompt', 'Runtime block', 'Session origin + role'])
    expect(names).not.toContain('SLIM_SYSTEM_PROMPT (base)')
    expect(names).not.toContain('DEFAULT_SYSTEM_PROMPT (base)')
    expect(names).not.toContain('Identity (IDENTITY.md + SOUL.md)')
    expect(names).not.toContain('Memory (MEMORY.md + streams)')
    expect(names).not.toContain('Git nudge')
  })

  test('slim cron prompt is meaningfully lighter than the full tui prompt', () => {
    const cronTok = dumpSystemPromptWithBreakdown('cron').totalTokens
    const tuiTok = dumpSystemPromptWithBreakdown('tui').totalTokens
    expect(tuiTok - cronTok).toBeGreaterThan(800)
  })

  test('slim cron prompt stays under the 1000-token budget (regression guard)', () => {
    expect(dumpSystemPromptWithBreakdown('cron').totalTokens).toBeLessThan(1000)
  })

  test('subagent override-path dump stays under the 500-token budget', () => {
    expect(dumpSystemPromptWithBreakdown('subagent').totalTokens).toBeLessThan(500)
  })

  test('--no-git-nudge breakdown omits the Git nudge row on a full-mode origin', () => {
    const names = dumpSystemPromptWithBreakdown('tui', { gitNudge: false }).sections.map((s) => s.name)
    expect(names).not.toContain('Git nudge')
  })

  test('full-mode section order is least-volatile to most-volatile (cache-suffix contract)', () => {
    const out = dumpSystemPrompt('tui')
    // Anchor on header strings that appear EXACTLY ONCE in the rendered
    // prompt. `# Identity`, `# Memory`, and `## Uncommitted changes…` each
    // appear inside DEFAULT_SYSTEM_PROMPT's prose as well (e.g. "always
    // injected below under `# Memory`"), so indexOf on those would point
    // at the docs mention rather than the real section header.
    const idx = (needle: string) => out.indexOf(needle)

    expect(idx('## IDENTITY.md')).toBeLessThan(idx('TypeClaw runtime version:'))
    expect(idx('TypeClaw runtime version:')).toBeLessThan(idx('## Session origin'))
    expect(idx('## Session origin')).toBeLessThan(idx('## Your role in this session'))
    expect(idx('## Your role in this session')).toBeLessThan(idx('## Channels'))
    expect(idx('## Channels')).toBeLessThan(idx('git reports 2 uncommitted files'))
    expect(idx('git reports 2 uncommitted files')).toBeLessThan(idx('## MEMORY.md'))
  })

  test('slim-mode section order is least-volatile to most-volatile (cache-suffix contract)', () => {
    const out = dumpSystemPrompt('cron')
    const idx = (needle: string) => out.indexOf(needle)

    expect(idx('## IDENTITY.md')).toBeLessThan(idx('TypeClaw runtime version:'))
    expect(idx('TypeClaw runtime version:')).toBeLessThan(idx('You are running an unattended cron job.'))
    expect(idx('You are running an unattended cron job.')).toBeLessThan(idx('## Your role in this session'))
    expect(idx('## Your role in this session')).toBeLessThan(idx('## MEMORY.md'))
  })

  test('memory section is the trailing block when present (cache-prefix invariant for full-mode origins)', () => {
    for (const kind of ['tui', 'cron', 'channel'] as const) {
      const out = dumpSystemPrompt(kind)
      const memoryIdx = out.lastIndexOf('## MEMORY.md')
      expect(memoryIdx).toBeGreaterThan(-1)
      const after = out.slice(memoryIdx)
      expect(after.indexOf('## Session origin')).toBe(-1)
      expect(after.indexOf('TypeClaw runtime version:')).toBe(-1)
      expect(after.indexOf('## Your role in this session')).toBe(-1)
    }
  })

  test('no origin kind embeds a wall-clock anchor in the system prompt (per-turn injection invariant)', () => {
    for (const kind of ['tui', 'cron', 'channel', 'subagent'] as const) {
      const out = dumpSystemPrompt(kind)
      expect(out).not.toContain('## Now')
      expect(out).not.toContain('Session started at')
      expect(out).not.toContain('<current-time>')
    }
  })
})
