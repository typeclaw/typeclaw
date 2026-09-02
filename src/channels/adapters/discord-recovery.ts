import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { DiscordChannel, DiscordClient, DiscordMessage } from 'agent-messenger/discord'
import lockfile from 'proper-lockfile'

import { describeError } from '../describe-error'

const FILE_VERSION = 1
export const DISCORD_RECOVERY_MAX_FILE_BYTES = 1024 * 1024
export const DISCORD_RECOVERY_MAX_ACCOUNTS = 32
export const DISCORD_RECOVERY_MAX_CHANNELS_PER_ACCOUNT = 1_024
export const DISCORD_RECOVERY_MAX_MESSAGES = 50
export const DISCORD_RECOVERY_MAX_AGE_MS = 30 * 60 * 1_000
export const DISCORD_RECOVERY_REQUEST_TIMEOUT_MS = 10_000
export const DISCORD_RECOVERY_MAX_RECENT_IDS_PER_CHANNEL = DISCORD_RECOVERY_MAX_MESSAGES * 4

export type DiscordRecoveryCursor = {
  channelId: string
  workspace: string
  messageId: string
  processedAt: number
}

type AccountRecoveryState = {
  accountId: string
  recoveryEpoch: number
  disconnectedAt: number | null
  cursors: DiscordRecoveryCursor[]
  replayCursors: DiscordRecoveryCursor[]
  recentMessageIds: Array<{ channelId: string; messageIds: string[] }>
}

type RecoveryFileV1 = {
  version: 1
  accounts: AccountRecoveryState[]
}

export type DiscordRecoveryStore = {
  listCursors: () => DiscordRecoveryCursor[]
  listReplayCursors: () => DiscordRecoveryCursor[]
  disconnectedAt: () => number | null
  currentEpoch: () => number
  isProcessed: (channelId: string, messageId: string) => boolean
  isReplayProcessed: (channelId: string, messageId: string) => boolean
  markProcessed: (cursor: DiscordRecoveryCursor) => Promise<void>
  markRouteFailed: (failure: {
    channelId: string
    workspace: string
    failedMessageId: string
    failedAt: number
  }) => Promise<void>
  markDisconnected: (at: number) => Promise<void>
  completeReplay: (channelId: string, expectedEpoch: number) => Promise<void>
}

export type DiscordRecoveryLogger = {
  warn: (message: string) => void
  error: (message: string) => void
}

const consoleLogger: DiscordRecoveryLogger = {
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
}

export function discordRecoveryPath(agentDir: string): string {
  return join(agentDir, 'channels', 'discord-recovery.json')
}

