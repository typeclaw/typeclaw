import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type BigIntStats,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { CREDENTIAL_STAGING_RELATIVE_DIR, ensureOwnerOnlyDir } from '@/init/staged-write'

import { withConfigFileLock, withConfigFileLockSync } from './config-file-lock'

// typeclaw.json and cron.json are guarded on every write/edit, but model bash for
// roles that keep agent-root writes changes them directly and is checked only
// after the call (src/agent/tool-file-safety.ts). This module keeps the state
// that makes that after-the-fact check safe:
//
// - The last AUTHORIZED commit of each file: bytes written under the config file
//   lock by a checked write/edit, a host CLI command, a config migration, or a
//   passed post-bash check. It lives in the credential staging dir, which is
//   owner-only and masked from every model tool and every bash role, so bash
//   cannot forge it.
// - While any bash call is in flight (or a failed rollback is unrecovered), the
//   TRUSTED state of each file: the newest authorized state. Runtime readers
//   (config/cron reload, the guards' own baselines) and guard-free
//   read-modify-write writers use it instead of bytes no check has passed yet.
//   It is also published to the staging dir, so host CLI writers in another
//   process build on it too.

export const MANAGED_CONFIG_FILES = ['typeclaw.json', 'cron.json'] as const

export type ConfigFileIdentity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }

// A managed path as a loader sees it. A symlink is followed to the regular file
// it names (`resolved`); anything a loader cannot read as one regular file, such
// as a directory, a FIFO, or a dangling link, is `other` and is never opened.
export type ConfigFileEntry =
  | { kind: 'missing' }
  | { kind: 'file'; bytes: Buffer; mode: number; id: ConfigFileIdentity }
  | {
      kind: 'link'
      target: string
      resolved: string
      bytes: Buffer
      mode: number
      id: ConfigFileIdentity
      resolvedId: ConfigFileIdentity
    }
  // `unreadable`: lstat says a regular file (or a link to one), but it could not be
  // opened or verified, so its bytes are unknown, unlike a confirmed FIFO,
  // directory, socket, or device.
  | { kind: 'other'; id: ConfigFileIdentity; unreadable?: true }

// `entry` is the kind of entry the writer left (file or link, with its mode and
// link target), so restoring a commit never reuses an older window's entry.
export type ConfigCommit = {
  generation: number
  bytes: Buffer | undefined
  superseded: boolean
  entry: ConfigFileEntry | undefined
}

// A bash call's guard check: the denial reason, or undefined when content may land.
export type ConfigCallGuard = (content: string, destination: string) => Promise<string | undefined>

type Window = {
  calls: Map<symbol, ConfigCallGuard>
  trusted: ConfigFileEntry
  generation: number | undefined
  // A blocked change whose rollback failed, or a file left unreadable: the
  // trusted view stays in force, even with no call in flight, until the file is
  // back to an authorized state. `recoveryGuards` are the checks of the calls
  // that left those unverified bytes; a later re-check must pass them too.
  recovery: boolean
  recoveryGuards: ConfigCallGuard[]
  // The guard of every call that has touched this window: if the window cannot
  // release (see evictWindow), these become its recovery guards.
  touched: ConfigCallGuard[]
  // False once the window could not be captured under the config lock or
  // published: a host command may then have built on unchecked bytes, so its
  // commits are not trusted to skip the post-bash check, and bash calls that
  // open on it get the file read-only.
  coordinated: boolean
  uncoordinatedReason?: string
  // Set when a rollback could not advance the epoch: the record outlives the window.
  keepRecord?: boolean
  // The record this window published, if any. A window only ever removes its
  // own record, and an uncoordinated window (which never published) none.
  owner: string
  published: boolean
}

let configReadHook: ((stage: 'after-window' | 'after-live') => void) | undefined

// Test seam: runs between the reads of a cross-process config read.
export function __setConfigReadHookForTests(hook: typeof configReadHook): void {
  configReadHook = hook
}

const windows = new Map<string, Window>()
const baselineOverride = new AsyncLocalStorage<{ file: string; bytes: Buffer | undefined }>()
// Set by a guard-free writer's baseline read when the file held a bash candidate
// that its write replaces; consumed by the commit it records under the same lock.
const supersededCandidates = new Set<string>()
// Set in the container runtime, which owns the in-process windows. Any other
// process (host CLI) reads the state the runtime published instead.
let runtimeOwnsWindows = false

