import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { defaultField, parseEntryRef, resolveField, TypeVaultError } from 'typevault'

import type { SessionOrigin } from '@/agent/session-origin'
import type { CronExecEnvLease } from '@/cron/consumer'
import type { PermissionService } from '@/permissions'
import { CORE_PERMISSIONS } from '@/permissions/builtins'
import { renderBinWrapper } from '@/sandbox/dependency-bins'
import { typevaultBashCliPath } from '@/typevault/cli-path'
import {
  agentSocketPath,
  grantAccess,
  isRoleTier,
  runtimeConfigRoot,
  TYPEVAULT_STATE_RELATIVE_DIR,
  typevaultDir,
} from '@/typevault/vault'

import type { createSessionGrants } from './grants'

type SessionGrants = ReturnType<typeof createSessionGrants>

// Shared with other bundled plugins (managed-browser's browser_fill_secret)
// so they read through the same per-session grant, scoped to the role the
// session last called a tool as, instead of minting their own.
type VaultRuntime = {
  agentDir: string
  grants: SessionGrants
  roles: Map<string, string>
  permissions: PermissionService
}

let active: VaultRuntime | undefined

export function activateVaultRuntime(runtime: VaultRuntime | undefined): void {
  active = runtime
}

export function vaultRuntime(): VaultRuntime | undefined {
  return active
}

// An exec cron job runs without an LLM session, so it never reaches the bash
// hook that hands sessions their grant. Each fire gets its own grant for the
// tier of the role that scheduled the job, revoked when the process exits.
// The process runs unsandboxed, so it reaches the daemon's agent socket at
// its real path (TYPECLAW_VAULT_RUN_DIR) and the `typevault` command through
// a wrapper on PATH; both use the same TypeClaw-named variables model bash
// gets, so a project's own typevault CLI is never steered to this vault.
export async function cronExecVaultEnv(
  origin: Extract<SessionOrigin, { kind: 'cron' }>,
  fireId: string,
): Promise<CronExecEnvLease | undefined> {
  const runtime = active
  if (runtime === undefined || !runtime.permissions.has(origin, CORE_PERMISSIONS.vaultUse)) return undefined
  const tier = runtime.permissions.resolveRole(origin)
  if (!isRoleTier(tier)) return undefined
  // Prepared before the grant, so a failure here never leaves an issued grant
  // that no lease will release.
  const binDir = await ensureCronExecBinDir(runtime.agentDir)
  const key = `cron:${origin.jobId}:${fireId}`
  const token = await runtime.grants.tokenFor(key, tier)
  return {
    env: {
      TYPECLAW_VAULT_GRANT: token,
      TYPECLAW_VAULT_DIR: typevaultDir(runtime.agentDir),
      TYPECLAW_VAULT_RUN_DIR: dirname(agentSocketPath(runtime.agentDir, runtimeConfigRoot(runtime.agentDir))),
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
    release: () => runtime.grants.end(key),
  }
}

// Under the agent's private TypeVault state, which every model tool masks, so
// no session can replace the command an exec job runs with its grant.
const binDirs = new Map<string, Promise<string>>()

function ensureCronExecBinDir(agentDir: string): Promise<string> {
  const existing = binDirs.get(agentDir)
  if (existing !== undefined) return existing
  const ready = (async () => {
    const dir = join(agentDir, TYPEVAULT_STATE_RELATIVE_DIR, 'bin')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, 'typevault')
    await writeFile(path, renderBinWrapper(typevaultBashCliPath()))
    await chmod(path, 0o755)
    return dir
  })().catch((error: unknown) => {
    binDirs.delete(agentDir)
    throw error
  })
  binDirs.set(agentDir, ready)
  return ready
}

export type VaultRead = { ok: true; value: string } | { ok: false; reason: string }

export async function readVaultValue(sessionId: string, ref: string, reason: string): Promise<VaultRead> {
  if (active === undefined) return { ok: false, reason: 'TypeVault is not enabled for this agent' }
  const role = active.roles.get(sessionId)
  if (role === undefined || !isRoleTier(role)) return { ok: false, reason: 'this session has no vault tier' }
  try {
    const { name, field } = parseEntryRef(ref)
    const access = await grantAccess(active.agentDir, await active.grants.tokenFor(sessionId, role))
    const entry = await access.get(name, reason)
    const value =
      field === undefined ? entry.fields[defaultField(entry.fields, ref)] : resolveField(entry.fields, field)
    if (value === undefined) return { ok: false, reason: `${ref} has no such field` }
    if (value.type !== 'secret' && value.type !== 'text') {
      return { ok: false, reason: `${ref} is a ${value.type} field; use \`typevault run\` for it` }
    }
    return { ok: true, value: value.value }
  } catch (error) {
    if (error instanceof TypeVaultError) return { ok: false, reason: error.message }
    throw error
  }
}
