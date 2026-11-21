import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSessionWithDispose } from '@/agent'
import { invalidateProviderAuthCache } from '@/agent/auth'
import { createReviewerSubagent } from '@/bundled-plugins/reviewer/reviewer'
import { config, __resetConfigForTesting, reloadConfig } from '@/config/config'

describe('codemode session registration', () => {
  let dir: string
  let previousCwd: string
  let previousKey: string | undefined
  let previousFetch: typeof fetch
  let previousCodemode: typeof config.codemode

  beforeEach(async () => {
    previousCwd = process.cwd()
    previousKey = process.env.ANTHROPIC_API_KEY
    previousFetch = globalThis.fetch
    previousCodemode = config.codemode
    dir = await mkdtemp(join(tmpdir(), 'typeclaw-codemode-session-'))
    await writeFile(
      join(dir, 'typeclaw.json'),
      JSON.stringify({
        models: { default: { model: 'anthropic/claude-sonnet-4-6' } },
      }),
    )
    process.chdir(dir)
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    globalThis.fetch = Object.assign(
      async () => {
        throw new Error('provider requests are forbidden in this test')
      },
      {
        preconnect: () => {
          throw new Error('provider preconnect is forbidden in this test')
        },
      },
    )
    config.codemode = { enabled: true, origins: ['tui', 'subagent'] }
    reloadConfig(dir)
    invalidateProviderAuthCache()
  })

  afterEach(async () => {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    config.codemode = previousCodemode
    invalidateProviderAuthCache()
    __resetConfigForTesting()
    process.chdir(previousCwd)
    await rm(dir, { recursive: true, force: true })
  })

  test('the real reviewer policy prevents codemode registration despite enabled subagent origin', async () => {
    const reviewer = createReviewerSubagent()
    const result = await createSessionWithDispose({
      origin: { kind: 'subagent', subagent: 'renamed', parentSessionId: 'test' },
      pluginSubagent: { pluginName: 'reviewer', toolNamePrefix: 'reviewer', toolRefs: reviewer.tools },
      bashPolicy: reviewer.bashPolicy,
      customTools: [],
    })
    try {
      expect(result.session.getActiveToolNames()).toContain('bash')
      expect(result.session.getActiveToolNames()).not.toContain('codemode')
      expect(result.session.getToolDefinition('codemode')).toBeUndefined()
    } finally {
      await result.dispose()
      result.session.dispose()
    }
  })

  test('an unrestricted session registers codemode when explicitly enabled', async () => {
    const result = await createSessionWithDispose({
      origin: { kind: 'tui', sessionId: 'test' },
      tools: ['bash', 'read'],
      customTools: [],
    })
    try {
      expect(result.session.getActiveToolNames()).toContain('codemode')
      expect(result.session.getToolDefinition('codemode')).toBeDefined()
    } finally {
      await result.dispose()
      result.session.dispose()
    }
  })

  test('a session without active bash does not register codemode', async () => {
    const result = await createSessionWithDispose({
      origin: { kind: 'tui', sessionId: 'test' },
      tools: ['read'],
      customTools: [],
    })
    try {
      expect(result.session.getToolDefinition('codemode')).toBeUndefined()
    } finally {
      await result.dispose()
      result.session.dispose()
    }
  })
})
