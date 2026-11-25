import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { posix } from 'node:path'

// Container-only code over the POSIX `/tmp`; pinned to `path.posix` so the test
// suite produces the same backing paths on a win32 runner (default `node:path`
// would yield `\tmp\…` and diverge from the Linux runtime).
const { basename, dirname, isAbsolute, join, relative, resolve } = posix

// Per-session scratch lives on the REAL container /tmp, namespaced by session id.
// It sits OUTSIDE the agent folder on purpose: the agent folder's `sessions/` is
// force-committed by typeclaw, and scratch must never be committed. A per-session
// subdir of /tmp gives `/tmp` semantics without either sharing the whole
// container /tmp into a sandboxed role or persisting anything into the project
// surface. The container /tmp only dies with the container, and agents run for
// weeks, so a dir is discarded when its last live session releases it and
// periodically swept (`sweepSessionTmp`) for anything a crash left behind.
export const SESSION_TMP_ROOT = '/tmp/typeclaw-session'

// A dir that no live session holds but that was touched this recently is left
// alone by the periodic sweep, so a scratch user outside the session factory
// (one short bash run) is never swept mid-use.
export const SESSION_TMP_SWEEP_MIN_AGE_MS = 60 * 60 * 1000
export const SESSION_TMP_SWEEP_INTERVAL_MS = 60 * 60 * 1000

const DISCARD_PREFIX = '.discard-'

// A subagent tree shares one scratch dir: its top-level subagent's. Runtime-
// owned scratch (a reviewer checkout) is handed to child subagents by `/tmp`
// path, and a child with its own `/tmp` cannot resolve it. The scope is anchored
// BELOW the spawning channel/TUI/cron session on purpose: that session persists
// across turns and speakers, so subagent artifacts must never land in its
// scratch. Unrelated sessions stay isolated. Each entry is resolved to its
// anchor at registration, so releasing an intermediate parent never re-routes a
// still-running grandchild.
const subagentTmpScopes = new Map<string, { scope: string; refs: number }>()

// Claims per scratch dir name: session holds plus in-flight bash leases. A
// subagent tree and a rehydrated channel session can share one dir, so a hold
// discards it only when the last claim goes away.
const liveTmpHolders = new Map<string, number>()

// A move-aside in flight per dir name. Preparing a dir waits for it, so a
// session claiming a name mid-discard gets a fresh dir instead of one the
// pending rename is about to take away.
const pendingMoves = new Map<string, Promise<void>>()

let renameDir: typeof rename = rename

// Lets a test hold a move-aside mid-rename to exercise overlapping discards.
export function __setSessionTmpRenameForTesting(fn: typeof rename | undefined): void {
  renameDir = fn ?? rename
}

export function sessionTmpDir(sessionId: string): string {
  return join(SESSION_TMP_ROOT, subagentTmpScopes.get(sessionId)?.scope ?? sessionId)
}

export function enterSubagentTmpScope(sessionId: string, parentSessionId: string): () => void {
  const existing = subagentTmpScopes.get(sessionId)
  const scope = existing?.scope ?? subagentTmpScopes.get(parentSessionId)?.scope ?? sessionId
  subagentTmpScopes.set(sessionId, { scope, refs: (existing?.refs ?? 0) + 1 })
  let released = false
  return () => {
    if (released) return
    released = true
    const entry = subagentTmpScopes.get(sessionId)
    if (entry === undefined) return
    if (entry.refs <= 1) subagentTmpScopes.delete(sessionId)
    else entry.refs -= 1
  }
}

// Resolves the dir at hold time, so call it after `enterSubagentTmpScope`. The
// returned release discards the dir when it drops the last claim.
export function holdSessionTmp(sessionId: string): () => Promise<void> {
  const name = scratchName(sessionId)
  if (name === undefined) return async () => {}
  claim(name)
  let released = false
  return async () => {
    if (released) return
    released = true
    if (!unclaim(name)) return
    const trash = await moveAside(SESSION_TMP_ROOT, name)
    if (trash !== undefined) await rm(trash, { recursive: true, force: true })
  }
}

// Keeps a dir out of every discard and sweep for one bash call, which may run
// with no session holding the dir (a watch probe) or outlive its session's
// dispose (a tool still unwinding). Releasing a lease never discards; a dir it
// outlived is reclaimed by the sweep.
export function leaseSessionTmp(sessionId: string): () => void {
  const name = scratchName(sessionId)
  if (name === undefined) return () => {}
  claim(name)
  let released = false
  return () => {
    if (released) return
    released = true
    unclaim(name)
  }
}

