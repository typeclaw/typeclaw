import { describe, expect, test } from 'bun:test'
import type { LookupAddress } from 'node:dns'
import { mkdtemp, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { WeightedResourceBudget } from '@/agent/resource-budget'

import {
  buildGlmVisionMessages,
  extractGlmVisionText,
  GLM_VISION_TTFB_MS,
  lookAtTool,
  resolveGlmVisionTtfbMs,
} from './look-at'
import {
  buildMultimodalLookerSystemPrompt,
  type LookAtHttpResponse,
  type LookAtNetworkDependencies,
  type LookAtRequestOptions,
} from './looker'
import {
  DEFAULT_LOOK_AT_TOTAL_MAX_BYTES,
  LOOK_AT_MAX_CONCURRENCY,
  DEFAULT_LOOK_AT_MAX_IMAGES,
  resolveImagesBounded,
} from './looker'

type ImageParam = { url?: string; path?: string; data?: string; mimeType?: string } | Record<string, never>

async function execute(args: { images: ImageParam[]; prompt?: string }) {
  // pi-coding-agent's `execute` signature is `(toolCallId, params, signal,
  // onUpdate, ctx)`; for these validation-path tests the last three are
  // unused (the tool fails fast in toImageInput before any LLM/IO).
  // The cast is needed because the JSONSchema-derived Static<TParams> type
  // differs from our type-level ImageParam shape.
  return lookAtTool.execute(
    'test-call-id',
    args as unknown as Parameters<typeof lookAtTool.execute>[1],
    undefined,
    undefined,
    {} as unknown as Parameters<typeof lookAtTool.execute>[4],
  )
}

describe('lookAtTool — image source validation (no LLM call)', () => {
  // All these tests should fail validation BEFORE attempting to spawn a
  // multimodal-looker session. They prove the exactly-one-source rule from
  // the self-review (Bug 3) is enforced regardless of what the model passes.

  test('rejects mixing url and path', async () => {
    const result = await execute({ images: [{ url: 'https://example.com/x.png', path: '/agent/x.png' }] })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('exactly one') })
    expect(result.details).toMatchObject({ error: expect.stringContaining('exactly one') })
  })

  test('rejects mixing url and data', async () => {
    const result = await execute({
      images: [{ url: 'https://example.com/x.png', data: 'aGk=', mimeType: 'image/png' }],
    })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('exactly one') })
  })

  test('rejects mixing path and data+mimeType', async () => {
    const result = await execute({ images: [{ path: '/agent/x.png', data: 'aGk=', mimeType: 'image/png' }] })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('exactly one') })
  })

  test('rejects empty image object', async () => {
    const result = await execute({ images: [{}] })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('exactly one') })
  })

  test('rejects data without mimeType (incomplete base64 spec)', async () => {
    const result = await execute({ images: [{ data: 'aGk=' }] })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('base64') })
  })

  test('rejects mimeType without data (incomplete base64 spec)', async () => {
    const result = await execute({ images: [{ mimeType: 'image/png' }] })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('base64') })
  })

  test('rejects relative file path', async () => {
    const result = await execute({ images: [{ path: 'relative/x.png' }] })
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('absolute') })
  })

  test('rejects file with unsupported extension', async () => {
    const result = await execute({ images: [{ path: '/tmp/x.bmp' }] })
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/unsupported|not found/),
    })
  })

  test('rejects base64 with non-image mimeType', async () => {
    const result = await execute({ images: [{ data: 'aGVsbG8=', mimeType: 'text/plain' }] })
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('mimeType must be image/*'),
    })
  })
})

