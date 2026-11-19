import { describe, expect, test } from 'bun:test'

// A controllable transformers fake whose pipeline load can be made to fail on
// demand, so we can prove embedding recovers from a transient
// pipeline failure instead of caching the rejection forever. Kept in its own
// file (separate from embedder-lazy-load.test.ts) because the embedder memoizes
// a module-level singleton across a file's tests — a failable mock here must
// not perturb the lazy-load regression guard there.
let pipelineCalls = 0
let failNextPipeline = false

type EmbedderModule = typeof import('./embedder-inference')
type TransformersImporter = NonNullable<Parameters<EmbedderModule['__setTransformersImporterForTests']>[0]>
type TransformersModule = Awaited<ReturnType<TransformersImporter>>

function fakeTransformersModule(): TransformersImporter {
  return async () => ({
    env: {} as never,
    pipeline: (async () => {
      pipelineCalls += 1
      if (failNextPipeline) throw new Error('local_files_only: model weights missing')
      return () => ({ data: new Float32Array(768) })
    }) as TransformersModule['pipeline'],
  })
}

describe('embedder reuse and retry', () => {
  test('passage indexing and query embedding reuse the same model session', async () => {
    const { embed } = await freshEmbedderModule()
    pipelineCalls = 0

    await embed(['hello'], 'passage')
    await embed(['hello'], 'query')

    expect(pipelineCalls).toBe(1)
  })

  test('a startup indexing load failure can be retried by a later query', async () => {
    const { embed } = await freshEmbedderModule()

    failNextPipeline = true
    await expect(embed(['hello'], 'passage')).rejects.toThrow('model weights missing')

    failNextPipeline = false
    const embeddings = await embed(['hello'], 'query')

    expect(embeddings).toHaveLength(1)
  })

  test('a rejected transformers module load is not cached: the next call reloads', async () => {
    const { getEmbedder, __setTransformersImporterForTests } = await freshEmbedderModule()

    // given: the dynamic import / native module load itself fails the first time
    // then succeeds — driven through the importer seam because Bun snapshots a
    // mock.module namespace at registration and can't toggle import failure later
    let importCalls = 0
    __setTransformersImporterForTests(async () => {
      importCalls += 1
      if (importCalls === 1) throw new Error('Cannot find module: sharp platform binary missing')
      return { env: {} as never, pipeline: (async () => () => ({ data: new Float32Array(768) })) as never }
    })

    // when: the first load fails and the caller retries after recovery
    await expect(getEmbedder()).rejects.toThrow('sharp platform binary missing')
    await getEmbedder()

    // then: transformersModulePromise wasn't memoized as rejected — it reloaded
    expect(importCalls).toBe(2)
  })
})

// Bun's module registry memoizes embedder.ts across tests, so its singleton
// would leak between the cases above. A cache-busting query string forces a
// fresh module instance (and thus a fresh embedderInstance) per test.
async function freshEmbedderModule(): Promise<EmbedderModule> {
  const mod = await import(`./embedder-inference?retry=${crypto.randomUUID()}`)
  mod.__setModelCacheCheckForTests(() => Promise.resolve())
  mod.__setTransformersImporterForTests(fakeTransformersModule())
  return mod
}
