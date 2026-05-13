import { defineCommand } from 'citty'

import { formatJson, formatReport, runDoctor, type DoctorRunResult } from '@/doctor'
import { findAgentDir } from '@/init'

export const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'diagnose the host, agent folder, and plugins; surface remediation steps',
  },
  args: {
    verbose: {
      type: 'boolean',
      alias: 'v',
      description: 'show check details and per-entry hints',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'emit the doctor report as JSON',
      default: false,
    },
    fix: {
      type: 'boolean',
      description: 'attempt to auto-fix issues and commit changes in the agent folder',
      default: false,
    },
    only: {
      type: 'string',
      description: 'comma-separated list of categories to include (e.g. docker,config)',
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()
    const only = parseOnly(args.only)
    const result = await runDoctor({
      cwd,
      fix: args.fix,
      ...(only !== undefined ? { only } : {}),
    })
    emit(result, { verbose: args.verbose, json: args.json })
    process.exit(exitCodeFor(result))
  },
})

export function exitCodeFor(result: DoctorRunResult): number {
  const last = result.final ?? result.initial
  if (!last.ok) return 1
  if (result.commit?.kind === 'failed') return 1
  if (result.fixAttempts?.some((a) => a.ok === false)) return 1
  return 0
}

function parseOnly(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return parts.length > 0 ? parts : undefined
}

function emit(result: DoctorRunResult, opts: { verbose: boolean; json: boolean }): void {
  if (opts.json) {
    process.stdout.write(`${formatJson(result.final ?? result.initial)}\n`)
    return
  }
  const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
  process.stdout.write(`${formatReport(result.initial, { useColor, verbose: opts.verbose })}\n`)

  if (result.fixAttempts) {
    process.stdout.write('\n')
    process.stdout.write(`${formatFixAttempts(result, useColor)}\n`)
  }
  if (result.final) {
    process.stdout.write('\n')
    process.stdout.write(`${formatReport(result.final, { useColor, verbose: opts.verbose })}\n`)
  }
}

function formatFixAttempts(result: DoctorRunResult, useColor: boolean): string {
  const lines: string[] = []
  lines.push(useColor ? '\u001b[1m--fix\u001b[0m' : '--fix')
  for (const attempt of result.fixAttempts ?? []) {
    const tag = attempt.source === 'static' ? '[static]' : `[plugin]`
    if (attempt.ok) {
      lines.push(`  ${tag} ${attempt.name}: ${attempt.summary}`)
    } else {
      lines.push(`  ${tag} ${attempt.name}: failed: ${attempt.reason}`)
    }
  }
  if (result.commit) {
    if (result.commit.kind === 'committed') {
      lines.push(`  commit: ${result.commit.commitSha.slice(0, 12)} (${result.commit.pathsStaged.length} path(s))`)
    } else if (result.commit.kind === 'skipped') {
      lines.push(`  commit: skipped — ${result.commit.reason}`)
    } else {
      lines.push(`  commit: failed — ${result.commit.reason}`)
    }
  }
  return lines.join('\n')
}
