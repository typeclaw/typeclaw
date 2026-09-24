import { describe, expect, test, afterEach, beforeEach } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type CredentialStore, type Credential } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

import { refreshProviderOAuthCredentials, refreshProviderOAuthForAgent } from './refresh-provider-oauth'

describe('refreshProviderOAuthCredentials', () => {
  test('probes only stored OAuth credentials and isolates failures', async () => {
    const calls: string[] = []
    const credentials: CredentialStore = {
      read: async () => undefined,
      list: async () => [
        { providerId: 'good', type: 'oauth' },
        { providerId: 'bad', type: 'oauth' },
        { providerId: 'key', type: 'api_key' },
      ],
      modify: async () => undefined,
      delete: async () => {},
    }
    const modelRuntime = {
      getAuth: async (providerId: string) => {
        calls.push(providerId)
        if (providerId === 'bad') throw new Error('refresh failed')
        return { auth: { apiKey: 'fresh' } }
      },
    } as unknown as ModelRuntime
    const result = await refreshProviderOAuthCredentials({ credentials, modelRuntime })
    expect(calls).toEqual(['good', 'bad'])
    expect(result.entries).toEqual([
      { providerId: 'good', outcome: 'valid-or-refreshed' },
      { providerId: 'bad', outcome: 'refresh-failed', error: 'refresh failed' },
    ])
  })
})

const future = () => Date.now() + 3_600_000
const past = () => Date.now() - 1

function credentials(initial: Record<string, Credential>): CredentialStore {
  const values = new Map(Object.entries(initial))
  return {
    read: async (id) => values.get(id),
    list: async () => [...values].map(([providerId, credential]) => ({ providerId, type: credential.type })),
    modify: async (id, fn) => {
      const next = await fn(values.get(id))
      if (next) values.set(id, next)
      return values.get(id)
    },
    delete: async (id) => {
      values.delete(id)
    },
  }
}

async function runtime(
  store: CredentialStore,
  refreshToken: (credential: { refresh: string }) => Promise<{ access: string; refresh: string; expires: number }>,
) {
  const modelRuntime = await ModelRuntime.create({ credentials: store, modelsPath: null, refreshOnCreate: false })
  modelRuntime.registerProvider('stub', {
    baseUrl: 'https://example.test',
    oauth: {
      name: 'stub',
      login: async () => ({ access: 'unused', refresh: 'unused', expires: future() }),
      refreshToken: async (credential) => refreshToken(credential),
      getApiKey: (credential) => credential.access,
    },
  })
  return modelRuntime
}

describe('refreshProviderOAuthCredentials outcomes', () => {
  test('no OAuth entries produces no work', async () => {
    const store = credentials({ key: { type: 'api_key', key: 'key' } })
    const result = await refreshProviderOAuthCredentials({
      credentials: store,
      modelRuntime: await runtime(store, async () => {
        throw new Error('unused')
      }),
    })
    expect(result.entries).toEqual([])
  })

  test('valid token does not refresh and expired token refreshes and persists', async () => {
    let calls = 0
    const store = credentials({ stub: { type: 'oauth', access: 'old', refresh: 'r', expires: future() } })
    const modelRuntime = await runtime(store, async (credential) => {
      calls++
      return { access: 'new', refresh: credential.refresh, expires: future() }
    })
    expect((await refreshProviderOAuthCredentials({ credentials: store, modelRuntime })).entries).toEqual([
      { providerId: 'stub', outcome: 'valid-or-refreshed' },
    ])
    expect(calls).toBe(0)
    await store.modify('stub', async () => ({ type: 'oauth', access: 'old', refresh: 'r', expires: past() }))
    expect((await refreshProviderOAuthCredentials({ credentials: store, modelRuntime })).entries).toEqual([
      { providerId: 'stub', outcome: 'valid-or-refreshed' },
    ])
    expect(calls).toBe(1)
    expect(await store.read('stub')).toMatchObject({ access: 'new' })
  })

  test('refresh failure is surfaced without stopping later entries', async () => {
    const store = credentials({
      stub: { type: 'oauth', access: 'old', refresh: 'r', expires: past() },
      unknown: { type: 'oauth', access: 'old', refresh: 'r', expires: past() },
    })
    const modelRuntime = await runtime(store, async () => {
      throw new Error('token endpoint failed')
    })
    const result = await refreshProviderOAuthCredentials({ credentials: store, modelRuntime })
    expect(result.entries).toHaveLength(2)
    expect(result.entries.every((entry) => entry.outcome === 'refresh-failed' && entry.error)).toBe(true)
    expect(result.entries[0]!.error).toContain('token endpoint failed')
    expect(result.entries[1]!.error).not.toContain('token endpoint failed')
  })
})

describe('refreshProviderOAuthForAgent failures', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'typeclaw-refresh-'))
  })
  afterEach(async () => rm(dir, { recursive: true, force: true }))

  test('logs malformed secrets and preserves non-fatal boot behavior', async () => {
    await writeFile(join(dir, 'secrets.json'), '{broken')
    const logs: string[] = []
    await expect(
      refreshProviderOAuthForAgent({ agentDir: dir, log: (message) => logs.push(message) }),
    ).resolves.toEqual({
      entries: [],
    })
    expect(logs.join('\\n')).toContain('not valid JSON')
  })
})

describe('built-in xAI OAuth compatibility', () => {
  let dir: string
  let fetchBefore: typeof fetch

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'typeclaw-xai-'))
    fetchBefore = globalThis.fetch
  })
  afterEach(async () => {
    globalThis.fetch = fetchBefore
    await rm(dir, { recursive: true, force: true })
  })

  test('refreshes legacy xAI credential records with the same client and preserves an unrotated refresh token', async () => {
    await writeFile(
      join(dir, 'secrets.json'),
      JSON.stringify({
        version: 2,
        providers: { xai: { type: 'oauth', access: 'old', refresh: 'legacy-refresh', expires: Date.now() - 1000 } },
        channels: {},
      }),
    )
    const requests: Array<{ url: string; body: string }> = []
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: String(url), body: String(init?.body) })
      return new Response(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }), { status: 200 })
    }) as typeof fetch

    const result = await refreshProviderOAuthForAgent({ agentDir: dir })
    expect(result.entries).toEqual([{ providerId: 'xai', outcome: 'valid-or-refreshed' }])
    expect(requests).toEqual([
      { url: 'https://auth.x.ai/oauth2/token', body: expect.stringContaining('grant_type=refresh_token') },
    ])
    expect(requests[0]!.body).toContain('client_id=b1a00492-073a-47ea-816f-4c329264a828')
    expect(requests[0]!.body).toContain('refresh_token=legacy-refresh')
    const stored = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8')).providers.xai
    expect(stored).toMatchObject({ access: 'new-access', refresh: 'legacy-refresh' })
  })
})
