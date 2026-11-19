// The session model's own hosted web search, run as a standalone request on a
// subscription login: the ChatGPT (Codex) subscription's `web_search` tool, or
// Claude's `web_search_20250305` server tool on a Claude OAuth login. Both are
// covered by the subscription with no per-search charge; pay-per-use API keys
// bill per search and are deliberately not routed here.
//
// The request goes through pi's own transport (`modelRegistry.complete`) on the
// session model, so the credential, its OAuth identity headers, and token
// refresh stay inside the runtime exactly as for the main turn. `onPayload`
// adds the hosted tool, and `onProviderStreamEvent` reads the provider's raw
// stream, because pi's normalized message drops search sources and citations.
// Only URLs from an actual search (its sources and citations) are returned,
// never URLs the model typed in its answer.

import type { Api, AssistantMessage, Context, Model } from '@earendil-works/pi-ai'

import {
  activeCooldown,
  blockGeneration,
  recordEngineBlock,
  recordEngineSuccess,
  type SearchBlockReason,
  type SearchEngineId,
} from './search-cooldown'

const REQUEST_TIMEOUT_MS = 90_000
const MAX_OUTPUT_TOKENS = 2048
const MAX_SNIPPET_CHARS = 400
const ANTHROPIC_HOST = 'api.anthropic.com'
const RATE_LIMIT_TEXT = /\b429\b|rate.?limit|usage limit|too_many_requests|quota/i
const TRANSIENT_TEXT =
  /\b5\d\d\b|overloaded|timed out|timeout|network|fetch failed|ECONN|socket|unavailable|bad gateway/i

const INSTRUCTIONS =
  'You are a web search assistant. Always run the web search tool for the user query, then answer briefly and cite the pages you used.'

export type NativeSearchResult = {
  title: string
  url: string
  snippet: string
}

export type NativeSearchRoute = {
  engine: Extract<SearchEngineId, 'native-chatgpt' | 'native-claude'>
  label: string
  kind: 'codex' | 'anthropic'
}

export type NativeSearchRegistry = {
  isUsingOAuth(model: Model<Api>): boolean
  complete(
    model: Model<Api>,
    context: Context,
    options: {
      signal?: AbortSignal
      maxTokens?: number
      transport?: 'sse'
      cacheRetention?: 'none'
      onPayload?: (payload: unknown, model: Model<Api>) => unknown
      onResponse?: (response: { status: number }, model: Model<Api>) => void
      onProviderStreamEvent?: (data: unknown, model: Model<Api>) => void
    },
  ): Promise<AssistantMessage>
}

export class NativeSearchError extends Error {
  readonly transient: boolean

  constructor(
    message: string,
    readonly blocked?: SearchBlockReason,
    temporary = false,
  ) {
    super(message)
    this.name = 'NativeSearchError'
    this.transient = temporary || blocked === 'rate_limited' || blocked === 'network'
  }
}

export function nativeSearchRoute(
  model: Model<Api> | undefined,
  registry: NativeSearchRegistry | undefined,
): NativeSearchRoute | undefined {
  if (!model || !registry) return undefined
  if (model.api === 'openai-codex-responses' && !model.id.includes('-spark')) {
    return { engine: 'native-chatgpt', label: 'ChatGPT search', kind: 'codex' }
  }
  if (model.api === 'anthropic-messages' && hostOf(model.baseUrl) === ANTHROPIC_HOST && registry.isUsingOAuth(model)) {
    return { engine: 'native-claude', label: 'Claude search', kind: 'anthropic' }
  }
  return undefined
}

