import { existsSync, realpathSync } from 'node:fs'
import { readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, parse as parsePath } from 'node:path'

import {
  COPYFILE_INSTALL_MARKER,
  type InstallResult,
  type InstallRunner,
  markIndependentInstall,
  recoverHiddenOperatorDotenv,
  runBunInstall,
} from './run-bun-install'

const PACKAGE_FILE = 'package.json'
const NODE_MODULES = 'node_modules'

export type EnsureDepsResult =
  | { ok: true; installed: boolean }
  | { ok: false; reason: string; missing?: readonly string[] }

export type EnsureDepsOptions = {
  cwd: string
  install?: InstallRunner
  detect?: (cwd: string) => Promise<readonly string[]>
  // Skip the pre-install drift detection and run `bun install --force`
  // unconditionally. The post-install re-detect at the bottom (the
  // silent-no-op guard) stays — `--force` does NOT excuse us from verifying
  // the install actually populated the agent's node_modules/.
  force?: boolean
  // Run a plain `bun install` even when nothing is missing. A plain install
  // re-copies `file:` deps from their current source, so a stale copy needs
  // this, not `--force`, which re-installs every package and is several times
  // slower when many agents restart at once.
  refresh?: boolean
  // Test seam for the longest a warm refresh waits behind the one ahead of it.
  maxQueueWaitMs?: number
}

// Warm refreshes started by one CLI run go through this queue one at a time.
// `compose start`/`restart` start every agent concurrently, and concurrent
// installs on one host contend on bun's shared cache and the disk: seven agents
// refreshing a `file:` typeclaw took about 51s in parallel against 26s back to
// back. Only warm refreshes queue (nothing missing, no `--force`). Cold and
// forced installs stay independent. A warm refresh can still need the registry
// (a bumped pin whose old version is installed, an evicted cache entry), and
// telling those apart up front is guesswork, so instead no refresh waits more
// than WARM_REFRESH_MAX_WAIT_MS behind the one ahead of it: the queue is a speed
// optimization and must never hold a restart behind a stalled install.
const WARM_REFRESH_MAX_WAIT_MS = 30_000
let warmRefreshQueue: Promise<unknown> = Promise.resolve()

function queueWarmRefresh<T>(run: () => Promise<T>, maxWaitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const waitCap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, maxWaitMs)
  })
  const turn = Promise.race([warmRefreshQueue, waitCap]).finally(() => clearTimeout(timer))
  const queued = turn.then(run)
  warmRefreshQueue = queued.catch(() => {})
  return queued
}

export async function ensureDepsInstalled(options: EnsureDepsOptions): Promise<EnsureDepsResult> {
  const { cwd } = options
  const install = options.install ?? runBunInstall
  const detect = options.detect ?? detectMissingDeps
  // A crashed host Bun run can leave the operator's .env in credential staging,
  // and an interrupted rebuild can leave the last working tree aside; put both
  // back before anything reads the folder.
  recoverHiddenOperatorDotenv(cwd)
  await recoverInterruptedRebuild(cwd)
  // A tree installed before the copyfile backend can share inodes with the
  // host Bun cache, and the agent can write node_modules, so it is rebuilt once
  // from empty and marked only after the new tree is verified.
  const rebuild = needsCopyfileRebuild(cwd)
  const force = options.force ?? false
  const refresh = options.refresh ?? false

  const missing = force || rebuild ? [] : await detect(cwd)
  if (!force && !rebuild && !refresh && missing.length === 0) return { ok: true, installed: false }
  const buildsFromEmpty = rebuild || !existsSync(join(cwd, NODE_MODULES))

  const installAndVerify = async (): Promise<EnsureDepsResult> => {
    const result =
      !force && !rebuild && missing.length === 0
        ? await queueWarmRefresh(() => install(cwd, { force }), options.maxQueueWaitMs ?? WARM_REFRESH_MAX_WAIT_MS)
        : await install(cwd, { force })
    if (!result.ok) return { ok: false, reason: result.reason, missing }
    const verified = await verifyInstalled(cwd, detect)
    if (verified.ok && buildsFromEmpty) await markIndependentInstall(cwd)
    return verified
  }
  return rebuild ? await rebuildFromEmpty(cwd, installAndVerify) : await installAndVerify()
}

async function verifyInstalled(
  cwd: string,
  detect: (cwd: string) => Promise<readonly string[]>,
): Promise<EnsureDepsResult> {
  // Re-probe: `bun install` returns 0 even when a file:-linked dep's own
  // package.json is unreachable (it silently no-ops on the target). Without
  // this check, we'd proceed to `docker run` with a known-broken
  // node_modules/ and the agent would crash with a confusing in-container
  // `Cannot find package 'x'`. This guard remains under `force` too —
  // --force bypasses the cache but does not guarantee the install actually
  // landed every declared dep.
  const stillMissing = await detect(cwd)
  if (stillMissing.length > 0) {
    return {
      ok: false,
      reason: `bun install completed but these deps are still missing from ${cwd}/node_modules/: ${stillMissing.join(', ')}`,
      missing: stillMissing,
    }
  }
  return { ok: true, installed: true }
}