describe('resolveImagesBounded — aggregate resource boundary', () => {
  test('honors configured lower per-image, aggregate, and count limits', async () => {
    const limits = { maxImageBytes: 4, maxAggregateBytes: 6, maxImages: 2 }
    await expect(
      resolveImagesBounded(
        [
          { kind: 'base64' as const, data: 'AAAA', mimeType: 'image/png' },
          { kind: 'base64' as const, data: 'AAAA', mimeType: 'image/png' },
          { kind: 'base64' as const, data: 'AAAA', mimeType: 'image/png' },
        ],
        undefined,
        undefined,
        limits,
      ),
    ).rejects.toThrow(/image count exceeds limit/)

    await expect(
      resolveImagesBounded(
        [
          { kind: 'base64' as const, data: 'AAAA', mimeType: 'image/png' },
          { kind: 'base64' as const, data: 'AAAA', mimeType: 'image/png' },
          { kind: 'base64' as const, data: 'AAAA', mimeType: 'image/png' },
        ].slice(0, 2),
        undefined,
        undefined,
        { ...limits, maxAggregateBytes: 5 },
      ),
    ).rejects.toThrow(/aggregate byte limit/)
  })

  test('accounts for retained base64 plus provider-payload amplification', async () => {
    const budget = new WeightedResourceBudget({
      maxMemoryBytes: 7,
      maxPinnedBytes: 1,
      maxPinnedCount: 1,
      maxWaiters: 1,
    })
    await expect(
      resolveImagesBounded(
        [{ kind: 'base64', data: 'AAAA', mimeType: 'image/png' }],
        undefined,
        undefined,
        { maxImageBytes: 4, maxAggregateBytes: 4, maxImages: 1 },
        { resourceBudget: budget },
      ),
    ).rejects.toThrow(/memory budget/i)
    expect(budget.usage().memoryBytes).toBe(0)
  })

  test('rejects image arrays above the global count limit before resolving any source', async () => {
    await expect(
      resolveImagesBounded(
        Array.from({ length: DEFAULT_LOOK_AT_MAX_IMAGES + 1 }, () => ({
          kind: 'url' as const,
          url: 'https://example.com/image.png',
        })),
      ),
    ).rejects.toThrow(/image count exceeds limit/)
  })

  test('bounds decoded base64 size before constructing a decoded Buffer', async () => {
    const encoded = 'A'.repeat(Math.ceil((DEFAULT_LOOK_AT_TOTAL_MAX_BYTES + 1) / 3) * 4)
    await expect(resolveImagesBounded([{ kind: 'base64', data: encoded, mimeType: 'image/png' }])).rejects.toThrow(
      /base64 image too large/,
    )
  })

  test('enforces one aggregate byte budget across mixed local and base64 sources', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'typeclaw-look-at-mixed-'))
    const file = path.join(root, 'image.png')
    await Bun.write(file, '')
    await truncate(file, Math.floor(DEFAULT_LOOK_AT_TOTAL_MAX_BYTES * 0.6))
    const encoded = 'A'.repeat(Math.ceil((DEFAULT_LOOK_AT_TOTAL_MAX_BYTES * 0.6) / 3) * 4)
    try {
      await expect(
        resolveImagesBounded([
          { kind: 'file', path: file },
          { kind: 'base64', data: encoded, mimeType: 'image/png' },
        ]),
      ).rejects.toThrow(/aggregate byte limit/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('limits concurrent URL downloads', async () => {
    let active = 0
    let peak = 0
    const network = networkFixture({
      request: async (options) => {
        await resolveSocketAddress(options)
        active += 1
        peak = Math.max(peak, active)
        await Bun.sleep(5)
        active -= 1
        return imageResponse({ chunks: [new Uint8Array([1])] })
      },
    })
    await resolveImagesBounded(
      Array.from({ length: DEFAULT_LOOK_AT_MAX_IMAGES }, (_, i) => ({
        kind: 'url' as const,
        url: `https://example.com/${i}.png`,
      })),
      undefined,
      network,
    )
    expect(peak).toBeLessThanOrEqual(LOOK_AT_MAX_CONCURRENCY)
  })

  test('aborts and settles sibling workers before propagating the first failure', async () => {
    let aborted = 0
    let active = 0
    const network = networkFixture({
      request: async (options) => {
        await resolveSocketAddress(options)
        if (options.path === '/fail.png') throw new Error('first failure')
        active++
        await new Promise<void>((_resolve, reject) => {
          const onAbort = () => {
            aborted++
            active--
            reject(new Error('sibling aborted'))
          }
          if (options.signal.aborted) onAbort()
          else options.signal.addEventListener('abort', onAbort, { once: true })
        })
        throw new Error('unreachable')
      },
    })

    await expect(
      resolveImagesBounded(
        [
          { kind: 'url', url: 'https://example.com/slow-1.png' },
          { kind: 'url', url: 'https://example.com/slow-2.png' },
          { kind: 'url', url: 'https://example.com/fail.png' },
        ],
        undefined,
        network,
      ),
    ).rejects.toThrow('first failure')
    expect(aborted).toBe(2)
    expect(active).toBe(0)
  })

  test('rejects direct internal and non-HTTP URL sources before opening a request', async () => {
    let calls = 0
    const network = networkFixture({
      request: async () => {
        calls += 1
        return imageResponse({ chunks: [new Uint8Array([1])] })
      },
    })
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://127.0.0.1/a.png', 'file:///etc/passwd']) {
      await expect(resolveImagesBounded([{ kind: 'url', url }], undefined, network)).rejects.toThrow(
        /public|SSRF|HTTP/i,
      )
    }
    expect(calls).toBe(0)
  })

  test('validates every redirect target and refuses a public-to-private hostname before requesting it', async () => {
    const requested: string[] = []
    const network = networkFixture({
      request: async (options) => {
        await resolveSocketAddress(options)
        requested.push(`${options.protocol}//${options.hostname}${options.path}`)
        return imageResponse({ statusCode: 302, headers: { location: 'http://127.0.0.1/private.png' } })
      },
    })
    await expect(
      resolveImagesBounded([{ kind: 'url', url: 'https://example.com/image.png' }], undefined, network),
    ).rejects.toThrow(/public|SSRF|redirect/i)
    expect(requested).toEqual(['https://example.com/image.png'])
  })

  test('preserves normal public HTTP image fetching', async () => {
    const network = networkFixture({
      request: async (options) => {
        await resolveSocketAddress(options)
        return imageResponse({ chunks: [new Uint8Array([1, 2, 3])] })
      },
    })
    const [image] = await resolveImagesBounded(
      [{ kind: 'url', url: 'https://example.com/image.png' }],
      undefined,
      network,
    )
    expect(image).toEqual({ data: 'AQID', mimeType: 'image/png' })
  })

  test.each([
    ['loopback', [{ address: '127.0.0.1', family: 4 as const }]],
    ['RFC1918', [{ address: '10.2.3.4', family: 4 as const }]],
    ['IPv4 link-local', [{ address: '169.254.20.1', family: 4 as const }]],
    ['IPv6 link-local', [{ address: 'fe90::1', family: 6 as const }]],
    ['IPv4-mapped IPv6', [{ address: '::ffff:127.0.0.1', family: 6 as const }]],
    [
      'mixed public/private',
      [
        { address: '93.184.216.34', family: 4 as const },
        { address: '192.168.1.5', family: 4 as const },
      ],
    ],
  ])('rejects %s answers in the socket lookup used by the request', async (_label, addresses) => {
    let requests = 0
    const network = networkFixture({
      resolveAddresses: async () => addresses,
      request: async (options) => {
        requests += 1
        await resolveSocketAddress(options)
        return imageResponse({ chunks: [new Uint8Array([1])] })
      },
    })
    await expect(
      resolveImagesBounded([{ kind: 'url', url: 'https://images.example/photo.png' }], undefined, network),
    ).rejects.toThrow(/DNS|non-public|SSRF|address/i)
    expect(requests).toBe(1)
  })

  test('pins the actual socket lookup to one validated answer without a second resolution', async () => {
    let resolutions = 0
    let connectedAddress = ''
    const network = networkFixture({
      resolveAddresses: async () => {
        resolutions += 1
        return resolutions === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]
      },
      request: async (options) => {
        connectedAddress = (await resolveSocketAddress(options)).address
        return imageResponse({ chunks: [new Uint8Array([1])] })
      },
    })
    await resolveImagesBounded([{ kind: 'url', url: 'https://images.example/photo.png' }], undefined, network)
    expect(connectedAddress).toBe('93.184.216.34')
    expect(resolutions).toBe(1)
  })

  test('preserves the original HTTPS hostname for Host, SNI, and certificate validation', async () => {
    let observed: LookAtRequestOptions | undefined
    const network = networkFixture({
      request: async (options) => {
        observed = options
        await resolveSocketAddress(options)
        return imageResponse({ chunks: [new Uint8Array([1])] })
      },
    })
    await resolveImagesBounded([{ kind: 'url', url: 'https://images.example:8443/photo.png?q=1' }], undefined, network)
    expect(observed?.hostname).toBe('images.example')
    expect(observed?.servername).toBe('images.example')
    expect(observed?.headers.Host).toBe('images.example:8443')
    expect(observed?.path).toBe('/photo.png?q=1')
  })

  test('performs a fresh validated socket lookup for every manual redirect hop', async () => {
    const resolvedHosts: string[] = []
    const requestedHosts: string[] = []
    const network = networkFixture({
      resolveAddresses: async (hostname) => {
        resolvedHosts.push(hostname)
        return hostname === 'cdn.example'
          ? [{ address: '93.184.216.34', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }]
      },
      request: async (options) => {
        requestedHosts.push(options.hostname)
        await resolveSocketAddress(options)
        if (options.hostname === 'cdn.example') {
          return imageResponse({ statusCode: 302, headers: { location: 'https://rebound.example/private.png' } })
        }
        return imageResponse({ chunks: [new Uint8Array([1])] })
      },
    })
    await expect(
      resolveImagesBounded([{ kind: 'url', url: 'https://cdn.example/photo.png' }], undefined, network),
    ).rejects.toThrow(/DNS|non-public|SSRF|address/i)
    expect(requestedHosts).toEqual(['cdn.example', 'rebound.example'])
    expect(resolvedHosts).toEqual(['cdn.example', 'rebound.example'])
  })

  test('surfaces DNS lookup failures and never falls back to an unpinned request', async () => {
    const network = networkFixture({
      resolveAddresses: async () => {
        throw new Error('dns unavailable')
      },
      request: async (options) => {
        await resolveSocketAddress(options)
        return imageResponse({ chunks: [new Uint8Array([1])] })
      },
    })
    await expect(
      resolveImagesBounded([{ kind: 'url', url: 'https://images.example/photo.png' }], undefined, network),
    ).rejects.toThrow(/dns unavailable/)
  })

  test('propagates caller aborts into the socket request', async () => {
    const controller = new AbortController()
    controller.abort('cancel image request')
    const network = networkFixture({
      request: async (options) => {
        if (options.signal.aborted) throw new Error(String(options.signal.reason))
        return imageResponse({ chunks: [new Uint8Array([1])] })
      },
    })
    await expect(
      resolveImagesBounded([{ kind: 'url', url: 'https://images.example/photo.png' }], controller.signal, network),
    ).rejects.toThrow(/cancel image request/)
  })

  test('retains image content-type and streaming byte limits on the pinned transport', async () => {
    const nonImage = networkFixture({
      request: async (options) => {
        await resolveSocketAddress(options)
        return imageResponse({ headers: { 'content-type': 'text/html' }, chunks: [new Uint8Array([1])] })
      },
    })
    await expect(
      resolveImagesBounded([{ kind: 'url', url: 'https://images.example/not-image' }], undefined, nonImage),
    ).rejects.toThrow(/did not return an image content-type/)

    const oversized = networkFixture({
      request: async (options) => {
        await resolveSocketAddress(options)
        return imageResponse({ chunks: [new Uint8Array(DEFAULT_LOOK_AT_TOTAL_MAX_BYTES + 1)] })
      },
    })
    await expect(
      resolveImagesBounded([{ kind: 'url', url: 'https://images.example/huge.png' }], undefined, oversized),
    ).rejects.toThrow(/response exceeded.*cap/)
  })

  test('cancels every final response on consumed and rejected paths', async () => {
    const cases = [
      imageResponse({ statusCode: 404 }),
      imageResponse({ headers: { 'content-type': 'text/html' } }),
      imageResponse({ headers: { 'content-length': String(DEFAULT_LOOK_AT_TOTAL_MAX_BYTES + 1) } }),
      imageResponse({ chunks: [new Uint8Array(DEFAULT_LOOK_AT_TOTAL_MAX_BYTES + 1)] }),
      imageResponse({ chunks: [new Uint8Array([1])], iterationError: new Error('body failed') }),
      imageResponse({ chunks: [new Uint8Array([1])] }),
    ]
    for (const candidate of cases) {
      const network = networkFixture({
        request: async (options) => {
          await resolveSocketAddress(options)
          return candidate
        },
      })
      await resolveImagesBounded([{ kind: 'url', url: 'https://images.example/photo.png' }], undefined, network).catch(
        () => undefined,
      )
      expect(candidate.cancelled()).toBeTrue()
    }
  })

  test('cancels the response when the aggregate budget rejects a URL chunk', async () => {
    const candidate = imageResponse({ chunks: [new Uint8Array(Math.ceil(DEFAULT_LOOK_AT_TOTAL_MAX_BYTES * 0.6))] })
    const network = networkFixture({ request: async (options) => (await resolveSocketAddress(options), candidate) })
    const encoded = 'A'.repeat(Math.ceil((DEFAULT_LOOK_AT_TOTAL_MAX_BYTES * 0.6) / 3) * 4)
    await expect(
      resolveImagesBounded(
        [
          { kind: 'base64', data: encoded, mimeType: 'image/png' },
          { kind: 'url', url: 'https://images.example/photo.png' },
        ],
        undefined,
        network,
      ),
    ).rejects.toThrow(/aggregate byte limit/)
    expect(candidate.cancelled()).toBeTrue()
  })

  test('cancels the final response when the caller aborts during body iteration', async () => {
    const controller = new AbortController()
    let cancelled = false
    const network = networkFixture({
      request: async (options) => {
        await resolveSocketAddress(options)
        return {
          statusCode: 200,
          headers: { 'content-type': 'image/png' },
          body: {
            async *[Symbol.asyncIterator]() {
              controller.abort('stop')
              if (options.signal.aborted) throw new Error(String(options.signal.reason))
              yield new Uint8Array([1])
            },
          },
          cancel: () => {
            cancelled = true
          },
        }
      },
    })
    await expect(
      resolveImagesBounded([{ kind: 'url', url: 'https://images.example/photo.png' }], controller.signal, network),
    ).rejects.toThrow(/stop/)
    expect(cancelled).toBeTrue()
  })
})