export function readConfigEntrySync(file: string): ConfigFileEntry {
  const link = lstatOrUndefined(file)
  if (link === undefined) return { kind: 'missing' }
  if (!link.isSymbolicLink()) {
    const read = readRegularSync(file, link)
    if (read !== undefined) return { kind: 'file', ...read }
    return link.isFile()
      ? { kind: 'other', id: identityOf(link), unreadable: true }
      : { kind: 'other', id: identityOf(link) }
  }
  let target: string
  let resolved: string
  try {
    target = readlinkSync(file)
    resolved = realpathSync(file)
  } catch (error) {
    // A dangling link or a link loop is confirmed not to be a regular file; any
    // other failure (permissions, I/O) leaves what it names unknown.
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ELOOP'
      ? { kind: 'other', id: identityOf(link) }
      : { kind: 'other', id: identityOf(link), unreadable: true }
  }
  const resolvedStats = lstatOrUndefined(resolved)
  const read = resolvedStats === undefined ? undefined : readRegularSync(resolved, resolvedStats)
  if (read === undefined) {
    return resolvedStats?.isFile() === true
      ? { kind: 'other', id: identityOf(link), unreadable: true }
      : { kind: 'other', id: identityOf(link) }
  }
  return {
    kind: 'link',
    target,
    resolved,
    bytes: read.bytes,
    mode: read.mode,
    id: identityOf(link),
    resolvedId: read.id,
  }
}

export function contentOf(entry: ConfigFileEntry): Buffer | undefined {
  return entry.kind === 'file' || entry.kind === 'link' ? entry.bytes : undefined
}

export function sameConfigContent(a: ConfigFileEntry, b: ConfigFileEntry): boolean {
  if (a.kind === 'other' || b.kind === 'other') {
    return a.kind === 'other' && b.kind === 'other' && a.id.dev === b.id.dev && a.id.ino === b.id.ino
  }
  return equalBytes(contentOf(a), contentOf(b))
}

export function equalBytes(a: Buffer | undefined, b: Buffer | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.equals(b)
}

export function readConfigCommitSync(file: string): ConfigCommit | undefined {
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = readStateFileSync(commitPath(file))
  } catch {
    return undefined
  }
  if (parsed === undefined || typeof parsed.generation !== 'number') return undefined
  const bytes = typeof parsed.content === 'string' ? Buffer.from(parsed.content, 'base64') : undefined
  return {
    generation: parsed.generation,
    bytes,
    superseded: parsed.superseded === true,
    entry: trustedEntryFromRecord(parsed),
  }
}

// The state a commit restores to: its own recorded entry, or for a commit
// recorded before entries were, its bytes in the given entry.
export function commitEntry(commit: ConfigCommit, fallback: ConfigFileEntry): ConfigFileEntry {
  return commit.entry ?? withContent(fallback, commit.bytes)
}

// Records `content` as the last authorized commit of `file`. Callers hold the
// config file lock and have just written exactly these bytes.
export function recordConfigCommitSync(file: string, content: string | Buffer | undefined): number {
  const key = resolve(file)
  const bytes = content === undefined ? undefined : Buffer.from(content)
  const generation = (readConfigCommitSync(file)?.generation ?? 0) + 1
  const superseded = supersededCandidates.delete(key)
  const live = readConfigEntrySync(file)
  const committed = equalBytes(contentOf(live), bytes) ? live : withContent({ kind: 'missing' }, bytes)
  writeStateFileSync(commitPath(file), {
    generation,
    content: bytes === undefined ? null : bytes.toString('base64'),
    superseded,
    entry: describeEntry(committed),
  })
  const window = windows.get(key)
  if (window !== undefined) {
    window.trusted = committed
    window.generation = generation
    window.recovery = false
    window.recoveryGuards = []
    settleWindow(file, window)
  }
  return generation
}

// Host CLI writers record their commits best-effort: the config write already
// landed, and failing the command over the record would misreport it.
export function tryRecordConfigCommitSync(file: string, content: string | Buffer | undefined): void {
  try {
    recordConfigCommitSync(file, content)
  } catch (error) {
    console.warn(
      `[typeclaw] could not record the ${basename(file)} commit (${errorText(error)}); a bash command running in the agent now may revert this change`,
    )
  }
}

// The baseline for a writer that changes typeclaw.json/cron.json without the
// guards (role grants, host CLI config commands, migrations), under the config
// lock. While a bash call is in flight the file may hold that call's unchecked
// candidate, so the writer builds on the trusted state instead: its write then
// replaces the candidate, and the bash call's check finds an authorized commit.
// With no bash call in flight it reads the file. Throws ENOENT when missing.
export function readConfigForWriteSync(file: string): string {
  const key = resolve(file)
  supersededCandidates.delete(key)
  const trusted = windows.has(key)
    ? trustedConfigState(file).entry
    : runtimeOwnsWindows
      ? undefined
      : publishedTrustedEntry(file)
  if (trusted === undefined) return textOf(file, readConfigEntrySync(file))
  if (!sameConfigContent(readConfigEntrySync(file), trusted)) supersededCandidates.add(key)
  return textOf(file, trusted)
}

