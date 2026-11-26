import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, parse as parsePath } from 'node:path'

import { type InstallRunner, runBunInstall } from './run-bun-install'

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
}

export async function ensureDepsInstalled(options: EnsureDepsOptions): Promise<EnsureDepsResult> {
  const { cwd } = options
  const install = options.install ?? runBunInstall
  const detect = options.detect ?? detectMissingDeps
  const force = options.force ?? false
  const refresh = options.refresh ?? false

  const missing = force ? [] : await detect(cwd)
  if (!force && !refresh && missing.length === 0) return { ok: true, installed: false }

  const result = await install(cwd, { force })
  if (!result.ok) return { ok: false, reason: result.reason, missing }

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
