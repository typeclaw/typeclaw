import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { splitPluginEntrySpec } from '@/plugin'

import { runBunPmViewVersion } from './run-bun-install'

const PACKAGE_FILE = 'package.json'

const NOOP: ReconcilePluginDepsResult = { changed: false, files: [], skipped: [] }

export type ReconcilePluginDepsResult = {
  changed: boolean
  files: string[]
  // Plugins skipped because their package could not be found in the registry
  // (npm 404 / E404). A missing plugin must not block `start`: the entry is
  // dropped from this reconcile pass and surfaced here so the caller can warn.
  skipped: string[]
}

// Resolves a bare plugin name to its latest published version. Returns null
// when the package genuinely does not exist in the registry (404 / E404) so
// the caller can skip it without blocking start. Throws on every other failure
// (network outage, missing bun runtime, empty registry response) — those are
// transient or environmental, not "plugin not found", and must still block.
export type ResolveLatestVersion = (packageName: string) => Promise<string | null>

export type ReconcilePluginDepsOptions = {
  cwd: string
  plugins: readonly string[]
  resolveLatest?: ResolveLatestVersion
}

// Materializes typeclaw.json#plugins into package.json#dependencies so the
// plugin list is the single source of truth: the user edits typeclaw.json and
// `start` keeps package.json in sync. The sync is one-way (config → manifest)
// and bidirectional in effect (entries added to config are written; entries
// removed from config are pruned). Provenance lives in
// package.json#typeclaw.managedPlugins so pruning only ever touches deps this
// step added — never the user's own dependencies or the typeclaw runtime dep.
export async function reconcilePluginDeps(options: ReconcilePluginDepsOptions): Promise<ReconcilePluginDepsResult> {
  const { cwd, plugins } = options
  const resolveLatest = options.resolveLatest ?? resolveLatestFromRegistry

  const pkgPath = join(cwd, PACKAGE_FILE)
  if (!existsSync(pkgPath)) return NOOP

  let raw: string
  try {
    raw = await readFile(pkgPath, 'utf8')
  } catch {
    return NOOP
  }

  let pkg: PackageJsonShape
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return NOOP
    pkg = parsed as PackageJsonShape
  } catch {
    return NOOP
  }

  const dependencies = { ...pkg.dependencies }
  const previousManaged = readManagedPlugins(pkg)
  const { desired, skipped } = await resolveDesiredManaged(plugins, previousManaged, resolveLatest)

  let changed = false

  for (const [name, version] of Object.entries(desired)) {
    if (dependencies[name] !== version) {
      dependencies[name] = version
      changed = true
    }
  }

  // Prune scoped strictly to the prior managed set: a dep the user hand-added
  // or a runtime dep is never removed even if its name shape looks plugin-like.
  for (const name of Object.keys(previousManaged)) {
    if (!(name in desired) && name in dependencies) {
      delete dependencies[name]
      changed = true
    }
  }

  if (!managedEqual(previousManaged, desired)) changed = true

  if (!changed) return { changed: false, files: [], skipped }

  const next = withManagedPlugins({ ...pkg, dependencies: sortKeys(dependencies) }, desired)
  await writeFile(pkgPath, `${JSON.stringify(next, null, 2)}\n`)
  return { changed: true, files: [PACKAGE_FILE], skipped }
}

type PackageJsonShape = {
  dependencies?: Record<string, string>
  typeclaw?: { managedPlugins?: Record<string, string> } & Record<string, unknown>
} & Record<string, unknown>