// A checked write/edit lands `bytes`: if the file held a bash candidate that
// these bytes replace, the bash call is told its change was discarded.
export function noteConfigWriteSync(file: string, bytes: string | Buffer): void {
  const key = resolve(file)
  supersededCandidates.delete(key)
  if (!windows.has(key)) return
  const live = readConfigEntrySync(file)
  const trusted = trustedConfigState(file).entry
  if (!sameConfigContent(live, trusted) && !equalBytes(contentOf(live), Buffer.from(bytes))) {
    supersededCandidates.add(key)
  }
}

// Opened by each bash call before it runs and closed after its post-call check.
// The first open captures the file as trusted: no unchecked bash bytes can be
// on disk while no bash call is in flight and no rollback is unrecovered. That
// capture and its publication hold the config lock, which host writers hold from
// read to write, so a host commit either lands first (and is the baseline) or
// reads the published window. A lock that cannot be taken in time never blocks
// the bash call: its window is kept in process only, as uncoordinated.
export async function openConfigWindow(
  file: string,
  call: symbol,
  guard: ConfigCallGuard,
): Promise<{ generation: number | undefined; uncoordinated: string | undefined }> {
  const key = resolve(file)
  if (!windows.has(key)) {
    try {
      await withConfigFileLock(file, async () => captureWindow(file))
    } catch (error) {
      if (!windows.has(key)) {
        captureWindow(file, `the ${basename(file)} lock could not be taken: ${errorText(error)}`)
      }
    }
  }
  const window = windows.get(key)
  if (window !== undefined) {
    window.calls.set(call, guard)
    if (!window.touched.includes(guard)) window.touched.push(guard)
  }
  return {
    generation: trustedConfigState(file).generation,
    uncoordinated: window?.coordinated === false ? window.uncoordinatedReason : undefined,
  }
}

export function markRuntimeOwnsConfigWindows(): void {
  runtimeOwnsWindows = true
}

export async function closeConfigWindow(file: string, call: symbol): Promise<void> {
  const window = windows.get(resolve(file))
  if (window === undefined) return
  window.calls.delete(call)
  if (window.calls.size > 0 || window.recovery) {
    settleWindow(file, window)
    return
  }
  // The record is removed only after the epoch advances under the lock.
  await withConfigFileLock(file, async () => settleWindow(file, window)).catch((error: unknown) => {
    // Another call may have joined meanwhile: the window stays in force for it.
    if (evictWindow(file, window)) {
      warnKeptRecord(
        file,
        window,
        `the ${basename(file)} lock could not be taken to close the window: ${errorText(error)}`,
      )
    }
  })
}

// Bumped when a window opens, closes, or rolls a change back, and kept when the
// window is gone, so a cross-process read can tell that a whole window came and
// went between its samples.
function bumpConfigEpochSync(file: string): { ok: true } | { ok: false; reason: string } {
  try {
    if (failEpochWrites) throw new Error('epoch writes are failing (test)')
    writeStateFileSync(epochPath(file), { epoch: readConfigEpochSync(file) + 1 })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      reason: `the ${basename(file)} window epoch could not be advanced at ${epochPath(file)}: ${errorText(error)}`,
    }
  }
}

let failEpochWrites = false

// Test seam: makes epoch advances fail while every other state write succeeds.
export function __failConfigEpochWritesForTests(fail: boolean): void {
  failEpochWrites = fail
}

// A rollback advances the epoch; if it cannot, the window's record is kept past
// its close, so host readers keep using the trusted bytes until a restart.
export function noteConfigRollbackSync(file: string): void {
  const bumped = bumpConfigEpochSync(file)
  if (bumped.ok) return
  const window = windows.get(resolve(file))
  if (window !== undefined) window.keepRecord = true
  console.warn(
    `[typeclaw] ${bumped.reason}; the agent's open ${basename(file)} state stays published until it restarts`,
  )
}

function readConfigEpochSync(file: string): number {
  const path = epochPath(file)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw invalidWindowState(file, path, errorText(error))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw invalidWindowState(file, path, errorText(error))
  }
  if (!isRecord(parsed) || typeof parsed.epoch !== 'number') {
    throw invalidWindowState(file, path, 'it is not a valid window epoch')
  }
  return parsed.epoch
}

