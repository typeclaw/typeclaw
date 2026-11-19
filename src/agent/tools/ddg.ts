// DDG's no-JS "lite" endpoint is the only major engine that serves a
// parseable, key-free, registration-free SERP. We POST a query and parse the
// resulting <table> markup.
//
// We target `lite.duckduckgo.com/lite/` rather than `html.duckduckgo.com/html/`
// because `html` is gated by the interactive "duck picker" CAPTCHA after a
// single bad fingerprint match. `lite` exists for non-browser clients (text
// browsers, accessibility tools) and historically gates less aggressively —
// but as of 2026 it ALSO fingerprints at the TLS layer (JA3/JA4) and the
// HTTP/2 SETTINGS frame, well before any HTTP header is read. The shared
// curl-impersonate primitive (./curl-impersonate.ts) replays Chrome's exact
// TLS handshake + HTTP/2 settings + header ordering. See that file's header
// for the full rationale and AGENTS.md §"Web search" for the original story.

import { CurlImpersonateError, curlImpersonate, isCurlExitTimeout } from './curl-impersonate'
import { createKeyedSemaphore } from './keyed-semaphore'
import { createRequestPacer, type PacerOptions } from './request-pacer'
import { activeCooldown, blockGeneration, recordEngineBlock, recordEngineSuccess } from './search-cooldown'
import { type SearchRetryOptions, withSearchRetry } from './search-retry'

export { _setCurlBinaryForTest } from './curl-impersonate'

const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/'

// As of 2026-10 DDG-lite answers every desktop Chrome fingerprint (124-146,
// including the curl_chrome136 default) with a 202 challenge page from IPs
// where Firefox and Safari fingerprints still get a normal SERP. Try them in
// order and only treat the request as CAPTCHA'd when every profile is
// challenged. Both wrappers ship in the pinned curl-impersonate tarball.
export const DDG_PROFILES = ['curl_firefox147', 'curl_safari184'] as const

// Empirically derived: a clean source IP serves DDG-lite at concurrency ~4 but
// trips a sticky multi-minute CAPTCHA at 5-6 (see keyed-semaphore.ts header).
// The whole agent egresses from one IP and the scout subagent fans out parallel
// searches, so 2 sits well under the observed ceiling with headroom for the
// concurrent membership-style overlap — matching the webex-prefetch-limiter
// default for the same reason.
export const DDG_CONCURRENCY = 2

// Process-wide, so the cap spans every session/subagent/cron in this agent.
const searchLimiter = createKeyedSemaphore({ concurrency: DDG_CONCURRENCY })

const DDG_KEY = 'ddg'

// The concurrency cap bounds parallelism, not rate: a subagent fan-out of ~10
// searches inside 30s still tripped DDG's gate behind a cap of 2 (production
// incident, 2026-10-27). Spacing every outbound request by a minimum interval
// turns such a burst into a queue instead of a volley.
export const DDG_MIN_REQUEST_INTERVAL_MS = 1_500

// Once DDG serves a challenge to every profile the source IP is boxed for
// minutes, and each further request keeps the box alive. The challenge pauses
// the engine (search-cooldown.ts): calls inside the pause fail fast without
// touching the network.

const DEFAULT_PACING: PacerOptions = { intervalMs: DDG_MIN_REQUEST_INTERVAL_MS }
let pacer = createRequestPacer(DEFAULT_PACING)

// Test-only seam: swaps the clock/sleep and interval, and resets the
// process-wide pacing state so tests don't leak a request slot into each other.
export function _setDdgPacingForTest(override: Partial<PacerOptions> | null): void {
  pacer = createRequestPacer({ ...DEFAULT_PACING, ...override })
}

export type DdgResult = {
  title: string
  url: string
  snippet: string
}

type RetryOverride = Pick<SearchRetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs' | 'sleep'>
let retryOverride: RetryOverride = {}

// Test-only seam: lets *.test.ts collapse the generous production backoff to
// zero-delay single-shot retries so CAPTCHA tests don't burn real seconds.
// Production never calls this — the empty default above is what production sees.
export function _setSearchRetryForTest(override: RetryOverride | null): void {
  retryOverride = override ?? {}
}

