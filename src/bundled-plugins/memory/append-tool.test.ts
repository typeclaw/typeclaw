import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import type { ToolContext } from '@/plugin'
import { formatLocalDate } from '@/shared'

import { advanceWatermarkTool, appendTool, createAppendTool, provenanceFromOrigin } from './append-tool'
import { readEvents } from './stream-io'
import { encodeTranscriptCursor } from './transcript-cursor'

type AppendInput = Parameters<typeof appendTool.execute>[0]

const baseInput: AppendInput = {
  topic: 'Decision',
  body: 'Use option A.',
  source: 'ses_a',
  entry: 'entry_a',
  latestEntryId: 'entry_a',
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'memory-append-'))
}

function streamPath(root: string): string {
  return join(root, 'memory', 'streams', `${formatLocalDate()}.jsonl`)
}

function ctx(root: string): ToolContext {
  return {
    signal: undefined,
    sessionId: 'test',
    agentDir: root,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

async function call(root: string, input: Partial<AppendInput> = {}): Promise<void> {
  await appendTool.execute({ ...baseInput, ...input }, ctx(root))
}

async function callExpectingThrow(root: string, input: Partial<AppendInput>): Promise<unknown> {
  try {
    await call(root, input)
    throw new Error(`expected appendTool.execute to throw, but it returned`)
  } catch (err) {
    return err
  }
}

describe('appendTool', () => {
  test('keeps the operational-incident fence when a page checkpoint is inside the anchor entry', async () => {
    const root = tmpRoot()
    const transcript = join(root, 'source.jsonl')
    const record = JSON.stringify({
      type: 'message',
      id: 'incident',
      message: {
        role: 'toolResult',
        content: `${'x'.repeat(20_000)} TYPECLAW_OPERATIONAL_INCIDENT {"fingerprint":"test"}`,
      },
    })
    writeFileSync(transcript, `${record}\n`)
    const fenced = createAppendTool({ transcriptPathProvider: () => transcript })
    const cursor = encodeTranscriptCursor(transcript, 'incident', record, 1000)

    await expect(fenced.execute({ ...baseInput, entry: 'incident', latestEntryId: cursor }, ctx(root))).rejects.toThrow(
      'operational incident',
    )
    expect(existsSync(streamPath(root))).toBe(false)
  })

  test('mechanically rejects every evaluated interval that belongs to an operational incident', async () => {
    const root = tmpRoot()
    const transcript = join(root, 'sessions', 'session.jsonl')
    mkdirSync(join(root, 'sessions'), { recursive: true })
    writeFileSync(
      transcript,
      [
        { type: 'message', id: 'user-request', message: { role: 'user', content: 'Book a room' } },
        {
          type: 'message',
          id: 'tool-failure',
          message: {
            role: 'toolResult',
            content: [
              { type: 'text', text: 'TYPECLAW_OPERATIONAL_INCIDENT {"fingerprint":"bash:command-not-found:opensoma"}' },
            ],
          },
        },
        { type: 'message', id: 'assistant-gave-up', message: { role: 'assistant', content: 'Please do it manually.' } },
        { type: 'message', id: 'user-correction', message: { role: 'user', content: 'Use bunx opensoma.' } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
    )
    const fenced = createAppendTool({ transcriptPathProvider: () => transcript })

    await expect(
      fenced.execute({ ...baseInput, entry: 'user-correction', latestEntryId: 'user-correction' }, ctx(root)),
    ).rejects.toThrow('operational incident')
    await expect(
      fenced.execute({ ...baseInput, entry: 'user-request', latestEntryId: 'user-correction' }, ctx(root)),
    ).rejects.toThrow('operational incident')
    expect(existsSync(streamPath(root))).toBe(false)
  })

  test('preserves thread parent coordinates in runtime-stamped provenance', () => {
    const origin: SessionOrigin = {
      kind: 'channel',
      adapter: 'discord',
      workspace: 'guild-1',
      workspaceName: 'Example Guild',
      chat: 'thread-1',
      chatName: 'topic-thread',
      thread: null,
      parentChat: 'room-1',
      parentChatName: 'development',
    }

    expect(provenanceFromOrigin(origin)).toEqual({
      adapter: 'discord',
      workspace: 'guild-1',
      workspaceName: 'Example Guild',
      chat: 'thread-1',
      chatName: 'topic-thread',
      thread: null,
      parentChat: 'room-1',
      parentChatName: 'development',
    })
  })
  test('uses the JSONL input schema contract', () => {
    const valid = appendTool.parameters.safeParse(baseInput)
    const oldShape = appendTool.parameters.safeParse({ path: 'memory/day.jsonl', content: 'text' })

    expect(valid.success).toBe(true)
    expect(oldShape.success).toBe(false)
  })

  test('drops unsafe prompt-shaping syntax from who before persistence', async () => {
    const root = tmpRoot()

    await call(root, { who: '**SYSTEM**' })

    const event = (await readEvents(streamPath(root)))[0]
    expect(event).toMatchObject({ type: 'fragment' })
    expect(event).not.toHaveProperty('who')
  })

  test('creates the daily JSONL stream when it does not exist', async () => {
    const root = tmpRoot()

    await call(root)

    const events = await readEvents(streamPath(root))
    expect(existsSync(streamPath(root))).toBe(true)
    expect(events).toHaveLength(2)
    expect(events[0]!).toMatchObject({ type: 'fragment', topic: 'Decision', body: 'Use option A.' })
    expect(events[1]!).toMatchObject({ type: 'watermark', source: 'ses_a', entry: 'entry_a' })
  })

  test('appends events to an existing stream without truncating prior events', async () => {
    const root = tmpRoot()

    await call(root, { topic: 'First', body: 'first body', entry: 'entry_1', latestEntryId: 'entry_1' })
    await call(root, { topic: 'Second', body: 'second body', entry: 'entry_2', latestEntryId: 'entry_2' })

    const events = await readEvents(streamPath(root))
    expect(events).toHaveLength(4)
    expect(events[0]!).toMatchObject({ type: 'fragment', topic: 'First' })
    expect(events[2]!).toMatchObject({ type: 'fragment', topic: 'Second' })
  })

  test('preserves multi-line bodies and special characters inside JSONL events', async () => {
    const root = tmpRoot()
    const body = ['line one', 'line two with `code`', 'emoji 🧠 and quotes "hello"', 'pipe | table char'].join('\n')

    await call(root, { topic: 'Special chars / multiline', body })

    const events = await readEvents(streamPath(root))
    expect(events[0]!).toMatchObject({ type: 'fragment', topic: 'Special chars / multiline', body })
  })

  test('latestEntryId can differ from the fragment entry', async () => {
    const root = tmpRoot()

    await call(root, { entry: 'fragment_entry', latestEntryId: 'latest_seen_entry' })

    const events = await readEvents(streamPath(root))
    expect(events[0]!).toMatchObject({ type: 'fragment', entry: 'fragment_entry' })
    expect(events[1]!).toMatchObject({ type: 'watermark', entry: 'latest_seen_entry' })
  })

  test('refuses to write content containing a GitHub fine-grained PAT', async () => {
    const root = tmpRoot()
    const fakePat = 'github_' + 'pat_' + 'X'.repeat(80)

    const err = await callExpectingThrow(root, { body: `GH_TOKEN=${fakePat}` })

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/credential|secret/i)
    expect((err as Error).message).toContain('github-pat')
  })

  test('does not create the file when content is rejected for containing a secret', async () => {
    const root = tmpRoot()

    await callExpectingThrow(root, { body: `token=${'sk-' + 'ant-' + 'X'.repeat(30)}` })

    expect(existsSync(streamPath(root))).toBe(false)
  })

  test('does not append when an existing stream would be polluted by secret content', async () => {
    const root = tmpRoot()
    await call(root, { topic: 'Prior', body: 'safe body' })

    await callExpectingThrow(root, { topic: 'Secret', body: `GH_TOKEN=${'ghp' + '_' + 'X'.repeat(36)}` })

    const events = await readEvents(streamPath(root))
    expect(events).toHaveLength(2)
    expect(events[0]!).toMatchObject({ type: 'fragment', topic: 'Prior' })
  })

  test('error message names every distinct secret rule that fired', async () => {
    const root = tmpRoot()
    const body = [`${'ghp' + '_' + 'X'.repeat(36)}`, `${'AK' + 'IA' + 'XXXXXXXXXXXXXXXX'}`].join('\n')

    const err = await callExpectingThrow(root, { body })
    const message = (err as Error).message
    expect(message).toContain('github-classic-pat')
    expect(message).toContain('aws-access-key')
  })

  test('still allows ordinary memory fragments through without false positives on prose', async () => {
    const root = tmpRoot()
    const body = [
      '**Claim**: The environment variable `GH_TOKEN` (not `GITHUB_TOKEN`) holds the GitHub PAT.',
      '**Evidence**: Discovered via `env | grep -i token`. Successfully used to fetch private repo data.',
      '**Implication**: For GitHub API operations, use `GH_TOKEN`, not `GITHUB_TOKEN`.',
    ].join('\n')

    await call(root, { topic: 'GitHub Token Environment Variable: GH_TOKEN', body })

    const events = await readEvents(streamPath(root))
    expect(events[0]!).toMatchObject({ type: 'fragment', topic: 'GitHub Token Environment Variable: GH_TOKEN', body })
  })

  test('refuses to append a fragment whose topic+body already exists in the stream', async () => {
    const root = tmpRoot()
    const body = [
      'Three Key Decisions raised by Jamie and confirmed:',
      '1. Eligibility (Conservative) - DELIVERED + no cancellation + no return',
      '2. Delete Strategy (Hybrid) - hard for user, soft for admin hide',
      '3. Review Count per Order Item - 1 per (user, order_item) with UNIQUE constraint',
    ].join('\n')

    await call(root, { source: 'ses_first', entry: '92ad3a70', topic: 'Review System Final Design Decisions', body })
    const err = await callExpectingThrow(root, {
      source: 'ses_second',
      entry: '1db7920a',
      topic: 'Review System Final Design Decisions',
      body,
    })

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/already exist|duplicate|byte-equivalent/i)
    expect((err as Error).message).toContain('Review System Final Design Decisions')
  })

  test('does not modify the stream when an append is rejected for duplication', async () => {
    const root = tmpRoot()
    await call(root, { topic: 'Existing', body: 'original body' })

    await callExpectingThrow(root, { source: 'ses_b', entry: 'entry_b', topic: 'Existing', body: 'original body' })

    const events = await readEvents(streamPath(root))
    expect(events).toHaveLength(2)
    expect(events[0]!).toMatchObject({ type: 'fragment', source: 'ses_a', topic: 'Existing' })
  })

  test('allows fragments whose topic matches but body differs', async () => {
    const root = tmpRoot()

    await call(root, { topic: 'Decision', body: 'use option A', entry: 'entry_1' })
    await call(root, { topic: 'Decision', body: 'actually use option B (decision changed)', entry: 'entry_2' })

    const events = await readEvents(streamPath(root))
    expect(events).toHaveLength(4)
    expect(events[0]!).toMatchObject({ type: 'fragment', body: 'use option A' })
    expect(events[2]!).toMatchObject({ type: 'fragment', body: 'actually use option B (decision changed)' })
  })

  test('treats whitespace-only differences as duplicates', async () => {
    const root = tmpRoot()

    await call(root, { topic: 'Topic', body: 'body line' })
    const err = await callExpectingThrow(root, { topic: 'Topic   ', body: 'body line   \n' })

    expect((err as Error).message).toContain('Topic')
  })

  test('dedups against pre-existing JSONL fragment events', async () => {
    const root = tmpRoot()
    const path = streamPath(root)
    mkdirSync(join(root, 'memory', 'streams'), { recursive: true })
    await Bun.write(
      path,
      `${JSON.stringify({
        type: 'fragment',
        id: 'fixture-fragment',
        ts: new Date().toISOString(),
        source: 'ses_fixture',
        entry: 'entry_fixture',
        topic: 'Fixture',
        body: 'existing body',
      })}\n`,
    )

    const err = await callExpectingThrow(root, { topic: 'Fixture', body: 'existing body' })

    expect((err as Error).message).toContain('Fixture')
    expect(await readEvents(path)).toHaveLength(1)
  })
})

const channelOrigin: SessionOrigin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: 'T0123',
  workspaceName: 'Acme',
  chat: 'C0456',
  chatName: 'incidents',
  thread: 'th-1',
  lastInboundAuthorId: 'U999',
}

describe('provenanceFromOrigin', () => {
  test('maps a channel origin to where coordinates, excluding author identity', () => {
    expect(provenanceFromOrigin(channelOrigin)).toEqual({
      adapter: 'slack-bot',
      workspace: 'T0123',
      workspaceName: 'Acme',
      chat: 'C0456',
      chatName: 'incidents',
      thread: 'th-1',
    })
  })

  test('omits unresolved human-readable names', () => {
    const where = provenanceFromOrigin({
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      thread: null,
    })
    expect(where).toEqual({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })
  })

  test('returns undefined for non-channel origins (TUI has no where)', () => {
    expect(provenanceFromOrigin({ kind: 'tui', sessionId: 'ses_a' })).toBeUndefined()
    expect(provenanceFromOrigin(undefined)).toBeUndefined()
  })

  test('drops a credential-shaped workspace/chat name but keeps the raw id', () => {
    const tokenShapedName = 'ghp' + '_' + 'X'.repeat(36)
    const where = provenanceFromOrigin({
      ...channelOrigin,
      workspaceName: tokenShapedName,
      chatName: tokenShapedName,
    })
    expect(where).toEqual({ adapter: 'slack-bot', workspace: 'T0123', chat: 'C0456', thread: 'th-1' })
  })
})

describe('appendTool provenance (who/where)', () => {
  test('stamps where from the origin provider and accepts an LLM-supplied who', async () => {
    const root = tmpRoot()
    const tool = createAppendTool({ originProvider: () => channelOrigin })

    await tool.execute({ ...baseInput, who: '홍길동' }, ctx(root))

    const events = await readEvents(streamPath(root))
    expect(events[0]!).toMatchObject({
      type: 'fragment',
      who: '홍길동',
      where: { adapter: 'slack-bot', chat: 'C0456', chatName: 'incidents', thread: 'th-1' },
    })
  })

  test('omits who and where when neither is supplied (legacy-shaped fragment)', async () => {
    const root = tmpRoot()

    await call(root)

    const fragment = (await readEvents(streamPath(root)))[0]!
    expect(fragment).not.toHaveProperty('who')
    expect(fragment).not.toHaveProperty('where')
  })

  test('does not stamp where for a non-channel origin even when who is given', async () => {
    const root = tmpRoot()
    const tool = createAppendTool({ originProvider: () => ({ kind: 'tui', sessionId: 'ses_a' }) })

    await tool.execute({ ...baseInput, who: 'Alice' }, ctx(root))

    const fragment = (await readEvents(streamPath(root)))[0]!
    expect(fragment).toMatchObject({ who: 'Alice' })
    expect(fragment).not.toHaveProperty('where')
  })

  test('refuses an LLM-supplied who that contains a credential pattern', async () => {
    const root = tmpRoot()
    const tokenShapedWho = 'ghp' + '_' + 'X'.repeat(36)

    const err = await callExpectingThrow(root, { who: tokenShapedWho })

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/credential|secret/i)
    expect(existsSync(streamPath(root))).toBe(false)
  })

  test('redacts a credential-shaped channel name instead of throwing, keeping the raw id', async () => {
    const root = tmpRoot()
    const tokenShapedName = 'ghp' + '_' + 'X'.repeat(36)
    const tool = createAppendTool({
      originProvider: () => ({
        kind: 'channel',
        adapter: 'slack-bot',
        workspace: 'T0123',
        workspaceName: tokenShapedName,
        chat: 'C0456',
        chatName: tokenShapedName,
        thread: null,
      }),
    })

    await tool.execute({ ...baseInput }, ctx(root))

    const fragment = (await readEvents(streamPath(root)))[0]!
    expect(fragment).toMatchObject({ where: { adapter: 'slack-bot', workspace: 'T0123', chat: 'C0456', thread: null } })
    expect(fragment.where).not.toHaveProperty('workspaceName')
    expect(fragment.where).not.toHaveProperty('chatName')
  })
})

