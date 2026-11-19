import { AsyncLocalStorage } from 'node:async_hooks'
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
  | { kind: 'other'; id: ConfigFileIdentity }

export type ConfigCommit = { generation: number; bytes: Buffer | undefined; superseded: boolean }

// A bash call's guard check: the denial reason, or undefined when content may land.
export type ConfigCallGuard = (content: string, destination: string) => Promise<string | undefined>

type Window = {
  calls: Map<symbol, ConfigCallGuard>
  trusted: ConfigFileEntry
  generation: number | undefined
  // A blocked change whose rollback failed: the trusted view stays in force,
  // even with no call in flight, until the file is back to an authorized state.
  recovery: boolean
  // False once the window could not be captured under the config lock or
  // published: a host command may then have built on unchecked bytes, so its
  // commits are not trusted to skip the post-bash check.
  coordinated: boolean
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
    return read === undefined ? { kind: 'other', id: identityOf(link) } : { kind: 'file', ...read }
  }
  let target: string
  let resolved: string
  try {
    target = readlinkSync(file)
    resolved = realpathSync(file)
  } catch {
    return { kind: 'other', id: identityOf(link) }
  }
  const resolvedStats = lstatOrUndefined(resolved)
  const read = resolvedStats === undefined ? undefined : readRegularSync(resolved, resolvedStats)
  if (read === undefined) return { kind: 'other', id: identityOf(link) }
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
  return { generation: parsed.generation, bytes, superseded: parsed.superseded === true }
}

