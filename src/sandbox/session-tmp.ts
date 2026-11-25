import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm } from 'node:fs/promises'
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
// weeks, so a dir is discarded when its last live session releases it.
export const SESSION_TMP_ROOT = '/tmp/typeclaw-session'

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

// Keeps a dir from being discarded for one bash call, which may run
// with no session holding the dir (a watch probe) or outlive its session's
// dispose (a tool still unwinding). Releasing a lease never discards.
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
  const move = rename(join(root, name), trash).then(
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

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