// Sweeps once at boot (`minAgeMs: 0`: nothing is live yet, so everything there
// is a previous run's debris) and then hourly for dirs a missed release left.
export function startSessionTmpSweeper(log: (message: string) => void): () => void {
  const sweep = (minAgeMs?: number) =>
    sweepSessionTmp({ log, ...(minAgeMs !== undefined ? { minAgeMs } : {}) }).then(
      (removed) => {
        if (removed > 0) log(`[session-tmp] swept ${removed} orphaned session scratch dir(s)`)
      },
      (err: unknown) => log(`[session-tmp] sweep failed: ${describeError(err)}`),
    )
  void sweep(0)
  const timer = setInterval(() => void sweep(), SESSION_TMP_SWEEP_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

// Removes scratch dirs nothing claims and returns how many. Every eligible dir
// is renamed aside before any delete starts, so the window in which a new
// session could claim a dir being swept stays at one rename, not one recursive
// delete of a large checkout. A failing entry is logged and skipped.
export async function sweepSessionTmp(
  options: { root?: string; minAgeMs?: number; now?: number; log?: (message: string) => void } = {},
): Promise<number> {
  const root = options.root ?? SESSION_TMP_ROOT
  const minAgeMs = options.minAgeMs ?? SESSION_TMP_SWEEP_MIN_AGE_MS
  const now = options.now ?? Date.now()
  let names: string[]
  try {
    names = await readdir(root)
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) return 0
    throw error
  }
  const trash: { dir: string; counted: boolean }[] = []
  for (const name of names) {
    if (name.startsWith(DISCARD_PREFIX)) {
      trash.push({ dir: join(root, name), counted: false })
      continue
    }
    if (minAgeMs > 0) {
      const info = await stat(join(root, name)).catch(() => undefined)
      if (info === undefined || now - info.mtimeMs < minAgeMs) continue
    }
    // Checked after the last await, so the claim test and the move registration
    // run in one synchronous step.
    // A dir already being moved aside is that discard's to finish.
    if (liveTmpHolders.has(name) || pendingMoves.has(name)) continue
    try {
      const moved = await moveAside(root, name)
      if (moved !== undefined) trash.push({ dir: moved, counted: true })
    } catch (error) {
      options.log?.(`[session-tmp] could not move ${name} aside: ${describeError(error)}`)
    }
  }
  let removed = 0
  for (const { dir, counted } of trash) {
    try {
      await rm(dir, { recursive: true, force: true })
      if (counted) removed++
    } catch (error) {
      options.log?.(`[session-tmp] could not delete ${dir}: ${describeError(error)}`)
    }
  }
  return removed
}

export async function ensureSessionTmpDir(sessionId: string): Promise<string> {
  const dir = sessionTmpDir(sessionId)
  await pendingMoves.get(basename(dir))
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

export function isUnderTmp(agentDir: string, rawPath: string): boolean {
  const resolved = resolve(agentDir, rawPath)
  return isVirtualTmpPath(agentDir, resolved)
}

// Maps a model-facing /tmp path to its per-session backing path. Returns
// undefined when the path is not under /tmp (caller leaves it untouched). The
// model keeps writing/reading `/tmp/foo`; only the on-disk target moves to
// `<SESSION_TMP_ROOT>/<sid>/foo`, which is the same dir bwrap binds over `/tmp`
// for the sandboxed bash that reads it back.
export function mapVirtualTmpPath(agentDir: string, sessionId: string, rawPath: string): string | undefined {
  const resolved = resolve(agentDir, rawPath)
  if (!isVirtualTmpPath(agentDir, resolved)) return undefined
  const rel = relative('/tmp', resolved)
  return rel === '' ? sessionTmpDir(sessionId) : join(sessionTmpDir(sessionId), rel)
}

function isVirtualTmpPath(agentDir: string, resolved: string): boolean {
  const resolvedAgentDir = resolve(agentDir)
  if (resolved === resolvedAgentDir || isInside(resolvedAgentDir, resolved)) return false
  return resolved === '/tmp' || isInside('/tmp', resolved)
}

// Only a direct, non-hidden child of the scratch root is ever claimed or
// discarded. A malformed restored session id (`../x`, `a/b`) resolves elsewhere,
// and recursive deletion must never follow it there.
function scratchName(sessionId: string): string | undefined {
  const dir = sessionTmpDir(sessionId)
  const name = basename(dir)
  return dirname(dir) === SESSION_TMP_ROOT && name !== '' && !name.startsWith('.') ? name : undefined
}

function claim(name: string): void {
  liveTmpHolders.set(name, (liveTmpHolders.get(name) ?? 0) + 1)
}

// Returns true when this dropped the last claim.
function unclaim(name: string): boolean {
  const refs = (liveTmpHolders.get(name) ?? 1) - 1
  if (refs > 0) {
    liveTmpHolders.set(name, refs)
    return false
  }
  liveTmpHolders.delete(name)
  return true
}

// Registers the move synchronously, before any await, so a claim that follows
// it in the same turn already sees it pending. A request for a dir whose move is
// already in flight joins it instead of issuing a second rename: once the first
// settles, a waiting claimant may have recreated the dir, and a late second
// rename would take that fresh dir away.
function moveAside(root: string, name: string): Promise<string | undefined> {
  const inFlight = pendingMoves.get(name)
  if (inFlight !== undefined) return inFlight.then(() => undefined)
  const trash = join(root, `${DISCARD_PREFIX}${name}-${randomUUID()}`)
  const move = renameDir(join(root, name), trash).then(
    () => trash,
    (error: unknown) => {
      if (isErrnoCode(error, 'ENOENT')) return undefined
      throw error
    },
  )
  const settled = move.then(
    () => {},
    () => {},
  )
  pendingMoves.set(name, settled)
  void settled.then(() => {
    if (pendingMoves.get(name) === settled) pendingMoves.delete(name)
  })
  return move
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
