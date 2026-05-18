import { CronExpressionParser } from 'cron-parser'
import { z } from 'zod'

import type { SubagentRegistry } from '@/agent/subagents'
import { validateSubagentPayload } from '@/agent/subagents'

const idPattern = /^[a-zA-Z0-9_-]+$/

const baseJob = z.object({
  id: z.string().min(1).regex(idPattern, 'id must contain only letters, digits, hyphens, or underscores'),
  schedule: z.string().min(1),
  enabled: z.boolean().default(true),
  timezone: z.string().optional(),
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

// Default cap shared by stdout and stderr when a prompt job pipes an exec
// command's output into the LLM. 64 KiB fits typical CLI output (e.g.
// `git log --oneline -100` is ~5 KiB) while staying well under any model's
// context window. Per-job override via `execMaxOutputBytes`.
export const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 65536

const promptJob = baseJob.extend({
  kind: z.literal('prompt'),
  prompt: z.string().min(1),
  subagent: z.string().min(1).optional(),
  payload: z.unknown().optional(),
  // Optional pre-LLM command. When present, the cron consumer spawns this
  // command (cwd = agent dir) BEFORE invoking the LLM, captures
  // stdout/stderr/exitCode, and feeds the result into the prompt (no
  // subagent: appended as a fenced block) or the payload (with subagent:
  // merged as `payload.exec = { stdin, stderr, exitCode }`). The LLM runs
  // regardless of exit code — the model sees the result and decides what
  // to do. For conditional firing, use shell composition in the command
  // itself (`bash -c "cmd1 && cmd2"`).
  exec: z.array(z.string().min(1)).min(1).optional(),
  // Cap applied independently to stdout and stderr. Larger outputs are
  // truncated with a `[truncated N bytes]` marker appended to the affected
  // stream. Defaults to DEFAULT_EXEC_MAX_OUTPUT_BYTES.
  execMaxOutputBytes: z.number().int().positive().optional(),
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

export type CronJob = z.infer<typeof cronJobSchema>
export type PromptJob = Extract<CronJob, { kind: 'prompt' }>
export type ExecJob = Extract<CronJob, { kind: 'exec' }>
export type CronFile = z.infer<typeof cronFileSchema>

export type ParseCronResult = { ok: true; file: CronFile } | { ok: false; reason: string }

export type ParseCronOptions = {
  // When provided, prompt jobs with a `subagent` field are validated against
  // the registry: the name must exist, and the optional `payload` must match
  // the registered subagent's payloadSchema (or be absent if no schema).
  subagents?: SubagentRegistry
}

// One-shot rewrite for cron.json files that predate PR #171, when
// `scheduledByRole` became mandatory on every job. The schema gate
// (`parseCronFile`) rejects legacy entries with a precise remediation
// message, but rejecting on every container boot is a stuck state for
// the user — the agent crashes in a tight restart loop with no path
// forward except hand-editing cron.json.
//
// The migration stamps `scheduledByRole: 'owner'` on every job that's
// missing it. `owner` is the right default for two reasons:
//   1. Before #171 there was no role concept; every cron job ran with
//      the same (effectively-owner) privileges the agent had.
//   2. The schema gate's own error message tells users to add
//      `"scheduledByRole": "owner"` for manually-authored entries —
//      we just do it for them.
//
// Mirrors `migrateLegacyConfigShape` in src/config/config.ts: pure
// function, returns the rewritten JSON plus an `applied` array so
// callers can build a meaningful commit message. Returns `changed:
// false` on canonical input so the persist + commit path stays
// untouched on the happy path.
export type CronMigrationStep = { kind: 'stamp-scheduled-by-role-owner'; jobIds: string[] }

export type CronMigrationResult = { json: unknown; changed: boolean; applied: CronMigrationStep[] }

export function migrateLegacyCronShape(json: unknown): CronMigrationResult {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { json, changed: false, applied: [] }
  }

  const obj = json as Record<string, unknown>
  const jobs = obj.jobs
  if (!Array.isArray(jobs)) {
    return { json, changed: false, applied: [] }
  }

  const stampedIds: string[] = []
  const nextJobs = jobs.map((job) => {
    if (typeof job !== 'object' || job === null || Array.isArray(job)) return job
    const record = job as Record<string, unknown>
    if ('scheduledByRole' in record) return job
    const id = typeof record.id === 'string' ? record.id : '<unknown>'
    stampedIds.push(id)
    return { ...record, scheduledByRole: 'owner' }
  })

  if (stampedIds.length === 0) {
    return { json, changed: false, applied: [] }
  }

  return {
    json: { ...obj, jobs: nextJobs },
    changed: true,
    applied: [{ kind: 'stamp-scheduled-by-role-owner', jobIds: stampedIds }],
  }
}

// Builds a one-line git commit subject (plus enumerating body) for a
// cron.json migration. Returns null when no steps were applied — callers
// should not commit in that case. Mirrors `buildConfigMigrationCommitMessage`
// in src/config/config.ts.
export function buildCronMigrationCommitMessage(applied: readonly CronMigrationStep[]): string | null {
  const first = applied[0]
  if (first === undefined) return null

  const subject =
    applied.length === 1
      ? `cron.json: ${shortCronStepLabel(first)}`
      : `cron.json: migrate legacy shape (${applied.length} steps)`

  const bodyLines: string[] = applied.map((step) => `- ${describeCronStep(step)}`)
  return `${subject}\n\n${bodyLines.join('\n')}\n`
}

function shortCronStepLabel(step: CronMigrationStep): string {
  switch (step.kind) {
    case 'stamp-scheduled-by-role-owner':
      return `stamp scheduledByRole: "owner" on ${step.jobIds.length} legacy job${step.jobIds.length === 1 ? '' : 's'}`
  }
}

function describeCronStep(step: CronMigrationStep): string {
  switch (step.kind) {
    case 'stamp-scheduled-by-role-owner':
      return `stamp scheduledByRole: "owner" on jobs without provenance (PR #171 backfill): ${step.jobIds.join(', ')}`
  }
}

export function parseCronFile(raw: unknown, options: ParseCronOptions = {}): ParseCronResult {
  const parsed = cronFileSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues.map(formatIssue).join('; ') }
  }

  const file = parsed.data
  const seen = new Set<string>()
  for (const job of file.jobs) {
    if (seen.has(job.id)) {
      return { ok: false, reason: `duplicate job id: ${job.id}` }
    }
    seen.add(job.id)

    try {
      const expr = CronExpressionParser.parse(job.schedule, job.timezone ? { tz: job.timezone } : undefined)
      // cron-parser validates the timezone lazily on first next() call, not at
      // parse time, so we must force evaluation here to catch bogus zones.
      expr.next()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (job.timezone && /invalid|unhandled timestamp|unrecognized/i.test(message)) {
        return { ok: false, reason: `job ${job.id}: invalid timezone "${job.timezone}": ${message}` }
      }
      return { ok: false, reason: `job ${job.id}: invalid schedule "${job.schedule}": ${message}` }
    }

    if (job.scheduledByRole === undefined) {
      return {
        ok: false,
        reason: `job ${job.id}: missing 'scheduledByRole'. Add "scheduledByRole": "owner" if you authored this entry manually.`,
      }
    }

    if (job.kind === 'prompt' && job.subagent !== undefined && options.subagents !== undefined) {
      const subagent = options.subagents[job.subagent]
      if (!subagent) {
        return { ok: false, reason: `job ${job.id}: unknown subagent "${job.subagent}"` }
      }
      try {
        validateSubagentPayload(job.subagent, subagent, job.payload)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, reason: `job ${job.id}: ${message}` }
      }
    }
  }

  return { ok: true, file }
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'
  return `${path}: ${issue.message}`
}
