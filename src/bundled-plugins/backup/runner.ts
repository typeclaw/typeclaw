import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { hooklessGitArgs } from '@/git/hookless'
import { type AgentGit, resolveAgentGit } from '@/git/resolve-agent-git'

import { DEFAULT_GC_PACK_THRESHOLD, maybeRunGitGc } from './maintenance'

export const COMMIT_TIMEOUT_MS = 30_000
export const NETWORK_TIMEOUT_MS = 60_000

const RUNTIME_OWNED_PREFIXES = ['memory/'] as const
const FORCE_ADD_PREFIXES = ['sessions/', 'todo/'] as const

const NONINTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GCM_INTERACTIVE: 'never',
} as const

export type GitSpawnResult = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export type GitSpawn = (
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number; env?: Record<string, string> },
) => Promise<GitSpawnResult>

export type BackupRunnerDeps = {
  gitSpawn: GitSpawn
  pickCommitMessage: (input: { status: string; diffstat: string }) => Promise<string>
  diagnoseFailure?: (input: BackupFailureInput) => Promise<void>
  // Credential env (GIT_ASKPASS/TYPECLAW_GIT_TOKEN/insteadOf) applied ONLY to
  // network git invocations (push/fetch). It is deliberately NOT given to local
  // commands — `git commit` can run repo-controlled hooks, which must never see
  // the minted token.
  pushEnv?: Record<string, string>
  logger?: { info: (m: string) => void; warn: (m: string) => void }
  now?: () => number
}

export type BackupRunnerOptions = {
  cwd: string
  pushToOrigin: boolean
  // Pack-count threshold for the post-commit `git gc`. 0 disables maintenance.
  gcPackThreshold?: number
}

export type BackupFailureInput = {
  cwd: string
  stage: 'push' | 'rebase'
  exitCode: number
  stderr: string
  stdout: string
}

export type BackupResult =
  | { ok: true; kind: 'no-repo' | 'clean' | 'committed' | 'pushed' | 'pushed-set-upstream' | 'rebased-and-pushed' }
  | { ok: false; kind: 'commit-failed' | 'push-failed' | 'rebase-failed' | 'aborted'; reason: string }

type ActivePushPlan =
  | { kind: 'upstream'; upstreamRef: string }
  | { kind: 'set-upstream'; remote: string; branch: string }

type PushPlan = ActivePushPlan | { kind: 'skip' }