// The newest authorized state: the trusted state, advanced to any commit an
// authorized writer in another process recorded since.
export function trustedConfigState(file: string): {
  entry: ConfigFileEntry
  generation: number | undefined
  commit: ConfigCommit | undefined
  coordinated: boolean
} {
  const window = windows.get(resolve(file))
  if (window === undefined) throw new Error(`${basename(file)} has no open bash config window`)
  const commit = readConfigCommitSync(file)
  const newer = commit !== undefined && (window.generation === undefined || commit.generation > window.generation)
  if (newer && window.coordinated) {
    const live = readConfigEntrySync(file)
    window.trusted = equalBytes(contentOf(live), commit.bytes) ? live : commitEntry(commit, window.trusted)
    window.generation = commit.generation
    publishWindow(file, window)
  }
  return {
    entry: window.trusted,
    generation: window.generation,
    commit: newer && !window.coordinated ? undefined : commit,
    coordinated: window.coordinated,
  }
}

// The guards of the other bash calls in flight on this file, whose sessions may
// hold fewer permissions than the call being checked.
export function concurrentCallGuards(file: string, call: symbol): ConfigCallGuard[] {
  const window = windows.get(resolve(file))
  if (window === undefined) return []
  return [...window.calls].filter(([other]) => other !== call).map(([, guard]) => guard)
}

export function setTrustedConfigEntry(file: string, entry: ConfigFileEntry): void {
  const window = windows.get(resolve(file))
  if (window === undefined) return
  window.trusted = entry
  publishWindow(file, window)
}

export function setConfigRecovery(file: string, recovery: boolean, guards: readonly ConfigCallGuard[] = []): void {
  const window = windows.get(resolve(file))
  if (window === undefined) return
  window.recovery = recovery
  window.recoveryGuards = recovery ? [...new Set([...window.recoveryGuards, ...guards])] : []
}

export function configRecoveryPending(file: string): boolean {
  return windows.get(resolve(file))?.recovery === true
}

export function configRecoveryGuards(file: string): readonly ConfigCallGuard[] {
  return windows.get(resolve(file))?.recoveryGuards ?? []
}

export function withContent(entry: ConfigFileEntry, bytes: Buffer | undefined): ConfigFileEntry {
  if (bytes === undefined) return { kind: 'missing' }
  if (entry.kind === 'file' || entry.kind === 'link') return { ...entry, bytes }
  return { kind: 'file', bytes, mode: 0o644, id: zeroIdentity() }
}

// What runtime readers load. With no bash call in flight this is the file, read
// only if it is one regular file (a link is followed to one). While one is (or
// a failed rollback is unrecovered), bytes that differ from the trusted state
// have not passed a check yet, so the trusted bytes are returned instead.
// Throws ENOENT for a missing file, like readFileSync.
export function readValidatedConfigFileSync(file: string): string {
  const window = windows.get(resolve(file))
  if (window === undefined) {
    if (runtimeOwnsWindows) return textOf(file, readConfigEntrySync(file))
    // In another process (host `typeclaw start`, CLI reads), an agent that has
    // a window open, or stopped with one, may have left rejected bytes on disk.
    const { live, trusted } = readAcrossProcessesSync(file)
    return textOf(file, trusted !== undefined && !sameConfigContent(live, trusted) ? trusted : live)
  }
  const live = readConfigEntrySync(file)
  const { entry: trusted } = trustedConfigState(file)
  if (!sameConfigContent(live, trusted)) return textOf(file, trusted)
  if (window.recovery) {
    window.recovery = false
    window.recoveryGuards = []
    try {
      withConfigFileLockSync(file, () => settleWindow(file, window))
    } catch (error) {
      if (evictWindow(file, window)) {
        warnKeptRecord(
          file,
          window,
          `the ${basename(file)} lock could not be taken to close the window: ${errorText(error)}`,
        )
      }
    }
  }
  return textOf(file, live)
}

// The baseline a typeclaw.json/cron.json guard compares a proposed change to.
// The post-bash check passes the trusted bytes explicitly, so the guards never
// need the live file rewritten to see them.
export function runWithConfigBaseline<T>(file: string, bytes: Buffer | undefined, fn: () => Promise<T>): Promise<T> {
  return baselineOverride.run({ file: resolve(file), bytes }, fn)
}

export async function readConfigBaseline(file: string): Promise<string> {
  const override = baselineOverride.getStore()
  if (override !== undefined && override.file === resolve(file)) {
    if (override.bytes === undefined) throw notFound(file)
    return override.bytes.toString('utf8')
  }
  return readValidatedConfigFileSync(file)
}