function networkFixture(overrides: Partial<LookAtNetworkDependencies> = {}): LookAtNetworkDependencies {
  return {
    resolveAddresses: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (options) => {
      await resolveSocketAddress(options)
      return imageResponse({ chunks: [new Uint8Array([1])] })
    },
    ...overrides,
  }
}

function imageResponse(options: {
  statusCode?: number
  headers?: Record<string, string>
  chunks?: Uint8Array[]
  iterationError?: Error
}): LookAtHttpResponse & { cancelled(): boolean } {
  const chunks = options.chunks ?? []
  let wasCancelled = false
  return {
    statusCode: options.statusCode ?? 200,
    headers: { 'content-type': 'image/png', ...options.headers },
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
        if (options.iterationError !== undefined) throw options.iterationError
      },
    },
    cancel() {
      wasCancelled = true
    },
    cancelled: () => wasCancelled,
  }
}

async function resolveSocketAddress(options: LookAtRequestOptions): Promise<{ address: string; family: number }> {
  return await new Promise((resolve, reject) => {
    options.lookup(options.hostname, {}, (error, address, family) => {
      if (error !== null) {
        reject(error)
        return
      }
      if (Array.isArray(address)) {
        const first = address[0] as LookupAddress | undefined
        if (first === undefined) {
          reject(new Error('lookup returned no address'))
          return
        }
        resolve({ address: first.address, family: first.family })
        return
      }
      resolve({ address, family: family ?? 0 })
    })
  })
}

