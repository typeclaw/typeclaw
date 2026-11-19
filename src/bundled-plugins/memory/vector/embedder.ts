import { EmbedderProcess } from './embedder-process'
import type { EmbedType } from './embedder-wire'

export {
  EMBEDDING_DIMS as DIMS,
  EMBEDDING_MODEL_DTYPE as MODEL_DTYPE,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_NAME as MODEL_NAME,
} from '@/models/embedding-model'
export type { EmbedType } from './embedder-wire'

let embedder = new EmbedderProcess()

export function startEmbedderProcess(): () => Promise<void> {
  const runtimeEmbedder = new EmbedderProcess()
  embedder = runtimeEmbedder
  return () => runtimeEmbedder.dispose()
}

export function embed(texts: string[], type: EmbedType): Promise<Float32Array[]> {
  return embedder.embed(texts, type)
}
