import type { AgentGit } from '@/git/resolve-agent-git'

import type { GitSpawn } from './runner'

// The backup runner and the memory dreaming subagent commit continuously and
// nothing ever repacks or prunes (there is no other gc in the codebase), so a
// long-running agent's repo accumulates packs without bound. The secret-history
// guard runs `git fsck` / `rev-list --objects --all` before EVERY model bash
// call, and its runtime AND memory footprint scale with the object/pack count —
// on a production agent this reached 869k objects / 40 packs / 1.4GB, and the
// per-bash fsck's ~850MB RSS directly contributed to a container OOM.
//
// This runs `git gc` after a successful backup, gated on the pack count so the
// common quiet backup stays cheap. The gate read (`git count-objects -v`) does
// NOT walk the object graph. Maintenance is strictly best-effort: every failure
// is swallowed so it can never fail a backup that already committed/pushed, and
// it runs under the same `withGitLock` the backup runner already holds.

export const DEFAULT_GC_PACK_THRESHOLD = 20

// `git gc` on a large repo can take a while; give it materially more headroom
// than an ordinary local command. Still bounded so a wedged gc can't hang the
// runner indefinitely (the AbortController in makeDefaultGitSpawn enforces it).
export const GC_TIMEOUT_MS = 300_000

export type GcMaintenanceOptions = {
  cwd: string
  repo: AgentGit
  gitSpawn: GitSpawn
  // When packs >= this, run gc. 0 (or negative) disables maintenance entirely.
  packThreshold: number
  timeoutMs?: number
  logger?: { info: (m: string) => void; warn: (m: string) => void }
}

export type GcMaintenanceResult =
  | { ran: false; reason: 'disabled' | 'below-threshold' | 'count-failed' }
  | { ran: true; ok: boolean; packsBefore: number }

// Reads the current pack count and, if it meets the threshold, runs `git gc`.
// Never throws: a maintenance failure is logged and reported, never propagated.
export async function maybeRunGitGc(options: GcMaintenanceOptions): Promise<GcMaintenanceResult> {
  const { cwd, repo, gitSpawn, packThreshold, logger } = options
  if (packThreshold <= 0) return { ran: false, reason: 'disabled' }

  const timeoutMs = options.timeoutMs ?? GC_TIMEOUT_MS

  const count = await gitSpawn([...repo.gitArgs, 'count-objects', '-v'], { cwd, timeoutMs: 30_000 })
  if (count.exitCode !== 0) {
    logger?.warn(`[backup] git maintenance skipped: count-objects failed (exit ${count.exitCode})`)
    return { ran: false, reason: 'count-failed' }
  }

  const packs = parsePackCount(count.stdout)
  if (packs < packThreshold) return { ran: false, reason: 'below-threshold' }

  logger?.info(`[backup] git gc: ${packs} pack(s) >= threshold ${packThreshold}, repacking`)
  const gc = await gitSpawn([...repo.gitArgs, 'gc', '--quiet'], { cwd, timeoutMs })
  if (gc.exitCode !== 0) {
    logger?.warn(`[backup] git gc failed (exit ${gc.exitCode}); repo maintenance deferred to next cycle`)
    return { ran: true, ok: false, packsBefore: packs }
  }
  return { ran: true, ok: true, packsBefore: packs }
}

// `git count-objects -v` emits `key: value` lines; `packs` is the number of
// pack files. Absent/malformed output is treated as 0 packs (no gc), matching
// the fail-safe posture — maintenance is best-effort and never blocks a backup.
export function parsePackCount(stdout: string): number {
  for (const line of stdout.split('\n')) {
    const match = /^packs:\s*(\d+)\s*$/.exec(line.trim())
    if (match?.[1] !== undefined) return Number.parseInt(match[1], 10)
  }
  return 0
}
