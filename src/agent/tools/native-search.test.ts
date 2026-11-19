import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai'
import { complete } from '@earendil-works/pi-ai/compat'

import {
  nativeSearch,
  NativeSearchError,
  nativeSearchRoute,
  type NativeSearchRegistry,
  type NativeSearchRoute,
} from './native-search'
import { _resetSearchCooldownsForTest, activeCooldown, recordEngineBlock } from './search-cooldown'

const CODEX_ROUTE: NativeSearchRoute = { engine: 'native-chatgpt', label: 'ChatGPT search', kind: 'codex' }
const CLAUDE_ROUTE: NativeSearchRoute = { engine: 'native-claude', label: 'Claude search', kind: 'anthropic' }

function model(overrides: Partial<Model<Api>>): Model<Api> {
  return {
    id: 'test-model',
    name: 'Test model',
    api: 'anthropic-messages',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
    ...overrides,
  } as Model<Api>
}

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'answer' }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
    ...overrides,
  } as AssistantMessage
}

// A registry that runs the request hooks like pi's transport does: the payload
// passes through onPayload, then each raw stream event reaches the observer.
function fakeRegistry(
  events: unknown[],
  options: { oauth?: boolean; reply?: AssistantMessage; basePayload?: Record<string, unknown>; status?: number } = {},
) {
  const sent: unknown[] = []
  const registry: NativeSearchRegistry = {
    isUsingOAuth: () => options.oauth ?? true,
    async complete(requestModel, _context, requestOptions) {
      sent.push(await requestOptions.onPayload?.(options.basePayload ?? { model: requestModel.id }, requestModel))
      requestOptions.onResponse?.({ status: options.status ?? 200 }, requestModel)
      for (const event of events) requestOptions.onProviderStreamEvent?.(event, requestModel)
      return options.reply ?? message()
    },
  }
  return { registry, sent }
}

const CODEX_EVENTS = [
  {
    type: 'response.output_item.done',
    item: {
      type: 'web_search_call',
      action: { type: 'search', sources: [{ type: 'url', url: 'https://bun.sh/docs' }] },
    },
  },
  {
    type: 'response.output_item.done',
    item: {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: 'Bun mocks fetch with mock(). See the docs.',
          annotations: [
            {
              type: 'url_citation',
              url: 'https://bun.sh/docs/test/mocks?utm_source=openai',
              title: 'Mocks | Bun',
              start_index: 0,
              end_index: 30,
            },
          ],
        },
      ],
    },
  },
]

const CLAUDE_EVENTS = [
  { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv', name: 'web_search' } },
  {
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: 'srv',
      content: [
        { type: 'web_search_result', url: 'https://www.kma.go.kr/weather', title: '서울 날씨' },
        { type: 'web_search_result', url: 'https://example.com/other', title: 'Other' },
      ],
    },
  },
  {
    type: 'content_block_delta',
    index: 2,
    delta: {
      type: 'citations_delta',
      citation: {
        type: 'web_search_result_location',
        url: 'https://www.kma.go.kr/weather',
        title: '서울 날씨',
        cited_text: '서울 기온 4.7',
      },
    },
  },
]

beforeEach(() => {
  _resetSearchCooldownsForTest()
})

afterEach(() => {
  _resetSearchCooldownsForTest()
})

describe('nativeSearchRoute', () => {
  const registry = (oauth: boolean) => fakeRegistry([], { oauth }).registry

  test('a ChatGPT subscription model routes to ChatGPT search', () => {
    expect(nativeSearchRoute(model({ api: 'openai-codex-responses', id: 'gpt-5.5' }), registry(true))?.engine).toBe(
      'native-chatgpt',
    )
  })

  test('a realtime -spark model has no search route', () => {
    expect(nativeSearchRoute(model({ api: 'openai-codex-responses', id: 'gpt-5.3-spark' }), registry(true))).toBe(
      undefined,
    )
  })

  test('Claude routes only on an OAuth login to the Anthropic API', () => {
    expect(nativeSearchRoute(model({}), registry(true))?.engine).toBe('native-claude')
    expect(nativeSearchRoute(model({}), registry(false))).toBeUndefined()
    expect(nativeSearchRoute(model({ baseUrl: 'https://proxy.example.com' }), registry(true))).toBeUndefined()
  })

  test('pay-per-use and other providers have no route', () => {
    expect(nativeSearchRoute(model({ api: 'openai-responses', provider: 'openai' }), registry(false))).toBeUndefined()
    expect(nativeSearchRoute(undefined, registry(true))).toBeUndefined()
  })
})

