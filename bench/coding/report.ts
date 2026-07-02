import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { TaskScore } from './score'

export type SuiteReport = {
  suite: string
  container: string
  ranAt: string
  runsPerTask: number
  passHatKRate: number
  meanPassRate: number
  tasks: { taskId: string; passAt1: number; passHatK: boolean; passRate: number }[]
}

export function buildReport(args: {
  suite: string
  container: string
  runsPerTask: number
  scores: TaskScore[]
}): SuiteReport {
  const { scores } = args
  const passHatKCount = scores.filter((s) => s.passHatK).length
  const meanPassRate = scores.length === 0 ? 0 : scores.reduce((sum, s) => sum + s.passRate, 0) / scores.length

  return {
    suite: args.suite,
    container: args.container,
    ranAt: new Date().toISOString(),
    runsPerTask: args.runsPerTask,
    passHatKRate: scores.length === 0 ? 0 : passHatKCount / scores.length,
    meanPassRate,
    tasks: scores.map((s) => ({
      taskId: s.taskId,
      passAt1: s.passAt1,
      passHatK: s.passHatK,
      passRate: s.passRate,
    })),
  }
}

export async function writeReport(resultsDir: string, report: SuiteReport): Promise<string> {
  await mkdir(resultsDir, { recursive: true })
  const stamp = report.ranAt.replace(/[:.]/g, '-')
  const path = join(resultsDir, `${stamp}.json`)
  await writeFile(path, JSON.stringify(report, null, 2) + '\n')
  return path
}
