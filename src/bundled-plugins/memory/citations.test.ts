import { describe, expect, test } from 'bun:test'

import { formatCitation, isCitationLine, parseCitations } from './citations'

const ID_A = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
const ID_B = '019e2ecf-f2d5-70ee-83f6-005fb5451c51'
const ID_C = '019e2ee8-bcc4-772f-8821-876162c5e601'

describe('formatCitation', () => {
  test('produces the canonical streams/yyyy-MM-dd#<id> shape', () => {
    expect(formatCitation('2026-05-16', ID_A)).toBe(`streams/2026-05-16#${ID_A}`)
  })
})

describe('isCitationLine', () => {
  test('matches a citation line with a leading dash and space', () => {
    expect(isCitationLine(`- streams/2026-05-16#${ID_A}`)).toBe(true)
  })

  test('matches a bare citation line', () => {
    expect(isCitationLine(`streams/2026-05-16#${ID_A}`)).toBe(true)
  })

  test('rejects a legacy line-range citation', () => {
    expect(isCitationLine('- memory/2026-05-16:43-45')).toBe(false)
  })

  test('rejects an unrelated bullet line', () => {
    expect(isCitationLine('- some other content')).toBe(false)
  })
})

describe('parseCitations', () => {
  test('extracts every citation grouped by date', () => {
    const text = [
      '## Topic',
      'Conclusion paragraph.',
      '',
      'fragments:',
      `- streams/2026-05-16#${ID_A}`,
      `- streams/2026-05-16#${ID_B}`,
      `- streams/2026-05-15#${ID_C}`,
    ].join('\n')

    const result = parseCitations(text)

    expect(result.get('2026-05-16')).toEqual(new Set([ID_A, ID_B]))
    expect(result.get('2026-05-15')).toEqual(new Set([ID_C]))
  })

  test('returns an empty map when no citations appear', () => {
    expect(parseCitations('# Memory\n\n(empty)\n').size).toBe(0)
  })

  test('drops legacy :line-range citations entirely (no backward compat)', () => {
    const text = [
      '## Old topic',
      'fragments:',
      '- memory/2026-04-27:43-45',
      '',
      '## New topic',
      'fragments:',
      `- streams/2026-05-16#${ID_A}`,
    ].join('\n')

    const result = parseCitations(text)

    expect(result.has('2026-04-27')).toBe(false)
    expect(result.get('2026-05-16')).toEqual(new Set([ID_A]))
  })

  test('deduplicates repeated citations of the same fragment', () => {
    const text = [`- streams/2026-05-16#${ID_A}`, `- streams/2026-05-16#${ID_A}`].join('\n')

    const result = parseCitations(text)

    expect(result.get('2026-05-16')).toEqual(new Set([ID_A]))
  })

  test('citation can appear inline inside prose, not only as a bullet line', () => {
    const text = `see streams/2026-05-16#${ID_A} for context`

    const result = parseCitations(text)

    expect(result.get('2026-05-16')).toEqual(new Set([ID_A]))
  })
})
