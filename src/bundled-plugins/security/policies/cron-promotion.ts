import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import { parseCronJson, type ParsedCronJob } from '@/cron'

import type { SecuritySeverity } from '../permissions'
import type { SecurityBlock } from '../policy'
import { resolveToolTarget } from './plugin-addition'

// True iff the caller may legitimately schedule deferred work that fires as
// `targetRole` — i.e. `targetRole` grants no permission the caller's own role
// lacks (capability dominance / permission-subset). The caller supplies this;
// the production wiring in index.ts compares resolved permission sets, NOT the
// coarse severity tower (which ranks every custom role equal and would let one
// custom role launder into another). Fails closed: an unknown caller or target
// role returns false, so the change is treated as an escalation and blocked.
export type CanScheduleAs = (targetRole: string | undefined) => boolean

export const GUARD_CRON_PROMOTION = 'cronPromotion'
// Classified `medium` (silent-attack axis). Originally `high`; reclassified
// for the same reason as `rolePromotion`: the deferred-execution surface
// is still operator-reviewable before the job fires. `cron.json` is
// force-committed by the auto-backup plugin, the change appears in
// `git log` and backup commits, and the cron consumer dispatches by
// schedule — there is wall-clock time between the privileged write and
// the privileged execution during which the operator can revert or
// disable. Bypass produces operator-reviewable state, not direct
// audience-leak.
//
// Net effect on the role-tower model: owner and trusted both bypass
// (they carry `security.bypass.medium`); member and guest are gated by
// the caller-role-aware predicate below. This guard does NOT honor
// `acknowledgeGuards` — an ack flag from an under-privileged session is
// ignored. Bypassing is a property of the caller's resolved role, not a
// tool-arg flag, because an args-level ack would let any member/guest
// launder itself past the guard (it inspected args, not permissions).
//
// Cron is the deferred-execution sibling of `roles`. Every cron job
// carries a `scheduledByRole` field that the runtime stamps into the
// firing session's origin; the permission service then trusts that
// stamp (subject to "named role must exist in the resolved role
// table"). The `parseCronFile` boot gate rejects entries without
// `scheduledByRole`, but it accepts any role name the file declares.
//
// Concrete breach pattern blocked: a `member`-role agent that can
// `write` `cron.json` authors a brand-new job with
// `"scheduledByRole": "owner"` and a prompt that does whatever the
// agent's tool surface allows when running as owner. The cron consumer
// fires it on schedule; the firing session resolves to `owner`. The
// agent has laundered itself into owner via the schedule. This guard
// blocks it because `canScheduleAs('owner')` is false for a member.
//
// Same two-step shape as `gitRemoteTainted`: "do a privileged write
// now, run the privileged thing later." This guard blocks the first
// step. It is the deferred-write analogue of the `spawnedByRole` cap in
// src/agent/tools/subagent-access.ts: a caller may only commit deferred
// work that fires at a role it could already act as.
//
// What counts as a cron promotion (a finding is raised only when the
// change introduces deferred authority the caller lacks — i.e. the
// relevant `scheduledByRole` is NOT schedulable by the caller, where
// `canScheduleAs(R)` means R's permission set is a SUBSET of the
// caller's (capability dominance), fail-closed on unknown roles):
//   1. A new job (by id) was added whose `scheduledByRole` the caller
//      cannot schedule as. Adding a job at-or-below the caller's own
//      role grants nothing new and is allowed.
//   2. An existing job's `scheduledByRole` was raised to a value the
//      caller cannot schedule as. Lowering it, or a lateral move within
//      the caller's reach, is allowed.
//   3. An existing job's EXECUTABLE BODY changed — `kind`, `prompt`,
//      `command`, `subagent`, or `payload` — AND the job fires above
//      the caller either before or after the change. Rewriting the body
//      of an already-privileged job is the same deferred-laundering
//      attack as job creation (Oracle PR #305 critical finding): the
//      cron consumer fires the new body as the stamped role. Requiring
//      BOTH old and new roles to be within the caller's reach preserves
//      that defense — a member cannot rewrite an owner-stamped body even
//      though `scheduledByRole` is untouched. The fields chosen are
//      exactly those the cron consumer uses to decide what executes;
//      provenance/identity fields (id, scheduledByRole,
//      scheduledByOrigin) are handled separately or are audit metadata.
//   4. An existing job had `enabled: false` flipped to true while it
//      fires above the caller (same both-sides reach check as body
//      changes). Re-enabling a job at-or-below the caller is allowed.
//
// What does NOT count (allowed):
//   - Any change (add / role-change / body / re-enable) whose resulting
//     job fires at or below the caller's own role: it grants the caller
//     no authority it doesn't already have.
//   - Removing a job entirely.
//   - Changing `schedule` or `timezone` on an existing job (cadence
//     decisions; do not change what runs, only when).
//   - Setting `enabled: true -> false` (disabling is a REDUCTION).
//   - A job with no `scheduledByRole` (`undefined`) is treated as NOT
//     schedulable (fail-closed), so the schema-rejected unset case stays
//     blocked rather than slipping through as a non-finding.
//
// Failure-closed on caller role: an unknown/incomparable caller role
// makes `canScheduleAs` return false, so every change is treated as an
// escalation and blocked. Failure-open on file read is unchanged: if the
// existing `cron.json` cannot be read or parsed, every proposed job is
// treated as new and then subjected to the same caller-role check.
export const GUARD_CRON_PROMOTION_SEVERITY: SecuritySeverity = 'medium'