describe('nativeSearch', () => {
  test('declares the Codex web_search tool like the official client and returns citations before bare sources', async () => {
    // given
    const { registry, sent } = fakeRegistry(CODEX_EVENTS, { basePayload: { include: ['reasoning.encrypted_content'] } })

    // when
    const results = await nativeSearch(CODEX_ROUTE, model({ api: 'openai-codex-responses' }), registry, 'bun mock', 5)

    // then
    expect(sent[0]).toMatchObject({
      tools: [{ type: 'web_search' }],
      tool_choice: 'auto',
      include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
    })
    expect(results).toEqual([
      {
        title: 'Mocks | Bun',
        url: 'https://bun.sh/docs/test/mocks',
        snippet: 'Bun mocks fetch with mock(). See the docs.',
      },
      { title: 'bun.sh', url: 'https://bun.sh/docs', snippet: '' },
    ])
  })

  test('adds the Claude server search tool and reads its results and citations', async () => {
    // given
    const { registry, sent } = fakeRegistry(CLAUDE_EVENTS, { basePayload: { tool_choice: { type: 'auto' } } })

    // when
    const results = await nativeSearch(CLAUDE_ROUTE, model({}), registry, '서울 날씨', 1)

    // then
    expect(sent[0]).toEqual({ tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] })
    expect(results).toEqual([{ title: '서울 날씨', url: 'https://www.kma.go.kr/weather', snippet: '서울 기온 4.7' }])
  })

  test('an answer that never searched returns nothing, so typed URLs are never sources', async () => {
    const { registry } = fakeRegistry([
      {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          content: [{ type: 'output_text', text: 'see https://made-up.example', annotations: [] }],
        },
      },
    ])

    expect(await nativeSearch(CODEX_ROUTE, model({ api: 'openai-codex-responses' }), registry, 'q', 5)).toEqual([])
  })

  test('a usage limit pauses the route and is transient', async () => {
    const { registry } = fakeRegistry([], {
      reply: message({ stopReason: 'error', errorMessage: '429 You have hit your usage limit' }),
    })

    const error = await nativeSearch(CLAUDE_ROUTE, model({}), registry, 'q', 5).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NativeSearchError)
    expect((error as NativeSearchError).transient).toBe(true)
    expect(activeCooldown('native-claude')?.reason).toBe('rate_limited')
  })

  test('a server error is transient without pausing the route, even when its text carries no status', async () => {
    const { registry } = fakeRegistry([], {
      reply: message({ stopReason: 'error', errorMessage: 'Bad Gateway' }),
      status: 502,
    })

    const error = await nativeSearch(CLAUDE_ROUTE, model({}), registry, 'q', 5).catch((e: unknown) => e)

    expect((error as NativeSearchError).transient).toBe(true)
    expect(activeCooldown('native-claude')).toBeUndefined()
  })

  test('a rejected request (an unsupported tool) pauses the route and is not transient', async () => {
    const { registry } = fakeRegistry([], {
      reply: message({ stopReason: 'error', errorMessage: 'invalid_request_error: tool type not supported' }),
      status: 400,
    })

    const error = await nativeSearch(CODEX_ROUTE, model({ api: 'openai-codex-responses' }), registry, 'q', 5).catch(
      (e: unknown) => e,
    )

    expect((error as NativeSearchError).transient).toBe(false)
    expect(activeCooldown('native-chatgpt')?.reason).toBe('forbidden')
  })

  test('a search tool error inside a successful reply fails the search', async () => {
    const { registry } = fakeRegistry([
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' },
        },
      },
    ])

    const error = await nativeSearch(CLAUDE_ROUTE, model({}), registry, 'q', 5).catch((e: unknown) => e)

    expect((error as NativeSearchError).blocked).toBe('rate_limited')
  })

  test('an unrecognized failure without a status fails this attempt only', async () => {
    const { registry } = fakeRegistry([], { reply: message({ stopReason: 'error', errorMessage: 'something odd' }) })

    const error = await nativeSearch(CLAUDE_ROUTE, model({}), registry, 'q', 5).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NativeSearchError)
    expect(activeCooldown('native-claude')).toBeUndefined()
  })

  test('a Claude query error fails this query only, without pausing the route', async () => {
    for (const code of ['query_too_long', 'invalid_tool_input']) {
      const { registry } = fakeRegistry([
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'web_search_tool_result',
            content: { type: 'web_search_tool_result_error', error_code: code },
          },
        },
      ])

      const error = await nativeSearch(CLAUDE_ROUTE, model({}), registry, 'q', 5).catch((e: unknown) => e)

      expect((error as NativeSearchError).message).toBe(`search tool error: ${code}`)
      expect((error as NativeSearchError).transient).toBe(false)
      expect(activeCooldown('native-claude')).toBeUndefined()
    }
  })

  test('sends nothing while the route is cooling down', async () => {
    recordEngineBlock('native-chatgpt', 'rate_limited')
    const { registry, sent } = fakeRegistry(CODEX_EVENTS)

    const error = await nativeSearch(CODEX_ROUTE, model({ api: 'openai-codex-responses' }), registry, 'q', 5).catch(
      (e: unknown) => e,
    )

    expect((error as NativeSearchError).blocked).toBe('rate_limited')
    expect(sent).toHaveLength(0)
  })
})

