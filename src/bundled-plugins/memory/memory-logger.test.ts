import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RunSession, SubagentContext } from '@/plugin'
import { formatLocalDate } from '@/shared'

import {
  createMemoryLoggerSubagent,
  isMemoryLoggerPayload,
  MEMORY_LOGGER_SYSTEM_PROMPT,
  type MemoryLoggerLogger,
  memoryLoggerSubagent,
  type MemoryLoggerPayload,
} from './memory-logger'

const silentLogger: MemoryLoggerLogger = { info: () => {}, warn: () => {}, error: () => {} }
const silentSubagent = createMemoryLoggerSubagent({ logger: silentLogger })

function fragment(source: string, entry: string, id = `f-${entry}`): string {
  return `${JSON.stringify({ type: 'fragment', id, ts: '2026-05-16T12:00:00.000Z', source, entry, topic: 'T', body: 'B' })}\n`
}

function watermark(source: string, entry: string, id = `w-${entry}`): string {
  return `${JSON.stringify({ type: 'watermark', id, ts: '2026-05-16T12:00:00.000Z', source, entry })}\n`
}

function makeAgentDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'memory-agent-'))
  mkdirSync(join(root, 'memory', 'streams'), { recursive: true })
  mkdirSync(join(root, 'sessions'))
  return root
}

async function invokeWith(
  payload: MemoryLoggerPayload,
  agentDir: string,
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
  await silentSubagent.handler!(ctx, runSession)
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

  test('requires every fragment to be evidence-anchored and self-contained', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('self-contained')
    expect(lower).toMatch(/anchored to evidence|anchor.*evidence|evidence.*anchor/)
  })

  test('frames both over-writing and under-writing as failure modes', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('over-writing')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('under-writing')
  })

  test('declares a "when in doubt, SKIP" capture philosophy biased toward low fragment counts', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('when in doubt, skip')
    expect(lower).toMatch(/zero or one fragment|recurrence|skipping costs nothing/)
  })

  test('lists chat-mechanical anti-patterns explicitly so the subagent stops recording them', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('conversational mechanics')
    expect(lower).toContain('group-chat membership events')
    expect(lower).toMatch(/single-occurrence|one event produces at most one fragment/)
  })

  test('does not require fragments to articulate a future behavior change', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(
      /does(n't| not) need to articulate.*future agent|no.*Implication.*not required|implication is obvious/i,
    )
  })

  test('forbids turning memories into proactive duties', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('memory is context, not authorization')
    expect(lower).toContain('must not create self-executing jobs')
    expect(lower).toContain('never use it to authorize action without a current user request')
  })

  test('names dreaming as the consolidation/filter step that runs after capture', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('dreaming')
  })

  test('declares a watermark contract that handles the zero-fragment case', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('watermark')
  })

  test('declares latestEntryId as the watermark argument instead of a raw marker', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toContain('latestEntryId')
    expect(MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()).toContain('you no longer emit a separate watermark marker')
  })

  test('forbids stamping every fragment with the same "latest evaluated" entry id (the winky bug)', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/per-fragment|each fragment.*own entry|do not stamp every fragment/i)
  })

  test('explains that fragment entry= is the evidence anchor, not the latest evaluated entry', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/anchors.*evidence|specific.*entry that anchors/i)
  })

  test('explains that latestEntryId is the latest evaluated entry, regardless of fragment anchors', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/latest.*entry.*evaluated|regardless.*anchored/i)
  })

  test('documents the zero-fragments watermark-advance path', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('zero-fragments path')
    expect(lower).toContain('watermark-advance tool')
  })

  test('forbids quoting credential values verbatim and explains why', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/never quote secret values|never quote credential values/i)
    expect(lower).toContain('rotation')
    expect(lower).toContain('force-committed to git')
  })

  test('shows allowed vs forbidden secret-handling examples', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/Allowed:.*GH_TOKEN/s)
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/Forbidden:.*GH_TOKEN=/s)
  })

  test('warns the subagent that the append tool enforces the secret-handling rule', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/append.*refuse.*credential|append.*refuse.*recognizable/i)
  })

  test('warns about the append-tool dedup rule (content-equality, not marker-equality)', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/byte-equivalent|content-equality|same daily stream/)
    expect(lower).toMatch(/refuse.*fragment|reject.*fragment/)
  })

  test('teaches the subagent to use find_entry to jump past the watermark instead of scrolling from line 1', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toContain('find_entry')
    expect(lower).toMatch(/before .*read|use find_entry before|find_entry.*then.*read/)
  })

  test('explains the read tool truncates large files so scrolling from line 1 is expensive', () => {
    expect(MEMORY_LOGGER_SYSTEM_PROMPT).toMatch(/truncat\w+.*(50 ?KB|2000 lines)/i)
  })

  test('forbids re-emitting the input watermark id as the new watermark id', () => {
    const lower = MEMORY_LOGGER_SYSTEM_PROMPT.toLowerCase()
    expect(lower).toMatch(/never write the same watermark id|advance the watermark|move forward each run/)
  })
})

