import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type {
  DiscordFile,
  DiscordGatewayEmbed,
  DiscordGatewayStickerItem,
  DiscordUser,
} from 'agent-messenger/discordbot'

import { describeError } from '../describe-error'

const FILE_VERSION = 1
export const DISCORD_BACKFILL_MAX_MESSAGES = 50
export const DISCORD_BACKFILL_MAX_AGE_MS = 30 * 60 * 1_000
export const DISCORD_BACKFILL_REQUEST_TIMEOUT_MS = 10_000
const RECENT_MESSAGE_IDS_PER_CHANNEL = DISCORD_BACKFILL_MAX_MESSAGES * 4

export type DiscordBotRecoveryCursor = {
  channelId: string
  workspace: string
  messageId: string
  processedAt: number
}

export type DiscordBackfillMessage = {
  id: string
  channel_id: string
  guild_id?: string
  type?: number
  author: { id: string; username: string; global_name?: string | null; bot?: boolean }
  content: string
  timestamp: string
  mentions?: DiscordUser[]
  mention_everyone?: boolean
  mention_roles?: string[]
  message_reference?: { message_id?: string; channel_id?: string; guild_id?: string }
  attachments?: DiscordFile[]
  embeds?: DiscordGatewayEmbed[]
  sticker_items?: DiscordGatewayStickerItem[]
}

type RecoveryFileV1 = {
  version: 1
  disconnectedAt: number | null
  cursors: DiscordBotRecoveryCursor[]
  replayCursors: DiscordBotRecoveryCursor[]
  recentMessageIds: Array<{ channelId: string; messageIds: string[] }>
}

export type DiscordBotRecoveryStore = {
  listCursors: () => DiscordBotRecoveryCursor[]
  listReplayCursors: () => DiscordBotRecoveryCursor[]
  disconnectedAt: () => number | null
  isProcessed: (channelId: string, messageId: string) => boolean
  isReplayProcessed: (channelId: string, messageId: string) => boolean
  markProcessed: (cursor: DiscordBotRecoveryCursor) => Promise<void>
  markDisconnected: (at: number) => Promise<void>
  completeReplay: (channelId: string) => Promise<void>
}

export type DiscordBotRecoveryLogger = {
  warn: (message: string) => void
  error: (message: string) => void
}

const consoleLogger: DiscordBotRecoveryLogger = {
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
}

export function discordBotRecoveryPath(agentDir: string): string {
  return join(agentDir, 'channels', 'discord-bot-recovery.json')
}

export async function loadDiscordBotRecoveryStore(
  agentDir: string,
  logger: DiscordBotRecoveryLogger = consoleLogger,
): Promise<DiscordBotRecoveryStore> {
  const path = discordBotRecoveryPath(agentDir)
  const state = await readRecoveryState(path, logger)
  return createRecoveryStore(state, async (file) => {
    const directory = dirname(path)
    await mkdir(directory, { recursive: true })
    const directoryStat = await lstat(directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error(`Discord recovery directory is not a real directory: ${directory}`)
    }
    const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
    const temporary = await open(temporaryPath, 'wx', 0o600)
    try {
      await temporary.writeFile(`${JSON.stringify(file, null, 2)}\n`, 'utf8')
      await temporary.close()
      await rename(temporaryPath, path)
    } finally {
      await temporary.close().catch(() => {})
      await rm(temporaryPath, { force: true }).catch(() => {})
    }
  })
}

export function createInMemoryDiscordBotRecoveryStore(): DiscordBotRecoveryStore {
  return createRecoveryStore(
    { version: FILE_VERSION, disconnectedAt: null, cursors: [], replayCursors: [], recentMessageIds: [] },
    async () => {},
  )
}

