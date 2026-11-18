import { describe, expect, test } from 'bun:test'

import { buildHatchingPrompt } from './hatching'

describe('buildHatchingPrompt', () => {
  test('inlined content preserves bytes verbatim (no JSON re-serialization)', () => {
    // given: a typeclaw.json with formatting quirks the agent's `edit` will anchor on
    const json = '{\n  "alias": ["existing"],\n  "models":   {"default":"x/y"}\n}\n'

    // when
    const prompt = buildHatchingPrompt({ typeclawJsonContent: json })

    // then: the exact byte sequence must appear so `edit` can match it
    expect(prompt).toContain(json)
  })

  test('passing undefined typeclawJsonContent behaves like no options', () => {
    const a = buildHatchingPrompt()
    const b = buildHatchingPrompt({ typeclawJsonContent: undefined })
    expect(a).toBe(b)
  })

  test('content is wrapped so the agent can locate it deterministically', () => {
    const json = '{"a":1}'
    const prompt = buildHatchingPrompt({ typeclawJsonContent: json })
    const start = prompt.indexOf('<current-typeclaw-json>')
    const end = prompt.indexOf('</current-typeclaw-json>')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(prompt.slice(start, end)).toContain(json)
  })

  test('asks the agent to set its git identity only when told the identity is not explicit', () => {
    expect(buildHatchingPrompt({ setGitIdentity: true })).toContain('git.user')
    expect(buildHatchingPrompt({ setGitIdentity: false })).not.toContain('git.user')
    expect(buildHatchingPrompt()).not.toContain('git.user')
  })
})
