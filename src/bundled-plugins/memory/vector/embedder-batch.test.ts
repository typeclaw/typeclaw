import { beforeEach, describe, expect, test } from 'bun:test'

import { EMBEDDING_DIMS } from '@/models/embedding-model'

// Records the size of every onnxruntime forward pass so the test can prove the
// embed is chunked (bounding peak memory) rather than run as one giant batch.
const batchSizes: number[] = []

type EmbedderModule = typeof import('./embedder-inference')
type TransformersImporter = NonNullable<Parameters<EmbedderModule['__setTransformersImporterForTests']>[0]>
type TransformersModule = Awaited<ReturnType<TransformersImporter>>

async function freshEmbedderModule(): Promise<EmbedderModule> {
  const mod = await import(`./embedder-inference?batch=${crypto.randomUUID()}`)
  mod.__setModelCacheCheckForTests(() => Promise.resolve())
  const pipeline = (async () => {
    return (texts: string[]) => {
      const count = Array.isArray(texts) ? texts.length : 1
      batchSizes.push(count)
      // Stamp each row's first lane with a running global index so the caller
      // can assert order is preserved across chunk boundaries.
      const data = new Float32Array(count * EMBEDDING_DIMS)
      const base = batchSizes.slice(0, -1).reduce((sum, n) => sum + n, 0)
      for (let i = 0; i < count; i++) data[i * EMBEDDING_DIMS] = base + i
      return { data }
    }
  }) as TransformersModule['pipeline']
  mod.__setTransformersImporterForTests(async () => ({
    env: {} as never,
    pipeline,
  }))
  return mod
}

describe('embedder batching', () => {
  beforeEach(() => {
    batchSizes.length = 0
  })

  test('splits a large input set into bounded forward passes and preserves order', async () => {
    const { embed } = await freshEmbedderModule()
    const inputs = Array.from({ length: 150 }, (_, i) => `passage ${i}`)

    const completed: number[] = []
    const out = await embed(inputs, 'passage', (count) => completed.push(count))

    // given 150 inputs and a 64 batch → 64 + 64 + 22
    expect(batchSizes).toEqual([64, 64, 22])
    expect(completed).toEqual([64, 128, 150])
    expect(batchSizes.every((n) => n <= 64)).toBe(true)
    expect(out).toHaveLength(150)
    // first lane carries the global index, so order is intact across chunks
    expect(out.map((e) => e[0])).toEqual(inputs.map((_, i) => i))
  })
})
