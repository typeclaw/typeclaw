import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compactDailyStreams } from './dreaming'
import { addDreamedIds, emptyState } from './dreaming-state'
import { readEvents } from './stream-io'

const TS = '2026-05-16T12:00:00.000Z'

function fragment(id: string, source: string, topic = `topic-${id}`): string {
  return JSON.stringify({ type: 'fragment', id, ts: TS, source, entry: id, topic, body: `body ${id}` })
}

function watermark(id: string, source: string, entry: string): string {
  return JSON.stringify({ type: 'watermark', id, ts: TS, source, entry })
}

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-compact-'))
  await mkdir(join(agentDir, 'memory', 'streams'), { recursive: true })
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

async function writeStream(date: string, lines: string[]): Promise<string> {
  const path = join(agentDir, 'memory', 'streams', `${date}.jsonl`)
  await writeFile(path, lines.join('\n') + '\n')
  return path
}

describe('compactDailyStreams: watermark GC', () => {
  test('keeps only the latest watermark per source', async () => {
    const path = await writeStream('2026-05-16', [
      watermark('w1', 'ses_a', 'e1'),
      watermark('w2', 'ses_a', 'e2'),
      watermark('w3', 'ses_a', 'e3'),
    ])

    const stats = await compactDailyStreams(agentDir, emptyState(), new Map(), ['2026-05-16'], {
      applyFragmentGc: true,
    })

    expect(stats.watermarksDropped).toBe(2)
    expect(stats.filesCompacted).toBe(1)
    const events = await readEvents(path)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'watermark', id: 'w3', entry: 'e3' })
  })

  test('keeps the latest watermark for each distinct source independently', async () => {
    const path = await writeStream('2026-05-16', [
      watermark('w-a1', 'ses_a', 'a1'),
      watermark('w-b1', 'ses_b', 'b1'),
      watermark('w-a2', 'ses_a', 'a2'),
      watermark('w-b2', 'ses_b', 'b2'),
    ])

    await compactDailyStreams(agentDir, emptyState(), new Map(), ['2026-05-16'], { applyFragmentGc: true })

    const events = await readEvents(path)
    const ids = events.map((e) => e.id).sort()
    expect(ids).toEqual(['w-a2', 'w-b2'])
  })

  test('does not touch a file whose watermarks are already deduplicated', async () => {
    const path = await writeStream('2026-05-16', [watermark('w-only', 'ses_a', 'e1')])
    const before = await readEvents(path)

    const stats = await compactDailyStreams(agentDir, emptyState(), new Map(), ['2026-05-16'], {
      applyFragmentGc: true,
    })

    expect(stats.filesCompacted).toBe(0)
    const after = await readEvents(path)
    expect(after).toEqual(before)
  })

  test('the redundancy pattern from the original bug report (3x same-source watermarks at the same entry) collapses to one', async () => {
    const path = await writeStream('2026-05-16', [
      watermark('w1', 'ses_a', '639cc130'),
      watermark('w2', 'ses_a', '639cc130'),
      watermark('w3', 'ses_a', '639cc130'),
    ])

    await compactDailyStreams(agentDir, emptyState(), new Map(), ['2026-05-16'], { applyFragmentGc: true })

    const events = await readEvents(path)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ id: 'w3', entry: '639cc130' })
  })
})

describe('compactDailyStreams: fragment GC', () => {
  test('drops fragments in dreamedIds that are not in citedIds', async () => {
    const path = await writeStream('2026-05-16', [
      fragment('f-cited', 'ses_a'),
      fragment('f-dreamed-uncited', 'ses_a'),
      fragment('f-not-yet-dreamed', 'ses_a'),
    ])

    const state = addDreamedIds(emptyState(), '2026-05-16', ['f-cited', 'f-dreamed-uncited'], 'now')
    const cited = new Map([['2026-05-16', new Set(['f-cited'])]])

    const stats = await compactDailyStreams(agentDir, state, cited, ['2026-05-16'], { applyFragmentGc: true })

    expect(stats.fragmentsDropped).toBe(1)
    expect(stats.filesCompacted).toBe(1)
    const events = await readEvents(path)
    const ids = events.map((e) => e.id).sort()
    expect(ids).toEqual(['f-cited', 'f-not-yet-dreamed'])
  })

  test('a fragment not yet dreamed always survives (cannot be GCd before evaluation)', async () => {
    const path = await writeStream('2026-05-16', [fragment('f-fresh', 'ses_a')])

    const stats = await compactDailyStreams(agentDir, emptyState(), new Map(), ['2026-05-16'], {
      applyFragmentGc: true,
    })

    expect(stats.fragmentsDropped).toBe(0)
    expect(stats.filesCompacted).toBe(0)
    const events = await readEvents(path)
    expect(events).toHaveLength(1)
  })

  test('a cited fragment survives even if it appears in dreamedIds (citation is the pin)', async () => {
    const path = await writeStream('2026-05-16', [fragment('f-cited', 'ses_a')])

    const state = addDreamedIds(emptyState(), '2026-05-16', ['f-cited'], 'now')
    const cited = new Map([['2026-05-16', new Set(['f-cited'])]])

    const stats = await compactDailyStreams(agentDir, state, cited, ['2026-05-16'], { applyFragmentGc: true })

    expect(stats.fragmentsDropped).toBe(0)
    expect(stats.filesCompacted).toBe(0)
    expect(await readEvents(path)).toHaveLength(1)
  })

  test('cited ids for OTHER dates do not pin a fragment alive in this date', async () => {
    const path = await writeStream('2026-05-16', [fragment('f-uncited-here', 'ses_a')])

    const state = addDreamedIds(emptyState(), '2026-05-16', ['f-uncited-here'], 'now')
    const cited = new Map([['2026-05-15', new Set(['f-uncited-here'])]])

    const stats = await compactDailyStreams(agentDir, state, cited, ['2026-05-16'], { applyFragmentGc: true })

    expect(stats.fragmentsDropped).toBe(1)
    expect(await readEvents(path)).toHaveLength(0)
  })
})

