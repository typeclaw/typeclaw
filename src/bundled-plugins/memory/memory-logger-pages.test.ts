import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatLocalDate } from '@/shared'

import { createMemoryLoggerSubagent } from './memory-logger'
import { streamsDir, streamFilePath } from './paths'
import { readEvents } from './stream-io'
import { decodeTranscriptCursor } from './transcript-cursor'
import { readLatestWatermark } from './watermark'

const roots: string[] = []
const logger = { info() {}, warn() {}, error() {} }

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'memory-page-'))
  roots.push(root)
  const path = join(root, 'source.jsonl')
  const entry = JSON.stringify({
    type: 'message',
    id: 'large-entry',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: `처음의 지시. ${'근거🙂'.repeat(20_000)} 마지막 지시도 반드시 보존하세요.` },
  })
  await writeFile(path, `${entry}\n`)
  const payload = { parentSessionId: 'parent-1', parentTranscriptPath: path, agentDir: root }
  return { root, path, entry, payload, ctx: { agentDir: root, payload, userPrompt: '' } }
}

function subagent() {
  return createMemoryLoggerSubagent({
    logger,
    fastModelLimits: () => [{ contextWindow: 65_536, outputTokens: 1000 }],
  })
}

function page(prompt: string) {
  const checkpoint = prompt.match(/<memory-page-checkpoint>([^<]+)<\/memory-page-checkpoint>/)?.[1]
  if (!checkpoint) throw new Error('Expected a page checkpoint')
  const text = prompt.slice(prompt.indexOf('<transcript>') + '<transcript>'.length, prompt.lastIndexOf('</transcript>'))
  return {
    checkpoint,
    records: text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  }
}

function toolContext(root: string) {
  return { agentDir: root, sessionId: 'test', signal: undefined, logger }
}