// The hooks above are pi's contract; these drive pi's real Anthropic and Codex
// transports against a local upstream to prove the contract holds end to end:
// the hosted tool reaches the wire, the subscription identity is applied, the
// raw search blocks reach the observer, and pi tolerates blocks it cannot render.
describe('nativeSearch through the real pi transport', () => {
  let server: ReturnType<typeof Bun.serve>
  let requests: { path: string; headers: Headers; body: Record<string, unknown> }[]
  let sse: string
  let status: number

  beforeEach(() => {
    requests = []
    status = 200
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const raw = new Uint8Array(await req.arrayBuffer())
        const bytes = req.headers.get('content-encoding') === 'zstd' ? Bun.zstdDecompressSync(raw) : raw
        requests.push({
          path: new URL(req.url).pathname,
          headers: req.headers,
          body: JSON.parse(new TextDecoder().decode(bytes)),
        })
        if (status !== 200) return new Response(sse, { status })
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
  })

  afterEach(() => {
    server.stop(true)
  })

  function viaPi(apiKey: string): NativeSearchRegistry {
    return {
      isUsingOAuth: () => true,
      complete: (requestModel, context, options) => complete(requestModel, context, { ...options, apiKey }),
    }
  }

  function events(list: Record<string, unknown>[]): string {
    return list.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('')
  }

  test('Claude OAuth: sends the server tool with the OAuth identity and reads its results', async () => {
    // given
    sse = events([
      {
        type: 'message_start',
        message: {
          id: 'msg',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      ...(CLAUDE_EVENTS as Record<string, unknown>[]),
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'It is 4.7 degrees.' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ])

    // when
    const results = await nativeSearch(
      CLAUDE_ROUTE,
      model({ baseUrl: server.url.origin }),
      viaPi('sk-ant-oat01-test'),
      '서울 날씨',
      5,
    )

    // then
    const request = requests[0]
    expect(request?.path).toBe('/v1/messages')
    expect(request?.headers.get('authorization')).toBe('Bearer sk-ant-oat01-test')
    expect(request?.headers.get('anthropic-beta')).toContain('oauth-2025-04-20')
    expect(request?.body.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }])
    expect(results.map((r) => r.url)).toEqual(['https://www.kma.go.kr/weather', 'https://example.com/other'])
  })

  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } }
  const codexToken = `e30.${btoa(JSON.stringify(claims))}.sig`

  test('ChatGPT subscription: declares web_search on the Codex backend and reads sources and citations', async () => {
    // given
    const token = codexToken
    sse = events([
      { type: 'response.created', response: { id: 'resp', status: 'in_progress', output: [] } },
      ...(CODEX_EVENTS as Record<string, unknown>[]),
      { type: 'response.completed', response: { id: 'resp', status: 'completed', output: [], usage: {} } },
    ])

    // when
    const results = await nativeSearch(
      CODEX_ROUTE,
      model({ api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: `${server.url.origin}/backend-api` }),
      viaPi(token),
      'bun mock',
      5,
    )

    // then
    const request = requests[0]
    expect(request?.path).toBe('/backend-api/codex/responses')
    expect(request?.headers.get('chatgpt-account-id')).toBe('acct-test')
    expect(request?.body.tool_choice).toBe('auto')
    expect(request?.body.tools).toEqual([{ type: 'web_search', external_web_access: true }])
    expect(results.map((r) => r.url)).toEqual(['https://bun.sh/docs/test/mocks', 'https://bun.sh/docs'])
  })

  test('ChatGPT subscription: a 5xx is decided by its status even when its body reads like a rate limit', async () => {
    // given
    status = 502
    sse = 'upstream rate limit service unavailable'

    // when
    const error = await nativeSearch(
      CODEX_ROUTE,
      model({ api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: `${server.url.origin}/backend-api` }),
      viaPi(codexToken),
      'q',
      5,
    ).catch((e: unknown) => e)

    // then
    expect((error as NativeSearchError).message).toMatch(/rate limit/)
    expect((error as NativeSearchError).transient).toBe(true)
    expect((error as NativeSearchError).blocked).toBeUndefined()
    expect(activeCooldown('native-chatgpt')).toBeUndefined()
  })

  test('ChatGPT subscription: a 502 whose body names no status is transient and leaves the route open', async () => {
    // given
    status = 502
    sse = 'Bad Gateway'

    // when
    const error = await nativeSearch(
      CODEX_ROUTE,
      model({ api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: `${server.url.origin}/backend-api` }),
      viaPi(codexToken),
      'q',
      5,
    ).catch((e: unknown) => e)

    // then
    expect(error).toBeInstanceOf(NativeSearchError)
    expect((error as NativeSearchError).message).not.toMatch(/502/)
    expect((error as NativeSearchError).transient).toBe(true)
    expect(activeCooldown('native-chatgpt')).toBeUndefined()
  })
})
