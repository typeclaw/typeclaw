import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ChannelParticipant } from '@/agent/session-origin'

import { toRef } from './adapters/webex-id-ref'
import { describeError } from './describe-error'
import type { AdapterId } from './schema'
import type { ChannelKey, GithubReviewFollowupRound } from './types'

const FILE_VERSION = 6

// `sessionFile` is the basename (not the full path) of the JSONL transcript
// for this (adapter, workspace, chat, thread) tuple. pi-coding-agent writes
// session files as `${ISO_TIMESTAMP}_${UUID}.jsonl`, where the UUID matches
// `sessionId` but the timestamp prefix only exists at write time. Without
// the basename persisted, reopen attempts can only guess the path from the
// UUID, which never matches on disk — every restart silently creates a
// fresh session and the channel loses its transcript memory.
//
// `sessionFile` is optional because a session can exist in memory before a
// transcript path is known; reopen falls back to a fresh session when absent.
export type ChannelSessionRecord = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
  sessionId?: string
  sessionFile?: string
  lastInboundAt?: number
  participants: ChannelParticipant[]
  githubReviewRound?: GithubReviewFollowupRound & {
    status: 'pending' | 'completed'
    attemptedCarriers: (string | null)[]
    dismissalAttempted?: true
  }
}

type FileV4 = {
  version: 4
  sessions: ChannelSessionRecord[]
}

type FileV5 = {
  version: 5
  sessions: ChannelSessionRecord[]
}

type FileV6 = {
  version: 6
  sessions: ChannelSessionRecord[]
}

export type ChannelSessionsLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: ChannelSessionsLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export function channelsSessionsPath(agentDir: string): string {
  return join(agentDir, 'channels', 'sessions.json')
}

export async function loadChannelSessions(
  agentDir: string,
  logger: ChannelSessionsLogger = consoleLogger,
): Promise<ChannelSessionRecord[]> {
  const path = channelsSessionsPath(agentDir)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    logger.error(`[channels] ${path} corrupted: ${describeError(err)}; starting fresh`)
    return []
  }
  if (!isObject(parsed)) {
    logger.warn(`[channels] ${path} not an object; ignored`)
    return []
  }
  const version = (parsed as { version?: unknown }).version
  if (version === FILE_VERSION) {
    const file = parsed as FileV6
    if (!Array.isArray(file.sessions)) return []
    return dedupe(file.sessions.filter(isValidRecord))
  }
  if (version === 5) {
    const file = parsed as FileV5
    if (!Array.isArray(file.sessions)) return []
    return dedupe(file.sessions.filter(isValidRecord))
  }
  if (version === 4) {
    const file = parsed as FileV4
    if (!Array.isArray(file.sessions)) return []
    return dedupeNewest(file.sessions.filter(isValidRecord).map(migrateV4Record))
  }
  logger.warn(`[channels] ${path} version ${String(version)} not supported (expected ${FILE_VERSION}); ignored`)
  return []
}

export async function saveChannelSessions(
  agentDir: string,
  sessions: readonly ChannelSessionRecord[],
  logger: ChannelSessionsLogger = consoleLogger,
): Promise<void> {
  const path = channelsSessionsPath(agentDir)
  const payload: FileV6 = { version: FILE_VERSION, sessions: dedupe(sessions) }
  try {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    const { rename } = await import('node:fs/promises')
    await rename(tmp, path)
  } catch (err) {
    logger.error(`[channels] failed to persist sessions: ${describeError(err)}`)
  }
}

function dedupe(sessions: readonly ChannelSessionRecord[]): ChannelSessionRecord[] {
  const seen = new Map<string, ChannelSessionRecord>()
  for (const s of sessions) {
    seen.set(recordKey(s), s)
  }
  return Array.from(seen.values())
}

