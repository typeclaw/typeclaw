import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseCitations, type Citation } from './citations'

export type TopicShard = {
  heading: string
  body: string
  citations: Citation[]
}

const HEADING_LEVEL_1 = /^#\s+(.*)$/
const HEADING_LEVEL_2 = /^##\s+(.*)$/

export function parseTopicShard(text: string): TopicShard | null {
  const lines = text.split('\n')

  let heading = ''
  let headingFound = false
  const body: string[] = []

  for (const line of lines) {
    const h1Match = HEADING_LEVEL_1.exec(line)
    if (h1Match) {
      heading = (h1Match[1] ?? '').trim()
      headingFound = true
      continue
    }
    if (!headingFound) {
      const h2Match = HEADING_LEVEL_2.exec(line)
      if (h2Match) {
        heading = (h2Match[1] ?? '').trim()
        headingFound = true
        continue
      }
    }
    if (headingFound) body.push(line)
  }

  if (!headingFound) return null

  const bodyText = body.join('\n')
  const grouped = parseCitations(bodyText)
  const citations: Citation[] = []
  for (const [date, ids] of grouped) {
    for (const fragmentId of ids) citations.push({ date, fragmentId })
  }

  return { heading, body: bodyText.trimEnd(), citations }
}

export function renderTopicShard(shard: TopicShard): string {
  const lines = [`# ${shard.heading}`, '', shard.body]
  if (shard.body.length > 0) lines.push('')
  return lines.join('\n').trimEnd() + '\n'
}

export async function readTopicShard(path: string): Promise<TopicShard | null> {
  try {
    const text = await readFile(path, 'utf8')
    return parseTopicShard(text)
  } catch {
    return null
  }
}

export function slugifyTopicHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

export async function loadTopicShards(dir: string): Promise<TopicShard[]> {
  const { readdir } = await import('node:fs/promises')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }

  const shards: TopicShard[] = []
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    const shard = await readTopicShard(join(dir, name))
    if (shard !== null) shards.push(shard)
  }
  return shards
}