// Run by `typeclaw run` before it loads typeclaw.json and cron.json. A runtime
// that stopped with a window open (a bash call in flight, or a blocked change it
// could not roll back) may have left unchecked or rejected bytes on disk. Those
// are put back to the last authorized state before anything loads them; a file
// that cannot be put back stops startup, as an invalid typeclaw.json does,
// rather than load bytes no check passed. Only then is the window state cleared.
export function reconcileLeftoverConfigWindowsSync(agentDir: string): void {
  for (const name of MANAGED_CONFIG_FILES) {
    const file = join(resolve(agentDir), name)
    // Only the runtime creates window state, and it is not running yet, so an
    // absent record cannot appear meanwhile; everything else is decided under
    // the lock, so a host commit that lands while startup waits is kept.
    if (readWindowRawSync(file) === undefined) continue
    let reverted = false
    try {
      withConfigFileLockSync(file, () => {
        const trusted = publishedTrustedEntry(file)
        if (trusted === undefined) return
        if (!matchesTrustedEntry(file, trusted)) {
          restoreTrustedEntrySync(file, trusted)
          recordConfigCommitSync(file, contentOf(trusted))
          reverted = true
        }
        // The epoch advances before the record goes; if it cannot, the record
        // stays, so host readers keep using its trusted bytes.
        const bumped = bumpConfigEpochSync(file)
        if (bumped.ok) rmSync(windowPath(file), { force: true })
        else {
          console.warn(
            `[typeclaw] ${bumped.reason}; the agent's ${name} state at ${windowPath(file)} stays published, so host typeclaw commands keep using the last authorized ${name}`,
          )
        }
      })
    } catch (error) {
      throw new Error(
        `${name} holds a bash change that was never checked or that was blocked and could not be reverted (${errorText(error)}); refusing to load it. Restore it with \`git checkout -- ${name}\` in the agent folder, delete ${windowPath(file)}, then start the agent again.`,
      )
    }
    if (reverted) {
      console.warn(
        `[typeclaw] ${name} held a bash change that was never checked or that was blocked and could not be reverted before the agent stopped; it was reverted to the last authorized ${name} at startup`,
      )
    }
  }
}

// Puts `to` back at `file`, given what is on disk now. A regular file is
// rewritten in place on its inode (bytes first, then the length), never
// truncated before it is rewritten; a symlink's target is rewritten the same way.
export function restoreConfigEntrySync(
  file: string,
  current: ConfigFileEntry,
  to: ConfigFileEntry,
  writeInPlace: (path: string, bytes: Buffer) => void = writeConfigInPlaceSync,
): void {
  if (to.kind === 'other') throw new Error(`${basename(file)} was not a regular file before; it cannot be restored`)
  if (current.kind === 'other') throw new Error(`${basename(file)} is no longer a regular file`)
  if (to.kind === 'missing') {
    if (current.kind !== 'missing') unlinkSync(file)
    return
  }
  if (to.kind === 'file') {
    if (current.kind === 'file') {
      writeInPlace(file, to.bytes)
      return
    }
    if (current.kind === 'link') unlinkSync(file)
    createExclusiveSync(file, to.bytes, to.mode)
    return
  }
  if (current.kind !== 'link' || current.target !== to.target) {
    if (current.kind !== 'missing') unlinkSync(file)
    symlinkSync(to.target, file)
  }
  const target = readConfigEntrySync(to.resolved)
  if (target.kind === 'file' && target.bytes.equals(to.bytes)) return
  if (target.kind === 'file') writeInPlace(to.resolved, to.bytes)
  else if (target.kind === 'missing') createExclusiveSync(to.resolved, to.bytes, to.mode)
  else throw new Error(`${to.resolved} is no longer a regular file`)
}