export async function nativeSearch(
  route: NativeSearchRoute,
  model: Model<Api>,
  registry: NativeSearchRegistry,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<NativeSearchResult[]> {
  const cooldown = activeCooldown(route.engine)
  if (cooldown) throw new NativeSearchError('cooling down after a block', cooldown.reason)

  const events: unknown[] = []
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const generation = blockGeneration(route.engine)
  // pi's transports can drop the HTTP status from the error they raise (a 502
  // surfaces as its bare body text), so keep it from the response itself.
  let status: number | undefined
  let message: AssistantMessage
  try {
    message = await registry.complete(
      model,
      { systemPrompt: INSTRUCTIONS, messages: [{ role: 'user', content: query, timestamp: Date.now() }] },
      {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        maxTokens: MAX_OUTPUT_TOKENS,
        // A one-shot search: plain SSE, no WebSocket session or prompt-cache key.
        transport: 'sse',
        cacheRetention: 'none',
        onPayload: (payload) => (route.kind === 'codex' ? withCodexSearch(payload) : withAnthropicSearch(payload)),
        onResponse: (response) => {
          status = response.status
        },
        onProviderStreamEvent: (event) => void events.push(event),
      },
    )
  } catch (error) {
    if (signal?.aborted) throw error
    throw failure(
      route,
      timeout.aborted ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : errorText(error),
      errorStatus(status),
    )
  }
  if (signal?.aborted) throw signal.reason
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    throw failure(
      route,
      timeout.aborted ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : (message.errorMessage ?? 'request failed'),
      errorStatus(status),
    )
  }

  const parsed = route.kind === 'codex' ? parseCodexEvents(events) : parseAnthropicEvents(events)
  if (parsed.toolError) throw searchToolFailure(route, parsed.toolError)
  if (parsed.error) throw failure(route, parsed.error)
  recordEngineSuccess(route.engine, generation)
  return parsed.searched ? parsed.results.slice(0, limit) : []
}

// The Codex backend takes OpenAI's Responses `web_search` tool, declared alone
// with the official Codex client's `tool_choice: "auto"`; the instructions ask
// for a search and the parser only counts a reply that actually ran one.
// `include` returns the search's sources.
export function withCodexSearch(payload: unknown): unknown {
  if (!isRecord(payload)) return payload
  const include = Array.isArray(payload.include) ? payload.include : []
  return {
    ...payload,
    tools: [{ type: 'web_search', external_web_access: true }],
    tool_choice: 'auto',
    include: [...new Set([...include, 'web_search_call.action.sources'])],
  }
}

export function withAnthropicSearch(payload: unknown): unknown {
  if (!isRecord(payload)) return payload
  const { tool_choice: _toolChoice, ...rest } = payload
  return { ...rest, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }] }
}

type ParsedSearch = { searched: boolean; results: NativeSearchResult[]; error?: string; toolError?: string }

// `response.output_item.done` carries each finished item: a `web_search_call`
// with its sources, and the `message` whose text annotations cite pages.
export function parseCodexEvents(events: readonly unknown[]): ParsedSearch {
  const citations: NativeSearchResult[] = []
  const sources: NativeSearchResult[] = []
  let searched = false
  let error: string | undefined
  for (const event of events) {
    if (!isRecord(event)) continue
    if (event.type === 'error' || event.type === 'response.failed') error ??= streamError(event)
    if (event.type !== 'response.output_item.done' || !isRecord(event.item)) continue
    const item = event.item
    if (item.type === 'web_search_call') {
      searched = true
      const action = isRecord(item.action) ? item.action : {}
      for (const source of Array.isArray(action.sources) ? action.sources : []) {
        if (isRecord(source) && typeof source.url === 'string') {
          sources.push(result(stringOf(source.title), source.url, ''))
        }
      }
    } else if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isRecord(part)) continue
        const text = stringOf(part.text) ?? ''
        for (const annotation of Array.isArray(part.annotations) ? part.annotations : []) {
          if (!isRecord(annotation) || annotation.type !== 'url_citation' || typeof annotation.url !== 'string') {
            continue
          }
          const snippet = around(text, numberOf(annotation.start_index), numberOf(annotation.end_index))
          citations.push(result(stringOf(annotation.title), annotation.url, snippet))
        }
      }
    }
  }
  return { searched, results: uniqueByUrl([...citations, ...sources]), ...(error ? { error } : {}) }
}

