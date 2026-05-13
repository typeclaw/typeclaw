import { describe, expect, test } from 'bun:test'

import type {
  PluginCheckResult,
  PluginDoctorCheck,
  PluginDoctorContext,
  PluginFixResult,
  PluginLogger,
  PluginRegistry,
} from '@/plugin'

import { runPluginDoctorChecks, runPluginDoctorFix, sanitizeChangedPaths } from './doctor'

const silentLogger: PluginLogger = { info: () => {}, warn: () => {}, error: () => {} }

function emptyRegistry(): PluginRegistry {
  return { tools: [], subagents: [], cronJobs: [], skills: [], skillsDirs: [], doctorChecks: [] }
}

function registerCheck(
  registry: PluginRegistry,
  pluginName: string,
  checkName: string,
  check: PluginDoctorCheck,
): void {
  registry.doctorChecks.push({ pluginName, checkName, pluginConfig: undefined, logger: silentLogger, check })
}

describe('runPluginDoctorChecks', () => {
  test('records ok / warning / error results in registry order', async () => {
    const registry = emptyRegistry()
    registerCheck(registry, 'p1', 'a', { description: 'a', run: async () => ({ status: 'ok', message: 'ok' }) })
    registerCheck(registry, 'p1', 'b', {
      description: 'b',
      run: async () => ({ status: 'warning', message: 'warn' }),
    })
    registerCheck(registry, 'p2', 'c', { description: 'c', run: async () => ({ status: 'error', message: 'err' }) })

    const records = await runPluginDoctorChecks({ registry, agentDir: '/agent' })

    expect(records.map((r) => r.id)).toEqual(['p1.a', 'p1.b', 'p2.c'])
    expect(records.map((r) => r.status)).toEqual(['ok', 'warning', 'error'])
  })

  test('catches thrown checks and surfaces them as error', async () => {
    const registry = emptyRegistry()
    registerCheck(registry, 'p1', 'boom', {
      description: 'boom',
      run: async () => {
        throw new Error('kaboom')
      },
    })
    const [record] = await runPluginDoctorChecks({ registry, agentDir: '/agent' })
    expect(record?.status).toBe('error')
    expect(record?.message).toBe('kaboom')
  })

  test('times out runaway checks instead of hanging', async () => {
    const registry = emptyRegistry()
    registerCheck(registry, 'p1', 'slow', {
      description: 'slow',
      run: () => new Promise<PluginCheckResult>(() => {}),
    })
    const [record] = await runPluginDoctorChecks({ registry, agentDir: '/agent', checkTimeoutMs: 30 })
    expect(record?.status).toBe('error')
    expect(record?.message).toMatch(/timed out/)
  })

  test('aborts the check signal when the timeout fires', async () => {
    const registry = emptyRegistry()
    let captured: AbortSignal | undefined
    registerCheck(registry, 'p1', 'observes-signal', {
      description: 'x',
      run: (ctx) =>
        new Promise<PluginCheckResult>(() => {
          captured = ctx.signal
        }),
    })
    const [record] = await runPluginDoctorChecks({ registry, agentDir: '/agent', checkTimeoutMs: 20 })
    expect(captured?.aborted).toBe(true)
    expect(record?.message).toMatch(/timed out/)
  })

  test('reports fix.hasApply: true only when apply is present', async () => {
    const registry = emptyRegistry()
    registerCheck(registry, 'p1', 'with-apply', {
      description: 'x',
      run: async () => ({
        status: 'warning',
        message: 'x',
        fix: { description: 'do it', apply: async () => ({ summary: 's', changedPaths: [] }) },
      }),
    })
    registerCheck(registry, 'p1', 'advisory', {
      description: 'y',
      run: async () => ({ status: 'warning', message: 'y', fix: { description: 'manual' } }),
    })
    const records = await runPluginDoctorChecks({ registry, agentDir: '/agent' })
    expect(records[0]?.fix?.hasApply).toBe(true)
    expect(records[1]?.fix?.hasApply).toBe(false)
  })
})

describe('runPluginDoctorFix', () => {
  test('invokes apply and returns sanitized changedPaths', async () => {
    const registry = emptyRegistry()
    const calls: PluginDoctorContext[] = []
    registerCheck(registry, 'p1', 'fixable', {
      description: 'x',
      run: async (ctx) => {
        calls.push(ctx)
        return {
          status: 'warning',
          message: 'x',
          fix: {
            description: 'create file',
            apply: async (): Promise<PluginFixResult> => ({ summary: 'created x', changedPaths: ['memory/x.md'] }),
          },
        }
      },
    })

    const outcome = await runPluginDoctorFix({ registry, agentDir: '/agent', checkId: 'p1.fixable' })

    expect(outcome).toEqual({ ok: true, summary: 'created x', changedPaths: ['memory/x.md'] })
    expect(calls.length).toBe(1)
    expect(calls[0]?.agentDir).toBe('/agent')
  })

  test('rejects absolute paths, ".." segments, ".", null bytes, backslashes, and empty', () => {
    const result = sanitizeChangedPaths([
      'memory/ok.md',
      '/etc/passwd',
      '../escape',
      'mem/../../oops',
      '.',
      './',
      'foo/..',
      '',
      'has\0null',
      'win\\path',
    ])
    expect(result.accepted).toEqual(['memory/ok.md'])
    expect(result.rejected.sort()).toEqual(
      ['', '.', './', '../escape', '/etc/passwd', 'foo/..', 'has\0null', 'mem/../../oops', 'win\\path'].sort(),
    )
  })

  test('reduces foo/bar/../baz to foo/baz instead of leaking ".."', () => {
    const result = sanitizeChangedPaths(['foo/bar/../baz', 'foo/./bar'])
    expect(result.accepted).toEqual(['foo/baz', 'foo/bar'])
  })

  test('returns error when check has no apply callback', async () => {
    const registry = emptyRegistry()
    registerCheck(registry, 'p1', 'advisory', {
      description: 'x',
      run: async () => ({ status: 'warning', message: 'x', fix: { description: 'manual only' } }),
    })
    const outcome = await runPluginDoctorFix({ registry, agentDir: '/agent', checkId: 'p1.advisory' })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/no auto-fix/)
  })

  test('returns error when checkId is unknown', async () => {
    const registry = emptyRegistry()
    const outcome = await runPluginDoctorFix({ registry, agentDir: '/agent', checkId: 'nope.nope' })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toMatch(/not registered/)
  })

  test('catches throwing apply', async () => {
    const registry = emptyRegistry()
    registerCheck(registry, 'p1', 'bad-fix', {
      description: 'x',
      run: async () => ({
        status: 'warning',
        message: 'x',
        fix: {
          description: 'broken',
          apply: async () => {
            throw new Error('disk full')
          },
        },
      }),
    })
    const outcome = await runPluginDoctorFix({ registry, agentDir: '/agent', checkId: 'p1.bad-fix' })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toBe('disk full')
  })
})
