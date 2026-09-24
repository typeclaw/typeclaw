import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveModel } from '@/config'
import { __resetConfigForTesting, reloadConfig } from '@/config/config'
import { KNOWN_PROVIDERS, supportsApiKey } from '@/config/providers'

import { getAuthFor, invalidateProviderAuthCache } from './auth'

describe('getAuthFor', () => {
  const priorEnv: Record<string, string | undefined> = {}
  const priorNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    invalidateProviderAuthCache()
    for (const provider of Object.values(KNOWN_PROVIDERS)) {
      if (!provider.apiKeyEnv) continue
      priorEnv[provider.apiKeyEnv] = process.env[provider.apiKeyEnv]
      delete process.env[provider.apiKeyEnv]
    }
  })

  afterEach(() => {
    for (const [name, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = priorNodeEnv
    invalidateProviderAuthCache()
  })

  test('resolves every API-key provider from its canonical env key', async () => {
    for (const provider of Object.values(KNOWN_PROVIDERS)) {
      if (!supportsApiKey(provider) || !provider.apiKeyEnv) continue
      const key = `test-${provider.id}`
      process.env[provider.apiKeyEnv] = key
      const { modelRuntime } = await getAuthFor(provider.id)
      const modelId = Object.keys(provider.models)[0]!
      const auth = await modelRuntime.getAuth(resolveModel(`${provider.id}/${modelId}`))
      expect(auth?.auth.apiKey).toBe(key)
    }
  })

  test('shares one in-flight ModelRuntime per provider', async () => {
    process.env.OPENAI_API_KEY = 'test-openai'
    const first = getAuthFor('openai')
    expect(getAuthFor('openai')).toBe(first)
    expect((await first).modelRuntime).toBe((await getAuthFor('openai')).modelRuntime)
  })

  // pi 0.87 dispatches through the PROVIDER's transport, not `model.api`. A
  // built-in provider whose transport differs from typeclaw's record (MiniMax is
  // Anthropic Messages upstream, openai-completions here) would otherwise send
  // every request to the wrong endpoint shape.
  test('routes every curated API-key model to the endpoint its record declares', async () => {
    const endpoint: Record<string, string> = {
      'openai-completions': '/chat/completions',
      'openai-responses': '/responses',
      'anthropic-messages': '/messages',
    }
    const originalFetch = globalThis.fetch
    let requested: string | undefined
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested = input instanceof Request ? input.url : String(input)
      return new Response('{"error":{"message":"routing probe"}}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      for (const provider of Object.values(KNOWN_PROVIDERS)) {
        if (!supportsApiKey(provider) || !provider.apiKeyEnv) continue
        process.env[provider.apiKeyEnv] = `test-${provider.id}`
        const { modelRuntime } = await getAuthFor(provider.id)
        for (const modelId of Object.keys(provider.models)) {
          const model = resolveModel(`${provider.id}/${modelId}`)
          requested = undefined
          const stream = modelRuntime.streamSimple(model, {
            messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }], timestamp: 0 }],
          })
          for await (const _event of stream) {
            if (requested !== undefined) break
          }
          const url = new URL(requested ?? 'about:blank')
          expect({ ref: `${provider.id}/${modelId}`, url: `${url.origin}${url.pathname}` }).toEqual({
            ref: `${provider.id}/${modelId}`,
            url: expect.stringMatching(
              new RegExp(`^${model.baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*${endpoint[model.api]}$`),
            ),
          })
        }
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('initial-provider runtime resolves a typeclaw-only fallback provider', async () => {
    process.env.OPENAI_API_KEY = 'openai-key'
    process.env.UPSTAGE_API_KEY = 'upstage-key'
    const { modelRuntime } = await getAuthFor('openai')
    const fallbackId = Object.keys(KNOWN_PROVIDERS.upstage.models)[0]!
    expect((await modelRuntime.getAuth(resolveModel(`upstage/${fallbackId}`)))?.auth.apiKey).toBe('upstage-key')
  })
})

