import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { resolveScaffoldVersion } from '@/init/cli-version'
import { editDependencySpec, type ParsedPackage, writeDependencySpec } from '@/init/packagejson-edit'

const PACKAGE_FILE = 'package.json'
const TYPECLAW = 'typeclaw'

export type TypeclawDepMode = 'local' | 'npm'

export type GitResult = { exitCode: number; stdout: string; stderr: string }
export type SpawnGit = (args: readonly string[], cwd: string) => Promise<GitResult>

export type SwitchTypeclawDepOptions = {
  agentRoot: string
  mode: TypeclawDepMode
  // local mode: path to the local typeclaw checkout. When omitted, falls back
  // to an existing `file:` spec or the running CLI's own checkout.
  localPath?: string
  // npm mode: the version to pin as `^<version>`. When omitted, resolved from
  // the installed package or the scaffold version of the running CLI.
  version?: string
  commit?: boolean
  spawnGit?: SpawnGit
  // Test seam: overrides the running-CLI checkout discovery so tests can
  // simulate an npm-installed CLI (no separate dev tree → null).
  findRunningCliCheckout?: () => string | null
}

export type SwitchTypeclawDepResult = {
  changed: boolean
  oldSpec: string | null
  newSpec: string
  packageJsonPath: string
  committed: boolean
  commitSubject?: string
}

export type SwitchTypeclawDepError =
  | { kind: 'no-package-json'; path: string }
  | { kind: 'no-typeclaw-dependency' }
  | { kind: 'local-path-unresolved' }
  | { kind: 'local-path-not-typeclaw'; path: string }
  | { kind: 'version-unresolved' }
  | { kind: 'invalid-version'; version: string }
  | { kind: 'commit-blocked-dirty'; files: string[] }

export class DevDepError extends Error {
  constructor(readonly detail: SwitchTypeclawDepError) {
    super(describeError(detail))
    this.name = 'DevDepError'
  }
}

export async function switchTypeclawDependency(options: SwitchTypeclawDepOptions): Promise<SwitchTypeclawDepResult> {
  const { agentRoot, mode } = options
  const packageJsonPath = join(agentRoot, PACKAGE_FILE)
  const pkg = await readPackageJson(packageJsonPath)
  if (pkg === null) throw new DevDepError({ kind: 'no-package-json', path: packageJsonPath })

  const oldSpec = pkg.parsed.dependencies?.[TYPECLAW] ?? null
  if (oldSpec === null) throw new DevDepError({ kind: 'no-typeclaw-dependency' })

  const newSpec =
    mode === 'local'
      ? resolveLocalSpec(
          agentRoot,
          oldSpec,
          options.localPath,
          options.findRunningCliCheckout ?? findRunningCliCheckout,
        )
      : resolveNpmSpec(options.version)

  if (newSpec === oldSpec) {
    return { changed: false, oldSpec, newSpec, packageJsonPath, committed: false }
  }

  const shouldCommit = options.commit ?? true
  const spawnGit = options.spawnGit ?? defaultSpawnGit
  // Gate on a clean index BEFORE writing so a refused commit never leaves the
  // edit half-applied (package.json changed but uncommitted, with unrelated
  // staged work the user must now untangle).
  const gitRepo = shouldCommit ? await resolveCommitContext(agentRoot, spawnGit) : null

  await writeDependencySpec(packageJsonPath, pkg, TYPECLAW, newSpec)

  if (!shouldCommit || gitRepo === null) {
    return { changed: true, oldSpec, newSpec, packageJsonPath, committed: false }
  }

  const commitSubject = `deps: switch typeclaw to ${mode === 'local' ? 'local' : 'npm'}`
  const committed = await commitPackageJson(agentRoot, commitSubject, spawnGit)
  return {
    changed: true,
    oldSpec,
    newSpec,
    packageJsonPath,
    committed,
    commitSubject: committed ? commitSubject : undefined,
  }
}

function resolveLocalSpec(
  agentRoot: string,
  oldSpec: string,
  localPath: string | undefined,
  findCheckout: () => string | null,
): string {
  const candidate = localPath ?? deriveLocalCheckout(oldSpec, agentRoot, findCheckout)
  if (candidate === null) throw new DevDepError({ kind: 'local-path-unresolved' })

  const absolute = isAbsolute(candidate) ? candidate : resolve(agentRoot, candidate)
  if (!isTypeclawCheckout(absolute)) throw new DevDepError({ kind: 'local-path-not-typeclaw', path: absolute })

  return `file:${toFileSpec(relative(agentRoot, absolute))}`
}

