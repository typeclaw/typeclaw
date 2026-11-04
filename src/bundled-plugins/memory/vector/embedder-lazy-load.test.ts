import { beforeEach, describe, expect, test } from 'bun:test'

import { DEFAULT_MAX_EMBED_THREADS } from './embed-threads'

// Regression guard for the container-boot crash: `@huggingface/transformers`
// eagerly `import sharp`s at module-evaluation time, and the memory plugin
// imports the embedder transitively. If embedder.ts ever goes back to a top-level
// `import { env, pipeline } from '@huggingface/transformers'`, the transformers
// module would evaluate the moment embedder.ts is imported — dragging sharp onto
// every boot and crashing the container. These tests prove the import is
// deferred to first embed.
let transformersEvaluated = false
let lastPipelineOptions: Record<string, unknown> | undefined

type EmbedderModule = typeof import('./embedder')
type TransformersImporter = NonNullable<Parameters<EmbedderModule['__setTransformersImporterForTests']>[0]>
type TransformersModule = Awaited<ReturnType<TransformersImporter>>

function fakeTransformersModule(): TransformersImporter {
  return async () => {
    transformersEvaluated = true
    const pipeline = (async (_task: string, _model?: string, options?: Record<string, unknown>) => {
      lastPipelineOptions = options
      const extractor = () => ({ data: new Float32Array(768) })
      return extractor
    }) as TransformersModule['pipeline']
    return {
      env: {} as never,
      pipeline,
    }
  }
}

async function freshEmbedderModule(): Promise<EmbedderModule> {
  const mod = await import(`./embedder?lazy=${crypto.randomUUID()}`)
  mod.__setModelCacheCheckForTests(() => Promise.resolve())
  mod.__setTransformersImporterForTests(fakeTransformersModule())
  return mod
}

describe('embedder lazy transformers load', () => {
  beforeEach(() => {
    transformersEvaluated = false
    lastPipelineOptions = undefined
  })

  test('importing the embedder module does NOT evaluate @huggingface/transformers', () => {
    // The flag-based seam below only fires for the FAKE importer, which is
    // installed after embedder.ts is already imported — so it cannot observe a
    // top-level static import that evaluates the REAL module during embedder.ts
    // module evaluation. This guard runs in a child bun process that mocks the
    // specifier and fails if the mock factory is invoked while importing
    // embedder.ts, catching exactly that regression without leaking Bun's
    // process-global mock.module into the sibling tests.
    const embedderUrl = `${new URL('./embedder.ts', import.meta.url).href}?lazy=${crypto.randomUUID()}`
    const script = `
      import { mock } from 'bun:test'
      let transformersRequested = false
      mock.module('@huggingface/transformers', () => {
        transformersRequested = true
        return { env: {}, pipeline: async () => { throw new Error('pipeline must not run during module eval') } }
      })
      await import(${JSON.stringify(embedderUrl)})
      if (transformersRequested) {
        console.error('@huggingface/transformers was requested while evaluating embedder.ts')
        process.exit(1)
      }
    `
    const result = Bun.spawnSync({
      timeout: 30_000,
      cmd: [process.execPath, '--eval', script],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = new TextDecoder().decode(result.stderr) || new TextDecoder().decode(result.stdout)
    expect(result.exitCode, output).toBe(0)
  })

  test('@huggingface/transformers is evaluated only when an embedding is actually requested', async () => {
    const { getEmbedder } = await freshEmbedderModule()
    expect(transformersEvaluated).toBe(false)

    await getEmbedder()
    expect(transformersEvaluated).toBe(true)
  })

  test('loads the q8 variant locally (dtype pinned, local_files_only preserved)', async () => {
    const { getEmbedder } = await freshEmbedderModule()

    await getEmbedder()

    expect(lastPipelineOptions?.dtype).toBe('q8')
    expect(lastPipelineOptions?.local_files_only).toBe(true)
  })

  test('forwards the memory-bounding session_options to the onnxruntime session', async () => {
    const { getEmbedder } = await freshEmbedderModule()

    await getEmbedder()

    // Regression guard: removing or miswiring this block silently restores the
    // per-core intra-op thread fan-out and the arena that never frees, which is
    // the production memory regression this PR fixes.
    const opts = lastPipelineOptions?.session_options as
      | { intraOpNumThreads?: unknown; interOpNumThreads?: unknown; enableCpuMemArena?: unknown }
      | undefined
    expect(opts).toBeDefined()
    expect(opts?.interOpNumThreads).toBe(1)
    expect(opts?.enableCpuMemArena).toBe(false)
    expect(Number.isInteger(opts?.intraOpNumThreads)).toBe(true)
    expect(opts?.intraOpNumThreads as number).toBeGreaterThanOrEqual(1)
    expect(opts?.intraOpNumThreads as number).toBeLessThanOrEqual(DEFAULT_MAX_EMBED_THREADS)
  })
})
