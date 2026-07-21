import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import { fetchWithLimits, normalizeUrl, parseMimeType, WebFetchError } from './fetch'
import { applyGrep, GrepError } from './strategies/grep'
import { applyJq, JqError } from './strategies/jq'
import { applyRaw } from './strategies/raw'
import { applyReadability } from './strategies/readability'
import { applySelector, SelectorError } from './strategies/selector'
import { applySnapshot } from './strategies/snapshot'
import {
  type CompactionStrategy,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  OUTPUT_CAPS,
  type WebFetchDetails,
} from './types'

const STRATEGY_VALUES = ['readability', 'jq', 'selector', 'grep', 'snapshot', 'raw'] as const

export const webFetchTool = defineTool({
  name: 'web_fetch',
  label: 'Web Fetch',
  description:
    'Fetch a single HTTP(S) URL and return the body, optionally compacted by a strategy. ' +
    'Use this when the user references a specific URL or when web_search surfaced a result you need to read in full. ' +
    'If `spawn_subagent` is available to you, PREFER delegating to the `scout` subagent by default: spawn it whenever you expect more than one fetch, an "across multiple sources" task, or any search-then-fetch loop. Scout runs the noisy fetching in its own context window and returns a distilled, citation-backed answer, keeping bulky page bodies out of yours. Only call this tool directly for a single known URL whose content you will cite immediately — or whenever you cannot spawn subagents (e.g. you are yourself a subagent), in which case fetch here. ' +
    'Outbound requests use a DNS-rebinding-safe transport that validates and pins every redirect hop. ' +
    'For Akamai Bot Manager specifically, it auto-warms the session: a first-request 403 that sets bot-manager ' +
    'cookies (_abck/bm_sz/…) is absorbed and replayed once, which returns 200 on many Akamai-fronted sites ' +
    '(disable with `antibotWarmup: "off"`). It still does NOT solve JavaScript challenges, behavioural ' +
    'fingerprinting (mouse/scroll/timing), interactive CAPTCHAs, or IP-reputation blocks — a 403 from those ' +
    'layers is expected and unrecoverable from this tool. ' +
    'Strategy guide:\n' +
    '- "readability": extract article content as markdown (blogs, docs, news). Default for HTML.\n' +
    '- "jq": query JSON APIs (npm registry, GitHub API). Pass `query` (e.g. ".items[].name").\n' +
    '- "selector": extract text from elements matching a CSS selector. Pass `selector` (e.g. ".price").\n' +
    '- "grep": filter lines by regex with optional `before`/`after` context. Pass `pattern`.\n' +
    '- "snapshot": indented semantic tree of the page (forms, headings, links).\n' +
    '- "raw": no processing.\n' +
    'If `strategy` is omitted, it is inferred from content-type. JSON responses require explicit `strategy: "jq"` (or "raw"). ' +
    'Private, mixed-address, and non-HTTP(S) targets are rejected.',
  parameters: Type.Object({
    url: Type.String({
      description: 'URL to fetch (http:// or https://). Bare hostnames are rewritten to https://.',
    }),
    strategy: Type.Optional(
      Type.Union(
        STRATEGY_VALUES.map((value) => Type.Literal(value)),
        { description: 'How to compact the response. If omitted, auto-detected from content-type.' },
      ),
    ),
    query: Type.Optional(Type.String({ description: 'jq query (required when strategy="jq")' })),
    selector: Type.Optional(Type.String({ description: 'CSS selector (required when strategy="selector")' })),
    pattern: Type.Optional(Type.String({ description: 'Regex pattern (required when strategy="grep")' })),
    before: Type.Optional(Type.Integer({ description: 'grep -B context lines', minimum: 0 })),
    after: Type.Optional(Type.Integer({ description: 'grep -A context lines', minimum: 0 })),
    limit: Type.Optional(Type.Integer({ description: 'grep: max result lines (default 100)', minimum: 1 })),
    offset: Type.Optional(Type.Integer({ description: 'grep: pagination offset', minimum: 0 })),
    timeout: Type.Optional(
      Type.Integer({
        description: `Timeout in seconds (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}).`,
        minimum: 1,
        maximum: MAX_TIMEOUT_SECONDS,
      }),
    ),
    antibotWarmup: Type.Optional(
      Type.Union([Type.Literal('auto'), Type.Literal('off')], {
        description:
          'Akamai Bot Manager warmup. "auto" (default): if the first request is a 403 that sets bot-manager cookies ' +
          '(_abck/bm_sz/…), absorb them and replay once — many Akamai-fronted sites (e.g. Coupang) only serve content ' +
          'on the second, cookie-bearing request. "off": disable the replay; a bot-manager 403 then surfaces as the ' +
          'normal HTTP 403 error (use to confirm the block without the warmup).',
      }),
    ),
  }),

  async execute(_toolCallId, params, signal) {
    const startedAt = Date.now()
    const inputUrl = params.url

    let normalizedUrl: string
    try {
      normalizedUrl = normalizeUrl(inputUrl)
    } catch (error) {
      const message = error instanceof WebFetchError ? error.message : `Invalid URL: ${error}`
      return errorResult(inputUrl, message, { startedAt })
    }

    const timeout = clampTimeout(params.timeout)

    let response
    try {
      response = await fetchWithLimits(normalizedUrl, timeout, signal, params.antibotWarmup ?? 'auto', undefined, {
        retainResultBudget: true,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return errorResult(normalizedUrl, message, { startedAt, finalUrl: normalizedUrl })
    }

    try {
      const mime = parseMimeType(response.contentType)
      const resolved = resolveStrategy(params.strategy, mime)
      if (resolved.kind === 'error') {
        return errorResult(normalizedUrl, resolved.message, {
          startedAt,
          finalUrl: response.finalUrl,
          contentType: response.contentType,
          httpStatus: response.httpStatus,
          bytesIn: response.bytesIn,
        })
      }
      const strategy = resolved.strategy
      const autoDetected = resolved.autoDetected

      const validation = validateStrategyArgs(strategy, params)
      if (validation) {
        return errorResult(normalizedUrl, validation, {
          startedAt,
          finalUrl: response.finalUrl,
          contentType: response.contentType,
          httpStatus: response.httpStatus,
          bytesIn: response.bytesIn,
          strategy,
          autoDetected,
        })
      }

      let output: string
      try {
        output = await runStrategy(strategy, response.body, response.finalUrl, params)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return errorResult(normalizedUrl, message, {
          startedAt,
          finalUrl: response.finalUrl,
          contentType: response.contentType,
          httpStatus: response.httpStatus,
          bytesIn: response.bytesIn,
          strategy,
          autoDetected,
        })
      }

      const capped = capOutput(output, strategy)
      const details: WebFetchDetails = {
        url: normalizedUrl,
        finalUrl: response.finalUrl,
        strategy,
        autoDetected,
        contentType: response.contentType,
        httpStatus: response.httpStatus,
        bytesIn: response.bytesIn,
        bytesOut: byteLength(capped.text),
        truncated: capped.truncated,
        durationMs: Date.now() - startedAt,
        ...(response.antibotWarmup?.triggered
          ? {
              antibotWarmup: {
                triggered: true,
                initialStatus: response.antibotWarmup.initialStatus,
                initialSetCookieNames: response.antibotWarmup.initialSetCookieNames,
                replayStatus: response.antibotWarmup.replayStatus,
              },
            }
          : {}),
      }

      return {
        content: [{ type: 'text' as const, text: capped.text }],
        details,
      }
    } finally {
      response.release()
    }
  },
})

type WebFetchParams = {
  url: string
  strategy?: CompactionStrategy
  antibotWarmup?: 'auto' | 'off'
  query?: string
  selector?: string
  pattern?: string
  before?: number
  after?: number
  limit?: number
  offset?: number
  timeout?: number
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_SECONDS
  return Math.min(Math.max(1, Math.floor(value)), MAX_TIMEOUT_SECONDS)
}

type ResolvedStrategy =
  | { kind: 'ok'; strategy: CompactionStrategy; autoDetected: boolean }
  | { kind: 'error'; message: string }

function resolveStrategy(explicit: CompactionStrategy | undefined, mime: string): ResolvedStrategy {
  if (explicit) return { kind: 'ok', strategy: explicit, autoDetected: false }

  if (mime === 'text/html' || mime === 'application/xhtml+xml') {
    return { kind: 'ok', strategy: 'readability', autoDetected: true }
  }
  if (mime === 'application/json' || mime.endsWith('+json')) {
    return {
      kind: 'error',
      message: 'JSON response — pass `strategy: "jq"` with a `query`, or `strategy: "raw"` to get it untransformed.',
    }
  }
  return { kind: 'ok', strategy: 'raw', autoDetected: true }
}

function validateStrategyArgs(strategy: CompactionStrategy, params: WebFetchParams): string | null {
  if (strategy === 'jq' && !params.query) return 'Missing required arg `query` for strategy "jq".'
  if (strategy === 'selector' && !params.selector) return 'Missing required arg `selector` for strategy "selector".'
  if (strategy === 'grep' && !params.pattern) return 'Missing required arg `pattern` for strategy "grep".'
  return null
}

async function runStrategy(
  strategy: CompactionStrategy,
  body: string,
  url: string,
  params: WebFetchParams,
): Promise<string> {
  switch (strategy) {
    case 'raw':
      return applyRaw(body)
    case 'readability':
      return applyReadability(body, url)
    case 'jq':
      try {
        return await applyJq(body, params.query ?? '')
      } catch (error) {
        if (error instanceof JqError) throw new Error(error.message)
        throw error
      }
    case 'selector':
      try {
        return applySelector(body, params.selector ?? '')
      } catch (error) {
        if (error instanceof SelectorError) throw new Error(error.message)
        throw error
      }
    case 'grep':
      try {
        return applyGrep(body, {
          pattern: params.pattern ?? '',
          before: params.before,
          after: params.after,
          limit: params.limit,
          offset: params.offset,
        })
      } catch (error) {
        if (error instanceof GrepError) throw new Error(error.message)
        throw error
      }
    case 'snapshot':
      return applySnapshot(body)
  }
}

function capOutput(text: string, strategy: CompactionStrategy): { text: string; truncated: boolean } {
  const cap = OUTPUT_CAPS[strategy]
  if (byteLength(text) <= cap) return { text, truncated: false }
  const head = sliceByBytes(text, cap)
  const fullKb = (byteLength(text) / 1024).toFixed(1)
  const shownKb = (byteLength(head) / 1024).toFixed(1)
  const footer = `\n\n[Output truncated: shown ${shownKb} KB of ${fullKb} KB. Use a more specific strategy or a tighter pattern.]`
  return { text: `${head}${footer}`, truncated: true }
}

function errorResult(
  url: string,
  message: string,
  partial: Partial<WebFetchDetails> & { startedAt: number },
): { content: [{ type: 'text'; text: string }]; details: WebFetchDetails } {
  const { startedAt, ...rest } = partial
  const details: WebFetchDetails = {
    url,
    finalUrl: rest.finalUrl ?? url,
    strategy: rest.strategy ?? 'none',
    autoDetected: rest.autoDetected ?? false,
    contentType: rest.contentType ?? '',
    httpStatus: rest.httpStatus ?? 0,
    bytesIn: rest.bytesIn ?? 0,
    bytesOut: byteLength(message),
    truncated: false,
    durationMs: Date.now() - startedAt,
    error: true,
    message,
  }
  return {
    content: [{ type: 'text' as const, text: message }],
    details,
  }
}

const ENCODER = new TextEncoder()

function byteLength(text: string): number {
  return ENCODER.encode(text).byteLength
}

function sliceByBytes(text: string, maxBytes: number): string {
  const encoded = ENCODER.encode(text)
  if (encoded.byteLength <= maxBytes) return text
  return new TextDecoder('utf-8', { fatal: false }).decode(encoded.slice(0, maxBytes))
}