// Without an explicit --path, reuse an existing `file:` spec (already local) or
// fall back to the running CLI's own checkout — but only when the CLI is a dev
// checkout, not an npm install (an npm-installed CLI lives under node_modules
// and is not a separate dev tree to point at).
function deriveLocalCheckout(oldSpec: string, agentRoot: string, findCheckout: () => string | null): string | null {
  if (oldSpec.startsWith('file:')) return resolve(agentRoot, oldSpec.slice('file:'.length))
  return findCheckout()
}

function resolveNpmSpec(version: string | undefined): string {
  const resolved = version ?? stripCaret(resolveScaffoldVersion())
  if (resolved === null) throw new DevDepError({ kind: 'version-unresolved' })

  const normalized = normalizeVersion(resolved)
  if (normalized === null) throw new DevDepError({ kind: 'invalid-version', version: resolved })

  return `^${normalized}`
}

// Validates the agent folder is a git repo with no unrelated staged changes,
// returning a marker the caller uses to decide whether to commit post-write.
// Throws on blockers (unrelated staged files); returns null for a non-repo.
async function resolveCommitContext(agentRoot: string, spawnGit: SpawnGit): Promise<{ ok: true } | null> {
  const repoCheck = await spawnGit(['rev-parse', '--is-inside-work-tree'], agentRoot)
  if (repoCheck.exitCode !== 0 || repoCheck.stdout.trim() !== 'true') return null

  const staged = await stagedFiles(agentRoot, spawnGit)
  const blockers = staged.filter((f) => f !== PACKAGE_FILE)
  if (blockers.length > 0) throw new DevDepError({ kind: 'commit-blocked-dirty', files: blockers })

  return { ok: true }
}

async function commitPackageJson(agentRoot: string, subject: string, spawnGit: SpawnGit): Promise<boolean> {
  const add = await spawnGit(['add', '--', PACKAGE_FILE], agentRoot)
  if (add.exitCode !== 0) return false

  const commit = await spawnGit(['commit', '-m', subject, '--', PACKAGE_FILE], agentRoot)
  return commit.exitCode === 0
}

// Files already staged in the index, excluding our own package.json edit. We
// refuse to commit when other staged changes exist so the dep switch never
// silently bundles unrelated work into its commit.
async function stagedFiles(agentRoot: string, spawnGit: SpawnGit): Promise<string[]> {
  const res = await spawnGit(['diff', '--cached', '--name-only'], agentRoot)
  if (res.exitCode !== 0) return []
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

async function readPackageJson(path: string): Promise<ParsedPackage | null> {
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return { raw, parsed: parsed as ParsedPackage['parsed'] }
}

function isTypeclawCheckout(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, PACKAGE_FILE), 'utf8')) as { name?: string }
    return pkg.name === TYPECLAW
  } catch {
    return false
  }
}

function findRunningCliCheckout(): string | null {
  try {
    let dir = import.meta.dir
    const root = resolve('/')
    while (dir !== root) {
      if (isTypeclawCheckout(dir) && !dir.includes(`${join('/', 'node_modules', '/')}`)) return dir
      dir = join(dir, '..')
      dir = resolve(dir)
    }
  } catch {}
  return null
}

function toFileSpec(rel: string): string {
  if (rel === '') return '.'
  return rel.split(/[\\/]/).join('/')
}

function stripCaret(scaffold: string | null): string | null {
  if (scaffold === null) return null
  const m = scaffold.match(/^\^?(\d+\.\d+\.\d+)$/)
  return m ? (m[1] ?? null) : null
}

function normalizeVersion(version: string): string | null {
  const m = version.trim().match(/^[\^~=]?(\d+\.\d+\.\d+)$/)
  return m ? (m[1] ?? null) : null
}

function describeError(detail: SwitchTypeclawDepError): string {
  switch (detail.kind) {
    case 'no-package-json':
      return `No package.json found at ${detail.path}. Run this from an agent folder.`
    case 'no-typeclaw-dependency':
      return 'No "typeclaw" entry in package.json dependencies. Run `typeclaw init` first.'
    case 'local-path-unresolved':
      return 'Could not resolve a local typeclaw checkout. Pass --path <dir>.'
    case 'local-path-not-typeclaw':
      return `${detail.path} is not a typeclaw checkout (package.json#name !== "typeclaw").`
    case 'version-unresolved':
      return 'Could not resolve a typeclaw version. Pass --version <X.Y.Z>.'
    case 'invalid-version':
      return `Invalid version "${detail.version}". Expected X.Y.Z.`
    case 'commit-blocked-dirty':
      return `Refusing to commit: unrelated staged changes present (${detail.files.join(', ')}). Commit or unstage them, or pass --no-commit.`
  }
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
