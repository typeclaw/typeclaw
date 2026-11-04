import { describe, expect, test } from 'bun:test'

// Regression guard for the idle-load contract this PR establishes: the heavy
// HTML/JSON parsers (jsdom + readability + turndown, cheerio, jq-wasm) must NOT
// be pulled into the process at module-evaluation time. agent/index.ts statically
// imports webfetch/tool.ts, which imports every strategy, so a top-level `import`
// of any parser would drag it onto every agent boot even when web_fetch is never
// called. Making the existing behavior tests async does not catch that: they would
// still pass with the imports restored to eager. Each case runs in a child bun
// process that mock.modules the heavy specifiers — a child process avoids Bun's
// process-global mock.module leakage into sibling tests. Mirrors
// vector/embedder-lazy-load.test.ts.

const HEAVY_SPECIFIERS = ['jsdom', '@mozilla/readability', 'turndown', 'cheerio', 'jq-wasm'] as const

function runChild(script: string): { exitCode: number | null; output: string } {
  const result = Bun.spawnSync({
    timeout: 30_000,
    cmd: [process.execPath, '--eval', script],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = new TextDecoder().decode(result.stderr) || new TextDecoder().decode(result.stdout)
  return { exitCode: result.exitCode, output }
}

function moduleUrl(relative: string): string {
  return `${new URL(relative, import.meta.url).href}?lazy=${crypto.randomUUID()}`
}

// Each heavy specifier is mocked to record its request into `requested` and then
// throw on any property access, so a dependency that is merely imported (deferred
// or eager) is recorded, while nothing downstream can actually use the fake.
function recordingMocks(): string {
  return HEAVY_SPECIFIERS.map(
    (spec) => `
      mock.module(${JSON.stringify(spec)}, () => {
        requested.add(${JSON.stringify(spec)})
        return new Proxy({}, { get: () => { throw new Error(${JSON.stringify(`${spec} used`)}) } })
      })`,
  ).join('\n')
}

describe('web_fetch strategy lazy loading', () => {
  test('importing the web_fetch tool evaluates none of the heavy parser modules', () => {
    const toolUrl = moduleUrl('../tool.ts')
    const script = `
      import { mock } from 'bun:test'
      const requested = new Set()
      ${recordingMocks()}
      await import(${JSON.stringify(toolUrl)})
      if (requested.size > 0) {
        console.error('eagerly requested: ' + [...requested].join(', '))
        process.exit(1)
      }
    `
    const { exitCode, output } = runChild(script)
    expect(exitCode, output).toBe(0)
  })

  test('applyReadability lazily loads jsdom/readability/turndown and nothing else', () => {
    const { exitCode, output } = runChild(
      strategyProbe(
        './readability.ts',
        'applyReadability',
        ['<html><body><p>hi</p></body></html>', 'https://example.com'],
        {
          expected: ['jsdom', '@mozilla/readability', 'turndown'],
          forbidden: ['cheerio', 'jq-wasm'],
        },
      ),
    )
    expect(exitCode, output).toBe(0)
  })

  test('applySelector lazily loads cheerio and nothing else', () => {
    const { exitCode, output } = runChild(
      strategyProbe('./selector.ts', 'applySelector', ['<html><body><p>hi</p></body></html>', 'p'], {
        expected: ['cheerio'],
        forbidden: ['jsdom', '@mozilla/readability', 'turndown', 'jq-wasm'],
      }),
    )
    expect(exitCode, output).toBe(0)
  })

  test('applySnapshot lazily loads cheerio and nothing else', () => {
    const { exitCode, output } = runChild(
      strategyProbe('./snapshot.ts', 'applySnapshot', ['<html><body><main><h1>hi</h1></main></body></html>'], {
        expected: ['cheerio'],
        forbidden: ['jsdom', '@mozilla/readability', 'turndown', 'jq-wasm'],
      }),
    )
    expect(exitCode, output).toBe(0)
  })

  test('applyJq lazily loads jq-wasm and nothing else', () => {
    const { exitCode, output } = runChild(
      strategyProbe('./jq.ts', 'applyJq', ['{"a":1}', '.a'], {
        expected: ['jq-wasm'],
        forbidden: ['jsdom', '@mozilla/readability', 'turndown', 'cheerio'],
      }),
    )
    expect(exitCode, output).toBe(0)
  })
})

// Proves two things per strategy: (1) importing the strategy module requests no
// heavy specifier (laziness), and (2) invoking the function requests exactly its
// own dependencies and none of the others. The fake parsers throw when used, so
// the invocation is wrapped in try/catch — we assert on which specifiers were
// requested, not on the parse result.
function strategyProbe(
  relativeModule: string,
  fn: string,
  args: readonly string[],
  contract: { expected: readonly string[]; forbidden: readonly string[] },
): string {
  const strategyUrl = moduleUrl(relativeModule)
  return `
    import { mock } from 'bun:test'
    const requested = new Set()
    ${recordingMocks()}
    const mod = await import(${JSON.stringify(strategyUrl)})
    if (requested.size > 0) {
      console.error('requested during module import: ' + [...requested].join(', '))
      process.exit(1)
    }
    try { await mod[${JSON.stringify(fn)}](${args.map((a) => JSON.stringify(a)).join(', ')}) } catch {}
    const expected = ${JSON.stringify(contract.expected)}
    const forbidden = ${JSON.stringify(contract.forbidden)}
    for (const spec of expected) {
      if (!requested.has(spec)) { console.error('expected but not loaded: ' + spec); process.exit(1) }
    }
    for (const spec of forbidden) {
      if (requested.has(spec)) { console.error('forbidden but loaded: ' + spec); process.exit(1) }
    }
  `
}