function createRecoveryStore(
  initial: RecoveryFileV1,
  persist: (state: RecoveryFileV1) => Promise<void>,
): DiscordBotRecoveryStore {
  const cursors = new Map(initial.cursors.map((cursor) => [cursor.channelId, cursor]))
  const replayCursors = new Map(initial.replayCursors.map((cursor) => [cursor.channelId, cursor]))
  const recentMessageIds = new Map(
    initial.recentMessageIds.map((entry) => [entry.channelId, new Set(entry.messageIds)]),
  )
  let disconnectedAt = initial.disconnectedAt
  let writeBarrier = Promise.resolve()

  const mutate = async (operation: () => boolean): Promise<void> => {
    const write = writeBarrier.then(async () => {
      if (!operation()) return
      await persist({
        version: FILE_VERSION,
        disconnectedAt,
        cursors: Array.from(cursors.values()),
        replayCursors: Array.from(replayCursors.values()),
        recentMessageIds: Array.from(recentMessageIds, ([channelId, messageIds]) => ({
          channelId,
          messageIds: Array.from(messageIds),
        })),
      })
    })
    writeBarrier = write.catch(() => {})
    await write
  }

  return {
    listCursors: () => Array.from(cursors.values()),
    listReplayCursors: () => Array.from(replayCursors.values()),
    disconnectedAt: () => disconnectedAt,
    isProcessed: (channelId, messageId) => {
      const cursor = cursors.get(channelId)
      return cursor !== undefined && compareSnowflakes(messageId, cursor.messageId) <= 0
    },
    isReplayProcessed: (channelId, messageId) => {
      const anchor = replayCursors.get(channelId)
      return (
        (anchor !== undefined && compareSnowflakes(messageId, anchor.messageId) <= 0) ||
        recentMessageIds.get(channelId)?.has(messageId) === true
      )
    },
    markProcessed: async (cursor) => {
      await mutate(() => {
        const current = cursors.get(cursor.channelId)
        let changed = false
        if (current === undefined || compareSnowflakes(cursor.messageId, current.messageId) > 0) {
          cursors.set(cursor.channelId, cursor)
          changed = true
        }
        const recent = recentMessageIds.get(cursor.channelId) ?? new Set<string>()
        if (!recent.has(cursor.messageId)) {
          recent.add(cursor.messageId)
          while (recent.size > RECENT_MESSAGE_IDS_PER_CHANNEL) {
            const oldest = recent.values().next().value
            if (oldest === undefined) break
            recent.delete(oldest)
          }
          recentMessageIds.set(cursor.channelId, recent)
          changed = true
        }
        return changed
      })
    },
    markDisconnected: async (at) => {
      await mutate(() => {
        let changed = false
        if (disconnectedAt === null) {
          disconnectedAt = at
          replayCursors.clear()
          changed = true
        }
        for (const [channelId, cursor] of cursors) {
          if (replayCursors.has(channelId)) continue
          replayCursors.set(channelId, cursor)
          changed = true
        }
        return changed
      })
    },
    completeReplay: async (channelId) => {
      await mutate(() => {
        if (!replayCursors.delete(channelId)) return false
        if (replayCursors.size === 0) disconnectedAt = null
        return true
      })
    },
  }
}

export type DiscordBackfillResult =
  | {
      ok: true
      outcome: 'succeeded' | 'capped'
      messages: DiscordBackfillMessage[]
      skipped: number
      skippedByAge: number
      skippedByCount: number
      moreMayExist: boolean
    }
  | { ok: false; outcome: 'unavailable'; error: string }

