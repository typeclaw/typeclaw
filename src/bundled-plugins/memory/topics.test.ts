import { describe, expect, test } from 'bun:test'

import { parseTopics } from './topics'

const ID_A = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
const ID_B = '019e2ecf-f2d5-70ee-83f6-005fb5451c51'
const ID_C = '019e2ee8-bcc4-772f-8821-876162c5e601'

describe('parseTopics', () => {
  test('returns an empty list when MEMORY.md has no level-2 headings', () => {
    expect(parseTopics('# Memory\n')).toEqual([])
    expect(parseTopics('')).toEqual([])
    expect(parseTopics('just some prose without headings')).toEqual([])
  })

  test('splits on `## ` headings and attributes the heading text to each topic', () => {
    const text = ['# Memory', '', '## First', 'body of first', '', '## Second', 'body of second'].join('\n')

    const topics = parseTopics(text)

    expect(topics.map((t) => t.heading)).toEqual(['First', 'Second'])
  })

  test("attaches each topic's citations from its body, not the global file", () => {
    const text = [
      '# Memory',
      '',
      '## Topic A',
      'Conclusion for A.',
      '',
      'fragments:',
      `- streams/2026-05-16#${ID_A}`,
      `- streams/2026-05-15#${ID_B}`,
      '',
      '## Topic B',
      'Conclusion for B.',
      '',
      'fragments:',
      `- streams/2026-05-16#${ID_C}`,
    ].join('\n')

    const topics = parseTopics(text)

    expect(topics).toHaveLength(2)
    expect(topics[0]?.heading).toBe('Topic A')
    expect(topics[0]?.citations).toEqual([
      { date: '2026-05-16', fragmentId: ID_A },
      { date: '2026-05-15', fragmentId: ID_B },
    ])
    expect(topics[1]?.heading).toBe('Topic B')
    expect(topics[1]?.citations).toEqual([{ date: '2026-05-16', fragmentId: ID_C }])
  })

  test('preserves heading order even when topics share a date', () => {
    const text = ['## Older', `- streams/2026-05-15#${ID_A}`, '', '## Newer', `- memory/2026-05-15#${ID_B}`].join('\n')

    const topics = parseTopics(text)
    expect(topics.map((t) => t.heading)).toEqual(['Older', 'Newer'])
  })

  test('emits an empty citations array for a topic that has none', () => {
    const text = ['## Empty topic', '', 'No fragments cited yet.'].join('\n')

    const topics = parseTopics(text)

    expect(topics).toEqual([{ heading: 'Empty topic', citations: [] }])
  })

  test('drops citations that appear in the preamble above the first h2 (they belong to no topic)', () => {
    const text = [
      '# Memory',
      `see streams/2026-05-16#${ID_A} for context`,
      '',
      '## Real topic',
      `- streams/2026-05-15#${ID_B}`,
    ].join('\n')

    const topics = parseTopics(text)

    expect(topics).toHaveLength(1)
    expect(topics[0]?.heading).toBe('Real topic')
    expect(topics[0]?.citations).toEqual([{ date: '2026-05-15', fragmentId: ID_B }])
  })

  test('trims surrounding whitespace from the heading text', () => {
    const text = '##    Spaced out    \n\nbody'
    expect(parseTopics(text)).toEqual([{ heading: 'Spaced out', citations: [] }])
  })

  test('keeps an empty-string heading rather than dropping the topic (subagent can see and clean it)', () => {
    const text = ['## ', `- streams/2026-05-16#${ID_A}`].join('\n')

    const topics = parseTopics(text)

    expect(topics).toHaveLength(1)
    expect(topics[0]?.heading).toBe('')
    expect(topics[0]?.citations).toEqual([{ date: '2026-05-16', fragmentId: ID_A }])
  })

  test('counts inline-prose citations toward the topic, not only fragments: bullets', () => {
    const text = ['## Inline citer', `mentioned in streams/2026-05-16#${ID_A} earlier`].join('\n')

    const topics = parseTopics(text)

    expect(topics[0]?.citations).toEqual([{ date: '2026-05-16', fragmentId: ID_A }])
  })

  test('ignores h3+ headings (they belong to the surrounding h2 topic)', () => {
    const text = ['## Parent', '### Subheading', `- streams/2026-05-16#${ID_A}`].join('\n')

    const topics = parseTopics(text)

    expect(topics).toHaveLength(1)
    expect(topics[0]?.heading).toBe('Parent')
    expect(topics[0]?.citations).toEqual([{ date: '2026-05-16', fragmentId: ID_A }])
  })
})
