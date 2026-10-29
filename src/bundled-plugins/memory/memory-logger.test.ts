import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RunSession, SubagentContext } from '@/plugin'
import { formatLocalDate } from '@/shared'

import { appendTool } from './append-tool'
import {
  createMemoryLoggerSubagent,
  isMemoryLoggerPayload,
  MEMORY_LOGGER_SYSTEM_PROMPT,
  type MemoryLoggerLogger,
  memoryLoggerSubagent,
  type MemoryLoggerPayload,
} from './memory-logger'
import { streamFilePath } from './paths'
import { parseReference } from './references/frontmatter'
import { storeReferenceTool } from './references/store-reference-tool'
import { readEvents } from './stream-io'
import { PRELOAD_OVERHEAD_TOKENS } from './transcript-preload'

const silentLogger: MemoryLoggerLogger = { info: () => {}, warn: () => {}, error: () => {} }
const silentSubagent = createMemoryLoggerSubagent({
  logger: silentLogger,
  fastModelLimits: () => [{ contextWindow: 400_000, outputTokens: 32_000 }],
})

function fragment(source: string, entry: string, id = `f-${entry}`): string {
  return `${JSON.stringify({ type: 'fragment', id, ts: '2026-05-16T12:00:00.000Z', source, entry, topic: 'T', body: 'B' })}\n`
}

function watermark(source: string, entry: string, id = `w-${entry}`): string {
  return `${JSON.stringify({ type: 'watermark', id, ts: '2026-05-16T12:00:00.000Z', source, entry })}\n`
}

function makeAgentDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'memory-agent-'))
  mkdirSync(join(root, 'memory'))
  mkdirSync(join(root, 'memory', 'streams'))
  mkdirSync(join(root, 'sessions'))
  return root
}

async function invokeWith(
  payload: MemoryLoggerPayload,
  agentDir: string,
  subagent = silentSubagent,
): Promise<{ runSessionCalls: { userPrompt: string | undefined }[] }> {
  const calls: { userPrompt: string | undefined }[] = []
  const runSession: RunSession = async (override) => {
    calls.push({ userPrompt: override?.userPrompt })
  }
  const ctx: SubagentContext<MemoryLoggerPayload> = {
    userPrompt: '',
    agentDir,
    payload,
  }
  await subagent.handler!(ctx, runSession)
  return { runSessionCalls: calls }
}

describe('isMemoryLoggerPayload', () => {
  test('accepts a valid payload', () => {
    expect(
      isMemoryLoggerPayload({
        parentSessionId: 'ses_abc',
        parentTranscriptPath: '/path/to/file.jsonl',
        agentDir: '/path/to/agent',
      }),
    ).toBe(true)
  })

  test('accepts a payload with channel origin context', () => {
    expect(
      isMemoryLoggerPayload({
        parentSessionId: 'ses_abc',
        parentTranscriptPath: '/path/to/file.jsonl',
        agentDir: '/path/to/agent',
        origin: {
          kind: 'channel',
          adapter: 'slack-bot',
          workspace: 'T123',
          workspaceName: 'Acme',
          chat: 'C456',
          chatName: 'infra',
          thread: '171234.0001',
          lastInboundAuthorId: 'U1',
          participants: [
            {
              authorId: 'U1',
              authorName: 'Neo',
              firstMessageAt: 1000,
              lastMessageAt: 2000,
              messageCount: 2,
            },
          ],
        },
      }),
    ).toBe(true)
  })

  test('rejects when fields are missing', () => {
    expect(isMemoryLoggerPayload({})).toBe(false)
    expect(isMemoryLoggerPayload({ parentSessionId: '', parentTranscriptPath: 'b', agentDir: 'c' })).toBe(false)
  })
})

describe('MEMORY_LOGGER_SYSTEM_PROMPT', () => {
  test('declares the append tool fragment input schema', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('{topic, body, source, entry, latestEntryId}')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('you never write raw JSON')
  })

  test('declares latestEntryId as the watermark argument instead of a raw marker', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('latestEntryId')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('you no longer emit a separate watermark marker')
  })
})

