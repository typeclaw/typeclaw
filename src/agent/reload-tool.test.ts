import { describe, expect, test } from 'bun:test'

import { ReloadRegistry, type ReloadResult } from '@/reload'

import { createProviderAuthReloadable } from './auth-reloadable'
import { createReloadTool } from './reload-tool'

function regWith(...results: ReloadResult[]): ReloadRegistry {
  const reg = new ReloadRegistry()
  for (const r of results) {
    reg.register({
      scope: r.scope,
      description: `${r.scope} reloadable`,
      reload: async () => r,
    })
  }
  return reg
}

async function execute(tool: ReturnType<typeof createReloadTool>, args: { scope?: string } = {}) {
  return await tool.execute('test-call', args, undefined, undefined, {} as never)
}

describe('createReloadTool', () => {
  test('exposes name "reload" and a description for the LLM', () => {
    const tool = createReloadTool({ registry: new ReloadRegistry() })
    expect(tool.name).toBe('reload')
    expect(tool.description.length).toBeGreaterThan(0)
  })

  test('returns a textual summary listing each scope and its outcome', async () => {
    const reg = regWith(
      { scope: 'cron', ok: true, summary: '2 jobs (added 1, removed 0, updated 1, unchanged 0)' },
      { scope: 'config', ok: true, summary: 'config reloaded' },
    )
    const tool = createReloadTool({ registry: reg })

    const result = await execute(tool)

    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    expect(text).toContain('cron')
    expect(text).toContain('config')
    expect(text).toContain('ok')
  })

  test('marks per-scope failures with their reason in the output text', async () => {
    const reg = regWith(
      { scope: 'cron', ok: false, reason: 'job daily-summary: invalid schedule' },
      { scope: 'config', ok: true, summary: 'config reloaded' },
    )
    const tool = createReloadTool({ registry: reg })

    const result = await execute(tool)

    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    expect(text).toContain('cron')
    expect(text).toContain('failed')
    expect(text).toContain('invalid schedule')
  })

  test('details include the structured ReloadAllResult', async () => {
    const reg = regWith({ scope: 'cron', ok: true, summary: 'ok' })
    const tool = createReloadTool({ registry: reg })

    const result = await execute(tool)

    const details = result.details as { results: { scope: string; ok: boolean }[] }
    expect(details.results).toHaveLength(1)
    expect(details.results[0]?.scope).toBe('cron')
  })

  test('handles an empty registry without throwing', async () => {
    const tool = createReloadTool({ registry: new ReloadRegistry() })

    const result = await execute(tool)

    const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
    expect(text).toMatch(/nothing|no.*reloadable|empty/i)
  })

  test('with scope arg, runs only the named reloadable', async () => {
    // given
    const calls: string[] = []
    const reg = new ReloadRegistry()
    reg.register({
      scope: 'config',
      description: 'config',
      reload: async () => {
        calls.push('config')
        return { scope: 'config', ok: true, summary: 'cfg ok' }
      },
    })
    reg.register({
      scope: 'cron',
      description: 'cron',
      reload: async () => {
        calls.push('cron')
        return { scope: 'cron', ok: true, summary: 'cron ok' }
      },
    })
    const tool = createReloadTool({ registry: reg })

    // when
    const result = await execute(tool, { scope: 'cron' })

    // then
    expect(calls).toEqual(['cron'])
    const details = result.details as { results: { scope: string }[] }
    expect(details.results).toHaveLength(1)
    expect(details.results[0]?.scope).toBe('cron')
  })

  test('with unknown scope, returns a single failure result without invoking any reloadable', async () => {
    // given
    const calls: string[] = []
    const reg = new ReloadRegistry()
    reg.register({
      scope: 'config',
      description: 'config',
      reload: async () => {
        calls.push('config')
        return { scope: 'config', ok: true, summary: 'cfg ok' }
      },
    })
    const tool = createReloadTool({ registry: reg })

    // when
    const result = await execute(tool, { scope: 'no-such' })

    // then
    expect(calls).toEqual([])
    const details = result.details as { results: { scope: string; ok: boolean }[] }
    expect(details.results).toHaveLength(1)
    expect(details.results[0]?.scope).toBe('no-such')
    expect(details.results[0]?.ok).toBe(false)
  })

  test('without scope arg, runs all reloadables in registration order', async () => {
    // given
    const calls: string[] = []
    const reg = new ReloadRegistry()
    reg.register({
      scope: 'config',
      description: 'config',
      reload: async () => {
        calls.push('config')
        return { scope: 'config', ok: true, summary: 'cfg ok' }
      },
    })
    reg.register({
      scope: 'cron',
      description: 'cron',
      reload: async () => {
        calls.push('cron')
        return { scope: 'cron', ok: true, summary: 'cron ok' }
      },
    })
    const tool = createReloadTool({ registry: reg })

    // when
    await execute(tool)

    // then
    expect(calls).toEqual(['config', 'cron'])
  })

  test('without scope arg, skips forced provider invalidation', async () => {
    const calls: string[] = []
    let liveSessionTeardowns = 0
    const reg = new ReloadRegistry()
    for (const scope of ['config', 'cron']) {
      reg.register({
        scope,
        description: scope,
        reload: async () => {
          calls.push(scope)
          return { scope, ok: true, summary: `${scope} ok` }
        },
      })
    }
    reg.register(
      createProviderAuthReloadable({
        onProviderAuthChanged: () => {
          liveSessionTeardowns++
        },
      }),
    )

    const result = await execute(createReloadTool({ registry: reg }))

    expect(calls).toEqual(['config', 'cron'])
    expect(liveSessionTeardowns).toBe(0)
    expect((result.details as { results: ReloadResult[] }).results.map((item) => item.scope)).toEqual([
      'config',
      'cron',
    ])
  })

  test('explicit providers scope still forces provider invalidation', async () => {
    let liveSessionTeardowns = 0
    const reg = new ReloadRegistry()
    reg.register(
      createProviderAuthReloadable({
        onProviderAuthChanged: () => {
          liveSessionTeardowns++
        },
      }),
    )

    const result = await execute(createReloadTool({ registry: reg }), { scope: 'providers' })

    expect(liveSessionTeardowns).toBe(1)
    expect((result.details as { results: ReloadResult[] }).results.map((item) => item.scope)).toEqual(['providers'])
  })
})
