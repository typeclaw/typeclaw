import { mkdir } from 'node:fs/promises'
import { posix } from 'node:path'

// Container-only code over the POSIX `/tmp`; pinned to `path.posix` so the test
// suite produces the same backing paths on a win32 runner (default `node:path`
// would yield `\tmp\…` and diverge from the Linux runtime).
const { isAbsolute, join, relative, resolve } = posix

// Per-session scratch lives on the REAL container /tmp, namespaced by session id.
// It sits OUTSIDE the agent folder on purpose: the agent folder's `sessions/` is
// force-committed by typeclaw, and scratch must never be committed. The real
// /tmp is ephemeral (dies with the container) and already the natural home for
// throwaway files, so a per-session subdir of it gives `/tmp` semantics without
// either sharing the whole container /tmp into a sandboxed role or persisting
// anything into the project surface.
export const SESSION_TMP_ROOT = '/tmp/typeclaw-session'

// A subagent tree shares one scratch dir: its top-level subagent's. Runtime-
// owned scratch (a reviewer checkout) is handed to child subagents by `/tmp`
// path, and a child with its own `/tmp` cannot resolve it. The scope is anchored
// BELOW the spawning channel/TUI/cron session on purpose: that session persists
// across turns and speakers, so subagent artifacts must never land in its
// scratch. Unrelated sessions stay isolated. Each entry is resolved to its
// anchor at registration, so releasing an intermediate parent never re-routes a
// still-running grandchild.
const subagentTmpScopes = new Map<string, { scope: string; refs: number }>()

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

export async function ensureSessionTmpDir(sessionId: string): Promise<string> {
  const dir = sessionTmpDir(sessionId)
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

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