function dedupeNewest(sessions: readonly ChannelSessionRecord[]): ChannelSessionRecord[] {
  const seen = new Map<string, ChannelSessionRecord>()
  for (const s of sessions) {
    const key = recordKey(s)
    const existing = seen.get(key)
    if (existing === undefined || shouldReplaceRecord(existing, s)) seen.set(key, s)
  }
  return Array.from(seen.values())
}

export function findRecord(
  sessions: readonly ChannelSessionRecord[],
  key: ChannelKey,
): ChannelSessionRecord | undefined {
  const exact = sessions.find(
    (s) =>
      s.adapter === key.adapter &&
      s.workspace === key.workspace &&
      s.chat === key.chat &&
      (s.thread ?? null) === (key.thread ?? null),
  )
  if (exact !== undefined) return exact

  // Compat insurance for legacy Webex records that may still be held in memory
  // or loaded from hand-written/session-origin data with blob-form room ids.
  if (!isWebexAdapter(key.adapter)) return undefined
  return sessions.find(
    (s) =>
      s.adapter === key.adapter &&
      toRef(s.workspace) === toRef(key.workspace) &&
      toRef(s.chat) === toRef(key.chat) &&
      (s.thread ?? null) === (key.thread ?? null),
  )
}

function migrateV4Record(record: ChannelSessionRecord): ChannelSessionRecord {
  if (!isWebexAdapter(record.adapter)) return record
  return {
    ...record,
    workspace: toRef(record.workspace),
    chat: toRef(record.chat),
    thread: record.thread === null ? null : toRef(record.thread),
  }
}

function recordKey(record: ChannelSessionRecord): string {
  return `${record.adapter}:${record.workspace}:${record.chat}:${record.thread ?? ''}`
}

function shouldReplaceRecord(existing: ChannelSessionRecord, next: ChannelSessionRecord): boolean {
  const existingAt = existing.lastInboundAt ?? Number.NEGATIVE_INFINITY
  const nextAt = next.lastInboundAt ?? Number.NEGATIVE_INFINITY
  if (nextAt !== existingAt) return nextAt > existingAt
  return !hasSessionPointer(existing) && hasSessionPointer(next)
}

function hasSessionPointer(record: ChannelSessionRecord): boolean {
  return record.sessionId !== undefined || record.sessionFile !== undefined
}

function isWebexAdapter(adapter: AdapterId): boolean {
  return adapter === 'webex' || adapter === 'webex-bot'
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isValidRecord(v: unknown): v is ChannelSessionRecord {
  if (!isObject(v)) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.adapter === 'string' &&
    typeof r.workspace === 'string' &&
    typeof r.chat === 'string' &&
    (r.thread === null || typeof r.thread === 'string') &&
    (r.sessionId === undefined || typeof r.sessionId === 'string') &&
    (r.sessionFile === undefined || typeof r.sessionFile === 'string') &&
    (r.lastInboundAt === undefined || typeof r.lastInboundAt === 'number') &&
    Array.isArray(r.participants) &&
    (r.githubReviewRound === undefined || isValidGithubReviewRound(r.githubReviewRound, r))
  )
}

function isValidGithubReviewRound(value: unknown, record: Record<string, unknown>): boolean {
  if (!isObject(value)) return false
  return (
    (value.status === 'pending' || value.status === 'completed') &&
    record.adapter === 'github' &&
    typeof value.workspace === 'string' &&
    value.workspace === record.workspace &&
    typeof value.prNumber === 'number' &&
    Number.isInteger(value.prNumber) &&
    value.prNumber > 0 &&
    record.chat === `pr:${value.prNumber}` &&
    typeof value.headSha === 'string' &&
    value.headSha.length > 0 &&
    (value.carrierThread === null || typeof value.carrierThread === 'string') &&
    Array.isArray(value.attemptedCarriers) &&
    value.attemptedCarriers.length > 0 &&
    value.attemptedCarriers.every((thread) => thread === null || typeof thread === 'string') &&
    value.attemptedCarriers.some((thread) => thread === value.carrierThread) &&
    (value.dismissalAttempted === undefined || value.dismissalAttempted === true)
  )
}
