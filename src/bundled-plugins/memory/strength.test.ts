import { describe, expect, test } from 'bun:test'

import { computeTopicStrengths, renderTopicStrengthsTable } from './strength'

const ID_A = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
const ID_B = '019e2ecf-f2d5-70ee-83f6-005fb5451c51'
const ID_C = '019e2ee8-bcc4-772f-8821-876162c5e601'
const ID_D = '019e2ef0-aaaa-77ef-bbbb-cccccccccccc'

describe('computeTopicStrengths', () => {
  test('returns an empty list for an empty MEMORY.md', () => {
    expect(computeTopicStrengths('', '2026-05-20')).toEqual([])
    expect(computeTopicStrengths('# Memory\n', '2026-05-20')).toEqual([])
  })

  test('counts citations and distinct days per topic', () => {
    const text = [
      '## Burst',
      `- streams/2026-05-15#${ID_A}`,
      `- streams/2026-05-15#${ID_B}`,
      `- streams/2026-05-15#${ID_C}`,
      '',
      '## Spread',
      `- streams/2026-05-13#${ID_A}`,
      `- streams/2026-05-15#${ID_B}`,
      `- streams/2026-05-18#${ID_C}`,
    ].join('\n')

    const result = computeTopicStrengths(text, '2026-05-20')

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ heading: 'Burst', citationCount: 3, distinctDays: 1 })
    expect(result[1]).toMatchObject({ heading: 'Spread', citationCount: 3, distinctDays: 3 })
  })

  test('reports lastReinforcedDate as the most recent citation date', () => {
    const text = [
      '## Topic',
      `- streams/2026-05-13#${ID_A}`,
      `- streams/2026-05-18#${ID_B}`,
      `- streams/2026-05-15#${ID_C}`,
    ].join('\n')

    const [topic] = computeTopicStrengths(text, '2026-05-20')

    expect(topic?.lastReinforcedDate).toBe('2026-05-18')
    expect(topic?.daysSinceLastReinforced).toBe(2)
  })

  test('daysSinceLastReinforced is 0 on the same day', () => {
    const text = ['## Today', `- streams/2026-05-20#${ID_A}`].join('\n')

    const [topic] = computeTopicStrengths(text, '2026-05-20')

    expect(topic?.daysSinceLastReinforced).toBe(0)
  })

  test('reports null lastReinforcedDate for a topic with zero citations', () => {
    const [topic] = computeTopicStrengths('## Empty\nno citations here', '2026-05-20')

    expect(topic).toMatchObject({
      heading: 'Empty',
      citationCount: 0,
      distinctDays: 0,
      lastReinforcedDate: null,
      daysSinceLastReinforced: null,
    })
  })

  test('clamps a future-dated citation to 0 days (clock-skew defense, not punishment)', () => {
    const text = ['## Time traveler', `- streams/2026-05-25#${ID_A}`].join('\n')

    const [topic] = computeTopicStrengths(text, '2026-05-20')

    expect(topic?.daysSinceLastReinforced).toBe(0)
  })

  test('handles month and year boundaries correctly (UTC arithmetic, no DST drift)', () => {
    const text = ['## Old', `- memory/2025-12-31#${ID_A}`].join('\n')

    const [topic] = computeTopicStrengths(text, '2026-01-02')

    expect(topic?.daysSinceLastReinforced).toBe(2)
  })

  test('preserves topic order (the dreaming subagent sees topics in MEMORY.md write order)', () => {
    const text = ['## First', `- streams/2026-05-15#${ID_A}`, '', '## Second', `- memory/2026-05-15#${ID_B}`].join('\n')

    const result = computeTopicStrengths(text, '2026-05-20')

    expect(result.map((t) => t.heading)).toEqual(['First', 'Second'])
  })

  test('dedupes distinctDays per citation date, not per fragment id', () => {
    const text = [
      '## Topic',
      `- streams/2026-05-15#${ID_A}`,
      `- streams/2026-05-15#${ID_B}`,
      `- streams/2026-05-15#${ID_C}`,
      `- streams/2026-05-16#${ID_D}`,
    ].join('\n')

    const [topic] = computeTopicStrengths(text, '2026-05-20')

    expect(topic?.citationCount).toBe(4)
    expect(topic?.distinctDays).toBe(2)
  })
})

describe('renderTopicStrengthsTable', () => {
  test('returns an empty string when no topics exist', () => {
    expect(renderTopicStrengthsTable([])).toBe('')
  })

  test('renders a 5-column markdown table with one row per topic', () => {
    const out = renderTopicStrengthsTable([
      {
        heading: 'Strong',
        citationCount: 8,
        distinctDays: 6,
        lastReinforcedDate: '2026-05-18',
        daysSinceLastReinforced: 2,
      },
      {
        heading: 'Weak',
        citationCount: 1,
        distinctDays: 1,
        lastReinforcedDate: '2026-02-01',
        daysSinceLastReinforced: 108,
      },
    ])

    expect(out).toContain('| topic | cites | days | last reinforced | age (d) |')
    expect(out).toContain('| Strong | 8 | 6 | 2026-05-18 | 2 |')
    expect(out).toContain('| Weak | 1 | 1 | 2026-02-01 | 108 |')
  })

  test("renders em-dash for a never-reinforced topic's last/age columns", () => {
    const out = renderTopicStrengthsTable([
      {
        heading: 'No cites',
        citationCount: 0,
        distinctDays: 0,
        lastReinforcedDate: null,
        daysSinceLastReinforced: null,
      },
    ])

    expect(out).toContain('| No cites | 0 | 0 | — | — |')
  })

  test('escapes pipe characters in headings so they do not break the table', () => {
    const out = renderTopicStrengthsTable([
      {
        heading: 'foo | bar',
        citationCount: 1,
        distinctDays: 1,
        lastReinforcedDate: '2026-05-20',
        daysSinceLastReinforced: 0,
      },
    ])

    expect(out).toContain('| foo \\| bar | 1 | 1 | 2026-05-20 | 0 |')
  })

  test('truncates very long headings with an ellipsis (keeps numbers honest)', () => {
    const longHeading = 'a'.repeat(200)
    const out = renderTopicStrengthsTable([
      {
        heading: longHeading,
        citationCount: 99,
        distinctDays: 9,
        lastReinforcedDate: '2026-05-20',
        daysSinceLastReinforced: 0,
      },
    ])

    expect(out).toContain('…')
    expect(out).toContain('| 99 | 9 | 2026-05-20 | 0 |')
  })

  test('replaces an empty heading with (untitled) so the row still reads cleanly', () => {
    const out = renderTopicStrengthsTable([
      { heading: '', citationCount: 1, distinctDays: 1, lastReinforcedDate: '2026-05-20', daysSinceLastReinforced: 0 },
    ])

    expect(out).toContain('| (untitled) | 1 | 1 | 2026-05-20 | 0 |')
  })
})