export async function loadDiscordRecoveryStore(
  agentDir: string,
  accountId: string,
  logger: DiscordRecoveryLogger = consoleLogger,
): Promise<DiscordRecoveryStore> {
  const path = discordRecoveryPath(agentDir)
  assertDiscordSnowflake(accountId, 'account id')
  const file = await readRecoveryFile(path, logger)
  return createRecoveryStore(accountFromFile(file, accountId), async (operation) => {
    const directory = dirname(path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await assertRealDirectory(directory)
    const release = await lockfile.lock(path, {
      realpath: false,
      stale: 10_000,
      update: 2_000,
      retries: { retries: 5, minTimeout: 5, maxTimeout: 50 },
    })
    try {
      const latest = await readRecoveryFile(path, logger)
      const nextAccount = cloneAccount(accountFromFile(latest, accountId))
      if (!operation(nextAccount)) return nextAccount
      const otherAccounts = latest.accounts.filter((entry) => entry.accountId !== accountId)
      const merged: RecoveryFileV1 = {
        version: FILE_VERSION,
        accounts: [...otherAccounts.slice(-(DISCORD_RECOVERY_MAX_ACCOUNTS - 1)), nextAccount],
      }
      await writeRecoveryFile(path, merged)
      return nextAccount
    } finally {
      await release().catch(() => undefined)
    }
  })
}

export function createInMemoryDiscordRecoveryStore(accountId = '1'): DiscordRecoveryStore {
  assertDiscordSnowflake(accountId, 'account id')
  return createRecoveryStore(emptyAccount(accountId))
}

export type DiscordRecoveryResult =
  | {
      ok: true
      outcome: 'succeeded' | 'capped'
      messages: DiscordMessage[]
      skipped: number
      skippedByAge: number
      skippedByCount: number
      moreMayExist: boolean
    }
  | { ok: false; outcome: 'unavailable'; error: string }

export async function fetchDiscordRecovery(args: {
  client: Pick<DiscordClient, 'getChannel' | 'getMessages'>
  channelId: string
  workspace: string
  after: string
  now: number
  requestTimeoutMs?: number
}): Promise<DiscordRecoveryResult> {
  const inputError = validateRecoveryRequest(args.channelId, args.workspace, args.after)
  if (inputError !== null) return { ok: false, outcome: 'unavailable', error: inputError }
  const timeoutMs = args.requestTimeoutMs ?? DISCORD_RECOVERY_REQUEST_TIMEOUT_MS
  const channelResult = await settleWithin(args.client.getChannel(args.channelId), timeoutMs)
  if (channelResult.kind === 'timed-out') {
    return { ok: false, outcome: 'unavailable', error: `channel lookup timed out after ${timeoutMs}ms` }
  }
  if (channelResult.kind === 'failed') {
    return { ok: false, outcome: 'unavailable', error: `channel lookup failed: ${describeError(channelResult.error)}` }
  }
  const channel = channelResult.value as DiscordChannel & { guild_id?: string }
  if (!isDiscordSnowflake(channel.id) || channel.id !== args.channelId) {
    return { ok: false, outcome: 'unavailable', error: 'channel lookup response mismatch' }
  }
  if ((channel.guild_id ?? '@dm') !== args.workspace) {
    return { ok: false, outcome: 'unavailable', error: 'channel workspace mismatch' }
  }

  const limit = DISCORD_RECOVERY_MAX_MESSAGES + 1
  const historyResult = await settleWithin(args.client.getMessages(args.channelId, limit), timeoutMs)
  if (historyResult.kind === 'timed-out') {
    return { ok: false, outcome: 'unavailable', error: `message history timed out after ${timeoutMs}ms` }
  }
  if (historyResult.kind === 'failed') {
    return { ok: false, outcome: 'unavailable', error: describeError(historyResult.error) }
  }
  if (historyResult.value.some((message) => message.channel_id !== args.channelId)) {
    return { ok: false, outcome: 'unavailable', error: 'message history channel mismatch' }
  }
  if (historyResult.value.some((message) => !isDiscordSnowflake(message.id))) {
    return { ok: false, outcome: 'unavailable', error: 'invalid message history snowflake' }
  }

  const newer = historyResult.value.filter((message) => compareSnowflakes(message.id, args.after) > 0)
  const cutoff = args.now - DISCORD_RECOVERY_MAX_AGE_MS
  const recent = newer.filter((message) => {
    const timestamp = Date.parse(message.timestamp)
    return Number.isFinite(timestamp) && timestamp >= cutoff
  })
  const selected = recent
    .sort((left, right) => compareSnowflakes(left.id, right.id))
    .slice(-DISCORD_RECOVERY_MAX_MESSAGES)
  const skippedByAge = newer.length - recent.length
  const skippedByCount = recent.length - selected.length
  const skipped = skippedByAge + skippedByCount
  const moreMayExist =
    historyResult.value.length === limit &&
    historyResult.value.every((message) => compareSnowflakes(message.id, args.after) > 0)
  const outcome = skipped > 0 || moreMayExist ? 'capped' : 'succeeded'
  return { ok: true, outcome, messages: selected, skipped, skippedByAge, skippedByCount, moreMayExist }
}

type AccountMutation = (draft: AccountRecoveryState) => boolean

function createRecoveryStore(
  initialAccount: AccountRecoveryState,
  applyLatest?: (operation: AccountMutation) => Promise<AccountRecoveryState>,
): DiscordRecoveryStore {
  let account = initialAccount
  let writeBarrier = Promise.resolve()

  const mutate = async (operation: AccountMutation): Promise<void> => {
    const write = writeBarrier.then(async () => {
      if (applyLatest !== undefined) {
        account = await applyLatest(operation)
        return
      }
      const draft = cloneAccount(account)
      if (!operation(draft)) return
      account = draft
    })
    writeBarrier = write.catch(() => undefined)
    await write
  }

  return {
    listCursors: () => account.cursors.map((cursor) => ({ ...cursor })),
    listReplayCursors: () => account.replayCursors.map((cursor) => ({ ...cursor })),
    disconnectedAt: () => account.disconnectedAt,
    currentEpoch: () => account.recoveryEpoch,
    isProcessed: (channelId, messageId) => {
      const cursor = account.cursors.find((entry) => entry.channelId === channelId)
      const anchor = account.replayCursors.find((entry) => entry.channelId === channelId)
      const recent = account.recentMessageIds.find((entry) => entry.channelId === channelId)
      if (anchor !== undefined) {
        return compareSnowflakes(messageId, anchor.messageId) <= 0 || recent?.messageIds.includes(messageId) === true
      }
      return cursor !== undefined && compareSnowflakes(messageId, cursor.messageId) <= 0
    },
    isReplayProcessed: (channelId, messageId) => {
      const anchor = account.replayCursors.find((entry) => entry.channelId === channelId)
      const recent = account.recentMessageIds.find((entry) => entry.channelId === channelId)
      return (
        (anchor !== undefined && compareSnowflakes(messageId, anchor.messageId) <= 0) ||
        recent?.messageIds.includes(messageId) === true
      )
    },
    markProcessed: async (cursor) => {
      assertValidCursor(cursor)
      await mutate((draft) => {
        const currentIndex = draft.cursors.findIndex((entry) => entry.channelId === cursor.channelId)
        let changed = false
        if (currentIndex === -1 || compareSnowflakes(cursor.messageId, draft.cursors[currentIndex]!.messageId) > 0) {
          if (currentIndex === -1) {
            if (draft.cursors.length >= DISCORD_RECOVERY_MAX_CHANNELS_PER_ACCOUNT) evictOldestChannel(draft)
            draft.cursors.push(cursor)
          } else draft.cursors[currentIndex] = cursor
          changed = true
        }
        let recent = draft.recentMessageIds.find((entry) => entry.channelId === cursor.channelId)
        if (recent === undefined) {
          if (draft.recentMessageIds.length >= DISCORD_RECOVERY_MAX_CHANNELS_PER_ACCOUNT) {
            draft.recentMessageIds.shift()
          }
          recent = { channelId: cursor.channelId, messageIds: [] }
          draft.recentMessageIds.push(recent)
        }
        if (!recent.messageIds.includes(cursor.messageId)) {
          recent.messageIds.push(cursor.messageId)
          if (recent.messageIds.length > DISCORD_RECOVERY_MAX_RECENT_IDS_PER_CHANNEL) {
            recent.messageIds.splice(0, recent.messageIds.length - DISCORD_RECOVERY_MAX_RECENT_IDS_PER_CHANNEL)
          }
          changed = true
        }
        return changed
      })
    },
    markRouteFailed: async (failure) => {
      assertDiscordSnowflake(failure.channelId, 'channel id')
      if (!isDiscordWorkspace(failure.workspace)) throw new Error('invalid Discord workspace id')
      assertDiscordSnowflake(failure.failedMessageId, 'message id')
      if (!isFiniteNonnegative(failure.failedAt)) throw new Error('invalid Discord failure timestamp')
      await mutate((draft) => {
        draft.recoveryEpoch = nextRecoveryEpoch(draft.recoveryEpoch)
        let changed = true
        if (draft.disconnectedAt === null) {
          draft.disconnectedAt = failure.failedAt
          changed = true
        }
        if (!draft.replayCursors.some((cursor) => cursor.channelId === failure.channelId)) {
          const current = draft.cursors.find((cursor) => cursor.channelId === failure.channelId)
          const anchor =
            current !== undefined && compareSnowflakes(current.messageId, failure.failedMessageId) < 0
              ? { ...current }
              : {
                  channelId: failure.channelId,
                  workspace: failure.workspace,
                  messageId: predecessorSnowflake(failure.failedMessageId),
                  processedAt: failure.failedAt,
                }
          addReplayAnchorBounded(draft, anchor, failure.channelId)
          changed = true
        }
        for (const cursor of draft.cursors) {
          if (cursor.channelId === failure.channelId) continue
          if (draft.replayCursors.some((entry) => entry.channelId === cursor.channelId)) continue
          if (draft.replayCursors.length >= DISCORD_RECOVERY_MAX_CHANNELS_PER_ACCOUNT) continue
          draft.replayCursors.push({ ...cursor })
          changed = true
        }
        return changed
      })
    },
    markDisconnected: async (at) => {
      if (!isFiniteNonnegative(at)) throw new Error('invalid Discord disconnect timestamp')
      await mutate((draft) => {
        if (draft.cursors.length === 0 && draft.replayCursors.length === 0) return false
        draft.recoveryEpoch = nextRecoveryEpoch(draft.recoveryEpoch)
        let changed = true
        if (draft.disconnectedAt === null) {
          draft.disconnectedAt = at
          draft.replayCursors = []
          changed = true
        }
        for (const cursor of draft.cursors) {
          if (draft.replayCursors.some((entry) => entry.channelId === cursor.channelId)) continue
          if (draft.replayCursors.length >= DISCORD_RECOVERY_MAX_CHANNELS_PER_ACCOUNT) continue
          draft.replayCursors.push({ ...cursor })
          changed = true
        }
        return changed
      })
    },
    completeReplay: async (channelId, expectedEpoch) => {
      assertDiscordSnowflake(channelId, 'channel id')
      if (!isRecoveryEpoch(expectedEpoch)) throw new Error('invalid Discord recovery epoch')
      await mutate((draft) => {
        if (draft.recoveryEpoch !== expectedEpoch) return false
        const next = draft.replayCursors.filter((cursor) => cursor.channelId !== channelId)
        if (next.length === draft.replayCursors.length) return false
        draft.replayCursors = next
        if (next.length === 0) draft.disconnectedAt = null
        return true
      })
    },
  }
}

function accountFromFile(file: RecoveryFileV1, accountId: string): AccountRecoveryState {
  return file.accounts.find((account) => account.accountId === accountId) ?? emptyAccount(accountId)
}

function cloneAccount(account: AccountRecoveryState): AccountRecoveryState {
  return {
    accountId: account.accountId,
    recoveryEpoch: account.recoveryEpoch,
    disconnectedAt: account.disconnectedAt,
    cursors: account.cursors.map((cursor) => ({ ...cursor })),
    replayCursors: account.replayCursors.map((cursor) => ({ ...cursor })),
    recentMessageIds: account.recentMessageIds.map((entry) => ({
      channelId: entry.channelId,
      messageIds: [...entry.messageIds],
    })),
  }
}

function evictOldestChannel(account: AccountRecoveryState): void {
  const oldest = account.cursors.reduce((candidate, cursor) =>
    cursor.processedAt < candidate.processedAt ? cursor : candidate,
  )
  account.cursors = account.cursors.filter((cursor) => cursor.channelId !== oldest.channelId)
  account.replayCursors = account.replayCursors.filter((cursor) => cursor.channelId !== oldest.channelId)
  account.recentMessageIds = account.recentMessageIds.filter((entry) => entry.channelId !== oldest.channelId)
}

function addReplayAnchorBounded(
  account: AccountRecoveryState,
  cursor: DiscordRecoveryCursor,
  protectedChannelId: string,
): void {
  if (account.replayCursors.length >= DISCORD_RECOVERY_MAX_CHANNELS_PER_ACCOUNT) {
    const candidates = account.replayCursors.filter((entry) => entry.channelId !== protectedChannelId)
    const oldest = candidates.reduce((candidate, entry) =>
      entry.processedAt < candidate.processedAt ? entry : candidate,
    )
    account.replayCursors = account.replayCursors.filter((entry) => entry.channelId !== oldest.channelId)
  }
  account.replayCursors.push(cursor)
}

function predecessorSnowflake(messageId: string): string {
  return (BigInt(messageId) - 1n).toString()
}

function nextRecoveryEpoch(epoch: number): number {
  return epoch === Number.MAX_SAFE_INTEGER ? 0 : epoch + 1
}

async function writeRecoveryFile(path: string, file: RecoveryFileV1): Promise<void> {
  if (!isRecoveryFile(file)) throw new Error('invalid Discord recovery state')
  const serialized = `${JSON.stringify(file, null, 2)}\n`
  if (Buffer.byteLength(serialized) > DISCORD_RECOVERY_MAX_FILE_BYTES) {
    throw new Error(`Discord recovery state exceeds ${DISCORD_RECOVERY_MAX_FILE_BYTES} bytes`)
  }
  const directory = dirname(path)
  await assertRealDirectory(directory)
  await assertSafeRecoveryTarget(path)
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  const temporary = await open(temporaryPath, 'wx', 0o600)
  try {
    await temporary.writeFile(serialized, 'utf8')
    await temporary.close()
    // `channels/` is runtime-owned. Node has no dirfd-relative rename API, so
    // revalidate it and the target at the last available point before rename.
    await assertRealDirectory(directory)
    await assertSafeRecoveryTarget(path)
    await rename(temporaryPath, path)
  } finally {
    await temporary.close().catch(() => undefined)
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Discord recovery directory is not a real directory: ${path}`)
  }
}

async function assertSafeRecoveryTarget(path: string): Promise<void> {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) throw new Error(`Discord recovery target is a symbolic link: ${path}`)
    if (!stat.isFile()) throw new Error(`Discord recovery target is not a regular file: ${path}`)
  } catch (error) {
    if (isErrorWithCode(error) && error.code === 'ENOENT') return
    throw error
  }
}

function validateRecoveryRequest(channelId: string, workspace: string, after: string): string | null {
  if (!isDiscordSnowflake(channelId)) return 'invalid Discord channel id'
  if (!isDiscordWorkspace(workspace)) return 'invalid Discord workspace id'
  if (!isDiscordRecoveryAnchor(after)) return 'invalid Discord message id'
  return null
}

function assertValidCursor(cursor: DiscordRecoveryCursor): void {
  assertDiscordSnowflake(cursor.channelId, 'channel id')
  if (!isDiscordWorkspace(cursor.workspace)) throw new Error('invalid Discord workspace id')
  assertDiscordSnowflake(cursor.messageId, 'message id')
  if (!isFiniteNonnegative(cursor.processedAt)) throw new Error('invalid Discord processed timestamp')
}

function assertDiscordSnowflake(value: string, label: string): void {
  if (!isDiscordSnowflake(value)) throw new Error(`invalid Discord ${label}`)
}

const MAX_DISCORD_SNOWFLAKE = 18_446_744_073_709_551_615n

function isDiscordSnowflake(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value)) return false
  return BigInt(value) <= MAX_DISCORD_SNOWFLAKE
}

function isDiscordRecoveryAnchor(value: unknown): value is string {
  return value === '0' || isDiscordSnowflake(value)
}

function isDiscordWorkspace(value: unknown): value is string {
  return value === '@dm' || isDiscordSnowflake(value)
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRecoveryEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

async function readRecoveryFile(path: string, logger: DiscordRecoveryLogger): Promise<RecoveryFileV1> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    if (isErrorWithCode(error) && error.code === 'ENOENT') return emptyRecoveryFile()
    logger.error(`[discord] failed to read recovery state at ${path}: ${describeError(error)}; starting fresh`)
    return emptyRecoveryFile()
  }
  let raw: string
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      logger.warn(`[discord] recovery state at ${path} is not a regular file; starting fresh`)
      return emptyRecoveryFile()
    }
    if (stat.size > DISCORD_RECOVERY_MAX_FILE_BYTES) {
      logger.warn(
        `[discord] recovery state at ${path} exceeds ${DISCORD_RECOVERY_MAX_FILE_BYTES} bytes; starting fresh`,
      )
      return emptyRecoveryFile()
    }
    const contents = await readBoundedRecoveryFile(handle)
    if (contents === null) {
      logger.warn(
        `[discord] recovery state at ${path} exceeds ${DISCORD_RECOVERY_MAX_FILE_BYTES} bytes; starting fresh`,
      )
      return emptyRecoveryFile()
    }
    raw = contents.toString('utf8')
  } catch (error) {
    logger.error(`[discord] failed to read recovery state at ${path}: ${describeError(error)}; starting fresh`)
    return emptyRecoveryFile()
  } finally {
    await handle.close().catch(() => undefined)
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecoveryFile(parsed)) {
      logger.warn(`[discord] recovery state at ${path} is invalid; starting fresh`)
      return emptyRecoveryFile()
    }
    return parsed
  } catch (error) {
    logger.error(`[discord] recovery state at ${path} is corrupted: ${describeError(error)}; starting fresh`)
    return emptyRecoveryFile()
  }
}

async function readBoundedRecoveryFile(handle: Awaited<ReturnType<typeof open>>): Promise<Buffer<ArrayBuffer> | null> {
  const buffer = Buffer.alloc(DISCORD_RECOVERY_MAX_FILE_BYTES + 1)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset > DISCORD_RECOVERY_MAX_FILE_BYTES) return null
  return buffer.subarray(0, offset)
}

function emptyRecoveryFile(): RecoveryFileV1 {
  return { version: FILE_VERSION, accounts: [] }
}

function emptyAccount(accountId: string): AccountRecoveryState {
  return { accountId, recoveryEpoch: 0, disconnectedAt: null, cursors: [], replayCursors: [], recentMessageIds: [] }
}

function isRecoveryFile(value: unknown): value is RecoveryFileV1 {
  return (
    isObject(value) &&
    value.version === FILE_VERSION &&
    Array.isArray(value.accounts) &&
    value.accounts.length <= DISCORD_RECOVERY_MAX_ACCOUNTS &&
    new Set(value.accounts.map((account) => (isObject(account) ? account.accountId : undefined))).size ===
      value.accounts.length &&
    value.accounts.every(isAccount)
  )
}

function isAccount(value: unknown): value is AccountRecoveryState {
  return (
    isObject(value) &&
    isDiscordSnowflake(value.accountId) &&
    isRecoveryEpoch(value.recoveryEpoch) &&
    (value.disconnectedAt === null || isFiniteNonnegative(value.disconnectedAt)) &&
    Array.isArray(value.cursors) &&
    value.cursors.length <= DISCORD_RECOVERY_MAX_CHANNELS_PER_ACCOUNT &&
    value.cursors.every(isCursor) &&
    Array.isArray(value.replayCursors) &&
    value.replayCursors.length <= DISCORD_RECOVERY_MAX_CHANNELS_PER_ACCOUNT &&
    value.replayCursors.every(isReplayCursor) &&
    ((value.disconnectedAt === null && value.replayCursors.length === 0) ||
      (isFiniteNonnegative(value.disconnectedAt) && value.replayCursors.length > 0)) &&
    Array.isArray(value.recentMessageIds) &&
    value.recentMessageIds.length <= DISCORD_RECOVERY_MAX_CHANNELS_PER_ACCOUNT &&
    value.recentMessageIds.every(isRecentMessageIds)
  )
}

function isCursor(value: unknown): value is DiscordRecoveryCursor {
  return (
    isObject(value) &&
    isDiscordSnowflake(value.channelId) &&
    isDiscordWorkspace(value.workspace) &&
    isDiscordSnowflake(value.messageId) &&
    isFiniteNonnegative(value.processedAt)
  )
}

function isReplayCursor(value: unknown): value is DiscordRecoveryCursor {
  return (
    isObject(value) &&
    isDiscordSnowflake(value.channelId) &&
    isDiscordWorkspace(value.workspace) &&
    isDiscordRecoveryAnchor(value.messageId) &&
    isFiniteNonnegative(value.processedAt)
  )
}

function isRecentMessageIds(value: unknown): value is AccountRecoveryState['recentMessageIds'][number] {
  return (
    isObject(value) &&
    isDiscordSnowflake(value.channelId) &&
    Array.isArray(value.messageIds) &&
    value.messageIds.length <= DISCORD_RECOVERY_MAX_RECENT_IDS_PER_CHANNEL &&
    value.messageIds.every(isDiscordSnowflake)
  )
}

export function compareDiscordSnowflakes(left: string, right: string): number {
  try {
    const leftId = BigInt(left)
    const rightId = BigInt(right)
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
  } catch {
    return left.localeCompare(right)
  }
}

function compareSnowflakes(left: string, right: string): number {
  return compareDiscordSnowflakes(left, right)
}

export type TimedSettlement<T> =
  | { kind: 'completed'; value: T }
  | { kind: 'failed'; error: unknown }
  | { kind: 'timed-out' }

export function settleWithin<T>(operation: Promise<T>, timeoutMs: number): Promise<TimedSettlement<T>> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ kind: 'timed-out' }), Math.max(0, timeoutMs))
    void operation.then(
      (value) => {
        clearTimeout(timeout)
        resolve({ kind: 'completed', value })
      },
      (error: unknown) => {
        clearTimeout(timeout)
        resolve({ kind: 'failed', error })
      },
    )
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isErrorWithCode(value: unknown): value is Error & { code: string } {
  return value instanceof Error && 'code' in value && typeof value.code === 'string'
}
