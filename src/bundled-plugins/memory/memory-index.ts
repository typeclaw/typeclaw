import { readFile, writeFile } from 'node:fs/promises'

import { memoryIndexPath } from './memory-paths'
import type { TopicShard } from './topic-shard'

export type TopicEntry = {
  heading: string
  slug: string
  file: string
  active: boolean
  cites: number
  days: number
  lastReinforced: string
  ageDays: number
}

export type MemoryIndex = {
  activeTopics: TopicEntry[]
  archivedTopics: TopicEntry[]
  historicalObservations: string[]
}

const ACTIVE_TABLE_HEADER = '| Topic | File | Days | Last | Age |'
const TABLE_SEPARATOR = '|-------|------|------|------|-----|'

export function parseMemoryIndex(text: string): MemoryIndex {
  const lines = text.split('\n')
  const index: MemoryIndex = {
    activeTopics: [],
    archivedTopics: [],
    historicalObservations: [],
  }

  let section: 'active' | 'archive' | 'historical' | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('## Active topics')) {
      section = 'active'
      continue
    }
    if (trimmed.startsWith('## Archived topics')) {
      section = 'archive'
      continue
    }
    if (trimmed.startsWith('## Historical observations')) {
      section = 'historical'
      continue
    }
    if (!trimmed.startsWith('|') || trimmed.startsWith('|--')) continue

    if (section === 'active' || section === 'archive') {
      const cells = trimmed
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
      if (cells.length >= 5) {
        const entry: TopicEntry = {
          heading: cells[0] ?? '',
          slug: '',
          file: cells[1] ?? '',
          active: section === 'active',
          cites: 0,
          days: Number.parseInt(cells[2] ?? '0', 10) || 0,
          lastReinforced: cells[3] ?? '',
          ageDays: Number.parseInt(cells[4] ?? '0', 10) || 0,
        }
        if (section === 'active') index.activeTopics.push(entry)
        else index.archivedTopics.push(entry)
      }
    } else if (section === 'historical') {
      if (trimmed.startsWith('- ')) {
        index.historicalObservations.push(trimmed.slice(2))
      }
    }
  }

  return index
}

export function renderMemoryIndex(
  activeShards: TopicShard[],
  archivedShards: TopicShard[],
  historicalObservations: string[],
): string {
  const lines = ['# Memory Index', '']

  if (activeShards.length > 0) {
    lines.push('## Active topics (auto-loaded)', '')
    lines.push(ACTIVE_TABLE_HEADER)
    lines.push(TABLE_SEPARATOR)
    for (const shard of activeShards) {
      const days = new Set(shard.citations.map((c) => c.date)).size
      const last = shard.citations[shard.citations.length - 1]?.date ?? ''
      lines.push(`| ${shard.heading} | topics/active/${shard.heading}.md | ${days} | ${last} | 0 |`)
    }
    lines.push('')
  }

  if (archivedShards.length > 0) {
    lines.push('## Archived topics (retrievable on demand)', '')
    lines.push(ACTIVE_TABLE_HEADER)
    lines.push(TABLE_SEPARATOR)
    for (const shard of archivedShards) {
      const days = new Set(shard.citations.map((c) => c.date)).size
      const last = shard.citations[shard.citations.length - 1]?.date ?? ''
      lines.push(`| ${shard.heading} | topics/archive/${shard.heading}.md | ${days} | ${last} | 0 |`)
    }
    lines.push('')
  }

  if (historicalObservations.length > 0) {
    lines.push('## Historical observations', '')
    for (const obs of historicalObservations) {
      lines.push(`- ${obs}`)
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd() + '\n'
}

export async function readMemoryIndex(agentDir: string): Promise<MemoryIndex | null> {
  const path = memoryIndexPath(agentDir)
  try {
    const text = await readFile(path, 'utf8')
    return parseMemoryIndex(text)
  } catch {
    return null
  }
}

export async function writeMemoryIndex(agentDir: string, index: MemoryIndex): Promise<void> {
  const path = memoryIndexPath(agentDir)
  await writeFile(path, renderMemoryIndexFromEntries(index), 'utf8')
}

function renderMemoryIndexFromEntries(index: MemoryIndex): string {
  const lines = ['# Memory Index', '']

  if (index.activeTopics.length > 0) {
    lines.push('## Active topics (auto-loaded)', '')
    lines.push(ACTIVE_TABLE_HEADER)
    lines.push(TABLE_SEPARATOR)
    for (const entry of index.activeTopics) {
      lines.push(`| ${entry.heading} | ${entry.file} | ${entry.days} | ${entry.lastReinforced} | ${entry.ageDays} |`)
    }
    lines.push('')
  }

  if (index.archivedTopics.length > 0) {
    lines.push('## Archived topics (retrievable on demand)', '')
    lines.push(ACTIVE_TABLE_HEADER)
    lines.push(TABLE_SEPARATOR)
    for (const entry of index.archivedTopics) {
      lines.push(`| ${entry.heading} | ${entry.file} | ${entry.days} | ${entry.lastReinforced} | ${entry.ageDays} |`)
    }
    lines.push('')
  }

  if (index.historicalObservations.length > 0) {
    lines.push('## Historical observations', '')
    for (const obs of index.historicalObservations) {
      lines.push(`- ${obs}`)
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd() + '\n'
}
