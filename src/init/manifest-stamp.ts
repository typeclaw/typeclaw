import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Lives inside node_modules so a wiped or rebuilt tree also drops it; the next
// start then records a fresh one instead of refreshing a tree it just built.
const STAMP_FILE = join('node_modules', '.typeclaw-manifest-stamp')

// Identifies every manifest a root `bun install` reads in the agent package:
// the root package.json and lockfile plus the package.json of each workspace
// the root declares. A change to any of them (a new workspace package, a
// workspace-only dependency) is something startup's missing-dependency check
// cannot see.
export async function agentManifestFingerprint(cwd: string, inputs?: string): Promise<string> {
  return createHash('sha256')
    .update(inputs ?? (await agentManifestInputs(cwd)))
    .update('\0bun.lock\0')
    .update(await readOrEmpty(join(cwd, 'bun.lock')))
    .digest('hex')
}

// The manifests alone, without the lockfile Bun may rewrite while installing,
// so a caller can tell whether a manifest changed during an install.
export async function agentManifestInputs(cwd: string): Promise<string> {
  const hash = createHash('sha256')
  const root = await readOrEmpty(join(cwd, 'package.json'))
  hash.update('package.json\0').update(root)
  for (const manifest of await workspaceManifests(cwd, root)) {
    hash.update(`\0${manifest}\0`).update(await readOrEmpty(join(cwd, manifest)))
  }
  return hash.digest('hex')
}

// True when an installed tree has no verified record of the manifests it was
// installed from (no stamp yet, or one an interrupted start left unwritten) or
// when they differ now. Without node_modules the install runs anyway.
export async function agentManifestsChanged(cwd: string, inputs?: string): Promise<boolean> {
  if (!existsSync(join(cwd, 'node_modules'))) return false
  const stamp = await readOrEmpty(join(cwd, STAMP_FILE))
  return stamp.trim() !== (await agentManifestFingerprint(cwd, inputs))
}

// Records `inputs`, the manifests read before the install, never a rescan: an
// edit that lands after the install leaves the record stale, so the next start
// installs again.
export async function writeAgentManifestStamp(cwd: string, inputs?: string): Promise<void> {
  if (!existsSync(join(cwd, 'node_modules'))) return
  await writeFile(join(cwd, STAMP_FILE), `${await agentManifestFingerprint(cwd, inputs)}\n`)
}

async function workspaceManifests(cwd: string, rootManifest: string): Promise<string[]> {
  const found = new Set<string>()
  for (const pattern of declaredWorkspaces(rootManifest)) {
    const glob = new Bun.Glob(`${pattern.replace(/\/+$/, '')}/package.json`)
    for await (const path of glob.scan({ cwd, onlyFiles: true })) {
      const normalized = path.split('\\').join('/')
      if (!normalized.split('/').includes('node_modules')) found.add(normalized)
    }
  }
  return [...found].sort()
}

function declaredWorkspaces(rootManifest: string): string[] {
  try {
    const workspaces = (JSON.parse(rootManifest) as { workspaces?: unknown }).workspaces
    const list = Array.isArray(workspaces)
      ? workspaces
      : workspaces !== null && typeof workspaces === 'object'
        ? (workspaces as { packages?: unknown }).packages
        : undefined
    return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

async function readOrEmpty(path: string): Promise<string> {
  return await readFile(path, 'utf8').catch(() => '')
}
