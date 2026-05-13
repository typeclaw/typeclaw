import { findAgentDir } from '@/init'
import type { DoctorCheckPayload } from '@/shared'

import { buildStaticChecks } from './checks'
import { commitAutoFixes, type SpawnGit } from './commit'
import {
  fetchPluginDoctorChecks as defaultFetchPluginDoctorChecks,
  fetchPluginDoctorFix as defaultFetchPluginDoctorFix,
  type PluginBridgeChecksResult,
  type PluginBridgeFetchChecks,
  type PluginBridgeFetchFix,
  type PluginBridgeFixResult,
} from './plugin-bridge'
import type {
  CheckContext,
  CheckResult,
  DoctorCheck,
  DoctorReport,
  DoctorRunResult,
  FixAttempt,
  ReportEntry,
  ReportSummary,
  Severity,
} from './types'

export * from './types'
export { buildStaticChecks } from './checks'
export { formatJson, formatReport } from './report'
export { buildCommitMessage, commitAutoFixes } from './commit'
export {
  fetchPluginDoctorChecks,
  fetchPluginDoctorFix,
  type PluginBridgeChecksResult,
  type PluginBridgeFixResult,
} from './plugin-bridge'

export type RunDoctorOptions = {
  cwd?: string
  only?: string[]
  fix?: boolean
  staticChecks?: DoctorCheck[]
  fetchPluginChecks?: PluginBridgeFetchChecks
  fetchPluginFix?: PluginBridgeFetchFix
  spawnGit?: SpawnGit
}

export async function runDoctor(opts: RunDoctorOptions = {}): Promise<DoctorRunResult> {
  const cwd = opts.cwd ?? findAgentDir(process.cwd()) ?? process.cwd()
  const hasAgentFolder = findAgentDir(cwd) === cwd
  const ctx: CheckContext = { cwd, hasAgentFolder }

  const staticChecks = (opts.staticChecks ?? buildStaticChecks()).filter((c) => isAllowed(c, opts.only, c.category))
  const staticResults = await runStaticChecks(staticChecks, ctx)

  const fetchPluginChecks = opts.fetchPluginChecks ?? defaultFetchPluginDoctorChecks
  const pluginResults = await collectPluginChecks(fetchPluginChecks, ctx, opts.only)

  const initial = buildReport(ctx, staticResults, pluginResults)

  if (opts.fix !== true || initial.ok) {
    return { initial }
  }

  const fetchPluginFix = opts.fetchPluginFix ?? defaultFetchPluginDoctorFix
  const attempts: FixAttempt[] = []
  attempts.push(...(await runStaticFixes(staticResults, ctx)))
  attempts.push(...(await runPluginFixes(pluginResults.entries, fetchPluginFix, ctx)))

  const commit = hasAgentFolder
    ? await commitAutoFixes({ cwd, attempts, ...(opts.spawnGit !== undefined ? { spawnGit: opts.spawnGit } : {}) })
    : { kind: 'skipped' as const, reason: 'no agent folder; nothing to commit' }

  const finalStaticResults = await runStaticChecks(staticChecks, ctx)
  const finalPluginResults = await collectPluginChecks(fetchPluginChecks, ctx, opts.only)
  const final = buildReport(ctx, finalStaticResults, finalPluginResults)

  return { initial, fixAttempts: attempts, commit, final }
}

type StaticResult = {
  check: DoctorCheck
  result: CheckResult
}

type PluginCollect = {
  entries: PluginEntry[]
  reachability: PluginBridgeChecksResult
}

type PluginEntry = {
  payload: DoctorCheckPayload
}

async function runStaticChecks(checks: DoctorCheck[], ctx: CheckContext): Promise<StaticResult[]> {
  const out: StaticResult[] = []
  for (const check of checks) {
    if (check.applies && !check.applies(ctx)) {
      out.push({ check, result: { status: 'skipped', message: 'not applicable' } })
      continue
    }
    try {
      out.push({ check, result: await check.run(ctx) })
    } catch (err) {
      out.push({ check, result: { status: 'error', message: err instanceof Error ? err.message : String(err) } })
    }
  }
  return out
}

async function collectPluginChecks(
  fetcher: PluginBridgeFetchChecks,
  ctx: CheckContext,
  only: string[] | undefined,
): Promise<PluginCollect> {
  if (!ctx.hasAgentFolder) {
    return { entries: [], reachability: { kind: 'unreachable', reason: 'no agent folder' } }
  }
  const reachability = await fetcher({ cwd: ctx.cwd })
  if (reachability.kind !== 'ok') return { entries: [], reachability }
  const filtered = reachability.checks.filter((c) => isAllowed({ category: c.category }, only, c.category))
  return { entries: filtered.map((payload) => ({ payload })), reachability }
}