describe('compactDailyStreams: combined rules', () => {
  test('the user-reported watermark pattern collapses 12 rows to 5 (matching the design discussion)', async () => {
    const SES_A = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
    const SES_B = '019e2ecf-f2d5-70ee-83f6-005fb5451c51'
    const SES_C = '019e2ee8-bcc4-772f-8821-876162c5e601'
    const path = await writeStream('2026-05-16', [
      watermark('w01', SES_A, '7aca12be'),
      watermark('w02', SES_A, 'bec8ac7b'),
      watermark('w03', SES_A, 'cdfec418'),
      watermark('w04', SES_A, '5de1f48c'),
      watermark('w05', SES_A, '639cc130'),
      watermark('w06', SES_A, '639cc130'),
      watermark('w07', SES_B, '28843ed8'),
      watermark('w08', SES_B, '28843ed8'),
      watermark('w09', SES_A, '639cc130'),
      watermark('w10', SES_C, '7e682f27'),
      watermark('w11', SES_B, '28843ed8'),
      watermark('w12', SES_C, '7e682f27'),
    ])

    await compactDailyStreams(agentDir, emptyState(), new Map(), ['2026-05-16'], { applyFragmentGc: true })

    const events = await readEvents(path)
    expect(events).toHaveLength(3)
    const ids = events.map((e) => e.id).sort()
    expect(ids).toEqual(['w09', 'w11', 'w12'])
  })

  test('no-op when there is nothing to drop', async () => {
    const path = await writeStream('2026-05-16', [fragment('f-1', 'ses_a'), watermark('w-1', 'ses_a', 'f-1')])
    const before = await readEvents(path)

    const stats = await compactDailyStreams(agentDir, emptyState(), new Map(), ['2026-05-16'], {
      applyFragmentGc: true,
    })

    expect(stats).toEqual({ filesCompacted: 0, watermarksDropped: 0, fragmentsDropped: 0 })
    expect(await readEvents(path)).toEqual(before)
  })

  test('skips files that do not exist on disk without throwing', async () => {
    const stats = await compactDailyStreams(agentDir, emptyState(), new Map(), ['2026-05-15'], {
      applyFragmentGc: true,
    })
    expect(stats.filesCompacted).toBe(0)
  })
})

describe('compactDailyStreams: applyFragmentGc gate', () => {
  test('with applyFragmentGc=false, fragments survive even when they would be dropped under the rule', async () => {
    const path = await writeStream('2026-05-16', [fragment('f-dreamed-uncited', 'ses_a')])
    const state = addDreamedIds(emptyState(), '2026-05-16', ['f-dreamed-uncited'], 'now')

    const stats = await compactDailyStreams(agentDir, state, new Map(), ['2026-05-16'], { applyFragmentGc: false })

    expect(stats.fragmentsDropped).toBe(0)
    const events = await readEvents(path)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'fragment', id: 'f-dreamed-uncited' })
  })

  test('with applyFragmentGc=false, watermark GC still runs (watermarks are never citation-dependent)', async () => {
    const path = await writeStream('2026-05-16', [
      watermark('w1', 'ses_a', 'e1'),
      watermark('w2', 'ses_a', 'e2'),
      fragment('f-dreamed-uncited', 'ses_a'),
    ])
    const state = addDreamedIds(emptyState(), '2026-05-16', ['f-dreamed-uncited'], 'now')

    const stats = await compactDailyStreams(agentDir, state, new Map(), ['2026-05-16'], { applyFragmentGc: false })

    expect(stats.watermarksDropped).toBe(1)
    expect(stats.fragmentsDropped).toBe(0)
    const events = await readEvents(path)
    expect(events.map((e) => e.id).sort()).toEqual(['f-dreamed-uncited', 'w2'])
  })
})
