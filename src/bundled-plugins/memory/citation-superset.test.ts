import { describe, expect, test } from 'bun:test'

import { checkCitationSuperset, summarizeMissingCitations } from './citation-superset'

const ID_A = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
const ID_B = '019e2ecf-f2d5-70ee-83f6-005fb5451c51'
const ID_C = '019e2ee8-bcc4-772f-8821-876162c5e601'
const ID_D = '019e2ef0-aaaa-77ef-bbbb-cccccccccccc'

describe('checkCitationSuperset', () => {
  test('returns ok when old is empty (first-ever dreaming run)', () => {
    expect(checkCitationSuperset('', `- streams/2026-05-16#${ID_A}`)).toEqual({ ok: true })
    expect(checkCitationSuperset('# Memory\n', `- streams/2026-05-16#${ID_A}`)).toEqual({ ok: true })
  })

  test('returns ok when new is a strict superset of old', () => {
    const oldText = `- streams/2026-05-16#${ID_A}`
    const newText = [`- streams/2026-05-16#${ID_A}`, `- memory/2026-05-16#${ID_B}`].join('\n')

    expect(checkCitationSuperset(oldText, newText)).toEqual({ ok: true })
  })

  test('returns ok when new exactly equals old', () => {
    const text = [`- streams/2026-05-16#${ID_A}`, `- memory/2026-05-15#${ID_B}`].join('\n')

    expect(checkCitationSuperset(text, text)).toEqual({ ok: true })
  })

  test('returns ok across topic restructure when every old id is still cited somewhere new', () => {
    const oldText = ['## Topic A', `- streams/2026-05-16#${ID_A}`, '## Topic B', `- memory/2026-05-15#${ID_B}`].join(
      '\n',
    )
    const newText = ['## Merged', `- streams/2026-05-16#${ID_A}`, `- memory/2026-05-15#${ID_B}`].join('\n')

    expect(checkCitationSuperset(oldText, newText)).toEqual({ ok: true })
  })

  test('returns failure listing the dropped ids when new is missing an old citation', () => {
    const oldText = [`- streams/2026-05-16#${ID_A}`, `- memory/2026-05-15#${ID_B}`, `- memory/2026-05-15#${ID_C}`].join(
      '\n',
    )
    const newText = [`- streams/2026-05-16#${ID_A}`].join('\n')

    const verdict = checkCitationSuperset(oldText, newText)

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.missing).toEqual([
        { date: '2026-05-15', fragmentId: ID_B },
        { date: '2026-05-15', fragmentId: ID_C },
      ])
    }
  })

  test('reports missing ids sorted by date then id (stable for log/test assertions)', () => {
    const oldText = [
      `- streams/2026-05-16#${ID_C}`,
      `- streams/2026-05-16#${ID_A}`,
      `- streams/2026-05-15#${ID_D}`,
      `- streams/2026-05-15#${ID_B}`,
    ].join('\n')
    const newText = ''

    const verdict = checkCitationSuperset(oldText, newText)

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.missing).toEqual([
        { date: '2026-05-15', fragmentId: ID_B },
        { date: '2026-05-15', fragmentId: ID_D },
        { date: '2026-05-16', fragmentId: ID_A },
        { date: '2026-05-16', fragmentId: ID_C },
      ])
    }
  })

  test('returns failure when new drops an entire date (whole topic deleted)', () => {
    const oldText = [`- streams/2026-05-16#${ID_A}`, `- memory/2026-05-15#${ID_B}`].join('\n')
    const newText = `- streams/2026-05-16#${ID_A}`

    const verdict = checkCitationSuperset(oldText, newText)

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.missing).toEqual([{ date: '2026-05-15', fragmentId: ID_B }])
    }
  })

  test('treats inline-prose citations the same as fragments: bullets', () => {
    const oldText = `prose mentions streams/2026-05-16#${ID_A} once`
    const newText = ''

    const verdict = checkCitationSuperset(oldText, newText)

    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.missing).toEqual([{ date: '2026-05-16', fragmentId: ID_A }])
  })
})

describe('summarizeMissingCitations', () => {
  test('returns the full list when 3 or fewer are missing', () => {
    expect(
      summarizeMissingCitations([
        { date: '2026-05-15', fragmentId: ID_A },
        { date: '2026-05-15', fragmentId: ID_B },
      ]),
    ).toBe(`2026-05-15#${ID_A}, 2026-05-15#${ID_B}`)
  })

  test('truncates to the first 3 with a +N more suffix for longer lists', () => {
    expect(
      summarizeMissingCitations([
        { date: '2026-05-15', fragmentId: ID_A },
        { date: '2026-05-15', fragmentId: ID_B },
        { date: '2026-05-15', fragmentId: ID_C },
        { date: '2026-05-15', fragmentId: ID_D },
        { date: '2026-05-16', fragmentId: ID_A },
      ]),
    ).toBe(`2026-05-15#${ID_A}, 2026-05-15#${ID_B}, 2026-05-15#${ID_C} (+2 more)`)
  })

  test('handles an empty list cleanly (caller guarantee, but defensive)', () => {
    expect(summarizeMissingCitations([])).toBe('')
  })
})