function buildReport(ctx: CheckContext, staticResults: StaticResult[], plugin: PluginCollect): DoctorReport {
  const entries: ReportEntry[] = []
  for (const { check, result } of staticResults) {
    const entry: ReportEntry = {
      name: check.name,
      category: check.category,
      description: check.description,
      source: 'static',
      status: result.status,
      message: result.message,
    }
    if (result.details !== undefined) entry.details = result.details
    if (result.fix !== undefined) {
      entry.fix = { description: result.fix.description, canAutoFix: result.fix.autoFix !== undefined }
    }
    entries.push(entry)
  }

  if (ctx.hasAgentFolder && plugin.reachability.kind !== 'ok') {
    entries.push(reachabilityNote(plugin.reachability))
  }

  for (const { payload } of plugin.entries) {
    const entry: ReportEntry = {
      name: payload.checkName,
      category: payload.category,
      description: payload.description,
      source: 'plugin',
      pluginName: payload.pluginName,
      status: payload.status,
      message: payload.message,
    }
    if (payload.details !== undefined) entry.details = payload.details
    if (payload.fix !== undefined) {
      entry.fix = { description: payload.fix.description, canAutoFix: payload.fix.hasApply }
    }
    entries.push(entry)
  }

  const summary = summarize(entries)
  const ok = summary.error === 0 && summary.warning === 0
  return { cwd: ctx.cwd, hasAgentFolder: ctx.hasAgentFolder, entries, summary, ok }
}

function reachabilityNote(reach: PluginBridgeChecksResult): ReportEntry {
  const message =
    reach.kind === 'unreachable'
      ? `plugin checks deferred: container not reachable (${reach.reason})`
      : reach.kind === 'timeout'
        ? 'plugin checks deferred: container did not respond in time'
        : `plugin checks deferred: ${reach.kind === 'error' ? reach.reason : 'unknown reason'}`
  return {
    name: 'plugin-checks-deferred',
    category: 'container',
    description: 'plugin doctor checks require a running container',
    source: 'static',
    status: 'info',
    message,
    details: ['Run `typeclaw start` then re-run `typeclaw doctor` to include plugin checks.'],
  }
}

function summarize(entries: ReportEntry[]): ReportSummary {
  const summary: ReportSummary = { ok: 0, warning: 0, error: 0, info: 0, skipped: 0 }
  for (const e of entries) {
    summary[e.status as keyof ReportSummary]++
  }
  return summary
}

function isAllowed(target: { category: string }, only: string[] | undefined, category: string): boolean {
  if (!only || only.length === 0) return true
  if (only.includes(target.category) || only.includes(category)) return true
  if (category.startsWith('plugin:')) return only.includes('plugin') || only.includes(category)
  return false
}

async function runStaticFixes(results: StaticResult[], ctx: CheckContext): Promise<FixAttempt[]> {
  const attempts: FixAttempt[] = []
  for (const { check, result } of results) {
    if (result.status === 'ok' || result.status === 'skipped' || result.status === 'info') continue
    const apply = result.fix?.autoFix
    if (!apply) continue
    try {
      const fix = await apply(ctx)
      attempts.push({
        name: check.name,
        source: 'static',
        ok: true,
        summary: fix.summary,
        changedPaths: fix.changedPaths,
      })
    } catch (err) {
      attempts.push({
        name: check.name,
        source: 'static',
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return attempts
}

async function runPluginFixes(
  entries: PluginEntry[],
  fetchFix: PluginBridgeFetchFix,
  ctx: CheckContext,
): Promise<FixAttempt[]> {
  const attempts: FixAttempt[] = []
  for (const { payload } of entries) {
    if (payload.status === 'ok') continue
    if (payload.fix === undefined || payload.fix.hasApply !== true) continue
    const result = await fetchFix({ cwd: ctx.cwd, checkId: payload.id })
    if (result.kind !== 'ok') {
      attempts.push({
        name: `${payload.pluginName}.${payload.checkName}`,
        source: 'plugin',
        ok: false,
        reason:
          result.kind === 'unreachable'
            ? result.reason
            : result.kind === 'timeout'
              ? 'timeout'
              : (result as { reason: string }).reason,
      })
      continue
    }
    if (result.payload.ok) {
      const accepted = sanitizeChangedPathsForHost(ctx.cwd, result.payload.changedPaths)
      attempts.push({
        name: `${payload.pluginName}.${payload.checkName}`,
        source: 'plugin',
        ok: true,
        summary: result.payload.summary,
        changedPaths: accepted,
      })
    } else {
      attempts.push({
        name: `${payload.pluginName}.${payload.checkName}`,
        source: 'plugin',
        ok: false,
        reason: result.payload.error,
      })
    }
  }
  return attempts
}

// Defense in depth: even though the container-side runner sanitizes
// changedPaths, re-validate on the host before `git add` so a future protocol
// change cannot bypass the security boundary by accident. The rules here MUST
// stay identical to `sanitizeChangedPaths` in `src/agent/doctor.ts`.
function sanitizeChangedPathsForHost(_cwd: string, paths: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    if (raw.includes('\0') || raw.includes('\\')) continue
    if (raw.startsWith('/')) continue
    const stripped = posixNormalize(raw).replace(/\/+$/, '')
    if (stripped === '.' || stripped === '' || stripped.startsWith('..')) continue
    if (stripped.split('/').includes('..')) continue
    out.push(stripped)
  }
  return out
}

function posixNormalize(p: string): string {
  const segments = p.split('/').filter((s) => s.length > 0 && s !== '.')
  const stack: string[] = []
  for (const seg of segments) {
    if (seg === '..') {
      if (stack.length === 0) return '..'
      stack.pop()
      continue
    }
    stack.push(seg)
  }
  return stack.join('/') || '.'
}

export type { Severity }
