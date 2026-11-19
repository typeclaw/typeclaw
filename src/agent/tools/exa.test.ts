import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { waitFor } from '@/test-helpers/wait-for'

import { _setExaPacingForTest, EXA_MCP_URL, exaSearch, ExaSearchError } from './exa'
import {
  _resetSearchCooldownsForTest,
  activeCooldown,
  ENGINE_COOLDOWN_BASE_MS,
  recordEngineBlock,
} from './search-cooldown'

type FetchArgs = { url: string; init: RequestInit | undefined }
let fetchCalls: FetchArgs[]
let fetchResponse: () => Response | Promise<Response>
const originalFetch = globalThis.fetch

beforeEach(() => {
  fetchCalls = []
  _resetSearchCooldownsForTest()
  _setExaPacingForTest({ intervalMs: 0 })
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    fetchCalls.push({ url: typeof input === 'string' ? input : input.toString(), init })
    return fetchResponse()
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  _resetSearchCooldownsForTest()
  _setExaPacingForTest(null)
})

function sseResponse(text: string, isError = false): Response {
  const message = {
    result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) },
    jsonrpc: '2.0',
    id: 1,
  }
  return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const TWO_HITS = [
  'Title: Bun test mocking\nURL: https://bun.sh/docs/test/mocks\nPublished: 2025-01-02T00:00:00.000Z\nAuthor: N/A\nHighlights:\nUse `mock()` to\ncreate   mock functions.',
  'Title: 서울 날씨\nURL: https://www.kma.go.kr/weather\nPublished: N/A\nAuthor: N/A\nHighlights:\n서울 기온 4.7',
  'Title: Duplicate\nURL: https://bun.sh/docs/test/mocks\nHighlights:\nsame url',
].join('\n\n')

