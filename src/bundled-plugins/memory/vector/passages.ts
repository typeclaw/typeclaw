import { fragmentContentHash } from '../fragment-parser'
import { loadAllShards, type TopicShard } from '../load-shards'
import { EMBEDDING_MODEL_ID } from './embedder'
import type { VectorStore } from './store'

// Only topics are embedded. Undreamed stream fragments are reachable via the
// keyword lane (`searchAll` reads the JSONL directly) and, once dreaming
// consolidates them, by their parent topic's vector — so a transient
// fragment's embedding earned ~30 min of paraphrase recall on the write hot
// path for content the keyword lane already covers. The `source` union is kept
// (the keyword lane still yields `stream` results) but no `stream` rows are
// ever written; legacy ones are pruned by startup/doctor on next boot.
export type Passage = {
  id: string
  source: 'topic'
  key: string
  text: string
  contentHash: string
}

export async function collectPassages(agentDir: string): Promise<Passage[]> {
  return buildPassages(await loadAllShards(agentDir))
}

export function findMissingPassages(store: VectorStore, passages: Passage[]): Passage[] {
  const existing = new Map(store.getAllMeta().map((row) => [row.id, row]))
  return passages.filter((passage) => {
    const row = existing.get(passage.id)
    return row === undefined || row.model !== EMBEDDING_MODEL_ID || row.contentHash !== passage.contentHash
  })
}

function buildPassages(shards: TopicShard[]): Passage[] {
  return shards.map(
    (shard): Passage => ({
      id: `topic:${shard.slug}`,
      source: 'topic',
      key: shard.slug,
      text: `${shard.frontmatter.heading}\n${shard.body}`,
      contentHash: fragmentContentHash({ topic: shard.frontmatter.heading, body: shard.body }),
    }),
  )
}