export function writeConfigInPlaceSync(path: string, bytes: Buffer): void {
  const fd = openSync(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`)
    let written = 0
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, written)
    ftruncateSync(fd, bytes.length)
  } finally {
    closeSync(fd)
  }
}

function createExclusiveSync(path: string, bytes: Buffer, mode: number): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    mode,
  )
  try {
    let written = 0
    while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, written)
  } finally {
    closeSync(fd)
  }
}

// Classified with lstat first and opened only when it is a regular file, never
// following a link and never blocking (a FIFO is not opened at all), then
// verified on the descriptor before it is read.
function readRegularSync(
  path: string,
  stats: BigIntStats,
): { bytes: Buffer; mode: number; id: ConfigFileIdentity } | undefined {
  if (!stats.isFile()) return undefined
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch {
    return undefined
  }
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino) return undefined
    return { bytes: readFileSync(fd), mode: Number(opened.mode & 0o7777n), id: identityOf(opened) }
  } finally {
    closeSync(fd)
  }
}

function lstatOrUndefined(path: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export function identityOf(stats: BigIntStats): ConfigFileIdentity {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs }
}

function zeroIdentity(): ConfigFileIdentity {
  return { dev: 0n, ino: 0n, size: 0n, mtimeNs: 0n, ctimeNs: 0n }
}

function textOf(file: string, entry: ConfigFileEntry): string {
  if (entry.kind === 'missing') throw notFound(file)
  if (entry.kind === 'other') {
    throw Object.assign(new Error(`${file} is not a regular file; refusing to read it`), { code: 'EINVAL' })
  }
  return entry.bytes.toString('utf8')
}

function notFound(file: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' })
}

function captureWindow(file: string, uncoordinatedReason?: string): void {
  const key = resolve(file)
  if (windows.has(key)) return
  const window: Window = {
    calls: new Map(),
    trusted: readConfigEntrySync(file),
    generation: readConfigCommitSync(file)?.generation,
    recovery: false,
    recoveryGuards: [],
    touched: [],
    coordinated: uncoordinatedReason === undefined,
    ...(uncoordinatedReason === undefined ? {} : { uncoordinatedReason }),
    owner: randomUUID(),
    published: false,
  }
  windows.set(key, window)
  if (window.coordinated) {
    // A window that cannot advance the epoch is invisible to a host read that
    // samples around it, so it is not coordinated.
    const bumped = bumpConfigEpochSync(file)
    if (bumped.ok) publishWindow(file, window)
    else {
      window.coordinated = false
      window.uncoordinatedReason = bumped.reason
    }
  }
  if (!window.coordinated)
    console.warn(
      `[typeclaw] a bash command could not coordinate with host typeclaw commands (${window.uncoordinatedReason})`,
    )
}

function settleWindow(file: string, window: Window): void {
  if (window.calls.size > 0 || window.recovery) {
    publishWindow(file, window)
    return
  }
  if (!evictWindow(file, window)) {
    if (window.recovery) publishWindow(file, window)
    return
  }
  // Callers hold the config lock. Only this window's own record is removed, and
  // only once the epoch has advanced; otherwise a host read could miss the whole
  // window, so the record stays and host readers keep its trusted bytes.
  if (!window.published || recordOwner(file) !== window.owner) return
  if (window.keepRecord === true) {
    warnKeptRecord(file, window, `the ${basename(file)} window epoch could not be advanced during a rollback`)
    return
  }
  const bumped = bumpConfigEpochSync(file)
  if (!bumped.ok) {
    warnKeptRecord(file, window, bumped.reason)
    return
  }
  try {
    rmSync(windowPath(file), { force: true })
  } catch (error) {
    warnKeptRecord(file, window, `the record could not be removed: ${errorText(error)}`)
  }
}

// The only way a window leaves memory: it must still be the window registered
// for the file, with no call in flight and no unrecovered rollback. Runtime
// readers fall back to the file itself once it is gone.
//
// Invariant: a window releases its trusted view only while the live file holds
// the trusted bytes, or a verified authorized commit (trustedConfigState adopts
// a recorded commit whose bytes are live). Anything else, including a live read
// that fails or is inconclusive, puts the window in recovery instead: it keeps
// the trusted baseline, and the guards of every call that touched it must pass
// before a later check accepts the live bytes. Every exit path, errors included,
// releases through here. Callers hold the config lock, except a close that could
// not take it; that close compares without it, and a mismatch still holds.
function evictWindow(file: string, window: Window): boolean {
  const key = resolve(file)
  if (windows.get(key) !== window || window.calls.size > 0 || window.recovery) return false
  if (!liveMatchesTrusted(file)) {
    window.recovery = true
    window.recoveryGuards = [...new Set([...window.recoveryGuards, ...window.touched])]
    return false
  }
  windows.delete(key)
  return true
}

function liveMatchesTrusted(file: string): boolean {
  try {
    const live = readConfigEntrySync(file)
    // A confirmed FIFO, directory, socket, or device holds no bytes a reader
    // would load: readers refuse it, so it never stands in for the config.
    if (live.kind === 'other') return live.unreadable !== true
    return sameConfigContent(live, trustedConfigState(file).entry)
  } catch {
    return false
  }
}

function warnKeptRecord(file: string, window: Window, reason: string): void {
  if (!window.published) return
  console.warn(
    `[typeclaw] ${reason}; the agent's ${basename(file)} state at ${windowPath(file)} stays published until the agent restarts, so host typeclaw commands keep using the last authorized ${basename(file)}`,
  )
}

function recordOwner(file: string): string | undefined {
  try {
    const raw = readWindowRawSync(file)
    const record = raw === undefined ? undefined : (JSON.parse(raw) as unknown)
    return isRecord(record) && typeof record.owner === 'string' ? record.owner : undefined
  } catch {
    return undefined
  }
}

