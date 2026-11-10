import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

  test('matches only top-level entry IDs when resuming after a watermark', async () => {
    const path = transcript([
      JSON.stringify({ id: 'wrapper', message: { id: 'target' } }),
      entry('target'),
      entry('after'),
    ])

    const preload = await buildTranscriptPreload(path, 'target')

    expect(preload?.text).toBe(entry('after'))
  })

  test('leaves an incomplete writer tail pending and resumes it when completed', async () => {
    const path = transcript([entry('a'), '{"type":"message","id":"b"'])
    const first = await buildTranscriptPreload(path, null)
    expect(first?.checkpoint).toBe('a')
    expect(first?.nextOffset).toBe(2)
    writeFileSync(path, `${entry('a')}\n${entry('b', '新しい指示を保存してください。')}\n`)

    const resumed = await buildTranscriptPreload(path, first!.checkpoint)

    expect(resumed?.text).toBe(entry('b', '新しい指示を保存してください。'))
    expect(resumed?.nextOffset).toBeNull()
  })

  test('resumes an oversized entry without losing Unicode content or later entries', async () => {
    const text = `${'앞부분🙂'.repeat(800)}끝부분의 지시도 보존하세요.`
    const raw = entry('big', text)
    const path = transcript([raw, entry('next')])
    const parts: string[] = []
    let checkpoint: string | null = null
    let sawNext = false

    for (let page = 0; page < 100; page++) {
      const preload = await buildTranscriptPreload(path, checkpoint, { maxBytes: 1024 })
      expect(Buffer.byteLength(preload!.text)).toBeLessThanOrEqual(1024)
      for (const line of preload!.text.split('\n')) {
        const record = JSON.parse(line)
        if (record.id === 'big') parts.push(record.type === 'entry-part' ? record.text : line)
        if (record.id === 'next') sawNext = true
      }
      checkpoint = preload!.checkpoint
      if (preload!.nextOffset === null) break
    }

    expect(parts.join('')).toBe(raw)
    expect(sawNext).toBe(true)
  })

  test('replays a changed partial entry instead of applying a stale cursor to new content', async () => {
    const path = transcript([entry('big', 'first '.repeat(2000))])
    const first = await buildTranscriptPreload(path, null, { maxBytes: 1024 })
    const replacement = entry('big', '변경된 지시입니다. '.repeat(2000))
    writeFileSync(path, `${replacement}\n`)

    const resumed = await buildTranscriptPreload(path, first!.checkpoint, { maxBytes: 1024 })
    const record = JSON.parse(resumed!.text)

    expect(record.offset).toBe(0)
    expect(replacement.startsWith(record.text)).toBe(true)
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

  test('preserves a durable instruction after the former per-line cutoff', async () => {
    const instruction = '앞으로 배포하기 전에 승인을 받아야 합니다.'
    const path = transcript([entry('long-message', `${'x'.repeat(17_000)}\n${instruction}`)])

    const preload = await buildTranscriptPreload(path, null)

    expect(preload?.text.includes(instruction)).toBe(true)
    expect(preload?.nextOffset).toBeNull()
  })

  test('omits transport bookkeeping while preserving evidence and the canonical transcript', async () => {
    const evidence = {
      type: 'message',
      id: 'entry-tools',
      parentId: 'entry-user',
      timestamp: '2026-01-01T12:00:00.000Z',
      message: {
        role: 'assistant',
        timestamp: 1767268800000,
        stopReason: 'toolUse',
        content: [
          { type: 'thinking', thinking: '확인된 근거를 보존한다.' },
          { type: 'text', text: 'The result is incomplete; check the source.' },
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'notes.md' } },
        ],
      },
    }
    const raw = JSON.stringify({
      ...evidence,
      message: {
        ...evidence.message,
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        model: 'test-model',
        responseId: 'response-1',
        usage: { input: 100, output: 20, cost: { total: 0.01 } },
        content: [
          { ...evidence.message.content[0], thinkingSignature: 'opaque-replay-data' },
          { ...evidence.message.content[1], textSignature: 'opaque-text-id' },
          evidence.message.content[2],
        ],
      },
    })
    const path = transcript([raw])

    const preload = await buildTranscriptPreload(path, null)

    expect(JSON.parse(preload!.text)).toEqual(evidence)
    expect(readFileSync(path, 'utf8')).toBe(`${raw}\n`)
  })

  test('returns null when the transcript is missing', async () => {
    expect(await buildTranscriptPreload(join(tmpdir(), 'nope-preload.jsonl'), null)).toBeNull()
  })
})