describe('exaSearch', () => {
  test('posts a web_search_exa tools/call and parses each hit into title, url and collapsed snippet', async () => {
    // given
    fetchResponse = () => sseResponse(TWO_HITS)

    // when
    const results = await exaSearch('bun mock', 5)

    // then
    expect(fetchCalls[0]?.url).toBe(EXA_MCP_URL)
    const body = JSON.parse(String(fetchCalls[0]?.init?.body))
    expect(body.method).toBe('tools/call')
    expect(body.params).toEqual({ name: 'web_search_exa', arguments: { query: 'bun mock', numResults: 5 } })
    expect(results).toEqual([
      {
        title: 'Bun test mocking',
        url: 'https://bun.sh/docs/test/mocks',
        snippet: 'Use `mock()` to create mock functions.',
      },
      { title: '서울 날씨', url: 'https://www.kma.go.kr/weather', snippet: '서울 기온 4.7' },
    ])
  })

  test('respects the limit', async () => {
    fetchResponse = () => sseResponse(TWO_HITS)

    expect(await exaSearch('q', 1)).toHaveLength(1)
  })

  test('a successful answer after a pause resets the doubling', async () => {
    // given: one block whose pause has elapsed
    let clock = 0
    _resetSearchCooldownsForTest(() => clock)
    recordEngineBlock('exa', 'rate_limited')
    clock = ENGINE_COOLDOWN_BASE_MS
    fetchResponse = () => sseResponse(TWO_HITS)

    // when
    await exaSearch('q', 5)
    recordEngineBlock('exa', 'rate_limited')

    // then: the next block is the first in a row again
    expect(activeCooldown('exa')?.remainingMs).toBe(ENGINE_COOLDOWN_BASE_MS)
  })

  test('sends nothing while the engine is cooling down', async () => {
    recordEngineBlock('exa', 'rate_limited')

    const error = await exaSearch('q', 5).catch((e: unknown) => e)

    expect((error as ExaSearchError).blocked).toBe('rate_limited')
    expect(fetchCalls).toHaveLength(0)
  })

  test('HTTP 429 is reported as a rate-limit block and pauses the engine for at least Retry-After', async () => {
    // given
    fetchResponse = () =>
      new Response('{"error":{"message":"Create an API key at https://example.com"}}', {
        status: 429,
        headers: { 'retry-after': '300' },
      })

    // when
    const error = await exaSearch('q', 5).catch((e: unknown) => e)

    // then
    expect(error).toBeInstanceOf(ExaSearchError)
    expect((error as ExaSearchError).blocked).toBe('rate_limited')
    expect((error as ExaSearchError).message).toBe('Exa HTTP 429')
    expect(activeCooldown('exa')).toEqual({ remainingMs: expect.any(Number), reason: 'rate_limited' })
    expect(activeCooldown('exa')?.remainingMs).toBeGreaterThan(299_000)
  })

  test('a network failure is a block', async () => {
    fetchResponse = () => {
      throw new TypeError('fetch failed')
    }

    const error = await exaSearch('q', 5).catch((e: unknown) => e)

    expect((error as ExaSearchError).blocked).toBe('network')
    expect(activeCooldown('exa')?.reason).toBe('network')
  })

  test('a server error or a tool error fails without pausing the engine', async () => {
    fetchResponse = () => new Response('boom', { status: 500 })
    const serverError = await exaSearch('q', 5).catch((e: unknown) => e)
    expect((serverError as ExaSearchError).blocked).toBeUndefined()

    fetchResponse = () => sseResponse('Invalid query', true)
    const toolError = await exaSearch('q', 5).catch((e: unknown) => e)
    expect((toolError as ExaSearchError).message).toBe('Exa error: Invalid query')

    expect(activeCooldown('exa')).toBeUndefined()
  })

  test('a search waiting for its request slot sends nothing once a concurrent search is blocked', async () => {
    // given: each pacing wait is held until released, and the endpoint rate-limits
    const held: Array<() => void> = []
    _setExaPacingForTest({
      intervalMs: 500,
      now: () => 0,
      sleep: () => new Promise<void>((resolve) => held.push(resolve)),
    })
    fetchResponse = () => new Response('', { status: 429 })

    // when: A goes out at once and is blocked while B waits for its slot
    const a = exaSearch('a', 5).catch((e: unknown) => e)
    const b = exaSearch('b', 5).catch((e: unknown) => e)
    expect(((await a) as ExaSearchError).blocked).toBe('rate_limited')
    held[0]?.()

    // then
    expect(((await b) as ExaSearchError).blocked).toBe('rate_limited')
    expect(fetchCalls).toHaveLength(1)
  })

  test('an older request that succeeds after a newer block does not lift the pause', async () => {
    // given: A's response is held while B gets a 429 with Retry-After
    let releaseA: (response: Response) => void = () => {}
    const responses = [
      () => new Promise<Response>((resolve) => (releaseA = resolve)),
      () => new Response('', { status: 429, headers: { 'retry-after': '300' } }),
    ]
    fetchResponse = () => (responses.shift() ?? (() => sseResponse(TWO_HITS)))()
    const a = exaSearch('a', 5)
    await waitFor(() => fetchCalls.length === 1, { description: 'A is in flight' })
    await exaSearch('b', 5).catch(() => {})

    // when: A's 200 lands after B's block
    releaseA(sseResponse(TWO_HITS))
    await a

    // then: C still skips Exa
    const error = await exaSearch('c', 5).catch((e: unknown) => e)
    expect((error as ExaSearchError).blocked).toBe('rate_limited')
    expect(fetchCalls).toHaveLength(2)
  })

  test('a 429 is honored from its headers without waiting for a body that never closes', async () => {
    // given
    const stalled = new ReadableStream<Uint8Array>({ start: () => {} })
    fetchResponse = () => new Response(stalled, { status: 429, headers: { 'retry-after': '120' } })

    // when
    const error = await exaSearch('q', 5).catch((e: unknown) => e)

    // then
    expect((error as ExaSearchError).blocked).toBe('rate_limited')
    expect(activeCooldown('exa')?.remainingMs).toBeGreaterThan(119_000)
  })

  test('a 5xx is temporary but does not pause the engine', async () => {
    fetchResponse = () => new Response('unavailable', { status: 503 })

    const error = await exaSearch('q', 5).catch((e: unknown) => e)

    expect((error as ExaSearchError).transient).toBe(true)
    expect((error as ExaSearchError).blocked).toBeUndefined()
    expect(activeCooldown('exa')).toBeUndefined()
  })

  test('an aborted call rethrows the abort without pausing the engine', async () => {
    // given
    const controller = new AbortController()
    fetchResponse = () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }

    // when
    const error = await exaSearch('q', 5, controller.signal).catch((e: unknown) => e)

    // then
    expect(error).not.toBeInstanceOf(ExaSearchError)
    expect(activeCooldown('exa')).toBeUndefined()
  })
})