// Classifies config.plugins entries and resolves the version each managed dep
// should pin to. Local paths are skipped (not npm packages). A bare name (no
// `@version`) is pinned ONCE: it reuses the version already pinned in the
// managed set on subsequent starts, and only resolves `latest` for a genuinely
// new, unmanaged plugin. Without this reuse, an unchanged `typeclaw.json` would
// re-resolve `latest` on every start and silently rewrite package.json when the
// registry moves — bypassing the pluginAddition security gate, which only fires
// on a guarded config write.
//
// Registry resolution for genuinely-new bare names runs CONCURRENTLY: each
// `resolveLatest` spawns a `bun pm view` subprocess (a serial pass paid the
// per-call network round-trip once per new plugin on the cold-start critical
// path). A hard resolver failure (network/auth, NOT a 404) still rejects the
// whole pass via Promise.all, preserving the "network errors block start"
// contract. The `skipped` list is sorted so its order is independent of which
// concurrent probe settled first.
//
// Last-entry-wins is positional, matching the prior serial loop: for a name
// listed more than once, the LAST entry decides. An explicit/pinned version
// applied during the loop must therefore survive even if an EARLIER bare entry
// for the same name resolved from the registry afterward — so the post-await
// assignment is skipped for any name whose last occurrence was not the bare one.
async function resolveDesiredManaged(
  plugins: readonly string[],
  previousManaged: Record<string, string>,
  resolveLatest: ResolveLatestVersion,
): Promise<{ desired: Record<string, string>; skipped: string[] }> {
  const desired: Record<string, string> = {}
  const bareIsLastFor = new Set<string>()
  const toResolve: string[] = []
  for (const entry of plugins) {
    if (isLocalEntry(entry)) continue
    const { name, versionSpec } = splitPluginEntrySpec(entry)
    if (name.length === 0) continue
    if (versionSpec !== undefined) {
      desired[name] = versionSpec
      bareIsLastFor.delete(name)
      continue
    }
    const pinned = previousManaged[name]
    if (pinned !== undefined) {
      desired[name] = pinned
      bareIsLastFor.delete(name)
      continue
    }
    bareIsLastFor.add(name)
    if (!toResolve.includes(name)) toResolve.push(name)
  }

  const resolved = await Promise.all(toResolve.map(async (name) => ({ name, version: await resolveLatest(name) })))
  const skipped: string[] = []
  for (const { name, version } of resolved) {
    if (!bareIsLastFor.has(name)) continue
    if (version === null) {
      skipped.push(name)
      continue
    }
    desired[name] = version
  }

  return { desired: sortKeys(desired), skipped: skipped.sort() }
}

function isLocalEntry(entry: string): boolean {
  return entry.startsWith('./') || entry.startsWith('../') || isAbsolute(entry)
}

function readManagedPlugins(pkg: PackageJsonShape): Record<string, string> {
  const managed = pkg.typeclaw?.managedPlugins
  if (managed === undefined || managed === null || typeof managed !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [name, version] of Object.entries(managed)) {
    if (typeof version === 'string') out[name] = version
  }
  return out
}

function withManagedPlugins(pkg: PackageJsonShape, managed: Record<string, string>): PackageJsonShape {
  const typeclaw = { ...pkg.typeclaw }
  if (Object.keys(managed).length === 0) {
    delete typeclaw.managedPlugins
  } else {
    typeclaw.managedPlugins = managed
  }
  if (Object.keys(typeclaw).length === 0) {
    const { typeclaw: _omit, ...rest } = pkg
    return rest as PackageJsonShape
  }
  return { ...pkg, typeclaw }
}

function managedEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (a[k] !== b[k]) return false
  return true
}

function sortKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of Object.keys(obj).sort()) out[k] = obj[k] as string
  return out
}

export async function resolveLatestFromRegistry(
  packageName: string,
  opts?: Parameters<typeof runBunPmViewVersion>[1],
): Promise<string | null> {
  const result = await runBunPmViewVersion(packageName, opts)
  if (!result.ok) {
    const stderr = result.stderr.trim()
    if (isPackageNotFound(stderr)) return null
    throw new Error(`failed to resolve latest version for ${packageName}: ${stderr || `exit ${result.code}`}`)
  }
  const version = result.stdout.trim().replace(/^["']|["']$/g, '')
  if (version.length === 0) throw new Error(`registry returned no version for ${packageName}`)
  return version
}

// A registry 404 means the package does not exist — a user typo or an
// unpublished plugin — which `start` must tolerate, not abort on. Network and
// auth failures are deliberately NOT matched here so they keep throwing.
export function isPackageNotFound(stderr: string): boolean {
  return /\bE404\b/.test(stderr) || /\b404\b/.test(stderr) || /not found/i.test(stderr)
}