// Records `content` as the last authorized commit of `file`. Callers hold the
// config file lock and have just written exactly these bytes.
export function recordConfigCommitSync(file: string, content: string | Buffer | undefined): number {
  const key = resolve(file)
  const bytes = content === undefined ? undefined : Buffer.from(content)
  const generation = (readConfigCommitSync(file)?.generation ?? 0) + 1
  const superseded = supersededCandidates.delete(key)
  writeStateFileSync(commitPath(file), {
    generation,
    content: bytes === undefined ? null : bytes.toString('base64'),
    superseded,
  })
  const window = windows.get(key)
  if (window !== undefined) {
    const live = readConfigEntrySync(file)
    window.trusted = equalBytes(contentOf(live), bytes) ? live : withContent(window.trusted, bytes)
    window.generation = generation
    window.recovery = false
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
): Promise<number | undefined> {
  const key = resolve(file)
  if (!windows.has(key)) {
    try {
      await withConfigFileLock(file, async () => captureWindow(file, true))
    } catch (error) {
      if (!windows.has(key)) {
        console.warn(
          `[typeclaw] could not take the ${basename(file)} lock to coordinate a bash command with host typeclaw commands (${errorText(error)}); its changes to ${basename(file)} are checked against the last state known to the agent`,
        )
        captureWindow(file, false)
      }
    }
  }
  windows.get(key)?.calls.set(call, guard)
  return trustedConfigState(file).generation
}

export function markRuntimeOwnsConfigWindows(): void {
  runtimeOwnsWindows = true
}

export function closeConfigWindow(file: string, call: symbol): void {
  const window = windows.get(resolve(file))
  if (window === undefined) return
  window.calls.delete(call)
  settleWindow(file, window)
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
    window.trusted = equalBytes(contentOf(live), commit.bytes) ? live : withContent(window.trusted, commit.bytes)
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

export function setConfigRecovery(file: string, recovery: boolean): void {
  const window = windows.get(resolve(file))
  if (window !== undefined) window.recovery = recovery
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
    const live = readConfigEntrySync(file)
    // In another process (host `typeclaw start`, CLI reads), an agent that has
    // a window open, or stopped with one, may have left rejected bytes on disk.
    const published = runtimeOwnsWindows ? undefined : publishedTrustedEntry(file)
    return textOf(file, published !== undefined && !sameConfigContent(live, published) ? published : live)
  }
  const live = readConfigEntrySync(file)
  const { entry: trusted } = trustedConfigState(file)
  if (!sameConfigContent(live, trusted)) return textOf(file, trusted)
  if (window.recovery) {
    window.recovery = false
    settleWindow(file, window)
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
    const trusted = publishedTrustedEntry(file)
    if (trusted === undefined) continue
    if (!sameConfigContent(readConfigEntrySync(file), trusted)) {
      try {
        withConfigFileLockSync(file, () => {
          const live = readConfigEntrySync(file)
          if (sameConfigContent(live, trusted)) return
          restoreConfigEntrySync(file, live, withContent(live, contentOf(trusted)))
          recordConfigCommitSync(file, contentOf(trusted))
        })
      } catch (error) {
        throw new Error(
          `${name} holds a bash change that was never checked or that was blocked and could not be reverted (${errorText(error)}); refusing to load it. Restore it with \`git checkout -- ${name}\` in the agent folder, delete ${windowPath(file)}, then start the agent again.`,
        )
      }
      console.warn(
        `[typeclaw] ${name} held a bash change that was never checked or that was blocked and could not be reverted before the agent stopped; it was reverted to the last authorized ${name} at startup`,
      )
    }
    rmSync(windowPath(file), { force: true })
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

function captureWindow(file: string, publish: boolean): void {
  const key = resolve(file)
  if (windows.has(key)) return
  const window: Window = {
    calls: new Map(),
    trusted: readConfigEntrySync(file),
    generation: readConfigCommitSync(file)?.generation,
    recovery: false,
    coordinated: publish,
  }
  windows.set(key, window)
  if (publish) publishWindow(file, window)
}

function settleWindow(file: string, window: Window): void {
  if (window.calls.size > 0 || window.recovery) {
    publishWindow(file, window)
    return
  }
  windows.delete(resolve(file))
  try {
    rmSync(windowPath(file), { force: true })
  } catch (error) {
    console.warn(
      `[typeclaw] could not clear the published ${basename(file)} state (${errorText(error)}); host typeclaw config commands keep building on the last authorized ${basename(file)} until the agent restarts`,
    )
  }
}

function publishWindow(file: string, window: Window): void {
  if (!window.coordinated) return
  const bytes = contentOf(window.trusted)
  try {
    writeStateFileSync(windowPath(file), {
      generation: window.generation ?? 0,
      content: bytes === undefined ? null : bytes.toString('base64'),
    })
  } catch (error) {
    window.coordinated = false
    console.warn(
      `[typeclaw] could not publish the trusted ${basename(file)} state (${errorText(error)}); changes to ${basename(file)} during this bash command are checked against the last state known to the agent`,
    )
  }
}

// The trusted state a runtime published for its open window, advanced to any
// newer commit, or undefined when no window is open. Published state that exists
// but cannot be read is an error, never a reason to trust the file as it is.
function publishedTrustedEntry(file: string): ConfigFileEntry | undefined {
  const path = windowPath(file)
  let published: Record<string, unknown> | undefined
  try {
    published = readStateFileSync(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOTDIR') return undefined
    throw unreadableWindowState(file, path, errorText(error))
  }
  if (published === undefined) return undefined
  const { generation, content } = published
  if (typeof generation !== 'number' || (content !== null && typeof content !== 'string')) {
    throw unreadableWindowState(file, path, 'it is not valid window state')
  }
  const commit = readConfigCommitSync(file)
  if (commit !== undefined && commit.generation > generation) return withContent({ kind: 'missing' }, commit.bytes)
  return withContent({ kind: 'missing' }, typeof content === 'string' ? Buffer.from(content, 'base64') : undefined)
}

function unreadableWindowState(file: string, path: string, detail: string): Error {
  return new Error(
    `${basename(file)} was not changed: the agent's open ${basename(file)} state at ${path} could not be read (${detail}). Restart the agent with \`typeclaw restart\` to clear it, or delete that file while the agent is stopped.`,
  )
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

function statePath(file: string, kind: 'commit' | 'window'): string {
  const absolute = resolve(file)
  return join(dirname(absolute), CREDENTIAL_STAGING_RELATIVE_DIR, `${basename(absolute)}.${kind}.json`)
}
