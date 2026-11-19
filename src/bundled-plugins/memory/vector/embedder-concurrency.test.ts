import { describe, expect, test } from 'bun:test'

import { EMBEDDING_DIMS } from '@/models/embedding-model'

type EmbedderModule = typeof import('./embedder-inference')
type TransformersImporter = NonNullable<Parameters<EmbedderModule['__setTransformersImporterForTests']>[0]>
type TransformersModule = Awaited<ReturnType<TransformersImporter>>

type Deferred = { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// A pipeline whose forward pass BLOCKS until the test releases it, so the test
// can observe how many embeds are inside inference at once. `started` fires each
// time a forward pass enters; `gate` holds it there until resolved.
async function gatedEmbedderModule(gate: Deferred, onStart: () => void): Promise<EmbedderModule> {
  const mod = await import(`./embedder-inference?concurrency=${crypto.randomUUID()}`)
  mod.__setModelCacheCheckForTests(() => Promise.resolve())
  const pipeline = (async () => {
    return async (texts: string[]) => {
      const count = Array.isArray(texts) ? texts.length : 1
      onStart()
      await gate.promise
      return { data: new Float32Array(count * EMBEDDING_DIMS) }
    }
  }) as TransformersModule['pipeline']
  mod.__setTransformersImporterForTests(async () => ({ env: {} as never, pipeline }))
  return mod
}

describe('embedder concurrency cap', () => {
  test('runs at most 2 embeds in inference at once; a 3rd waits for a slot', async () => {
    const gate = deferred()
    let inFlight = 0
    let peakInFlight = 0
    const onStart = (): void => {
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
    }

    const { embed } = await gatedEmbedderModule(gate, onStart)

    // given: three concurrent embed() calls, each a single-batch input
    const calls = [embed(['a'], 'passage'), embed(['b'], 'passage'), embed(['c'], 'passage')]

    // when: the gate is still closed, let the event loop settle so every
    // admitted call has entered its forward pass
    await new Promise((r) => setTimeout(r, 20))

    // then: only 2 are inside inference; the 3rd is queued on the semaphore
    expect(peakInFlight).toBe(2)

    gate.resolve()
    await Promise.all(calls)
  })
})
