import { join } from 'node:path'

// Type-only import: erased at runtime, so it does NOT evaluate
// @huggingface/transformers (which eagerly `import sharp`s, crashing the
// container at startup when sharp's linux binary is missing). The runtime
// values are pulled lazily via `loadTransformers()` below.
import type { env as TransformersEnvValue, pipeline as TransformersPipeline } from '@huggingface/transformers'

import { homeRoot } from '../../../hostd/paths'
import { type BoundedText, boundEmbeddableText, MAX_MODEL_TOKENS } from './truncation'

export const MODEL_NAME = 'Xenova/multilingual-e5-base'
export const DIMS = 768
// MUST match src/hostd/models.ts MODEL_DTYPE: the host downloads exactly this
// variant, and this loader runs local_files_only, so a mismatch loads nothing.
// q8 → onnx/model_quantized.onnx (~279 MB); the default would be fp32 (1.11 GB).
export const MODEL_DTYPE = 'q8'

// The index identity. dtype changes the embedding values (q8 ≠ fp32) while
// MODEL_NAME and DIMS stay constant, so neither alone detects a variant switch.
// Vectors are stamped with this and retrieval filters on it — rows from a
// different variant are stale and never compared against a query of this one.
export const EMBEDDING_MODEL_ID = `${MODEL_NAME}@${MODEL_DTYPE}`

export type EmbedType = 'query' | 'passage'

type TransformersEnv = typeof TransformersEnvValue
type FeatureExtractor = Awaited<ReturnType<typeof TransformersPipeline<'feature-extraction'>>>

// Defer the transformers (and thus sharp/onnxruntime) module load until an
// embedding is actually requested. typeclaw's memory plugin is always loaded
// and `vector.enabled` defaults to false, so a top-level static import would
// drag the heavy native stack onto every container boot — and crash it when
// sharp can't resolve its platform binary. Memoized so the module evaluates
// at most once.
let transformersModulePromise: Promise<{ env: TransformersEnv; pipeline: typeof TransformersPipeline }> | undefined

function loadTransformers(): Promise<{ env: TransformersEnv; pipeline: typeof TransformersPipeline }> {
  transformersModulePromise ??= import('@huggingface/transformers').then((mod) => ({
    env: mod.env,
    pipeline: mod.pipeline,
  }))
  return transformersModulePromise
}

export class Embedder {
  private constructor(private readonly extractor: FeatureExtractor) {}

  static async load(): Promise<Embedder> {
    const { env, pipeline } = await loadTransformers()
    configureTransformers(env)
    const extractor = await pipeline('feature-extraction', MODEL_NAME, { local_files_only: true, dtype: MODEL_DTYPE })
    return new Embedder(extractor)
  }

  async embed(texts: string[], type: EmbedType): Promise<Float32Array[]> {
    if (texts.length === 0) return []

    // Bound every input to the model's token budget BEFORE the tokenizer sees it.
    // The tokenizer would otherwise truncate silently at 512 tokens; bounding
    // here makes the cut deterministic and owned by us (the leading heading /
    // belief sentence — the load-bearing retrieval signal — always survives
    // because it comes first). The dreaming subagent separately compacts the
    // topic shards that trip this, but bounding guarantees no silent loss even
    // for inputs dreaming never rewrites — queries and stream fragments — which
    // the dreaming over_budget table does not cover, so this is their only
    // observability path.
    const results = texts.map((text) => boundEmbeddableText(text))
    warnIfBounded(results, type)

    const output = await this.extractor(
      prefixTexts(
        results.map((r) => r.text),
        type,
      ),
      {
        pooling: 'mean',
        normalize: true,
      },
    )
    return toEmbeddings(output.data, texts.length)
  }
}

let embedderInstance: Promise<Embedder> | null = null

export function getEmbedder(): Promise<Embedder> {
  embedderInstance ??= Embedder.load()
  return embedderInstance
}

export async function embed(texts: string[], type: EmbedType): Promise<Float32Array[]> {
  return (await getEmbedder()).embed(texts, type)
}

// Structured, content-free signal when any input was bounded, so a truncation
// is observable in logs (the dreaming over_budget table only covers topic
// shards — this is the only path for queries and stream fragments). Logs counts
// and the worst estimate only, never the text, so memory content can't leak.
// Emitted at info, not warn: bounding is the designed, deterministic remediation
// (dreaming compacts the over-budget topic shards on its own schedule), so a
// non-zero count on a routine boot index build is expected, not actionable.
function warnIfBounded(results: readonly BoundedText[], type: EmbedType): void {
  const trimmed = results.filter((r) => r.bounded)
  if (trimmed.length === 0) return
  const worst = trimmed.reduce((max, r) => Math.max(max, r.estimatedTokens), 0)
  console.info(
    `[memory] vector embedding: bounded ${trimmed.length}/${results.length} ${type} input(s) to the ` +
      `${MAX_MODEL_TOKENS}-token model limit (worst ~${worst} est. tokens); their tail is not embedded`,
  )
}

function configureTransformers(env: TransformersEnv): void {
  env.localModelPath = modelCachePath()
  env.allowRemoteModels = false
  // Silence onnxruntime's "cpuid_info warning: Unknown CPU vendor" at every
  // boot index build. It fires when cpuinfo initializes but can't match the
  // CPUID vendor string — the norm for our container under emulated/virtualized
  // CPUs (Rosetta/QEMU on Apple Silicon hosts). The vendor string is purely
  // informational: SIMD kernel dispatch (AVX/NEON/...) is detected on an
  // independent codepath, so vendor=unknown has no perf or correctness impact.
  // onnxruntime itself already suppresses this same warning on wasm.
  // onnxruntime-node reads this onnxruntime-common env at session creation —
  // inside pipeline() below, AFTER this runs — so 'error' takes effect before
  // the cpuid probe fires. Guarded because the backend object is absent under
  // the test mock; setLogLevel mirrors the level so it lands regardless of
  // which hook the installed build honors. Tradeoff: 'error' also hides the
  // separate "cpuinfo init FAILED — perf degradation" warning, acceptable
  // because that one does not fire here (vendor=0 means init succeeded), and
  // real session/inference errors still surface.
  const onnx = env.backends?.onnx
  if (onnx) {
    onnx.logLevel = 'error'
    onnx.setLogLevel?.(3)
  }
}

function modelCachePath(): string {
  const override = process.env.TYPECLAW_MODEL_CACHE
  if (override && override.length > 0) return override
  return join(homeRoot(), 'models')
}

function prefixTexts(texts: string[], type: EmbedType): string[] {
  const prefix = type === 'query' ? 'query: ' : 'passage: '
  return texts.map((text) => `${prefix}${text}`)
}

function toEmbeddings(data: unknown, count: number): Float32Array[] {
  const values = toFloat32Array(data)
  if (values.length !== count * DIMS) {
    throw new Error(`unexpected ${MODEL_NAME} embedding size: got ${values.length}, expected ${count * DIMS}`)
  }

  return Array.from({ length: count }, (_, index) => values.slice(index * DIMS, (index + 1) * DIMS))
}

function toFloat32Array(data: unknown): Float32Array {
  if (data instanceof Float32Array) return data
  if (!isNumericArrayLike(data)) throw new Error(`${MODEL_NAME} returned non-numeric embeddings`)
  return Float32Array.from(data)
}

function isNumericArrayLike(data: unknown): data is ArrayLike<number> {
  if (!ArrayBuffer.isView(data) || !('length' in data)) return false
  return !(data instanceof BigInt64Array) && !(data instanceof BigUint64Array)
}