export async function fetchDiscordBackfill(args: {
  channelId: string
  workspace: string
  after: string
  token: string
  fetchImpl: typeof fetch
  now: number
}): Promise<DiscordBackfillResult> {
  const workspace = await fetchDiscordChannelWorkspace(args)
  if (!workspace.ok) return workspace
  if (workspace.workspace !== args.workspace) {
    return { ok: false, outcome: 'unavailable', error: 'channel workspace mismatch' }
  }

  const limit = DISCORD_BACKFILL_MAX_MESSAGES + 1
  const params = new URLSearchParams({ after: args.after, limit: String(limit) })
  let response: Response
  try {
    response = await args.fetchImpl(`https://discord.com/api/v10/channels/${args.channelId}/messages?${params}`, {
      method: 'GET',
      headers: { Authorization: `Bot ${args.token}` },
      signal: AbortSignal.timeout(DISCORD_BACKFILL_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, outcome: 'unavailable', error: describeError(error) }
  }
  if (!response.ok) return { ok: false, outcome: 'unavailable', error: `http ${response.status}` }

  let raw: DiscordBackfillMessage[]
  try {
    const parsed: unknown = await response.json()
    if (!Array.isArray(parsed) || !parsed.every(isBackfillMessage)) {
      return { ok: false, outcome: 'unavailable', error: 'invalid message history response' }
    }
    if (parsed.some((message) => message.channel_id !== args.channelId)) {
      return { ok: false, outcome: 'unavailable', error: 'message history channel mismatch' }
    }
    raw = parsed
  } catch (error) {
    return { ok: false, outcome: 'unavailable', error: `parse failed: ${describeError(error)}` }
  }

  const cutoff = args.now - DISCORD_BACKFILL_MAX_AGE_MS
  const recent = raw.filter((message) => {
    const timestamp = Date.parse(message.timestamp)
    return Number.isFinite(timestamp) && timestamp >= cutoff
  })
  const selected = recent
    .sort((left, right) => compareSnowflakes(left.id, right.id))
    .slice(-DISCORD_BACKFILL_MAX_MESSAGES)
  const skippedByAge = raw.length - recent.length
  const skippedByCount = recent.length - selected.length
  const skipped = skippedByAge + skippedByCount
  const moreMayExist = raw.length === limit
  const outcome = skipped > 0 || moreMayExist ? 'capped' : 'succeeded'
  return { ok: true, outcome, messages: selected, skipped, skippedByAge, skippedByCount, moreMayExist }
}

async function fetchDiscordChannelWorkspace(args: {
  channelId: string
  token: string
  fetchImpl: typeof fetch
}): Promise<{ ok: true; workspace: string } | { ok: false; outcome: 'unavailable'; error: string }> {
  let response: Response
  try {
    response = await args.fetchImpl(`https://discord.com/api/v10/channels/${args.channelId}`, {
      method: 'GET',
      headers: { Authorization: `Bot ${args.token}` },
      signal: AbortSignal.timeout(DISCORD_BACKFILL_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, outcome: 'unavailable', error: `channel lookup failed: ${describeError(error)}` }
  }
  if (!response.ok) return { ok: false, outcome: 'unavailable', error: `channel lookup http ${response.status}` }
  try {
    const parsed: unknown = await response.json()
    if (!isObject(parsed) || typeof parsed.id !== 'string' || parsed.id !== args.channelId) {
      return { ok: false, outcome: 'unavailable', error: 'invalid channel lookup response' }
    }
    if (parsed.guild_id !== undefined && typeof parsed.guild_id !== 'string') {
      return { ok: false, outcome: 'unavailable', error: 'invalid channel workspace response' }
    }
    return { ok: true, workspace: parsed.guild_id ?? '@dm' }
  } catch (error) {
    return { ok: false, outcome: 'unavailable', error: `channel lookup parse failed: ${describeError(error)}` }
  }
}

function compareSnowflakes(left: string, right: string): number {
  try {
    const leftId = BigInt(left)
    const rightId = BigInt(right)
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
  } catch {
    return left.localeCompare(right)
  }
}

async function readRecoveryState(path: string, logger: DiscordBotRecoveryLogger): Promise<RecoveryFileV1> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return emptyRecoveryFile()
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecoveryFile(parsed)) {
      logger.warn(`[discord-bot] recovery state at ${path} is invalid; starting fresh`)
      return emptyRecoveryFile()
    }
    return parsed
  } catch (error) {
    logger.error(`[discord-bot] recovery state at ${path} is corrupted: ${describeError(error)}; starting fresh`)
    return emptyRecoveryFile()
  }
}

function isRecoveryFile(value: unknown): value is RecoveryFileV1 {
  if (
    !isObject(value) ||
    value.version !== FILE_VERSION ||
    !Array.isArray(value.cursors) ||
    !Array.isArray(value.replayCursors) ||
    !Array.isArray(value.recentMessageIds)
  )
    return false
  if (value.disconnectedAt !== null && typeof value.disconnectedAt !== 'number') return false
  return (
    value.cursors.every(isCursor) &&
    value.replayCursors.every(isCursor) &&
    value.recentMessageIds.every(isRecentMessageIds)
  )
}

function emptyRecoveryFile(): RecoveryFileV1 {
  return { version: FILE_VERSION, disconnectedAt: null, cursors: [], replayCursors: [], recentMessageIds: [] }
}

function isRecentMessageIds(value: unknown): value is RecoveryFileV1['recentMessageIds'][number] {
  return (
    isObject(value) &&
    typeof value.channelId === 'string' &&
    Array.isArray(value.messageIds) &&
    value.messageIds.every((messageId) => typeof messageId === 'string')
  )
}

function isCursor(value: unknown): value is DiscordBotRecoveryCursor {
  return (
    isObject(value) &&
    typeof value.channelId === 'string' &&
    typeof value.workspace === 'string' &&
    typeof value.messageId === 'string' &&
    typeof value.processedAt === 'number'
  )
}

function isBackfillMessage(value: unknown): value is DiscordBackfillMessage {
  if (!isObject(value) || !isObject(value.author)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.channel_id === 'string' &&
    typeof value.author.id === 'string' &&
    typeof value.author.username === 'string' &&
    typeof value.content === 'string' &&
    typeof value.timestamp === 'string'
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
