import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { CommitOutcome, FixAttempt } from './types'

export type CommitOptions = {
  cwd: string
  attempts: FixAttempt[]
  spawnGit?: SpawnGit
}

export type GitResult = { exitCode: number; stdout: string; stderr: string }
export type SpawnGit = (args: string[], cwd: string) => Promise<GitResult>

export async function commitAutoFixes(opts: CommitOptions): Promise<CommitOutcome> {
  const successes = opts.attempts.filter((a): a is Extract<FixAttempt, { ok: true }> => a.ok === true)
  if (successes.length === 0) {
    return { kind: 'skipped', reason: 'no successful auto-fixes' }
  }

  const pathsStaged = uniqueSorted(successes.flatMap((a) => a.changedPaths))
  if (pathsStaged.length === 0) {
    return { kind: 'skipped', reason: 'auto-fixes reported no changed paths' }
  }

  if (!existsSync(join(opts.cwd, '.git'))) {
    return { kind: 'skipped', reason: 'agent folder is not a git repo (.git missing)' }
  }

  const spawnGit = opts.spawnGit ?? defaultSpawnGit

  const dirty = await spawnGit(['diff', '--cached', '--quiet'], opts.cwd)
  if (dirty.exitCode !== 0) {
    return {
      kind: 'skipped',
      reason: 'git index is not clean; refusing to mix doctor auto-fixes with unrelated staged changes',
    }
  }

  const add = await spawnGit(['add', '--', ...pathsStaged], opts.cwd)
  if (add.exitCode !== 0) {
    return { kind: 'failed', reason: `git add failed: ${add.stderr.trim() || `exit ${add.exitCode}`}` }
  }

  const message = buildCommitMessage(opts.attempts)
  const commit = await spawnGit(['commit', '-m', message], opts.cwd)
  if (commit.exitCode !== 0) {
    return { kind: 'failed', reason: `git commit failed: ${commit.stderr.trim() || `exit ${commit.exitCode}`}` }
  }

  const sha = await spawnGit(['rev-parse', 'HEAD'], opts.cwd)
  const commitSha = sha.exitCode === 0 ? sha.stdout.trim() : ''
  return { kind: 'committed', commitSha, pathsStaged }
}

export function buildCommitMessage(attempts: FixAttempt[]): string {
  const successes = attempts.filter((a): a is Extract<FixAttempt, { ok: true }> => a.ok === true)
  const subject = `typeclaw doctor: auto-fix ${successes.length} issue${successes.length === 1 ? '' : 's'}`
  const body = successes.map((a) => `- [${a.source}] ${a.name}: ${a.summary}`).join('\n')
  return `${subject}\n\n${body}\n`
}

const defaultSpawnGit: SpawnGit = async (args, cwd) => {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return { exitCode: -1, stdout: '', stderr: 'bun runtime not available' }
  try {
    const proc = bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    return { exitCode, stdout, stderr }
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}
