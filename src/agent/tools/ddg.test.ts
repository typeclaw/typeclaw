import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isWindows } from '@/shared'
import { waitFor } from '@/test-helpers/wait-for'

import { CurlImpersonateError } from './curl-impersonate'
import {
  _setCurlBinaryForTest,
  _setDdgPacingForTest,
  _setSearchRetryForTest,
  DDG_CONCURRENCY,
  DdgCaptchaError,
  ddgSearch,
  fetchDdgHtml,
  isTransientSearchError,
  parseDdgHtml,
} from './ddg'
import { _resetSearchCooldownsForTest } from './search-cooldown'

const onWindows = isWindows()

const REAL_RESULT_HTML = `
<html><body><table>
  <tr><td>1.&nbsp;</td>
    <td>
      <a rel="nofollow" href="https://bun.sh/" class='result-link'>Bun &mdash; A fast all-in-one JavaScript runtime</a>
    </td>
  </tr>
  <tr>
    <td class='result-snippet'>
      <b>Bun</b> is a fast, all-in-one JavaScript &amp; <b>TypeScript</b> &#x27;toolkit&#x27;.
    </td>
  </tr>
  <tr>
    <td>&nbsp;</td>
    <td>
      <span class='link-text'>bun.sh</span>
    </td>
  </tr>
  <tr><td>2.&nbsp;</td>
    <td>
      <a rel="nofollow" href="https://github.com/oven-sh/bun" class='result-link'>oven-sh/bun</a>
    </td>
  </tr>
  <tr>
    <td class='result-snippet'>
      Incredibly fast JavaScript runtime.
    </td>
  </tr>
</table></body></html>
`

describe('parseDdgHtml', () => {
  test('extracts title, url, snippet from each result block', () => {
    // when
    const results = parseDdgHtml(REAL_RESULT_HTML)

    // then
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: 'Bun — A fast all-in-one JavaScript runtime',
      url: 'https://bun.sh/',
      snippet: "Bun is a fast, all-in-one JavaScript & TypeScript 'toolkit'.",
    })
    expect(results[1]).toEqual({
      title: 'oven-sh/bun',
      url: 'https://github.com/oven-sh/bun',
      snippet: 'Incredibly fast JavaScript runtime.',
    })
  })

  test('returns an empty array when there are no result blocks', () => {
    expect(parseDdgHtml('<html><body>nothing here</body></html>')).toEqual([])
  })

  test('strips inline highlight tags and decodes HTML entities in titles and snippets', () => {
    // given
    const html = `
      <tr><td><a rel="nofollow" href="https://example.com/" class='result-link'>Foo &amp; Bar &lt;v2&gt;</a></td></tr>
      <tr><td class='result-snippet'>A &quot;quoted&quot; <b>snippet</b> with &#39;apostrophe&#39;.</td></tr>
    `

    // when
    const results = parseDdgHtml(html)

    // then
    expect(results[0]?.title).toBe('Foo & Bar <v2>')
    expect(results[0]?.snippet).toBe('A "quoted" snippet with \'apostrophe\'.')
  })

  test('unwraps DDG redirect URLs (//duckduckgo.com/l/?uddg=...)', () => {
    // given
    const html = `
      <tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fpath&rut=abc" class='result-link'>Real Site</a></td></tr>
      <tr><td class='result-snippet'>snippet</td></tr>
    `

    // when
    const results = parseDdgHtml(html)

    // then
    expect(results[0]?.url).toBe('https://real.example/path')
  })

  test('keeps results that have no snippet (snippet is optional in lite SERPs)', () => {
    // given: a single result with no following result-snippet row
    const html = `
      <tr><td><a rel="nofollow" href="https://valid.example/" class='result-link'>Valid</a></td></tr>
    `

    // when
    const results = parseDdgHtml(html)

    // then
    expect(results).toHaveLength(1)
    expect(results[0]?.title).toBe('Valid')
    expect(results[0]?.url).toBe('https://valid.example/')
    expect(results[0]?.snippet).toBe('')
  })

  test('skips snippet rows that have no preceding result-link (defensive against malformed responses)', () => {
    // given
    const html = `
      <tr><td class='result-snippet'>orphan snippet with no link</td></tr>
      <tr><td><a rel="nofollow" href="https://valid.example/" class='result-link'>Valid</a></td></tr>
      <tr><td class='result-snippet'>real snippet</td></tr>
    `

    // when
    const results = parseDdgHtml(html)

    // then
    expect(results).toHaveLength(1)
    expect(results[0]).toEqual({
      title: 'Valid',
      url: 'https://valid.example/',
      snippet: 'real snippet',
    })
  })
})