export type CronPromotionFinding =
  | { kind: 'job-added'; id: string; scheduledByRole: string }
  | { kind: 'role-changed'; id: string; from: string; to: string }
  | { kind: 'body-changed'; id: string; scheduledByRole: string; fields: readonly string[] }
  | { kind: 'enabled-flipped'; id: string; scheduledByRole: string }

export async function checkCronPromotionGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
  canScheduleAs: CanScheduleAs
}): Promise<SecurityBlock | undefined> {
  const { tool, args, agentDir, canScheduleAs } = options
  if (tool !== 'write' && tool !== 'edit') return undefined

  const rawPath = args.path
  if (typeof rawPath !== 'string') return undefined

  const targetPath = resolveToolTarget(agentDir, rawPath)
  if (targetPath === undefined) return undefined
  const isCronJson = await pathIsCronJson(agentDir, targetPath)
  if (!isCronJson) return undefined

  const editRefusal = refuseRiskyEdit(tool, args, targetPath)
  if (editRefusal) return editRefusal

  const newContent = await intendedContent(tool, args, targetPath)
  if (newContent === undefined) return undefined

  const newJobs = parseJobsFromContent(newContent)
  if (newJobs === undefined) return undefined

  const oldJobs = await readExistingJobs(targetPath)
  const findings = diffJobs(oldJobs, newJobs, canScheduleAs)
  if (findings.length === 0) return undefined

  return {
    block: true,
    reason: buildBlockReason(tool, targetPath, findings),
  }
}

// See the parallel `identifiesManagedFile` rationale block in
// role-promotion.ts — Oracle PR #305 findings #5 and #6 (symlinked
// managed file + case-insensitive FS).
async function pathIsCronJson(agentDir: string, targetPath: string): Promise<boolean> {
  const resolvedAgentDir = path.resolve(agentDir)
  const canonicalManagedPath = path.join(resolvedAgentDir, 'cron.json')
  const resolvedTarget = path.resolve(targetPath)
  if (canonicalManagedPath === resolvedTarget) return true
  const realCanonical = await resolveRealPath(canonicalManagedPath)
  const realTarget = await resolveRealPath(resolvedTarget)
  return realCanonical === realTarget
}

