import { describe, expect, test } from 'bun:test'

import { supportsApiKey } from '@/config/providers'
import { KNOWN_PROVIDERS, type KnownProviderId } from '@/config/providers'

import { API_KEY_DASHBOARD_URL, providersWithApiKeyProbe, validateApiKey, type FetchFn } from './validate-api-key'

function fakeFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>): FetchFn {
  return async (url, init) => responder(url, init)
}

const okBody = '{"data":[{"id":"m"}]}'

describe('validateApiKey', () => {
  test('returns ok when the provider accepts the key and returns the expected JSON shape', async () => {
    const result = await validateApiKey(
      'openai',
      'sk-test',
      fakeFetch((url, init) => {
        expect(url).toBe('https://api.openai.com/v1/models')
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
        expect(init.redirect).toBe('manual')
        return new Response(okBody, { status: 200 })
      }),
    )
    expect(result).toEqual({ kind: 'ok' })
  })

  test('probes the minimax /v1/models endpoint with a Bearer header', async () => {
    const result = await validateApiKey(
      'minimax',
      'mm-test',
      fakeFetch((url, init) => {
        expect(url).toBe('https://api.minimax.io/v1/models')
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer mm-test')
        return new Response(okBody, { status: 200 })
      }),
    )
    expect(result).toEqual({ kind: 'ok' })
  })

  test('accepts a minimax Token Plan subscription key (sk-cp-) through the same probe', async () => {
    const result = await validateApiKey(
      'minimax',
      'sk-cp-subscription',
      fakeFetch((url, init) => {
        expect(url).toBe('https://api.minimax.io/v1/models')
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-cp-subscription')
        return new Response(okBody, { status: 200 })
      }),
    )
    expect(result).toEqual({ kind: 'ok' })
  })

  test('returns rejected on 401 without leaking the response body', async () => {
    const result = await validateApiKey(
      'openai',
      'bad-key',
      fakeFetch(() => new Response('{"error":"invalid"}', { status: 401 })),
    )
    expect(result).toEqual({ kind: 'rejected', status: 401 })
  })

  test('accepts a Fireworks Fire Pass key whose 403 body carries the FORBIDDEN/Fire Pass marker', async () => {
    const firePassBody = JSON.stringify({
      error: {
        message: 'Fire Pass API keys are not authorized for this route.',
        code: 'FORBIDDEN',
        type: 'error',
      },
    })
    const result = await validateApiKey(
      'fireworks',
      'fpk_test',
      fakeFetch((url, init) => {
        expect(url).toBe('https://api.fireworks.ai/inference/v1/models')
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer fpk_test')
        return new Response(firePassBody, { status: 403 })
      }),
    )
    expect(result).toEqual({ kind: 'ok' })
  })

  test('rejects a Fireworks 403 that is not the Fire Pass marker (e.g. genuinely forbidden)', async () => {
    const result = await validateApiKey(
      'fireworks',
      'fw_test',
      fakeFetch(() => new Response('{"error":{"message":"forbidden","code":"FORBIDDEN"}}', { status: 403 })),
    )
    expect(result).toEqual({ kind: 'rejected', status: 403 })
  })

  test('does not apply the Fire Pass exception to non-Fireworks providers', async () => {
    const firePassBody = JSON.stringify({
      error: { message: 'Fire Pass API keys are not authorized for this route.', code: 'FORBIDDEN' },
    })
    const result = await validateApiKey(
      'openai',
      'sk-test',
      fakeFetch(() => new Response(firePassBody, { status: 403 })),
    )
    expect(result).toEqual({ kind: 'rejected', status: 403 })
  })

  test('rejects a Fireworks 401 even if the body somehow mentions Fire Pass', async () => {
    const result = await validateApiKey(
      'fireworks',
      'fpk_bad',
      fakeFetch(
        () =>
          new Response('{"error":{"message":"Fire Pass key invalid","code":"UNAUTHORIZED"}}', {
            status: 401,
          }),
      ),
    )
    expect(result).toEqual({ kind: 'rejected', status: 401 })
  })

  test('uses x-api-key + anthropic-version for Anthropic', async () => {
    let seenHeaders: Record<string, string> | null = null
    await validateApiKey(
      'anthropic',
      'sk-ant-test',
      fakeFetch((_url, init) => {
        seenHeaders = init.headers as Record<string, string>
        return new Response(okBody, { status: 200 })
      }),
    )
    expect(seenHeaders!['x-api-key']).toBe('sk-ant-test')
    expect(seenHeaders!['anthropic-version']).toBe('2023-06-01')
    expect(seenHeaders!.Authorization).toBeUndefined()
  })

  test('probes api.anthropic.com by default', async () => {
    const prev = process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_BASE_URL
    try {
      let seenUrl: string | null = null
      await validateApiKey(
        'anthropic',
        'sk-ant-test',
        fakeFetch((url) => {
          seenUrl = url
          return new Response(okBody, { status: 200 })
        }),
      )
      expect(seenUrl!).toBe('https://api.anthropic.com/v1/models')
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = prev
    }
  })

  test('probes the proxy endpoint when ANTHROPIC_BASE_URL is set', async () => {
    const prev = process.env.ANTHROPIC_BASE_URL
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/anthropic/'
    try {
      let seenUrl: string | null = null
      await validateApiKey(
        'anthropic',
        'sk-ant-test',
        fakeFetch((url) => {
          seenUrl = url
          return new Response(okBody, { status: 200 })
        }),
      )
      expect(seenUrl!).toBe('https://gateway.example.com/anthropic/v1/models')
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = prev
    }
  })

  test('probes api.openai.com by default', async () => {
    const prev = process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_BASE_URL
    try {
      let seenUrl: string | null = null
      await validateApiKey(
        'openai',
        'sk-test',
        fakeFetch((url) => {
          seenUrl = url
          return new Response(okBody, { status: 200 })
        }),
      )
      expect(seenUrl!).toBe('https://api.openai.com/v1/models')
    } finally {
      if (prev === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = prev
    }
  })

  test('probes the proxy endpoint when OPENAI_BASE_URL is set', async () => {
    const prev = process.env.OPENAI_BASE_URL
    process.env.OPENAI_BASE_URL = 'https://gateway.example.com/openai/'
    try {
      let seenUrl: string | null = null
      await validateApiKey(
        'openai',
        'sk-test',
        fakeFetch((url) => {
          seenUrl = url
          return new Response(okBody, { status: 200 })
        }),
      )
      expect(seenUrl!).toBe('https://gateway.example.com/openai/models')
    } finally {
      if (prev === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = prev
    }
  })

  test('probes the opengateway /v1/me endpoint, never the publicly readable /v1/models', async () => {
    // OpenGateway serves /v1/models without auth, so probing it would validate
    // any garbage string. /me is the endpoint that actually rejects a bad key.
    let seenUrl: string | null = null
    const result = await validateApiKey(
      'opengateway',
      'og-test',
      fakeFetch((url, init) => {
        seenUrl = url
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer og-test')
        return new Response('{"id":"team_1","name":"Acme"}', { status: 200 })
      }),
    )
    expect(seenUrl!).toBe('https://apis.opengateway.ai/v1/me')
    expect(seenUrl!).not.toContain('/models')
    expect(result).toEqual({ kind: 'ok' })
  })

  test('rejects an invalid opengateway key on 401', async () => {
    const result = await validateApiKey(
      'opengateway',
      'og-bad',
      fakeFetch(() => new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 })),
    )
    expect(result).toEqual({ kind: 'rejected', status: 401 })
  })

  test('opengateway still rejects a captive-portal HTML 200 despite the looser shape check', async () => {
    const result = await validateApiKey(
      'opengateway',
      'og-test',
      fakeFetch(() => new Response('<html><body>Login required</body></html>', { status: 200 })),
    )
    expect(result).toEqual({ kind: 'skipped', reason: 'network-error', detail: 'unexpected response shape' })
  })

  test('the json-object shape does not accept a top-level array', async () => {
    const result = await validateApiKey(
      'opengateway',
      'og-test',
      fakeFetch(() => new Response('[{"id":"team_1"}]', { status: 200 })),
    )
    expect(result.kind).toBe('skipped')
  })

  test('models-list providers still require {data:[...]}, unaffected by the json-object shape', async () => {
    const result = await validateApiKey(
      'openai',
      'sk-test',
      fakeFetch(() => new Response('{"id":"acct_1"}', { status: 200 })),
    )
    expect(result).toEqual({ kind: 'skipped', reason: 'network-error', detail: 'unexpected response shape' })
  })

  test('skips OAuth-only providers without contacting the network', async () => {
    let called = false
    const result = await validateApiKey('openai-codex', 'whatever', async () => {
      called = true
      return new Response()
    })
    expect(result).toEqual({ kind: 'skipped', reason: 'no-probe' })
    expect(called).toBe(false)
  })

  test('skips on fetch rejection so flaky networks do not block init', async () => {
    const result = await validateApiKey('openai', 'sk-test', async () => {
      throw new Error('ENOTFOUND')
    })
    expect(result.kind).toBe('skipped')
    if (result.kind === 'skipped') {
      expect(result.reason).toBe('network-error')
      expect(result.detail).toContain('ENOTFOUND')
    }
  })

  test('skips on non-auth 4xx/5xx so provider hiccups do not look like a rejected key', async () => {
    const result = await validateApiKey(
      'openai',
      'sk-test',
      fakeFetch(() => new Response('', { status: 503 })),
    )
    expect(result).toEqual({ kind: 'skipped', reason: 'network-error', detail: 'HTTP 503' })
  })

  test('treats 3xx as skipped so the credential is never sent to a redirected host', async () => {
    const result = await validateApiKey(
      'openai',
      'sk-test',
      fakeFetch(() => new Response('', { status: 302, headers: { location: 'https://attacker.example/models' } })),
    )
    expect(result).toEqual({ kind: 'skipped', reason: 'network-error', detail: 'HTTP 302' })
  })

  test('treats HTTP 200 with non-JSON body (captive portal / WAF page) as skipped, not ok', async () => {
    const result = await validateApiKey(
      'openai',
      'sk-test',
      fakeFetch(() => new Response('<html><body>Login required</body></html>', { status: 200 })),
    )
    expect(result).toEqual({ kind: 'skipped', reason: 'network-error', detail: 'unexpected response shape' })
  })

  test('treats HTTP 200 with JSON of the wrong shape as skipped', async () => {
    const result = await validateApiKey(
      'openai',
      'sk-test',
      fakeFetch(() => new Response('{"object":"list","data":"not-an-array"}', { status: 200 })),
    )
    expect(result.kind).toBe('skipped')
  })

  test('caps the response body when checking the shape so a malicious provider cannot exhaust memory', async () => {
    const huge = `{"data":[${'0,'.repeat(10_000)}0]}`
    const result = await validateApiKey(
      'openai',
      'sk-test',
      fakeFetch(() => new Response(huge, { status: 200 })),
    )
    expect(result.kind).toBe('skipped')
    if (result.kind === 'skipped') expect(result.detail).toBe('unexpected response shape')
  })
})

describe('drift guard', () => {
  test('every api-key-supporting provider either has a probe or is an explicit OAuth-only exception', () => {
    const probes = new Set(providersWithApiKeyProbe())
    // Inception serves /v1/models publicly and has no authenticated GET, so a
    // probe would accept any string.
    // EXAONE documents no models endpoint to probe.
    const noAuthenticatedProbe = new Set<KnownProviderId>(['inception', 'exaone'])
    const apiKeyProviders = (Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]).filter(
      (id) => supportsApiKey(KNOWN_PROVIDERS[id]) && !noAuthenticatedProbe.has(id),
    )
    for (const id of apiKeyProviders) {
      expect(probes.has(id), `provider "${id}" supports api-key but has no entry in PROVIDER_PROBE`).toBe(true)
    }
  })

  test('every api-key-supporting provider has a dashboard URL for the deeplink note', () => {
    for (const id of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
      if (!supportsApiKey(KNOWN_PROVIDERS[id])) continue
      expect(API_KEY_DASHBOARD_URL[id], `provider "${id}" supports api-key but has no dashboard URL`).toBeDefined()
    }
  })
})
