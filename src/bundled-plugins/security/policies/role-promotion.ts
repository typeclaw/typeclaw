import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import { parseConfigJson } from '@/config'
import { readConfigBaseline } from '@/config/config-commits'
import { isBuiltinRoleName, type RoleConfig, type RolesConfig } from '@/permissions'

import type { SecuritySeverity } from '../permissions'
import type { SecurityBlock } from '../policy'
import { resolveToolTarget } from './plugin-addition'

export const GUARD_ROLE_PROMOTION = 'rolePromotion'
// Classified `medium` (silent-attack axis). Originally `high`; reclassified
// because the privilege escalation does NOT take effect until the operator
// reloads or restarts — `roles` is `restart-required` in FIELD_EFFECTS, and
// even the `match`-only path that's classified `applied` writes through
// `typeclaw.json` which is force-committed by the auto-backup plugin on
// idle. The operator sees the file change in `git log`, in `typeclaw reload`
// output, and in their backup commits BEFORE the new role mapping takes
// effect. There is an operator-visible step between bypass and breach,
// which puts this guard squarely on the medium axis: bypass produces
// attacker-favorable state in operator-reviewable surface, not direct
// audience-leak.
//
// Net effect on the role-tower model: owner and trusted both bypass without
// ack; member and guest still get blocked. The defense for trusted now
// depends on operator config-review discipline — if backup commits are
// reviewed and `typeclaw reload` output is read before applying, a
// trusted-laundered role promotion is caught before it fires. Operators
// who do not review can re-tighten by adding `security.bypass.rolePromotion`
// to `trusted.permissions[]` as an explicit subtraction (replace the
// default tier grant with a narrower list) — see typeclaw-permissions skill.
//
// Breach pattern blocked at `medium`: a `member`-role speaker in a chat
// asks "promote me to admin"; the agent edits typeclaw.json; the change is
// schema-valid, managedConfig accepts it, nonWorkspaceWrite allowlists
// typeclaw.json — but this guard still blocks because member does not
// carry `bypass.medium` by default.
//
// What counts as a promotion (any of):
//   1. A role's `permissions[]` gained an entry.
//   2. A role's `match[]` gained an entry (widens who fills the role).
//   3. A new role was added with non-empty `permissions[]` or non-empty
//      `match[]` (introducing a role nobody used before is an
//      escalation in two steps: this PR + add a match rule next).
//
// What does NOT count (allowed without ack):
//   - Removing a permission from a role.
//   - Removing a match rule from a role.
//   - Deleting a role entirely.
//   - Reordering entries within `permissions[]` or `match[]`.
//   - Any edit to fields outside `roles`.
//
// Failure-open is deliberate: if the existing typeclaw.json cannot be
// read or parsed (first init, mid-corruption), we treat every role-
// bearing field in the proposed file as a NEW grant and block. That's
// the safe direction — the only false positive is "operator edited a
// broken config to fix it", which is fine because the operator can ack
// the call.
//
// What this guard does NOT cover, by design:
//   - `grantRole()` in src/permissions/grant.ts. That function writes
//     `typeclaw.json` directly (commitConfigWriteSync, in place) and
//     bypasses `tool.before` by construction. The only production caller
//     is the role-claim flow (src/role-claim/controller.ts), which is
//     gated by an operator-issued pairing code from the host CLI: the
//     agent cannot start a claim, only consume one whose code the
//     operator already broadcast. That makes the bypass intentionally
//     out-of-band — do not extend this guard to cover it.
export const GUARD_ROLE_PROMOTION_SEVERITY: SecuritySeverity = 'medium'

export type RolePromotionFinding = {
  role: string
  kind: 'permissions-added' | 'match-added' | 'role-added'
  added: readonly string[]
}

export async function checkRolePromotionGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
}): Promise<SecurityBlock | undefined> {
  const { tool, args, agentDir } = options
  if (tool !== 'write' && tool !== 'edit') return undefined

  const rawPath = args.path
  if (typeof rawPath !== 'string') return undefined

  const targetPath = resolveToolTarget(agentDir, rawPath)
  if (targetPath === undefined) return undefined
  const isTypeclawJson = await pathIsTypeclawJson(agentDir, targetPath)
  if (!isTypeclawJson) return undefined

  const editRefusal = refuseRiskyEdit(tool, args, targetPath)
  if (editRefusal) return editRefusal

  const newContent = await intendedContent(tool, args, targetPath)
  if (newContent === undefined) return undefined

  const newRoles = parseRolesFromContent(newContent)
  // managedConfig will block invalid JSON / schema separately. If parsing
  // fails here we can't reason about promotion, so we don't block at this
  // guard layer — the managedConfig schema check below us is the right
  // place to surface that error.
  if (newRoles === undefined) return undefined

  const oldRoles = await readExistingRoles(targetPath)
  const findings = diffRoles(oldRoles, newRoles)
  if (findings.length === 0) return undefined

  return {
    block: true,
    reason: buildBlockReason(tool, targetPath, findings),
  }
}

