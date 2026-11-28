import { describe, expect, test } from 'bun:test'

import type { Option } from '@clack/prompts'

import { fuzzyMatch } from './fuzzy-filter'

function opt(label: string, value: string, hint?: string): Option<string> {
  return hint !== undefined ? { value, label, hint } : { value, label }
}

describe('fuzzyMatch', () => {
  test('matches spaced query across a hyphenated label', () => {
    const option = opt('GPT-5.5 Turbo', 'openai/gpt-5.5-turbo')
    expect(fuzzyMatch('gpt 5.5', option)).toBe(true)
  })

  test('is case-insensitive', () => {
    const option = opt('GPT-5.5 Turbo', 'openai/gpt-5.5-turbo')
    expect(fuzzyMatch('GPT', option)).toBe(true)
    expect(fuzzyMatch('TURBO', option)).toBe(true)
  })

  test('matches against the value when label omits the term', () => {
    const option = opt('Claude Sonnet', 'anthropic/claude-sonnet-4')
    expect(fuzzyMatch('anthropic', option)).toBe(true)
  })

  test('matches against the hint', () => {
    const option = opt('Add provider', 'sentinel', 'configure a new provider')
    expect(fuzzyMatch('configure', option)).toBe(true)
  })

  test('empty query matches everything', () => {
    const option = opt('Anything', 'x')
    expect(fuzzyMatch('', option)).toBe(true)
    expect(fuzzyMatch('   ', option)).toBe(true)
  })

  test('all tokens must be present', () => {
    const option = opt('GPT-5.5 Turbo', 'openai/gpt-5.5-turbo')
    expect(fuzzyMatch('gpt mini', option)).toBe(false)
  })

  test('non-matching query returns false', () => {
    const option = opt('GPT-5.5 Turbo', 'openai/gpt-5.5-turbo')
    expect(fuzzyMatch('claude', option)).toBe(false)
  })

  test('subsequence (abbreviation) matching within a token', () => {
    const option = opt('GPT-4o', 'openai/gpt-4o')
    expect(fuzzyMatch('gpt4o', option)).toBe(true)
  })

  test('falls back to String(value) when label is absent', () => {
    const option: Option<string> = { value: 'openai/gpt-5.5' }
    expect(fuzzyMatch('gpt', option)).toBe(true)
  })

  test('does not match letters scattered across separate words', () => {
    const option = opt(
      'OpenAI Codex (ChatGPT Plus/Pro) · GPT-5.4 mini',
      'openai-codex/gpt-5.4-mini',
      'openai-codex/gpt-5.4-mini',
    )
    expect(fuzzyMatch('sonnet', option)).toBe(false)
  })

  test('matches the intended model among scattered-letter decoys', () => {
    const option = opt('Anthropic · Claude Sonnet 4.6', 'anthropic/claude-sonnet-4-6')
    expect(fuzzyMatch('sonnet', option)).toBe(true)
    expect(fuzzyMatch('snt', option)).toBe(true)
  })

  test('matches a query token containing a separator as a substring', () => {
    const option = opt('Claude Sonnet', 'anthropic/claude-sonnet-4')
    expect(fuzzyMatch('anthropic/claude', option)).toBe(true)
  })

  test('matches non-Latin labels', () => {
    const option = opt('모델 선택 도우미', 'local/helper')
    expect(fuzzyMatch('선택', option)).toBe(true)
    expect(fuzzyMatch('모선', option)).toBe(false)
  })

  test('abbreviates a word containing combining marks', () => {
    const option = opt('मॉडल चुनें', 'local/helper')
    expect(fuzzyMatch('मडल', option)).toBe(true)
  })

  test('tokens are order-independent', () => {
    const option = opt('GPT Turbo', 'openai/gpt-turbo')
    expect(fuzzyMatch('gpt turbo', option)).toBe(true)
    expect(fuzzyMatch('turbo gpt', option)).toBe(true)
  })
})
