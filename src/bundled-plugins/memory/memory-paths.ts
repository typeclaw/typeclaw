import { join } from 'node:path'

import { formatLocalDate } from '@/shared'

export function memoryDir(agentDir: string): string {
  return join(agentDir, 'memory')
}

export function streamsDir(agentDir: string): string {
  return join(memoryDir(agentDir), 'streams')
}

export function topicsDir(agentDir: string): string {
  return join(memoryDir(agentDir), 'topics')
}

export function activeTopicsDir(agentDir: string): string {
  return join(topicsDir(agentDir), 'active')
}

export function archiveTopicsDir(agentDir: string): string {
  return join(topicsDir(agentDir), 'archive')
}

export function skillsDir(agentDir: string): string {
  return join(memoryDir(agentDir), 'skills')
}

export function dailyStreamPath(agentDir: string, date?: string): string {
  const d = date ?? formatLocalDate()
  return join(streamsDir(agentDir), `${d}.jsonl`)
}

export function memoryIndexPath(agentDir: string): string {
  return join(memoryDir(agentDir), 'index.md')
}

export function topicShardPath(agentDir: string, slug: string, active: boolean): string {
  const dir = active ? activeTopicsDir(agentDir) : archiveTopicsDir(agentDir)
  return join(dir, `${slug}.md`)
}

export const STREAM_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/

export const CITATION_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function formatCitation(date: string, fragmentId: string): string {
  return `streams/${date}#${fragmentId}`
}
