import { describe, expect, test } from 'bun:test'

import type { HelperRun, SpotlightDeps } from '@/spotlight'

import { spotlightExclusion } from './spotlight'

const ctx = { cwd: import.meta.dir, hasAgentFolder: true }

function deps(responses: Record<'check' | 'ensure', object>): SpotlightDeps & { ops: string[] } {
  const ops: string[] = []
  return {
    ops,
    platform: 'darwin',
    neverIndexedRoots: () => [],
    runHelper: async (op): Promise<HelperRun> => {
      ops.push(op)
      return { stdout: JSON.stringify(responses[op]), exitCode: 0, signalCode: null, timedOut: false }
    },
  }
}

describe('agent-folder.spotlight-excluded', () => {
  test('passes when the folder is already in the Privacy list', async () => {
    const result = await spotlightExclusion(deps({ check: { ok: true, state: 'excluded' }, ensure: {} })).run(ctx)

    expect(result.status).toBe('ok')
  })

  test('warns and auto-fixes an indexed folder', async () => {
    const d = deps({ check: { ok: true, state: 'not-excluded' }, ensure: { ok: true, state: 'newly-excluded' } })

    const result = await spotlightExclusion(d).run(ctx)
    expect(result.status).toBe('warning')
    const fixed = await result.fix?.autoFix?.(ctx)

    expect(fixed).toEqual({ summary: expect.any(String), changedPaths: [] })
    expect(d.ops).toEqual(['check', 'ensure'])
  })

  test('surfaces the manual fix when the auto-fix does not stick', async () => {
    const d = deps({
      check: { ok: true, state: 'not-excluded' },
      ensure: { ok: false, code: 'not-applied', detail: 'Spotlight did not record the exclusion' },
    })

    const result = await spotlightExclusion(d).run(ctx)

    await expect(result.fix?.autoFix?.(ctx)).rejects.toThrow('Search Privacy')
  })

  test('offers only the manual fix when the private API is gone', async () => {
    const d = deps({ check: { ok: false, code: 'unavailable', detail: 'symbol not found' }, ensure: {} })

    const result = await spotlightExclusion(d).run(ctx)

    expect(result.status).toBe('warning')
    expect(result.fix?.autoFix).toBeUndefined()
    expect(result.fix?.description).toContain('Search Privacy')
  })

  test('skips off macOS', async () => {
    const result = await spotlightExclusion({ ...deps({ check: {}, ensure: {} }), platform: 'linux' }).run(ctx)

    expect(result.status).toBe('skipped')
  })
})