export async function runBackup(options: BackupRunnerOptions, deps: BackupRunnerDeps): Promise<BackupResult> {
  const { cwd, pushToOrigin } = options
  const gcPackThreshold = options.gcPackThreshold ?? DEFAULT_GC_PACK_THRESHOLD

  const repo = resolveAgentGit(cwd)
  if (!repo) return { ok: true, kind: 'no-repo' }

  const status = await deps.gitSpawn([...repo.gitArgs, 'status', '--porcelain=v1', '--untracked-files=all'], {
    cwd,
    timeoutMs: COMMIT_TIMEOUT_MS,
  })
  if (status.exitCode !== 0) return { ok: false, kind: 'aborted', reason: `git status failed: ${shortErr(status)}` }
  const dirty = filterAgentOwned(parsePorcelain(status.stdout))
  const force = filterForceAdd(parsePorcelain(status.stdout))
  if (dirty.length === 0 && force.length === 0) return { ok: true, kind: 'clean' }

  if (dirty.length > 0) {
    const add = await deps.gitSpawn([...repo.gitArgs, 'add', '--', ...dirty], { cwd, timeoutMs: COMMIT_TIMEOUT_MS })
    if (add.exitCode !== 0) return { ok: false, kind: 'commit-failed', reason: `git add failed: ${shortErr(add)}` }
  }
  if (force.length > 0) {
    const present = force.filter((p) => existsSync(join(cwd, p)))
    if (present.length > 0) {
      const addF = await deps.gitSpawn([...repo.gitArgs, 'add', '-f', '--', ...present], {
        cwd,
        timeoutMs: COMMIT_TIMEOUT_MS,
      })
      if (addF.exitCode !== 0) {
        return { ok: false, kind: 'commit-failed', reason: `git add -f failed: ${shortErr(addF)}` }
      }
    }
  }

  const stagedCheck = await deps.gitSpawn([...repo.gitArgs, 'diff', '--cached', '--quiet'], {
    cwd,
    timeoutMs: COMMIT_TIMEOUT_MS,
  })
  if (stagedCheck.exitCode === 0) return { ok: true, kind: 'clean' }

  const diffstat = await deps.gitSpawn([...repo.gitArgs, 'diff', '--cached', '--stat'], {
    cwd,
    timeoutMs: COMMIT_TIMEOUT_MS,
  })
  const message = await deps.pickCommitMessage({
    status: status.stdout.slice(0, 4096),
    diffstat: diffstat.stdout.slice(0, 4096),
  })

  // `pickCommitMessage` may spawn a subagent (the backup plugin's
  // `backup-message`) whose session JSONL lands under `sessions/` after we
  // already staged. Without this second pass that file would sit dirty in
  // the worktree until the NEXT backup cycle, which would then commit it
  // and create another orphan via the same path — a steady-state of
  // one-cycle-behind churn. Re-status, filter to `sessions/` additions
  // only (don't accidentally stage user work that arrived during the
  // window), and force-add anything new.
  const reStatus = await deps.gitSpawn([...repo.gitArgs, 'status', '--porcelain=v1', '--untracked-files=all'], {
    cwd,
    timeoutMs: COMMIT_TIMEOUT_MS,
  })
  if (reStatus.exitCode === 0) {
    const lateForce = filterForceAdd(parsePorcelain(reStatus.stdout)).filter((p) => existsSync(join(cwd, p)))
    if (lateForce.length > 0) {
      const lateAdd = await deps.gitSpawn([...repo.gitArgs, 'add', '-f', '--', ...lateForce], {
        cwd,
        timeoutMs: COMMIT_TIMEOUT_MS,
      })
      if (lateAdd.exitCode !== 0) {
        return { ok: false, kind: 'commit-failed', reason: `git add -f (post-message) failed: ${shortErr(lateAdd)}` }
      }
    }
  }

  const safeMessage = sanitizeCommitMessage(message)
  const commit = await deps.gitSpawn([...repo.gitArgs, 'commit', '-m', safeMessage], {
    cwd,
    timeoutMs: COMMIT_TIMEOUT_MS,
  })
  if (commit.exitCode !== 0)
    return { ok: false, kind: 'commit-failed', reason: `git commit failed: ${shortErr(commit)}` }

  // Repack/prune before pushing so the object count the next per-bash secret
  // fsck must walk stays bounded. Best-effort: maybeRunGitGc never throws, so a
  // gc failure leaves the already-made commit intact and falls through to push.
  await maybeRunGitGc({ cwd, repo, gitSpawn: deps.gitSpawn, packThreshold: gcPackThreshold, logger: deps.logger })

  if (!pushToOrigin) return { ok: true, kind: 'committed' }

  const plan = await resolvePushPlan(cwd, deps, repo)
  if (plan.kind === 'skip') return { ok: true, kind: 'committed' }

  return pushWithRecovery(cwd, deps, repo, plan)
}