describe('memoryLoggerSubagent', () => {
  test('declares the memory-logger system prompt', () => {
    expect(memoryLoggerSubagent.systemPrompt).toBe(MEMORY_LOGGER_SYSTEM_PROMPT)
  })

  test('declares one built-in tool (read) and four custom tools (find_entry, append, store_reference, watermark advance)', () => {
    expect(memoryLoggerSubagent.tools).toBeDefined()
    expect(memoryLoggerSubagent.tools!.length).toBe(1)
    expect(memoryLoggerSubagent.customTools).toBeDefined()
    expect(memoryLoggerSubagent.customTools!.length).toBe(4)
    const descriptions = memoryLoggerSubagent.customTools!.map((t) => t.description)
    expect(descriptions.some((d) => d.includes('Locate a session-transcript entry'))).toBe(true)
    expect(descriptions.some((d) => d.includes('Append a memory fragment'))).toBe(true)
    expect(descriptions.some((d) => d.includes('Advance the daily-stream watermark'))).toBe(true)
    expect(descriptions.some((d) => d.includes('store_reference'))).toBe(true)
  })

  test('declares a defensive tool-result byte budget on the read tool so a malfunctioning find_entry cannot cause unbounded chunked reads', () => {
    expect(memoryLoggerSubagent.toolResultBudget).toBeDefined()
    expect(memoryLoggerSubagent.toolResultBudget!.maxTotalBytes).toBeGreaterThanOrEqual(64 * 1024)
    expect(memoryLoggerSubagent.toolResultBudget!.maxTotalBytes).toBeLessThanOrEqual(1024 * 1024)
  })

  test('budgets ONLY the read tool so the append / find_entry recovery path stays open after exhaustion', () => {
    expect([...memoryLoggerSubagent.toolResultBudget!.toolNames]).toEqual(['read'])
  })

  test("runs on the 'fast' profile so it does not share the slow default model a researcher saturates", () => {
    expect(memoryLoggerSubagent.profile).toBe('fast')
  })

  test('declares an inFlightKey that keys on agentDir (so two concurrent sessions for the same agent serialize)', () => {
    expect(memoryLoggerSubagent.inFlightKey).toBeDefined()
    const key = memoryLoggerSubagent.inFlightKey!({
      parentSessionId: 'ses_abc',
      parentTranscriptPath: '/x',
      agentDir: '/agents/momo',
    })
    expect(key).toBe('/agents/momo')
  })

  test('two payloads from different sessions of the same agent produce the same inFlightKey', () => {
    const keyA = memoryLoggerSubagent.inFlightKey!({
      parentSessionId: 'ses_a',
      parentTranscriptPath: '/x',
      agentDir: '/agents/momo',
    })
    const keyB = memoryLoggerSubagent.inFlightKey!({
      parentSessionId: 'ses_b',
      parentTranscriptPath: '/y',
      agentDir: '/agents/momo',
    })
    expect(keyA).toBe(keyB)
  })

  test('two payloads from the same session of different agents produce different inFlightKeys', () => {
    const keyA = memoryLoggerSubagent.inFlightKey!({
      parentSessionId: 'ses_x',
      parentTranscriptPath: '/x',
      agentDir: '/agents/momo',
    })
    const keyB = memoryLoggerSubagent.inFlightKey!({
      parentSessionId: 'ses_x',
      parentTranscriptPath: '/x',
      agentDir: '/agents/dolsoe',
    })
    expect(keyA).not.toBe(keyB)
  })

  test('handler builds an initial prompt mentioning transcript, session id, and stream file', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    expect(runSessionCalls).toHaveLength(1)
    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).toContain(transcript)
    expect(prompt).toContain('ses_abc')
    expect(prompt).toMatch(/memory[/\\]streams[/\\]\d{4}-\d{2}-\d{2}\.jsonl/)
  })

  test('handler preloads the transcript slice past the watermark into the initial prompt', async () => {
    // given
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(
      transcript,
      ['seen', 'watermrk', 'fresh'].map((id) => `${JSON.stringify({ type: 'message', id })}\n`).join(''),
    )
    writeFileSync(join(agentDir, 'memory', 'streams', `${formatLocalDate()}.jsonl`), watermark('ses_abc', 'watermrk'))

    // when
    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    // then
    const prompt = runSessionCalls[0]!.userPrompt!
    const preloaded = prompt.slice(prompt.indexOf('<transcript>'))
    expect(prompt).toContain('Preloaded transcript lines 3-3 of totalLines=3')
    expect(preloaded).toContain('"id":"fresh"')
    expect(preloaded).not.toContain('"id":"seen"')
  })

  test('handler keeps a token-dense preload inside the smallest fast-chain context window', async () => {
    // given a near-cap transcript of comma-separated digits (about one token per byte)
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    const dense = Array.from({ length: 1000 }, (_, i) => i % 10).join(',')
    const line = (i: number) => `${JSON.stringify({ type: 'message', id: `e${i}`, text: dense })}\n`
    writeFileSync(transcript, Array.from({ length: 130 }, (_, i) => line(i)).join(''))
    const small = { contextWindow: 128_000, outputTokens: 32_000 }
    const subagent = createMemoryLoggerSubagent({
      logger: silentLogger,
      fastModelLimits: () => [{ contextWindow: 400_000, outputTokens: 32_000 }, small],
    })

    // when
    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
      subagent,
    )

    // then: UTF-8 bytes bound the input tokens for any byte-level tokenizer, and
    // the request's output allowance must fit beside them
    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).toContain('More lines remain')
    const promptBytes = Buffer.byteLength(prompt, 'utf8') + Buffer.byteLength(MEMORY_LOGGER_SYSTEM_PROMPT, 'utf8')
    expect(promptBytes + PRELOAD_OVERHEAD_TOKENS + small.outputTokens).toBeLessThanOrEqual(small.contextWindow)
  })

  test('handler keeps the read loop when no useful preload fits the context window', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, `${JSON.stringify({ type: 'message', id: 'a' })}\n`)
    const smallContext = createMemoryLoggerSubagent({
      logger: silentLogger,
      fastModelLimits: () => [{ contextWindow: 32_768, outputTokens: 8_192 }],
    })

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
      smallContext,
    )

    expect(runSessionCalls[0]!.userPrompt!).not.toContain('<transcript>')
  })

  test('handler includes channel location and participants in the initial prompt', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      {
        parentSessionId: 'ses_abc',
        parentTranscriptPath: transcript,
        agentDir,
        origin: {
          kind: 'channel',
          adapter: 'slack-bot',
          workspace: 'T123',
          workspaceName: 'Acme',
          chat: 'C456',
          chatName: 'infra',
          thread: '171234.0001',
          lastInboundAuthorId: 'U1',
          participants: [
            {
              authorId: 'U1',
              authorName: 'Neo',
              firstMessageAt: 1000,
              lastMessageAt: 2000,
              messageCount: 2,
            },
          ],
        },
      },
      agentDir,
    )

    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).toContain('Conversation context:')
    expect(prompt).toContain('- Adapter: slack-bot')
    expect(prompt).toContain('- Workspace: Acme (T123)')
    expect(prompt).toContain('- Chat: infra (C456)')
    expect(prompt).toContain('- Thread: 171234.0001')
    expect(prompt).toContain('- Last inbound author: U1')
    expect(prompt).toContain('Neo (U1); messages=2')
  })

  test('handler includes the watermark when one exists in the daily stream', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')
    const today = formatLocalDate()
    writeFileSync(join(agentDir, 'memory', 'streams', `${today}.jsonl`), fragment('ses_abc', 'watermrk'))

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    expect(runSessionCalls[0]!.userPrompt!).toContain('watermrk')
  })

  test("handler picks up YESTERDAY'S watermark when today's stream is missing (midnight-rollover case)", async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')
    const today = formatLocalDate()
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const yyyy = yesterday.getFullYear()
    const mm = String(yesterday.getMonth() + 1).padStart(2, '0')
    const dd = String(yesterday.getDate()).padStart(2, '0')
    const yesterdayName = `${yyyy}-${mm}-${dd}.jsonl`
    expect(yesterdayName).not.toBe(`${today}.jsonl`)
    writeFileSync(
      join(agentDir, 'memory', 'streams', yesterdayName),
      [fragment('ses_abc', 'yesterday-morning'), watermark('ses_abc', 'yesterday-evening')].join(''),
    )

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).toContain('yesterday-evening')
    expect(prompt).not.toContain('Watermark: none')
  })

  test('handler emits Stream line cursor line when streamLineCursor is in the payload', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir, streamLineCursor: 7 },
      agentDir,
    )

    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).toMatch(/Stream line cursor: 7/)
    expect(prompt).toMatch(/offset=8/)
  })

  test('handler omits Stream line cursor line when payload has no streamLineCursor', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).not.toMatch(/Stream line cursor:/)
  })

  test('handler indicates "no prior watermark" when none exists', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    expect(runSessionCalls[0]!.userPrompt!.toLowerCase()).toMatch(/no.*watermark|no prior|first time|begin/)
  })

  test('handler emits a [memory-logger] start log line with parentSessionId and watermark on every run', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const logs: string[] = []
    const subagent = createMemoryLoggerSubagent({
      logger: { info: (m) => logs.push(m), warn: () => {}, error: () => {} },
    })
    const runSession: RunSession = async () => {}
    const ctx: SubagentContext<MemoryLoggerPayload> = {
      userPrompt: '',
      agentDir,
      payload: { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
    }
    await subagent.handler!(ctx, runSession)

    const startLog = logs.find((l) => l.startsWith('[memory-logger] ses_abc start'))
    expect(startLog).toBeDefined()
    expect(startLog!).toContain('watermark=none')
    expect(logs.some((l) => l.startsWith('[memory-logger] ses_abc done'))).toBe(true)
  })

  test('handler emits a [memory-logger] warn log line and rethrows when runSession fails', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const warnings: string[] = []
    const subagent = createMemoryLoggerSubagent({
      logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    })
    const runSession: RunSession = async () => {
      throw new Error('LLM blew up')
    }
    const ctx: SubagentContext<MemoryLoggerPayload> = {
      userPrompt: '',
      agentDir,
      payload: { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
    }
    await expect(subagent.handler!(ctx, runSession)).rejects.toThrow('LLM blew up')
    expect(warnings.some((m) => m.includes('[memory-logger] ses_abc') && m.includes('LLM blew up'))).toBe(true)
  })

  test('creates memory/streams/ on first write if absent', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'memory-agent-'))
    mkdirSync(join(agentDir, 'memory'))
    mkdirSync(join(agentDir, 'sessions'))
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const runSession: RunSession = async () => {
      await appendTool.execute(
        {
          topic: 'Test',
          body: 'Test body',
          source: 'ses_abc',
          entry: 'entry_1',
          latestEntryId: 'entry_1',
        },
        {
          signal: undefined,
          sessionId: 'test',
          agentDir,
          logger: { info: () => {}, warn: () => {}, error: () => {} },
        },
      )
    }
    const ctx: SubagentContext<MemoryLoggerPayload> = {
      userPrompt: '',
      agentDir,
      payload: { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
    }
    await silentSubagent.handler!(ctx, runSession)

    const today = formatLocalDate()
    expect(existsSync(join(agentDir, 'memory', 'streams'))).toBe(true)
    expect(existsSync(join(agentDir, 'memory', 'streams', `${today}.jsonl`))).toBe(true)
  })

  test('run can store a verbatim reference and append a fragment citing it', async () => {
    const agentDir = makeAgentDir()
    const sql = 'SELECT * FROM users WHERE id = 1'
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(
      transcript,
      `${JSON.stringify({ id: 'entry_sql', role: 'user', text: `remember this query verbatim: ${sql}` })}\n`,
    )

    const runSession: RunSession = async () => {
      const stored = await storeReferenceTool.execute(
        { title: 'User lookup query', body: sql, origin: 'episode', tags: [] },
        toolCtx(agentDir),
      )
      const slug = (stored.details as { slug: string }).slug
      await appendTool.execute(
        {
          topic: 'verbatim reference stored',
          body: 'The user explicitly asked to remember the user lookup SQL query verbatim.',
          source: 'ses_abc',
          entry: 'entry_sql',
          latestEntryId: 'entry_sql',
          references: [slug],
        },
        toolCtx(agentDir),
      )
    }
    const ctx: SubagentContext<MemoryLoggerPayload> = {
      userPrompt: '',
      agentDir,
      payload: { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
    }

    await silentSubagent.handler!(ctx, runSession)

    const referenceText = readFileSync(join(agentDir, 'memory', 'references', 'user-lookup-query.md'), 'utf8')
    expect(parseReference(referenceText).body).toBe(sql)
    const events = await readEvents(streamFilePath(agentDir, formatLocalDate()))
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'fragment',
        topic: 'verbatim reference stored',
        references: ['user-lookup-query'],
      }),
    )
  })

  test('the wired append tool drops a hallucinated reference slug while keeping the real one', async () => {
    const agentDir = makeAgentDir()
    const wiredStore = silentSubagent.customTools!.find((t) => t.description.startsWith('store_reference:'))!
    const wiredAppend = silentSubagent.customTools!.find((t) => t.description.startsWith('Append a memory fragment'))!

    const stored = await wiredStore.execute(
      { title: 'Lookup query', body: 'SELECT 1', origin: 'episode', tags: [] },
      toolCtx(agentDir),
    )
    const slug = (stored.details as { slug: string }).slug

    await wiredAppend.execute(
      {
        topic: 'verbatim reference stored',
        body: 'Stored the lookup query.',
        source: 'ses_abc',
        entry: 'entry_sql',
        latestEntryId: 'entry_sql',
        references: [slug, 'typeclaw-pr-998-invented', ''],
      },
      toolCtx(agentDir),
    )

    const events = await readEvents(streamFilePath(agentDir, formatLocalDate()))
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'fragment', topic: 'verbatim reference stored', references: [slug] }),
    )
  })
})

function toolCtx(agentDir: string) {
  return {
    signal: undefined,
    sessionId: 'test',
    agentDir,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}
