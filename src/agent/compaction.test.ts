import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AssistantMessage, Model, UserMessage } from '@earendil-works/pi-ai'
import { SessionManager } from '@earendil-works/pi-coding-agent'

import { resolveModel } from '@/config'
import { __resetConfigForTesting, configSchema, reloadConfig } from '@/config/config'

import { invalidateProviderAuthCache } from './auth'
import {
  COMPACTION_ABSOLUTE_TRIGGER_TOKENS,
  COMPACTION_KEEP_RECENT_TOKENS,
  COMPACTION_TRIGGER_PERCENT,
  compactionTriggerTokens,
  createCompactionSettingsManager,
  reserveTokensForModel,
} from './compaction'
import { createSessionWithDispose } from './index'

function fakeModel(contextWindow: number): Model<'openai-completions'> {
  return {
    id: 'fake',
    name: 'Fake',
    api: 'openai-completions',
    provider: 'fake',
    baseUrl: 'https://example',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: contextWindow,
  } as unknown as Model<'openai-completions'>
}

describe('compactionTriggerTokens', () => {
  test('small windows keep the 80% window-relative trigger', () => {
    // given: a window whose 80% sits below the absolute cap
    const window = 64_000
    const model = fakeModel(window)

    // when
    const trigger = compactionTriggerTokens(model)

    // then
    expect(trigger).toBe(Math.round(window * COMPACTION_TRIGGER_PERCENT))
    expect(trigger).toBe(51_200)
  })

  test('large windows cap the trigger at the absolute budget instead of 80%', () => {
    // given: 80% of 1.05M (840_000) is well above the absolute cap
    const model = fakeModel(1_050_000)

    // when
    const trigger = compactionTriggerTokens(model)

    // then
    expect(trigger).toBe(COMPACTION_ABSOLUTE_TRIGGER_TOKENS)
  })

  test('a configured ceiling replaces the absolute cap on large windows', () => {
    // given: 80% of 1M (800_000) sits above the configured 160K ceiling
    const model = fakeModel(1_000_000)

    // when
    const trigger = compactionTriggerTokens(model, 160_000)

    // then
    expect(trigger).toBe(160_000)
  })

  test('a configured ceiling never delays compaction past 80% of a small window', () => {
    // given: 80% of 128K (102_400) sits below the configured 160K ceiling
    const model = fakeModel(128_000)

    // when
    const trigger = compactionTriggerTokens(model, 160_000)

    // then
    expect(trigger).toBe(102_400)
  })
})

describe('reserveTokensForModel', () => {
  test('derives reserve as window minus the (capped) trigger', () => {
    // given
    const model = fakeModel(1_050_000)

    // when
    const reserve = reserveTokensForModel(model)

    // then: 1.05M - 200K cap = 850K reserved, so compaction fires at 200K not 80%
    expect(reserve).toBe(1_050_000 - COMPACTION_ABSOLUTE_TRIGGER_TOKENS)
    expect(reserve).toBe(850_000)
  })

  test('clamps to at least 1 so a degenerate zero-window model never produces a non-positive reserve', () => {
    // given
    const broken = fakeModel(0)

    // when
    const reserve = reserveTokensForModel(broken)

    // then
    expect(reserve).toBeGreaterThanOrEqual(1)
  })
})

describe('compaction budget invariant', () => {
  test('absolute trigger stays >=3x the recent-window floor to avoid thrashing', () => {
    // a trigger too close to keepRecent would re-compact almost immediately
    // after each compaction; keep headroom so a compacted session can grow
    expect(COMPACTION_ABSOLUTE_TRIGGER_TOKENS).toBeGreaterThanOrEqual(COMPACTION_KEEP_RECENT_TOKENS * 3)
  })

  test('a configured ceiling below 3x the recent window is rejected at parse time', () => {
    expect(
      configSchema.safeParse({ compaction: { maxTriggerTokens: COMPACTION_KEEP_RECENT_TOKENS * 3 } }).success,
    ).toBe(true)
    expect(
      configSchema.safeParse({ compaction: { maxTriggerTokens: COMPACTION_KEEP_RECENT_TOKENS * 3 - 1 } }).success,
    ).toBe(false)
  })
})

