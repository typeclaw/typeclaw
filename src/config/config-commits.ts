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
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type BigIntStats,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { CREDENTIAL_STAGING_RELATIVE_DIR, ensureOwnerOnlyDir } from '@/init/staged-write'

// typeclaw.json and cron.json are guarded on every write/edit, but model bash for
// roles that keep agent-root writes changes them directly and is checked only
// after the call (src/agent/tool-file-safety.ts). This module keeps the state
// that makes that after-the-fact check safe:
//
// - The last AUTHORIZED commit of each file: bytes written under the config file
//   lock by a checked write/edit, a host CLI command, or a passed post-bash
//   check. It lives in the credential staging dir, which is owner-only and masked
//   from every model tool and every bash role, so bash cannot forge it.
// - While any bash call is in flight, the VALIDATED state of each file in this
//   process. Runtime readers (config/cron reload, the guards' own baselines) use
//   it instead of bytes no check has passed yet.

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

export type ConfigCommit = { generation: number; bytes: Buffer | undefined }

type Window = { count: number; validated: ConfigFileEntry; generation: number | undefined }

const windows = new Map<string, Window>()
const baselineOverride = new AsyncLocalStorage<{ file: string; bytes: Buffer | undefined }>()

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
  let raw: string
  try {
    raw = readFileSync(commitPath(file), 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as { generation?: unknown; content?: unknown }
    if (typeof parsed.generation !== 'number') return undefined
    const bytes = typeof parsed.content === 'string' ? Buffer.from(parsed.content, 'base64') : undefined
    return { generation: parsed.generation, bytes }
  } catch {
    return undefined
  }
}

// Records `content` as the last authorized commit of `file`. Callers hold the
// config file lock and have just written exactly these bytes.
export function recordConfigCommitSync(file: string, content: string | Buffer | undefined): number {
  const bytes = content === undefined ? undefined : Buffer.from(content)
  const generation = (readConfigCommitSync(file)?.generation ?? 0) + 1
  const destination = commitPath(file)
  ensureOwnerOnlyDir(dirname(destination))
  const temporary = `${destination}.${process.pid}.${generation}.tmp`
  writeFileSync(
    temporary,
    JSON.stringify({ generation, content: bytes === undefined ? null : bytes.toString('base64') }),
    { mode: 0o600, flag: 'wx' },
  )
  try {
    renameSync(temporary, destination)
  } catch (error) {
    unlinkSync(temporary)
    throw error
  }
  const window = windows.get(resolve(file))
  if (window !== undefined) {
    const live = readConfigEntrySync(file)
    window.validated = equalBytes(contentOf(live), bytes) ? live : withContent(window.validated, bytes)
    window.generation = generation
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
      `[typeclaw] could not record the ${basename(file)} commit (${error instanceof Error ? error.message : String(error)}); a bash command running in the agent now may revert this change`,
    )
  }
}

// Opened by each bash call before it runs and closed after its post-call check.
// The first open captures the file as validated: no unchecked bash bytes can be
// on disk while no bash call is in flight.
export function openConfigWindowSync(file: string): void {
  const key = resolve(file)
  const window = windows.get(key)
  if (window !== undefined) {
    window.count += 1
    return
  }
  windows.set(key, {
    count: 1,
    validated: readConfigEntrySync(file),
    generation: readConfigCommitSync(file)?.generation,
  })
}

export function closeConfigWindow(file: string): void {
  const key = resolve(file)
  const window = windows.get(key)
  if (window === undefined) return
  window.count -= 1
  if (window.count === 0) windows.delete(key)
}

export function validatedConfigState(file: string): { entry: ConfigFileEntry; generation: number | undefined } {
  const window = windows.get(resolve(file))
  if (window === undefined) throw new Error(`${basename(file)} has no open bash config window`)
  return { entry: window.validated, generation: window.generation }
}

export function setValidatedConfigEntry(file: string, entry: ConfigFileEntry): void {
  const window = windows.get(resolve(file))
  if (window !== undefined) window.validated = entry
}

// The commit that supersedes the validated state: one an authorized writer in
// another process made after the validated state was captured.
export function newerConfigCommit(file: string, generation: number | undefined): ConfigCommit | undefined {
  const commit = readConfigCommitSync(file)
  if (commit === undefined) return undefined
  return generation === undefined || commit.generation > generation ? commit : undefined
}

export function withContent(entry: ConfigFileEntry, bytes: Buffer | undefined): ConfigFileEntry {
  if (bytes === undefined) return { kind: 'missing' }
  if (entry.kind === 'file' || entry.kind === 'link') return { ...entry, bytes }
  return { kind: 'file', bytes, mode: 0o644, id: zeroIdentity() }
}

// What runtime readers load. With no bash call in flight this is the file. While
// one is, bytes that differ from the validated state and from any newer
// authorized commit have not passed a check yet, so the validated (or newer
// committed) bytes are returned instead. Throws ENOENT for a missing file, like
// readFileSync.
export function readValidatedConfigFileSync(file: string): string {
  const window = windows.get(resolve(file))
  if (window === undefined) return readFileSync(file, 'utf8')
  const live = readConfigEntrySync(file)
  if (sameConfigContent(live, window.validated)) return textOf(file, live)
  const commit = newerConfigCommit(file, window.generation)
  if (commit !== undefined) {
    return equalBytes(contentOf(live), commit.bytes)
      ? textOf(file, live)
      : textOf(file, withContent(live, commit.bytes))
  }
  return textOf(file, window.validated)
}

// The baseline a typeclaw.json/cron.json guard compares a proposed change to.
// The post-bash check passes the validated bytes explicitly, so the guards never
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
  // Not one regular file (a directory or FIFO): read it as loaders always have.
  if (entry.kind === 'other') return readFileSync(file, 'utf8')
  return entry.bytes.toString('utf8')
}

function notFound(file: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' })
}

function commitPath(file: string): string {
  const absolute = resolve(file)
  return join(dirname(absolute), CREDENTIAL_STAGING_RELATIVE_DIR, `${basename(absolute)}.commit.json`)
}
