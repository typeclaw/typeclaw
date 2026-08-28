import { CronExpressionParser } from 'cron-parser'
import { z } from 'zod'

import type { SubagentRegistry } from '@/agent/subagents'
import { validateSubagentPayload } from '@/agent/subagents'
import type { CronHandlerContext } from '@/plugin/types'

const idPattern = /^[a-zA-Z0-9_-]+$/
export const MAX_CRON_RUN_TIMEOUT_MS = 2_147_483_647
export const cronRunTimeoutMsSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_CRON_RUN_TIMEOUT_MS, `timeoutMs must be at most ${MAX_CRON_RUN_TIMEOUT_MS}`)

const baseJob = z.object({
  id: z.string().min(1).regex(idPattern, 'id must contain only letters, digits, hyphens, or underscores'),
  // `schedule` (recurring cron expression) and `at` (one-shot ISO instant) are
  // mutually exclusive: exactly one must be present. Zod marks both optional so
  // the discriminated union still parses; the XOR is enforced in parseCronFile
  // where we can emit a job-id-scoped error message.
  schedule: z.string().min(1).optional(),
  at: z.string().min(1).optional(),
  // End boundaries. `until` is an absolute ISO instant (last allowed fire,
  // inclusive); `count` stops after N accepted fires. Both may coexist on one
  // job — the scheduler stops at whichever limit is reached first. `count`
  // progress is tracked out-of-band in cron-state.json, never written back here.
  until: z.string().min(1).optional(),
  count: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
  timezone: z.string().optional(),
  timeoutMs: cronRunTimeoutMsSchema.optional(),
  scheduledByRole: z.string().optional(),
  // Audit snapshot of the SessionOrigin that scheduled this job. Persisted
  // as opaque z.unknown() because SessionOrigin is recursive (a cron origin
  // can contain a subagent origin can contain another cron origin, etc.)
  // and we do not want to mirror that union in the cron schema. The cron
  // consumer reads this back as-is and stamps it into the firing session's
  // origin without further validation -- if it's malformed, role
  // resolution falls back to `guest` via the same path that handles
  // missing fields.
  scheduledByOrigin: z.unknown().optional(),
})

const promptJob = baseJob.extend({
  kind: z.literal('prompt'),
  prompt: z.string().min(1),
  subagent: z.string().min(1).optional(),
  payload: z.unknown().optional(),
})

const execJob = baseJob.extend({
  kind: z.literal('exec'),
  command: z.array(z.string().min(1)).min(1),
})

export const cronJobSchema = z.discriminatedUnion('kind', [promptJob, execJob])

export const cronFileSchema = z.object({
  $schema: z.string().optional(),
  jobs: z.array(cronJobSchema).default([]),
})

export type ParsedCronJob = z.infer<typeof cronJobSchema>
export type PromptJob = Extract<ParsedCronJob, { kind: 'prompt' }>
export type ExecJob = Extract<ParsedCronJob, { kind: 'exec' }>

export type HandlerJob = z.infer<typeof baseJob> & {
  kind: 'handler'
  handler: (ctx: CronHandlerContext) => Promise<void>
}

export type CronJob = ParsedCronJob | HandlerJob
export type CronFile = z.infer<typeof cronFileSchema>

export type CronParseWarning = { jobId?: string; index: number; reason: string }

export type ParseCronResult =
  | { ok: true; file: CronFile; warnings?: CronParseWarning[] }
  | { ok: false; reason: string }

// `edit` is the strict authoring path for an agent writing/editing cron.json: a
// past enabled `at`/`until` is rejected so a job scheduled in the past surfaces
// as an error instead of silently becoming a never-firing no-op, and any single
// bad job fails the whole file so the author sees it.
//
// `load` is the strict programmatic/security path (cron-promotion inspection,
// reload validation): it tolerates fired past `at`/`until` tombstones but still
// fails the whole file on any structurally bad job, so a security policy never
// reasons over a silently-filtered subset.
//
// `boot` is the runtime-survivability path used only by the scheduler on
// container boot/reload: it isolates bad individual jobs (skips them, emits a
// warning) and keeps the valid ones, so one malformed job can never brick every
// cron — including the plugin-registered dreaming job that isn't even in the
// file. It shares `load`'s tolerance for expired `at`/`until`.
export type ParseCronMode = 'edit' | 'load' | 'boot'

