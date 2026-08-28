import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SubagentRegistry } from '@/agent/subagents'

import { type CronFile, type CronParseWarning, type ParseCronMode, parseCronFile } from './schema'

export { type CountStore, createCountStore } from './count-state'
export { createCronReloadable } from './reloadable'
export { createCronConsumer, type CronConsumer } from './consumer'
export { computeNextFire, createScheduler, type JobDiff, type Scheduler } from './scheduler'
export { aggregateCronList, type CronListEntry, type CronListSource } from './list'
export {
  cronFileSchema,
  cronJobSchema,
  cronRunTimeoutMsSchema,
  type CronFile,
  type CronJob,
  type CronParseWarning,
  type ExecJob,
  type HandlerJob,
  MAX_CRON_RUN_TIMEOUT_MS,
  parseCronJson,
  type ParseCronMode,
  type ParseCronResult,
  type ParsedCronJob,
  type PromptJob,
  validateCronEdit,
} from './schema'

const CRON_FILE = 'cron.json'

export type LoadCronResult =
  | { ok: true; file: CronFile | null; warnings?: CronParseWarning[] }
  | { ok: false; reason: string }

export type LoadCronOptions = {
  subagents?: SubagentRegistry
  // Defaults to strict `load` so inspection/security callers surface bad jobs
  // as a whole-file error. Only the scheduler boot path passes `boot` to
  // isolate individual bad jobs and keep the rest runnable.
  mode?: ParseCronMode
}

export async function loadCron(agentDir: string, options: LoadCronOptions = {}): Promise<LoadCronResult> {
  const path = join(agentDir, CRON_FILE)
  if (!existsSync(path)) return { ok: true, file: null }

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    return { ok: false, reason: `failed to read cron.json: ${errorMessage(err)}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, reason: `cron.json is not valid JSON: ${errorMessage(err)}` }
  }

  const result = parseCronFile(parsed, {
    mode: options.mode ?? 'load',
    ...(options.subagents !== undefined ? { subagents: options.subagents } : {}),
  })
  if (!result.ok) return { ok: false, reason: result.reason }

  return { ok: true, file: result.file, ...(result.warnings ? { warnings: result.warnings } : {}) }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
