import { hooklessGitArgs } from './hookless'
import { resolveAgentGit } from './resolve-agent-git'

// Commits TypeClaw-owned tracked files (.gitignore, package.json,
// typeclaw.json) if any are dirty in git. Skips silently when the agent
// folder is not a git repo, when Bun is unavailable, or when every named
// file is clean. Uses Git's ambient identity: host config in host-stage calls,
// or the agent repo identity injected into the container process at start.
//
// Accepts a single file or an array; the array form produces a single
// atomic commit covering all listed paths (used for migrations that touch
// multiple files together, e.g. enabling bun workspaces writes both
// package.json and packages/.gitkeep in one commit).
//
// Lives under src/git/ rather than src/container/ because both the
// host-stage launcher (typeclaw start) and src/config/config.ts (called
// from every entry point that reads typeclaw.json, host AND container)
// need to commit migration artifacts. Putting it in src/container/ would
// pull container-level imports into the config module and create a
// circular dependency at the package boundary.
export async function commitSystemFile(cwd: string, file: string | readonly string[], message: string): Promise<void> {
  const files = typeof file === 'string' ? [file] : file
  if (files.length === 0) return

  const bun = getBunAsync()
  if (!bun) return
  const repo = resolveAgentGit(cwd)
  if (!repo) return

  const status = bun.spawn({
    cmd: ['git', ...hooklessGitArgs([...repo.gitArgs, 'status', '--porcelain', '--', ...files])],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((await status.exited) !== 0) return
  const dirty = (await new Response(status.stdout).text()).trim().length > 0
  if (!dirty) return

  const add = bun.spawn({
    cmd: ['git', ...hooklessGitArgs([...repo.gitArgs, 'add', '--', ...files])],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if ((await add.exited) !== 0) return

  const commit = bun.spawn({
    cmd: ['git', ...hooklessGitArgs([...repo.gitArgs, 'commit', '-m', message, '--only', '--', ...files])],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await commit.exited
}

// A git child that never exits would otherwise block the caller's thread for
// good, since a synchronous spawn cannot be interrupted from JavaScript.
const SPAWN_SYNC_TIMEOUT_MS = 30_000

// Synchronous variant for callers that already hold a synchronous codepath
// — specifically `persistMigratedConfig` in src/config/config.ts. The
// migration write is itself synchronous (writeFileSync) and the call sites
// (loadConfigSync, validateConfig, loadPluginConfigsSync) are sync, so we
// cannot await an async commit without forcing them all to become async,
// which would ripple into hundreds of call sites across the codebase.
//
// The commit overhead (~10-50ms) is paid exactly once per agent folder
// per legacy form: after the first call rewrites the file to canonical
// shape, subsequent migrateLegacyConfigShape calls return changed=false
// and this codepath is unreachable. On canonical folders (the common
// case) this function is never called at all.
//
// Same skip semantics as the async variant — no-op when the folder is not
// a git repo, when Bun is unavailable, or when the file is clean.
export function commitSystemFileSync(cwd: string, file: string | readonly string[], message: string): void {
  const files = typeof file === 'string' ? [file] : file
  if (files.length === 0) return

  const bun = getBunSync()
  if (!bun) return
  const repo = resolveAgentGit(cwd)
  if (!repo) return

  const status = bun.spawnSync({
    cmd: ['git', ...hooklessGitArgs([...repo.gitArgs, 'status', '--porcelain', '--', ...files])],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: SPAWN_SYNC_TIMEOUT_MS,
  })
  if (status.exitCode !== 0) return
  if (new TextDecoder().decode(status.stdout).trim().length === 0) return

  const add = bun.spawnSync({
    cmd: ['git', ...hooklessGitArgs([...repo.gitArgs, 'add', '--', ...files])],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: SPAWN_SYNC_TIMEOUT_MS,
  })
  if (add.exitCode !== 0) return

  bun.spawnSync({
    cmd: ['git', ...hooklessGitArgs([...repo.gitArgs, 'commit', '-m', message, '--only', '--', ...files])],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: SPAWN_SYNC_TIMEOUT_MS,
  })
}

// Bun-availability shims kept tight to the two functions so the module
// has no module-level side effects (matters for the sync codepath, which
// is called during typeclaw.json reads on hot import).
function getBunAsync(): { spawn: typeof Bun.spawn } | undefined {
  return (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
}

function getBunSync(): { spawnSync: typeof Bun.spawnSync } | undefined {
  return (globalThis as { Bun?: { spawnSync: typeof Bun.spawnSync } }).Bun
}