describe('extractGlmVisionText — GLM vision response parsing', () => {
  test('extracts trimmed assistant content from a well-formed response', () => {
    const body = { choices: [{ message: { role: 'assistant', content: '\nblue\n' } }] }
    expect(extractGlmVisionText(body)).toBe('blue')
  })

  test('returns null when choices is empty', () => {
    expect(extractGlmVisionText({ choices: [] })).toBeNull()
  })

  test('returns null when content is blank', () => {
    expect(extractGlmVisionText({ choices: [{ message: { content: '   ' } }] })).toBeNull()
  })

  test('returns null for a non-object body', () => {
    expect(extractGlmVisionText(null)).toBeNull()
    expect(extractGlmVisionText('oops')).toBeNull()
  })

  test('returns null when the API returns an error envelope instead of choices', () => {
    expect(extractGlmVisionText({ error: { code: '1113', message: 'Insufficient balance' } })).toBeNull()
  })
})

describe('buildGlmVisionMessages — GLM payload preserves looker behavior', () => {
  const image = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' }

  test('prepends the looker system prompt (with a question)', () => {
    const messages = buildGlmVisionMessages([image], 'What color is the car?')
    expect(messages[0]).toEqual({
      role: 'system',
      content: buildMultimodalLookerSystemPrompt('What color is the car?'),
    })
    expect(messages[0]!.content).toContain('What color is the car?')
  })

  test('uses the describe-everything system prompt when no prompt is given', () => {
    const messages = buildGlmVisionMessages([image], undefined)
    expect(messages[0]).toEqual({ role: 'system', content: buildMultimodalLookerSystemPrompt(undefined) })
  })

  test('carries the image as a data-URI and the user text in the user turn', () => {
    const messages = buildGlmVisionMessages([image], undefined)
    const user = messages[1] as { role: string; content: Array<Record<string, unknown>> }
    expect(user.role).toBe('user')
    expect(user.content[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } })
    expect(user.content[1]).toEqual({ type: 'text', text: 'Please describe the attached image(s).' })
  })
})

describe('resolveGlmVisionTtfbMs — vision TTFB budget', () => {
  test('defaults to 45s when the env var is unset', () => {
    expect(resolveGlmVisionTtfbMs({})).toBe(GLM_VISION_TTFB_MS)
    expect(GLM_VISION_TTFB_MS).toBe(45_000)
  })

  test('a valid TYPECLAW_GLM_VISION_TTFB_MS overrides the default', () => {
    expect(resolveGlmVisionTtfbMs({ TYPECLAW_GLM_VISION_TTFB_MS: '60000' })).toBe(60_000)
  })

  test('an invalid or empty env value falls back to the default', () => {
    expect(resolveGlmVisionTtfbMs({ TYPECLAW_GLM_VISION_TTFB_MS: '' })).toBe(GLM_VISION_TTFB_MS)
    expect(resolveGlmVisionTtfbMs({ TYPECLAW_GLM_VISION_TTFB_MS: 'abc' })).toBe(GLM_VISION_TTFB_MS)
    expect(resolveGlmVisionTtfbMs({ TYPECLAW_GLM_VISION_TTFB_MS: '-5' })).toBe(GLM_VISION_TTFB_MS)
  })
})