// Symmetric with role-promotion's refuseRiskyEdit. See Oracle PR #305
// finding #4: simulator-vs-real divergence on multi-edit, plus
// non-unique-oldText ambiguity. Conservative refusal keeps the guard
// honest without re-implementing pi-coding-agent/edit-diff.js inside
// the security plugin.
function refuseRiskyEdit(tool: string, args: Record<string, unknown>, targetPath: string): SecurityBlock | undefined {
  if (tool !== 'edit') return undefined
  const edits = args.edits
  if (!Array.isArray(edits)) return undefined
  if (edits.length > 1) {
    return {
      block: true,
      reason: [
        `Guard \`${GUARD_CRON_PROMOTION}\` refuses multi-edit on ${targetPath}: the security guard's edit simulator cannot match the pi-coding-agent edit tool's original-content semantics for multi-edit calls.`,
        'Use `write` with the full file content instead — this is the canonical workflow for managed config files (see the `typeclaw-cron` skill).',
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
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') return undefined
    const { oldText, newText } = edit as Record<string, unknown>
    if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
    if (oldText.length === 0) return undefined
    const firstIdx = content.indexOf(oldText)
    if (firstIdx === -1) return undefined
    if (content.indexOf(oldText, firstIdx + 1) !== -1) return undefined
    content = content.slice(0, firstIdx) + newText + content.slice(firstIdx + oldText.length)
  }
  return content
}

function parseJobsFromContent(content: string): readonly ParsedCronJob[] | undefined {
  const result = parseCronJson(content)
  if (!result.ok) return undefined
  return result.file.jobs
}

async function readExistingJobs(targetPath: string): Promise<readonly ParsedCronJob[]> {
  let raw: string
  try {
    raw = await readFile(targetPath, 'utf8')
  } catch {
    return []
  }
  const result = parseCronJson(raw)
  if (!result.ok) return []
  return result.file.jobs
}

// A finding is a *promotion* only when the change introduces deferred authority
// the caller could not already wield. `canScheduleAs(R)` is true when R's
// permission set is a subset of the caller's, so a change that lands (and, for
// mutations, started) at a role granting nothing the caller lacks is not
// flagged. The laundering shapes still trip every branch: a member
// adding/role-changing a job to `owner` fails `canScheduleAs('owner')`,
// rewriting/re-enabling an already-`owner`-stamped body fails the prior-role
// check, and a custom role scheduling as a different custom role that carries
// an extra permission fails the subset check — none are schedulable, so all
// stay blocked.
export function diffJobs(
  before: readonly ParsedCronJob[],
  after: readonly ParsedCronJob[],
  canScheduleAs: CanScheduleAs,
): CronPromotionFinding[] {
  const findings: CronPromotionFinding[] = []
  const beforeById = new Map<string, ParsedCronJob>()
  for (const job of before) beforeById.set(job.id, job)

  for (const job of after) {
    const prior = beforeById.get(job.id)
    const newRole = job.scheduledByRole
    if (prior === undefined) {
      if (!canScheduleAs(newRole)) {
        findings.push({
          kind: 'job-added',
          id: job.id,
          scheduledByRole: newRole ?? '<unset>',
        })
      }
      continue
    }
    const oldRole = prior.scheduledByRole
    if (oldRole !== newRole && !canScheduleAs(newRole)) {
      findings.push({
        kind: 'role-changed',
        id: job.id,
        from: oldRole ?? '<unset>',
        to: newRole ?? '<unset>',
      })
    }
    const withinReach = canScheduleAs(oldRole) && canScheduleAs(newRole)
    const bodyDelta = diffJobBody(prior, job)
    if (bodyDelta.length > 0 && !withinReach) {
      findings.push({
        kind: 'body-changed',
        id: job.id,
        scheduledByRole: newRole ?? '<unset>',
        fields: bodyDelta,
      })
    }
    if (isPreviouslyDisabled(prior) && !isPreviouslyDisabled(job) && !withinReach) {
      findings.push({
        kind: 'enabled-flipped',
        id: job.id,
        scheduledByRole: newRole ?? '<unset>',
      })
    }
  }
  return findings
}

// `enabled` defaults to true at the schema layer (parseCronJson fills
// it in). After parse, the field is always boolean-typed. "Previously
// disabled" means literally `false`; everything else is live.
function isPreviouslyDisabled(job: ParsedCronJob): boolean {
  return job.enabled === false
}

// Executable-body field set. Anything the cron consumer uses to
// decide what executes when a job fires belongs here. Metadata and
// cadence fields (schedule, timezone, id, enabled) are out of scope:
// id/enabled are handled separately (job-added, enabled-flipped),
// schedule/timezone do not change what runs (only when), and
// provenance (scheduledByRole, scheduledByOrigin) is handled by
// role-changed or treated as audit metadata.
function diffJobBody(before: ParsedCronJob, after: ParsedCronJob): string[] {
  const changed: string[] = []
  if (before.kind !== after.kind) {
    changed.push('kind')
    return changed
  }
  if (before.kind === 'prompt' && after.kind === 'prompt') {
    if (before.prompt !== after.prompt) changed.push('prompt')
    if (before.subagent !== after.subagent) changed.push('subagent')
    if (!stableEqual(before.payload, after.payload)) changed.push('payload')
  } else if (before.kind === 'exec' && after.kind === 'exec') {
    if (!arrayEqual(before.command, after.command)) changed.push('command')
  }
  return changed
}

function arrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// JSON-stable equality for the opaque `payload` field. We use canonical
// JSON serialization (sorted keys via the comparator below) so a write
// that only reorders payload object keys does not flag.
function stableEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
      return sorted
    }
    return v
  })
}

