import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  type Access,
  defaultField,
  type EntryName,
  type EntryValue,
  type Field,
  type Passkey,
  parseEntryRef,
  resolveField,
  TypeVaultError,
} from 'typevault'

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
  return withSessionAccess(sessionId, async (access) => {
    const { name, field } = parseEntryRef(ref)
    const entry = await access.get(name, reason)
    // A part such as `#passkey.private_key` resolves to a plain secret, so check the field it comes from too.
    if (field !== undefined && passkeySourceOf(entry.fields, field) !== undefined) {
      return { ok: false, reason: `${ref} is part of a passkey; sign in with it through \`browser_passkey\`` }
    }
    const value =
      field === undefined ? entry.fields[defaultField(entry.fields, ref)] : resolveField(entry.fields, field)
    if (value === undefined) return { ok: false, reason: `${ref} has no such field` }
    if (value.type === 'passkey') {
      return { ok: false, reason: `${ref} is a passkey; sign in with it through \`browser_passkey\`` }
    }
    if (value.type !== 'secret' && value.type !== 'text') {
      return { ok: false, reason: `${ref} is a ${value.type} field; use \`typevault run\` for it` }
    }
    return { ok: true, value: value.value }
  })
}

export type VaultWrite = { ok: true; name: string } | { ok: false; reason: string }

// Where a registration will store its passkey, checked before the site is asked to create one. `existing` is the
// entry as read then, so the save is a compare-and-swap against it.
export type PasskeyRegistration = {
  readonly name: EntryName
  readonly field: string
  readonly existing?: EntryValue
}

export async function planPasskeyRegistration(
  sessionId: string,
  ref: string,
  reason: string,
): Promise<{ ok: true; plan: PasskeyRegistration } | { ok: false; reason: string }> {
  return withSessionAccess(sessionId, async (access, role) => {
    const { name, field = PASSKEY_FIELD } = parseEntryRef(ref)
    if ((await access.list()).every((entry) => entry.name !== name)) {
      const unavailable = await newNameUnavailable(access, name, role)
      return unavailable === undefined ? { ok: true, plan: { name, field } } : { ok: false, reason: unavailable }
    }
    const existing = await access.get(name, reason)
    if (existing.tier !== role) {
      return {
        ok: false,
        reason: `${ref} is in tier ${existing.tier}; this session can only add a passkey to an entry in its own tier, ${role}`,
      }
    }
    const key = fieldKey(existing.fields, field) ?? field
    const taken = existing.fields[key]
    if (taken !== undefined) {
      return {
        ok: false,
        reason: `typevault://${name}#${key} already holds a ${taken.type} field; name another field, e.g. typevault://${name}#passkey-2`,
      }
    }
    // With one named field and no `$default`, that field is the entry's implicit default: bare references, and an
    // env override, resolve to it. A second field would end that and break them.
    if (!Object.hasOwn(existing.fields, '$default') && Object.keys(existing.fields).length === 1) {
      return {
        ok: false,
        reason: `typevault://${name} has one field, which bare references to the entry resolve to, and a second field would break them; save the passkey in its own entry, e.g. typevault://${name}-passkey`,
      }
    }
    return { ok: true, plan: { name, field: key, existing } }
  })
}

// Keeps the entry's other fields, its env override, its origin and any rotation warning (the new field rotates none
// of the others), and fails if the name no longer holds the planned entry at the planned revision.
export async function savePasskeyRegistration(
  sessionId: string,
  plan: PasskeyRegistration,
  passkey: Passkey,
  origin: string | undefined,
): Promise<VaultWrite> {
  return withSessionAccess(sessionId, async (access, role) => {
    const { existing } = plan
    await access.set({
      name: plan.name,
      fields: { ...existing?.fields, [plan.field]: { type: 'passkey', value: passkey } },
      tier: existing?.tier ?? role,
      env: existing?.env,
      origin: existing?.origin ?? origin,
      tags: existing?.tags,
      ifRev: existing?.rev ?? 0,
      ifId: existing?.id,
      rotates: false,
    })
    return { ok: true, name: `typevault://${plan.name}#${plan.field}` }
  })
}

// The passkey a sign-in uses, with the stored field key it came from, so its sign count is written back there.
export type PasskeySignIn = {
  readonly name: EntryName
  readonly id: string
  readonly field: string
  readonly passkey: Passkey
}

// A ref without `#field` means the entry's `passkey` field, else its only passkey field.
export async function readPasskeyForSignIn(
  sessionId: string,
  ref: string,
  reason: string,
): Promise<{ ok: true; signIn: PasskeySignIn } | { ok: false; reason: string }> {
  return withSessionAccess(sessionId, async (access) => {
    const { name, field } = parseEntryRef(ref)
    const entry = await access.get(name, reason)
    const passkeys = Object.keys(entry.fields).filter((key) => entry.fields[key]?.type === 'passkey')
    const key =
      field !== undefined
        ? fieldKey(entry.fields, field)
        : Object.hasOwn(entry.fields, PASSKEY_FIELD)
          ? PASSKEY_FIELD
          : passkeys.length === 1
            ? passkeys[0]
            : undefined
    const value = key === undefined ? undefined : entry.fields[key]
    if (key === undefined || value?.type !== 'passkey') return { ok: false, reason: `${ref} holds no passkey` }
    return { ok: true, signIn: { name, id: entry.id, field: key, passkey: value.value } }
  })
}