describe('appendTool reference validation', () => {
  test('keeps already-clean references as-is when no resolver is wired', async () => {
    const root = tmpRoot()

    await call(root, { references: ['some-slug'] })

    const fragment = (await readEvents(streamPath(root)))[0]!
    expect(fragment).toMatchObject({ references: ['some-slug'] })
  })

  test('normalizes references (trim, drop blanks, de-dupe) even with no resolver wired', async () => {
    const root = tmpRoot()

    await call(root, { references: ['  spaced  ', '', '   ', 'dup', 'dup'] })

    const fragment = (await readEvents(streamPath(root)))[0]!
    expect(fragment).toMatchObject({ references: ['spaced', 'dup'] })
  })

  test('omits the references field entirely when no resolver is wired and all entries are blank', async () => {
    const root = tmpRoot()

    await call(root, { references: ['', '   '] })

    const fragment = (await readEvents(streamPath(root)))[0]!
    expect(fragment).not.toHaveProperty('references')
  })

  test('keeps only resolver-known slugs and drops the rest', async () => {
    const root = tmpRoot()
    const tool = createAppendTool({ referenceSlugResolver: async () => ['real-slug', 'other-real'] })

    await tool.execute(
      { ...baseInput, references: ['real-slug', 'streams/2026-06-19#abc', 'invented-pr-998', 'other-real'] },
      ctx(root),
    )

    const fragment = (await readEvents(streamPath(root)))[0]!
    expect(fragment).toMatchObject({ references: ['real-slug', 'other-real'] })
  })

  test('omits the references field entirely when every cited slug is unknown', async () => {
    const root = tmpRoot()
    const tool = createAppendTool({ referenceSlugResolver: async () => [] })

    await tool.execute({ ...baseInput, references: ['ghost-1', 'ghost-2'] }, ctx(root))

    const fragment = (await readEvents(streamPath(root)))[0]!
    expect(fragment).not.toHaveProperty('references')
  })

  test('drops empty-string and whitespace-only slugs even when a resolver allows real ones', async () => {
    const root = tmpRoot()
    const tool = createAppendTool({ referenceSlugResolver: async () => ['kept'] })

    await tool.execute({ ...baseInput, references: ['', '   ', 'kept'] }, ctx(root))

    const fragment = (await readEvents(streamPath(root)))[0]!
    expect(fragment).toMatchObject({ references: ['kept'] })
  })

  test('logs the dropped slugs so dangling citations are observable', async () => {
    const root = tmpRoot()
    const tool = createAppendTool({ referenceSlugResolver: async () => ['kept'] })
    const warnings: string[] = []
    const loggingCtx: ToolContext = {
      signal: undefined,
      sessionId: 'test',
      agentDir: root,
      logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    }

    await tool.execute({ ...baseInput, references: ['kept', 'dangling'] }, loggingCtx)

    expect(warnings.some((m) => m.includes('dangling') && /unknown reference slug/i.test(m))).toBe(true)
  })
})