describe('createCompactionSettingsManager', () => {
  test('produces a SettingsManager whose getCompactionSettings() reflects our chosen values', () => {
    // given
    const model = fakeModel(256_000)

    // when
    const settings = createCompactionSettingsManager(model).getCompactionSettings()

    // then
    expect(settings.enabled).toBe(true)
    expect(settings.reserveTokens).toBe(reserveTokensForModel(model))
    expect(settings.keepRecentTokens).toBe(COMPACTION_KEEP_RECENT_TOKENS)
  })

  test('different-window models reserve different amounts but keep the same recent window', () => {
    // given
    const a = fakeModel(200_000)
    const b = fakeModel(1_000_000)

    // when
    const sa = createCompactionSettingsManager(a).getCompactionSettings()
    const sb = createCompactionSettingsManager(b).getCompactionSettings()

    // then
    expect(sa.reserveTokens).not.toBe(sb.reserveTokens)
    expect(sa.keepRecentTokens).toBe(sb.keepRecentTokens)
  })
})

describe('compaction request thinking', () => {
  let agentDir: string
  let previousCwd: string
  let previousNodeEnv: string | undefined
  let previousAnthropicApiKey: string | undefined
  let previousFetch: typeof fetch

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-compaction-'))
    previousCwd = process.cwd()
    previousNodeEnv = process.env.NODE_ENV
    previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    previousFetch = globalThis.fetch
    process.chdir(agentDir)
    process.env.NODE_ENV = 'test'
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    invalidateProviderAuthCache()
  })

  afterEach(async () => {
    globalThis.fetch = previousFetch
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey
    invalidateProviderAuthCache()
    __resetConfigForTesting()
    process.chdir(previousCwd)
    await rm(agentDir, { recursive: true, force: true })
  })

  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }

  function seedHistory(sessionManager: SessionManager, model: string): void {
    for (let turn = 0; turn < 8; turn += 1) {
      const text = `turn-${turn} ${'history '.repeat(2_500)}`
      const timestamp = turn * 2
      const user: UserMessage = { role: 'user', content: [{ type: 'text', text }], timestamp }
      const assistant: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text }],
        api: 'anthropic-messages',
        provider: 'anthropic',
        model,
        usage,
        stopReason: 'stop',
        timestamp: timestamp + 1,
      }
      sessionManager.appendMessage(user)
      sessionManager.appendMessage(assistant)
    }
  }

  // pi-ai's compaction path calls completeSimple (pi-coding-agent
  // dist/core/compaction/compaction.js:477-487), where forceAdaptiveThinking
  // selects adaptive rather than rejected budget thinking
  // (pi-ai dist/api/anthropic-messages.js). Capture the real request
  // so this catalog compatibility contract cannot regress silently.
  //
  // The same request must also stay within the model's output limit. Our
  // absolute trigger sets reserveTokens to nearly the whole window; on pi
  // 0.73.1 the summary budget was 0.8 x reserveTokens, which sent
  // max_tokens=748800 for Sonnet 4.6, whose limit is 64K. Since pi 1.4 the
  // summary ignores reserveTokens and uses the model's output limit
  // (generateSummaryWithUsage in compaction.js, pi #9512).
  test.each([
    ['anthropic/claude-sonnet-4-6', false],
    ['anthropic/claude-sonnet-5', false],
    ['anthropic/claude-opus-5-5', true],
  ])('compacts %s with adaptive thinking inside its output limit', async (ref, requiresBindingControls) => {
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({ models: { default: { model: ref, thinkingLevel: 'high' } } }),
    )
    reloadConfig(agentDir)

    const sessionManager = SessionManager.inMemory(agentDir)
    seedHistory(sessionManager, ref.split('/')[1]!)
    const { session, dispose } = await createSessionWithDispose({
      sessionManager,
      systemPromptOverride: 'test compaction request',
      tools: [],
    })
    let request: { body: Record<string, unknown>; headers: Headers } | undefined
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const captured = new Request(input, init)
      request = {
        body: (await captured.json()) as Record<string, unknown>,
        headers: captured.headers,
      }
      return new Response('{"error":{"message":"compaction probe"}}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    try {
      await expect(session.compact()).rejects.toThrow(/compaction probe/)
      expect(request).toBeDefined()
      expect(request!.body.thinking).toMatchObject({ type: 'adaptive' })
      expect(request!.body.thinking).not.toMatchObject({ type: 'enabled' })
      expect(request!.body.thinking).not.toMatchObject({ type: 'disabled' })
      expect(request!.body.thinking).not.toHaveProperty('budget_tokens')
      const record = resolveModel(ref)
      expect(request!.body.max_tokens).toBeLessThanOrEqual(record.maxTokens)
      if (requiresBindingControls) {
        expect(request!.body.thinking).toMatchObject({
          block_binding: { prefix_mismatch_behavior: 'drop_block' },
        })
        expect(request!.headers.get('anthropic-beta')).toContain('thinking-binding-controls-2026-08-01')
      }
    } finally {
      globalThis.fetch = previousFetch
      await dispose()
    }
  })

  // The channel router keeps its terminal-reply stop and output cap away from
  // compaction by checking `session.isCompacting` inside `agent.streamFunction`
  // (src/channels/router.ts installChannelOutputCap). That only works if pi
  // routes the summary request through `agent.streamFunction` while the flag
  // is set, so pin both halves on a real session.
  test('routes the summary request through agent.streamFunction while isCompacting', async () => {
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({ models: { default: 'anthropic/claude-sonnet-5' } }),
    )
    reloadConfig(agentDir)
    const sessionManager = SessionManager.inMemory(agentDir)
    seedHistory(sessionManager, 'claude-sonnet-5')
    const { session, dispose } = await createSessionWithDispose({
      sessionManager,
      systemPromptOverride: 'test compaction request',
      tools: [],
    })
    const inner = session.agent.streamFunction
    const compactingAtCall: boolean[] = []
    session.agent.streamFunction = (model, context, options) => {
      compactingAtCall.push(session.isCompacting)
      return inner(model, context, options)
    }
    globalThis.fetch = (async () =>
      new Response('{"error":{"message":"compaction probe"}}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

    try {
      await expect(session.compact()).rejects.toThrow(/compaction probe/)
      expect(compactingAtCall.length).toBeGreaterThan(0)
      expect(compactingAtCall.every(Boolean)).toBe(true)
    } finally {
      globalThis.fetch = previousFetch
      await dispose()
    }
  })

  test('typeclaw.json compaction.maxTriggerTokens sets the created session compaction reserve', async () => {
    const ref = 'anthropic/claude-sonnet-5'
    const window = resolveModel(ref).contextWindow
    const reserveFor = async (config: Record<string, unknown>): Promise<number> => {
      await writeFile(join(agentDir, 'typeclaw.json'), JSON.stringify({ models: { default: ref }, ...config }))
      reloadConfig(agentDir)
      const { session, dispose } = await createSessionWithDispose({
        sessionManager: SessionManager.inMemory(agentDir),
        systemPromptOverride: 'test compaction budget',
        tools: [],
      })
      try {
        return session.settingsManager.getCompactionSettings().reserveTokens
      } finally {
        await dispose()
      }
    }

    const defaultReserve = await reserveFor({})
    const configuredReserve = await reserveFor({ compaction: { maxTriggerTokens: 300_000 } })

    expect(defaultReserve).toBe(window - Math.min(Math.round(window * 0.8), COMPACTION_ABSOLUTE_TRIGGER_TOKENS))
    expect(configuredReserve).toBe(window - Math.min(Math.round(window * 0.8), 300_000))
    expect(configuredReserve).toBeLessThan(defaultReserve)
  })
})
