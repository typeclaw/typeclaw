import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ToolContext } from '@/plugin'
import { formatLocalDate } from '@/shared'
import { rmTempDir } from '@/test-helpers/rm-temp-dir'

import { advanceWatermarkTool } from './append-tool'
import { streamFilePath, streamsDir } from './paths'
import { createMemoryRememberTool } from './remember-tool'
import { type FragmentEvent, parseEventLine } from './stream-events'
import { readEvents } from './stream-io'
import { makeAppendHook } from './vector/index-on-write'
import { VectorStore } from './vector/store'
import { readLatestWatermark } from './watermark'

let agentDir: string
const logger = { info() {}, warn() {}, error() {} }

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'memory-remember-'))
})

afterEach(async () => {
  await rmTempDir(agentDir)
})

function context(): ToolContext {
  return {
    agentDir,
    sessionId: 'session-a',
    entryId: 'assistant-entry',
    origin: {
      kind: 'channel',
      adapter: 'slack',
      workspace: 'T0123456789',
      chat: 'C0123456789',
      chatName: 'planning',
      thread: 'thread-a',
    },
    logger,
    signal: undefined,
  }
}

function path(): string {
  return streamFilePath(agentDir, formatLocalDate())
}

describe('memory_remember', () => {
  test('appends one runtime-stamped explicit fragment without advancing logger progress', async () => {
    const tool = createMemoryRememberTool()
    await tool.execute({ topic: 'Preference', body: 'Use concise replies.', who: 'Alice' }, context())

    const events = await readEvents(path())
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'fragment',
      kind: 'explicit',
      source: 'session-a',
      entry: 'assistant-entry',
      topic: 'Preference',
      body: 'Use concise replies.',
      who: 'Alice',
      where: {
        adapter: 'slack',
        workspace: 'T0123456789',
        chat: 'C0123456789',
        chatName: 'planning',
        thread: 'thread-a',
      },
    })
    expect(await readLatestWatermark(streamsDir(agentDir), 'session-a')).toBeNull()
    expect(existsSync(join(agentDir, 'memory', 'topics'))).toBe(false)

    await advanceWatermarkTool.execute({ source: 'session-a', latestEntryId: 'evaluated-entry' }, context())
    await tool.execute({ topic: 'Decision', body: 'Ship option A.' }, context())
    expect(await readLatestWatermark(streamsDir(agentDir), 'session-a')).toBe('evaluated-entry')
  })

  test.each(['topic', 'body', 'who'] as const)(
    'refuses secret-shaped %s before storing a verbatim reference',
    async (field) => {
      const input = { topic: 'Preference', body: 'Use concise replies.', who: 'Alice', verbatim: true }
      const secret = `ghp_${'a'.repeat(36)}`
      await expect(createMemoryRememberTool().execute({ ...input, [field]: secret }, context())).rejects.toThrow(
        'recognized credential pattern',
      )
      expect(existsSync(join(agentDir, 'memory'))).toBe(false)
    },
  )

  test('stores the exact verbatim body through the reference writer and links its slug', async () => {
    const body = '\nSELECT 한글 FROM examples;\r\n  -- preserve spacing\n\n'
    const stored: { slug: string; body: string }[] = []
    await createMemoryRememberTool({
      onReferenceStored: async (reference) => {
        stored.push(reference)
      },
    }).execute({ topic: 'Query', body, verbatim: true }, context())

    const [reference] = stored
    expect(reference?.body).toBe(body)
    const [event] = await readEvents(path())
    expect(event).toMatchObject({ body, references: [reference?.slug] })
    const files = await readdir(join(agentDir, 'memory', 'references'))
    expect(files).toEqual([`${reference?.slug}.md`])
    const raw = await readFile(join(agentDir, 'memory', 'references', files[0] ?? ''), 'utf8')
    expect(raw.slice(raw.indexOf('\n---\n') + 5)).toBe(body)
  })

  test('concurrent verbatim captures under one topic reserve distinct references', async () => {
    const tool = createMemoryRememberTool()
    const bodies = ['SELECT 1;', 'SELECT 2;', 'SELECT 3;']
    await Promise.all(bodies.map((body) => tool.execute({ topic: 'Query', body, verbatim: true }, context())))

    const events = (await readEvents(path())).filter((event) => event.type === 'fragment')
    const slugs = events.map((event) => event.references?.[0])
    expect(new Set(slugs).size).toBe(bodies.length)
    for (const event of events) {
      const raw = await readFile(join(agentDir, 'memory', 'references', `${event.references?.[0]}.md`), 'utf8')
      expect(raw.slice(raw.indexOf('\n---\n') + 5)).toBe(event.body)
    }
  })

  test('a failing reference index hook still completes the capture with a linked reference', async () => {
    const warnings: string[] = []
    const ctx = { ...context(), logger: { ...logger, warn: (message: string) => warnings.push(message) } }
    await createMemoryRememberTool({
      onReferenceStored: async () => {
        throw new Error('index unavailable')
      },
    }).execute({ topic: 'Query', body: 'SELECT 1;', verbatim: true }, ctx)

    const [event] = await readEvents(path())
    if (event?.type !== 'fragment') throw new Error('Expected a persisted fragment')
    const [slug] = event.references ?? []
    expect(await readdir(join(agentDir, 'memory', 'references'))).toEqual([`${slug}.md`])
    expect(warnings.some((message) => message.includes('index unavailable'))).toBe(true)
  })

  test('round-trips Korean text and delivers the persisted fragment to the append hook', async () => {
    const batches: FragmentEvent[][] = []
    const tool = createMemoryRememberTool({
      onFragmentsAppended: async (fragments) => {
        batches.push(fragments)
      },
    })
    const body = '사용자는 답변을 짧게 받는 것을 선호한다.'
    await tool.execute({ topic: '답변 선호', body, who: '민준' }, context())

    const raw = await readFile(path(), 'utf8')
    const event = parseEventLine(raw.trim())
    expect(event).toMatchObject({ topic: '답변 선호', body, who: '민준', kind: 'explicit' })
    if (event?.type !== 'fragment') throw new Error('Expected a persisted fragment')
    expect(batches).toEqual([[event]])
  })

  test('indexes remembered fragments immediately through the shared vector hook', async () => {
    const dbPath = join(agentDir, 'memory', '.vectors', 'index.db')
    const vector = new Float32Array([1, 0, 0])
    await createMemoryRememberTool({
      onFragmentsAppended: makeAppendHook(
        () => VectorStore.open(dbPath),
        async () => [vector],
      ),
    }).execute({ topic: 'Decision', body: 'Use option A.' }, context())

    const [event] = await readEvents(path())
    const store = VectorStore.open(dbPath)
    try {
      expect(
        store.getByIds([`stream:${formatLocalDate()}#${event?.type === 'fragment' ? event.id : ''}`]),
      ).toMatchObject([{ source: 'stream', embedding: vector }])
    } finally {
      store.close()
    }
  })

  test('omits unavailable transcript anchors and non-channel provenance honestly', async () => {
    const ctx: ToolContext = { agentDir, sessionId: 'session-b', logger, signal: undefined }
    await createMemoryRememberTool().execute({ topic: 'Decision', body: 'Use option B.' }, ctx)
    const [event] = await readEvents(path())
    expect(event).toMatchObject({ source: 'session-b', entry: '' })
    expect(event).not.toHaveProperty('where')
  })
})
