import { describe, expect, test } from 'bun:test'
import type { LookupAddress } from 'node:dns'

import type { PublicHttpRequestOptions, PublicHttpResponse } from '@/agent/network/safe-http'
import { WeightedResourceBudget } from '@/agent/resource-budget'

import { fetchWithLimits, normalizeUrl, parseMimeType, type WebFetchNetworkDependencies, WebFetchError } from './fetch'
import { DEFAULT_WEB_FETCH_TRANSPORT_MAX_BYTES } from './types'

describe('normalizeUrl', () => {
  test('normalizes HTTP(S) and rejects other schemes', () => {
    expect(normalizeUrl('example.com/a')).toBe('https://example.com/a')
    expect(normalizeUrl(' http://example.com ')).toBe('http://example.com')
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow(WebFetchError)
  })
})

describe('parseMimeType', () => {
  test('normalizes the media type', () => {
    expect(parseMimeType('TEXT/PLAIN; charset=utf-8')).toBe('text/plain')
  })
})

describe('fetchWithLimits safe transport', () => {
  test('pins the socket lookup and preserves Host and SNI', async () => {
    let observed: PublicHttpRequestOptions | undefined
    const network = fixture({
      request: async (options) => {
        observed = options
        expect(await socketAddress(options)).toEqual({ address: '93.184.216.34', family: 4 })
        return response({ chunks: [new TextEncoder().encode('hello')], headers: { 'content-type': 'text/plain' } })
      },
    })
    const result = await fetchWithLimits('https://example.com:8443/a', 30, undefined, 'off', network)
    expect(result.body).toBe('hello')
    expect(observed?.headers.Host).toBe('example.com:8443')
    expect(observed?.servername).toBe('example.com')
  })

  test.each([
    ['loopback', [{ address: '127.0.0.1', family: 4 as const }]],
    ['private', [{ address: '10.0.0.1', family: 4 as const }]],
    ['benchmarking', [{ address: '198.18.24.9', family: 4 as const }]],
    [
      'mixed',
      [
        { address: '93.184.216.34', family: 4 as const },
        { address: '192.168.1.2', family: 4 as const },
      ],
    ],
  ])('rejects %s DNS answers used by the actual request lookup', async (_label, addresses) => {
    const network = fixture({
      resolveAddresses: async () => addresses,
      request: async (options) => {
        await socketAddress(options)
        return response({})
      },
    })
    await expect(fetchWithLimits('https://example.com', 30, undefined, 'off', network)).rejects.toThrow(
      /non-public|DNS/,
    )
  })

  test('validates and pins every redirect hop', async () => {
    const hosts: string[] = []
    const network = fixture({
      resolveAddresses: async (hostname) =>
        hostname === 'public.example'
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }],
      request: async (options) => {
        hosts.push(options.hostname)
        await socketAddress(options)
        return response({ statusCode: 302, headers: { location: 'https://rebound.example/private' } })
      },
    })
    await expect(fetchWithLimits('https://public.example', 30, undefined, 'off', network)).rejects.toThrow(/non-public/)
    expect(hosts).toEqual(['public.example', 'rebound.example'])
  })

  test('rejects a redirect to a literal 198.19.x benchmarking address before requesting it', async () => {
    const hosts: string[] = []
    const network = fixture({
      request: async (options) => {
        hosts.push(options.hostname)
        await socketAddress(options)
        return response({ statusCode: 302, headers: { location: 'http://198.19.7.8/private' } })
      },
    })

    await expect(fetchWithLimits('https://public.example', 30, undefined, 'off', network)).rejects.toThrow(
      /SSRF|non-public|198\.19/,
    )
    expect(hosts).toEqual(['public.example'])
  })

  test('cancels non-2xx, declared-oversize, streaming-oversize, iteration-error, and successful responses', async () => {
    for (const candidate of [
      response({ statusCode: 404 }),
      response({ headers: { 'content-length': String(DEFAULT_WEB_FETCH_TRANSPORT_MAX_BYTES + 1) } }),
      response({ chunks: [new Uint8Array(DEFAULT_WEB_FETCH_TRANSPORT_MAX_BYTES + 1)] }),
      response({ iterationError: new Error('body broke') }),
      response({ chunks: [new Uint8Array([1])] }),
    ]) {
      const network = fixture({ request: async (options) => (await socketAddress(options), candidate) })
      await fetchWithLimits('https://example.com', 30, undefined, 'off', network).catch(() => undefined)
      expect(candidate.cancelled()).toBeTrue()
    }
  })

  test('streams an unknown-length body and aborts at a configured lower transport ceiling', async () => {
    const candidate = response({ chunks: [new Uint8Array(6), new Uint8Array(5)] })
    const network = fixture({ request: async (options) => (await socketAddress(options), candidate) })

    await expect(
      fetchWithLimits('https://example.com', 30, undefined, 'off', network, { maxResponseBytes: 10 }),
    ).rejects.toThrow(/10B limit/)
    expect(candidate.cancelled()).toBeTrue()
  })

  test('accounts for chunk retention plus Buffer.concat before allocating the concat buffer', async () => {
    const candidate = response({ chunks: [new Uint8Array(4), new Uint8Array(4)] })
    const network = fixture({ request: async (options) => (await socketAddress(options), candidate) })
    const budget = new WeightedResourceBudget({
      maxMemoryBytes: 15,
      maxPinnedBytes: 1,
      maxPinnedCount: 1,
      maxWaiters: 1,
    })

    await expect(
      fetchWithLimits('https://example.com', 30, undefined, 'off', network, {
        maxResponseBytes: 10,
        resourceBudget: budget,
      }),
    ).rejects.toThrow(/memory budget/i)
    expect(candidate.cancelled()).toBeTrue()
    expect(budget.usage().memoryBytes).toBe(0)
  })

  test('retains raw plus decoded-body accounting without a hidden BufferedResponse capture', async () => {
    const candidate = response({ chunks: [new TextEncoder().encode('test')] })
    const network = fixture({ request: async (options) => (await socketAddress(options), candidate) })
    const budget = new WeightedResourceBudget({
      maxMemoryBytes: 12,
      maxPinnedBytes: 1,
      maxPinnedCount: 1,
      maxWaiters: 1,
    })

    const result = await fetchWithLimits('https://example.com', 30, undefined, 'off', network, {
      resourceBudget: budget,
      retainResultBudget: true,
    })
    expect(result.body).toBe('test')
    expect(budget.usage().memoryBytes).toBe(12)

    result.release()
    expect(budget.usage().memoryBytes).toBe(0)
  })

  test('safely replays Akamai cookie warmup through the same pinned transport', async () => {
    const seenCookies: Array<string | undefined> = []
    let calls = 0
    const network = fixture({
      request: async (options) => {
        await socketAddress(options)
        seenCookies.push(options.headers.Cookie)
        calls++
        return calls === 1
          ? response({ statusCode: 403, headers: { 'set-cookie': ['_abck=one; Path=/', 'bm_sz=two'] } })
          : response({ chunks: [new TextEncoder().encode('ok')] })
      },
    })
    const result = await fetchWithLimits('https://example.com', 30, undefined, 'auto', network)
    expect(result.body).toBe('ok')
    expect(result.antibotWarmup?.triggered).toBeTrue()
    expect(seenCookies).toEqual([undefined, '_abck=one; bm_sz=two'])
  })

  test('scopes warmup cookies to each URL across redirects', async () => {
    const seen: Array<{ host: string; path: string; cookie?: string }> = []
    let calls = 0
    const network = fixture({
      request: async (options) => {
        await socketAddress(options)
        seen.push({
          host: options.hostname,
          path: options.path,
          ...(options.headers.Cookie === undefined ? {} : { cookie: options.headers.Cookie }),
        })
        calls++
        if (options.hostname === 'app.example') {
          return response({
            statusCode: 302,
            headers: {
              location: 'https://cdn.app.example/challenge',
              'set-cookie': ['_abck=one; Domain=.app.example; Path=/challenge; Secure'],
            },
          })
        }
        return calls === 2 ? response({ statusCode: 403 }) : response({ chunks: [new TextEncoder().encode('ok')] })
      },
    })

    const result = await fetchWithLimits('https://app.example/', 30, undefined, 'auto', network)

    expect(result.body).toBe('ok')
    expect(result.antibotWarmup?.triggered).toBeTrue()
    expect(seen).toEqual([
      { host: 'app.example', path: '/' },
      { host: 'cdn.app.example', path: '/challenge', cookie: '_abck=one' },
      { host: 'app.example', path: '/' },
      { host: 'cdn.app.example', path: '/challenge', cookie: '_abck=one' },
    ])
  })

  test.each([
    ['foreign domain', '_abck=one; Domain=other.example; Path=/'],
    ['different path', '_abck=one; Path=/challenge'],
    ['secure over HTTP', '_abck=one; Path=/; Secure'],
    ['expired', '_abck=one; Path=/; Max-Age=0'],
  ])('does not replay a %s warmup cookie', async (_label, setCookie) => {
    let calls = 0
    const network = fixture({
      request: async (options) => {
        await socketAddress(options)
        calls++
        return response({ statusCode: 403, headers: { 'set-cookie': [setCookie] } })
      },
    })

    await expect(fetchWithLimits('http://app.example/product', 30, undefined, 'auto', network)).rejects.toThrow(
      /HTTP 403/,
    )
    expect(calls).toBe(1)
  })
})

