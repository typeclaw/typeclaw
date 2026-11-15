import { createHash } from 'node:crypto'

import { loadShard } from './load-shards'
import { loadReference } from './references/load-references'
import type { MemorySearchMatch, StreamMatch } from './search-tool'
import { readAllStreamDays } from './stream-io'
import type { HybridSearchResult } from './vector/hybrid'

// Hybrid results carry excerpts and provenance, while the tool also exposes
// canonical paths, citation IDs and optional complete bodies.
export async function hydrateHybridMatches(
  agentDir: string,
  results: HybridSearchResult[],
  full: boolean,
): Promise<MemorySearchMatch[]> {
  const streams = new Map<string, StreamMatch>()
  if (results.some((hit) => hit.source === 'stream')) {
    for (const day of await readAllStreamDays(agentDir)) {
      for (const event of day.events) {
        const base = { source: 'stream', streamPath: day.path, date: day.date, excerpt: '' } as const
        switch (event.type) {
          case 'fragment':
            streams.set(`${day.date}#${event.id}`, {
              ...base,
              topic: event.topic,
              eventId: `streams/${day.date}#${event.id}`,
              ...(full ? { fullBody: event.body } : {}),
            })
            break
          case 'legacy_prose':
            streams.set(`${day.date}#legacy-${createHash('sha256').update(event.text).digest('hex').slice(0, 12)}`, {
              ...base,
              topic: '[legacy prose from pre-shard migration]',
              ...(full ? { fullBody: event.text } : {}),
            })
            break
          case 'watermark':
            break
          default:
            event satisfies never
        }
      }
    }
  }

  const matches = await Promise.all(
    results.map(async (hit): Promise<MemorySearchMatch | null> => {
      switch (hit.source) {
        case 'topic': {
          const shard = await loadShard(agentDir, hit.key)
          if (shard === null) return null
          return {
            source: 'topic',
            shardPath: shard.path,
            slug: hit.key,
            heading: hit.heading,
            excerpt: hit.excerpt,
            ...(hit.provenance === undefined ? {} : { provenance: hit.provenance }),
            ...(full ? { fullBody: shard.body } : {}),
          }
        }
        case 'reference': {
          const reference = await loadReference(agentDir, hit.key)
          if (reference === null) return null
          return {
            source: 'reference',
            slug: hit.key,
            title: hit.heading,
            excerpt: hit.excerpt,
            created: reference.frontmatter.created,
            ...(full ? { fullBody: reference.body } : {}),
          }
        }
        case 'stream': {
          const stream = streams.get(hit.key)
          if (stream === undefined) return null
          return {
            ...stream,
            excerpt: hit.excerpt,
            ...(hit.who === undefined ? {} : { who: hit.who }),
            ...(hit.when === undefined ? {} : { when: hit.when }),
            ...(hit.where === undefined ? {} : { where: hit.where }),
          }
        }
        default:
          return hit.source satisfies never
      }
    }),
  )
  return matches.filter((match) => match !== null)
}