// POSIX-only fake shell binary without .exe/.cmd; Windows cannot spawn it (#899).
describe.skipIf(onWindows)('fetchDdgHtml', () => {
  // We test the curl-impersonate spawn path against a fake binary in a
  // tmpdir. AGENTS.md §5 prefers real implementations with controlled inputs
  // over mocks, so we hand-roll a shell script that stands in for
  // curl_chrome136 — this exercises the actual `spawn` codepath, including
  // exit-code handling, stdout/stderr piping, and abort propagation.
  let scratchDir: string

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'ddg-fetch-test-'))
  })

  afterEach(() => {
    _setCurlBinaryForTest(null)
    rmSync(scratchDir, { recursive: true, force: true })
  })

  function installFakeBinary(script: string): void {
    const path = join(scratchDir, 'fake-curl')
    writeFileSync(path, `#!/bin/sh\n${script}\n`, 'utf8')
    chmodSync(path, 0o755)
    _setCurlBinaryForTest(path)
  }

  // The fake binary must round-trip the per-request random sentinel from
  // curl's `-w` argument back to stdout (otherwise the primitive rejects
  // the output as corrupted). See fetch.test.ts for the rationale.
  const FAKE_CURL_BODY = (body: string) => `
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
RENDERED=$(printf '%s' "$WTPL" | sed -e 's/%{http_code}/200/' -e 's|%{url_effective}|https://lite.duckduckgo.com/lite/|' -e 's|%{content_type}|text/html|' -e 's/%{size_download}/${body.length}/')
printf '%s' '${body}'
printf '%s' "$RENDERED"
`

  test('returns stdout verbatim on exit 0', async () => {
    // given: fake binary that prints a fixed HTML body + the sentinel
    installFakeBinary(FAKE_CURL_BODY('<html>hello world</html>'))

    // when
    const html = await fetchDdgHtml('ignored')

    // then
    expect(html).toBe('<html>hello world</html>')
  })

  test('rejects with stderr detail when the binary exits non-zero', async () => {
    // given
    installFakeBinary('echo "boom" >&2; exit 7')

    // when / then
    await expect(fetchDdgHtml('q')).rejects.toThrow(/curl-impersonate exited 7/)
    await expect(fetchDdgHtml('q')).rejects.toThrow(/boom/)
  })

  test('reports "no stderr" when the binary fails silently', async () => {
    // given
    installFakeBinary('exit 1')

    // when / then
    await expect(fetchDdgHtml('q')).rejects.toThrow(/exited 1.*no stderr/)
  })

  test('passes query as POST form data with --data-urlencode', async () => {
    // given: fake binary records argv AND emits the required sentinel
    const argvFile = join(scratchDir, 'argv.txt')
    installFakeBinary(`printf '%s\\n' "$@" > ${argvFile}\n${FAKE_CURL_BODY('')}`)

    // when
    await fetchDdgHtml('hello world')

    // then
    const argv = (await Bun.file(argvFile).text()).split('\n')
    expect(argv).toContain('-X')
    expect(argv).toContain('POST')
    expect(argv).toContain('--data-urlencode')
    expect(argv).toContain('q=hello world')
    expect(argv).toContain('https://lite.duckduckgo.com/lite/')
  })

  test('aborts when the AbortSignal fires', async () => {
    // given: fake binary sleeps long enough that we always abort first
    installFakeBinary('sleep 30')
    const controller = new AbortController()

    // when
    const promise = fetchDdgHtml('q', controller.signal)
    setTimeout(() => controller.abort(), 50)

    // then
    await expect(promise).rejects.toThrow()
  })
})