describe('advanceWatermarkTool', () => {
  test('writes only a watermark event', async () => {
    const root = tmpRoot()

    await advanceWatermarkTool.execute({ source: 'ses_a', latestEntryId: 'latest_entry' }, ctx(root))

    const events = await readEvents(streamPath(root))
    expect(events).toHaveLength(1)
    expect(events[0]!).toMatchObject({ type: 'watermark', source: 'ses_a', entry: 'latest_entry' })
  })

  test('writes UUIDv7-shaped ids whose ts field matches the id timestamp', async () => {
    const root = tmpRoot()

    await advanceWatermarkTool.execute({ source: 'ses_a', latestEntryId: 'latest_entry' }, ctx(root))

    const events = await readEvents(streamPath(root))
    const watermark = events[0]!
    const id = String(watermark.id)
    const ts = String(watermark.ts)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const tsMs = new Date(ts).getTime()
    const idHex = id.replace(/-/g, '').slice(0, 12)
    expect(tsMs).toBe(Number.parseInt(idHex, 16))
  })

  test('appendTool fragment and watermark ids are both UUIDv7 and time-ordered', async () => {
    const root = tmpRoot()

    await call(root)

    const events = await readEvents(streamPath(root))
    const fragmentId = String(events[0]!.id)
    const watermarkId = String(events[1]!.id)
    expect(fragmentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(watermarkId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/)
    expect(fragmentId <= watermarkId).toBe(true)
  })
})