// A `web_search_tool_result` block lists the pages a search returned (or its
// error); `citations_delta` events carry the passage the answer cited.
export function parseAnthropicEvents(events: readonly unknown[]): ParsedSearch {
  const citations: NativeSearchResult[] = []
  const sources: NativeSearchResult[] = []
  let searched = false
  let toolError: string | undefined
  for (const event of events) {
    if (!isRecord(event)) continue
    if (event.type === 'content_block_start' && isRecord(event.content_block)) {
      const block = event.content_block
      if (block.type !== 'web_search_tool_result') continue
      searched = true
      if (isRecord(block.content) && block.content.type === 'web_search_tool_result_error') {
        toolError ??= stringOf(block.content.error_code) ?? 'unknown'
        continue
      }
      for (const page of Array.isArray(block.content) ? block.content : []) {
        if (isRecord(page) && typeof page.url === 'string') sources.push(result(stringOf(page.title), page.url, ''))
      }
    } else if (event.type === 'content_block_delta' && isRecord(event.delta)) {
      const citation = event.delta.citation
      if (event.delta.type !== 'citations_delta' || !isRecord(citation) || typeof citation.url !== 'string') continue
      citations.push(result(stringOf(citation.title), citation.url, clip(stringOf(citation.cited_text) ?? '')))
    }
  }
  // A search that hit only its own usage limit is still a search with no pages.
  if (toolError === 'max_uses_exceeded') toolError = undefined
  return { searched, results: uniqueByUrl([...citations, ...sources]), ...(toolError ? { toolError } : {}) }
}

// A known HTTP status decides on its own: a 429 pauses the route, a 5xx is
// temporary and leaves it open (whatever its body says), and any other 4xx (an
// account or model that does not accept the tool) pauses it, so a route that
// cannot search stops costing time on every query. Only without a status does
// the message text decide: a recognizable rate limit still pauses, a
// recognizable outage is temporary, and anything else fails this attempt only.
function failure(route: NativeSearchRoute, detail: string, status?: number): NativeSearchError {
  if (status !== undefined) {
    if (status === 429) return rateLimited(route, detail)
    if (status >= 500) return new NativeSearchError(detail, undefined, true)
    recordEngineBlock(route.engine, 'forbidden')
    return new NativeSearchError(detail, 'forbidden')
  }
  if (RATE_LIMIT_TEXT.test(detail)) return rateLimited(route, detail)
  return new NativeSearchError(detail, undefined, TRANSIENT_TEXT.test(detail))
}

function rateLimited(route: NativeSearchRoute, detail: string): NativeSearchError {
  recordEngineBlock(route.engine, 'rate_limited')
  return new NativeSearchError(detail, 'rate_limited')
}

// Claude reports search errors inside a successful reply. Query errors are about
// this query only, so the next query still tries the route.
function searchToolFailure(route: NativeSearchRoute, code: string): NativeSearchError {
  const detail = `search tool error: ${code}`
  if (code === 'too_many_requests') return failure(route, detail, 429)
  return new NativeSearchError(detail, undefined, code === 'unavailable')
}

function errorStatus(status: number | undefined): number | undefined {
  return status !== undefined && status >= 400 ? status : undefined
}

function streamError(event: Record<string, unknown>): string {
  const response = isRecord(event.response) ? event.response : {}
  const nested = isRecord(event.error) ? event.error : isRecord(response.error) ? response.error : {}
  return stringOf(nested.message) ?? stringOf(event.message) ?? stringOf(nested.code) ?? 'the search stream failed'
}

function result(title: string | undefined, url: string, snippet: string): NativeSearchResult {
  return { title: title ?? hostOf(url) ?? url, url: cleanUrl(url), snippet }
}

// OpenAI tags its citation links with utm_source=openai; it is not part of the page.
function cleanUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.searchParams.get('utm_source') === 'openai') url.searchParams.delete('utm_source')
    return url.href
  } catch {
    return raw
  }
}

function uniqueByUrl(items: NativeSearchResult[]): NativeSearchResult[] {
  const byUrl = new Map<string, NativeSearchResult>()
  for (const item of items) if (!byUrl.has(item.url)) byUrl.set(item.url, item)
  return [...byUrl.values()]
}

function around(text: string, start: number | undefined, end: number | undefined): string {
  if (start === undefined || end === undefined) return ''
  return clip(text.slice(Math.max(0, start - 150), Math.min(text.length, end + 150)))
}

function clip(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > MAX_SNIPPET_CHARS ? `${clean.slice(0, MAX_SNIPPET_CHARS - 1)}…` : clean
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
