import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isWindows } from '@/shared'

import { _setCurlBinaryForTest, _setDdgPacingForTest, _setSearchRetryForTest } from './ddg'
import { _setExaPacingForTest } from './exa'
import { _resetSearchCooldownsForTest, activeCooldown, recordEngineBlock } from './search-cooldown'
import { webSearchTool } from './websearch'

const onWindows = isWindows()

type FetchInput = Parameters<typeof fetch>[0]
type FetchArgs = { url: string; init: RequestInit | undefined }
let fetchCalls: FetchArgs[]
let fetchResponse: (args: FetchArgs) => Response | Promise<Response>
const originalFetch = globalThis.fetch

beforeEach(() => {
  fetchCalls = []
  _resetSearchCooldownsForTest()
  _setExaPacingForTest({ intervalMs: 0 })
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const args = { url, init }
    fetchCalls.push(args)
    return fetchResponse(args)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  _resetSearchCooldownsForTest()
  _setExaPacingForTest(null)
})

const ctx = {} as Parameters<typeof webSearchTool.execute>[4]

function textOf(result: Awaited<ReturnType<typeof webSearchTool.execute>>): string {
  return result.content[0]?.type === 'text' ? result.content[0].text : ''
}

function exaResponse(text: string): Response {
  const message = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } }
  return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const EXA_HIT = 'Title: Bun docs\nURL: https://bun.sh/docs\nPublished: N/A\nAuthor: N/A\nHighlights:\nBun is a runtime.'

describe('websearch tool: web (Exa first)', () => {
  test('answers from Exa without touching DuckDuckGo, and reminds the model to cite sources', async () => {
    // given
    fetchResponse = () => exaResponse(EXA_HIT)

    // when
    const result = await webSearchTool.execute('id', { query: 'bun' }, undefined, undefined, ctx)

    // then
    const text = textOf(result)
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]?.url).toContain('mcp.exa.ai')
    expect(text).toContain('Search results for "bun" (web via Exa, 1)')
    expect(text).toContain('https://bun.sh/docs')
    expect(text).not.toContain('Routing attempts')
    expect(text.endsWith('Cite the URLs you rely on from these results as sources in your answer.')).toBe(true)
    expect((result.details as { engine?: string }).engine).toBe('Exa')
  })

  test('returns the terminal "do not retry" contract without any request when every engine is cooling down', async () => {
    // given
    recordEngineBlock('exa', 'rate_limited')
    recordEngineBlock('ddg', 'challenge')
    fetchResponse = () => new Response('should not be called', { status: 500 })

    // when
    const result = await webSearchTool.execute('id', { query: 'q' }, undefined, undefined, ctx)

    // then
    const text = textOf(result)
    expect(fetchCalls).toHaveLength(0)
    expect(text).toContain('Exa skipped (cooling down for 60s after a rate limit)')
    expect(text).toContain('DuckDuckGo skipped (cooling down for 60s after a bot challenge)')
    expect(text).toContain('Do not retry this tool now')
    expect((result.details as { error?: boolean }).error).toBe(true)
  })
})

const MINIMAL_DDG_HTML = `
<tr><td><a rel="nofollow" href="https://example.com/" class='result-link'>Example Domain</a></td></tr>
<tr><td class='result-snippet'>Example snippet text.</td></tr>
`