// Walks the agent's package.json plus one level of transitive deps. The
// canonical failure we guard against: typeclaw is installed, but its own
// deps (e.g. agent-messenger, zod) aren't reachable from the agent folder
// after a CLI upgrade added them. Direct deps alone wouldn't catch that —
// typeclaw IS present, but its dependencies field has grown. Deeper drift
// (dep-of-dep-of-dep missing) is rare and surfaces during `bun install`.
//
// Root deps are checked against <cwd>/node_modules/<dep> ONLY (no walk-up):
// the agent folder is what gets bind-mounted into the container, so a dep
// satisfied by some ancestor host folder's node_modules would be invisible
// inside the container. Walking the host filesystem upward here would
// silently pass the gate and let `docker run` crash later with "Cannot find
// package", which is the exact failure mode this whole module was added to
// prevent.
//
// Transitive deps are different: they MUST be resolved via Node's algorithm
// from the parent package's realpath, not lexical-joined against <cwd>.
// Bun's isolated linker (used for new workspace projects with
// `configVersion = 1`, which is TypeClaw's scaffold) symlinks
// node_modules/<dep> into node_modules/.bun/<dep>@<ver>/node_modules/<dep>/
// and stores that package's own deps as siblings inside the same nested
// node_modules. A lexical probe at <cwd>/node_modules/<transitive> finds
// nothing even though the dep is correctly installed and reachable from
// the parent — that was the original false-positive that aborted
// `typeclaw start`.
// Moves the old tree aside so the install builds every package fresh and
// nothing stale (a package no longer in the graph, a leftover hardlink)
// survives. The old tree is dropped only after the new one is verified;
// a failed install or verification puts it back.
async function rebuildFromEmpty(cwd: string, run: () => Promise<EnsureDepsResult>): Promise<EnsureDepsResult> {
  const nodeModules = join(cwd, NODE_MODULES)
  const legacy = legacyTreePath(cwd)
  await rename(nodeModules, legacy)
  const result = await run()
  if (result.ok) {
    await rm(legacy, { recursive: true, force: true })
    return result
  }
  await rm(nodeModules, { recursive: true, force: true })
  await rename(legacy, nodeModules)
  return result
}

// A backup next to an unmarked tree means a rebuild stopped before verifying
// its replacement, so the partial tree is discarded and the backup restored. A
// marked tree means the rebuild finished and only the cleanup was missed.
async function recoverInterruptedRebuild(cwd: string): Promise<void> {
  const legacy = legacyTreePath(cwd)
  if (!existsSync(legacy)) return
  const nodeModules = join(cwd, NODE_MODULES)
  if (existsSync(join(nodeModules, COPYFILE_INSTALL_MARKER))) {
    await rm(legacy, { recursive: true, force: true })
    return
  }
  await rm(nodeModules, { recursive: true, force: true })
  await rename(legacy, nodeModules)
}

function legacyTreePath(cwd: string): string {
  return join(cwd, `${NODE_MODULES}.typeclaw-legacy`)
}

function needsCopyfileRebuild(cwd: string): boolean {
  const nodeModules = join(cwd, NODE_MODULES)
  return existsSync(nodeModules) && !existsSync(join(nodeModules, COPYFILE_INSTALL_MARKER))
}

export async function detectMissingDeps(cwd: string): Promise<readonly string[]> {
  const rootDeps = await readDeclaredDeps(join(cwd, PACKAGE_FILE))
  if (rootDeps.length === 0) return []

  const missing = new Set<string>()
  const installedRootDirs = new Map<string, string>()
  for (const dep of rootDeps) {
    const dir = resolveDirectDep(cwd, dep)
    if (dir === null) {
      missing.add(dep)
    } else {
      installedRootDirs.set(dep, dir)
    }
  }

  for (const [dep, parentDir] of installedRootDirs) {
    if (missing.has(dep)) continue
    const transitive = await readDeclaredDeps(join(parentDir, PACKAGE_FILE))
    for (const t of transitive) {
      if (!resolveTransitiveDep(parentDir, t)) {
        missing.add(t)
      }
    }
  }

  return [...missing].sort()
}

async function readDeclaredDeps(packageJsonPath: string): Promise<readonly string[]> {
  if (!existsSync(packageJsonPath)) return []
  let raw: string
  try {
    raw = await readFile(packageJsonPath, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== 'object') return []
  const deps = (parsed as { dependencies?: unknown }).dependencies
  if (deps === null || typeof deps !== 'object') return []
  return Object.keys(deps as Record<string, unknown>)
}

function resolveDirectDep(cwd: string, depName: string): string | null {
  const candidate = join(cwd, NODE_MODULES, depName)
  if (!existsSync(join(candidate, PACKAGE_FILE))) return null
  try {
    return realpathSync(candidate)
  } catch {
    return null
  }
}

function resolveTransitiveDep(fromDir: string, depName: string): string | null {
  let dir: string
  try {
    dir = realpathSync(fromDir)
  } catch {
    return null
  }
  const fsRoot = parsePath(dir).root
  while (true) {
    const candidate = join(dir, NODE_MODULES, depName)
    if (existsSync(join(candidate, PACKAGE_FILE))) {
      try {
        return realpathSync(candidate)
      } catch {
        return null
      }
    }
    if (dir === fsRoot) return null
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
