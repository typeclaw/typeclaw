import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { CurlImpersonateError, isCurlExitTimeout } from './curl-impersonate'
import { ddgSearch, DdgCaptchaError, type DdgResult } from './ddg'
import { exaSearch, ExaSearchError, type ExaResult } from './exa'
import { activeCooldown, type SearchBlockReason, type SearchEngineId } from './search-cooldown'
import { wikipediaSearch, type WikipediaResult } from './wikipedia'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20

const SOURCES_REMINDER = 'Cite the URLs you rely on from these results as sources in your answer.'

type SearchResult = DdgResult | ExaResult | WikipediaResult

type WebEngine = {
  id: SearchEngineId
  label: string
  search: (query: string, limit: number, signal?: AbortSignal) => Promise<SearchResult[]>
}

// Keyless engines only, tried in order until one answers with results. Exa's
// JSON API is not fingerprinted, so it goes first; DuckDuckGo's SERP needs
// curl-impersonate and trips its CAPTCHA under bursts, so it is the fallback.
const WEB_ENGINES: readonly WebEngine[] = [
  { id: 'exa', label: 'Exa', search: exaSearch },
  { id: 'ddg', label: 'DuckDuckGo', search: ddgSearch },
]

const BLOCK_DESCRIPTIONS: Record<SearchBlockReason, string> = {
  challenge: 'a bot challenge',
  rate_limited: 'a rate limit',
  forbidden: 'a refusal',
  network: 'a network error',
}

type SearchAttempt = {
  engine: string
  outcome: 'results' | 'empty' | 'skipped' | 'failed'
  count: number
  message?: string
  transient?: boolean
}

type WebSearchDetails = {
  query: string
  source: 'web' | 'wikipedia' | 'none'
  engine?: string
  count: number
  results: SearchResult[]
  attempts?: SearchAttempt[]
  error?: boolean
  message?: string
}