export type ParseCronOptions = {
  // When provided, prompt jobs with a `subagent` field are validated against
  // the registry: the name must exist, and the optional `payload` must match
  // the registered subagent's payloadSchema (or be absent if no schema).
  subagents?: SubagentRegistry
  // Injected by tests so past/future boundary checks on `at`/`until` are
  // deterministic. Production omits it and validation reads the wall clock.
  now?: number
  // Defaults to `load` (reload-safe). Callers validating an agent edit pass
  // `edit` to reject newly-scheduled past `at` reminders.
  mode?: ParseCronMode
}

export type ParseCronJsonOptions = ParseCronOptions

export function parseCronJson(raw: string, options: ParseCronJsonOptions = {}): ParseCronResult {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    return { ok: false, reason: `cron.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }

  return parseCronFile(json, {
    ...(options.subagents !== undefined ? { subagents: options.subagents } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
  })
}

// Authoring-delta validation for a cron.json edit. Strict `edit` mode fails the
// whole file on any enabled job with a past `at`/`until`, which lets a single
// stale pre-existing job (an expired `until` from weeks ago) brick EVERY edit —
// including the edit that would remove it, or an edit to a completely unrelated
// job. That is the trap: expired history holds the file hostage.
//
// This validator parses the proposed content in tolerant `load` mode (so it
// still catches structural errors and duplicate ids), then applies the strict
// `edit` timing check ONLY to jobs whose timing is newly-authored — a job that
// is new, or whose timing fields changed versus the on-disk baseline. A job
// carried over unchanged keeps its stale boundary tolerated, so removing it or
// editing a sibling is never blocked. Adding a new past job, or re-timing an
// existing one into the past, is still rejected exactly as before.
//
// `existingRaw` is the current on-disk cron.json (undefined on first-init). If
// it is missing or unparseable the baseline is empty, so every proposed job is
// treated as new and strict-checked — the safe direction (fail closed).
export function validateCronEdit(
  proposedRaw: string,
  existingRaw: string | undefined,
  options: ParseCronOptions = {},
): ParseCronResult {
  const now = options.now ?? Date.now()
  const proposed = parseCronJson(proposedRaw, { ...options, mode: 'load' })
  if (!proposed.ok) return proposed

  const baselineTiming = existingRaw !== undefined ? timingSignaturesByJobId(existingRaw) : new Map<string, string>()

  for (const job of proposed.file.jobs) {
    const prior = baselineTiming.get(job.id)
    const timingUnchanged = prior !== undefined && prior === timingSignature(job)
    if (timingUnchanged) continue
    const timingError = validateTiming(job, now, 'edit')
    if (timingError !== null) return { ok: false, reason: `job ${job.id}: ${timingError}` }
  }

  return proposed
}

// The timing fields whose change re-arms the strict past-boundary check. A job
// is exempt from the stale-boundary rejection only when ALL of these match the
// baseline; touching any of them (including flipping `enabled` back on) counts
// as re-authoring the schedule and is strict-checked afresh.
function timingSignature(job: {
  schedule?: string | undefined
  at?: string | undefined
  until?: string | undefined
  count?: number | undefined
  timezone?: string | undefined
  enabled: boolean
}): string {
  return JSON.stringify([
    job.schedule ?? null,
    job.at ?? null,
    job.until ?? null,
    job.count ?? null,
    job.timezone ?? null,
    job.enabled,
  ])
}

function timingSignaturesByJobId(raw: string): Map<string, string> {
  const signatures = new Map<string, string>()
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return signatures
  }
  const parsed = cronFileSchema.safeParse(json)
  if (!parsed.success) return signatures
  for (const job of parsed.data.jobs) signatures.set(job.id, timingSignature(job))
  return signatures
}

export function parseCronFile(raw: unknown, options: ParseCronOptions = {}): ParseCronResult {
  const parsed = cronFileSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map(formatIssue).join('; ') }
  }

  const file = parsed.data
  const mode = options.mode ?? 'load'
  const now = options.now ?? Date.now()

  const validJobs: ParsedCronJob[] = []
  const warnings: CronParseWarning[] = []
  const seen = new Set<string>()

  for (const [index, job] of file.jobs.entries()) {
    const duplicate = seen.has(job.id)
    const reason = duplicate
      ? `duplicate job id: ${job.id}`
      : validateJob(job, { now, mode, subagents: options.subagents })

    if (reason !== null) {
      const scoped = duplicate ? reason : `job ${job.id}: ${reason}`
      if (mode !== 'boot') return { ok: false, reason: scoped }
      warnings.push({ jobId: job.id, index, reason: scoped })
      continue
    }

    seen.add(job.id)
    validJobs.push(job)
  }

  if (mode !== 'boot') return { ok: true, file }
  return { ok: true, file: { ...file, jobs: validJobs }, ...(warnings.length > 0 ? { warnings } : {}) }
}

function validateJob(
  job: ParsedCronJob,
  { now, mode, subagents }: { now: number; mode: ParseCronMode; subagents?: SubagentRegistry },
): string | null {
  const timingError = validateTiming(job, now, mode)
  if (timingError !== null) return timingError

  if (job.scheduledByRole === undefined) {
    return `missing 'scheduledByRole'. Add "scheduledByRole": "owner" if you authored this entry manually.`
  }

  if (job.kind === 'prompt' && job.subagent !== undefined && subagents !== undefined) {
    const subagent = subagents[job.subagent]
    if (!subagent) return `unknown subagent "${job.subagent}"`
    try {
      validateSubagentPayload(job.subagent, subagent, job.payload)
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  return null
}

type TimingJob = {
  schedule?: string | undefined
  at?: string | undefined
  until?: string | undefined
  count?: number | undefined
  timezone?: string | undefined
  enabled: boolean
}

function validateTiming(job: TimingJob, now: number = Date.now(), mode: ParseCronMode = 'load'): string | null {
  const hasSchedule = job.schedule !== undefined
  const hasAt = job.at !== undefined
  if (hasSchedule === hasAt) {
    return `must set exactly one of "schedule" (recurring) or "at" (one-shot)`
  }

  if (hasAt) {
    if (job.timezone !== undefined) return `"timezone" is only valid with "schedule", not "at"`
    if (job.until !== undefined) return `"until" is only valid with "schedule", not "at"`
    if (job.count !== undefined && job.count !== 1) return `one-shot "at" jobs may only set "count": 1`
    const at = parseInstant(job.at!)
    if (at === null) return `invalid "at": "${job.at}" is not an ISO datetime with an explicit zone/offset`
    // Reject a past reminder only on `edit`; `load` tolerates fired tombstones.
    // See ParseCronMode for the full rationale.
    if (mode === 'edit' && job.enabled && at <= now) return `"at" is in the past: "${job.at}"`
    return null
  }

  let until: number | null = null
  if (job.until !== undefined) {
    until = parseInstant(job.until)
    if (until === null) return `invalid "until": "${job.until}" is not an ISO datetime with an explicit zone/offset`
    // Reject an expired boundary only on `edit`; `load`/`boot` tolerate an
    // already-past `until` (the recurring counterpart of a fired one-shot `at`)
    // so an expired job goes inert instead of bricking the whole file on reload.
    // See ParseCronMode for the full rationale.
    if (mode === 'edit' && job.enabled && until <= now) return `"until" is in the past: "${job.until}"`
  }

  let firstFire: number
  try {
    const expr = CronExpressionParser.parse(job.schedule!, {
      currentDate: new Date(now),
      ...(job.timezone ? { tz: job.timezone } : {}),
    })
    firstFire = expr.next().getTime()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (job.timezone && /invalid|unhandled timestamp|unrecognized/i.test(message)) {
      return `invalid timezone "${job.timezone}": ${message}`
    }
    return `invalid schedule "${job.schedule}": ${message}`
  }

  if (mode === 'edit' && job.enabled && until !== null && firstFire > until) {
    return `schedule has no occurrence at or before "until" ("${job.until}")`
  }

  return null
}

// Accepts only absolute instants: an explicit `Z` or numeric offset is
// required so "remind me at 9am" can never silently resolve to the host's
// local zone. A bare `2026-06-09T09:00:00` (no zone) is rejected.
function parseInstant(value: string): number | null {
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value)) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'
  return `${path}: ${issue.message}`
}