function publishWindow(file: string, window: Window): void {
  if (!window.coordinated) return
  const bytes = contentOf(window.trusted)
  try {
    writeStateFileSync(windowPath(file), {
      generation: window.generation ?? 0,
      content: bytes === undefined ? null : bytes.toString('base64'),
      entry: describeEntry(window.trusted),
      owner: window.owner,
    })
    window.published = true
  } catch (error) {
    window.coordinated = false
    window.uncoordinatedReason = `the agent's ${basename(file)} state could not be written to ${windowPath(file)}: ${errorText(error)}; make that path writable (restarting the agent clears it)`
    console.warn(
      `[typeclaw] a bash command could not coordinate with host typeclaw commands (${window.uncoordinatedReason})`,
    )
  }
}

// The trusted state a runtime published for its open window, advanced to any
// newer commit, or undefined when no window is open. Published state that exists
// but cannot be read is an error, never a reason to trust the file as it is.
function publishedTrustedEntry(file: string): ConfigFileEntry | undefined {
  return parseWindowRecord(file, readWindowRawSync(file))
}

// A cross-process read without the lock: the window state, then the file, then
// the window state again, retried while a rollback or commit moves either, so a
// rollback that lands between them cannot hand back the rejected bytes. Host
// reads (`typeclaw start`, status) stay off the lock in the common case; after a
// few moving reads it falls back to reading under the lock's normal bound.
function readAcrossProcessesSync(file: string): { live: ConfigFileEntry; trusted: ConfigFileEntry | undefined } {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = windowStamp(file)
    configReadHook?.('after-window')
    const live = readConfigEntrySync(file)
    configReadHook?.('after-live')
    const after = windowStamp(file)
    if (before.raw === after.raw && before.generation === after.generation && before.epoch === after.epoch) {
      return { live, trusted: parseWindowRecord(file, before.raw) }
    }
  }
  return withConfigFileLockSync(file, () => ({
    live: readConfigEntrySync(file),
    trusted: publishedTrustedEntry(file),
  }))
}

function windowStamp(file: string): { raw: string | undefined; generation: number | undefined; epoch: number } {
  return {
    raw: readWindowRawSync(file),
    generation: readConfigCommitSync(file)?.generation,
    epoch: readConfigEpochSync(file),
  }
}

// Only a missing record means no window; anything else that is not valid
// window state is an error, never a reason to trust the file as it is.
function readWindowRawSync(file: string): string | undefined {
  const path = windowPath(file)
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw invalidWindowState(file, path, errorText(error))
    // Windows reports a path through a regular file as ENOENT, where POSIX says
    // ENOTDIR: a record is only absent when its directories are directories or missing.
    const blocker = nonDirectoryAncestor(dirname(path), dirname(resolve(file)))
    if (blocker !== undefined) throw invalidWindowState(file, path, `${blocker} is not a directory`)
    return undefined
  }
}

function nonDirectoryAncestor(directory: string, root: string): string | undefined {
  for (let current = directory; current.startsWith(root) && current !== root; current = dirname(current)) {
    const stats = lstatOrUndefined(current)
    if (stats !== undefined && !stats.isDirectory()) return current
  }
  return undefined
}

function parseWindowRecord(file: string, raw: string | undefined): ConfigFileEntry | undefined {
  if (raw === undefined) return undefined
  const path = windowPath(file)
  let record: unknown
  try {
    record = JSON.parse(raw)
  } catch (error) {
    throw invalidWindowState(file, path, errorText(error))
  }
  const entry = isRecord(record) ? trustedEntryFromRecord(record) : undefined
  if (entry === undefined || !isRecord(record) || typeof record.generation !== 'number') {
    throw invalidWindowState(file, path, 'it is not valid window state')
  }
  const commit = readConfigCommitSync(file)
  return commit !== undefined && commit.generation > record.generation ? commitEntry(commit, entry) : entry
}

function invalidWindowState(file: string, path: string, detail: string): Error {
  const name = basename(file)
  return new Error(
    `${name} was not changed: the agent's open ${name} state at ${path} is invalid (${detail}). Delete that file (after restoring ${name} with \`git checkout -- ${name}\` if it holds an unwanted change) and try again.`,
  )
}

// The entry shape a window was opened on, so startup restores the same kind of
// entry and never writes through a link bash swapped in.
type EntryRecord =
  | { kind: 'missing' }
  | { kind: 'other' }
  | { kind: 'file'; mode: number }
  | { kind: 'link'; mode: number; target: string; resolved: string; dev: string; ino: string }

function describeEntry(entry: ConfigFileEntry): EntryRecord {
  if (entry.kind === 'missing') return { kind: 'missing' }
  if (entry.kind === 'file') return { kind: 'file', mode: entry.mode }
  if (entry.kind === 'link') {
    return {
      kind: 'link',
      mode: entry.mode,
      target: entry.target,
      resolved: entry.resolved,
      dev: String(entry.resolvedId.dev),
      ino: String(entry.resolvedId.ino),
    }
  }
  return { kind: 'other' }
}

