import { describe, expect, test } from 'bun:test'

import { buildReport } from './report'
import type { TaskScore } from './score'

const score = (taskId: string, passHatK: boolean, passRate: number): TaskScore => ({
  taskId,
  runs: 3,
  passAt1: passRate > 0 ? 1 : 0,
  passHatK,
  passRate,
  outcomes: [],
})

describe('buildReport', () => {
  test('aggregates pass^k rate and mean pass rate across tasks', () => {
    const report = buildReport({
      suite: 'demo-suite',
      container: 'agent',
      runsPerTask: 3,
      scores: [score('a', true, 1), score('b', false, 1 / 3)],
    })

    expect(report.passHatKRate).toBe(0.5)
    expect(report.meanPassRate).toBeCloseTo((1 + 1 / 3) / 2)
    expect(report.tasks).toHaveLength(2)
    expect(report.container).toBe('agent')
  })

  test('handles an empty suite without dividing by zero', () => {
    const report = buildReport({ suite: 'empty', container: 'agent', runsPerTask: 3, scores: [] })

    expect(report.passHatKRate).toBe(0)
    expect(report.meanPassRate).toBe(0)
  })
})