// Writes back the sign count a sign-in advanced, and only that: the entry must still hold the same credential in
// the same field, a rotation or removal in the meantime wins, and a missing entry is never recreated.
export async function recordPasskeySignIn(
  sessionId: string,
  signIn: PasskeySignIn,
  used: Passkey,
): Promise<{ ok: true; recorded: boolean } | { ok: false; reason: string }> {
  return withSessionAccess(sessionId, async (access) => {
    const ref = `typevault://${signIn.name}#${signIn.field}`
    if ((await access.list()).every((entry) => entry.name !== signIn.name)) {
      return { ok: false, reason: `${ref} was removed during the sign-in` }
    }
    const current = await access.get(signIn.name, 'record a passkey sign-in')
    const stored = current.fields[signIn.field]
    if (
      current.id !== signIn.id ||
      stored?.type !== 'passkey' ||
      stored.value.credential_id !== signIn.passkey.credential_id
    ) {
      return { ok: false, reason: `${ref} changed during the sign-in` }
    }
    const count = used.sign_count ?? 0
    if (count <= (stored.value.sign_count ?? 0)) return { ok: true, recorded: false }
    // The count stays in the entry's own tier, which this grant reaches; TypeVault refuses a write the grant can't make.
    await access.set({
      name: signIn.name,
      fields: { ...current.fields, [signIn.field]: { type: 'passkey', value: { ...stored.value, sign_count: count } } },
      tier: current.tier,
      env: current.env,
      origin: current.origin,
      tags: current.tags,
      ifRev: current.rev,
      ifId: signIn.id,
      // A sign count is no credential, so the entry's rotation warning stays.
      rotates: false,
    })
    return { ok: true, recorded: true }
  })
}

// The stored key `field` names: an exact match, else the only one equal ignoring case, as TypeVault resolves it.
function fieldKey(fields: Readonly<Record<string, Field>>, field: string): string | undefined {
  if (Object.hasOwn(fields, field)) return field
  const matches = Object.keys(fields).filter((key) => key.toLowerCase() === field.toLowerCase())
  return matches.length === 1 ? matches[0] : undefined
}

// A name this grant can't list may still be taken by an entry it can't see, which the real write would refuse only
// after the site created a credential. TypeVault's write checks the tier and that collision before the revision, and
// fails a revision that can't match before storing anything, so a write at an impossible revision is a dry run: the
// revision mismatch it reaches means the name is free. Any other conflict (a name in two unrelated tiers, say) is
// the real write's refusal too. It reports what the write would, so it discloses nothing more.
// The end of TypeVault's message for a write at this preflight's impossible revision.
const REVISION_MISMATCH = `, not ${Number.MAX_SAFE_INTEGER}`

async function newNameUnavailable(access: Access, name: EntryName, tier: string): Promise<string | undefined> {
  try {
    await access.set({
      name,
      tier,
      fields: { probe: { type: 'text', value: 'probe' } },
      ifRev: Number.MAX_SAFE_INTEGER,
    })
  } catch (error) {
    if (error instanceof TypeVaultError && error.code === 'conflict' && error.message.endsWith(REVISION_MISMATCH)) {
      return undefined
    }
    if (error instanceof TypeVaultError) return error.message
    throw error
  }
  throw new Error(`a dry-run write of ${name} was stored`)
}

// The field a bare part belongs to, as TypeVault's defaultFieldOf picks it: `$default`, else the only field.
function implicitDefaultOf(fields: Readonly<Record<string, Field>>): string | undefined {
  if (Object.hasOwn(fields, '$default')) return '$default'
  const keys = Object.keys(fields)
  return keys.length === 1 ? keys[0] : undefined
}

// The passkey field a ref's part comes from (`passkey.private_key`, or a bare part of a passkey default field).
function passkeySourceOf(fields: Readonly<Record<string, Field>>, field: string): string | undefined {
  if (fieldKey(fields, field) !== undefined) return undefined
  const dot = field.lastIndexOf('.')
  const parent = dot === -1 ? implicitDefaultOf(fields) : fieldKey(fields, field.slice(0, dot))
  return parent !== undefined && fields[parent]?.type === 'passkey' ? parent : undefined
}

const PASSKEY_FIELD = 'passkey'

async function withSessionAccess<T extends { ok: boolean }>(
  sessionId: string,
  use: (access: Access, role: string) => Promise<T | { ok: false; reason: string }>,
): Promise<T | { ok: false; reason: string }> {
  if (active === undefined) return { ok: false, reason: 'TypeVault is not enabled for this agent' }
  const role = active.roles.get(sessionId)
  if (role === undefined || !isRoleTier(role)) return { ok: false, reason: 'this session has no vault tier' }
  try {
    return await use(await grantAccess(active.agentDir, await active.grants.tokenFor(sessionId, role)), role)
  } catch (error) {
    if (error instanceof TypeVaultError) return { ok: false, reason: error.message }
    throw error
  }
}
