import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyReadabilityDetailed } from './readability'
import {
  applyReadabilityIsolated,
  MEMORY_RESERVE_BYTES,
  MIN_KILLABLE_CHILD_RSS_BYTES,
  readLinuxAvailableBytes,
  READABILITY_ABORT_MESSAGE,
  runReadabilityChild,
  shouldStopChild,
} from './readability-process'

const MiB = 1024 * 1024
const exhaustedMemory = { readChildRssBytes: () => 64 * 1024 * MiB, readAvailableBytes: () => 0 }

const PAGES: Record<string, string> = {
  article: `<!doctype html><html><head><title>Sample</title></head><body><nav>Home</nav><article><h1>Sample</h1>
    <p>This is a paragraph of body text that is long enough for Readability to consider it main content.</p>
    <p>A second paragraph with <a href="https://example.com/x">an inline link</a> so the heuristics fire.</p>
    <ul><li>First</li><li>Second</li></ul></article><footer>copyright</footer></body></html>`,
  cssHidden: `<html><head><style>.secret{display:none}</style></head><body><article>
    <p class="secret">hidden instructions</p><p>Visible paragraph with enough words to count as the article body text.</p>
    </article></body></html>`,
  korean: `<html><body><article><h1>한국어 문서</h1><p>${'본문 내용이 충분히 길어야 리더빌리티가 기사로 인식합니다. '.repeat(20)}</p></article></body></html>`,
  empty: '<html><body></body></html>',
  appShell: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
  malformed: '<html><body><div><p>unclosed <b>bold <i>italic</div></span>text after</body>',
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

describe('applyReadabilityIsolated', () => {
  for (const [name, html] of Object.entries(PAGES)) {
    test(`returns exactly the in-process result for the ${name} page`, async () => {
      const url = `https://example.com/${name}`
      expect(await applyReadabilityIsolated(html, url)).toEqual(await applyReadabilityDetailed(html, url))
    })
  }

  test('round-trips a result many pipe buffers long without truncation', async () => {
    const html = `<html><body><article>${'<p>Long paragraph of article body text for a large page. </p>'.repeat(5_000)}</article></body></html>`

    const isolated = await applyReadabilityIsolated(html, 'https://example.com/large')

    expect(isolated.output.length).toBeGreaterThan(256 * 1024)
    expect(isolated).toEqual(await applyReadabilityDetailed(html, 'https://example.com/large'))
  })

  test('rejects with the same error the in-process parser throws', async () => {
    const rules = Array.from({ length: 2_000 }, (_, i) => `.c${i}{color:red}`).join('')
    const html = `<html><head><style>${rules}</style></head><body><p>hi</p></body></html>`

    const inProcess = await settle(applyReadabilityDetailed(html, 'https://example.com/css'))
    const isolated = await settle(applyReadabilityIsolated(html, 'https://example.com/css'))

    expect(inProcess.ok).toBe(false)
    expect(isolated).toEqual(inProcess)
  })

  test('rejects without spawning when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(applyReadabilityIsolated(PAGES.article!, 'https://example.com/a', controller.signal)).rejects.toThrow(
      READABILITY_ABORT_MESSAGE,
    )
  })
})

describe('runReadabilityChild', () => {
  test('kills the parser when the machine is about to run out of memory', async () => {
    let pid = 0

    const outcome = await runReadabilityChild(
      { html: PAGES.article!, url: 'https://example.com/a' },
      { probe: exhaustedMemory, onSpawn: (spawned) => (pid = spawned) },
    )

    expect(outcome).toEqual({ kind: 'memory', childRssBytes: 64 * 1024 * MiB, availableBytes: 0 })
    expect(isAlive(pid)).toBe(false)
  })

  test('kills the parser when the tool call is aborted mid-parse', async () => {
    const controller = new AbortController()
    let pid = 0

    const outcome = await runReadabilityChild(
      { html: PAGES.article!, url: 'https://example.com/a' },
      {
        signal: controller.signal,
        onSpawn: (spawned) => {
          pid = spawned
          controller.abort()
        },
      },
    )

    expect(outcome).toEqual({ kind: 'aborted' })
    expect(isAlive(pid)).toBe(false)
  })

  test.skipIf(process.platform === 'win32')(
    'treats an outside SIGKILL as the kernel OOM killer choosing the parser',
    async () => {
      const outcome = await runReadabilityChild(
        { html: PAGES.article!, url: 'https://example.com/a' },
        { onSpawn: (pid) => process.kill(pid, 'SIGKILL') },
      )

      expect(outcome).toEqual({ kind: 'memory', childRssBytes: null, availableBytes: null })
    },
  )
})

describe('shouldStopChild', () => {
  test('lets a parse run while memory is available', () => {
    expect(shouldStopChild(8 * 1024 * MiB, MEMORY_RESERVE_BYTES)).toBe(false)
  })

  test('stops a large parse once available memory drops under the reserve', () => {
    expect(shouldStopChild(MIN_KILLABLE_CHILD_RSS_BYTES, MEMORY_RESERVE_BYTES - 1)).toBe(true)
  })

  test('spares a normal-sized parse when something else is exhausting memory', () => {
    expect(shouldStopChild(MIN_KILLABLE_CHILD_RSS_BYTES - 1, 0)).toBe(false)
  })

  test('never stops a parse when either reading is unavailable', () => {
    expect(shouldStopChild(null, 0)).toBe(false)
    expect(shouldStopChild(64 * 1024 * MiB, null)).toBe(false)
  })
})

describe('readLinuxAvailableBytes', () => {
  function fakeRoot(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'readability-memory-'))
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    return root
  }

  test('uses the tighter of VM MemAvailable and cgroup headroom, counting inactive page cache as free', () => {
    const root = fakeRoot({
      'proc/meminfo': 'MemTotal:       9000000 kB\nMemAvailable:    2097152 kB\n',
      'sys/fs/cgroup/memory.max': `${6 * 1024 * MiB}\n`,
      'sys/fs/cgroup/memory.current': `${5 * 1024 * MiB}\n`,
      'sys/fs/cgroup/memory.stat': `anon 1\ninactive_file ${256 * MiB}\nactive_file 2\n`,
    })
    try {
      expect(readLinuxAvailableBytes(root)).toBe(1024 * MiB + 256 * MiB)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('falls back to MemAvailable when the cgroup has no memory limit', () => {
    const root = fakeRoot({
      'proc/meminfo': 'MemAvailable:    1048576 kB\n',
      'sys/fs/cgroup/memory.max': 'max\n',
      'sys/fs/cgroup/memory.current': `${5 * 1024 * MiB}\n`,
    })
    try {
      expect(readLinuxAvailableBytes(root)).toBe(1024 * MiB)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('reports nothing when neither source exists', () => {
    const root = fakeRoot({})
    try {
      expect(readLinuxAvailableBytes(root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