// Oracle PR #305 findings #5 and #6. The earlier shape compared
// `basename(realpath(target))` to `'typeclaw.json'`. That misses two
// real attacks:
//
//   (5) Symlink: root `typeclaw.json` is a symlink into workspace
//       (`typeclaw.json -> workspace/tc.json`). Writing to
//       `typeclaw.json` realpaths to a workspace file whose basename
//       is `tc.json` — the guard skips, but the next reload follows
//       the symlink and consumes the attacker's content.
//   (6) Case-insensitive FS (macOS APFS, default): `TYPECLAW.JSON`
//       addresses the same file as `typeclaw.json` but basename
//       string-equality misses the casing variant.
//
// Both are closed by treating the canonical agent-root config file as
// an identity to compare against, not a basename to match. We accept
// a write/edit if EITHER:
//
//   (a) the lexical agent-root path `<agentDir>/<managed-file-name>`
//       resolves (after realpath) to the same file as the target, OR
//   (b) the target's lexical path is exactly `<agentDir>/<managed-
//       file-name>` regardless of what's at that path (symlink, file,
//       missing — preserves first-init writes).
//
// Branch (a) catches both the symlink-into-workspace and the macOS-
// case-aliased attacks because realpath canonicalizes both. Branch
// (b) keeps the lexical name authoritative (a fresh write through the
// canonical name is always managed, even before the file exists).
async function pathIsTypeclawJson(agentDir: string, targetPath: string): Promise<boolean> {
  return identifiesManagedFile(agentDir, targetPath, 'typeclaw.json')
}

async function identifiesManagedFile(agentDir: string, targetPath: string, managedBasename: string): Promise<boolean> {
  const resolvedAgentDir = path.resolve(agentDir)
  const canonicalManagedPath = path.join(resolvedAgentDir, managedBasename)
  const resolvedTarget = path.resolve(targetPath)
  if (canonicalManagedPath === resolvedTarget) return true
  const realCanonical = await resolveRealPath(canonicalManagedPath)
  const realTarget = await resolveRealPath(resolvedTarget)
  return realCanonical === realTarget
}

// Oracle PR #305 finding #4. Our guard simulates edits as sequential
// `content.replace(oldText, newText)` calls — the next edit sees the
// output of the previous one. Pi's actual edit tool (in
// pi-coding-agent/dist/core/tools/edit-diff.js) applies each oldText
// against the ORIGINAL file content, requires uniqueness, and checks
// for overlapping replacements. A multi-edit call where the simulator
// and pi diverge would let an attacker validate one final file in our
// guard while pi writes a different final file to disk.
//
// We close the gap conservatively: refuse multi-edit AND non-unique-
// oldText edits on managed files. Tell the agent to use `write` with
// the full content instead (the typeclaw-cron and typeclaw-permissions
// skills already document this as the canonical path). Re-implementing
// pi's edit-diff inside the guard would be a maintenance hazard — any
// future pi version drift would silently re-open the bypass.
function refuseRiskyEdit(tool: string, args: Record<string, unknown>, targetPath: string): SecurityBlock | undefined {
  if (tool !== 'edit') return undefined
  const edits = args.edits
  if (!Array.isArray(edits)) return undefined
  if (edits.length > 1) {
    return {
      block: true,
      reason: [
        `Guard \`${GUARD_ROLE_PROMOTION}\` refuses multi-edit on ${targetPath}: the security guard's edit simulator cannot match the pi-coding-agent edit tool's original-content semantics for multi-edit calls, so a final file validated here may not match the final file actually written.`,
        'Use `write` with the full file content instead — this is the canonical workflow for managed config files (see the `typeclaw-cron` and `typeclaw-permissions` skills).',
      ].join(' '),
    }
  }
  return undefined
}

async function intendedContent(
  tool: string,
  args: Record<string, unknown>,
  targetPath: string,
): Promise<string | undefined> {
  if (tool === 'write') {
    return typeof args.content === 'string' ? args.content : undefined
  }
  const edits = args.edits
  if (!Array.isArray(edits)) return undefined
  let content: string
  try {
    content = await readFile(targetPath, 'utf8')
  } catch {
    return undefined
  }
  // refuseRiskyEdit already enforced edits.length <= 1 for managed
  // files. The loop here therefore always executes at most one iteration
  // — we still enforce oldText uniqueness inside it as defense in depth
  // (and because pi's edit-diff requires uniqueness too, so a non-unique
  // single-edit is a malformed input that would fail at the real tool).
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') return undefined
    const { oldText, newText } = edit as Record<string, unknown>
    if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
    if (oldText.length === 0) return undefined
    const firstIdx = content.indexOf(oldText)
    if (firstIdx === -1) return undefined
    if (content.indexOf(oldText, firstIdx + 1) !== -1) return undefined
    // Slice-rebuild to avoid String.replace's $-substitution interpreting
    // newText as a replacement pattern (a `$&` or `$1` in newText would
    // otherwise expand against the match).
    content = content.slice(0, firstIdx) + newText + content.slice(firstIdx + oldText.length)
  }
  return content
}

