import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'

import { MEMBERSHIP_FRESHNESS_MS, type MembershipCount } from '@/channels/membership'
import {
  grantRole,
  grantRolePermission,
  isDmChannelOrigin,
  parseMatchRule,
  type PermissionService,
  type RolesConfig,
} from '@/permissions'

import type { SessionOrigin } from '../session-origin'

export type GrantRoleToolDetails =
  | { ok: true; mode: 'match' | 'permission'; role: string; value: string; added: boolean; restartRequired: boolean }
  | { ok: false; error: string }

export type CreateGrantRoleToolOptions = {
  agentDir: string
  getOrigin: () => SessionOrigin | undefined
  permissions: PermissionService
  // Re-reads roles FROM DISK and returns the fresh set, for hot-reloading a
  // match-grant after grantRole writes typeclaw.json. Must NOT read an
  // in-memory config snapshot: grantRole writes the file directly, so a
  // snapshot taken before the live config pointer is reloaded would be stale
  // and replaceRoles would reapply the pre-grant table. Production wires this
  // to reloadConfig(agentDir) + getConfig().roles, matching the config
  // reloadable. A permission-grant is restart-required, so the reload has no
  // runtime effect for it, but we reload anyway to keep a same-session
  // subsequent match-grant reading a consistent table.
  reloadRoles: () => RolesConfig | undefined
}

// Roles this tool may target, lowest to highest. `guest` is a valid target
// (an operator opening guest channel.respond) but never a granter — the gate
// below requires the caller to resolve to owner/trusted.
const TIER_ORDER = ['guest', 'member', 'trusted', 'owner'] as const
type TierRole = (typeof TIER_ORDER)[number]

function tierOf(role: string): number {
  return TIER_ORDER.indexOf(role as TierRole)
}

function isTierRole(role: string): role is TierRole {
  return (TIER_ORDER as readonly string[]).includes(role)
}

// A single-principal turn carries only the principal's own first-party words:
// the TUI (a human typing directly) or a 1:1 DM (principal + bot, no
// third-party messages buffered in). A group/open channel turn normally mixes
// in other authors' messages, which is the confused-deputy surface that lets a
// guest prompt-inject a trusted turn into rewriting the access-control table.
// Role grants are confined to turns where that surface does not exist.
function isSinglePrincipalOrigin(origin: SessionOrigin | undefined): boolean {
  if (origin === undefined) return false
  if (origin.kind === 'tui') return true
  if (origin.kind === 'channel') return isDmChannelOrigin(origin)
  return false
}

// Shared precondition for treating a non-DM channel as injection-equivalent to
// a 1:1 DM. A DM is safe because it is "principal + the agent's OWN bot, no
// third-party content". For a group channel we must independently prove the
// same room shape from a membership read:
//   - fresh and NOT truncated, so the count is the complete current membership
//     (`participants` is speaker-only and cannot see silent lurkers — never
//     used for authorization here);
//   - `bots === 1`, i.e. the only non-human is the agent itself. The agent's
//     own bot is always a member of a chat channel and is never an inbound
//     author (adapters drop self-authored messages), so a complete read with
//     exactly one bot proves there are NO peer bots whose buffered messages
//     could prompt-inject the turn. A peer bot would push the count to >= 2
//     (or, if misclassified as human, trip the human checks) — fail-closed
//     either way.
// GitHub is excluded: its membership is the repo COLLABORATOR list, a different
// population from the authors that can comment into a PR/issue turn (and the
// agent App is typically not a collaborator), so `bots === 1` is not a valid
// "no peer bot" proof there. GitHub grants stay confined to the TUI/DM path.
function provesOnlyAgentBotPresent(
  origin: Extract<SessionOrigin, { kind: 'channel' }>,
  now: number,
): origin is Extract<SessionOrigin, { kind: 'channel' }> & { membership: MembershipCount } {
  if (origin.adapter === 'github') return false
  const membership = origin.membership
  if (membership === undefined) return false
  if (membership.truncated) return false
  if (now - membership.fetchedAt >= MEMBERSHIP_FRESHNESS_MS) return false
  return membership.bots === 1
}