export async function ddgSearch(query: string, limit: number, signal?: AbortSignal): Promise<DdgResult[]> {
  return searchLimiter.run(
    DDG_KEY,
    () =>
      withSearchRetry(
        async () => {
          for (const binary of DDG_PROFILES) {
            if (activeCooldown('ddg')) throw new DdgCaptchaError()
            await pacer.waitForSlot(signal)
            // A concurrent search may have started the cooldown while this one waited.
            if (activeCooldown('ddg')) throw new DdgCaptchaError()
            const generation = blockGeneration('ddg')
            const html = await fetchDdgHtml(query, signal, binary)
            if (!isCaptcha(html)) {
              recordEngineSuccess('ddg', generation)
              return parseDdgHtml(html).slice(0, limit)
            }
          }
          recordEngineBlock('ddg', 'challenge')
          throw new DdgCaptchaError()
        },
        { ...retryOverride, shouldRetry: isTransientSearchError, signal },
      ),
    signal,
  )
}

// Only a bare connection timeout is retried: an egress timeout is almost
// always a momentary network blip (the incident that motivated this: an agent's
// egress timed out for a few minutes, then recovered). Retrying under the
// bounded `withSearchRetry` backoff turns an otherwise-unbounded model-driven
// retry loop into at most `attempts` code-level tries. A CAPTCHA is NOT retried:
// DDG's gate lasts minutes, far beyond the retry backoff, and every retry keeps
// the box alive — the cooldown above handles it instead. A hard network failure
// (DNS, refused, TLS) is NOT retried either; it won't fix itself on a re-run.
export function isTransientSearchError(error: unknown): boolean {
  return error instanceof CurlImpersonateError && isCurlExitTimeout(error)
}

export class DdgCaptchaError extends Error {
  constructor() {
    super('DuckDuckGo returned a CAPTCHA page (rate-limited).')
    this.name = 'DdgCaptchaError'
  }
}

export async function fetchDdgHtml(query: string, signal?: AbortSignal, binary?: string): Promise<string> {
  const response = await curlImpersonate({
    url: DDG_LITE_URL,
    binary,
    method: 'POST',
    formFields: [{ name: 'q', value: query }],
    signal,
  })
  return response.body
}

// The `lite` endpoint's CAPTCHA page is plainer than `html`'s anomaly-modal:
// it returns either an HTTP error (caught above) or a "challenge-form" page
// asking the user to verify they're human. We also keep the legacy anomaly
// markers as a belt-and-suspenders check in case DDG ever unifies the flows.
function isCaptcha(html: string): boolean {
  return (
    html.includes('challenge-form') ||
    html.includes('Please verify you are a human') ||
    html.includes('anomaly-modal') ||
    html.includes('class="anomaly"')
  )
}

// Parses the lite SERP HTML. Each result is a triplet of `<tr>` rows:
//   1. <a class='result-link' href="…">Title</a>
//   2. <td class='result-snippet'>snippet…</td>
//   3. <span class='link-text'>display.url</span>
// Rows 2 and 3 are sometimes absent (e.g. ad placements without snippets), so
// we anchor on `result-link` and walk forward looking for the optional
// snippet within a small window. Sponsored entries are wrapped in adjacent
// rows that don't carry `result-link`, so they fall out naturally.
export function parseDdgHtml(html: string): DdgResult[] {
  const results: DdgResult[] = []
  const linkRegex = /<a\s+[^>]*href=(['"])([^'"]+)\1[^>]*class=(['"])result-link\3[^>]*>([\s\S]*?)<\/a>/g
  for (const match of html.matchAll(linkRegex)) {
    const url = decodeDdgUrl(match[2] ?? '')
    const title = stripHtml(match[4] ?? '').trim()
    if (!url || !title) continue

    const blockEnd = match.index !== undefined ? match.index + 2000 : html.length
    const blockStart = match.index !== undefined ? match.index : 0
    const window = html.slice(blockStart, blockEnd)
    const snippetMatch = /<td\s+[^>]*class=(['"])result-snippet\1[^>]*>([\s\S]*?)<\/td>/.exec(window)
    const snippet = snippetMatch ? stripHtml(snippetMatch[2] ?? '').trim() : ''

    results.push({ title, url, snippet })
  }
  return results
}

// DDG sometimes wraps result URLs in a redirect like
//   //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&rut=...
// Unwrap when present so the model sees the real destination.
function decodeDdgUrl(href: string): string {
  if (!href) return ''
  const normalized = href.startsWith('//') ? `https:${href}` : href
  try {
    const parsed = new URL(normalized)
    if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname === '/l/') {
      const inner = parsed.searchParams.get('uddg')
      if (inner) return inner
    }
    return parsed.toString()
  } catch {
    return href
  }
}

function stripHtml(input: string): string {
  return decodeEntities(input.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ')
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
}

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body] ?? whole
  })
}
