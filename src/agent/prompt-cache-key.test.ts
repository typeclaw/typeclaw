import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeContext } from '@earendil-works/pi-ai'
import { SessionManager } from '@earendil-works/pi-coding-agent'

import { __resetConfigForTesting, reloadConfig } from '@/config/config'

import { invalidateProviderAuthCache } from './auth'
import { createSessionWithDispose } from './index'
import { promptCacheKeyForOrigin, sharedSessionIdForOrigin, withPromptCacheKey } from './prompt-cache-key'
import type { SessionOrigin } from './session-origin'

describe('promptCacheKeyForOrigin', () => {
  test('keys subagents and system components by name, other origins by kind', () => {
    expect(promptCacheKeyForOrigin({ kind: 'subagent', subagent: 'memory-logger', parentSessionId: 'parent-a' })).toBe(
      'typeclaw:subagent:memory-logger',
    )
    expect(promptCacheKeyForOrigin({ kind: 'system', component: 'backup' })).toBe('typeclaw:system:backup')
    expect(promptCacheKeyForOrigin({ kind: 'cron', jobId: 'daily', jobKind: 'prompt' })).toBe('typeclaw:cron')
    expect(promptCacheKeyForOrigin({ kind: 'tui', sessionId: 'tui-1' })).toBe('typeclaw:tui')
    expect(promptCacheKeyForOrigin(undefined)).toBeUndefined()
  })

  test('bounds keys from long names to the 64 code points OpenAI accepts', () => {
    const key = promptCacheKeyForOrigin({ kind: 'subagent', subagent: '확'.repeat(80), parentSessionId: 'p' })

    expect(Array.from(key!)).toHaveLength(64)
    expect(key!.startsWith('typeclaw:subagent:확')).toBe(true)
  })
})

describe('sharedSessionIdForOrigin', () => {
  test('short-lived sessions share their origin key as the session id', () => {
    const subagent: SessionOrigin = { kind: 'subagent', subagent: 'explorer', parentSessionId: 'parent-a' }

    expect(sharedSessionIdForOrigin(subagent)).toBe('typeclaw:subagent:explorer')
    expect(sharedSessionIdForOrigin({ kind: 'system', component: 'backup' })).toBe('typeclaw:system:backup')
  })

  test('long-lived sessions keep their own session id', () => {
    const channel = { kind: 'channel', adapter: 'slack', workspace: 'T1', channel: 'C1' } as unknown as SessionOrigin

    expect(sharedSessionIdForOrigin(channel)).toBeUndefined()
    expect(sharedSessionIdForOrigin({ kind: 'tui', sessionId: 'tui-1' })).toBeUndefined()
    expect(sharedSessionIdForOrigin(undefined)).toBeUndefined()
  })

  test('each fire of one cron job shares that job session id', () => {
    expect(sharedSessionIdForOrigin({ kind: 'cron', jobId: 'daily', jobKind: 'prompt' })).toBe('typeclaw:cron:daily')
    expect(sharedSessionIdForOrigin({ kind: 'cron', jobId: '아침', jobKind: 'prompt' })).toBe(
      'typeclaw:cron:%EC%95%84%EC%B9%A8',
    )
  })
})

describe('withPromptCacheKey', () => {
  test('replaces an existing string key and leaves other payloads alone', () => {
    expect(withPromptCacheKey({ model: 'm', prompt_cache_key: 'session-1' }, 'k')).toEqual({
      model: 'm',
      prompt_cache_key: 'k',
    })
    const withoutKey = { model: 'm' }
    expect(withPromptCacheKey(withoutKey, 'k')).toBe(withoutKey)
    const optedOut = { model: 'm', prompt_cache_key: undefined }
    expect(withPromptCacheKey(optedOut, 'k')).toBe(optedOut)
  })
})

