// Exa's hosted MCP server (mcp.exa.ai) serves its `web_search_exa` tool on an
// anonymous tier: no key, no account. It is a JSON-RPC API, so unlike the
// DuckDuckGo SERP it does not fingerprint the TLS handshake and plain fetch
// works. The anonymous tier is rate-limited per source IP; a 429/403 or a
// network failure pauses the engine (search-cooldown.ts) so web_search falls
// through to DuckDuckGo instead of hammering a blocked endpoint.

import { createRequestPacer, type PacerOptions } from './request-pacer'
import {
  activeCooldown,
  blockGeneration,
  recordEngineBlock,
  recordEngineSuccess,
  type SearchBlockReason,
} from './search-cooldown'

export const EXA_MCP_URL = 'https://mcp.exa.ai/mcp?tools=web_search_exa'

// Measured against the anonymous tier (2026-11): it answers about three
// requests per second per IP with `Retry-After: 1`, and four or more parallel
// requests start drawing 429s. Two per second keeps a subagent fan-out under it.
export const EXA_MIN_REQUEST_INTERVAL_MS = 500

const DEFAULT_PACING: PacerOptions = { intervalMs: EXA_MIN_REQUEST_INTERVAL_MS }
let pacer = createRequestPacer(DEFAULT_PACING)

// Test-only seam: swaps the clock/sleep and interval, and resets the
// process-wide pacing state so tests don't leak a request slot into each other.
export function _setExaPacingForTest(override: Partial<PacerOptions> | null): void {
  pacer = createRequestPacer({ ...DEFAULT_PACING, ...override })
}

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RESULTS = 20
const MAX_SNIPPET_CHARS = 400
const MAX_ERROR_DETAIL_CHARS = 300

export type ExaResult = {
  title: string
  url: string
  snippet: string
}

export class ExaSearchError extends Error {
  // A block (429/403/network) pauses the engine; a 5xx is just as temporary but
  // does not. Either way the failure says nothing about the query.
  readonly transient: boolean

  constructor(
    message: string,
    readonly blocked?: SearchBlockReason,
    temporary = false,
  ) {
    super(message)
    this.name = 'ExaSearchError'
    this.transient = temporary || blocked !== undefined
  }
}

export async function exaSearch(query: string, limit: number, signal?: AbortSignal): Promise<ExaResult[]> {
  await pacer.waitForSlot(signal)
  // A concurrent search may have started the cooldown while this one waited.
  const cooldown = activeCooldown('exa')
  if (cooldown) throw new ExaSearchError('Exa is cooling down after a block', cooldown.reason)
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const generation = blockGeneration('exa')
  let response: Response
  try {
    response = await fetch(EXA_MCP_URL, {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'web_search_exa',
          arguments: { query, numResults: Math.min(Math.max(1, limit), MAX_RESULTS) },
        },
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch (error) {
    throw networkFailure(error, signal, timeout)
  }

  // A block is decided by its status and Retry-After header alone. Its body is
  // an upsell to create an API key, which web_search never uses, so it is not
  // read: a stalled body must not delay the fallback or lose the header.
  const blocked = blockForStatus(response.status)
  if (blocked) {
    response.body?.cancel().catch(() => {})
    recordEngineBlock('exa', blocked, retryAfterMs(response.headers.get('retry-after')))
    throw new ExaSearchError(`Exa HTTP ${response.status}`, blocked)
  }

  let body: string
  try {
    body = await response.text()
  } catch (error) {
    throw networkFailure(error, signal, timeout)
  }

  if (!response.ok) {
    const message = parseRpcMessage(body)
    const rpcError = isRecord(message) ? rpcErrorMessage(message) : undefined
    const detail = (rpcError ?? body).trim().slice(0, MAX_ERROR_DETAIL_CHARS)
    throw new ExaSearchError(
      `Exa HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      undefined,
      response.status >= 500,
    )
  }

  const message = parseRpcMessage(body)
  const rpcError = rpcErrorMessage(message)
  if (rpcError) throw new ExaSearchError(`Exa error: ${rpcError}`)
  recordEngineSuccess('exa', generation)
  return parseExaResults(message).slice(0, limit)
}

// The tool's text content is one `Title:` / `URL:` / `Published:` / `Author:`
// / `Highlights:` section per hit, separated by blank lines. Highlights run to
// the end of their section and may span several lines.
export function parseExaResults(message: unknown): ExaResult[] {
  const text = contentText(message).replace(/\r\n?/g, '\n')
  const seen = new Set<string>()
  const results: ExaResult[] = []
  for (const section of text.split(/\n{2,}(?=Title:)/)) {
    if (!section.startsWith('Title:')) continue
    const title = field(section, 'Title')
    const url = field(section, 'URL')
    if (!title || !url || seen.has(url)) continue
    seen.add(url)
    results.push({ title, url, snippet: snippetOf(section) })
  }
  return results
}

// A streamable-HTTP MCP answer is either plain JSON or server-sent events whose
// `data:` lines carry the JSON-RPC message.
function parseRpcMessage(body: string): unknown {
  if (body.trimStart().startsWith('{')) return parseJson(body)
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const message = parseJson(line.slice(5).trim())
    if (isRecord(message) && ('result' in message || 'error' in message)) return message
  }
  return undefined
}

function rpcErrorMessage(message: unknown): string | undefined {
  if (!isRecord(message)) return 'unreadable response'
  if (isRecord(message.error)) {
    return typeof message.error.message === 'string' ? message.error.message : 'unknown JSON-RPC error'
  }
  if (isRecord(message.result) && message.result.isError === true) {
    return contentText(message).replace(/\s+/g, ' ').trim() || 'the search tool reported an error'
  }
  return undefined
}

function contentText(message: unknown): string {
  if (!isRecord(message) || !isRecord(message.result) || !Array.isArray(message.result.content)) return ''
  return message.result.content
    .map((part: unknown) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('\n\n')
}

function field(section: string, name: string): string | undefined {
  const value = new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(section)?.[1]?.replace(/\s+/g, ' ').trim()
  return value && value !== 'N/A' ? value : undefined
}

function snippetOf(section: string): string {
  const text = /^(?:Highlights|Text|Summary):[ \t]*\n?([\s\S]*)$/m.exec(section)?.[1]?.replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS - 1)}…` : text
}

function networkFailure(error: unknown, signal: AbortSignal | undefined, timeout: AbortSignal): unknown {
  if (signal?.aborted) return error
  recordEngineBlock('exa', 'network')
  const reason = timeout.aborted ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : errorMessage(error)
  return new ExaSearchError(`Exa request failed: ${reason}`, 'network')
}

function blockForStatus(status: number): SearchBlockReason | undefined {
  if (status === 429) return 'rate_limited'
  if (status === 403) return 'forbidden'
  return undefined
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