// `@{upstream}` resolution failing was previously treated as "no push" — but a
// fresh agent repo that nobody ran `git push -u` on has a configured `origin`
// and no tracking ref, so the runner committed forever and never pushed. The
// correct gate when `pushToOrigin` is on is "origin exists and HEAD is a real
// branch": then we push AND set the upstream in one shot, and every later run
// takes the plain-upstream path. No remote / detached HEAD stays commit-only
// (a legitimate offline state), so it returns `skip` rather than diagnosing.
async function resolvePushPlan(cwd: string, deps: BackupRunnerDeps, repo: AgentGit): Promise<PushPlan> {
  const upstream = await deps.gitSpawn(
    [...repo.gitArgs, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    {
      cwd,
      timeoutMs: COMMIT_TIMEOUT_MS,
    },
  )
  if (upstream.exitCode === 0 && upstream.stdout.trim().length > 0) {
    return { kind: 'upstream', upstreamRef: upstream.stdout.trim() }
  }

  // Only `origin` is acted on: picking "the first remote" when origin is absent
  // would guess a destination the operator never configured. `get-url` (not
  // `get-url --push`) is enough here — we only need to know origin EXISTS and
  // is named `origin`; the push targets `origin` by name regardless of pushurl.
  const origin = await deps.gitSpawn([...repo.gitArgs, 'remote', 'get-url', 'origin'], {
    cwd,
    timeoutMs: COMMIT_TIMEOUT_MS,
  })
  if (origin.exitCode !== 0 || origin.stdout.trim().length === 0) return { kind: 'skip' }

  // `symbolic-ref --short HEAD` fails on a detached HEAD (no branch to set an
  // upstream for); `rev-parse --abbrev-ref HEAD` would have returned the literal
  // "HEAD" and we'd have tried to push a branch named HEAD. Skip cleanly.
  const branch = await deps.gitSpawn([...repo.gitArgs, 'symbolic-ref', '--short', 'HEAD'], {
    cwd,
    timeoutMs: COMMIT_TIMEOUT_MS,
  })
  if (branch.exitCode !== 0 || branch.stdout.trim().length === 0) return { kind: 'skip' }

  return { kind: 'set-upstream', remote: 'origin', branch: branch.stdout.trim() }
}

// Both entry points (plain push and first-time set-upstream push) share the
// non-fast-forward recovery: fetch, rebase onto the intended remote branch,
// re-push. Keeping one helper stops the set-upstream path from silently becoming
// a weaker duplicate that skips recovery.
async function pushWithRecovery(
  cwd: string,
  deps: BackupRunnerDeps,
  repo: AgentGit,
  plan: ActivePushPlan,
): Promise<BackupResult> {
  const pushArgs = [...repo.gitArgs, ...pushArgsFor(plan)]
  const rebaseRef = plan.kind === 'upstream' ? plan.upstreamRef : `${plan.remote}/${plan.branch}`
  // In the set-upstream case there is no tracking ref yet, so a bare `git fetch`
  // has no configured remote to default to — fetch the same remote we rebase
  // onto. The upstream case keeps bare `fetch` (its tracking config resolves it).
  const fetchArgs = [...repo.gitArgs, ...(plan.kind === 'upstream' ? ['fetch'] : ['fetch', plan.remote])]
  const pushedKind: BackupResult = { ok: true, kind: plan.kind === 'upstream' ? 'pushed' : 'pushed-set-upstream' }
  // Credentials ride ONLY on the network calls (push/fetch). The rebase is
  // local (it replays onto an already-fetched remote-tracking ref), so it runs
  // token-free like every other local command.
  const net = { cwd, timeoutMs: NETWORK_TIMEOUT_MS, env: deps.pushEnv }

  const push = await deps.gitSpawn(pushArgs, net)
  if (push.exitCode === 0) return pushedKind

  if (!isNonFastForward(push)) {
    await maybeDiagnose(deps, { cwd, stage: 'push', exitCode: push.exitCode, stderr: push.stderr, stdout: push.stdout })
    return { ok: false, kind: 'push-failed', reason: shortErr(push) }
  }

  const fetch = await deps.gitSpawn(fetchArgs, net)
  if (fetch.exitCode !== 0) {
    await maybeDiagnose(deps, {
      cwd,
      stage: 'push',
      exitCode: fetch.exitCode,
      stderr: fetch.stderr,
      stdout: fetch.stdout,
    })
    return { ok: false, kind: 'push-failed', reason: `git fetch failed: ${shortErr(fetch)}` }
  }

  const rebase = await deps.gitSpawn([...repo.gitArgs, 'rebase', rebaseRef], { cwd, timeoutMs: NETWORK_TIMEOUT_MS })
  if (rebase.exitCode !== 0) {
    await deps.gitSpawn([...repo.gitArgs, 'rebase', '--abort'], { cwd, timeoutMs: COMMIT_TIMEOUT_MS })
    await maybeDiagnose(deps, {
      cwd,
      stage: 'rebase',
      exitCode: rebase.exitCode,
      stderr: rebase.stderr,
      stdout: rebase.stdout,
    })
    return { ok: false, kind: 'rebase-failed', reason: `git rebase failed: ${shortErr(rebase)}` }
  }

  const push2 = await deps.gitSpawn(pushArgs, net)
  if (push2.exitCode !== 0) {
    await maybeDiagnose(deps, {
      cwd,
      stage: 'push',
      exitCode: push2.exitCode,
      stderr: push2.stderr,
      stdout: push2.stdout,
    })
    return { ok: false, kind: 'push-failed', reason: `git push (post-rebase) failed: ${shortErr(push2)}` }
  }
  return { ok: true, kind: 'rebased-and-pushed' }
}

function pushArgsFor(plan: ActivePushPlan): string[] {
  if (plan.kind === 'upstream') return ['push']
  // `HEAD:<branch>` is explicit about pushing the current commit to the named
  // remote branch, avoiding any reliance on local refspec defaults.
  return ['push', '-u', plan.remote, `HEAD:${plan.branch}`]
}

async function maybeDiagnose(deps: BackupRunnerDeps, input: BackupFailureInput): Promise<void> {
  if (!deps.diagnoseFailure) return
  try {
    await deps.diagnoseFailure(input)
  } catch {
    // Diagnosis is advisory; never let it mask the original failure.
  }
}

function shortErr(r: GitSpawnResult): string {
  if (r.timedOut) return `timed out (exit ${r.exitCode})`
  const text = r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

function isNonFastForward(r: GitSpawnResult): boolean {
  const blob = `${r.stderr}\n${r.stdout}`.toLowerCase()
  return blob.includes('non-fast-forward') || blob.includes('updates were rejected')
}

export function parsePorcelain(stdout: string): string[] {
  const out: string[] = []
  for (const raw of stdout.split('\n')) {
    if (raw.length < 4) continue
    const rest = raw.slice(3)
    const arrowIdx = rest.indexOf(' -> ')
    out.push(arrowIdx === -1 ? rest : rest.slice(arrowIdx + 4))
  }
  return out
}

function filterAgentOwned(paths: readonly string[]): string[] {
  return paths.filter((p) => !RUNTIME_OWNED_PREFIXES.some((pre) => p.startsWith(pre)))
}

function filterForceAdd(paths: readonly string[]): string[] {
  return paths.filter((p) => FORCE_ADD_PREFIXES.some((pre) => p.startsWith(pre)))
}

function sanitizeCommitMessage(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return 'Backup'
  const subject = trimmed.split('\n')[0]?.slice(0, 200) ?? 'Backup'
  const rest = trimmed.split('\n').slice(1).join('\n').trim()
  return rest.length > 0 ? `${subject}\n\n${rest}` : subject
}

export function makeDefaultGitSpawn(): GitSpawn {
  return withIndexLockRetry(async (args, { cwd, timeoutMs, env }) => {
    const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
    if (!bun) {
      return { exitCode: 127, stdout: '', stderr: 'Bun runtime not available', timedOut: false }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // Per-call `env` (credentials for push/fetch) is applied LAST so its
      // GIT_TERMINAL_PROMPT wins; NONINTERACTIVE_ENV's pager/GCM settings still
      // apply to every call. Local commands pass no `env` and stay token-free.
      const proc = bun.spawn({
        cmd: ['git', ...hooklessGitArgs(args)],
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...NONINTERACTIVE_ENV, ...env },
        signal: controller.signal,
      })
      const exitCode = await proc.exited
      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const timedOut = controller.signal.aborted
      return { exitCode, stdout, stderr, timedOut }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        exitCode: 1,
        stdout: '',
        stderr: message,
        timedOut: controller.signal.aborted,
      }
    } finally {
      clearTimeout(timer)
    }
  })
}

export function withIndexLockRetry(spawn: GitSpawn): GitSpawn {
  return async (args, opts) => {
    let result = await spawn(args, opts)
    for (const delayMs of [50, 150, 350]) {
      if (result.exitCode === 0 || !isIndexLockContention(result.stderr)) return result
      await sleep(delayMs)
      result = await spawn(args, opts)
    }
    return result
  }
}

function isIndexLockContention(stderr: string): boolean {
  const lower = stderr.toLowerCase()
  return lower.includes('index.lock') || (lower.includes('unable to create') && lower.includes('index.lock'))
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}