describe('memory logger page completion', () => {
  test('extracts a complete instruction crossing the boundary between fresh page sessions', async () => {
    const f = await fixture()
    let raw = JSON.stringify({
      ...JSON.parse(f.entry),
      message: { role: 'user', content: 'x'.repeat(200_000) },
    })
    await writeFile(f.path, `${raw}\n`)
    const probe = async () => {
      const worker = subagent()
      let cut = 0
      await expect(
        worker.handler!(f.ctx, async (override) => {
          cut = page(override!.userPrompt!).records[0].text.length
          throw new Error('probe boundary')
        }),
      ).rejects.toThrow('probe boundary')
      return cut
    }
    // The first attempt persists the start cursor. Measure with that same
    // prompt frame so rewriting equal-length evidence preserves the boundary.
    await probe()
    const cut = await probe()
    const prefix = 'Always obtain approval before'
    const instruction = `${prefix} deploying any production changes.`
    const start = cut - prefix.length
    raw = raw.slice(0, start) + instruction + raw.slice(start + instruction.length)
    await writeFile(f.path, `${raw}\n`)
    const worker = subagent()
    let sessions = 0

    await worker.handler!(f.ctx, async (override) => {
      const current = page(override!.userPrompt!)
      const record = current.records[0]
      if (sessions++ === 0) expect(record.text.endsWith(prefix)).toBe(true)
      const visibleEvidence = (record.precedingText ?? '') + record.text
      if (visibleEvidence.includes(instruction)) {
        await worker.customTools![1]!.execute(
          {
            topic: 'Deployment approval',
            body: instruction,
            source: 'parent-1',
            entry: record.id,
            latestEntryId: current.checkpoint,
          },
          toolContext(f.root),
        )
      }
      await worker.customTools![3]!.execute(
        { source: 'parent-1', latestEntryId: current.checkpoint },
        toolContext(f.root),
      )
    })

    const events = await readEvents(streamFilePath(f.root, formatLocalDate()))
    expect(events.filter((event) => event.type === 'fragment').map((event) => event.body)).toEqual([instruction])
    expect(sessions).toBeGreaterThan(1)
    expect(await readFile(f.path, 'utf8')).toBe(`${raw}\n`)
  })

  test.each(['unavailable', 'insufficient'])(
    'keeps a partial cursor pending when preload limits are %s',
    async (limits) => {
      const f = await fixture()
      const interrupted = subagent()
      let pages = 0
      await expect(
        interrupted.handler!(f.ctx, async (override) => {
          if (pages++ > 0) throw new Error('interrupted on a later page')
          await interrupted.customTools![3]!.execute(
            { source: 'parent-1', latestEntryId: page(override!.userPrompt!).checkpoint },
            toolContext(f.root),
          )
        }),
      ).rejects.toThrow('interrupted on a later page')
      const checkpoint = await readLatestWatermark(streamsDir(f.root), 'parent-1')
      expect(decodeTranscriptCursor(checkpoint)!.offset).toBeGreaterThan(0)
      const warnings: string[] = []
      const resumed = createMemoryLoggerSubagent({
        logger: { ...logger, warn: (message) => warnings.push(message) },
        fastModelLimits: () => (limits === 'unavailable' ? [] : [{ contextWindow: 1000, outputTokens: 1000 }]),
      })
      let fallbackCalls = 0

      await resumed.handler!(f.ctx, async () => {
        fallbackCalls++
        await resumed.customTools![3]!.execute(
          { source: 'parent-1', latestEntryId: 'large-entry' },
          toolContext(f.root),
        )
      })

      expect(fallbackCalls).toBe(0)
      expect(await readLatestWatermark(streamsDir(f.root), 'parent-1')).toBe(checkpoint)
      expect(warnings.some((message) => message.includes('partial transcript cursor remains pending'))).toBe(true)
      const recovered = subagent()
      await recovered.handler!(f.ctx, async (override) => {
        await recovered.customTools![3]!.execute(
          { source: 'parent-1', latestEntryId: page(override!.userPrompt!).checkpoint },
          toolContext(f.root),
        )
      })
      expect(await readLatestWatermark(streamsDir(f.root), 'parent-1')).toBe('large-entry')
    },
  )

  test('rejects fragment writes once page completion has started', async () => {
    const f = await fixture()
    const worker = subagent()

    await worker.handler!(f.ctx, async (override) => {
      const current = page(override!.userPrompt!)
      const completing = worker.customTools![3]!.execute(
        { source: 'parent-1', latestEntryId: current.checkpoint },
        toolContext(f.root),
      )
      try {
        await expect(
          worker.customTools![1]!.execute(
            {
              topic: '승인',
              body: '사용자는 승인 절차를 요구한다.',
              source: 'parent-1',
              entry: 'large-entry',
              latestEntryId: current.checkpoint,
            },
            toolContext(f.root),
          ),
        ).rejects.toThrow('active page')
      } finally {
        await completing
      }
    })

    const events = await readEvents(streamFilePath(f.root, formatLocalDate()))
    expect(events.filter((event) => event.type === 'fragment')).toHaveLength(0)
    expect(await readLatestWatermark(streamsDir(f.root), 'parent-1')).toBe('large-entry')
  })

  test('does not acknowledge an incomplete writer tail as a completed entry', async () => {
    const f = await fixture()
    await writeFile(f.path, '{"type":"message","id":"unfinished"')
    const worker = subagent()

    await worker.handler!(f.ctx, async () => {
      await expect(
        worker.customTools![3]!.execute({ source: 'parent-1', latestEntryId: 'unfinished' }, toolContext(f.root)),
      ).rejects.toThrow('active page')
    })

    expect(await readLatestWatermark(streamsDir(f.root), 'parent-1')).toBeNull()
  })

  test('does not commit a page while its fragment write is still in flight', async () => {
    const f = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const worker = createMemoryLoggerSubagent({
      logger,
      fastModelLimits: () => [{ contextWindow: 65_536, outputTokens: 1000 }],
      onFragmentsAppended: async () => {
        entered.resolve()
        await release.promise
      },
    })
    let first = true

    await worker.handler!(f.ctx, async (override) => {
      const current = page(override!.userPrompt!)
      if (first) {
        first = false
        const writing = worker.customTools![1]!.execute(
          {
            topic: '승인',
            body: '사용자는 승인 절차를 요구한다.',
            source: 'parent-1',
            entry: 'large-entry',
            latestEntryId: current.checkpoint,
          },
          toolContext(f.root),
        )
        await entered.promise
        try {
          await expect(
            worker.customTools![3]!.execute(
              { source: 'parent-1', latestEntryId: current.checkpoint },
              toolContext(f.root),
            ),
          ).rejects.toThrow('active page')
          expect(await readLatestWatermark(streamsDir(f.root), 'parent-1')).not.toBe(current.checkpoint)
        } finally {
          release.resolve()
          await writing
        }
      }
      await worker.customTools![3]!.execute(
        { source: 'parent-1', latestEntryId: current.checkpoint },
        toolContext(f.root),
      )
    })

    expect(await readLatestWatermark(streamsDir(f.root), 'parent-1')).toBe('large-entry')
  })

  test('processes every oversized-record segment and only then acknowledges its original entry', async () => {
    const f = await fixture()
    const worker = subagent()
    const advance = worker.customTools![3]!
    const segments: string[] = []
    let calls = 0

    await worker.handler!(f.ctx, async (override) => {
      const current = page(override!.userPrompt!)
      for (const record of current.records) {
        if (record.type === 'entry-part') {
          expect(record.context).toMatchObject({
            timestamp: '2026-01-01T00:00:00.000Z',
            'message.role': 'user',
          })
        }
        segments.push(record.type === 'entry-part' ? record.text : JSON.stringify(record))
      }
      calls++
      await advance.execute({ source: 'parent-1', latestEntryId: current.checkpoint }, toolContext(f.root))
    })

    expect(segments.join('')).toBe(f.entry)
    expect(calls > 1).toBe(true)
    expect(await readLatestWatermark(streamsDir(f.root), 'parent-1')).toBe('large-entry')
    expect(await readFile(f.path, 'utf8')).toBe(`${f.entry}\n`)
  })

  test('replays an unfinished page after restart even when a fragment was already persisted', async () => {
    const f = await fixture()
    const interrupted = subagent()

    await expect(
      interrupted.handler!(f.ctx, async (override) => {
        const current = page(override!.userPrompt!)
        await interrupted.customTools![1]!.execute(
          {
            topic: '승인',
            body: '사용자는 승인 절차를 요구한다.',
            source: 'parent-1',
            entry: 'large-entry',
            latestEntryId: current.checkpoint,
          },
          toolContext(f.root),
        )
        throw new Error('interrupted before page completion')
      }),
    ).rejects.toThrow('interrupted before page completion')

    const restarted = subagent()
    const replayed: string[] = []
    let firstOffset: number | undefined
    await restarted.handler!(f.ctx, async (override) => {
      const current = page(override!.userPrompt!)
      firstOffset ??= current.records[0].offset
      replayed.push(current.records[0].text)
      await restarted.customTools![3]!.execute(
        { source: 'parent-1', latestEntryId: current.checkpoint },
        toolContext(f.root),
      )
    })

    expect(firstOffset).toBe(0)
    expect(replayed.join('')).toBe(f.entry)
    const events = await readEvents(streamFilePath(f.root, formatLocalDate()))
    expect(events.filter((event) => event.type === 'fragment')).toHaveLength(1)
    expect(await readLatestWatermark(streamsDir(f.root), 'parent-1')).toBe('large-entry')
  })

  test('rejects unseen anchors, foreign sources and stale completion calls without advancing progress', async () => {
    const f = await fixture()
    const worker = subagent()
    const advance = worker.customTools![3]!
    let issued = ''

    await worker.handler!(f.ctx, async (override) => {
      issued = page(override!.userPrompt!).checkpoint
      await expect(
        advance.execute({ source: 'parent-1', latestEntryId: 'unseen-entry' }, toolContext(f.root)),
      ).rejects.toThrow('active page')
      await expect(
        advance.execute({ source: 'another-parent', latestEntryId: issued }, toolContext(f.root)),
      ).rejects.toThrow('active page')
      await expect(
        worker.customTools![1]!.execute(
          { topic: 'T', body: 'B', source: 'parent-1', entry: 'unseen-entry', latestEntryId: issued },
          toolContext(f.root),
        ),
      ).rejects.toThrow('active page')
    })

    await expect(advance.execute({ source: 'parent-1', latestEntryId: issued }, toolContext(f.root))).rejects.toThrow(
      'active page',
    )
    expect(await readLatestWatermark(streamsDir(f.root), 'parent-1')).not.toBe(issued)
    const events = await readEvents(streamFilePath(f.root, formatLocalDate()))
    expect(events.filter((event) => event.type === 'fragment')).toHaveLength(0)
  })
})
