import type { MatchRule } from './match-rule'

export type BuiltinRoleName = 'owner' | 'trusted' | 'member' | 'guest'

export const BUILTIN_ROLE_NAMES: readonly BuiltinRoleName[] = ['owner', 'trusted', 'member', 'guest']

// Core-owned permission strings; not contributed by plugins. The security
// plugin's `security.bypass.*` strings are NOT listed here — they are
// collected from plugin contributions and merged into `owner`'s permission
// set at boot via expandOwnerWildcard.
export const CORE_PERMISSIONS = {
  channelRespond: 'channel.respond',
  // Distinct from channelRespond so a respond-capable guest cannot abort
  // other speakers' sessions. The /stop command (both the text-prefix and
  // native-slash paths in the router) gates on this, not on channelRespond:
  // an operator may grant guest channelRespond to let strangers drive masked
  // turns, but session lifecycle control stays member-and-up.
  sessionControl: 'session.control',
  // Operate-the-agent tier: gates the /reload and /restart channel commands
  // (both the text-prefix and native-slash paths in the router). Strictly
  // above sessionControl — reloading config or restarting the container
  // mutates global agent state and drops every in-flight session, so it is
  // owner+trusted only (NOT member). A member who can /stop a turn must not
  // be able to bounce the whole container.
  sessionAdmin: 'session.admin',
  cronSchedule: 'cron.schedule',
  cronModify: 'cron.modify',
  subagentSpawn: 'subagent.spawn',
  subagentCancel: 'subagent.cancel',
  subagentOutput: 'subagent.output',
  subagentSpawnOperator: 'subagent.spawn.operator',
  subagentSpawnDeep: 'subagent.spawn.deep',
  // Phrased as capabilities to SEE, not to hide, so the role tower stays
  // monotonic (a higher tier sees a strict superset of a lower tier).
  // resolveHiddenPaths masks whatever the resolved role lacks: fsSeePrivate
  // gates workspace/+memory/+sessions/, fsSeeSecrets gates .env+secrets.json.
  // The fail-safe floor is the undefined origin (see has() in
  // permissions.ts), not the guest role, which is now grantable.
  fsSeePrivate: 'fs.see.private',
  fsSeeSecrets: 'fs.see.secrets',
} as const

// Sentinel that `expandOwnerWildcard` swaps for the concrete union of
// plugin-registered `security.bypass.*` strings. Users cannot write `*` in
// their own `permissions[]`; the sentinel exists only inside the built-in
// `owner` spec.
export const OWNER_SECURITY_WILDCARD = '__BUILTIN_OWNER_SECURITY_WILDCARD__'

export type BuiltinRoleSpec = {
  readonly match: readonly MatchRule[]
  readonly permissions: readonly string[]
}

// Role-to-tier defaults form a strict tower:
//   owner   → bypass.low + bypass.medium + bypass.high
//   trusted → bypass.low + bypass.medium
//   member  → bypass.low
//   guest   → no bypass
//
// `canBypass` in the bundled security plugin checks the specific tier
// string for the guard's severity, so each role must carry every tier
// string at or below its cap (tiers do not cascade implicitly).
//
// Owner also carries the wildcard sentinel: the sentinel expands to every
// plugin-contributed `security.bypass.*` string minus
// `ownerWildcardExclusions`. The bundled security plugin no longer excludes
// high-tier strings (owner is meant to bypass them by default under this
// model), so the sentinel covers per-guard high-tier strings too.
//
// Tradeoff: this gives owner audience-leak bypass without per-call ack.
// The owner-in-public-channel risk is now load-bearing on the operator
// scoping `roles.owner.match[]` tightly. Default match is TUI-only, where
// a human is present; configs that widen owner to a channel author should
// understand they have re-opened audience-leak for that author.
export const BUILTIN_ROLES: Readonly<Record<BuiltinRoleName, BuiltinRoleSpec>> = {
  owner: {
    match: [{ kind: 'tui' }],
    permissions: [
      CORE_PERMISSIONS.channelRespond,
      CORE_PERMISSIONS.sessionControl,
      CORE_PERMISSIONS.sessionAdmin,
      CORE_PERMISSIONS.cronSchedule,
      CORE_PERMISSIONS.cronModify,
      CORE_PERMISSIONS.subagentSpawn,
      CORE_PERMISSIONS.subagentCancel,
      CORE_PERMISSIONS.subagentOutput,
      CORE_PERMISSIONS.subagentSpawnOperator,
      CORE_PERMISSIONS.subagentSpawnDeep,
      CORE_PERMISSIONS.fsSeePrivate,
      CORE_PERMISSIONS.fsSeeSecrets,
      'security.bypass.low',
      'security.bypass.medium',
      'security.bypass.high',
      OWNER_SECURITY_WILDCARD,
    ],
  },
  trusted: {
    match: [],
    permissions: [
      CORE_PERMISSIONS.channelRespond,
      CORE_PERMISSIONS.sessionControl,
      CORE_PERMISSIONS.sessionAdmin,
      CORE_PERMISSIONS.cronSchedule,
      CORE_PERMISSIONS.subagentSpawn,
      CORE_PERMISSIONS.subagentCancel,
      CORE_PERMISSIONS.subagentOutput,
      CORE_PERMISSIONS.subagentSpawnOperator,
      CORE_PERMISSIONS.subagentSpawnDeep,
      CORE_PERMISSIONS.fsSeePrivate,
      CORE_PERMISSIONS.fsSeeSecrets,
      'security.bypass.low',
      'security.bypass.medium',
    ],
  },
  member: {
    match: [],
    permissions: [
      CORE_PERMISSIONS.channelRespond,
      CORE_PERMISSIONS.sessionControl,
      CORE_PERMISSIONS.subagentSpawn,
      CORE_PERMISSIONS.subagentCancel,
      CORE_PERMISSIONS.subagentOutput,
      CORE_PERMISSIONS.fsSeePrivate,
      'security.bypass.low',
    ],
  },
  guest: {
    match: [],
    permissions: [],
  },
}

// Expands the owner wildcard sentinel against plugin-contributed
// `security.bypass.*` strings. `wildcardExclusions` lets plugins opt
// specific strings OUT of the wildcard expansion. The bundled security
// plugin no longer excludes any high-tier strings — owner bypasses every
// security tier by default under the current role-tower model. The
// parameter is preserved for third-party plugins that want a different
// shape (e.g. a future audit-only plugin that never auto-flows to owner).
export function expandOwnerWildcard(
  ownerPermissions: readonly string[],
  pluginContributed: readonly string[],
  wildcardExclusions: readonly string[] = [],
): readonly string[] {
  const excludeSet = new Set(wildcardExclusions)
  const bypass = pluginContributed.filter((p) => p.startsWith('security.bypass.') && !excludeSet.has(p))
  const out: string[] = []
  for (const p of ownerPermissions) {
    if (p === OWNER_SECURITY_WILDCARD) {
      for (const b of bypass) if (!out.includes(b)) out.push(b)
      continue
    }
    if (!out.includes(p)) out.push(p)
  }
  return out
}

export function isBuiltinRoleName(name: string): name is BuiltinRoleName {
  return (BUILTIN_ROLE_NAMES as readonly string[]).includes(name)
}