describe('memoryLoggerSubagent', () => {
  test('declares the memory-logger system prompt', () => {
    expect(memoryLoggerSubagent.systemPrompt).toBe(MEMORY_LOGGER_SYSTEM_PROMPT)
  })

  test('declares one built-in tool (read) and three custom tools (find_entry, append, watermark advance)', () => {
    expect(memoryLoggerSubagent.tools).toBeDefined()
    expect(memoryLoggerSubagent.tools!.length).toBe(1)
    expect(memoryLoggerSubagent.customTools).toBeDefined()
    expect(memoryLoggerSubagent.customTools!.length).toBe(3)
    const descriptions = memoryLoggerSubagent.customTools!.map((t) => t.description)
    expect(descriptions.some((d) => d.includes('Locate a session-transcript entry'))).toBe(true)
    expect(descriptions.some((d) => d.includes('Append a memory fragment'))).toBe(true)
    expect(descriptions.some((d) => d.includes('Advance the daily-stream watermark'))).toBe(true)
  })

  test('declares a defensive tool-result byte budget on the read tool so a malfunctioning find_entry cannot cause unbounded chunked reads', () => {
    expect(memoryLoggerSubagent.toolResultBudget).toBeDefined()
    expect(memoryLoggerSubagent.toolResultBudget!.maxTotalBytes).toBeGreaterThanOrEqual(64 * 1024)
    expect(memoryLoggerSubagent.toolResultBudget!.maxTotalBytes).toBeLessThanOrEqual(1024 * 1024)
  })

  test('budgets ONLY the read tool so the append / find_entry recovery path stays open after exhaustion', () => {
    expect([...memoryLoggerSubagent.toolResultBudget!.toolNames]).toEqual(['read'])
  })

  test('exhausted-budget message tells the subagent to exit silently when no transcript content was read (never invent a watermark)', () => {
    const msg = memoryLoggerSubagent.toolResultBudget!.exhaustedMessage!(256 * 1024, 256 * 1024)
    expect(msg).toContain('exit immediately')
    expect(msg).toContain('WITHOUT writing a watermark')
    expect(msg).toContain('Do not invent or reuse a watermark id')
  })

  test('declares an inFlightKey that keys on agentDir (so two concurrent sessions for the same agent serialize)', () => {
    expect(memoryLoggerSubagent.inFlightKey).toBeDefined()
    const key = memoryLoggerSubagent.inFlightKey!({
      parentSessionId: 'ses_abc',
      parentTranscriptPath: '/x',
      agentDir: '/agents/winky',
    })
    expect(key).toBe('/agents/winky')
  })

  test('two payloads from different sessions of the same agent produce the same inFlightKey', () => {
    const keyA = memoryLoggerSubagent.inFlightKey!({
      parentSessionId: 'ses_a',
      parentTranscriptPath: '/x',
      agentDir: '/agents/winky',
    })
    const keyB = memoryLoggerSubagent.inFlightKey!({
      parentSessionId: 'ses_b',
      parentTranscriptPath: '/y',
      agentDir: '/agents/winky',
    })
    expect(keyA).toBe(keyB)
  })

  test('two payloads from the same session of different agents produce different inFlightKeys', () => {
    const keyA = memoryLoggerSubagent.inFlightKey!({
      parentSessionId: 'ses_x',
      parentTranscriptPath: '/x',
      agentDir: '/agents/winky',
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
    expect(prompt).toMatch(/memory\/streams\/\d{4}-\d{2}-\d{2}\.jsonl/)
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

  test('handler instructs the subagent to pass latestEntryId or use the watermark-advance tool', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt).toContain('latestEntryId')
    expect(prompt).toContain('watermark-advance tool')
    expect(prompt).toContain('ses_abc')
  })

  test('handler instructs the subagent that each fragment carries its own evidence-anchor entry id', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    const prompt = runSessionCalls[0]!.userPrompt!
    expect(prompt.toLowerCase()).toMatch(/per-fragment provenance|specific transcript entry that anchors/i)
  })

  test('handler points the subagent at MEMORY.md so it can read existing memory first', async () => {
    const agentDir = makeAgentDir()
    const transcript = join(agentDir, 'sessions', 'ses_abc.jsonl')
    writeFileSync(transcript, '')

    const { runSessionCalls } = await invokeWith(
      { parentSessionId: 'ses_abc', parentTranscriptPath: transcript, agentDir },
      agentDir,
    )

    expect(runSessionCalls[0]!.userPrompt!).toContain(join(agentDir, 'MEMORY.md'))
    expect(runSessionCalls[0]!.userPrompt!).toMatch(/read MEMORY\.md/i)
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

  test('the default exported memoryLoggerSubagent still has a handler (back-compat)', () => {
    expect(memoryLoggerSubagent.handler).toBeDefined()
  })
})