export const webSearchTool = defineTool({
  name: 'web_search',
  label: 'Web Search',
  description:
    'Search the public web. Returns a ranked list of {title, url, snippet} entries. Use `source: "wikipedia"` for encyclopedic lookups; otherwise general web results come from Exa, falling back to DuckDuckGo when Exa is unavailable. Pair this with the `read` tool by visiting URLs you find with `bash` (curl) when you need full page contents.\n' +
    'If `spawn_subagent` is available to you, PREFER delegating to the `scout` subagent by default: spawn it whenever the research is non-trivial (more than 1-2 queries, any "across multiple sources" framing, or follow-up fetches of the results). Scout runs `web_search`/`web_fetch` in its own context window and returns a distilled, citation-backed answer, so the search churn never pollutes yours. Only call this tool directly for a single query whose top result you will cite immediately — or whenever you cannot spawn subagents (e.g. you are yourself a subagent), in which case run the searches here.',
  parameters: Type.Object({
    query: Type.String({ description: 'The search query.' }),
    limit: Type.Optional(
      Type.Integer({
        description: `Max number of results to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
        minimum: 1,
        maximum: MAX_LIMIT,
      }),
    ),
    source: Type.Optional(
      Type.Union([Type.Literal('web'), Type.Literal('wikipedia')], {
        description: 'Which engine to query. Defaults to "web" (Exa, then DuckDuckGo).',
      }),
    ),
  }),

  async execute(_toolCallId, params, signal) {
    const query = params.query.trim()
    if (!query) {
      return errorResult('Query is empty.')
    }
    const limit = clampLimit(params.limit)

    try {
      if (params.source === 'wikipedia') {
        return successResult(query, 'wikipedia', await wikipediaSearch(query, limit, signal), [])
      }
      const { engine, results, attempts } = await searchWeb(query, limit, signal)
      if (engine) return successResult(query, 'web', results, attempts, engine)
      return noResultsOrFailure(query, attempts)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return errorResult(`Search failed: ${message}`)
    }
  },
})

async function searchWeb(
  query: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<{ engine?: string; results: SearchResult[]; attempts: SearchAttempt[] }> {
  const attempts: SearchAttempt[] = []
  for (const engine of WEB_ENGINES) {
    const cooldown = activeCooldown(engine.id)
    if (cooldown) {
      const seconds = Math.ceil(cooldown.remainingMs / 1000)
      attempts.push({
        engine: engine.label,
        outcome: 'skipped',
        count: 0,
        transient: true,
        message: `skipped (cooling down for ${seconds}s after ${BLOCK_DESCRIPTIONS[cooldown.reason]})`,
      })
      continue
    }
    try {
      const results = await engine.search(query, limit, signal)
      if (results.length > 0) {
        attempts.push({ engine: engine.label, outcome: 'results', count: results.length })
        return { engine: engine.label, results, attempts }
      }
      attempts.push({ engine: engine.label, outcome: 'empty', count: 0 })
    } catch (error) {
      if (signal?.aborted) throw error
      attempts.push({
        engine: engine.label,
        outcome: 'failed',
        count: 0,
        transient: isTransientEngineError(error),
        message: failureMessage(error),
      })
    }
  }
  return { results: [], attempts }
}

// A rate limit, CAPTCHA, or network timeout outlasts anything the model can do
// right now: each engine already retried or paused itself, and the model has no
// visibility into that. Any message that hints "try again" invites it to loop
// the tool with varied queries, so when every failure is transient the result
// is a terminal "do not retry now" contract instead.
function noResultsOrFailure(query: string, attempts: SearchAttempt[]) {
  const failures = attempts.filter((attempt) => attempt.outcome === 'failed' || attempt.outcome === 'skipped')
  if (failures.length === 0) {
    return {
      content: [{ type: 'text' as const, text: `No results for "${query}" on web.` }],
      details: { query, source: 'web', count: 0, results: [], attempts } satisfies WebSearchDetails,
    }
  }
  const summary = attempts.map(formatAttempt).join('; ')
  if (failures.every((attempt) => attempt.transient)) {
    return errorResult(
      `Search unavailable for "${query}" (${summary}). Do not retry this tool now — report what you already have and note the search was unreachable.`,
      { query, attempts },
    )
  }
  return errorResult(`Search failed: ${summary}`, { query, attempts })
}

function isTransientEngineError(error: unknown): boolean {
  if (error instanceof DdgCaptchaError) return true
  if (error instanceof CurlImpersonateError && isCurlExitTimeout(error)) return true
  return error instanceof ExaSearchError && error.transient
}

function failureMessage(error: unknown): string {
  if (error instanceof DdgCaptchaError) return 'challenged: CAPTCHA (rate-limited)'
  if (error instanceof CurlImpersonateError && isCurlExitTimeout(error)) return 'failed: network timeout'
  return `failed: ${error instanceof Error ? error.message : String(error)}`
}

function formatAttempt(attempt: SearchAttempt): string {
  if (attempt.message) return `${attempt.engine} ${attempt.message}`
  if (attempt.outcome === 'empty') return `${attempt.engine} no results`
  return `${attempt.engine} ${attempt.count} result${attempt.count === 1 ? '' : 's'}`
}

function clampLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT
  return Math.min(Math.max(1, Math.floor(value)), MAX_LIMIT)
}

function successResult(
  query: string,
  source: 'web' | 'wikipedia',
  results: SearchResult[],
  attempts: SearchAttempt[],
  engine?: string,
) {
  const details: WebSearchDetails = { query, source, count: results.length, results }
  if (engine) details.engine = engine
  if (attempts.length > 0) details.attempts = attempts
  if (results.length === 0) {
    return {
      content: [{ type: 'text' as const, text: `No results for "${query}" on ${source}.` }],
      details,
    }
  }

  const via = engine ? ` via ${engine}` : ''
  const lines = [`Search results for "${query}" (${source}${via}, ${results.length}):`, '']
  // Only a fallback is worth the tokens: it tells the model which engines were
  // skipped or blocked, so it does not mistake a fallback answer for the default.
  if (attempts.length > 1) lines.push(`Routing attempts: ${attempts.map(formatAttempt).join(' -> ')}`, '')
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title}`)
    lines.push(`   ${result.url}`)
    if (result.snippet) lines.push(`   ${result.snippet}`)
    lines.push('')
  })
  lines.push(SOURCES_REMINDER)

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    details,
  }
}

function errorResult(message: string, extra: { query?: string; attempts?: SearchAttempt[] } = {}) {
  const details: WebSearchDetails = {
    query: extra.query ?? '',
    source: 'none',
    count: 0,
    results: [],
    error: true,
    message,
  }
  if (extra.attempts) details.attempts = extra.attempts
  return {
    content: [{ type: 'text' as const, text: message }],
    details,
  }
}