describe('ModelRuntime credential resolution regressions', () => {
  let cwd: string
  let previousCwd: string
  let previousNodeEnv: string | undefined
  let previousFireworks: string | undefined
  let previousXai: string | undefined

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-auth-runtime-'))
    previousCwd = process.cwd()
    previousNodeEnv = process.env.NODE_ENV
    previousFireworks = process.env.FIREWORKS_API_KEY
    previousXai = process.env.XAI_API_KEY
    process.chdir(cwd)
    delete process.env.FIREWORKS_API_KEY
    delete process.env.XAI_API_KEY
    invalidateProviderAuthCache()
    await writeFile(
      join(cwd, 'typeclaw.json'),
      JSON.stringify({ models: { default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' } }),
    )
    reloadConfig(cwd)
  })

  afterEach(async () => {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousFireworks === undefined) delete process.env.FIREWORKS_API_KEY
    else process.env.FIREWORKS_API_KEY = previousFireworks
    if (previousXai === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = previousXai
    invalidateProviderAuthCache()
    __resetConfigForTesting()
    process.chdir(previousCwd)
    await rm(cwd, { recursive: true, force: true })
  })

  test('env wins over disk without persisting its value or changing .env', async () => {
    await writeFile(
      join(cwd, 'secrets.json'),
      JSON.stringify({
        version: 2,
        providers: { fireworks: { type: 'api_key', key: { value: 'disk' } } },
        channels: {},
      }),
    )
    const envFile = 'FIREWORKS_API_KEY=runtime\nUNRELATED=keep\n'
    delete process.env.ZAI_API_KEY
    delete process.env.ZAI_CODING_API_KEY
    await writeFile(join(cwd, '.env'), envFile)
    process.env.FIREWORKS_API_KEY = 'runtime'
    const { modelRuntime } = await getAuthFor('fireworks')
    expect(
      (await modelRuntime.getAuth(resolveModel('fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')))?.auth.apiKey,
    ).toBe('runtime')
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe(envFile)
    expect(JSON.parse(await readFile(join(cwd, 'secrets.json'), 'utf8')).providers.fireworks.key.value).toBe('disk')
  })

  test('uses disk when env is unset', async () => {
    process.env.NODE_ENV = 'production'
    await writeFile(
      join(cwd, 'secrets.json'),
      JSON.stringify({
        version: 2,
        providers: { fireworks: { type: 'api_key', key: { value: 'disk' } } },
        channels: {},
      }),
    )
    const { modelRuntime } = await getAuthFor('fireworks')
    expect((await modelRuntime.getAuth('fireworks'))?.auth.apiKey).toBe('disk')
  })

  test('persisted xAI OAuth takes precedence over XAI_API_KEY', async () => {
    await writeFile(
      join(cwd, 'secrets.json'),
      JSON.stringify({
        version: 2,
        providers: {
          xai: { type: 'oauth', access: 'oauth-access', refresh: 'refresh', expires: Date.now() + 3600000 },
        },
        channels: {},
      }),
    )
    process.env.XAI_API_KEY = 'env-key'
    const { modelRuntime } = await getAuthFor('xai')
    expect((await modelRuntime.getAuth('xai'))?.auth.apiKey).toBe('oauth-access')
    expect(JSON.parse(await readFile(join(cwd, 'secrets.json'), 'utf8')).providers.xai.access).toBe('oauth-access')
  })

  test('uses the NODE_ENV=test dummy only when no environment credential exists', async () => {
    process.env.NODE_ENV = 'test'
    const { modelRuntime } = await getAuthFor('fireworks')
    expect((await modelRuntime.getAuth('fireworks'))?.auth.apiKey).toBe('test_dummy_key')
    expect(existsSync(join(cwd, 'secrets.json'))).toBe(false)
  })
  test('provider-scoped environment keys and runtime caches are isolated', async () => {
    process.env.ZAI_API_KEY = 'paygo'
    process.env.ZAI_CODING_API_KEY = 'coding'
    const zai = await getAuthFor('zai')
    const coding = await getAuthFor('zai-coding')
    expect((await zai.modelRuntime.getAuth('zai'))?.auth.apiKey).toBe('paygo')
    expect((await coding.modelRuntime.getAuth('zai-coding'))?.auth.apiKey).toBe('coding')
    expect(zai.modelRuntime).not.toBe(coding.modelRuntime)
  })

  // A reload (invalidateProviderAuthCache) can land while a creation is in
  // flight. If that stale creation then fails, it must not evict the runtime a
  // later caller already cached, or the next caller builds a second runtime
  // that refreshes the same OAuth credential independently.
  test('a stale failed creation does not evict the runtime cached after a reload', async () => {
    process.env.FIREWORKS_API_KEY = 'runtime'
    const healthyDir = await mkdtemp(join(tmpdir(), 'typeclaw-auth-healthy-'))
    await writeFile(join(cwd, 'secrets.json'), '{ not json')
    try {
      // The secrets path is captured from cwd synchronously at creation, so
      // the stale creation reads the corrupt file and the next one does not.
      const stale = getAuthFor('fireworks')
      const staleOutcome = stale.then(
        () => undefined,
        (error: unknown) => error,
      )
      invalidateProviderAuthCache()
      process.chdir(healthyDir)
      const current = getAuthFor('fireworks')
      expect(await staleOutcome).toBeInstanceOf(Error)
      await current
      expect(getAuthFor('fireworks')).toBe(current)
    } finally {
      process.chdir(cwd)
      await rm(healthyDir, { recursive: true, force: true })
    }
  })
})
