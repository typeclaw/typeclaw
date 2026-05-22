import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseCitations, type Citation } from './citations'
import { type MemoryIndex, type TopicEntry } from './memory-index'
import { activeTopicsDir, archiveTopicsDir, memoryIndexPath } from './memory-paths'
import { renderTopicShard, type TopicShard } from './topic-shard'

const H2_HEADING = /^##\s+(.*)$/
const FRAGMENTS_BLOCK = /^fragments:/

export async function migrateMonolithicMemory(agentDir: string): Promise<boolean> {
  const memoryPath = join(agentDir, 'MEMORY.md')
  const indexPath = memoryIndexPath(agentDir)

  if (existsSync(indexPath)) return false
  if (!existsSync(memoryPath)) return false

  const raw = await readFile(memoryPath, 'utf8')
  const lines = raw.split('\n')

  const activeShards: TopicShard[] = []
  const archivedShards: TopicShard[] = []
  const historicalObservations: string[] = []

  let currentHeading = ''
  let currentBody: string[] = []

  function flushTopic() {
    if (!currentHeading) return
    const bodyText = currentBody.join('\n').trimEnd()
    const grouped = parseCitations(bodyText)
    const citations: Citation[] = []
    for (const [date, ids] of grouped) {
      for (const fragmentId of ids) citations.push({ date, fragmentId })
    }

    const shard: TopicShard = { heading: currentHeading, body: bodyText, citations }

    if (currentHeading === 'Historical observations') {
      for (const line of currentBody) {
        const trimmed = line.trim()
        if (trimmed.startsWith('- ')) {
          historicalObservations.push(trimmed.slice(2))
        }
      }
    } else if (citations.length >= 3 && new Set(citations.map((c) => c.date)).size >= 2) {
      activeShards.push(shard)
    } else {
      archivedShards.push(shard)
    }

    currentHeading = ''
    currentBody = []
  }

  for (const line of lines) {
    const h2Match = H2_HEADING.exec(line)
    if (h2Match) {
      flushTopic()
      currentHeading = (h2Match[1] ?? '').trim()
      continue
    }
    if (FRAGMENTS_BLOCK.test(line)) {
      continue
    }
    if (currentHeading) {
      currentBody.push(line)
    }
  }
  flushTopic()

  const activeDir = activeTopicsDir(agentDir)
  const archiveDir = archiveTopicsDir(agentDir)
  await mkdir(activeDir, { recursive: true })
  await mkdir(archiveDir, { recursive: true })

  for (const shard of activeShards) {
    const slug = slugify(shard.heading)
    await writeFile(join(activeDir, `${slug}.md`), renderTopicShard(shard), 'utf8')
  }

  for (const shard of archivedShards) {
    const slug = slugify(shard.heading)
    await writeFile(join(archiveDir, `${slug}.md`), renderTopicShard(shard), 'utf8')
  }

  const index: MemoryIndex = {
    activeTopics: activeShards.map((s) => topicToEntry(s, true)),
    archivedTopics: archivedShards.map((s) => topicToEntry(s, false)),
    historicalObservations,
  }

  await writeFile(indexPath, renderMemoryIndexFromEntries(index), 'utf8')
  return true
}

function topicToEntry(shard: TopicShard, active: boolean): TopicEntry {
  const days = new Set(shard.citations.map((c) => c.date)).size
  const last = shard.citations[shard.citations.length - 1]?.date ?? ''
  return {
    heading: shard.heading,
    slug: slugify(shard.heading),
    file: active ? `topics/active/${slugify(shard.heading)}.md` : `topics/archive/${slugify(shard.heading)}.md`,
    active,
    cites: shard.citations.length,
    days,
    lastReinforced: last,
    ageDays: 0,
  }
}

function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function renderMemoryIndexFromEntries(index: MemoryIndex): string {
  const lines = ['# Memory Index', '']

  if (index.activeTopics.length > 0) {
    lines.push('## Active topics (auto-loaded)', '')
    lines.push('| Topic | File | Days | Last | Age |')
    lines.push('|-------|------|------|------|-----|')
    for (const entry of index.activeTopics) {
      lines.push(`| ${entry.heading} | ${entry.file} | ${entry.days} | ${entry.lastReinforced} | ${entry.ageDays} |`)
    }
    lines.push('')
  }

  if (index.archivedTopics.length > 0) {
    lines.push('## Archived topics (retrievable on demand)', '')
    lines.push('| Topic | File | Days | Last | Age |')
    lines.push('|-------|------|------|------|-----|')
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