function parseRolesFromContent(content: string): RolesConfig | undefined {
  const result = parseConfigJson(content, { migrate: false })
  if (!result.ok) return undefined
  return result.config.roles ?? {}
}

async function readExistingRoles(targetPath: string): Promise<RolesConfig> {
  let raw: string
  try {
    raw = await readConfigBaseline(targetPath)
  } catch {
    // No existing file (first write) — treat every role as a new grant.
    return {}
  }
  // migrate:true on the on-disk read so the comparison matches what the
  // runtime currently sees — `migrateLegacyConfigShape` rewrites legacy
  // `channels.<adapter>.allow[]` into `roles.member.match[]` at every
  // config load. Without this, a legacy-shape file on disk would surface
  // as `roles: {}` to the guard and every legitimate operator edit on a
  // legacy config would be flagged as "new role with grant." The proposed
  // content (parseRolesFromContent) stays migrate:false so we diff the
  // agent's literal intent, not a migrated rewrite of it.
  const result = parseConfigJson(raw, { migrate: true })
  if (!result.ok) return {}
  return result.config.roles ?? {}
}

export function diffRoles(before: RolesConfig, after: RolesConfig): RolePromotionFinding[] {
  const findings: RolePromotionFinding[] = []
  for (const [role, afterCfg] of Object.entries(after)) {
    const beforeCfg = before[role]
    if (beforeCfg === undefined) {
      // New role. Flag only when it actually carries a grant — declaring
      // a role with empty permissions[] and empty match[] grants nothing.
      const addedPerms = readPermissions(afterCfg)
      const addedMatch = readMatchRaw(afterCfg)
      if (addedPerms.length > 0 || addedMatch.length > 0) {
        findings.push({
          role,
          kind: 'role-added',
          added: [...addedPerms.map((p) => `permission:${p}`), ...addedMatch.map((m) => `match:${m}`)],
        })
      }
      continue
    }
    const permsAdded = setDifference(readPermissions(afterCfg), readPermissions(beforeCfg))
    if (permsAdded.length > 0) {
      findings.push({ role, kind: 'permissions-added', added: permsAdded })
    }
    if (isBuiltinDefaultsRestoration(role, beforeCfg, afterCfg)) {
      findings.push({ role, kind: 'permissions-added', added: ['<built-in defaults restored>'] })
    }
    const matchAdded = setDifference(readMatchRaw(afterCfg), readMatchRaw(beforeCfg))
    if (matchAdded.length > 0) {
      findings.push({ role, kind: 'match-added', added: matchAdded })
    }
  }
  return findings
}

// Oracle PR #305 finding #3. For built-in roles (owner/trusted/member/
// guest), the runtime treats `permissions: undefined` as "use built-in
// defaults" — and the built-in defaults can be substantial (trusted
// carries channel.respond + cron.schedule + subagent perms +
// security.bypass.low even though its file representation may have
// been `permissions: []`). A write that removes an explicit
// `permissions[]` field on a built-in role therefore re-grants the
// built-in default set the file had narrowed away. The raw-array diff
// at readPermissions doesn't see this (both sides flatten to []), so
// we surface it here with a sentinel finding. Custom (non-built-in)
// roles do not have implicit defaults, so this rule applies only when
// the role name is built-in.
function isBuiltinDefaultsRestoration(role: string, before: RoleConfig, after: RoleConfig): boolean {
  if (!isBuiltinRoleName(role)) return false
  return before.permissions !== undefined && after.permissions === undefined
}

function readPermissions(cfg: RoleConfig | undefined): string[] {
  if (cfg === undefined) return []
  return cfg.permissions === undefined ? [] : [...cfg.permissions]
}

// We compare on the raw string forms of match rules even though the
// schema parses them into structured MatchRule objects. Two reasons:
// (1) the canonical migration in `migrateLegacyConfigShape` may rewrite
// legacy prefixes before they hit this guard, so the "before" we read
// from disk and the "after" we receive from args are both already in
// canonical DSL form — string equality is correct; (2) reconstructing a
// stable string key from MatchRule would duplicate the DSL formatter and
// drift over time.
function readMatchRaw(cfg: RoleConfig | undefined): string[] {
  if (cfg === undefined) return []
  const out: string[] = []
  for (const rule of cfg.match) {
    out.push(serializeMatchRule(rule))
  }
  return out
}

