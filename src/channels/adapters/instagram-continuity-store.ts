import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { describeError } from '../describe-error'

const FILE_VERSION = 1
const MAX_MESSAGE_IDS_PER_THREAD = 500

type ThreadState = {
  accountId: string
  threadId: string
  messageIds: string[]
}

type FileV1 = {
  version: 1
  threads: ThreadState[]
}

export type InstagramContinuityLogger = {
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type InstagramContinuityStore = {
  knowsThread: (accountId: string, threadId: string) => boolean
  hasMessage: (accountId: string, threadId: string, messageId: string) => boolean
  seedThread: (accountId: string, threadId: string, messageIds: readonly string[]) => Promise<void>
  markMessage: (accountId: string, threadId: string, messageId: string) => Promise<void>
}

export function instagramContinuityPath(agentDir: string): string {
  return join(agentDir, 'channels', 'instagram-continuity.json')
}

export async function loadInstagramContinuityStore(
  agentDir: string,
  logger: InstagramContinuityLogger,
): Promise<InstagramContinuityStore> {
  const path = instagramContinuityPath(agentDir)
  const threads = new Map<string, string[]>()
  for (const state of await readStates(path, logger)) {
    threads.set(threadKey(state.accountId, state.threadId), state.messageIds.slice(-MAX_MESSAGE_IDS_PER_THREAD))
  }

  const flush = async (): Promise<void> => {
    const states: ThreadState[] = []
    for (const [key, messageIds] of threads) {
      const [accountId, threadId] = parseThreadKey(key)
      states.push({ accountId, threadId, messageIds })
    }
    const payload: FileV1 = { version: FILE_VERSION, threads: states }
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  }

  const saveIds = async (accountId: string, threadId: string, messageIds: readonly string[]): Promise<void> => {
    const key = threadKey(accountId, threadId)
    const previous = threads.get(key)
    const next = Array.from(new Set(messageIds)).slice(-MAX_MESSAGE_IDS_PER_THREAD)
    threads.set(key, next)
    try {
      await flush()
    } catch (err) {
      if (previous === undefined) threads.delete(key)
      else threads.set(key, previous)
      throw err
    }
  }

  return {
    knowsThread(accountId, threadId): boolean {
      return threads.has(threadKey(accountId, threadId))
    },
    hasMessage(accountId, threadId, messageId): boolean {
      return threads.get(threadKey(accountId, threadId))?.includes(messageId) ?? false
    },
    async seedThread(accountId, threadId, messageIds): Promise<void> {
      await saveIds(accountId, threadId, messageIds)
    },
    async markMessage(accountId, threadId, messageId): Promise<void> {
      const current = threads.get(threadKey(accountId, threadId)) ?? []
      if (current.includes(messageId)) return
      await saveIds(accountId, threadId, [...current, messageId])
    },
  }
}

function threadKey(accountId: string, threadId: string): string {
  return `${accountId}\u0000${threadId}`
}

function parseThreadKey(key: string): [string, string] {
  const separator = key.indexOf('\u0000')
  return [key.slice(0, separator), key.slice(separator + 1)]
}

async function readStates(path: string, logger: InstagramContinuityLogger): Promise<ThreadState[]> {
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
    logger.error(`[instagram] ${path} corrupted: ${describeError(err)}; starting fresh`)
    return []
  }
  if (!isObject(parsed)) {
    logger.warn(`[instagram] ${path} not an object; ignored`)
    return []
  }
  if (parsed.version !== FILE_VERSION) {
    logger.warn(
      `[instagram] ${path} version ${String(parsed.version)} not supported (expected ${FILE_VERSION}); ignored`,
    )
    return []
  }
  if (!Array.isArray(parsed.threads)) return []
  return parsed.threads.filter(isThreadState)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isThreadState(value: unknown): value is ThreadState {
  if (!isObject(value)) return false
  return (
    typeof value.accountId === 'string' &&
    typeof value.threadId === 'string' &&
    Array.isArray(value.messageIds) &&
    value.messageIds.every((id) => typeof id === 'string')
  )
}
