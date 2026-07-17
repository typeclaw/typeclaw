import { lstat, mkdir, opendir, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import { CORE_PERMISSIONS } from '@/permissions/builtins'
import type { PermissionService } from '@/permissions/permissions'

import { CANONICAL_AGENT_SECRET_DIRS, CANONICAL_AGENT_SECRET_FILES } from './canonical-secrets'
import { SandboxMaskTargetError } from './errors'

export type HiddenPaths = {
  dirs: string[]
  files: string[]
  // Subset of `dirs` whose contents are reusable credentials. These get the
  // recursive hardlink-alias scan and ancestor-symlink rejection at mask time,
  // regardless of whether the operator configured an absolute or relative path.
  credentialDirs?: string[]
  // Agent-root boundary for the ancestor-symlink walk. Only path components
  // STRICTLY BELOW this are attacker-relevant; the agent root and anything above
  // it (`/`, `/private/var` on macOS, the tmpfs bind) are system-owned, so
  // walking from `/` would false-positive on platform symlinks like `/var`.
  agentRoot?: string
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
  const canonicalDirs = CANONICAL_AGENT_SECRET_DIRS.map((dir) => join(agentDir, dir))
  const messengerDir = resolvedMessengerCredentialDir(agentDir)
  const credentialDirs = [...canonicalDirs, ...(messengerDir === undefined ? [] : [messengerDir])]
  const dirs = [...credentialDirs, ...(seesPrivate ? [] : PRIVATE_DIRS.map((dir) => join(agentDir, dir)))]
  const files = CANONICAL_AGENT_SECRET_FILES.map((f) => join(agentDir, f))
  return { dirs, files, credentialDirs, agentRoot: agentDir }
}

// An operator may relocate agent-messenger's credential dir via
// AGENT_MESSENGER_CONFIG_DIR (e.g. a noncanonical workspace/.config/agent-messenger).
// Its reusable tokens must be masked from sandboxed bash exactly like the
// canonical workspace/.agent-messenger — otherwise a workspace-visible role's
// bash reads the profile. Return the resolved path only when it stays STRICTLY
// inside agentDir: equality (AGENT_MESSENGER_CONFIG_DIR=.) would --tmpfs the whole
// agent root, and a value outside agentDir is not ours to mask. `resolve`
// collapses `..`, so the strict-prefix check is a real lexical containment gate;
// ancestor-symlink escape is caught at mask time by rejectSymlinkAncestors.
function resolvedMessengerCredentialDir(agentDir: string): string | undefined {
  const configured = process.env.AGENT_MESSENGER_CONFIG_DIR
  if (configured === undefined || configured.length === 0) return undefined
  const resolved = resolve(agentDir, configured)
  const canonical = CANONICAL_AGENT_SECRET_DIRS.map((dir) => join(agentDir, dir))
  if (canonical.includes(resolved)) return undefined
  return resolved.startsWith(`${agentDir}${sep}`) ? resolved : undefined
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

function canSeePrivateSurface(permissions: PermissionService, origin: SessionOrigin | undefined): boolean {
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
  const credentialDirs = new Set(hidden.credentialDirs ?? [])
  const agentRoot = hidden.agentRoot
  const dirs = await Promise.all(
    hidden.dirs.map((target) => ensureRequiredDirMaskTarget(target, credentialDirs, agentRoot)),
  )
  const files = await Promise.all(hidden.files.map((target) => ensureRequiredFileMaskTarget(target)))
  return {
    dirs,
    files,
    ...(hidden.credentialDirs === undefined ? {} : { credentialDirs: hidden.credentialDirs }),
    ...(agentRoot === undefined ? {} : { agentRoot }),
  }
}

export async function verifyHiddenMaskTargets(hidden: HiddenPaths): Promise<void> {
  const credentialDirs = new Set(hidden.credentialDirs ?? [])
  const agentRoot = hidden.agentRoot
  await Promise.all(hidden.dirs.map((target) => verifyRequiredMaskTarget(target, 'dir', credentialDirs, agentRoot)))
  await Promise.all(hidden.files.map((target) => verifyRequiredMaskTarget(target, 'file', new Set(), undefined)))
}

async function ensureRequiredDirMaskTarget(
  target: string,
  credentialDirs: ReadonlySet<string>,
  agentRoot: string | undefined,
): Promise<string> {
  if (credentialDirs.has(target)) await rejectSymlinkAncestors(target, agentRoot)
  await mkdir(target, { recursive: true }).catch(() => {})
  await verifyRequiredMaskTarget(target, 'dir', credentialDirs, agentRoot)
  return target
}

async function ensureRequiredFileMaskTarget(target: string): Promise<string> {
  await ensureEmptyFile(target)
  await verifyRequiredMaskTarget(target, 'file', new Set(), undefined)
  return target
}

async function verifyRequiredMaskTarget(
  target: string,
  kind: 'dir' | 'file',
  credentialDirs: ReadonlySet<string>,
  agentRoot: string | undefined,
): Promise<void> {
  const stats = await lstat(target).catch(() => {
    throw new SandboxMaskTargetError(target, `could not materialize or inspect a ${kind}`)
  })
  if (stats.isSymbolicLink()) throw new SandboxMaskTargetError(target, 'symlinks are not maskable safely')
  if (kind === 'dir' && !stats.isDirectory()) throw new SandboxMaskTargetError(target, 'target is not a directory')
  if (kind === 'file' && !stats.isFile()) throw new SandboxMaskTargetError(target, 'target is not a regular file')
  if (kind === 'file' && stats.nlink !== 1) throw new SandboxMaskTargetError(target, 'target has hardlink aliases')
  if (kind === 'dir' && credentialDirs.has(target)) {
    await rejectSymlinkAncestors(target, agentRoot)
    await rejectHardlinksUnderCanonicalDir(target)
  }
}

// A masked credential dir must have NO symlink in any path component BELOW the
// agent root. mkdir(recursive)/lstat/opendir all FOLLOW an ancestor symlink, so
// a planted `workspace/link -> /tmp/outside` would let the mask materialize and
// scan run under an attacker-chosen tree outside the agent — defeating
// containment. Walk each component strictly below `agentRoot` (the root and
// above are system-owned: `/`, `/private/var`, the tmpfs bind — checking those
// would false-positive on platform symlinks like macOS `/var`). Nonexistent
// trailing components are fine (the mask ensures them next); only EXISTING
// components are checked, and any that IS a symlink fails closed. Without a known
// agentRoot the walk is skipped (the direct-target symlink check still applies).
async function rejectSymlinkAncestors(target: string, agentRoot: string | undefined): Promise<void> {
  if (agentRoot === undefined || !target.startsWith(`${agentRoot}${sep}`)) return
  const rest = target
    .slice(agentRoot.length + 1)
    .split(sep)
    .filter((s) => s.length > 0)
  let current = agentRoot
  for (const segment of rest) {
    current = `${current}${sep}${segment}`
    const stats = await lstat(current).catch(() => undefined)
    if (stats === undefined) return
    if (stats.isSymbolicLink()) {
      throw new SandboxMaskTargetError(target, `credential mask path has a symlinked ancestor: ${current}`)
    }
  }
}

async function rejectHardlinksUnderCanonicalDir(root: string): Promise<void> {
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
        if (visited > MAX_CANONICAL_SECRET_SCAN_ENTRIES) {
          throw new SandboxMaskTargetError(root, 'canonical secret directory exceeds bounded hardlink scan')
        }
        const child = join(current, entry.name)
        const stats = await lstat(child)
        // A symlink inside a credential dir is an escape: masking the dir with
        // --tmpfs hides the LINK, but the SDK writes/reads the token through it to
        // a visible target outside the mask. Reject rather than skip.
        if (stats.isSymbolicLink()) {
          throw new SandboxMaskTargetError(root, `symlink under credential directory escapes the mask: ${child}`)
        }
        if (stats.isDirectory()) pending.push(child)
        if (stats.isFile() && stats.nlink !== 1) {
          throw new SandboxMaskTargetError(root, `file under credential directory has hardlink aliases: ${child}`)
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
