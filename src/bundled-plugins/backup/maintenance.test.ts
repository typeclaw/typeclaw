import { describe, expect, test } from 'bun:test'

import type { AgentGit } from '@/git/resolve-agent-git'

import { DEFAULT_GC_PACK_THRESHOLD, maybeRunGitGc, parsePackCount } from './maintenance'
import type { GitSpawn, GitSpawnResult } from './runner'

const ok = (stdout = ''): GitSpawnResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false })
const fail = (exit = 1, stderr = 'boom'): GitSpawnResult => ({ exitCode: exit, stdout: '', stderr, timedOut: false })

const repo: AgentGit = { kind: 'dotgit', gitArgs: [] }

type Call = readonly string[]

function makeSpawn(handler: (args: readonly string[]) => GitSpawnResult): { spawn: GitSpawn; calls: Call[] } {
  const calls: Call[] = []
  const spawn: GitSpawn = async (args) => {
    calls.push(args)
    return handler(args)
  }
  return { spawn, calls }
}

const countOutput = (packs: number): string =>
  ['count: 12', 'size: 48', `in-pack: 869416`, `packs: ${packs}`, 'size-pack: 1200000'].join('\n')

describe('parsePackCount', () => {
  test('reads the packs line from count-objects -v output', () => {
    expect(parsePackCount(countOutput(40))).toBe(40)
  })

  test('returns 0 when the packs line is absent or malformed', () => {
    expect(parsePackCount('count: 5\nsize: 20\n')).toBe(0)
    expect(parsePackCount('packs: not-a-number\n')).toBe(0)
    expect(parsePackCount('')).toBe(0)
  })
})

describe('maybeRunGitGc', () => {
  test('runs gc when pack count meets the threshold', async () => {
    // given
    const { spawn, calls } = makeSpawn((args) => (args.includes('count-objects') ? ok(countOutput(25)) : ok()))

    // when
    const result = await maybeRunGitGc({ cwd: '/agent', repo, gitSpawn: spawn, packThreshold: 20 })

    // then
    expect(result).toEqual({ ran: true, ok: true, packsBefore: 25 })
    expect(calls.some((c) => c.includes('gc'))).toBe(true)
  })

  test('skips gc when pack count is below the threshold', async () => {
    const { spawn, calls } = makeSpawn((args) => (args.includes('count-objects') ? ok(countOutput(5)) : ok()))

    const result = await maybeRunGitGc({ cwd: '/agent', repo, gitSpawn: spawn, packThreshold: 20 })

    expect(result).toEqual({ ran: false, reason: 'below-threshold' })
    expect(calls.some((c) => c.includes('gc'))).toBe(false)
  })

  test('is disabled when threshold is 0 and never reads the repo', async () => {
    const { spawn, calls } = makeSpawn(() => ok())

    const result = await maybeRunGitGc({ cwd: '/agent', repo, gitSpawn: spawn, packThreshold: 0 })

    expect(result).toEqual({ ran: false, reason: 'disabled' })
    expect(calls.length).toBe(0)
  })

  test('reports count-failed without running gc when count-objects fails', async () => {
    const { spawn, calls } = makeSpawn((args) => (args.includes('count-objects') ? fail() : ok()))

    const result = await maybeRunGitGc({ cwd: '/agent', repo, gitSpawn: spawn, packThreshold: 20 })

    expect(result).toEqual({ ran: false, reason: 'count-failed' })
    expect(calls.some((c) => c.includes('gc'))).toBe(false)
  })

  test('reports ok:false but never throws when gc itself fails', async () => {
    const { spawn } = makeSpawn((args) => (args.includes('count-objects') ? ok(countOutput(30)) : fail()))

    const result = await maybeRunGitGc({ cwd: '/agent', repo, gitSpawn: spawn, packThreshold: 20 })

    expect(result).toEqual({ ran: true, ok: false, packsBefore: 30 })
  })

  test('threads gitstore gitArgs into the git invocations', async () => {
    const gitstoreRepo: AgentGit = {
      kind: 'gitstore',
      gitArgs: ['--git-dir', '/agent/.gitstore', '--work-tree', '/agent'],
    }
    const { spawn, calls } = makeSpawn((args) => (args.includes('count-objects') ? ok(countOutput(25)) : ok()))

    await maybeRunGitGc({ cwd: '/agent', repo: gitstoreRepo, gitSpawn: spawn, packThreshold: 20 })

    for (const call of calls) {
      expect(call.slice(0, 4)).toEqual(['--git-dir', '/agent/.gitstore', '--work-tree', '/agent'])
    }
  })

  test('default threshold is a positive pack count', () => {
    expect(DEFAULT_GC_PACK_THRESHOLD).toBeGreaterThan(0)
  })
})
