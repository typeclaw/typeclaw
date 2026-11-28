import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

import {
  checkSpotlightExclusion,
  ensureSpotlightExclusion,
  type HelperRun,
  NEVER_INDEXED_ROOTS,
  type SpotlightDeps,
  spotlightWarning,
} from '.'

const AGENT_DIR = import.meta.dir
const checkoutIsInSystemTemp = NEVER_INDEXED_ROOTS.some((root) => realpathSync(AGENT_DIR).startsWith(`${root}${sep}`))

function helperReturning(run: Partial<HelperRun>): SpotlightDeps & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    platform: 'darwin',
    neverIndexedRoots: () => [],
    runHelper: async (op, dir) => {
      calls.push([op, dir])
      return { stdout: '', exitCode: 0, signalCode: null, timedOut: false, ...run }
    },
  }
}

const respond = (body: object) => helperReturning({ stdout: `${JSON.stringify(body)}\n` })

describe('ensureSpotlightExclusion', () => {
  test('does nothing off macOS', async () => {
    const deps = { ...respond({ ok: true, state: 'newly-excluded' }), platform: 'linux' as const }

    expect(await ensureSpotlightExclusion(AGENT_DIR, deps)).toEqual({ kind: 'skipped', reason: 'not-macos' })
    expect(deps.calls).toEqual([])
  })

  test.skipIf(process.platform !== 'darwin')('skips folders under the system temp root', async () => {
    const tmp = mkdtempSync('/tmp/spotlight-')
    try {
      const deps = { ...respond({ ok: true, state: 'newly-excluded' }), neverIndexedRoots: undefined }

      expect(await ensureSpotlightExclusion(tmp, deps)).toEqual({ kind: 'skipped', reason: 'never-indexed' })
      expect(deps.calls).toEqual([])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test.skipIf(checkoutIsInSystemTemp)('still excludes a folder under an operator-chosen TMPDIR', async () => {
    const previous = process.env.TMPDIR
    process.env.TMPDIR = dirname(AGENT_DIR)
    try {
      const deps = { ...respond({ ok: true, state: 'newly-excluded' }), neverIndexedRoots: undefined }

      expect(await ensureSpotlightExclusion(AGENT_DIR, deps)).toEqual({ kind: 'excluded', changed: true })
      expect(deps.calls).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }
  })

  test('skips folders inside a dot-directory', async () => {
    const deps = { ...respond({ ok: true, state: 'newly-excluded' }), neverIndexedRoots: () => [] }

    expect(await ensureSpotlightExclusion(join(AGENT_DIR, '..', '..', '.github'), deps)).toEqual({
      kind: 'skipped',
      reason: 'never-indexed',
    })
    expect(deps.calls).toEqual([])
  })

  test('passes the resolved folder to the helper and reports a new exclusion', async () => {
    const deps = respond({ ok: true, state: 'newly-excluded' })

    expect(await ensureSpotlightExclusion(join(AGENT_DIR, '.', '..', 'spotlight'), deps)).toEqual({
      kind: 'excluded',
      changed: true,
    })
    expect(deps.calls).toEqual([['ensure', realpathSync(AGENT_DIR)]])
  })

  test('reports an existing exclusion as unchanged', async () => {
    expect(await ensureSpotlightExclusion(AGENT_DIR, respond({ ok: true, state: 'excluded' }))).toEqual({
      kind: 'excluded',
      changed: false,
    })
  })

  test('fails when the folder does not exist', async () => {
    const result = await ensureSpotlightExclusion(join(AGENT_DIR, 'missing'), respond({ ok: true, state: 'excluded' }))

    expect(result).toMatchObject({ kind: 'failed' })
  })

  test('maps a missing private API to unavailable', async () => {
    const result = await ensureSpotlightExclusion(
      AGENT_DIR,
      respond({ ok: false, code: 'unavailable', detail: 'symbol not found' }),
    )

    expect(result).toEqual({ kind: 'unavailable', detail: 'Spotlight exclusion API unavailable: symbol not found' })
  })

  test('treats a helper crash as an unavailable API', async () => {
    const result = await ensureSpotlightExclusion(AGENT_DIR, helperReturning({ exitCode: null, signalCode: 'SIGSEGV' }))

    expect(result).toEqual({ kind: 'unavailable', detail: 'Spotlight helper crashed (SIGSEGV)' })
  })

  test('fails on a hung helper, unparseable output, or a dropped request', async () => {
    expect(await ensureSpotlightExclusion(AGENT_DIR, helperReturning({ timedOut: true }))).toMatchObject({
      kind: 'failed',
    })
    expect(await ensureSpotlightExclusion(AGENT_DIR, helperReturning({ stdout: 'dyld: oops' }))).toMatchObject({
      kind: 'failed',
    })
    expect(
      await ensureSpotlightExclusion(AGENT_DIR, respond({ ok: false, code: 'not-applied', detail: 'dropped' })),
    ).toEqual({ kind: 'failed', detail: 'dropped' })
  })

  test('fails instead of throwing on a well-formed but malformed reply', async () => {
    for (const body of [{ ok: true }, { ok: true, state: 'purged' }, { ok: false }, { ok: false, code: 'gone' }, []]) {
      const outcome = await ensureSpotlightExclusion(AGENT_DIR, respond(body))

      expect(outcome).toMatchObject({ kind: 'failed' })
      expect(spotlightWarning(AGENT_DIR, outcome)).toContain('Search Privacy')
    }
  })

  test('fails when the helper cannot be spawned', async () => {
    const result = await ensureSpotlightExclusion(AGENT_DIR, {
      platform: 'darwin',
      neverIndexedRoots: () => [],
      runHelper: async () => {
        throw new Error('ENOENT')
      },
    })

    expect(result).toEqual({ kind: 'failed', detail: 'could not start the Spotlight helper: ENOENT' })
  })
})

describe('checkSpotlightExclusion', () => {
  test('asks the helper to check, not to change the list', async () => {
    const deps = respond({ ok: true, state: 'not-excluded' })

    expect(await checkSpotlightExclusion(AGENT_DIR, deps)).toEqual({ kind: 'not-excluded' })
    expect(deps.calls).toEqual([['check', realpathSync(AGENT_DIR)]])
  })

  test.skipIf(process.platform !== 'darwin')('reads the real Privacy list through the private API', async () => {
    const result = await checkSpotlightExclusion(AGENT_DIR, { neverIndexedRoots: () => [] })

    expect(['excluded', 'not-excluded']).toContain(result.kind)
  })
})

describe('spotlightWarning', () => {
  test('stays quiet unless the exclusion could not be applied', () => {
    expect(spotlightWarning('/a', { kind: 'excluded', changed: true })).toBeNull()
    expect(spotlightWarning('/a', { kind: 'skipped', reason: 'not-macos' })).toBeNull()
    expect(spotlightWarning('/a', { kind: 'unavailable', detail: 'gone' })).toContain('/a')
    expect(spotlightWarning('/a', { kind: 'failed', detail: 'hung' })).toContain('/a')
  })
})