// Use double-quoted class attrs so the bodies embed cleanly inside the shell
// fake's single-quoted printf (the lite SERP markup uses single quotes, but the
// parser accepts either quote style).
const RESULT_SERP = `<tr><td><a href="https://ok.example/" class="result-link">OK</a></td></tr>`
const CAPTCHA_SERP = `<form id="challenge-form">Please verify you are a human</form>`

// Emits a per-call body chosen by a counter file, plus the per-request random
// sentinel round-tripped from `-w` (the primitive rejects output without it).
function fakeCurlSwitching(scratchDir: string, captchaBody: string, okBody: string): string {
  const counter = join(scratchDir, 'count')
  return `
WTPL=""
i=1
for arg in "$@"; do
  if [ "$arg" = "-w" ]; then j=$((i + 1)); eval "WTPL=\\"\\\${$j}\\""; break; fi
  i=$((i + 1))
done
N=$(cat ${counter} 2>/dev/null || echo 0)
echo $((N + 1)) > ${counter}
RENDERED=$(printf '%s' "$WTPL" | sed -e 's/%{http_code}/200/' -e 's|%{url_effective}|https://lite.duckduckgo.com/lite/|' -e 's|%{content_type}|text/html|' -e 's/%{size_download}/0/')
if [ "$N" -lt 1 ]; then printf '%s' '${captchaBody}'; else printf '%s' '${okBody}'; fi
printf '%s' "$RENDERED"
`
}

