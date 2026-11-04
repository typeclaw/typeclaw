import { defaultField, parseEntryRef, resolveField, TypeVaultError } from 'typevault'

import { grantAccess, isRoleTier } from '@/typevault/vault'

import type { createSessionGrants } from './grants'

type SessionGrants = ReturnType<typeof createSessionGrants>

// Shared with other bundled plugins (managed-browser's browser_fill_secret)
// so they read through the same per-session grant, scoped to the role the
// session last called a tool as, instead of minting their own.
type VaultRuntime = { agentDir: string; grants: SessionGrants; roles: Map<string, string> }

let active: VaultRuntime | undefined

export function activateVaultRuntime(runtime: VaultRuntime | undefined): void {
  active = runtime
}

export function vaultRuntime(): VaultRuntime | undefined {
  return active
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
