import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { EMBEDDING_DIMS } from '@/models/embedding-model'

import { estimateTokens, TEXT_TOKEN_BUDGET } from './truncation'

let lastExtractorInput: string[] | undefined
let lastExtractorOptions: Record<string, unknown> | undefined

type EmbedderModule = typeof import('./embedder-inference')
type TransformersImporter = NonNullable<Parameters<EmbedderModule['__setTransformersImporterForTests']>[0]>
type TransformersModule = Awaited<ReturnType<TransformersImporter>>

async function freshEmbedderModule(): Promise<EmbedderModule> {
  const mod = await import(`./embedder-inference?truncation=${crypto.randomUUID()}`)
  mod.__setModelCacheCheckForTests(() => Promise.resolve())
  const pipeline = (async () => {
    return (texts: string[], options?: Record<string, unknown>) => {
      lastExtractorInput = texts
      lastExtractorOptions = options
      const count = Array.isArray(texts) ? texts.length : 1
      return { data: new Float32Array(count * EMBEDDING_DIMS) }
    }
  }) as TransformersModule['pipeline']
  mod.__setTransformersImporterForTests(async () => ({
    env: {} as never,
    pipeline,
  }))
  return mod
}

const overBudgetText = 'word '.repeat(TEXT_TOKEN_BUDGET * 4)

describe('embedder bounding', () => {
  beforeEach(() => {
    lastExtractorInput = undefined
    lastExtractorOptions = undefined
  })

  test('extracts with mean pooling and normalized embeddings', async () => {
    const { embed } = await freshEmbedderModule()

    await embed(['short passage'], 'passage')

    expect(lastExtractorOptions?.pooling).toBe('mean')
    expect(lastExtractorOptions?.normalize).toBe(true)
  })

  test('bounds an over-budget passage to the token budget before the extractor sees it', async () => {
    const { embed } = await freshEmbedderModule()

    await embed([overBudgetText], 'passage')

    // The extractor input carries the "passage: " prefix; strip it before estimating.
    const seen = (lastExtractorInput ?? []).map((t) => t.replace(/^passage: /, ''))
    expect(seen).toHaveLength(1)
    expect(estimateTokens(seen[0] ?? '')).toBeLessThanOrEqual(TEXT_TOKEN_BUDGET)
  })

  test('passes an in-budget passage through unchanged', async () => {
    const { embed } = await freshEmbedderModule()

    await embed(['a short belief sentence'], 'passage')

    expect(lastExtractorInput).toEqual(['passage: a short belief sentence'])
  })

  test('bounds an over-budget query too (no silent loss on the retrieval side)', async () => {
    const { embed } = await freshEmbedderModule()

    await embed([overBudgetText], 'query')

    const seen = (lastExtractorInput ?? []).map((t) => t.replace(/^query: /, ''))
    expect(estimateTokens(seen[0] ?? '')).toBeLessThanOrEqual(TEXT_TOKEN_BUDGET)
  })
})

describe('embedder bounding observability', () => {
  let warnings: string[]
  const originalWarn = console.warn

  beforeEach(() => {
    lastExtractorInput = undefined
    lastExtractorOptions = undefined
    warnings = []
    console.warn = (message?: unknown) => {
      warnings.push(String(message))
    }
  })

  afterEach(() => {
    console.warn = originalWarn
  })

  test('warns content-free with the type and count when an input is bounded', async () => {
    const { embed } = await freshEmbedderModule()

    await embed(['in budget', overBudgetText], 'query')

    const bounded = warnings.filter((w) => w.includes('bounded'))
    expect(bounded).toHaveLength(1)
    expect(bounded[0]).toContain('[memory]')
    expect(bounded[0]).toContain('query')
    expect(bounded[0]).toContain('1/2')
    expect(bounded[0]).not.toContain('word')
  })

  test('does not warn about bounding when every input is within budget', async () => {
    const { embed } = await freshEmbedderModule()

    await embed(['short a', 'short b'], 'passage')

    expect(warnings.filter((w) => w.includes('bounded'))).toHaveLength(0)
  })
})

describe('embedder batch-size observability', () => {
  let warnings: string[]
  let notices: string[]
  const originalWarn = console.warn
  const originalInfo = console.info

  beforeEach(() => {
    lastExtractorInput = undefined
    lastExtractorOptions = undefined
    warnings = []
    notices = []
    console.warn = (message?: unknown) => {
      warnings.push(String(message))
    }
    console.info = (message?: unknown) => {
      notices.push(String(message))
    }
  })

  afterEach(() => {
    console.warn = originalWarn
    console.info = originalInfo
  })

  test('logs the total embed size and chunk width at info for a small build', async () => {
    const { embed } = await freshEmbedderModule()

    await embed(['short a', 'short b'], 'passage')

    const batchLine = notices.find((n) => n.includes('vector embedding'))
    expect(batchLine).toContain('2 passage input(s)')
    expect(batchLine).toContain('chunked at')
  })

  test('notes a large build is slow but does not warn — chunking removed the OOM risk', async () => {
    const { embed } = await freshEmbedderModule()

    await embed(
      Array.from({ length: 256 }, (_, i) => `passage ${i}`),
      'passage',
    )

    const batchLine = notices.find((n) => n.includes('256 passage input(s)'))
    expect(batchLine).toContain('may take a while')
    expect(warnings.some((w) => w.includes('vector embedding'))).toBe(false)
  })
})

describe('embedder progress observability', () => {
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

  test('reports per-chunk progress for a large build, ending at 100%', async () => {
    const { embed } = await freshEmbedderModule()

    await embed(
      Array.from({ length: 256 }, (_, i) => `passage ${i}`),
      'passage',
    )

    const progress = notices.filter((n) => n.includes('embedded'))
    // 256 inputs at 64/pass → 4 chunks → 4 progress lines.
    expect(progress).toHaveLength(4)
    expect(progress[0]).toContain('[memory]')
    expect(progress.at(-1)).toContain('256/256 passage input(s) embedded (100%)')
  })

  test('does not report per-chunk progress for a small build', async () => {
    const { embed } = await freshEmbedderModule()

    await embed(['short a', 'short b'], 'passage')

    expect(notices.filter((n) => n.includes('embedded'))).toHaveLength(0)
  })
})
