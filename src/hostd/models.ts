import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import lockfile from 'proper-lockfile'

import { EMBEDDING_MODEL_DTYPE, EMBEDDING_MODEL_NAME, writeModelSentinel } from '@/models/embedding-model'
import { getResolvedTransformersVersion } from '@/models/transformers-version'

import { modelsDir } from './paths'

// q8 → onnx/model_quantized.onnx (~279 MB). Without this, dtype defaults to
// 'auto', which resolves to fp32 (onnx/model.onnx, 1.11 GB) on CPU/non-WASM
// devices — 4x the download for no quality gain at this corpus size. The
// gold-set eval that chose e5-base (recall@3 96.9%) was run on this q8 variant.
// Shared with the container embedder via @/models/embedding-model: the host
// downloads what the container loads with local_files_only, so a mismatch
// makes the container request a file that was never fetched.
const MODEL_NAME = EMBEDDING_MODEL_NAME
const MODEL_DTYPE = EMBEDDING_MODEL_DTYPE
const LOCK_RETRIES = { retries: 60, factor: 1, minTimeout: 100, maxTimeout: 100, randomize: false } as const

let ensureModelsPromise: Promise<void> | null = null
let ensureModelsPath: string | null = null

export function ensureModels(): Promise<void> {
  const dir = modelsDir()
  if (ensureModelsPath !== dir) {
    ensureModelsPath = dir
    ensureModelsPromise = null
  }
  ensureModelsPromise ??= ensureModelsLocked().catch((error: unknown) => {
    ensureModelsPromise = null
    throw error
  })
  return ensureModelsPromise
}

async function ensureModelsLocked(): Promise<void> {
  const dir = modelsDir()
  await mkdir(dir, { recursive: true })

  const release = await lockfile.lock(dir, {
    lockfilePath: join(dir, '.lock'),
    realpath: false,
    retries: LOCK_RETRIES,
    stale: 30_000,
  })
  try {
    const { env, pipeline } = await import('@huggingface/transformers')
    env.localModelPath = dir
    env.cacheDir = dir
    await pipeline('feature-extraction', MODEL_NAME, { dtype: MODEL_DTYPE })
    // Stamp the cache with the version that produced it, still under the lock,
    // so the container can verify the producer matches its consumer before a
    // local_files_only load (see assertModelCacheCompatible).
    await writeModelSentinel(dir, { transformers: getResolvedTransformersVersion() })
  } finally {
    await release()
  }
}