describe.skipIf(onWindows)('ddgSearch (retry + concurrency)', () => {
  let scratchDir: string

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'ddg-search-test-'))
    _setSearchRetryForTest({ attempts: 3, sleep: async () => {} })
    _setDdgPacingForTest({ intervalMs: 0 })
    _resetSearchCooldownsForTest()
  })

  afterEach(() => {
    _setCurlBinaryForTest(null)
    _setSearchRetryForTest(null)
    _setDdgPacingForTest(null)
    _resetSearchCooldownsForTest()
    rmSync(scratchDir, { recursive: true, force: true })
  })

  function installFakeBinary(script: string): void {
    const path = join(scratchDir, 'fake-curl')
    writeFileSync(path, `#!/bin/sh\n${script}\n`, 'utf8')
    chmodSync(path, 0o755)
    _setCurlBinaryForTest(path)
  }

  test('a CAPTCHA is not retried and starts a cooldown that sends no requests until it ends', async () => {
    // given: every profile is challenged until an "ok" flag file appears
    let clock = 0
    _setDdgPacingForTest({ intervalMs: 0, now: () => clock })
    _resetSearchCooldownsForTest(() => clock)
    const counter = join(scratchDir, 'count')
    const okFlag = join(scratchDir, 'ok')
    installFakeBinary(`
WTPL=""
i=1
for arg in "$@"; do
  if [ "$arg" = "-w" ]; then j=$((i + 1)); eval "WTPL=\\"\\\${$j}\\""; break; fi
  i=$((i + 1))
done
N=$(cat ${counter} 2>/dev/null || echo 0)
echo $((N + 1)) > ${counter}
RENDERED=$(printf '%s' "$WTPL" | sed -e 's/%{http_code}/200/' -e 's|%{url_effective}|https://lite.duckduckgo.com/lite/|' -e 's|%{content_type}|text/html|' -e 's/%{size_download}/0/')
if [ -f ${okFlag} ]; then printf '%s' '${RESULT_SERP}'; else printf '%s' '${CAPTCHA_SERP}'; fi
printf '%s' "$RENDERED"
`)

    // when: the first search is challenged on every profile
    await expect(ddgSearch('q', 10)).rejects.toBeInstanceOf(DdgCaptchaError)

    // then: one request per profile, no retries
    expect(await Bun.file(counter).text()).toBe('2\n')

    // when: a search inside the cooldown, even after DDG would answer again
    writeFileSync(okFlag, '', 'utf8')
    clock = 59_999

    // then: fails fast without touching the network
    await expect(ddgSearch('q', 10)).rejects.toBeInstanceOf(DdgCaptchaError)
    expect(await Bun.file(counter).text()).toBe('2\n')

    // when: the cooldown has elapsed
    clock = 60_000
    const results = await ddgSearch('q', 10)

    // then: searches resume normally
    expect(results[0]?.url).toBe('https://ok.example/')
    expect(await Bun.file(counter).text()).toBe('3\n')
  })

  test('a search waiting for its request slot sends nothing once a concurrent search starts the cooldown', async () => {
    // given: every response is a CAPTCHA, and each pacing wait is held until released
    const held: Array<() => void> = []
    _setDdgPacingForTest({
      intervalMs: 1_000,
      now: () => 0,
      sleep: () => new Promise<void>((resolve) => held.push(resolve)),
    })
    const counter = join(scratchDir, 'count')
    installFakeBinary(fakeCurlSwitching(scratchDir, CAPTCHA_SERP, CAPTCHA_SERP))

    // when: A sends its first profile while B waits for a slot, then A waits for its second
    const a = ddgSearch('a', 10)
    const b = ddgSearch('b', 10)
    await waitFor(() => held.length === 2, { description: 'B and A second-profile waits are queued' })

    // when: A's second profile is challenged and starts the cooldown
    held[1]?.()
    await expect(a).rejects.toBeInstanceOf(DdgCaptchaError)
    expect(await Bun.file(counter).text()).toBe('2\n')

    // then: releasing B's wait sends no request
    held[0]?.()
    await expect(b).rejects.toBeInstanceOf(DdgCaptchaError)
    expect(await Bun.file(counter).text()).toBe('2\n')
  })

  test('spaces a burst of searches by the minimum request interval, without delaying the first', async () => {
    // given: a frozen clock and a sleep that records each requested wait
    const waits: number[] = []
    _setDdgPacingForTest({ intervalMs: 1_000, now: () => 0, sleep: async (ms) => void waits.push(ms) })
    installFakeBinary(fakeCurlSwitching(scratchDir, RESULT_SERP, RESULT_SERP))

    // when: three searches fire at once
    const results = await Promise.all([ddgSearch('a', 10), ddgSearch('b', 10), ddgSearch('c', 10)])

    // then: all succeed, the first goes out immediately, the rest queue one interval apart
    expect(results.every((r) => r[0]?.url === 'https://ok.example/')).toBe(true)
    expect(waits.sort((x, y) => x - y)).toEqual([1_000, 2_000])
  })

  test('falls back to the next impersonation profile within one attempt when the first is challenged', async () => {
    // given: a single attempt, first profile gets a CAPTCHA, the next a SERP
    _setSearchRetryForTest({ attempts: 1, sleep: async () => {} })
    installFakeBinary(fakeCurlSwitching(scratchDir, CAPTCHA_SERP, RESULT_SERP))

    // when
    const results = await ddgSearch('q', 10)

    // then
    expect(results[0]?.url).toBe('https://ok.example/')
  })

  test('reports a CAPTCHA only when every impersonation profile is challenged', async () => {
    // given: a single attempt and every response is a CAPTCHA
    _setSearchRetryForTest({ attempts: 1, sleep: async () => {} })
    installFakeBinary(fakeCurlSwitching(scratchDir, CAPTCHA_SERP, CAPTCHA_SERP))

    // when / then
    await expect(ddgSearch('q', 10)).rejects.toBeInstanceOf(DdgCaptchaError)
  })

  test('retries past a transient connection timeout (curl exit 28) and returns results', async () => {
    // given: first spawn exits 28 (curl connection timeout), the next serves a SERP
    const counter = join(scratchDir, 'count')
    installFakeBinary(`
WTPL=""
i=1
for arg in "$@"; do
  if [ "$arg" = "-w" ]; then j=$((i + 1)); eval "WTPL=\\"\\\${$j}\\""; break; fi
  i=$((i + 1))
done
N=$(cat ${counter} 2>/dev/null || echo 0)
echo $((N + 1)) > ${counter}
if [ "$N" -lt 1 ]; then echo "curl: (28) Connection timed out after 30000 milliseconds" >&2; exit 28; fi
RENDERED=$(printf '%s' "$WTPL" | sed -e 's/%{http_code}/200/' -e 's|%{url_effective}|https://lite.duckduckgo.com/lite/|' -e 's|%{content_type}|text/html|' -e 's/%{size_download}/0/')
printf '%s' '${RESULT_SERP}'
printf '%s' "$RENDERED"
`)

    // when
    const results = await ddgSearch('q', 10)

    // then
    expect(results).toHaveLength(1)
    expect(results[0]?.url).toBe('https://ok.example/')
  })

  test('gives up after the bounded attempts when the timeout never clears', async () => {
    // given: every spawn exits 28, so no attempt ever succeeds
    installFakeBinary('echo "curl: (28) Connection timed out after 30000 milliseconds" >&2; exit 28')

    // when / then: the error propagates (bounded, not an infinite loop) as a curl timeout
    await expect(ddgSearch('q', 10)).rejects.toThrow(/exited 28/)
  })

  test('does NOT retry a hard network failure (non-timeout exit code)', async () => {
    // given: a fake binary that fails with a non-timeout code on every call
    const counter = join(scratchDir, 'count-hard')
    installFakeBinary(
      `N=$(cat ${counter} 2>/dev/null || echo 0); echo $((N + 1)) > ${counter}; echo "boom" >&2; exit 7`,
    )

    // when / then: surfaces immediately without burning the retry budget
    await expect(ddgSearch('q', 10)).rejects.toThrow(/exited 7/)
    expect(await Bun.file(join(scratchDir, 'count-hard')).text()).toBe('1\n')
  })

  test('caps concurrent ddgSearch calls at DDG_CONCURRENCY across the process', async () => {
    // given: each spawn marks itself with a per-pid file and holds the slot
    // until released. Per-spawn marker files make the live count race-free —
    // the prior shared-counter version lost increments to a read-modify-write
    // race under contention (a fixed `sleep 0.3` overlap window also flaked on
    // slow runners). This mirrors the marker-file technique the abort test below
    // already uses.
    const liveDir = join(scratchDir, 'live')
    const releaseFile = join(scratchDir, 'release')
    installFakeBinary(`
WTPL=""
i=1
for arg in "$@"; do
  if [ "$arg" = "-w" ]; then j=$((i + 1)); eval "WTPL=\\"\\\${$j}\\""; break; fi
  i=$((i + 1))
done
mkdir -p ${liveDir}
: > ${liveDir}/live.$$
while [ ! -f ${releaseFile} ]; do sleep 0.02; done
rm -f ${liveDir}/live.$$
RENDERED=$(printf '%s' "$WTPL" | sed -e 's/%{http_code}/200/' -e 's|%{url_effective}|https://lite.duckduckgo.com/lite/|' -e 's|%{content_type}|text/html|' -e 's/%{size_download}/0/')
printf '%s' '${RESULT_SERP}'
printf '%s' "$RENDERED"
`)

    const countLive = async (): Promise<number> => {
      if (!existsSync(liveDir)) return 0
      const glob = new Bun.Glob('live.*')
      let n = 0
      for await (const _ of glob.scan({ cwd: liveDir })) n++
      return n
    }

    // when: fire 5 searches at once through the shared process-wide limiter and
    // hold every admitted slot, so the live count reaches its true peak before
    // any slot frees
    const searches = Promise.all(Array.from({ length: 5 }, () => ddgSearch('q', 10)))
    let peak = 0
    await waitFor(
      async () => {
        const live = await countLive()
        if (live > peak) peak = live
        return live >= DDG_CONCURRENCY
      },
      { description: 'live spawns reach DDG_CONCURRENCY' },
    )

    // then: never more than DDG_CONCURRENCY ran the curl spawn simultaneously
    expect(peak).toBeLessThanOrEqual(DDG_CONCURRENCY)
    expect(peak).toBeGreaterThan(0)

    // cleanup: release the held slots so the searches finish
    writeFileSync(releaseFile, 'go', 'utf8')
    await searches
  })

  test('a queued ddgSearch aborted before a slot frees rejects without spawning curl', async () => {
    // given: a fake binary that records each spawn as its own marker file (so
    // counting is free of the read-modify-write race a shared counter has) and
    // blocks on a release file so the DDG_CONCURRENCY admitted calls hold slots
    const spawnDir = join(scratchDir, 'spawns')
    const releaseFile = join(scratchDir, 'release')
    installFakeBinary(`
WTPL=""
i=1
for arg in "$@"; do
  if [ "$arg" = "-w" ]; then j=$((i + 1)); eval "WTPL=\\"\\\${$j}\\""; break; fi
  i=$((i + 1))
done
mkdir -p ${spawnDir}
: > ${spawnDir}/spawn.$$
while [ ! -f ${releaseFile} ]; do sleep 0.02; done
RENDERED=$(printf '%s' "$WTPL" | sed -e 's/%{http_code}/200/' -e 's|%{url_effective}|https://lite.duckduckgo.com/lite/|' -e 's|%{content_type}|text/html|' -e 's/%{size_download}/0/')
printf '%s' '${RESULT_SERP}'
printf '%s' "$RENDERED"
`)

    const countSpawns = async (): Promise<number> => {
      if (!existsSync(spawnDir)) return 0
      const glob = new Bun.Glob('spawn.*')
      let n = 0
      for await (const _ of glob.scan({ cwd: spawnDir })) n++
      return n
    }

    // when: saturate every slot, then queue one more with a signal and abort it
    const saturating = Array.from({ length: DDG_CONCURRENCY }, () => ddgSearch('q', 10))
    while ((await countSpawns()) < DDG_CONCURRENCY) {
      await Bun.sleep(10)
    }
    const controller = new AbortController()
    const queued = ddgSearch('q', 10, controller.signal)
    await Bun.sleep(20)
    controller.abort()

    // then: the queued call rejected and never spawned curl (count stayed at DDG_CONCURRENCY)
    await expect(queued).rejects.toThrow()
    expect(await countSpawns()).toBe(DDG_CONCURRENCY)

    // cleanup: release the held slots so the saturating calls finish
    writeFileSync(releaseFile, 'go', 'utf8')
    await Promise.all(saturating)
  })
})

describe('isTransientSearchError', () => {
  test('a CAPTCHA is NOT retried (the cooldown handles it)', () => {
    expect(isTransientSearchError(new DdgCaptchaError())).toBe(false)
  })

  test('a curl connection timeout (exit 28) is transient', () => {
    const err = new CurlImpersonateError('curl-impersonate exited 28: timed out', 28, 'timed out')
    expect(isTransientSearchError(err)).toBe(true)
  })

  test('a hard curl failure (non-timeout exit) is NOT transient', () => {
    const err = new CurlImpersonateError('curl-impersonate exited 7: refused', 7, 'refused')
    expect(isTransientSearchError(err)).toBe(false)
  })

  test('an arbitrary error is NOT transient', () => {
    expect(isTransientSearchError(new Error('parse failed'))).toBe(false)
  })
})