function trustedEntryFromRecord(record: Record<string, unknown>): ConfigFileEntry | undefined {
  const { content, entry } = record
  if (content !== null && typeof content !== 'string') return undefined
  if (!isRecord(entry)) return undefined
  const bytes = typeof content === 'string' ? Buffer.from(content, 'base64') : undefined
  if (entry.kind === 'missing') return bytes === undefined ? { kind: 'missing' } : undefined
  if (entry.kind === 'other') return bytes === undefined ? { kind: 'other', id: zeroIdentity() } : undefined
  if (bytes === undefined || typeof entry.mode !== 'number') return undefined
  if (entry.kind === 'file') return { kind: 'file', bytes, mode: entry.mode, id: zeroIdentity() }
  if (
    entry.kind !== 'link' ||
    typeof entry.target !== 'string' ||
    typeof entry.resolved !== 'string' ||
    typeof entry.dev !== 'string' ||
    typeof entry.ino !== 'string'
  ) {
    return undefined
  }
  return {
    kind: 'link',
    target: entry.target,
    resolved: entry.resolved,
    bytes,
    mode: entry.mode,
    id: zeroIdentity(),
    resolvedId: { ...zeroIdentity(), dev: BigInt(entry.dev), ino: BigInt(entry.ino) },
  }
}

// The file already is the trusted entry: same kind of entry, the same link and
// link target file, and the trusted bytes.
function matchesTrustedEntry(file: string, trusted: ConfigFileEntry): boolean {
  const live = readConfigEntrySync(file)
  if (live.kind === 'other' && trusted.kind === 'other') return true
  if (!sameConfigContent(live, trusted) || live.kind !== trusted.kind) return false
  if (live.kind !== 'link' || trusted.kind !== 'link') return true
  return (
    live.target === trusted.target &&
    live.resolved === trusted.resolved &&
    live.resolvedId.dev === trusted.resolvedId.dev &&
    live.resolvedId.ino === trusted.resolvedId.ino
  )
}

// Puts back the entry a window was opened on. Whatever bash left at the managed
// path is removed, never written through; a regular file is rewritten in place,
// and a link is recreated and its target file rewritten in place only if that
// file is still the one the window recorded.
function restoreTrustedEntrySync(file: string, trusted: ConfigFileEntry): void {
  const current = lstatOrUndefined(file)
  if (current !== undefined && !current.isFile() && !current.isSymbolicLink()) {
    throw new Error(`${file} is no longer a regular file or symlink`)
  }
  if (trusted.kind === 'other') throw new Error(`${file} was not a regular file before`)
  if (trusted.kind === 'missing') {
    if (current !== undefined) unlinkSync(file)
    return
  }
  if (trusted.kind === 'file') {
    if (current?.isFile() === true) {
      writeConfigInPlaceSync(file, trusted.bytes)
      return
    }
    if (current !== undefined) unlinkSync(file)
    createExclusiveSync(file, trusted.bytes, trusted.mode)
    return
  }
  const target = lstatOrUndefined(trusted.resolved)
  if (
    target === undefined ||
    !target.isFile() ||
    target.dev !== trusted.resolvedId.dev ||
    target.ino !== trusted.resolvedId.ino
  ) {
    throw new Error(`${trusted.resolved}, the file ${basename(file)} linked to, is no longer the same file`)
  }
  if (current?.isSymbolicLink() !== true || readlinkSync(file) !== trusted.target) {
    if (current !== undefined) unlinkSync(file)
    symlinkSync(trusted.target, file)
  }
  if (realpathSync(file) !== trusted.resolved) throw new Error(`${file} does not resolve to ${trusted.resolved}`)
  writeConfigInPlaceSync(trusted.resolved, trusted.bytes)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStateFileSync(path: string): Record<string, unknown> | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed = JSON.parse(raw) as unknown
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
}

function writeStateFileSync(path: string, value: Record<string, unknown>): void {
  ensureOwnerOnlyDir(dirname(path))
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
  try {
    renameSync(temporary, path)
  } catch (error) {
    unlinkSync(temporary)
    throw error
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function commitPath(file: string): string {
  return statePath(file, 'commit')
}

function windowPath(file: string): string {
  return statePath(file, 'window')
}

function epochPath(file: string): string {
  return statePath(file, 'epoch')
}

function statePath(file: string, kind: 'commit' | 'window' | 'epoch'): string {
  const absolute = resolve(file)
  return join(dirname(absolute), CREDENTIAL_STAGING_RELATIVE_DIR, `${basename(absolute)}.${kind}.json`)
}