// A group/open channel that the platform proves contains exactly one human AND
// no peer bots is injection-equivalent to a 1:1 DM: there is no third-party
// author (human or bot) whose buffered messages could prompt-inject the turn.
// The lone human is the caller, and the per-turn caller-role check below still
// requires them to resolve to owner/trusted.
function isSingleHumanGroupChannelOrigin(origin: SessionOrigin | undefined, now: number): boolean {
  if (origin?.kind !== 'channel') return false
  if (isDmChannelOrigin(origin)) return false
  if (!provesOnlyAgentBotPresent(origin, now)) return false

  return origin.membership.humans === 1
}

// Caps the per-member role resolution this check performs so it can never do
// unbounded work on a large room. resolveRole is in-memory (a match-rule walk,
// no I/O), so the real cost is small, but a trusted-only operational channel is
// small by nature and past this many humans we refuse rather than iterate an
// arbitrarily long list on a tool call. Adapters already stop enumerating past
// their own cap; this is the guard-local ceiling.
const MAX_TRUSTED_GROUP_HUMANS = 20

// Generalises the single-human case: a group channel where the platform proves
// EVERY human member resolves to trusted/owner AND no peer bots are present is
// also injection-equivalent to a DM, because no untrusted author (human or bot)
// can buffer a message into the turn. The human proof requires an authoritative,
// complete identity enumeration — only a fresh, non-truncated membership read
// that carries `humanMemberIds` (the adapter listed and classified every member
// in one pass). `humanMemberIds` length must equal `humans` so an unaccounted
// member cannot slip past; the resolvers construct it that way and we re-check
// defensively. The no-peer-bot proof is shared with the single-human branch via
// provesOnlyAgentBotPresent (also enforces fresh/non-truncated and excludes
// GitHub). The room must be at most MAX_TRUSTED_GROUP_HUMANS humans. Each id is
// resolved through the same per-author path the turn anchor uses.
function isAllHumansTrustedGroupChannelOrigin(
  origin: SessionOrigin | undefined,
  permissions: PermissionService,
  now: number,
): boolean {
  if (origin?.kind !== 'channel') return false
  if (isDmChannelOrigin(origin)) return false
  if (!provesOnlyAgentBotPresent(origin, now)) return false

  const membership = origin.membership
  const humanMemberIds = membership.humanMemberIds
  if (humanMemberIds === undefined) return false
  if (humanMemberIds.length !== membership.humans) return false
  if (humanMemberIds.length === 0) return false
  if (humanMemberIds.length > MAX_TRUSTED_GROUP_HUMANS) return false

  return humanMemberIds.every((authorId) => {
    const role = permissions.resolveRole({ ...origin, lastInboundAuthorId: authorId })
    return role === 'owner' || role === 'trusted'
  })
}

