import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

import { GITKEEP_FILE, PACKAGES_DIR } from './paths'

export const PACKAGE_FILE = 'package.json'
export const WORKSPACES_GLOB = `${PACKAGES_DIR}/*`

const BUN_COMPATIBLE_OVERRIDES: Record<string, string> = {
  bson: '6.10.4',
}

export type PackageJsonRefreshResult = {
  changed: boolean
  files: string[]
}

// Migrates an existing agent folder into a bun monorepo layout. Idempotent —
// running twice is a no-op. Skips silently when:
//   - package.json is missing (folder not initialized yet)
//   - package.json is unparseable (we never touch corrupt user files)
//   - workspaces is already set (user opted in or customized)
//
// Always ensures `packages/<GITKEEP_FILE>` exists so the directory survives the
// initial git commit, regardless of whether package.json was touched.
//
// Returns the list of paths the caller should consider for git auto-commit.
// The caller (typeclaw start) commits these via the same `commitSystemFile`
// pattern as .gitignore, keeping the monorepo migration on git's record.
export async function refreshPackageJson(cwd: string): Promise<PackageJsonRefreshResult> {
  const changed: string[] = []
  const pkgPath = join(cwd, PACKAGE_FILE)

  if (existsSync(pkgPath)) {
    const updated = await ensureManagedPackageJsonFields(pkgPath)
    if (updated) changed.push(PACKAGE_FILE)
  }

  const gitkeepRel = posix.join(PACKAGES_DIR, GITKEEP_FILE)
  const gitkeepPath = join(cwd, gitkeepRel)
  if (!existsSync(gitkeepPath)) {
    await mkdir(join(cwd, PACKAGES_DIR), { recursive: true })
    await writeFile(gitkeepPath, '')
    changed.push(gitkeepRel)
  }

  return { changed: changed.length > 0, files: changed }
}

async function ensureManagedPackageJsonFields(pkgPath: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(pkgPath, 'utf8')
  } catch {
    return false
  }

  let pkg: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    pkg = parsed as Record<string, unknown>
  } catch {
    return false
  }

  let next = pkg
  let changed = false

  if (!('workspaces' in next)) {
    // Insertion order matters: place `workspaces` right after `type` (or after
    // top-of-object metadata if `type` is absent) so the diff reads cleanly
    // alongside the buildPackageJson template's field order. Without this, a
    // freshly-migrated package.json has `workspaces` at the bottom — visually
    // jarring and harder to spot on review.
    next = insertAfterKey(next, 'type', 'workspaces', [WORKSPACES_GLOB])
    changed = true
  }

  const overrides = next.overrides
  if (overrides === undefined) {
    next = insertAfterKey(next, 'dependencies', 'overrides', BUN_COMPATIBLE_OVERRIDES)
    changed = true
  } else if (isPlainObject(overrides)) {
    const missing = Object.entries(BUN_COMPATIBLE_OVERRIDES).filter(([name]) => !(name in overrides))
    if (missing.length > 0) {
      next = { ...next, overrides: { ...overrides, ...Object.fromEntries(missing) } }
      changed = true
    }
  }

  if (!changed) return false
  await writeFile(pkgPath, `${JSON.stringify(next, null, 2)}\n`)
  return true
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function insertAfterKey(
  obj: Record<string, unknown>,
  anchor: string,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const keys = Object.keys(obj)
  const anchorIdx = keys.indexOf(anchor)
  if (anchorIdx === -1) {
    return { [key]: value, ...obj }
  }
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i] as string
    out[k] = obj[k]
    if (i === anchorIdx) out[key] = value
  }
  return out
}