// The DuckDuckGo source talks to curl-impersonate via Bun.spawn rather than
// fetch. We install a fake binary at a tmpdir path and point ddg.ts at it
// via _setCurlBinaryForTest, so these end-to-end tests exercise the real
// spawn codepath plus the webSearchTool's success/error orchestration
// without depending on a real network or a real curl_chrome136 install.
// POSIX-only fake shell binary without .exe/.cmd; Windows cannot spawn it (#899).
describe.skipIf(onWindows)('websearch tool: web (DuckDuckGo fallback)', () => {
  let scratchDir: string

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'websearch-test-'))
    // Exa fails without pausing itself, so every search here falls through to DuckDuckGo.
    fetchResponse = () => new Response('upstream error', { status: 500 })
    // Collapse the production CAPTCHA backoff so the retry path doesn't burn
    // real seconds: one attempt, zero-delay sleep.
    _setSearchRetryForTest({ attempts: 1, sleep: async () => {} })
    _setDdgPacingForTest({ intervalMs: 0 })
  })

  afterEach(() => {
    _setCurlBinaryForTest(null)
    _setSearchRetryForTest(null)
    _setDdgPacingForTest(null)
    rmSync(scratchDir, { recursive: true, force: true })
  })

  function installFakeBinary(script: string): void {
    const path = join(scratchDir, 'fake-curl')
    writeFileSync(path, `#!/bin/sh\n${script}\n`, 'utf8')
    chmodSync(path, 0o755)
    _setCurlBinaryForTest(path)
  }

  // Emits a body plus the per-request random sentinel + fake metadata,
  // mirroring how a real curl-impersonate response is shaped. The sentinel
  // is round-tripped from argv (the value of -w) because we can't predict
  // its random value. See fetch.test.ts for the full rationale.
  function installFakePrintingBinary(body: string): void {
    installFakeBinary(`
WTPL=""
i=1
for arg in "$@"; do
  if [ "$arg" = "-w" ]; then
    j=$((i + 1))
    eval "WTPL=\\"\\\${$j}\\""
    break
  fi
  i=$((i + 1))
done
RENDERED=$(printf '%s' "$WTPL" | sed -e 's/%{http_code}/200/' -e 's|%{url_effective}|https://lite.duckduckgo.com/lite/|' -e 's|%{content_type}|text/html|' -e 's/%{size_download}/0/')
cat <<'TYPECLAW_EOF'
${body}
TYPECLAW_EOF
printf '%s' "$RENDERED"
`)
  }

  test('falls back to DuckDuckGo when Exa fails and names the failed engine', async () => {
    // given
    installFakePrintingBinary(MINIMAL_DDG_HTML)

    // when
    const result = await webSearchTool.execute('id', { query: 'example' }, undefined, undefined, ctx)

    // then
    const text = textOf(result)
    expect(text).toContain('Search results for "example" (web via DuckDuckGo, 1)')
    expect(text).toContain('Routing attempts: Exa failed: Exa HTTP 500: upstream error -> DuckDuckGo 1 result')
    expect(text).toContain('Example Domain')
    expect(text).toContain('https://example.com/')
    expect(text).toContain('Example snippet text.')

    const details = result.details as { source: string; count: number; engine?: string }
    expect(details.source).toBe('web')
    expect(details.count).toBe(1)
    expect(details.engine).toBe('DuckDuckGo')
  })

  test('skips Exa without a request while it is cooling down', async () => {
    // given
    recordEngineBlock('exa', 'rate_limited')
    installFakePrintingBinary(MINIMAL_DDG_HTML)

    // when
    const result = await webSearchTool.execute('id', { query: 'example' }, undefined, undefined, ctx)

    // then
    expect(fetchCalls).toHaveLength(0)
    expect(textOf(result)).toContain(
      'Routing attempts: Exa skipped (cooling down for 60s after a rate limit) -> DuckDuckGo 1 result',
    )
  })

  test('an exhausted CAPTCHA returns the terminal "do not retry" contract (no "try again")', async () => {
    // given: Exa is rate-limited and every DuckDuckGo attempt serves the challenge-form CAPTCHA marker
    fetchResponse = () => new Response('slow down', { status: 429 })
    installFakePrintingBinary('<form id="challenge-form">Please verify you are a human</form>')

    // when
    const result = await webSearchTool.execute('id', { query: 'spam' }, undefined, undefined, ctx)

    // then: unified terminal contract — tells the model to stop, not to vary queries
    const text = textOf(result)
    expect(text).toContain('Do not retry this tool now')
    expect(text).toContain('report what you already have')
    expect(text).not.toMatch(/try again/i)
    expect((result.details as { error?: boolean }).error).toBe(true)
    expect(activeCooldown('exa')).toBeDefined()
    expect(activeCooldown('ddg')).toBeDefined()
  })

  test('an Exa 5xx followed by a DuckDuckGo CAPTCHA keeps the terminal contract', async () => {
    // given
    fetchResponse = () => new Response('unavailable', { status: 503 })
    installFakePrintingBinary('<form id="challenge-form">Please verify you are a human</form>')

    // when
    const result = await webSearchTool.execute('id', { query: 'q' }, undefined, undefined, ctx)

    // then
    const text = textOf(result)
    expect(text).toContain('Exa failed: Exa HTTP 503')
    expect(text).toContain('Do not retry this tool now')
    expect(activeCooldown('exa')).toBeUndefined()
  })

  test('an exhausted connection timeout (curl exit 28) returns the same terminal contract', async () => {
    // given: Exa is rate-limited and every DuckDuckGo attempt times out at the curl layer
    fetchResponse = () => new Response('slow down', { status: 429 })
    installFakeBinary('echo "curl: (28) Connection timed out after 30000 milliseconds" >&2; exit 28')

    // when
    const result = await webSearchTool.execute('id', { query: 'x' }, undefined, undefined, ctx)

    // then
    const text = textOf(result)
    expect(text).toContain('Do not retry this tool now')
    expect(text).toContain('report what you already have')
    expect(text).not.toMatch(/try again/i)
    expect((result.details as { error?: boolean }).error).toBe(true)
  })

  test('returns a clear error on spawn failure (does not throw)', async () => {
    // given: fake binary that exits non-zero with a known stderr signature
    installFakeBinary('echo "ECONNREFUSED" >&2; exit 1')

    // when
    const result = await webSearchTool.execute('id', { query: 'x' }, undefined, undefined, ctx)

    // then
    const text = textOf(result)
    expect(text).toContain('Search failed')
    expect(text).toContain('Exa failed: Exa HTTP 500')
    expect(text).toContain('ECONNREFUSED')
  })

  test('returns a "no results" message when every engine answers with nothing', async () => {
    // given
    fetchResponse = () => exaResponse('')
    installFakePrintingBinary('<html><body>nothing</body></html>')

    // when
    const result = await webSearchTool.execute('id', { query: 'zzznoresults' }, undefined, undefined, ctx)

    // then
    const text = textOf(result)
    expect(text).toBe('No results for "zzznoresults" on web.')
    expect((result.details as { count: number }).count).toBe(0)
  })

  test('respects the limit parameter', async () => {
    // given: 3 results in the SERP, ask for 2
    const html = `
      <tr><td><a href="https://a/" class='result-link'>A</a></td></tr>
      <tr><td class='result-snippet'>a</td></tr>
      <tr><td><a href="https://b/" class='result-link'>B</a></td></tr>
      <tr><td class='result-snippet'>b</td></tr>
      <tr><td><a href="https://c/" class='result-link'>C</a></td></tr>
      <tr><td class='result-snippet'>c</td></tr>
    `
    installFakePrintingBinary(html)

    // when
    const result = await webSearchTool.execute('id', { query: 'q', limit: 2 }, undefined, undefined, ctx)

    // then
    expect((result.details as { count: number }).count).toBe(2)
  })
})

describe('websearch tool: wikipedia', () => {
  test('routes wikipedia source to the OpenSearch JSON API', async () => {
    // given
    const json = ['ts', ['TypeScript'], [''], ['https://en.wikipedia.org/wiki/TypeScript']]
    fetchResponse = () =>
      new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })

    // when
    const result = await webSearchTool.execute('id', { query: 'ts', source: 'wikipedia' }, undefined, undefined, ctx)

    // then
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]?.url).toContain('en.wikipedia.org/w/api.php')
    expect(fetchCalls[0]?.url).toContain('action=opensearch')
    expect(fetchCalls[0]?.url).toContain('search=ts')

    const text = textOf(result)
    expect(text).toContain('Search results for "ts" (wikipedia, 1)')
    expect(text).toContain('TypeScript')
    expect((result.details as { source: string }).source).toBe('wikipedia')
  })
})

describe('websearch tool: input handling', () => {
  test('rejects an empty query before hitting the network', async () => {
    fetchResponse = () => new Response('should not be called', { status: 500 })

    const result = await webSearchTool.execute('id', { query: '   ' }, undefined, undefined, ctx)

    const text = textOf(result)
    expect(text).toBe('Query is empty.')
    expect(fetchCalls).toHaveLength(0)
  })
})