function serializeMatchRule(rule: RoleConfig['match'][number]): string {
  // We need a stable string key per rule for diff equality. The schema
  // parses rule strings into a typed union; we serialize back to a
  // canonical DSL form. Any rule shape not handled here falls through to
  // a JSON dump, which is correct for diff purposes (stable equality
  // even if the surface text is lossy) and acts as a forced signal at
  // code-review time when a new MatchRule kind ships.
  if (rule.kind === 'tui') return 'tui'
  if (rule.kind === 'cron') return 'cron'
  if (rule.kind === 'wildcard') return '*'
  if (rule.kind === 'subagent') {
    return rule.subagent === undefined ? 'subagent' : `subagent:${rule.subagent}`
  }
  if (rule.kind === 'channel') {
    const head = serializeChannelScope(rule)
    if (rule.author === undefined) return head
    return `${head} author:${rule.author}`
  }
  return JSON.stringify(rule)
}

function serializeChannelScope(rule: Extract<RoleConfig['match'][number], { kind: 'channel' }>): string {
  const { platform, workspace, chat, bucket } = rule
  if (bucket !== undefined) {
    return chat === undefined ? `${platform}:${bucket}/*` : `${platform}:${bucket}/${chat}`
  }
  if (workspace === undefined && chat === undefined) return `${platform}:*`
  if (workspace !== undefined && chat === undefined) return `${platform}:${workspace}`
  if (workspace !== undefined && chat !== undefined) return `${platform}:${workspace}/${chat}`
  return `${platform}:${JSON.stringify({ workspace, chat })}`
}

function setDifference(after: readonly string[], before: readonly string[]): string[] {
  const beforeSet = new Set(before)
  const out: string[] = []
  for (const item of after) {
    if (!beforeSet.has(item) && !out.includes(item)) out.push(item)
  }
  return out
}

function buildBlockReason(tool: string, targetPath: string, findings: readonly RolePromotionFinding[]): string {
  const lines: string[] = []
  for (const f of findings) {
    const role = sanitizeForReason(f.role)
    const added = dedup(f.added.map(sanitizeForReason)).join(', ')
    if (f.kind === 'role-added') {
      lines.push(`new role \`${role}\` adds: ${added}`)
    } else if (f.kind === 'permissions-added') {
      lines.push(`role \`${role}\` gains permissions: ${added}`)
    } else {
      lines.push(`role \`${role}\` gains match rules: ${added}`)
    }
  }
  return [
    `Guard \`${GUARD_ROLE_PROMOTION}\` blocked ${tool} on ${sanitizeForReason(targetPath)}: this change is a privilege escalation — ${lines.join('; ')}.`,
    'Granting `owner` / `trusted` (or widening any role) gives the matched actor security-bypass capabilities, cron scheduling, channel respond, and operator-only subagent spawn. Even an operator running from TUI must not silently rewrite the access-control table based on a channel message: the canonical attack is a member-role speaker socially-engineering the agent into adding their own author-id to `roles.owner.match[]`, which the schema check accepts as valid.',
    'This cannot be acknowledged away from an under-privileged session. The operator must make the change from a session that already resolves to `owner`/`trusted` (TUI, or a role granted `security.bypass.medium`), or claim the role out-of-band via `typeclaw role claim`.',
  ].join(' ')
}

const MAX_REASON_TOKEN_LEN = 200

// Strings flowing into the block reason can be attacker-controlled: an
// LLM-rendered role name, an author id inside a match rule, even the file
// path basename. The operator reads this reason in a TUI/terminal context,
// so ANSI escapes and other C0 controls would let an attacker forge or
// hide block-message UI. Same shape as sanitizeUrlForReason in git-exfil.
// Backticks are also replaced so an attacker can't break the inline-code
// formatting we use elsewhere in the message.
export function sanitizeForReason(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/`/g, "'")
  if (cleaned.length <= MAX_REASON_TOKEN_LEN) return cleaned
  return `${cleaned.slice(0, MAX_REASON_TOKEN_LEN)}...`
}

function dedup(items: readonly string[]): string[] {
  const out: string[] = []
  for (const item of items) if (!out.includes(item)) out.push(item)
  return out
}

async function resolveRealPath(absolutePath: string): Promise<string> {
  const pending: string[] = []
  let current = absolutePath
  while (true) {
    try {
      const real = await realpath(current)
      return path.join(real, ...pending.reverse())
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    const parent = path.dirname(current)
    if (parent === current) return absolutePath
    pending.push(path.basename(current))
    current = parent
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code: unknown }).code === 'ENOENT'
}