describe('session requests', () => {
  let agentDir: string
  const previousCwd = process.cwd()
  const previousFetch = globalThis.fetch
  const previousOpenAiKey = process.env.OPENAI_API_KEY

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-prompt-cache-key-'))
    process.chdir(agentDir)
    await writeFile(join(agentDir, 'typeclaw.json'), JSON.stringify({ models: { default: 'openai/gpt-4o-mini' } }))
    reloadConfig(agentDir)
    process.env.OPENAI_API_KEY = 'test-openai-key'
    invalidateProviderAuthCache()
  })

  afterEach(async () => {
    globalThis.fetch = previousFetch
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousOpenAiKey
    invalidateProviderAuthCache()
    __resetConfigForTesting()
    process.chdir(previousCwd)
    await rm(agentDir, { recursive: true, force: true })
  })

  // A JWT whose claims carry the account id pi's Codex transport extracts.
  const codexApiKey = `e30.${btoa(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct' } }))}.sig`

  async function capturePromptCacheKey(
    origin: SessionOrigin | undefined,
    provider: {
      model?: string
      secrets?: unknown
      affinityHeader?: string
      streamOptions?: Record<string, unknown>
    } = {},
  ): Promise<{ key: unknown; affinity: string | null; sessionId: string }> {
    if (provider.model !== undefined) {
      await writeFile(join(agentDir, 'typeclaw.json'), JSON.stringify({ models: { default: provider.model } }))
      reloadConfig(agentDir)
    }
    if (provider.secrets !== undefined) {
      await writeFile(join(agentDir, 'secrets.json'), JSON.stringify(provider.secrets))
      invalidateProviderAuthCache()
    }
    const sessionManager = SessionManager.inMemory(agentDir)
    const { session, dispose } = await createSessionWithDispose({
      sessionManager,
      systemPromptOverride: 'prompt cache key probe',
      tools: [],
      ...(origin ? { origin } : {}),
    })
    let body: Record<string, unknown> | undefined
    let affinity: string | null = null
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      // pi's OpenAI Responses client sends the stream sessionId as x-client-request-id.
      affinity = request.headers.get(provider.affinityHeader ?? 'x-client-request-id')
      const raw = new Uint8Array(await request.arrayBuffer())
      // pi's Codex transport zstd-compresses the request body.
      const json = request.headers.get('content-encoding') === 'zstd' ? Bun.zstdDecompressSync(raw) : raw
      body = JSON.parse(new TextDecoder().decode(json)) as Record<string, unknown>
      return new Response('{"error":{"message":"cache key probe"}}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const stream = await session.agent.streamFunction(
        session.model!,
        normalizeContext({
          systemPrompt: 'probe',
          messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
          tools: [],
        }),
        { sessionId: session.sessionId, ...provider.streamOptions },
      )
      await stream.result()
      return { key: body?.prompt_cache_key, affinity, sessionId: session.sessionId }
    } finally {
      globalThis.fetch = previousFetch
      await dispose()
    }
  }

  test('sessions of the same subagent share one prompt cache key across parents', async () => {
    // given two memory-logger sessions spawned by different parents
    const first = await capturePromptCacheKey({ kind: 'subagent', subagent: 'memory-logger', parentSessionId: 'a' })
    const second = await capturePromptCacheKey({ kind: 'subagent', subagent: 'memory-logger', parentSessionId: 'b' })

    // then both requests carry the shared key and session affinity instead of their own session ids
    expect(first.sessionId).not.toBe(second.sessionId)
    expect(first.key).toBe('typeclaw:subagent:memory-logger')
    expect(second.key).toBe('typeclaw:subagent:memory-logger')
    expect(first.affinity).toBe('typeclaw:subagent:memory-logger')
    expect(second.affinity).toBe('typeclaw:subagent:memory-logger')
  })

  test('codex subagent sessions share the session-id header and body key', async () => {
    const codex = {
      model: 'openai-codex/gpt-6-luna',
      secrets: {
        version: 2,
        providers: {
          'openai-codex': { type: 'oauth', access: codexApiKey, refresh: 'r', expires: Date.now() + 3_600_000 },
        },
      },
      affinityHeader: 'session-id',
      streamOptions: { transport: 'sse' },
    }
    const first = await capturePromptCacheKey({ kind: 'subagent', subagent: 'explorer', parentSessionId: 'a' }, codex)
    const second = await capturePromptCacheKey({ kind: 'subagent', subagent: 'explorer', parentSessionId: 'b' }, codex)

    expect(first.affinity).toBe('typeclaw:subagent:explorer')
    expect(second.affinity).toBe('typeclaw:subagent:explorer')
    expect(first.key).toBe('typeclaw:subagent:explorer')
    expect(second.key).toBe('typeclaw:subagent:explorer')
  })

  test('a non-Latin subagent name still yields a sendable session affinity header', async () => {
    const probe = await capturePromptCacheKey({ kind: 'subagent', subagent: '요약', parentSessionId: 'a' })

    expect(probe.affinity).toBe('typeclaw:subagent:%EC%9A%94%EC%95%BD')
    expect(probe.key).toBe('typeclaw:subagent:요약')
  })

  test('a long-lived session shares its body key but keeps its own session affinity', async () => {
    const probe = await capturePromptCacheKey({ kind: 'tui', sessionId: 'tui-1' })

    expect(probe.key).toBe('typeclaw:tui')
    expect(probe.affinity).toBe(probe.sessionId)
  })

  test('sessions without an origin keep the session-id key', async () => {
    const probe = await capturePromptCacheKey(undefined)

    expect(probe.key).toBe(probe.sessionId)
  })
})
