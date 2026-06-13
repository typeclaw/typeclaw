import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { DIMS } from './embedder'
import { estimateTokens, TEXT_TOKEN_BUDGET } from './truncation'

let lastExtractorInput: string[] | undefined
let lastExtractorOptions: Record<string, unknown> | undefined

mock.module('@huggingface/transformers', () => ({
  env: {},
  pipeline: async () => {
    return (texts: string[], options?: Record<string, unknown>) => {
      lastExtractorInput = texts
      lastExtractorOptions = options
      const count = Array.isArray(texts) ? texts.length : 1
      return { data: new Float32Array(count * DIMS) }
    }
  },
}))

const overBudgetText = 'word '.repeat(TEXT_TOKEN_BUDGET * 4)

describe('embedder bounding', () => {
  test('extracts with mean pooling and normalized embeddings', async () => {
    const { embed } = await import('./embedder')

    await embed(['short passage'], 'passage')

    expect(lastExtractorOptions?.pooling).toBe('mean')
    expect(lastExtractorOptions?.normalize).toBe(true)
  })

  test('bounds an over-budget passage to the token budget before the extractor sees it', async () => {
    const { embed } = await import('./embedder')

    await embed([overBudgetText], 'passage')

    // The extractor input carries the "passage: " prefix; strip it before estimating.
    const seen = (lastExtractorInput ?? []).map((t) => t.replace(/^passage: /, ''))
    expect(seen).toHaveLength(1)
    expect(estimateTokens(seen[0] ?? '')).toBeLessThanOrEqual(TEXT_TOKEN_BUDGET)
  })

  test('passes an in-budget passage through unchanged', async () => {
    const { embed } = await import('./embedder')

    await embed(['a short belief sentence'], 'passage')

    expect(lastExtractorInput).toEqual(['passage: a short belief sentence'])
  })

  test('bounds an over-budget query too (no silent loss on the retrieval side)', async () => {
    const { embed } = await import('./embedder')

    await embed([overBudgetText], 'query')

    const seen = (lastExtractorInput ?? []).map((t) => t.replace(/^query: /, ''))
    expect(estimateTokens(seen[0] ?? '')).toBeLessThanOrEqual(TEXT_TOKEN_BUDGET)
  })
})

describe('embedder bounding observability', () => {
  let notices: string[]
  const originalInfo = console.info

  beforeEach(() => {
    notices = []
    console.info = (message?: unknown) => {
      notices.push(String(message))
    }
  })

  afterEach(() => {
    console.info = originalInfo
  })

  test('emits a content-free notice naming the type and count when an input is bounded', async () => {
    const { embed } = await import('./embedder')

    await embed(['in budget', overBudgetText], 'query')

    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('[memory]')
    expect(notices[0]).toContain('query')
    expect(notices[0]).toContain('1/2')
    expect(notices[0]).not.toContain('word')
  })

  test('does not log when every input is within budget', async () => {
    const { embed } = await import('./embedder')

    await embed(['short a', 'short b'], 'passage')

    expect(notices).toHaveLength(0)
  })
})
