import { describe, expect, test } from 'bun:test'

import { channelsSchema } from '@/channels/schema'
import { formatLocalDateTime, resolveLocalTimezoneName } from '@/shared'

import { DEFAULT_SYSTEM_PROMPT, renderChannelsBlock, renderTurnRoleAnchor, renderTurnTimeAnchor } from './system-prompt'

describe('subagent orchestration — explicit research routing', () => {
  // Guards the regression where an explicit "do a research" directive was answered
  // inline (web_search / training memory) instead of delegated. The invariant the
  // reviewer demanded: explicit research is MANDATORY-`researcher`, not satisfiable
  // by a scout/explorer-only route or an inline answer. Soften any of these and the
  // downgrade path reopens.
  test('explicit research mandates `researcher` and forbids the inline-answer downgrade', () => {
    const ruleStart = DEFAULT_SYSTEM_PROMPT.indexOf('When the user *explicitly* says')
    expect(ruleStart).toBeGreaterThan(-1)
    const rule = DEFAULT_SYSTEM_PROMPT.slice(ruleStart, ruleStart + 320)
    expect(rule).toContain('MUST spawn `researcher`')
    expect(rule).toContain('training memory')
    expect(rule).toContain('does not satisfy the request')
  })

  test('scout/explorer fan-out is explicitly marked as not replacing `researcher`', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('does not replace `researcher`')
  })
})

describe('delivering reports and documents', () => {
  test('routes report/PDF/document requests to the typeclaw-markdown-pdf skill', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('## Delivering reports and documents')
    expect(DEFAULT_SYSTEM_PROMPT).toContain('typeclaw-markdown-pdf')
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/produce a polished file/i)
  })

  test('states the summary is a pointer, never the deliverable', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/summary[\s\S]*?never the deliverable/i)
  })

  test('forbids hand-rolling a PDF with an ad-hoc library', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/jsPDF, pdfkit/i)
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/mojibake/i)
  })
})

describe('renderTurnTimeAnchor', () => {
  test('wraps the ISO timestamp, IANA zone, and weekday in a single <current-time> tag', () => {
    const now = new Date('2026-01-15T12:00:00+09:00')

    const anchor = renderTurnTimeAnchor(now)

    expect(anchor.startsWith('<current-time>')).toBe(true)
    expect(anchor.endsWith('</current-time>')).toBe(true)
    expect(anchor).toContain(formatLocalDateTime(now))
    expect(anchor).toContain(`(${resolveLocalTimezoneName()},`)
  })

  test('emits the English weekday name (global users get one canonical language, not a localized pair)', () => {
    // Asserting membership in the canonical 7-entry list rather than a
    // specific weekday: the local zone may differ on CI from the
    // zone-agnostic constructor input, so the resolved weekday is not
    // pinnable. The contract is "an English weekday is present", not
    // "this specific day".
    const now = new Date('2026-01-15T12:00:00+09:00')

    const anchor = renderTurnTimeAnchor(now)

    const englishDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    expect(englishDays.some((d) => anchor.includes(d))).toBe(true)
    const koreanDays = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일']
    expect(koreanDays.some((d) => anchor.includes(d))).toBe(false)
  })

  test('produces a single-line block with no internal newlines (so prepending `${anchor}\\n\\n${user}` is the only newline boundary)', () => {
    const now = new Date('2026-01-15T12:00:00+09:00')

    const anchor = renderTurnTimeAnchor(now)

    expect(anchor).not.toContain('\n')
  })

  test('defaults to new Date() when no argument is passed (production callers use this path)', () => {
    const before = Date.now()
    const anchor = renderTurnTimeAnchor()
    const after = Date.now()

    expect(anchor).toContain('<current-time>')
    expect(anchor).toContain('</current-time>')
    const match = anchor.match(/<current-time>(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/)
    expect(match).not.toBeNull()
    const ts = new Date(match![1]!).getTime()
    expect(ts).toBeGreaterThanOrEqual(before - 1000)
    expect(ts).toBeLessThanOrEqual(after + 1000)
  })

  test('the weekday matches what `Date.getDay()` would resolve in the runtime zone (the anchor must agree with `date` for the current local day)', () => {
    const now = new Date()
    const anchor = renderTurnTimeAnchor(now)

    const englishDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const expectedEn = englishDays[now.getDay()]!
    expect(anchor).toContain(expectedEn)
  })
})

describe('renderTurnRoleAnchor', () => {
  test('wraps a non-owner role in an authoritative <your-role> tag with override instruction', () => {
    expect(renderTurnRoleAnchor('guest')).toBe(
      '<your-role authority="current-speaker">guest</your-role> (authoritative for this message; overrides any role implied by the system prompt)',
    )
    expect(renderTurnRoleAnchor('member')).toContain('<your-role authority="current-speaker">member</your-role>')
    expect(renderTurnRoleAnchor('trusted')).toContain('<your-role authority="current-speaker">trusted</your-role>')
  })

  test('marks the per-turn role as authoritative so it overrides the cached system-prompt role block', () => {
    const anchor = renderTurnRoleAnchor('guest')!
    expect(anchor).toContain('authoritative')
    expect(anchor).toContain('overrides')
  })

  test('omits the tag for owner (the unconstrained default — absent means no special handling)', () => {
    expect(renderTurnRoleAnchor('owner')).toBeUndefined()
  })

  test('produces a single-line block with no internal newlines', () => {
    expect(renderTurnRoleAnchor('guest')).not.toContain('\n')
  })

  test('passes through a custom role name verbatim', () => {
    expect(renderTurnRoleAnchor('contributor')).toContain(
      '<your-role authority="current-speaker">contributor</your-role>',
    )
  })
})

describe('renderChannelsBlock', () => {
  test('renders github repos and review config so the agent knows its standing setup', () => {
    const block = renderChannelsBlock(
      channelsSchema.parse({
        'slack-bot': {},
        github: { repos: ['acme/api', 'acme/web'], review: { on: 'opened', approve: true } },
      }),
    )
    expect(block).toContain('## Channels')
    expect(block).toContain('**github**')
    expect(block).toContain('acme/api, acme/web')
    expect(block).toContain('on `opened`')
    expect(block).toContain('may approve')
    expect(block).toContain('**slack-bot** — enabled')
  })

  test('carries a disclosure guard so low-privilege channel speakers cannot extract the repo list', () => {
    const block = renderChannelsBlock(channelsSchema.parse({ github: { repos: ['acme/private-svc'] } }))
    expect(block).toContain('owner/trusted authority')
    expect(block).toContain('decline')
  })

  test('returns empty string when no channel is enabled (TUI-only agents pay nothing)', () => {
    expect(renderChannelsBlock(channelsSchema.parse({}))).toBe('')
  })

  test('omits disabled adapters', () => {
    const block = renderChannelsBlock(channelsSchema.parse({ 'discord-bot': { enabled: false }, 'telegram-bot': {} }))
    expect(block).not.toContain('discord-bot')
    expect(block).toContain('**telegram-bot** — enabled')
  })

  test('renders comment-only and off review states distinctly', () => {
    const commentOnly = renderChannelsBlock(
      channelsSchema.parse({ github: { repos: ['a/b'], review: { on: 'opened', approve: false } } }),
    )
    expect(commentOnly).toContain('comment-only')
    const off = renderChannelsBlock(channelsSchema.parse({ github: { repos: ['a/b'], review: { on: 'off' } } }))
    expect(off).toContain('review: off')
  })

  test('handles a github channel with no repos configured', () => {
    const block = renderChannelsBlock(channelsSchema.parse({ github: { repos: [] } }))
    expect(block).toContain('(none configured)')
  })
})
