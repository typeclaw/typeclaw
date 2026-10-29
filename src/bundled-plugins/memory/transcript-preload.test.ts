import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildTranscriptPreload,
  PRELOAD_MAX_BYTES,
  PRELOAD_OVERHEAD_TOKENS,
  preloadBudgetBytes,
} from './transcript-preload'

function transcript(lines: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'preload-')), 't.jsonl')
  writeFileSync(path, lines.map((l) => `${l}\n`).join(''))
  return path
}

const entry = (id: string, text = 'hi') => JSON.stringify({ type: 'message', id, message: { text } })

describe('preloadBudgetBytes', () => {
  test('caps at the fixed maximum for large-context models', () => {
    expect(preloadBudgetBytes([{ contextWindow: 1_000_000, outputTokens: 32_000 }], 30_000)).toBe(PRELOAD_MAX_BYTES)
  })

  test('reserves each model output allowance and sizes to the tightest model', () => {
    const models = [
      { contextWindow: 400_000, outputTokens: 32_000 },
      { contextWindow: 128_000, outputTokens: 32_000 },
    ]

    const budget = preloadBudgetBytes(models, 30_000)!

    expect(budget + 30_000 + PRELOAD_OVERHEAD_TOKENS + 32_000).toBeLessThanOrEqual(128_000)
  })

  test('returns null when no useful slice fits or no model is known', () => {
    expect(preloadBudgetBytes([{ contextWindow: 64_000, outputTokens: 32_000 }], 30_000)).toBeNull()
    expect(preloadBudgetBytes([], 30_000)).toBeNull()
  })
})

describe('buildTranscriptPreload', () => {
  test('starts right after the watermark and reaches the end', async () => {
    const path = transcript([entry('a'), entry('b'), entry('c')])

    const preload = await buildTranscriptPreload(path, 'a')

    expect(preload).toMatchObject({ startLine: 2, endLine: 3, totalLines: 3, watermarkFound: true, nextOffset: null })
    expect(preload?.text).not.toContain('"id":"a"')
    expect(preload?.text).toContain('"id":"c"')
  })

  test('starts at line 1 when there is no watermark or it was compacted away', async () => {
    const path = transcript([entry('a'), entry('b')])

    expect(await buildTranscriptPreload(path, null)).toMatchObject({ startLine: 1, watermarkFound: false })
    expect(await buildTranscriptPreload(path, 'gone')).toMatchObject({ startLine: 1, watermarkFound: false })
  })

  test('truncates an oversized line instead of skipping it, keeping its id', async () => {
    const path = transcript([entry('big', 'x'.repeat(80_000)), entry('next')])

    const preload = await buildTranscriptPreload(path, null, { maxLineBytes: 1024 })

    expect(preload?.truncatedLines).toBe(1)
    expect(preload?.text).toContain('"id":"big"')
    expect(preload?.text).toContain('[line 1 truncated')
    expect(preload?.text).toContain('"id":"next"')
  })

  test('stops at the byte cap and reports the next offset to read from', async () => {
    const path = transcript([entry('a', 'x'.repeat(500)), entry('b', 'x'.repeat(500)), entry('c')])

    const preload = await buildTranscriptPreload(path, null, { maxBytes: 700 })

    expect(preload).toMatchObject({ startLine: 1, endLine: 1, nextOffset: 2 })
  })

  test('keeps non-ASCII text intact', async () => {
    const path = transcript([entry('k', '배포 메모 확인해줘')])

    const preload = await buildTranscriptPreload(path, null)

    expect(preload?.text).toContain('배포 메모 확인해줘')
  })

  test('returns null when the transcript is missing', async () => {
    expect(await buildTranscriptPreload(join(tmpdir(), 'nope-preload.jsonl'), null)).toBeNull()
  })
})