function buildBlockReason(tool: string, targetPath: string, findings: readonly CronPromotionFinding[]): string {
  const lines: string[] = []
  for (const f of findings) {
    const id = sanitizeForReason(f.id)
    if (f.kind === 'job-added') {
      lines.push(`new job \`${id}\` would run as role \`${sanitizeForReason(f.scheduledByRole)}\``)
    } else if (f.kind === 'body-changed') {
      const fieldList = f.fields.map(sanitizeForReason).join(', ')
      lines.push(
        `job \`${id}\` (running as \`${sanitizeForReason(f.scheduledByRole)}\`) executable body changed: ${fieldList}`,
      )
    } else if (f.kind === 'enabled-flipped') {
      lines.push(`job \`${id}\` re-enabled (would now fire as role \`${sanitizeForReason(f.scheduledByRole)}\`)`)
    } else {
      lines.push(
        `job \`${id}\` changes scheduledByRole \`${sanitizeForReason(f.from)}\` -> \`${sanitizeForReason(f.to)}\``,
      )
    }
  }
  return [
    `Guard \`${GUARD_CRON_PROMOTION}\` blocked ${tool} on ${sanitizeForReason(targetPath)}: this change schedules deferred work above your role — ${lines.join('; ')}.`,
    'Cron jobs carry `scheduledByRole`, which the runtime stamps into the firing session\'s origin. Adding a job, raising its scheduledByRole, or rewriting/re-enabling a job that already fires above your role is the deferred form of the `rolePromotion` attack: "schedule a privileged prompt now, the cron consumer runs it as that role later." A change that fires at or below your own role grants nothing new and is allowed; this block means the resulting (or prior) role outranks yours.',
    'This cannot be acknowledged away from an under-privileged session. The operator must make the change from a session that already resolves to a role at least as high as the cron job — TUI (owner), or a role granted `security.bypass.medium` — or claim the role out-of-band via `typeclaw role claim`.',
  ].join(' ')
}

const MAX_REASON_TOKEN_LEN = 200

function sanitizeForReason(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/`/g, "'")
  if (cleaned.length <= MAX_REASON_TOKEN_LEN) return cleaned
  return `${cleaned.slice(0, MAX_REASON_TOKEN_LEN)}...`
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
