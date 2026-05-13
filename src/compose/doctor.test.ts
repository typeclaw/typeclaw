import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DoctorRunResult } from '@/doctor'

import { composeDoctor, runCrossChecks } from './doctor'

function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'typeclaw-compose-doctor-'))
}

function makeAgent(root: string, name: string, config: Record<string, unknown>): string {
  const cwd = join(root, name)
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(cwd, 'typeclaw.json'), JSON.stringify(config), 'utf8')
  return cwd
}

function passingResult(cwd: string): DoctorRunResult {
  return {
    initial: {
      cwd,
      hasAgentFolder: true,
      entries: [],
      summary: { ok: 0, warning: 0, error: 0, info: 0, skipped: 0 },
      ok: true,
    },
  }
}

describe('composeDoctor', () => {
  test('flags duplicate preferred ports across agents', async () => {
    const root = makeTmpRoot()
    makeAgent(root, 'alpha', { port: 8973 })
    makeAgent(root, 'beta', { port: 8973 })
    makeAgent(root, 'gamma', { port: 9000 })

    const report = await composeDoctor({
      rootCwd: root,
      runDoctorFn: async ({ cwd }) => passingResult(cwd as string),
    })

    const portCheck = report.crossChecks.find((c) => c.name === 'compose.no-port-collisions')
    expect(portCheck?.status).toBe('warning')
    expect(portCheck?.details?.[0]).toMatch(/alpha.*beta|beta.*alpha/)
  })

  test('returns ok=true when nothing collides', async () => {
    const root = makeTmpRoot()
    makeAgent(root, 'alpha', { port: 8973 })
    makeAgent(root, 'beta', { port: 9000 })

    const report = await composeDoctor({
      rootCwd: root,
      runDoctorFn: async ({ cwd }) => passingResult(cwd as string),
    })
    expect(report.ok).toBe(true)
  })

  test('reports empty root with an info note', async () => {
    const root = makeTmpRoot()
    const report = await composeDoctor({ rootCwd: root, runDoctorFn: async () => passingResult('') })
    const note = report.crossChecks.find((c) => c.name === 'compose.root-has-agents')
    expect(note?.status).toBe('info')
    expect(report.agents).toEqual([])
  })

  test('reports ok=false when any agent has a failing internal check', async () => {
    const root = makeTmpRoot()
    makeAgent(root, 'alpha', { port: 8973 })
    makeAgent(root, 'beta', { port: 9000 })

    const report = await composeDoctor({
      rootCwd: root,
      runDoctorFn: async ({ cwd }) => {
        const passing = passingResult(cwd as string)
        if ((cwd as string).endsWith('/beta')) {
          passing.initial.summary.error = 1
          passing.initial.ok = false
        }
        return passing
      },
    })
    expect(report.ok).toBe(false)
  })

  test('runs per-agent doctor by default, skips it under --shallow', async () => {
    const root = makeTmpRoot()
    makeAgent(root, 'alpha', { port: 8973 })
    let calls = 0
    const counted = async ({ cwd }: { cwd?: string }): Promise<DoctorRunResult> => {
      calls++
      return passingResult(cwd ?? '')
    }
    await composeDoctor({ rootCwd: root, runDoctorFn: counted })
    expect(calls).toBe(1)
    calls = 0
    await composeDoctor({ rootCwd: root, runDoctorFn: counted, shallow: true })
    expect(calls).toBe(0)
  })
})

describe('runCrossChecks', () => {
  test('detects container-name collisions when folders sanitize to the same name', () => {
    const agents = [
      { name: 'foo', cwd: '/tmp/foo', containerName: 'shared' },
      { name: 'bar', cwd: '/tmp/bar', containerName: 'shared' },
      { name: 'baz', cwd: '/tmp/baz', containerName: 'unique' },
    ]
    const checks = runCrossChecks(agents)
    const collision = checks.find((c) => c.name === 'compose.no-container-name-collisions')
    expect(collision?.status).toBe('error')
    expect(collision?.details?.[0]).toContain('shared')
  })
})