function fixture(overrides: Partial<WebFetchNetworkDependencies> = {}): WebFetchNetworkDependencies {
  return {
    resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (options) => (await socketAddress(options), response({ chunks: [new Uint8Array([1])] })),
    ...overrides,
  }
}

function response(options: {
  statusCode?: number
  headers?: PublicHttpResponse['headers']
  chunks?: Uint8Array[]
  iterationError?: Error
}): PublicHttpResponse & { cancelled(): boolean } {
  let wasCancelled = false
  return {
    statusCode: options.statusCode ?? 200,
    headers: options.headers ?? {},
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of options.chunks ?? []) yield chunk
        if (options.iterationError !== undefined) throw options.iterationError
      },
    },
    cancel: () => {
      wasCancelled = true
    },
    cancelled: () => wasCancelled,
  }
}

async function socketAddress(options: PublicHttpRequestOptions): Promise<{ address: string; family: number }> {
  return await new Promise((resolve, reject) => {
    options.lookup(options.hostname, {}, (error, address, family) => {
      if (error !== null) return reject(error)
      if (Array.isArray(address)) {
        const first = address[0] as LookupAddress | undefined
        if (first === undefined) return reject(new Error('no address'))
        resolve(first)
        return
      }
      resolve({ address, family: family ?? 0 })
    })
  })
}
