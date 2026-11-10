import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readLatestWatermark, readWatermarkFromFile } from './watermark'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'memory-watermark-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function tmpFile(content: string): Promise<string> {
  const path = join(dir, 'stream.jsonl')
  await writeFile(path, content, 'utf-8')
  return path
}

async function tmpMemoryDir(files: Record<string, string>): Promise<string> {
  const memoryDir = join(dir, 'memory')
  await mkdir(memoryDir)
  for (const [name, content] of Object.entries(files)) await writeFile(join(memoryDir, name), content, 'utf-8')
  return memoryDir
}

function fragment(source: string, entry: string, id = `f-${entry}`, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type: 'fragment', id, ts: '2026-05-16T12:00:00.000Z', source, entry, topic: 'T', body: 'B', ...extra })}\n`
}

function watermark(source: string, entry: string, id = `w-${entry}`): string {
  return `${JSON.stringify({ type: 'watermark', id, ts: '2026-05-16T12:00:00.000Z', source, entry })}\n`
}

function legacyProse(text = 'some notes'): string {
  return `${JSON.stringify({ type: 'legacy_prose', ts: '2026-05-16T12:00:00.000Z', text, origin: 'migration' })}\n`
}

describe('readWatermarkFromFile', () => {
  test('returns null when the file does not exist', async () => {
    await expect(readWatermarkFromFile(join(dir, 'does-not-exist-xyz.jsonl'), 'ses_abc')).resolves.toBeNull()
  })

  test('returns null when the file has no fragment markers', async () => {
    const path = await tmpFile(legacyProse())
    await expect(readWatermarkFromFile(path, 'ses_abc')).resolves.toBeNull()
  })

  test('returns null when markers exist only for a different session', async () => {
    const path = await tmpFile(fragment('ses_xyz', '11111111'))
    await expect(readWatermarkFromFile(path, 'ses_abc')).resolves.toBeNull()
  })

  test('returns the entry id when a single matching marker exists', async () => {
    const path = await tmpFile(fragment('ses_abc', 'a3f9c2d1'))
    await expect(readWatermarkFromFile(path, 'ses_abc')).resolves.toBe('a3f9c2d1')
  })

  test('returns the LAST entry id when multiple markers for the same session exist', async () => {
    const path = await tmpFile(
      [fragment('ses_abc', '11111111'), fragment('ses_abc', '22222222'), fragment('ses_abc', '33333333')].join(''),
    )
    await expect(readWatermarkFromFile(path, 'ses_abc')).resolves.toBe('33333333')
  })

  test('does not match when source value is a prefix of the requested session id', async () => {
    const path = await tmpFile(fragment('ses_a', '00000001'))
    await expect(readWatermarkFromFile(path, 'ses_abc')).resolves.toBeNull()
  })

  test('recognizes a bare watermark marker (no fragment body) as a valid watermark', async () => {
    const path = await tmpFile(watermark('ses_abc', 'quietday'))
    await expect(readWatermarkFromFile(path, 'ses_abc')).resolves.toBe('quietday')
  })

  test('an explicit checkpoint is not overtaken by a fragment from an unfinished page', async () => {
    const path = await tmpFile(
      [fragment('ses_abc', '11111111'), watermark('ses_abc', '22222222'), fragment('ses_abc', '33333333')].join(''),
    )
    await expect(readWatermarkFromFile(path, 'ses_abc')).resolves.toBe('22222222')
  })

  test('fragment markers with a trailing certainty attribute still match', async () => {
    const path = await tmpFile(fragment('ses_abc', 'cert0001', 'f-cert0001', { certainty: 'explicit' }))
    await expect(readWatermarkFromFile(path, 'ses_abc')).resolves.toBe('cert0001')
  })
})

describe('readLatestWatermark', () => {
  test('retains an explicit checkpoint when an interrupted page wrote fragments after midnight', async () => {
    const memoryDir = await tmpMemoryDir({
      '2026-05-15.jsonl': watermark('ses_abc', 'unfinished-page-start'),
      '2026-05-16.jsonl': fragment('ses_abc', 'unfinished-entry'),
    })

    await expect(readLatestWatermark(memoryDir, 'ses_abc')).resolves.toBe('unfinished-page-start')
  })

  test('returns null when the memory dir does not exist', async () => {
    await expect(readLatestWatermark(join(dir, 'no-such-memory-dir-xyz'), 'ses_abc')).resolves.toBeNull()
  })

  test('returns null when the memory dir is empty', async () => {
    const memoryDir = await tmpMemoryDir({})
    await expect(readLatestWatermark(memoryDir, 'ses_abc')).resolves.toBeNull()
  })

  test("returns today's watermark when today's stream exists with a marker", async () => {
    const memoryDir = await tmpMemoryDir({ '2026-05-16.jsonl': watermark('ses_abc', 'today-id') })
    await expect(readLatestWatermark(memoryDir, 'ses_abc')).resolves.toBe('today-id')
  })

  test("returns YESTERDAY'S watermark when today's stream does not exist (the midnight-rollover case)", async () => {
    const memoryDir = await tmpMemoryDir({
      '2026-05-15.jsonl': [fragment('ses_abc', 'morning-id'), watermark('ses_abc', 'evening-id')].join(''),
    })
    await expect(readLatestWatermark(memoryDir, 'ses_abc')).resolves.toBe('evening-id')
  })

  test("returns yesterday's watermark when today's stream exists but has none for this session", async () => {
    const memoryDir = await tmpMemoryDir({
      '2026-05-15.jsonl': watermark('ses_abc', 'yesterday-id'),
      '2026-05-16.jsonl': watermark('ses_other', 'different-session'),
    })
    await expect(readLatestWatermark(memoryDir, 'ses_abc')).resolves.toBe('yesterday-id')
  })

  test("prefers today's watermark over yesterday's when both contain markers for the session", async () => {
    const memoryDir = await tmpMemoryDir({
      '2026-05-15.jsonl': watermark('ses_abc', 'yesterday-id'),
      '2026-05-16.jsonl': watermark('ses_abc', 'today-id'),
    })
    await expect(readLatestWatermark(memoryDir, 'ses_abc')).resolves.toBe('today-id')
  })

  test('walks back past empty / unrelated daily streams until it finds a matching marker', async () => {
    const memoryDir = await tmpMemoryDir({
      '2026-05-13.jsonl': watermark('ses_abc', 'oldest'),
      '2026-05-14.jsonl': legacyProse('nothing for us today'),
      '2026-05-15.jsonl': watermark('ses_other', 'different-session'),
      '2026-05-16.jsonl': '',
    })
    await expect(readLatestWatermark(memoryDir, 'ses_abc')).resolves.toBe('oldest')
  })

  test('returns null when no daily stream contains a marker for this session', async () => {
    const memoryDir = await tmpMemoryDir({
      '2026-05-14.jsonl': watermark('ses_other', 'different-session'),
      '2026-05-15.jsonl': legacyProse('unrelated content'),
    })
    await expect(readLatestWatermark(memoryDir, 'ses_abc')).resolves.toBeNull()
  })

  test('ignores non-YYYY-MM-DD JSONL files in memory/', async () => {
    const memoryDir = await tmpMemoryDir({
      'README.jsonl': watermark('ses_abc', 'should-be-ignored'),
      'notes.jsonl': watermark('ses_abc', 'also-ignored'),
      '2026-05-15.jsonl': watermark('ses_abc', 'picked'),
    })
    await expect(readLatestWatermark(memoryDir, 'ses_abc')).resolves.toBe('picked')
  })

  test('ignores non-JSONL files and subdirectories in memory/', async () => {
    const memoryDir = await tmpMemoryDir({
      '.dreaming-state.json': '{"days":{"2026-05-15":42}}',
      '2026-05-15.jsonl': watermark('ses_abc', 'found'),
    })
    await mkdir(join(memoryDir, 'skills'))
    await writeFile(join(memoryDir, 'skills', 'something.jsonl'), watermark('ses_abc', 'in-subdir'), 'utf-8')
    await expect(readLatestWatermark(memoryDir, 'ses_abc')).resolves.toBe('found')
  })

  test("uses the LAST marker within a file once it picks that file (so today's last is preferred to today's first)", async () => {
    const memoryDir = await tmpMemoryDir({
      '2026-05-16.jsonl': [
        fragment('ses_abc', 'morning'),
        fragment('ses_abc', 'midday'),
        watermark('ses_abc', 'latest'),
      ].join(''),
    })
    await expect(readLatestWatermark(memoryDir, 'ses_abc')).resolves.toBe('latest')
  })
})
