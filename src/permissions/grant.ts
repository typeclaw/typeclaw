import { join } from 'node:path'

import { commitConfigWriteSync, readConfigForWriteSync } from '@/config/config-commits'
import { withConfigFileLockSync } from '@/config/config-file-lock'
import { commitSystemFileSync } from '@/git/system-commit'

import { BUILTIN_ROLES, isBuiltinRoleName } from './builtins'
import { parseMatchRule } from './match-rule'

// Appends `rule` to `typeclaw.json#roles.<name>.match`, creating the role
// block when missing. Idempotent: re-granting the same rule is a no-op.
// Writes in place through commitConfigWriteSync, which refuses, writing
// nothing, unless typeclaw.json is still the regular file the grant read.
//
// Used by the role-claim flow (after a successful handshake) and by any
// future operator-direct grant command. The match rule is validated
// against the same parser that runs at config load, so a malformed rule
// fails here instead of bricking the next start.

const CONFIG_FILE = 'typeclaw.json'

export type GrantResult = { ok: true; added: boolean } | { ok: false; reason: string }

export type GrantOptions = {
  cwd: string
  roleName: string
  matchRule: string
}

export type GrantPermissionOptions = {
  cwd: string
  roleName: string
  permission: string
}

export function grantRole(opts: GrantOptions): GrantResult {
  const result = underConfigLock(opts.cwd, () => {
    const validation = parseMatchRule(opts.matchRule)
    if (!validation.ok) {
      return { ok: false, reason: `invalid match rule '${opts.matchRule}': ${validation.error}` }
    }

    const loaded = loadConfigObject(opts.cwd, opts.roleName)
    if (!loaded.ok) return loaded

    const { obj, roles, role } = loaded
    const existingMatch = Array.isArray(role.match) ? [...(role.match as unknown[])] : []

    // Dedup by exact string equality — match rules canonicalize during load,
    // and a literal duplicate in the file is a noise source the schema doesn't
    // currently dedupe for us.
    if (existingMatch.includes(opts.matchRule)) {
      return { ok: true, added: false }
    }

    role.match = [...existingMatch, opts.matchRule]
    roles[opts.roleName] = role
    obj.roles = roles

    return writeConfigObject(opts.cwd, obj)
  })

  // Best-effort commit so a claimed role survives a fresh clone/rebuild — a
  // failing commit leaves the on-disk grant intact (history, not correctness).
  // Subject stays neutral: every grantRole caller hits this, not just claim.
  if (result.ok && result.added) {
    commitSystemFileSync(opts.cwd, CONFIG_FILE, `${CONFIG_FILE}: grant ${opts.roleName} role`)
  }
  return result
}

// Appends `permission` to `typeclaw.json#roles.<name>.permissions`. For a
// built-in role with no explicit `permissions[]`, the runtime treats the
// field as "use built-in defaults" (see resolveOne in permissions.ts), so a
// naive write of `[permission]` would NARROW the role to a single capability,
// silently dropping its defaults. We materialize the current effective set
// (explicit field if present, else the built-in default list) and append to
// THAT, preserving every existing capability. Idempotent: a permission the
// role already holds is a no-op.
//
// NOTE: `roles.permissions` is `restart-required` (FIELD_EFFECTS); the write
// lands on disk but does not take effect until the next container restart.
// Callers must surface that to the operator.
export function grantRolePermission(opts: GrantPermissionOptions): GrantResult {
  return underConfigLock(opts.cwd, () => {
    const loaded = loadConfigObject(opts.cwd, opts.roleName)
    if (!loaded.ok) return loaded

    const { obj, roles, role } = loaded
    const effective = effectivePermissions(opts.roleName, role)

    if (effective.includes(opts.permission)) {
      return { ok: true, added: false }
    }

    role.permissions = [...effective, opts.permission]
    roles[opts.roleName] = role
    obj.roles = roles

    return writeConfigObject(opts.cwd, obj)
  })
}

// A busy config lock is a grant failure like any other, so role claim and
// grant_role reply with it instead of throwing past their error paths.
function underConfigLock(cwd: string, grant: () => GrantResult): GrantResult {
  try {
    return withConfigFileLockSync(join(cwd, CONFIG_FILE), grant)
  } catch (error) {
    return { ok: false, reason: describeError(error) }
  }
}

function effectivePermissions(roleName: string, role: Record<string, unknown>): string[] {
  if (Array.isArray(role.permissions)) {
    return role.permissions.filter((p): p is string => typeof p === 'string')
  }
  if (isBuiltinRoleName(roleName)) {
    return [...BUILTIN_ROLES[roleName].permissions]
  }
  return []
}

type LoadedConfig = {
  ok: true
  obj: Record<string, unknown>
  roles: Record<string, unknown>
  role: Record<string, unknown>
}

function loadConfigObject(cwd: string, roleName: string): LoadedConfig | { ok: false; reason: string } {
  const path = join(cwd, CONFIG_FILE)
  let raw: string
  try {
    raw = readConfigForWriteSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: `${CONFIG_FILE} not found at ${cwd}` }
    }
    return { ok: false, reason: `failed to read ${CONFIG_FILE}: ${describeError(error)}` }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    return { ok: false, reason: `${CONFIG_FILE} is not valid JSON: ${describeError(error)}` }
  }

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, reason: `${CONFIG_FILE} must be a JSON object` }
  }

  const obj = json as Record<string, unknown>
  const roles = isPlainObject(obj.roles) ? { ...obj.roles } : {}
  const role = isPlainObject(roles[roleName]) ? { ...(roles[roleName] as Record<string, unknown>) } : {}
  return { ok: true, obj, roles, role }
}

function writeConfigObject(cwd: string, obj: Record<string, unknown>): GrantResult {
  const path = join(cwd, CONFIG_FILE)
  const bytes = `${JSON.stringify(obj, null, 2)}\n`
  try {
    commitConfigWriteSync(path, bytes)
  } catch (error) {
    return { ok: false, reason: `failed to write ${CONFIG_FILE}: ${describeError(error)}` }
  }
  return { ok: true, added: true }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
