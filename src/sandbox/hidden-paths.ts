import { lstat, mkdir, opendir, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import { CORE_PERMISSIONS } from '@/permissions/builtins'
import type { PermissionService } from '@/permissions/permissions'

import {
  BROWSER_PROFILE_RELATIVE_DIR,
  CANONICAL_AGENT_SECRET_DIRS,
  CANONICAL_AGENT_SECRET_FILES,
  OPERATOR_CLI_CREDENTIAL_DIRS,
  RUNTIME_OWNED_SECRET_DIRS,
} from './canonical-secrets'
import { SandboxMaskTargetError } from './errors'
import { CANONICAL_AGENT_RUNTIME_PRIVATE_FILES } from './runtime-private'

export type HiddenPaths = {
  dirs: string[]
  files: string[]
}

const PRIVATE_DIRS = ['workspace', 'memory', 'sessions'] as const
const MAX_CANONICAL_SECRET_SCAN_ENTRIES = 4096

// The ordinary private working surface is role-scoped, but canonical credential
// files and runtime-owned credential directories are always masked.
// `permissions.has` resolves the role from the live origin and fails safe to
// guest (empty permissions) for an unclear/undefined origin, so a missing
// grant — whether from a low tier or an unresolvable author — hides the path.
//
// The security.bypass.* fallback keeps custom roles (which may never name
// fs.see.private) working by capability. fs.see.secrets remains useful for
// runtime-owned credential injection, but it deliberately cannot make raw
// .env, secrets.json, or historical auth.json bytes available to an LLM.
// Privileged diagnostics must
// use host-side commands that report presence/status without returning values.
export function resolveHiddenPaths(
  permissions: PermissionService,
  origin: SessionOrigin | undefined,
  agentDir: string,
): HiddenPaths {
  const seesPrivate = canSeePrivateSurface(permissions, origin)
  const dirs = [
    ...RUNTIME_OWNED_SECRET_DIRS.map((dir) => join(agentDir, dir)),
    ...(seesPrivate ? [] : [...OPERATOR_CLI_CREDENTIAL_DIRS, ...PRIVATE_DIRS].map((dir) => join(agentDir, dir))),
  ]
  const files = [...CANONICAL_AGENT_SECRET_FILES, ...CANONICAL_AGENT_RUNTIME_PRIVATE_FILES].map((f) =>
    join(agentDir, f),
  )
  return { dirs, files }
}

// Before canonical secret masking became unconditional, roles carrying both
// visibility capabilities ran bash unsandboxed and therefore had full write
// access to the agent root. They now enter bwrap so canonical credential paths
// can be masked, but must retain ordinary root-write capability. The policy
// overlays the secret masks after the RW root bind, so this does not restore raw
// credential access.
export function canWriteAgentRootInSandbox(permissions: PermissionService, origin: SessionOrigin | undefined): boolean {
  const seesSecrets =
    permissions.has(origin, CORE_PERMISSIONS.fsSeeSecrets) || permissions.has(origin, 'security.bypass.medium')
  return canSeePrivateSurface(permissions, origin) && seesSecrets
}

export function canSeePrivateSurface(permissions: PermissionService, origin: SessionOrigin | undefined): boolean {
  return (
    permissions.has(origin, CORE_PERMISSIONS.fsSeePrivate) ||
    permissions.has(origin, 'security.bypass.low') ||
    permissions.has(origin, 'security.bypass.medium')
  )
}

// SECURITY / bwrap contract: the mask ops REQUIRE a pre-existing target.
// `--ro-bind-data` (secret files) and `--tmpfs` (private dirs) create their
// mount point under the agent-folder bind, which fails "Read-only file system"
// on a virtiofs/OrbStack bind (bwrap cannot create it from its child user
// namespace). An agent whose folder legitimately lacks `.env` (keys live in
// secrets.json) would otherwise have EVERY sandboxed bash call abort at setup.
// Ensure each target on the REAL host FS first — the runtime owns agentDir RW
// here (only sandboxed bash sees it RO), so an empty placeholder is harmless and
// the mask binds over a real empty file, leaking nothing.
//
// ENSURE, not FILTER: privileged modes make the jail root RW
// (`writableRoot: agentDir`), so dropping an absent secret would let sandboxed
// code CREATE a canonical credential path for real (planting) or expose one created
// mid-session (TOCTOU). A guaranteed target keeps the mask always rendered over
// it (last-op-wins), closing that hole for every mode. Required masks are
// fail-closed: symlinks, wrong entry kinds, hardlinked files, materialization
// failures, or a late identity change abort bash.
export async function ensureHiddenMaskTargets(hidden: HiddenPaths): Promise<HiddenPaths> {
  const dirs = await Promise.all(hidden.dirs.map((target) => ensureRequiredDirMaskTarget(target)))
  const files = await Promise.all(hidden.files.map((target) => ensureRequiredFileMaskTarget(target)))
  return { dirs, files }
}

export async function verifyHiddenMaskTargets(hidden: HiddenPaths): Promise<void> {
  await Promise.all(hidden.dirs.map((target) => verifyRequiredMaskTarget(target, 'dir')))
  await Promise.all(hidden.files.map((target) => verifyRequiredMaskTarget(target, 'file')))
}

async function ensureRequiredDirMaskTarget(target: string): Promise<string> {
  await mkdir(target, { recursive: true }).catch(() => {})
  await verifyRequiredMaskTarget(target, 'dir')
  return target
}

async function ensureRequiredFileMaskTarget(target: string): Promise<string> {
  await ensureEmptyFile(target)
  await verifyRequiredMaskTarget(target, 'file')
  return target
}

async function verifyRequiredMaskTarget(target: string, kind: 'dir' | 'file'): Promise<void> {
  const stats = await lstat(target).catch(() => {
    throw new SandboxMaskTargetError(target, `could not materialize or inspect a ${kind}`)
  })
  if (stats.isSymbolicLink()) throw new SandboxMaskTargetError(target, 'symlinks are not maskable safely')
  if (kind === 'dir' && !stats.isDirectory()) throw new SandboxMaskTargetError(target, 'target is not a directory')
  if (kind === 'file' && !stats.isFile()) throw new SandboxMaskTargetError(target, 'target is not a regular file')
  if (kind === 'file' && stats.nlink !== 1) throw new SandboxMaskTargetError(target, 'target has hardlink aliases')
  if (kind === 'dir' && isCanonicalSecretDir(target)) await rejectHardlinksUnderCanonicalDir(target)
}

// The browser profile grows past the bounded scan through ordinary browsing
// (Chromium caches use about one file per entry), so scanning it per bash call
// would eventually block every command. Its only writer is the managed Chrome,
// which sees nothing but the profile and files directories, and every model tool
// masks it, so no alias can be planted while the runtime is up. Pre-existing
// aliases are refused once at browser boot instead (startManagedBrowser), which
// disables only the browser.
function isCanonicalSecretDir(target: string): boolean {
  return CANONICAL_AGENT_SECRET_DIRS.some(
    (dir) => dir !== BROWSER_PROFILE_RELATIVE_DIR && target.endsWith(`${sep}${dir.split('/').join(sep)}`),
  )
}

async function rejectHardlinksUnderCanonicalDir(root: string): Promise<void> {
  await rejectHardlinkAliases(root, MAX_CANONICAL_SECRET_SCAN_ENTRIES)
}

export async function rejectHardlinkAliases(root: string, maxEntries = Number.POSITIVE_INFINITY): Promise<void> {
  const pending = [root]
  let visited = 0
  while (pending.length > 0) {
    const current = pending.pop() as string
    const dir = await opendir(current).catch(() => {
      throw new SandboxMaskTargetError(root, 'canonical secret directory could not be scanned safely')
    })
    try {
      for await (const entry of dir) {
        visited += 1
        if (visited > maxEntries) {
          throw new SandboxMaskTargetError(root, 'canonical secret directory exceeds bounded hardlink scan')
        }
        const child = join(current, entry.name)
        const stats = await lstat(child)
        if (stats.isSymbolicLink()) continue
        if (stats.isDirectory()) pending.push(child)
        if (stats.isFile() && stats.nlink !== 1) {
          throw new SandboxMaskTargetError(root, `file under canonical secret directory has hardlink aliases: ${child}`)
        }
      }
    } finally {
      try {
        await dir.close()
      } catch {}
    }
  }
}

async function ensureEmptyFile(target: string): Promise<void> {
  try {
    await writeFile(target, '', { flag: 'wx' })
  } catch {
    // Already exists or lost a creation race; isRealEntry re-validates the kind
    // and rejects a symlink, so an existing regular file passes and anything
    // else is dropped from the mask.
  }
}