export function createGrantRoleTool(options: CreateGrantRoleToolOptions) {
  const { agentDir, getOrigin, permissions, reloadRoles } = options

  return defineTool({
    name: 'grant_role',
    label: 'Grant Role',
    description:
      'Assign an author to a role (match grant) or give a role a capability (permission grant), by editing typeclaw.json#roles. ' +
      'Use this to onboard a teammate ("respond to author U_X" → grant them member) or to open the agent to a wider audience ' +
      '("let anyone in this channel message you" → grant guest channel.respond). ' +
      'Only callable by an owner or trusted user from the TUI, a 1:1 DM, or a group channel with no peer bots whose ' +
      'human members are all trusted (or which has a single human member) — channels that admit untrusted humans or ' +
      'other bots cannot use it. ' +
      'Permission grants are restart-required: they land in typeclaw.json but take effect on the next `typeclaw restart`.',
    parameters: Type.Object({
      role: Type.Union(
        [Type.Literal('owner'), Type.Literal('trusted'), Type.Literal('member'), Type.Literal('guest')],
        {
          description: 'The role to grant TO.',
        },
      ),
      match: Type.Optional(
        Type.String({
          description:
            'A match rule assigning an author/scope to the role, e.g. "slack:T0123 author:U_WIFE". ' +
            'Provide exactly one of match or permission.',
        }),
      ),
      permission: Type.Optional(
        Type.String({
          description:
            'A capability to add to the role, e.g. "channel.respond". Provide exactly one of match or permission. ' +
            'security.bypass.* permissions cannot be granted through this tool.',
        }),
      ),
    }),

    async execute(_toolCallId, params): Promise<ToolReturn> {
      const origin = getOrigin()

      const now = Date.now()
      if (
        !isSinglePrincipalOrigin(origin) &&
        !isSingleHumanGroupChannelOrigin(origin, now) &&
        !isAllHumansTrustedGroupChannelOrigin(origin, permissions, now)
      ) {
        return err(
          'grant_role is only available from the TUI, a 1:1 DM, or a group channel that has no peer bots and whose ' +
            'human members are all trusted (or which currently has a single human member). A channel that admits any ' +
            'untrusted human or another bot cannot change roles, because it mixes in other participants\u2019 messages ' +
            '(prompt-injection surface).',
        )
      }

      const callerRole = permissions.resolveRole(origin)
      if (callerRole !== 'owner' && callerRole !== 'trusted') {
        return err(`grant_role denied: caller resolves to '${callerRole}'; only owner or trusted may grant roles.`)
      }

      const hasMatch = typeof params.match === 'string' && params.match.length > 0
      const hasPermission = typeof params.permission === 'string' && params.permission.length > 0
      if (hasMatch === hasPermission) {
        return err('Provide exactly one of `match` or `permission`.')
      }

      if (!isTierRole(params.role)) {
        return err(`Unknown target role '${params.role}'.`)
      }

      // Tier ceiling: a granter may not assign or empower a role ABOVE its own.
      // owner(3) ≥ trusted(2) ≥ member(1) ≥ guest(0).
      if (tierOf(params.role) > tierOf(callerRole)) {
        return err(`grant_role denied: a ${callerRole} caller cannot grant the higher '${params.role}' role.`)
      }

      return hasMatch
        ? grantMatch(params.role, params.match as string)
        : grantPermission(callerRole, params.role, params.permission as string)
    },
  })

  function grantMatch(role: string, matchRule: string): ToolReturn {
    const parsed = parseMatchRule(matchRule)
    if (!parsed.ok) {
      return err(`Invalid match rule '${matchRule}': ${parsed.error}`)
    }

    const result = grantRole({ cwd: agentDir, roleName: role, matchRule })
    if (!result.ok) return err(result.reason)

    reload()
    return ok('match', role, matchRule, result.added, false)
  }

  function grantPermission(callerRole: string, role: string, permission: string): ToolReturn {
    // security.bypass.* defeats guards rather than enabling a feature; never
    // grantable through an agent tool. It stays a deliberate hand-edit gated by
    // the rolePromotion guard + an explicit ack.
    if (permission.startsWith('security.bypass.')) {
      return err(
        `grant_role refuses to grant '${permission}': security.bypass.* permissions disable security guards and ` +
          'must be set by hand-editing typeclaw.json (gated by the rolePromotion guard), not via this tool.',
      )
    }

    // "Grant only what you hold": the caller cannot confer a capability it does
    // not itself possess. Owner's resolved set is the expanded wildcard, so an
    // owner can grant any non-bypass core permission; trusted is capped at its
    // literal set.
    const callerPerms = permissions.describe(getOrigin()).permissions
    if (!callerPerms.includes(permission)) {
      return err(
        `grant_role denied: a ${callerRole} caller cannot grant '${permission}' because it does not hold that permission.`,
      )
    }

    const result = grantRolePermission({ cwd: agentDir, roleName: role, permission })
    if (!result.ok) return err(result.reason)

    reload()
    return ok('permission', role, permission, result.added, true)
  }

  function reload(): void {
    try {
      permissions.replaceRoles(reloadRoles())
    } catch {
      // Best-effort hot-reload of match-grants. A failure here does not undo
      // the on-disk write; the next config reload / restart picks it up.
    }
  }
}

function ok(
  mode: 'match' | 'permission',
  role: string,
  value: string,
  added: boolean,
  restartRequired: boolean,
): ToolReturn {
  const details: GrantRoleToolDetails = { ok: true, mode, role, value, added, restartRequired }
  const note = added ? '' : ' (already on file)'
  const restart = restartRequired
    ? ' This permission grant is restart-required; run `typeclaw restart` for it to take effect.'
    : ''
  const text =
    mode === 'match'
      ? `Granted role '${role}' the match rule '${value}'${note}.${restart}`
      : `Granted role '${role}' the permission '${value}'${note}.${restart}`
  return { content: [{ type: 'text', text }], details }
}

function err(message: string): ToolReturn {
  const details: GrantRoleToolDetails = { ok: false, error: message }
  return { content: [{ type: 'text', text: message }], details }
}

type ToolReturn = {
  content: { type: 'text'; text: string }[]
  details: GrantRoleToolDetails
}
