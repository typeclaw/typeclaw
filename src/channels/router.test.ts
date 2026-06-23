import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile as writeFileFs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { AfterToolCallContext, AfterToolCallResult, StreamFn } from '@mariozechner/pi-agent-core'
import type { AssistantMessage } from '@mariozechner/pi-ai'
import type { SessionEntry } from '@mariozechner/pi-coding-agent'

import type { AgentSession } from '@/agent'
import type { RestartHandoff } from '@/agent/restart-handoff'
import type { SessionOrigin } from '@/agent/session-origin'
import type { PermissionService } from '@/permissions'
import type { HookBus, SessionIdleEvent } from '@/plugin'

import type { ChannelSessionRecord } from './persistence'
import { channelsSessionsPath, loadChannelSessions, saveChannelSessions } from './persistence'
import {
  CHANNEL_EMPTY_TURN_RETRY_MAX_OUTPUT_TOKENS,
  CHANNEL_MAX_OUTPUT_TOKENS,
  createChannelRouter,
  disengageReactionEmojiFor,
  DUPLICATE_SEND_ERROR,
  EMPTY_TURN_FALLBACK_TEXT,
  EMPTY_TURN_RETRY_NUDGE,
  extractPlainTextChannelToolCallText,
  getPlainTextChannelToolCallKind,
  HISTORY_ATTACHMENT_LIMIT,
  MAX_CHANNEL_SENDS_PER_TURN,
  MAX_EMPTY_TURN_RETRIES,
  MAX_POLICY_DENIED_CHANNEL_SENDS_PER_TURN,
  MAX_TYPING_HEARTBEAT_MS,
  MAX_WILLINGNESS_NUDGES,
  OUTBOUND_FLOOD_ERROR,
  ROUTE_WORKSPACE_ANY,
  SEND_RATE_WARN_THRESHOLD,
  SEND_RATE_WINDOW_MS,
  SEND_WILLINGNESS_NUDGE,
  STRANDED_TOOLUSE_CONTINUATION_NUDGE,
  isGraceWorthReusing,
  SESSION_GC_INTERVAL_MS,
  SESSION_FRESHNESS_TTL_MS,
  OBSERVED_MESSAGE_MAX_CHARS,
  SESSION_GRACE_HARD_TTL_MS,
  SESSION_IDLE_MS,
  SESSION_CHILD_PIN_MAX_MS,
  sliceHeadTail,
  StaleLiveSessionError,
  stripThinkBlocks,
  TURN_CAP_ERROR,
  WILLINGNESS_NUDGE,
  type ChannelRouter,
  type ClaimHandler,
  type RestartCommandContext,
} from './router'
import { defaultHistoryConfig, QUOTED_REPLY_EXCERPT_MAX_CHARS, type ChannelAdapterConfig } from './schema'
import type {
  ChannelHistoryMessage,
  ChannelKey,
  FetchHistoryArgs,
  HistoryCallback,
  InboundMessage,
  RemoveReactionRequest,
  OutboundMessage,
  ReactionRequest,
  ReactionRef,
  SendResult,
} from './types'

class FakeSession {
  public prompts: string[] = []
  public aborted = 0
  public disposed = 0
  public thinkingLevels: string[] = []
  setThinkingLevel = (level: string): void => {
    this.thinkingLevels.push(level)
  }
  public leafEntry: SessionEntry | undefined
  // Additional entries indexed by id for `getEntry` lookups. Walked by
  // `recoverableAssistantText` when the leaf is a toolResult and we need to
  // find the assistant message that called the tool.
  public entriesById = new Map<string, SessionEntry>()
  public onPrompt: ((text: string) => void | Promise<void>) | undefined

  // Mirrors the real `AgentSession.agent` surface the router touches:
  // `agent.abort()` flips `agent.signal.aborted`. The router uses this as the
  // non-blocking turn terminator for the policy-denial loop guard. A fresh
  // AbortController is installed at the start of every `prompt()` so each turn
  // gets its own run signal (matching pi's per-run AbortController).
  public lastStreamMaxTokens: number | undefined
  public agent: {
    controller: AbortController
    readonly signal: AbortSignal
    abort(): void
    afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>
    streamFn: StreamFn
  }

  constructor() {
    const recordMaxTokens = (maxTokens: number | undefined): void => {
      this.lastStreamMaxTokens = maxTokens
    }
    this.agent = {
      controller: new AbortController(),
      get signal(): AbortSignal {
        return this.controller.signal
      },
      abort(): void {
        this.controller.abort()
      },
      streamFn: ((_model, _context, options) => {
        recordMaxTokens(options?.maxTokens)
        return undefined as unknown as ReturnType<StreamFn>
      }) as StreamFn,
    }
  }

  public sessionManager = {
    getLeafEntry: (): SessionEntry | undefined => this.leafEntry,
    getEntry: (id: string): SessionEntry | undefined => this.entriesById.get(id),
  }

  private subscribers = new Set<(event: Record<string, unknown> & { type: string }) => void>()

  prompt = async (text: string): Promise<void> => {
    this.prompts.push(text)
    this.agent.controller = new AbortController()
    await this.onPrompt?.(text)
  }
  abort = async (): Promise<void> => {
    this.aborted++
    this.agent.abort()
  }
  dispose = (): void => {
    this.disposed++
  }
  subscribe = (cb: (event: Record<string, unknown> & { type: string }) => void): (() => void) => {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }
  emit = (event: Record<string, unknown> & { type: string }): void => {
    for (const cb of this.subscribers) cb(event)
  }

  setAssistantText(text: string): void {
    this.leafEntry = messageEntry(assistantMessage(text))
  }

  setAssistantMidTurn(text: string, stopReason: AssistantMessage['stopReason'] = 'toolUse'): void {
    this.leafEntry = messageEntry({
      ...assistantMessage(text),
      content: [
        { type: 'text', text },
        { type: 'toolCall', id: 't0', name: 'bash', arguments: {} },
      ],
      stopReason,
    })
  }

  setAssistantMessage(message: AssistantMessage): void {
    this.leafEntry = messageEntry(message)
  }

  // A `length`-truncated leaf with ONLY text blocks (no synthetic toolCall),
  // matching the production shape: the model interleaved leaked `<think>` prose
  // with its real answer and hit the output cap. Each string becomes its own
  // text block so visibleAssistantText joins them exactly as in production.
  setAssistantLengthLeaf(...texts: string[]): void {
    this.leafEntry = messageEntry({
      ...assistantMessage(''),
      content: texts.map((text) => ({ type: 'text', text })),
      stopReason: 'length',
    })
  }
}

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'channels-router-'))
}

async function streamOnce(session: FakeSession): Promise<void> {
  await session.agent.streamFn(
    {} as Parameters<StreamFn>[0],
    { systemPrompt: '', messages: [], tools: [] } as Parameters<StreamFn>[1],
    undefined as Parameters<StreamFn>[2],
  )
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'test-model',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 1000,
  }
}

function messageEntry(message: AssistantMessage): SessionEntry {
  return {
    type: 'message',
    id: 'assistant-entry',
    parentId: null,
    timestamp: '2026-05-01T00:00:00.000Z',
    message,
  }
}

function strandOnUnansweredToolUse(session: FakeSession, id: string = 'strand'): void {
  const toolCallId = `tool-${id}`
  const assistantEntry: SessionEntry = {
    type: 'message',
    id: `assistant-${id}`,
    parentId: null,
    timestamp: '2026-06-15T06:23:45.000Z',
    message: {
      ...assistantMessage(''),
      content: [{ type: 'toolCall', id: toolCallId, name: 'stream_snapshot', arguments: { limit: 20 } }],
      stopReason: 'toolUse',
    },
  }
  const toolResultEntry: SessionEntry = {
    type: 'message',
    id: `tool-result-${id}`,
    parentId: assistantEntry.id,
    timestamp: '2026-06-15T06:23:45.500Z',
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: 'stream_snapshot',
      content: [{ type: 'text', text: 'stream events here' }],
      isError: false,
      timestamp: 1000,
    },
  }
  session.entriesById.set(assistantEntry.id, assistantEntry)
  session.entriesById.set(toolResultEntry.id, toolResultEntry)
  session.leafEntry = toolResultEntry
}

const baseConfig: ChannelAdapterConfig = {
  engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: { perReply: { window: 60_000 } } },
  enabled: true,
  history: defaultHistoryConfig(),
}

type SessionFactoryArgs = {
  existingSessionId?: string
  existingSessionFile?: string
}

// Test-only permission service that grants `channel.respond` to everyone.
// Most router tests don't exercise the gate; they need a permissive service
// so the router actually routes. Suites that test the gate inject their
// own.
const grantAllPermissions: PermissionService = {
  has: () => true,
  resolveRole: () => 'owner',
  compareRoleSeverity: () => 1,
  describe: () => ({ role: 'owner', permissions: ['channel.respond'] }),
  replaceRoles: () => {},
}

function makeRouter(
  agentDir: string,
  options: {
    config?: ChannelAdapterConfig
    sessions?: FakeSession[]
    nowRef?: { value: number }
    logs?: string[]
    origins?: SessionOrigin[]
    factoryCalls?: SessionFactoryArgs[]
    transcriptPathFor?: (sessionId: string) => string | undefined
    measureTranscriptBytes?: (path: string) => number
    configuredAliases?: () => readonly string[]
    ensureLiveTimeoutMs?: number
    permissions?: PermissionService
    claimHandler?: ClaimHandler
    hooks?: HookBus
    onReload?: () => Promise<string>
    onRestart?: (ctx?: RestartCommandContext) => Promise<string>
    saveChannelSessions?: (agentDir: string, sessions: readonly ChannelSessionRecord[]) => Promise<void>
    newestRunningChildSubagentStartedAt?: (sessionId: string) => number | null
  } = {},
): { router: ChannelRouter; sessions: FakeSession[]; origins: SessionOrigin[] } {
  const sessions: FakeSession[] = options.sessions ?? []
  const origins: SessionOrigin[] = options.origins ?? []
  const nowRef = options.nowRef ?? { value: 1000 }
  const router = createChannelRouter({
    agentDir,
    configForAdapter: () => options.config ?? baseConfig,
    ...(options.configuredAliases !== undefined ? { configuredAliases: options.configuredAliases } : {}),
    ...(options.ensureLiveTimeoutMs !== undefined ? { ensureLiveTimeoutMs: options.ensureLiveTimeoutMs } : {}),
    ...(options.measureTranscriptBytes !== undefined ? { measureTranscriptBytes: options.measureTranscriptBytes } : {}),
    ...(options.claimHandler !== undefined ? { claimHandler: options.claimHandler } : {}),
    ...(options.onReload !== undefined ? { onReload: options.onReload } : {}),
    ...(options.onRestart !== undefined ? { onRestart: options.onRestart } : {}),
    ...(options.saveChannelSessions !== undefined ? { saveChannelSessions: options.saveChannelSessions } : {}),
    ...(options.newestRunningChildSubagentStartedAt !== undefined
      ? { newestRunningChildSubagentStartedAt: options.newestRunningChildSubagentStartedAt }
      : {}),
    permissions: options.permissions ?? grantAllPermissions,
    now: () => nowRef.value,
    logger: {
      info: (m) => options.logs?.push(`info:${m}`),
      warn: (m) => options.logs?.push(`warn:${m}`),
      error: (m) => options.logs?.push(`error:${m}`),
    },
    createSessionForChannel: async ({ origin, existingSessionId, existingSessionFile }) => {
      options.factoryCalls?.push({
        ...(existingSessionId !== undefined ? { existingSessionId } : {}),
        ...(existingSessionFile !== undefined ? { existingSessionFile } : {}),
      })
      origins.push(origin)
      const fake = new FakeSession()
      sessions.push(fake)
      const sessionId = existingSessionId ?? `ses_fake_${sessions.length}`
      return {
        session: fake as unknown as AgentSession,
        sessionId,
        dispose: async () => {
          fake.dispose()
        },
        ...(options.transcriptPathFor !== undefined
          ? { getTranscriptPath: () => options.transcriptPathFor!(sessionId) }
          : {}),
        ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
      }
    },
  })
  return { router, sessions, origins }
}

const FIXED_INBOUND_TS = Date.parse('2024-06-15T12:34:56.000Z')
const FIXED_INBOUND_ISO = '2024-06-15T12:34:56.000Z'

function inbound(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    adapter: 'discord-bot',
    workspace: 'g1',
    chat: 'c1',
    thread: null,
    text: 'hello',
    externalMessageId: 'm1',
    authorId: 'alice',
    authorName: 'alice',
    authorIsBot: false,
    isBotMention: true,
    replyToBotMessageId: null,
    mentionsOthers: false,
    replyToOtherMessageId: null,
    isDm: false,
    ts: FIXED_INBOUND_TS,
    ...over,
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition not met')
}

async function expectPersistedLastInboundAt(agentDir: string, expected: number): Promise<void> {
  // No poll: callers always flushDebounce() first, which now awaits the persist
  // chain, so the lastInboundAt write has already landed on disk. Polling here
  // was the source of the Windows-CI flake — a tight wall-clock budget racing
  // tmpdir fs latency.
  const loaded = await loadChannelSessions(agentDir)
  expect(loaded[0]?.lastInboundAt).toBe(expected)
}

const KEY: ChannelKey = { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null }
const SLACK_KEY: ChannelKey = { adapter: 'slack-bot', workspace: 'g1', chat: 'c1', thread: null }

describe('ChannelRouter session lifecycle', () => {
  test('creates a session on first inbound and reuses it on second', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)
    await router.route(inbound({ externalMessageId: 'm2', text: 'follow up' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions).toHaveLength(1)
    expect(router.liveCount()).toBe(1)
  })

  test('includes registered self-identity in the session-creation origin', async () => {
    const dir = await tempDir()
    const { router, origins } = makeRouter(dir)
    router.registerSelfIdentity('discord-bot', 'g1', () => ({ id: 'BOT_SELF_ID' }))

    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const channelOrigin = origins.find((o) => o.kind === 'channel')
    expect(channelOrigin?.kind).toBe('channel')
    expect(channelOrigin?.kind === 'channel' ? channelOrigin.self : undefined).toEqual({ id: 'BOT_SELF_ID' })
  })

  test('omits self from the origin when no identity resolver is registered', async () => {
    const dir = await tempDir()
    const { router, origins } = makeRouter(dir)

    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const channelOrigin = origins.find((o) => o.kind === 'channel')
    expect(channelOrigin?.kind === 'channel' ? channelOrigin.self : undefined).toBeUndefined()
  })

  test('emits ordered ensureLive phase logs bracketing each await', async () => {
    // given a fresh router and a captured log buffer
    const dir = await tempDir()
    const logs: string[] = []
    const { router } = makeRouter(dir, { logs })

    // when a first inbound triggers cold-start ensureLive
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    // then phase logs appear in order: begin → resolved-names-and-membership
    //   → session-created → done. The bracketing is what makes a stuck phase
    //   visible from logs alone (begin without done == hung at that phase).
    //   Name and membership resolution share one log because they now run
    //   concurrently — separate ordered markers would misrepresent the timing.
    const phaseLogs = logs
      .filter((l) => l.startsWith('info:[channels]') && l.includes('ensureLive'))
      .map((l) => l.replace(/^.*ensureLive /, ''))
    const beginIdx = phaseLogs.findIndex((p) => p.startsWith('begin'))
    const resolvedIdx = phaseLogs.findIndex((p) => p.startsWith('resolved-names-and-membership'))
    const createdIdx = phaseLogs.findIndex((p) => p.startsWith('session-created'))
    const doneIdx = phaseLogs.findIndex((p) => p.startsWith('done'))
    expect(beginIdx).toBeGreaterThanOrEqual(0)
    expect(resolvedIdx).toBeGreaterThan(beginIdx)
    expect(createdIdx).toBeGreaterThan(resolvedIdx)
    expect(doneIdx).toBeGreaterThan(createdIdx)
    expect(phaseLogs[beginIdx]).toContain('cold-start')
    expect(phaseLogs[doneIdx]).toContain('cold-start')
  })

  test('rehydrate path logs `ensureLive begin (rehydrate)` after restart', async () => {
    // given a persisted mapping from a prior run
    const dir = await tempDir()
    const firstRun = makeRouter(dir)
    await firstRun.router.route(inbound())
    await firstRun.router.__testing!.flushDebounce(KEY)
    await firstRun.router.stop()

    // when a fresh router (simulating restart) handles a new inbound for the same channel
    const logs: string[] = []
    const secondRun = makeRouter(dir, { logs })
    await secondRun.router.route(inbound({ externalMessageId: 'm-rehydrate' }))
    await secondRun.router.__testing!.flushDebounce(KEY)

    // then the begin and done logs both flag the rehydrate path
    const phaseLogs = logs.filter((l) => l.includes('ensureLive'))
    expect(phaseLogs.some((l) => l.includes('begin (rehydrate)'))).toBe(true)
    expect(phaseLogs.some((l) => l.includes('done (rehydrate)'))).toBe(true)
  })

  test('persists the (4-tuple → sessionId) mapping to channels/sessions.json', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    await router.route(inbound())
    await new Promise((r) => setTimeout(r, 10))
    const loaded = await loadChannelSessions(dir)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.adapter).toBe('discord-bot')
    expect(loaded[0]?.workspace).toBe('g1')
    expect(loaded[0]?.chat).toBe('c1')
    expect(loaded[0]?.thread).toBeNull()
    expect(loaded[0]?.sessionId).toBe('ses_fake_1')
  })

  test('persists sessionFile from getTranscriptPath() so reopen across restart can find the file', async () => {
    // given: a factory whose session manager exposes a transcript path with a
    // pi-coding-agent-style ${ISO_TIMESTAMP}_${sessionId}.jsonl basename
    const dir = await tempDir()
    const transcriptDir = '/tmp/fake-sessions'
    const transcriptPathFor = (sessionId: string): string =>
      `${transcriptDir}/2026-05-02T16-56-52-380Z_${sessionId}.jsonl`
    const { router } = makeRouter(dir, { transcriptPathFor })

    // when: a brand-new channel session is created
    await router.route(inbound())
    await new Promise((r) => setTimeout(r, 10))

    // then: the persisted record carries the basename, NOT the full path
    const loaded = await loadChannelSessions(dir)
    expect(loaded[0]?.sessionFile).toBe('2026-05-02T16-56-52-380Z_ses_fake_1.jsonl')
  })

  test('after restart, a second router instance passes the persisted sessionFile to the factory', async () => {
    // given: a first router run that produces a persisted mapping with sessionFile
    const dir = await tempDir()
    const transcriptPathFor = (sessionId: string): string =>
      `/tmp/fake-sessions/2026-05-02T16-56-52-380Z_${sessionId}.jsonl`
    const firstRun = makeRouter(dir, { transcriptPathFor })
    await firstRun.router.route(inbound({ text: 'please restart' }))
    await firstRun.router.__testing!.flushDebounce(KEY)
    await firstRun.router.stop()

    // when: a fresh router instance (simulating container restart) handles a new inbound
    // for the same channel
    const factoryCalls: SessionFactoryArgs[] = []
    const secondRun = makeRouter(dir, { transcriptPathFor, factoryCalls })
    await secondRun.router.route(inbound({ text: 'try again', externalMessageId: 'm-followup' }))
    await secondRun.router.__testing!.flushDebounce(KEY)

    // then: the factory was called with BOTH existingSessionId AND existingSessionFile
    // (regression: previously only existingSessionId was passed, and the consumer
    // constructed `${sessionDir}/${sessionId}.jsonl` which never matched the on-disk
    // ${ISO}_${sessionId}.jsonl, silently creating a fresh session every restart)
    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.existingSessionId).toBe('ses_fake_1')
    expect(factoryCalls[0]?.existingSessionFile).toBe('2026-05-02T16-56-52-380Z_ses_fake_1.jsonl')
  })

  test('restart with an unsupported v2 mapping creates a fresh session', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'sessions'), { recursive: true })
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFileFs(
      channelsSessionsPath(dir),
      JSON.stringify({
        version: 2,
        sessions: [
          {
            adapter: 'discord-bot',
            workspace: 'g1',
            chat: 'c1',
            thread: null,
            sessionId: 'ses_lost',
            participants: [],
          },
        ],
      }),
    )

    const factoryCalls: SessionFactoryArgs[] = []
    const { router } = makeRouter(dir, { factoryCalls })

    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.existingSessionId).toBeUndefined()
    expect(factoryCalls[0]?.existingSessionFile).toBeUndefined()
  })

  test('separate (workspace, chat) tuples get separate sessions', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ workspace: 'g1', chat: 'c1' }))
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })
    await router.route(inbound({ workspace: 'g1', chat: 'c2' }))
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c2', thread: null })
    expect(sessions).toHaveLength(2)
    expect(router.liveCount()).toBe(2)
  })

  test('concurrent inbounds for a cold tuple share one session creation', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await Promise.all([router.route(inbound()), router.route(inbound({ externalMessageId: 'm2' }))])
    expect(sessions).toHaveLength(1)
  })

  test('after SESSION_FRESHNESS_TTL_MS + 1ms idle, next inbound creates new sessionId', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    nowRef.value = 1000 + SESSION_FRESHNESS_TTL_MS + 1
    await router.route(inbound({ externalMessageId: 'm2', text: 'still there?' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions).toHaveLength(2)
    const loaded = await loadChannelSessions(dir)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.sessionId).toBe('ses_fake_2')
    expect(loaded[0]?.lastInboundAt).toBe(1000 + SESSION_FRESHNESS_TTL_MS + 1)
  })

  test('at exactly SESSION_FRESHNESS_TTL_MS, next inbound reuses session', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    nowRef.value = 1000 + SESSION_FRESHNESS_TTL_MS
    await router.route(inbound({ externalMessageId: 'm2', text: 'boundary check' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions).toHaveLength(1)
    await expectPersistedLastInboundAt(dir, 1000 + SESSION_FRESHNESS_TTL_MS)
    const loaded = await loadChannelSessions(dir)
    expect(loaded[0]?.sessionId).toBe('ses_fake_1')
    expect(loaded[0]?.lastInboundAt).toBe(1000 + SESSION_FRESHNESS_TTL_MS)
  })

  test('stale rollover fires session.end on old session', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const events: string[] = []
    const hooks: HookBus = {
      registerAll: () => {},
      unregisterAll: () => {},
      runSessionStart: async () => {},
      runSessionEnd: async (e) => {
        events.push(`end:${e.sessionId}`)
      },
      runSessionIdle: async () => {},
      runSessionPrompt: async () => {},
      runSessionTurnStart: async () => {},
      runSessionTurnEnd: async () => {},
      runToolBefore: async () => undefined,
      runToolAfter: async () => {},
      count: () => 0,
    }
    const { router, sessions } = makeRouter(dir, { nowRef, hooks })
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    nowRef.value = 1000 + SESSION_FRESHNESS_TTL_MS + 1
    await router.route(inbound({ externalMessageId: 'm2', text: 'roll over' }))
    await router.__testing!.flushDebounce(KEY)

    expect(events).toContain('end:ses_fake_1')
    expect(sessions[0]!.disposed).toBe(1)
    expect(sessions).toHaveLength(2)
  })

  test('grace reuse: in soft→hard band, large base + small transcript reuses the live session', async () => {
    // given: a session whose base context (10KB) dwarfs its transcript growth
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const bytesFor = new Map<string, number>()
    const { router, sessions } = makeRouter(dir, {
      nowRef,
      transcriptPathFor: (sessionId) => `/fake/${sessionId}.jsonl`,
      measureTranscriptBytes: (path) => bytesFor.get(path) ?? 0,
    })
    bytesFor.set('/fake/ses_fake_1.jsonl', 10_000) // base context at cold-start
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)
    bytesFor.set('/fake/ses_fake_1.jsonl', 11_000) // +1KB transcript < 10KB base

    // when: a follow-up lands just inside the grace band (soft TTL + 1ms)
    nowRef.value = 1000 + SESSION_FRESHNESS_TTL_MS + 1
    await router.route(inbound({ externalMessageId: 'm2', text: 'still there?' }))
    await router.__testing!.flushDebounce(KEY)

    // then: the live session is reused, not rolled over
    expect(sessions).toHaveLength(1)
    expect(router.liveCount()).toBe(1)
  })

  test('grace decline: in soft→hard band, transcript exceeding base rolls over', async () => {
    // given: a session whose transcript growth (15KB) now exceeds its base (10KB)
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const bytesFor = new Map<string, number>()
    const { router, sessions } = makeRouter(dir, {
      nowRef,
      transcriptPathFor: (sessionId) => `/fake/${sessionId}.jsonl`,
      measureTranscriptBytes: (path) => bytesFor.get(path) ?? 0,
    })
    bytesFor.set('/fake/ses_fake_1.jsonl', 10_000)
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)
    bytesFor.set('/fake/ses_fake_1.jsonl', 25_000) // delta 15KB > 10KB base

    // when: a follow-up lands in the grace band
    nowRef.value = 1000 + SESSION_FRESHNESS_TTL_MS + 1
    await router.route(inbound({ externalMessageId: 'm2', text: 'long convo' }))
    await router.__testing!.flushDebounce(KEY)

    // then: the bloated transcript makes rebuild cheaper, so it rolls over
    expect(sessions).toHaveLength(2)
  })

  test('grace is bounded: past the hard cap, a large base still rolls over', async () => {
    // given: a large base that would otherwise win the grace comparison
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const bytesFor = new Map<string, number>()
    const { router, sessions } = makeRouter(dir, {
      nowRef,
      transcriptPathFor: (sessionId) => `/fake/${sessionId}.jsonl`,
      measureTranscriptBytes: (path) => bytesFor.get(path) ?? 0,
    })
    bytesFor.set('/fake/ses_fake_1.jsonl', 10_000)
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)
    bytesFor.set('/fake/ses_fake_1.jsonl', 10_100) // tiny delta — grace would apply

    // when: the follow-up lands PAST the hard cap
    nowRef.value = 1000 + SESSION_GRACE_HARD_TTL_MS + 1
    await router.route(inbound({ externalMessageId: 'm2', text: 'much later' }))
    await router.__testing!.flushDebounce(KEY)

    // then: the hard cap forces rollover regardless of base vs delta
    expect(sessions).toHaveLength(2)
  })

  test('grace fails closed: no transcript path (baseContextBytes=0) rolls over at soft TTL', async () => {
    // given: a router with no transcript path (the prior default behavior)
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    // when: a follow-up lands in what would be the grace band
    nowRef.value = 1000 + SESSION_FRESHNESS_TTL_MS + 1
    await router.route(inbound({ externalMessageId: 'm2', text: 'no base measured' }))
    await router.__testing!.flushDebounce(KEY)

    // then: with baseContextBytes=0, grace is disabled and it rolls over
    expect(sessions).toHaveLength(2)
  })

  test('lastInboundAt persisted to sessions.json after every engaged inbound', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router } = makeRouter(dir, { nowRef })

    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)
    await expectPersistedLastInboundAt(dir, 1000)

    nowRef.value = 2000
    await router.route(inbound({ externalMessageId: 'm2', text: 'second' }))
    await router.__testing!.flushDebounce(KEY)
    await expectPersistedLastInboundAt(dir, 2000)
  })

  test('stop() flushes the fire-and-forget persist before returning', async () => {
    // given: an engaged inbound schedules a fire-and-forget `void persist()`
    //   (the lastInboundAt write) but we never poll or flushDebounce for it
    const dir = await tempDir()
    const logs: string[] = []
    const nowRef = { value: 4242 }
    const { router } = makeRouter(dir, { nowRef, logs })
    await router.route(inbound({ externalMessageId: 'm1' }))

    // when: stop() returns
    await router.stop()

    // then: the write has already landed (no poll needed) — proving stop()
    //   awaited the persist chain rather than leaving it racing teardown
    const loaded = await loadChannelSessions(dir)
    expect(loaded[0]?.lastInboundAt).toBe(4242)

    // and: deleting the dir right after stop() — exactly what test afterEach
    //   does — produces no "failed to persist" error, because nothing is
    //   still writing into it
    await rm(dir, { recursive: true, force: true })
    expect(logs.some((l) => l.includes('failed to persist'))).toBe(false)
  })

  test('v3-loaded record with lastInboundAt=0 forces rollover on first inbound', async () => {
    const dir = await tempDir()
    await mkdir(join(dir, 'channels'), { recursive: true })
    await writeFileFs(
      channelsSessionsPath(dir),
      JSON.stringify({
        version: 3,
        sessions: [
          {
            adapter: 'discord-bot',
            workspace: 'g1',
            chat: 'c1',
            thread: null,
            sessionId: 'ses_legacy',
            sessionFile: 'legacy.jsonl',
            participants: [],
          },
        ],
      }),
    )
    const factoryCalls: SessionFactoryArgs[] = []
    const nowRef = { value: SESSION_FRESHNESS_TTL_MS + 1 }
    const { router, sessions } = makeRouter(dir, { nowRef, factoryCalls })

    await router.route(inbound({ externalMessageId: 'm-upgrade', text: 'post-upgrade' }))
    await router.__testing!.flushDebounce(KEY)

    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.existingSessionId).toBeUndefined()
    expect(factoryCalls[0]?.existingSessionFile).toBeUndefined()
    expect(sessions).toHaveLength(1)
    const loaded = await loadChannelSessions(dir)
    expect(loaded[0]?.sessionId).toBe('ses_fake_1')
    expect(loaded[0]?.lastInboundAt).toBe(SESSION_FRESHNESS_TTL_MS + 1)
  })

  // Regression for the Huxley Slack channel incident on 2026-05-26
  // (session 019e62c2-179b-734a-9340-b9dd28254636, addressed at the
  // contract layer by PR #359). The model's second turn was running
  // longer than SESSION_FRESHNESS_TTL_MS (5 min) because it was
  // composing a reply off a backgrounded subagent's result. The user
  // sent a "why is it stopping mid-answer" follow-up at minute 8, which
  // triggered ensureLive's stale-rollover branch and called
  // tearDownLive → session.abort() on the in-flight prompt. The reply
  // was lost. The runIdleGc path already skipped draining sessions; the
  // ensureLive rollover path was missing the matching guard.
  test('stale rollover is suppressed while draining; in-flight prompt is not aborted', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { nowRef, logs })
    let releaseFirstPrompt: () => void = () => {}
    const firstPromptHeld = new Promise<void>((resolve) => {
      releaseFirstPrompt = resolve
    })
    await router.route(inbound({ externalMessageId: 'm1' }))
    sessions[0]!.onPrompt = async () => {
      await firstPromptHeld
    }
    // Fire drain WITHOUT awaiting — the held onPrompt would otherwise
    // block flushDebounce forever. The drain runs in the background and
    // we observe its mid-flight state via live.draining (which the
    // production rollover branch checks).
    const drainPromise = router.__testing!.flushDebounce(KEY)
    await waitFor(() => sessions[0]!.prompts.length > 0)
    // First prompt is now mid-flight: drain() has set live.draining=true
    // and is blocked at session.prompt(). Bump the clock past the
    // freshness TTL and route a follow-up inbound — pre-fix, this fired
    // tearDownLive on the in-flight session and aborted the prompt.
    nowRef.value = 1000 + SESSION_FRESHNESS_TTL_MS + 1
    await router.route(inbound({ externalMessageId: 'm2', text: 'why is it stopping mid-answer' }))

    expect(logs.some((l) => l.includes('stale-rollover'))).toBe(false)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.aborted).toBe(0)
    expect(sessions[0]!.disposed).toBe(0)

    // Release the held prompt so the drain loop can finish. The
    // follow-up that arrived during the in-flight turn was enqueued via
    // the live.draining branch in route() and is picked up on the next
    // iteration of drain's while-loop.
    releaseFirstPrompt()
    await drainPromise
    expect(sessions[0]!.prompts.length).toBeGreaterThanOrEqual(2)
  })

  test('rollover STILL fires when idle exceeds TTL and the session is NOT draining', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { nowRef, logs })
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)
    // First prompt resolved (default FakeSession.prompt is a no-op),
    // so live.draining is back to false. Bump the clock and route a
    // follow-up — the draining-guard does not apply, and the original
    // rollover behavior must still fire.
    nowRef.value = 1000 + SESSION_FRESHNESS_TTL_MS + 1
    await router.route(inbound({ externalMessageId: 'm2', text: 'follow up after a long quiet stretch' }))
    await router.__testing!.flushDebounce(KEY)

    expect(logs.some((l) => l.includes('stale-rollover'))).toBe(true)
    expect(sessions).toHaveLength(2)
    expect(sessions[0]!.disposed).toBe(1)
  })

  test('rollover does NOT fire while a background child of the session is still running', async () => {
    // given: a session with a running background subagent that started at t=1000
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const childStartedAt = 1000
    const { router, sessions } = makeRouter(dir, {
      nowRef,
      logs,
      newestRunningChildSubagentStartedAt: (sessionId) => (sessionId === 'ses_fake_1' ? childStartedAt : null),
    })
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    // when: a follow-up arrives past the freshness TTL (would normally roll over)
    nowRef.value = 1000 + SESSION_FRESHNESS_TTL_MS + 1
    await router.route(inbound({ externalMessageId: 'm2', text: 'still researching?' }))
    await router.__testing!.flushDebounce(KEY)

    // then: the session is pinned — no rollover, same session reused
    expect(logs.some((l) => l.includes('stale-rollover'))).toBe(false)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.disposed).toBe(0)
  })

  test('rollover fires anyway once the running child exceeds SESSION_CHILD_PIN_MAX_MS', async () => {
    // given: a child that started long enough ago to exceed the pin ceiling
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const childStartedAt = 1000
    const { router, sessions } = makeRouter(dir, {
      nowRef,
      logs,
      newestRunningChildSubagentStartedAt: (sessionId) => (sessionId === 'ses_fake_1' ? childStartedAt : null),
    })
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    // when: the follow-up arrives after the pin cap has elapsed
    nowRef.value = childStartedAt + SESSION_CHILD_PIN_MAX_MS + 1
    await router.route(inbound({ externalMessageId: 'm2', text: 'are you stuck?' }))
    await router.__testing!.flushDebounce(KEY)

    // then: pin is overridden, rollover proceeds with the past-cap annotation
    expect(logs.some((l) => l.includes('stale-rollover') && l.includes('past child-pin cap'))).toBe(true)
    expect(sessions).toHaveLength(2)
    expect(sessions[0]!.disposed).toBe(1)
  })

  test('rollover stays pinned when the oldest child is past cap but a newer child is still within it', async () => {
    // given: two running children — one past the cap, one fresh. The production
    //   seam reports the NEWEST start time, so an over-cap older child must not
    //   unpin the session while the newer child is still inside its window.
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const startOfTurn = 1000
    const runningChildStartsFor = (sessionId: string): number[] =>
      sessionId === 'ses_fake_1'
        ? [startOfTurn, nowRef.value - 1000] // oldest (past cap by the assertion time) + a fresh one
        : []
    const { router, sessions } = makeRouter(dir, {
      nowRef,
      logs,
      newestRunningChildSubagentStartedAt: (sessionId) => {
        const starts = runningChildStartsFor(sessionId)
        return starts.length > 0 ? Math.max(...starts) : null
      },
    })
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    // when: the follow-up arrives after the OLDEST child has crossed the cap
    nowRef.value = startOfTurn + SESSION_CHILD_PIN_MAX_MS + 1
    await router.route(inbound({ externalMessageId: 'm2', text: 'still going?' }))
    await router.__testing!.flushDebounce(KEY)

    // then: the newer child keeps the session pinned — no rollover
    expect(logs.some((l) => l.includes('stale-rollover'))).toBe(false)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.disposed).toBe(0)
  })

  test('command path does NOT trigger rollover', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { nowRef, logs })
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    nowRef.value = 1000 + SESSION_FRESHNESS_TTL_MS + 1
    await router.route(inbound({ externalMessageId: 'm-stop', text: '/stop' }))

    expect(sessions).toHaveLength(1)
    expect(logs.some((l) => l.includes('stale-rollover'))).toBe(false)

    await router.route(inbound({ externalMessageId: 'm2', text: 'now answer' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions).toHaveLength(2)
    expect(logs.some((l) => l.includes('stale-rollover'))).toBe(true)
  })
})

describe('ChannelRouter ensureLive watchdog', () => {
  test('hung session factory rejects after the timeout instead of awaiting forever', async () => {
    // given a factory that never resolves (simulates a hung Discord REST chain
    // inside createForChannel — the production failure mode that bricked the
    // bot for 2 days when a previously-evicted channel got a new inbound
    // during a gateway-disconnect storm)
    const dir = await tempDir()
    const logs: string[] = []
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      ensureLiveTimeoutMs: 50,
      logger: {
        info: (m) => logs.push(`info:${m}`),
        warn: (m) => logs.push(`warn:${m}`),
        error: (m) => logs.push(`error:${m}`),
      },
      createSessionForChannel: () => new Promise(() => {}),
    })

    // when the route promise resolves (the adapter's outer catch is responsible
    // for swallowing the thrown timeout in production; here we observe the
    // throw directly to assert the watchdog actually fired)
    const start = Date.now()
    await expect(router.route(inbound())).rejects.toThrow(/ensureLive timed out after 50ms/)
    const elapsed = Date.now() - start

    // then we returned within the watchdog window (production-relevant: the
    // adapter's outer catch sees the timeout error promptly and decrements
    // its inflight counter, instead of sitting forever)
    expect(elapsed).toBeLessThan(500)
    expect(logs.some((l) => l.includes('error:[channels]') && l.includes('ensureLive failed'))).toBe(true)
  })

  test('after a watchdog timeout, the next inbound retries instead of awaiting the dead promise', async () => {
    // given a factory that hangs the FIRST call but resolves the second.
    // This is the diagnostic that proves the `creating` map entry was evicted
    // — the original bug had every subsequent message await the same dead
    // promise from the first hung call (commit message reproduces from logs).
    const dir = await tempDir()
    const logs: string[] = []
    let callCount = 0
    let firstCreationEntered: (() => void) | undefined
    const firstCreation = new Promise<void>((resolve) => {
      firstCreationEntered = resolve
    })
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      ensureLiveTimeoutMs: 50,
      logger: {
        info: (m) => logs.push(`info:${m}`),
        warn: (m) => logs.push(`warn:${m}`),
        error: (m) => logs.push(`error:${m}`),
      },
      createSessionForChannel: async () => {
        callCount++
        if (callCount === 1) {
          firstCreationEntered!()
          await new Promise(() => {})
        }
        const fake = new FakeSession()
        return {
          session: fake as unknown as AgentSession,
          sessionId: `ses_retry_${callCount}`,
          dispose: async () => {
            fake.dispose()
          },
        }
      },
    })

    // when first inbound times out, then a second inbound arrives
    await expect(router.route(inbound())).rejects.toThrow(/ensureLive timed out/)
    expect(logs.some((l) => l.includes('ensureLive failed'))).toBe(true)
    // Gate the retry on the first creation actually reaching the factory and
    // hanging. Under parallel-test load the watchdog can fire before the slow
    // pre-factory chain (ensureLoaded + name/membership resolution) reaches the
    // factory; without this barrier the hang races onto the SECOND call, which
    // then times out too and rejects this retry.
    await firstCreation
    await router.route(inbound({ externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)

    // then the factory was called twice (proving the creating-map entry was
    // evicted on timeout) and the second call succeeded into a live session
    expect(callCount).toBe(2)
    expect(router.liveCount()).toBe(1)
  })

  test('tearDownAllLive() during an in-flight creation discards the stale session instead of installing it', async () => {
    // given a factory whose first creation blocks until we release it, so we can
    // run tearDownAllLive() (the roles-reload teardown) in the exact window
    // between creation start and the liveSessions.set install
    const dir = await tempDir()
    let callCount = 0
    let releaseFirst: (() => void) | undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      createSessionForChannel: async () => {
        callCount++
        if (callCount === 1) await firstBlocked
        const fake = new FakeSession()
        return {
          session: fake as unknown as AgentSession,
          sessionId: `ses_race_${callCount}`,
          dispose: async () => {
            fake.dispose()
          },
        }
      },
    })

    // when the first inbound starts creating (and blocks), a roles reload tears
    // down all live sessions, then the blocked creation is released
    const routePromise = router.route(inbound())
    await new Promise((r) => setTimeout(r, 10))
    await router.tearDownAllLive()
    releaseFirst!()

    // then the in-flight creation self-disposes (route rejects) and nothing was
    // installed — the stale-role session never becomes live
    await expect(routePromise).rejects.toBeInstanceOf(StaleLiveSessionError)
    expect(router.liveCount()).toBe(0)

    // and a fresh post-reload inbound creates a new live session normally
    await router.route(inbound({ externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)
    expect(router.liveCount()).toBe(1)
    expect(callCount).toBe(2)
  })
})

describe('ChannelRouter engagement and prompt composition', () => {
  test('engaging inbound is delivered to session.prompt with attribution', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ text: 'what time is it?' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('<@alice> (alice): what time is it?')
  })

  test('prompt line is prefixed with the platform-side ISO 8601 timestamp from event.ts', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ text: 'hello there', ts: FIXED_INBOUND_TS }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts[0]).toContain(`[${FIXED_INBOUND_ISO}] <@alice> (alice): hello there`)
  })

  test('prompt line omits the timestamp prefix when ts is unknown (0)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ text: 'hello there', ts: 0 }))
    await router.__testing!.flushDebounce(KEY)
    const line = sessions[0]!.prompts[0]!
    expect(line).toContain('<@alice> (alice): hello there')
    expect(line).not.toMatch(/\[\d{4}-\d{2}-\d{2}T/)
  })

  test('GitHub prompt attribution uses @login instead of numeric-id mention syntax', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const key: ChannelKey = { adapter: 'github', workspace: 'typeclaw/typeclaw', chat: 'issue:398', thread: null }

    await router.route(
      inbound({
        adapter: 'github',
        workspace: 'typeclaw/typeclaw',
        chat: 'issue:398',
        authorId: '12345',
        authorName: 'octocat',
        text: '@typeey can you review this PR',
      }),
    )
    await router.__testing!.flushDebounce(key)

    expect(sessions[0]!.prompts[0]).toContain('@octocat (octocat): @typeey can you review this PR')
    expect(sessions[0]!.prompts[0]).not.toContain('<@12345>')
  })

  test('non-engaging inbound goes to context buffer, not session.prompt', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    // Prime participants with a second human so we exercise the strict gate
    // rather than the solo-human fallback (which would engage on any message).
    await router.route(inbound({ isBotMention: true, authorId: 'carol', authorName: 'carol', text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.prompts.length = 0
    await router.route(inbound({ isBotMention: false, text: 'unrelated chatter' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.prompts).toHaveLength(0)
  })

  test('coalesces a multi-message burst into one prompt', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ text: 'hi' }))
    await router.route(inbound({ externalMessageId: 'm2', text: 'how' }))
    await router.route(inbound({ externalMessageId: 'm3', text: 'are you' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('hi')
    expect(sessions[0]!.prompts[0]).toContain('how')
    expect(sessions[0]!.prompts[0]).toContain('are you')
  })

  test('drains observed messages as "Recent context" before engaged messages', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    // Prime participants with carol so bob's later non-mention message
    // doesn't trigger the solo-human fallback. We need bob's message to
    // observe so we can verify the Recent context prefix.
    await router.route(inbound({ isBotMention: true, authorId: 'carol', authorName: 'carol', text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.prompts.length = 0
    await router.route(inbound({ isBotMention: false, authorId: 'bob', authorName: 'bob', text: 'unrelated' }))
    await router.route(inbound({ text: 'hey bot' }))
    await router.__testing!.flushDebounce(KEY)
    const prompt = sessions[0]!.prompts[0]!
    expect(prompt).toContain('Recent context (not addressed to you, for awareness only)')
    expect(prompt).toContain('<@bob> (bob): unrelated')
    expect(prompt).toContain('Current message')
    expect(prompt).toContain('<@alice> (alice): hey bot')
    expect(prompt.indexOf('unrelated')).toBeLessThan(prompt.indexOf('hey bot'))
  })

  test('caps observed Recent-context message text but never the addressed current message', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ isBotMention: true, authorId: 'carol', authorName: 'carol', text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.prompts.length = 0

    const longObserved = 'A'.repeat(OBSERVED_MESSAGE_MAX_CHARS + 500)
    const longCurrent = 'B'.repeat(OBSERVED_MESSAGE_MAX_CHARS + 500)
    await router.route(inbound({ isBotMention: false, authorId: 'bob', authorName: 'bob', text: longObserved }))
    await router.route(inbound({ text: longCurrent }))
    await router.__testing!.flushDebounce(KEY)

    const prompt = sessions[0]!.prompts[0]!
    // observed (awareness-only) message is truncated to the cap with a marker
    expect(prompt).toContain('[…truncated]')
    expect(prompt).toContain('A'.repeat(OBSERVED_MESSAGE_MAX_CHARS))
    expect(prompt).not.toContain('A'.repeat(OBSERVED_MESSAGE_MAX_CHARS + 1))
    // the addressed current message is preserved in full
    expect(prompt).toContain(longCurrent)
  })

  test('truncates observed text on whole code points, never splitting a surrogate pair', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ isBotMention: true, authorId: 'carol', authorName: 'carol', text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.prompts.length = 0

    // each 😀 is one code point but two UTF-16 code units, so a code-unit slice
    // at the cap would leave a dangling surrogate half
    const emoji = '😀'.repeat(OBSERVED_MESSAGE_MAX_CHARS + 100)
    await router.route(inbound({ isBotMention: false, authorId: 'bob', authorName: 'bob', text: emoji }))
    await router.route(inbound({ text: 'hey bot' }))
    await router.__testing!.flushDebounce(KEY)

    const prompt = sessions[0]!.prompts[0]!
    expect(prompt).toContain('[…truncated]')
    expect(prompt).not.toContain('\uFFFD')
    // exactly the cap worth of whole emoji survives — a code-unit split would
    // break this contiguous-emoji substring with a dangling surrogate
    expect(prompt).toContain('😀'.repeat(OBSERVED_MESSAGE_MAX_CHARS))
    expect(prompt).not.toContain('😀'.repeat(OBSERVED_MESSAGE_MAX_CHARS + 1))
  })

  test('seeds the session.turn.start retrieval query with the pure user message, not recent context or framing', async () => {
    const dir = await tempDir()
    const turnStartPrompts: string[] = []
    const hooks: HookBus = {
      registerAll: () => {},
      unregisterAll: () => {},
      runSessionStart: async () => {},
      runSessionEnd: async () => {},
      runSessionIdle: async () => {},
      runSessionPrompt: async () => {},
      runSessionTurnStart: async (e) => {
        turnStartPrompts.push(e.userPrompt)
      },
      runSessionTurnEnd: async () => {},
      runToolBefore: async () => undefined,
      runToolAfter: async () => {},
      count: () => 0,
    }
    const { router } = makeRouter(dir, { hooks })
    await router.route(inbound({ isBotMention: true, authorId: 'carol', authorName: 'carol', text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    turnStartPrompts.length = 0
    await router.route(inbound({ isBotMention: false, authorId: 'bob', authorName: 'bob', text: 'unrelated chatter' }))
    await router.route(inbound({ text: 'what was that PR about?' }))
    await router.__testing!.flushDebounce(KEY)

    const query = turnStartPrompts[0]!
    expect(query).toBe('what was that PR about?')
    expect(query).not.toContain('Recent context')
    expect(query).not.toContain('Current message')
    expect(query).not.toContain('unrelated chatter')
    expect(query).not.toContain(FIXED_INBOUND_ISO)
    expect(query).not.toContain('<@alice>')
  })

  test('joins a multi-message batch into the retrieval query without author or timestamp framing', async () => {
    const dir = await tempDir()
    const turnStartPrompts: string[] = []
    const hooks: HookBus = {
      registerAll: () => {},
      unregisterAll: () => {},
      runSessionStart: async () => {},
      runSessionEnd: async () => {},
      runSessionIdle: async () => {},
      runSessionPrompt: async () => {},
      runSessionTurnStart: async (e) => {
        turnStartPrompts.push(e.userPrompt)
      },
      runSessionTurnEnd: async () => {},
      runToolBefore: async () => undefined,
      runToolAfter: async () => {},
      count: () => 0,
    }
    const { router } = makeRouter(dir, { hooks })
    await router.route(inbound({ text: 'first line' }))
    await router.route(inbound({ text: 'second line' }))
    await router.__testing!.flushDebounce(KEY)

    expect(turnStartPrompts[0]!).toBe('first line\nsecond line')
  })

  test('labels the current message even when there is no recent context', async () => {
    // Regression: the `## Current message` header used to be gated on
    // observed.length > 0, so a turn carrying only the current message (no
    // recent context) rendered the batch line bare. The group-chat nudge tells
    // the model to identify "THIS latest message", so the latest message must
    // be labeled regardless of whether recent context exists.
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ text: 'hey bot' }))
    await router.__testing!.flushDebounce(KEY)
    const prompt = sessions[0]!.prompts[0]!
    expect(prompt).not.toContain('Recent context')
    expect(prompt).toContain('## Current message (addressed to you)')
    expect(prompt).toContain('<@alice> (alice): hey bot')
  })

  test('engaged turn carries the history-interpretation note above the current-message header', async () => {
    // Regression: the persisted `## Current message (addressed to you)` header
    // is turn-local, but a chain of such turns made weak models believe only
    // the latest turn existed (they denied seeing earlier user messages that
    // were in their own transcript). The note re-anchors the header. It must
    // sit ABOVE the header so the model reads it before the addressed line.
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ text: 'hey bot' }))
    await router.__testing!.flushDebounce(KEY)
    const prompt = sessions[0]!.prompts[0]!
    expect(prompt).toContain('if earlier turns appear above, they are real conversation history')
    expect(prompt.indexOf('if earlier turns appear above')).toBeLessThan(
      prompt.indexOf('## Current message (addressed to you)'),
    )
  })

  test('empty allow rules + observed-only burst produces no prompt and no crash', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir, {
      config: {
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
        history: defaultHistoryConfig(),
      },
    })
    // Prime participants with carol so the next non-mention message hits the
    // strict gate (which observes) rather than the solo-human fallback.
    await router.route(inbound({ isBotMention: true, authorId: 'carol', authorName: 'carol' }))
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.prompts.length = 0
    await router.route(inbound({ isBotMention: false }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(0)
  })

  test('logs an `observed id=...` line when engagement decides observe', async () => {
    // given a 2-human channel under strict trigger so a non-mention observes
    const dir = await tempDir()
    const logs: string[] = []
    const { router } = makeRouter(dir, {
      config: {
        engagement: { trigger: ['mention'], stickiness: 'off' },
        enabled: true,
        history: defaultHistoryConfig(),
      },
      logs,
    })
    await router.route(inbound({ isBotMention: true, authorId: 'carol', authorName: 'carol' }))
    await router.__testing!.flushDebounce(KEY)

    // when a non-mention from a different author arrives (must observe)
    logs.length = 0
    await router.route(inbound({ isBotMention: false, externalMessageId: 'm-observed' }))

    // then exactly one observed log is emitted with the inbound message id
    const observedLogs = logs.filter((l) => l.includes('observed id='))
    expect(observedLogs).toHaveLength(1)
    expect(observedLogs[0]).toContain('id=m-observed')
  })

  test('solo-human channel: plain message engages without mention/reply/dm', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ isBotMention: false, text: 'hello there' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('<@alice> (alice): hello there')
  })

  test('solo-human fallback turns off once a second human posts', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    // Alice (solo) → engages on plain message.
    await router.route(inbound({ isBotMention: false, text: 'first' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(1)
    // Bob arrives mentioning the bot → engages via strict gate.
    await router.route(inbound({ authorId: 'bob', authorName: 'bob', isBotMention: true, text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(2)
    // Alice's next plain message must now observe (2 humans in cache).
    await router.route(inbound({ isBotMention: false, text: 'follow up' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(2)
  })

  test('registered membership resolver gates first cold inbound before sticky can start', async () => {
    const dir = await tempDir()
    const { router, sessions, origins } = makeRouter(dir)
    router.registerMembership('discord-bot', 'g1', async () => ({
      humans: 5,
      bots: 2,
      fetchedAt: Date.now(),
      truncated: false,
    }))

    await router.route(inbound({ isBotMention: false, text: 'ambient hello' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(0)
    expect(origins[0]).toMatchObject({ kind: 'channel', membership: { humans: 5, bots: 2, truncated: false } })
  })

  test('membership resolver failure preserves legacy null fallback', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerMembership('discord-bot', 'g1', async () => ({ kind: 'transient' }))

    await router.route(inbound({ isBotMention: false, text: 'solo hello' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('solo hello')
  })

  test('large approximate membership counts still quiet plain chatter', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerMembership('discord-bot', 'g1', async () => ({
      humans: 30,
      bots: 5,
      fetchedAt: Date.now(),
      truncated: true,
    }))

    await router.route(inbound({ isBotMention: false, text: 'ambient hello' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(0)
  })

  test('previously-unseen author triggers a membership refetch (warmup after invalidate)', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let resolverCalls = 0
    router.registerMembership('discord-bot', 'g1', async () => {
      resolverCalls++
      return { humans: 1, bots: 0, fetchedAt: Date.now(), truncated: false }
    })

    await router.route(inbound({ authorId: 'alice', authorName: 'alice' }))
    await router.__testing!.flushDebounce(KEY)
    const callsAfterFirstAuthor = resolverCalls

    // Same author — no invalidation, no extra resolver call (cache still hot)
    await router.route(inbound({ authorId: 'alice', authorName: 'alice', externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)
    expect(resolverCalls).toBe(callsAfterFirstAuthor)

    // Novel author — cache invalidated, warmup kicks off (additional resolver hit)
    await router.route(inbound({ authorId: 'bob', authorName: 'bob', externalMessageId: 'm3' }))
    await router.__testing!.flushDebounce(KEY)
    await waitFor(() => resolverCalls > callsAfterFirstAuthor)
    expect(resolverCalls).toBeGreaterThan(callsAfterFirstAuthor)
  })

  test('DM channels skip the new-author invalidation path', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let resolverCalls = 0
    router.registerMembership('discord-bot', 'g1', async () => {
      resolverCalls++
      return { humans: 1, bots: 1, fetchedAt: Date.now(), truncated: false }
    })

    const dmKey: ChannelKey = { adapter: 'discord-bot', workspace: '@dm', chat: 'd1', thread: null }
    await router.route(inbound({ workspace: '@dm', chat: 'd1', isDm: true, authorId: 'alice', authorName: 'alice' }))
    await router.__testing!.flushDebounce(dmKey)
    const callsAfterFirst = resolverCalls

    await router.route(
      inbound({
        workspace: '@dm',
        chat: 'd1',
        isDm: true,
        authorId: 'bob',
        authorName: 'bob',
        externalMessageId: 'm2',
      }),
    )
    await router.__testing!.flushDebounce(dmKey)

    expect(resolverCalls).toBe(callsAfterFirst)
  })
})

describe('ChannelRouter alias engagement', () => {
  test('engages on dir-name implicit alias even with no configured aliases', async () => {
    const dir = await tempDir()
    const dirName = basename(dir)
    const { router, sessions } = makeRouter(dir, {
      config: { ...baseConfig, engagement: { trigger: [], stickiness: 'off' } },
    })

    await router.route(
      inbound({
        text: `Hey ${dirName.toUpperCase()}, can you check the cron`,
        isBotMention: false,
        authorId: 'first-human',
        authorName: 'first-human',
      }),
    )
    await router.__testing!.flushDebounce(KEY)
    await router.route(
      inbound({
        externalMessageId: 'm2',
        text: `Hey ${dirName}, can you check the cron`,
        isBotMention: false,
        authorId: 'second-human',
        authorName: 'second-human',
      }),
    )
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(2)
  })

  test('engages on configured alias substring (Korean particle suffix)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir, {
      config: { ...baseConfig, engagement: { trigger: [], stickiness: 'off' } },
      configuredAliases: () => ['토토', 'toto'],
    })

    // '토토아' = alias '토토' + Korean vocative particle '아'; substring match must still fire.
    await router.route(
      inbound({
        text: '토토아 check the cron',
        isBotMention: false,
        authorId: 'first-human',
        authorName: 'first-human',
      }),
    )
    await router.__testing!.flushDebounce(KEY)
    await router.route(
      inbound({
        externalMessageId: 'm2',
        text: '토토아 check the cron',
        isBotMention: false,
        authorId: 'second-human',
        authorName: 'second-human',
      }),
    )
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(2)
  })

  test('reads aliases live each inbound (live-reload contract)', async () => {
    const dir = await tempDir()
    let aliases: readonly string[] = []
    const { router, sessions } = makeRouter(dir, {
      config: { ...baseConfig, engagement: { trigger: [], stickiness: 'off' } },
      configuredAliases: () => aliases,
    })

    await router.route(
      inbound({
        text: '토토아 cron',
        isBotMention: false,
        authorId: 'first-human',
        authorName: 'first-human',
      }),
    )
    await router.route(
      inbound({
        externalMessageId: 'm2',
        text: 'second human posts',
        isBotMention: false,
        authorId: 'second-human',
        authorName: 'second-human',
      }),
    )
    await router.__testing!.flushDebounce(KEY)

    aliases = ['토토']
    await router.route(
      inbound({
        externalMessageId: 'm3',
        text: '토토아 cron',
        isBotMention: false,
        authorId: 'first-human',
        authorName: 'first-human',
      }),
    )
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts.some((p) => p.includes('토토아 cron'))).toBe(true)
  })
})

describe('ChannelRouter sticky credits', () => {
  test('agent-sent reply grants sticky to the inbound author for the next message', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })

    await router.route(inbound({ text: 'first' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(1)

    nowRef.value = 1500
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    const result = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: 'hi alice',
    })
    expect(result.ok).toBe(true)

    nowRef.value = 2000
    await router.route(inbound({ externalMessageId: 'm2', isBotMention: false, text: 'thanks' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(2)
    expect(sessions[0]!.prompts[1]).toContain('thanks')
  })

  test('sticky engages a plain follow-up in a multi-human group, and the turn carries the nudge', async () => {
    // given a 2-human group (bob already seen) where the bot just replied in
    // alice's turn — granting alice sticky credit
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound({ authorId: 'bob', externalMessageId: 'bob-1', isBotMention: true, text: 'bot hi' }))
    await router.__testing!.flushDebounce(KEY)
    nowRef.value = 1200
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'yep just sent it' })
    }
    await router.route(
      inbound({ authorId: 'alice', externalMessageId: 'alice-1', isBotMention: true, text: 'bot did you send it?' }),
    )
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.onPrompt = undefined
    sessions[0]!.prompts.length = 0

    // when alice posts a plain follow-up with no mention (the regressed case)
    nowRef.value = 2000
    await router.route(
      inbound({ authorId: 'alice', externalMessageId: 'alice-2', isBotMention: false, text: 'where did you send it' }),
    )
    await router.__testing!.flushDebounce(KEY)

    // then we engage (sticky woke us) and the nudge rides along so the model
    // can still self-select silence for true chatter
    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('where did you send it')
    expect(sessions[0]!.prompts[0]).toContain('You are in a group chat with multiple people.')
  })

  test('clearSticky drops the credit so a plain follow-up is no longer auto-engaged', async () => {
    // given a 2-human group where the bot just replied in alice's turn,
    // granting alice a sticky credit (mirrors the test above)
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound({ authorId: 'bob', externalMessageId: 'bob-1', isBotMention: true, text: 'bot hi' }))
    await router.__testing!.flushDebounce(KEY)
    nowRef.value = 1200
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'yep just sent it' })
    }
    await router.route(
      inbound({ authorId: 'alice', externalMessageId: 'alice-1', isBotMention: true, text: 'bot did you send it?' }),
    )
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.onPrompt = undefined
    sessions[0]!.prompts.length = 0

    // when the credit is force-cleared before alice's plain follow-up
    const cleared = router.clearSticky(KEY)
    expect(cleared.cleared).toBe(1)

    nowRef.value = 2000
    await router.route(
      inbound({ authorId: 'alice', externalMessageId: 'alice-2', isBotMention: false, text: 'where did you send it' }),
    )
    await router.__testing!.flushDebounce(KEY)

    // then the follow-up is observed, not engaged: no new prompt reaches the session
    expect(sessions[0]!.prompts).toHaveLength(0)
  })

  test('clearSticky reports zero when no credit is held', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    expect(router.clearSticky(KEY)).toEqual({ keyId: 'discord-bot:g1:c1:', cleared: 0 })
  })

  test('an ack reply in the same turn as clearSticky does not re-grant sticky', async () => {
    // given a 2-human group: the model disengages mid-turn and THEN acks with a
    // reply in the SAME turn (the natural "ok, backing off" pattern). The reply's
    // success path must not silently re-grant the credit disengage just cleared.
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound({ authorId: 'bob', externalMessageId: 'bob-1', isBotMention: true, text: 'bot hi' }))
    await router.__testing!.flushDebounce(KEY)
    nowRef.value = 1200
    sessions[0]!.onPrompt = async () => {
      // disengage, then ack in the same turn — the ordering that previously
      // re-granted alice's credit and defeated the tool
      router.clearSticky(KEY)
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'ok, backing off' })
    }
    await router.route(
      inbound({ authorId: 'alice', externalMessageId: 'alice-1', isBotMention: true, text: 'bot stop replying' }),
    )
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.onPrompt = undefined
    sessions[0]!.prompts.length = 0

    // when alice posts a plain follow-up after the disengaged turn
    nowRef.value = 2000
    await router.route(
      inbound({ authorId: 'alice', externalMessageId: 'alice-2', isBotMention: false, text: 'you there' }),
    )
    await router.__testing!.flushDebounce(KEY)

    // then it is observed, not engaged: the ack did not re-arm stickiness
    expect(sessions[0]!.prompts).toHaveLength(0)
  })

  test('disengage is scoped to its turn: a reply on a LATER turn re-grants normally', async () => {
    // given the model disengaged on alice's first turn (clearing + arming the
    // guard for that turn only)
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound({ authorId: 'bob', externalMessageId: 'bob-1', isBotMention: true, text: 'bot hi' }))
    await router.__testing!.flushDebounce(KEY)
    nowRef.value = 1200
    sessions[0]!.onPrompt = async () => {
      router.clearSticky(KEY)
    }
    await router.route(
      inbound({ authorId: 'alice', externalMessageId: 'alice-1', isBotMention: true, text: 'bot stop' }),
    )
    await router.__testing!.flushDebounce(KEY)

    // when alice mentions again on a NEW turn and the bot replies (no disengage)
    nowRef.value = 2000
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'sure' })
    }
    await router.route(
      inbound({ authorId: 'alice', externalMessageId: 'alice-2', isBotMention: true, text: 'bot one thing' }),
    )
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.onPrompt = undefined
    sessions[0]!.prompts.length = 0

    // then sticky is back: alice's plain follow-up engages again
    nowRef.value = 2200
    await router.route(
      inbound({ authorId: 'alice', externalMessageId: 'alice-3', isBotMention: false, text: 'and another' }),
    )
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(1)
  })

  test('a user the agent @-mentions auto-engages on their next plain reply', async () => {
    // given a 2-human group (alice + bob both seen) so the solo-human fallback is
    // off — an untriggered plain message would otherwise be observed
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(
      inbound({ authorId: '111', authorName: 'alice', externalMessageId: 'p1', isBotMention: true, text: 'bot hi' }),
    )
    await router.__testing!.flushDebounce(KEY)
    nowRef.value = 1100
    await router.route(
      inbound({ authorId: '777', authorName: 'bob', externalMessageId: 'n0', isBotMention: false, text: 'hi all' }),
    )
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.prompts.length = 0

    // when alice triggers a turn and the agent's reply @-mentions bob, a third party
    nowRef.value = 1500
    sessions[0]!.onPrompt = async () => {
      await router.send({
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        text: 'good question — <@777> can you confirm?',
      })
    }
    await router.route(
      inbound({
        authorId: '111',
        authorName: 'alice',
        externalMessageId: 'p2',
        isBotMention: true,
        text: 'bot what about X?',
      }),
    )
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.onPrompt = undefined
    sessions[0]!.prompts.length = 0

    // then bob's plain reply (no mention of the bot) engages: the @-mention granted bob a sticky credit
    nowRef.value = 2000
    await router.route(
      inbound({
        authorId: '777',
        authorName: 'bob',
        externalMessageId: 'n1',
        isBotMention: false,
        text: 'sure, it is Y',
      }),
    )
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('sure, it is Y')
  })

  test('a user the agent did NOT mention stays observed on a plain reply', async () => {
    // given the same 2-human group, but the agent's reply mentions nobody
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(
      inbound({ authorId: '111', authorName: 'alice', externalMessageId: 'p1', isBotMention: true, text: 'bot hi' }),
    )
    await router.__testing!.flushDebounce(KEY)
    nowRef.value = 1100
    await router.route(
      inbound({ authorId: '777', authorName: 'bob', externalMessageId: 'n0', isBotMention: false, text: 'hi all' }),
    )
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.prompts.length = 0

    // when alice triggers a turn and the agent replies without any @-mention
    nowRef.value = 1500
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'good question, let me check' })
    }
    await router.route(
      inbound({
        authorId: '111',
        authorName: 'alice',
        externalMessageId: 'p2',
        isBotMention: true,
        text: 'bot what about X?',
      }),
    )
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.onPrompt = undefined
    sessions[0]!.prompts.length = 0

    // then bob's unrelated plain reply is observed, not engaged — only alice (the turn author) holds a credit
    nowRef.value = 2000
    await router.route(
      inbound({
        authorId: '777',
        authorName: 'bob',
        externalMessageId: 'n1',
        isBotMention: false,
        text: 'sure, it is Y',
      }),
    )
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(0)
  })

  test('the bot does not grant itself sticky when its reply contains a self-mention', async () => {
    // given a registered self-identity and a turn authored by alice (111)
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    router.registerSelfIdentity('discord-bot', 'g1', () => ({ id: '999' }))
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(
      inbound({ authorId: '111', authorName: 'alice', externalMessageId: 'p1', isBotMention: true, text: 'bot hi' }),
    )
    await router.__testing!.flushDebounce(KEY)

    // when the agent's reply mentions both the bot itself (999) and bob (777),
    // e.g. a quoted inbound that @-pinged the bot
    nowRef.value = 1500
    sessions[0]!.onPrompt = async () => {
      await router.send({
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        text: '> <@999> ping\n<@777> thoughts?',
      })
    }
    await router.route(
      inbound({ authorId: '111', authorName: 'alice', externalMessageId: 'p2', isBotMention: true, text: 'bot go' }),
    )
    await router.__testing!.flushDebounce(KEY)

    // then only alice (111, turn author) and bob (777, mentioned) hold credits — self (999) is excluded
    expect(router.clearSticky(KEY).cleared).toBe(2)
  })
})

describe('ChannelRouter outbound', () => {
  test('returns ok:false when no adapter callback is registered', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const result = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: 'hi',
    })
    expect(result.ok).toBe(false)
  })

  test('forwards to the registered adapter callback', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const captured: { chat: string; text: string } = { chat: '', text: '' }
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      captured.chat = msg.chat
      captured.text = msg.text ?? ''
      return { ok: true }
    })
    const result = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c-99',
      text: 'announcement',
    })
    expect(result.ok).toBe(true)
    expect(captured).toEqual({ chat: 'c-99', text: 'announcement' })
  })

  test('stamps the turn typingThread onto a DM send so the adapter can clear the status', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let capturedTypingThread: string | undefined
    let capturedThread: string | null | undefined
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      capturedTypingThread = msg.typingThread
      capturedThread = msg.thread
      return { ok: true }
    })
    await router.route(inbound({ isDm: true, thread: null, typingThread: 'dm-ts-1', text: 'hi bot' }))
    const result = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'reply' })
    expect(result.ok).toBe(true)
    expect(capturedTypingThread).toBe('dm-ts-1')
    expect(capturedThread).toBeUndefined()
  })

  test('returns ok:false with adapter error when callback denies', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: false, error: 'denied by allow rules' }))
    const result = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: 'nope',
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.error : '').toContain('denied')
  })

  test('strips a leaked think block before forwarding to the adapter', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let captured = ''
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      captured = msg.text ?? ''
      return { ok: true }
    })
    const result = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: '<think>let me figure out the tone here</think>Done — shipped it.',
    })
    expect(result.ok).toBe(true)
    expect(captured).toBe('Done — shipped it.')
  })

  test('does not forward the reasoning when the whole body was a think block', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let capturedText: string | undefined = 'UNSET'
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      capturedText = msg.text
      return { ok: true }
    })
    const result = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: '<think>they are just laughing, no reply needed</think>',
    })
    expect(result.ok).toBe(true)
    expect(capturedText === undefined || capturedText === '').toBe(true)
  })
})

describe('stripThinkBlocks', () => {
  test('removes a closed block and trims surrounding whitespace', () => {
    expect(stripThinkBlocks('<think>plan the reply</think>\n\nHello there')).toBe('Hello there')
  })

  test('removes a block wrapped by real prose on both sides', () => {
    expect(stripThinkBlocks('Sure.<think>internal</think> On it.')).toBe('Sure. On it.')
  })

  test('matches case-insensitively and tolerates attributes', () => {
    expect(stripThinkBlocks('<Think foo="bar">x</THINK>kept')).toBe('kept')
  })

  test('drops an unclosed trailing think block (budget exhaustion)', () => {
    expect(stripThinkBlocks('Visible answer.\n<think>ran out of room mid-thought')).toBe('Visible answer.')
  })

  test('removes multiple blocks in one message', () => {
    expect(stripThinkBlocks('<think>a</think>one <think>b</think>two')).toBe('one two')
  })

  test('collapses blank-line runs left by excision', () => {
    expect(stripThinkBlocks('line1\n\n<think>x</think>\n\nline2')).toBe('line1\n\nline2')
  })

  test('returns empty string when the whole body was a think block', () => {
    expect(stripThinkBlocks('<think>nothing to say</think>')).toBe('')
  })

  test('leaves text without think tags unchanged (aside from trim)', () => {
    expect(stripThinkBlocks('just a normal message')).toBe('just a normal message')
  })

  test('does not match a bare word "think" in prose', () => {
    expect(stripThinkBlocks('I think this is fine')).toBe('I think this is fine')
  })
})

describe('ChannelRouter auto-react on engage', () => {
  const REACTION_REF = { adapter: 'discord-bot' as const, value: 'msg-ref' }

  test('adds an :eyes: reaction to the triggering inbound when engaging', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const captured: ReactionRequest[] = []
    router.registerReaction('discord-bot', 'g1', async (req) => {
      captured.push(req)
      return { ok: true }
    })

    await router.route(inbound({ reactionRef: REACTION_REF }))

    await waitFor(() => captured.length > 0)
    expect(captured[0]).toMatchObject({ adapter: 'discord-bot', chat: 'c1', emoji: 'eyes', reactionRef: REACTION_REF })
    await router.__testing!.flushDebounce(KEY)
  })

  test('does not attempt a reaction when the inbound carries no reactionRef', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let called = false
    router.registerReaction('discord-bot', 'g1', async () => {
      called = true
      return { ok: true }
    })

    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    expect(called).toBe(false)
  })

  test('does not add :eyes: when the adapter has a visible typing indicator', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let called = false
    router.registerReaction('discord-bot', 'g1', async () => {
      called = true
      return { ok: true }
    })
    router.setTypingCapability('discord-bot', 'g1', true)

    await router.route(inbound({ reactionRef: REACTION_REF }))
    await router.__testing!.flushDebounce(KEY)

    expect(called).toBe(false)
  })

  test('adds :eyes: again once typing capability is cleared', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const captured: ReactionRequest[] = []
    router.registerReaction('discord-bot', 'g1', async (req) => {
      captured.push(req)
      return { ok: true }
    })
    router.setTypingCapability('discord-bot', 'g1', true)
    router.setTypingCapability('discord-bot', 'g1', false)

    await router.route(inbound({ reactionRef: REACTION_REF }))

    await waitFor(() => captured.length > 0)
    expect(captured[0]).toMatchObject({ adapter: 'discord-bot', emoji: 'eyes', reactionRef: REACTION_REF })
    await router.__testing!.flushDebounce(KEY)
  })

  test('typing capability is per-adapter and does not suppress :eyes: on other adapters', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const captured: ReactionRequest[] = []
    router.registerReaction('discord-bot', 'g1', async (req) => {
      captured.push(req)
      return { ok: true }
    })
    // given a different adapter declares typing
    router.setTypingCapability('slack-bot', 'g1', true)

    await router.route(inbound({ reactionRef: REACTION_REF }))

    await waitFor(() => captured.length > 0)
    expect(captured[0]).toMatchObject({ adapter: 'discord-bot', emoji: 'eyes', reactionRef: REACTION_REF })
    await router.__testing!.flushDebounce(KEY)
  })

  test('a throwing reaction callback never blocks engagement (session still created, reply still sends)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerReaction('discord-bot', 'g1', async () => {
      throw new Error('reaction api exploded')
    })
    const outbound: string[] = []
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      outbound.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(inbound({ reactionRef: REACTION_REF }))
    sessions[0]!.onPrompt = () => sessions[0]!.setAssistantText('NO_REPLY')
    await router.__testing!.flushDebounce(KEY)

    expect(sessions.length).toBe(1)
  })

  test('react() reports unsupported for an adapter with no reaction callback', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const result = await router.react({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      thread: null,
      reactionRef: REACTION_REF,
      emoji: 'eyes',
    })
    expect(result).toEqual({
      ok: false,
      error: 'adapter "discord-bot" does not support reactions',
      code: 'unsupported',
    })
  })

  test('react() refuses a ref whose adapter does not match the request adapter', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerReaction('discord-bot', 'g1', async () => ({ ok: true }))
    const result = await router.react({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      thread: null,
      reactionRef: { adapter: 'slack-bot', value: 'x' },
      emoji: 'eyes',
    })
    expect(result).toEqual({ ok: false, error: 'reaction ref adapter mismatch', code: 'unsupported' })
  })

  test('react() converts a throwing callback into a transient failure result, not a rejection', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerReaction('discord-bot', 'g1', async () => {
      throw new Error('reaction api exploded')
    })

    const result = await router.react({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      thread: null,
      reactionRef: REACTION_REF,
      emoji: 'eyes',
    })

    expect(result).toEqual({ ok: false, error: 'reaction api exploded', code: 'transient' })
  })
})

describe('ChannelRouter react on disengage', () => {
  const REACTION_REF: ReactionRef = { adapter: 'discord-bot', value: 'msg-ref' }

  test('reacts on the triggering message with the disengage emoji when clearSticky fires mid-turn', async () => {
    // given an engaged turn whose triggering inbound carries a reactionRef
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const captured: ReactionRequest[] = []
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    // when the model disengages during the turn (callback registered here so the
    // engage :eyes: added during route() is not captured)
    await router.route(inbound({ reactionRef: REACTION_REF }))
    sessions[0]!.onPrompt = async () => {
      router.registerReaction('discord-bot', 'g1', async (req) => {
        captured.push(req)
        return { ok: true }
      })
      router.clearSticky(KEY)
    }
    await router.__testing!.flushDebounce(KEY)

    // then the disengage emoji lands on the triggering message
    await waitFor(() => captured.length > 0)
    expect(captured[0]).toMatchObject({
      adapter: 'discord-bot',
      chat: 'c1',
      emoji: 'zipper_mouth_face',
      reactionRef: REACTION_REF,
    })
  })

  test('does not react when there is no live session for the key', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let called = false
    router.registerReaction('discord-bot', 'g1', async () => {
      called = true
      return { ok: true }
    })

    router.clearSticky(KEY)

    expect(called).toBe(false)
  })

  test('does not react when the current turn carries no reactionRef', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    let called = false
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound())
    sessions[0]!.onPrompt = async () => {
      router.registerReaction('discord-bot', 'g1', async () => {
        called = true
        return { ok: true }
      })
      router.clearSticky(KEY)
    }
    await router.__testing!.flushDebounce(KEY)

    expect(called).toBe(false)
  })

  test('a throwing disengage reaction never blocks clearSticky', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound({ reactionRef: REACTION_REF }))
    let cleared: { keyId: string; cleared: number } | null = null
    sessions[0]!.onPrompt = async () => {
      router.registerReaction('discord-bot', 'g1', async () => {
        throw new Error('reaction api exploded')
      })
      cleared = router.clearSticky(KEY)
    }
    await router.__testing!.flushDebounce(KEY)

    // clearSticky returned normally (a throwing reaction did not propagate)
    expect(cleared).toMatchObject({ keyId: 'discord-bot:g1:c1:' })
  })
})

describe('disengageReactionEmojiFor', () => {
  test('falls back to a GitHub-supported emoji because GitHub cannot render zipper_mouth_face', () => {
    expect(disengageReactionEmojiFor('github')).toBe('confused')
  })

  test('uses the default zipper_mouth_face on chat adapters that support it', () => {
    expect(disengageReactionEmojiFor('discord-bot')).toBe('zipper_mouth_face')
    expect(disengageReactionEmojiFor('slack-bot')).toBe('zipper_mouth_face')
  })
})

describe('ChannelRouter drop-eyes-after-reply', () => {
  const TARGET_REF: ReactionRef = { adapter: 'discord-bot', value: 'msg-ref' }
  const INSTANCE_REF: ReactionRef = { adapter: 'discord-bot', value: 'reaction-instance' }

  test('removes the engage-added eyes reaction after a successful reply', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const removed: RemoveReactionRequest[] = []
    router.registerReaction('discord-bot', 'g1', async () => ({ ok: true, reactionRef: INSTANCE_REF }))
    router.registerRemoveReaction('discord-bot', 'g1', async (req) => {
      removed.push(req)
      return { ok: true }
    })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound({ reactionRef: TARGET_REF }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'reply' })
    }
    await router.__testing!.flushDebounce(KEY)

    await waitFor(() => removed.length === 1)
    expect(removed[0]).toMatchObject({ adapter: 'discord-bot', chat: 'c1', reactionRef: INSTANCE_REF })
  })

  test('removes every engage reaction when multiple inbounds coalesce into one turn', async () => {
    // given two inbounds debounced into a single turn, each with its own :eyes:
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const instanceFor: Record<string, ReactionRef> = {
      'msg-a': { adapter: 'discord-bot', value: 'instance-a' },
      'msg-b': { adapter: 'discord-bot', value: 'instance-b' },
    }
    const removed: RemoveReactionRequest[] = []
    router.registerReaction('discord-bot', 'g1', async (req) => ({
      ok: true,
      reactionRef: instanceFor[req.reactionRef.value]!,
    }))
    router.registerRemoveReaction('discord-bot', 'g1', async (req) => {
      removed.push(req)
      return { ok: true }
    })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    // when both arrive before the debounce flush, then the agent replies once
    await router.route(inbound({ reactionRef: { adapter: 'discord-bot', value: 'msg-a' } }))
    await router.route(inbound({ reactionRef: { adapter: 'discord-bot', value: 'msg-b' } }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'reply' })
    }
    await router.__testing!.flushDebounce(KEY)

    // then both engage reactions are removed, not just the last inbound's
    await waitFor(() => removed.length === 2)
    expect(removed.map((r) => r.reactionRef.value).sort()).toEqual(['instance-a', 'instance-b'])
  })

  test('keeps the engage reaction when the turn sends no reply', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const removed: RemoveReactionRequest[] = []
    router.registerReaction('discord-bot', 'g1', async () => ({ ok: true, reactionRef: INSTANCE_REF }))
    router.registerRemoveReaction('discord-bot', 'g1', async (req) => {
      removed.push(req)
      return { ok: true }
    })

    await router.route(inbound({ reactionRef: TARGET_REF }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('NO_REPLY')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(removed).toHaveLength(0)
  })

  test('orders removal after the in-flight add resolves', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const removed: RemoveReactionRequest[] = []
    let resolveAdd: ((ref: ReactionRef) => void) | undefined
    router.registerReaction(
      'discord-bot',
      'g1',
      async () =>
        await new Promise((resolve: (result: { ok: true; reactionRef: ReactionRef }) => void) => {
          resolveAdd = (ref) => resolve({ ok: true, reactionRef: ref })
        }),
    )
    router.registerRemoveReaction('discord-bot', 'g1', async (req) => {
      removed.push(req)
      return { ok: true }
    })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound({ reactionRef: TARGET_REF }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'reply' })
    }
    await router.__testing!.flushDebounce(KEY)
    expect(removed).toHaveLength(0)

    resolveAdd!(INSTANCE_REF)
    await waitFor(() => removed.length === 1)
    expect(removed[0]!.reactionRef).toEqual(INSTANCE_REF)
  })

  test('does not remove when add succeeds without a removable instance ref', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    let removed = false
    router.registerReaction('discord-bot', 'g1', async () => ({ ok: true }))
    router.registerRemoveReaction('discord-bot', 'g1', async () => {
      removed = true
      return { ok: true }
    })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound({ reactionRef: TARGET_REF }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'reply' })
    }
    await router.__testing!.flushDebounce(KEY)

    expect(removed).toBe(false)
  })

  test('does not remove when add fails unsupported', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    let removed = false
    router.registerReaction('discord-bot', 'g1', async () => ({ ok: false, error: 'nope', code: 'unsupported' }))
    router.registerRemoveReaction('discord-bot', 'g1', async () => {
      removed = true
      return { ok: true }
    })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound({ reactionRef: TARGET_REF }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'reply' })
    }
    await router.__testing!.flushDebounce(KEY)

    expect(removed).toBe(false)
  })

  test('treats not-found and unsupported removal failures as non-noisy', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerReaction('discord-bot', 'g1', async () => ({ ok: true, reactionRef: INSTANCE_REF }))
    router.registerRemoveReaction('discord-bot', 'g1', async () => ({
      ok: false,
      error: 'already gone',
      code: 'not-found',
    }))
    router.registerRemoveReaction('discord-bot', 'g1', async () => ({
      ok: false,
      error: 'unsupported',
      code: 'unsupported',
    }))
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound({ reactionRef: TARGET_REF }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'reply' })
    }
    await router.__testing!.flushDebounce(KEY)
    await waitFor(() => logs.some((m) => m.includes('prompted elapsed_ms')))

    expect(logs.some((m) => m.includes('engage-unreact'))).toBe(false)
  })

  test('removeReaction dispatcher mirrors react() unsupported and transient behavior', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const noCallback = await router.removeReaction({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      reactionRef: INSTANCE_REF,
    })
    expect(noCallback).toEqual({
      ok: false,
      error: 'adapter "discord-bot" does not support reaction removal',
      code: 'unsupported',
    })

    router.registerRemoveReaction('discord-bot', 'g1', async () => {
      throw new Error('remove api exploded')
    })
    const mismatch = await router.removeReaction({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      reactionRef: { adapter: 'slack-bot', value: 'x' },
    })
    expect(mismatch).toEqual({ ok: false, error: 'reaction ref adapter mismatch', code: 'unsupported' })

    const thrown = await router.removeReaction({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      reactionRef: INSTANCE_REF,
    })
    expect(thrown).toEqual({ ok: false, error: 'remove api exploded', code: 'transient' })
  })
})

describe('ChannelRouter channel-turn protocol', () => {
  test('allows NO_REPLY when no channel tool sent a message', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })

    await router.route(inbound({ text: 'just FYI' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('NO_REPLY')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(logs.some((m) => m.includes('no_reply'))).toBe(true)
    expect(logs.some((m) => m.includes('blocked assistant_text_without_channel_tool'))).toBe(false)
  })

  test('allows (NO_REPLY) with parens as a silent-turn signal', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'just FYI' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('(NO_REPLY)')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(logs.some((m) => m.includes('no_reply'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
    expect(sent).toHaveLength(0)
  })

  test('allows empty visible text (thinking-only response) as a silent-turn signal', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'just FYI' }))
    sessions[0]!.onPrompt = () => {
      // given: assistant message with only a thinking block, no visible text
      // (e.g. Kimi-distilled models that end the turn after thinking)
      sessions[0]!.setAssistantMessage({
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'no need to respond' }],
        api: 'openai-completions',
        provider: 'openai',
        model: 'test-model',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: 1000,
      })
    }
    await router.__testing!.flushDebounce(KEY)

    expect(logs.some((m) => m.includes('no_reply'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
    expect(sent).toHaveLength(0)
  })

  test('cold-start solo-human fallback: a bare-empty stop retries, then the model answers', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    // given: a non-mention direct question on a freshly cold-started solo channel
    await router.route(inbound({ isBotMention: false, text: '일정 어떻게 되는 거더라' }))
    let calls = 0
    sessions[0]!.onPrompt = () => {
      calls++
      // when: the model whiffs an empty completion, then answers on the retry
      if (calls === 1) sessions[0]!.setAssistantText('')
      else sessions[0]!.setAssistantText('마감은 다음 주 화요일이야.')
    }
    await router.__testing!.flushDebounce(KEY)

    // then: it retried instead of dropping silently, and the answer landed
    expect(sessions[0]!.prompts).toHaveLength(2)
    expect(logs.some((m) => m.includes('empty_turn_retry') && m.includes('cause=cold_start_solo_bare_empty'))).toBe(
      true,
    )
    expect(sent.map((s) => s.text)).toEqual(['마감은 다음 주 화요일이야.'])
    expect(logs.some((m) => m.includes('no_reply'))).toBe(false)
  })

  test('cold-start solo-human fallback: a persistent bare-empty stop exhausts to the visible fallback', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ isBotMention: false, text: '일정 알려줘' }))
    sessions[0]!.onPrompt = () => sessions[0]!.setAssistantText('')
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1 + MAX_EMPTY_TURN_RETRIES)
    expect(
      logs.filter((m) => m.includes('empty_turn_retry') && m.includes('cause=cold_start_solo_bare_empty')).length,
    ).toBe(MAX_EMPTY_TURN_RETRIES)
    expect(sent.map((s) => s.text)).toEqual([EMPTY_TURN_FALLBACK_TEXT])
    expect(logs.some((m) => m.includes('empty_turn_fallback cause=cold_start_solo_bare_empty_retries_exhausted'))).toBe(
      true,
    )
  })

  test('cold-start solo-human fallback: an explicit NO_REPLY stays silent (no retry)', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ isBotMention: false, text: 'just chatter' }))
    sessions[0]!.onPrompt = () => sessions[0]!.setAssistantText('NO_REPLY')
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(logs.some((m) => m.includes('no_reply'))).toBe(true)
    expect(logs.some((m) => m.includes('cold_start_solo_bare_empty'))).toBe(false)
    expect(sent).toHaveLength(0)
  })

  test('cold-start bare-empty is NOT retried when the message @-mentions the bot (explicit address)', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    // given: a MENTION is explicit address, so the historical empty=silent path holds
    await router.route(inbound({ isBotMention: true, text: 'hey bot' }))
    sessions[0]!.onPrompt = () => sessions[0]!.setAssistantText('')
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(logs.some((m) => m.includes('no_reply'))).toBe(true)
    expect(logs.some((m) => m.includes('cold_start_solo_bare_empty'))).toBe(false)
  })

  test('bare-empty is NOT retried on a later warm turn — only the first cold-start turn is armed', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    // given: turn 1 (cold-start solo) answers normally, advancing turnSeq past 0
    await router.route(inbound({ isBotMention: false, text: 'q1', externalMessageId: 'm1' }))
    sessions[0]!.onPrompt = () => sessions[0]!.setAssistantText('answer 1')
    await router.__testing!.flushDebounce(KEY)

    // when: a later turn whiffs a bare-empty stop
    sessions[0]!.onPrompt = () => sessions[0]!.setAssistantText('')
    await router.route(inbound({ isBotMention: false, text: 'q2', externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)

    // then: the arm self-cleared — no retry, historical no_reply
    expect(logs.some((m) => m.includes('cold_start_solo_bare_empty'))).toBe(false)
    expect(logs.some((m) => m.includes('no_reply'))).toBe(true)
  })

  test('suppresses recovery when assistant ends with NO_REPLY after leaked reasoning', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'haha' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText(
        'The user is laughing. This is just a reaction, not a direct request. I can choose to not reply. ' +
          "However, given the recent engagement, a brief no-op is fine. But since the user didn't ask anything, " +
          "I'll end with NO_REPLY.NO_REPLY",
      )
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('no_reply (with_leaked_reasoning)'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  test('suppresses recovery when assistant ends with bare NO_REPLY after prose', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'just FYI' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText("Nothing to add here. I'll end with NO_REPLY")
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('no_reply (with_leaked_reasoning)'))).toBe(true)
  })

  test('suppresses recovery when assistant ends with parenthesized (NO_REPLY) after prose', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'just FYI' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('Nothing actionable in this message. (NO_REPLY)')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('no_reply (with_leaked_reasoning)'))).toBe(true)
  })

  test('still recovers prose that mentions NO_REPLY mid-sentence (not at end)', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'what does NO_REPLY do?' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText(
        'NO_REPLY is the silent-turn signal — the agent ends its turn with it to stay quiet.',
      )
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('silent-turn signal')
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(true)
  })

  test('still recovers prose where NO_REPLY appears as a substring of another token', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'which env var?' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('The env var is named NO_REPLY_MODE')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('NO_REPLY_MODE')
  })

  test('skip_response: markTurnSkipped + skip-only turn produces no channel send, logs reason, no recovery', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'just FYI, no question' }))
    sessions[0]!.onPrompt = () => {
      const result = router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'no new info to add' })
      expect(result.kind).toBe('recorded')
      sessions[0]!.setAssistantText('Nothing actionable here.')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('skipped_by_tool reason="no new info to add"'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
    expect(logs.some((m) => m.includes('no_reply'))).toBe(false)
  })

  test('skip_response: suppresses recovery even when the assistant turn produced visible prose', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'casual' }))
    sessions[0]!.onPrompt = () => {
      router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'duplicate' })
      // given: model leaked meta-narration before / instead of NO_REPLY.
      // The skip guard must win — recovery would otherwise post this.
      sessions[0]!.setAssistantText("Same story as before; I'll stay quiet here.")
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('skipped_by_tool'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  test('skip_response: stale skippedTurn from an earlier turnSeq does NOT suppress the next turn', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    // Turn 1: skip cleanly.
    await router.route(inbound({ text: 'turn-1' }))
    sessions[0]!.onPrompt = () => {
      router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'turn-1-skip' })
      sessions[0]!.setAssistantText('')
    }
    await router.__testing!.flushDebounce(KEY)
    expect(sent).toHaveLength(0)

    // Turn 2: do NOT skip. The skip flag from turn 1 was consumed at the
    // end of validateChannelTurn; if it had not been (or if turnSeq match
    // were missing), the model's reply here would be silently dropped.
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('Actual reply to turn 2.')
    }
    await router.route(inbound({ text: 'turn-2', externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('Actual reply to turn 2')
  })

  test('skip_response: channel_send after skip_response in the same turn is rejected with SKIP_RESPONSE_LOCK_ERROR', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hi' }))
    let sendResult: SendResult | undefined
    sessions[0]!.onPrompt = async () => {
      router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'on second thought' })
      sendResult = await router.send({
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        text: 'wait, I do want to reply',
      })
    }
    await router.__testing!.flushDebounce(KEY)

    // The live tool send stays denied (commit-to-silence is binding for the
    // live path). With no recoverable assistant text in the branch, the
    // contested-skip fall-through finds nothing to surface, so nothing is sent.
    expect(sendResult?.ok).toBe(false)
    expect(sendResult?.ok === false ? sendResult.code : '').toBe('skip-locked')
    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('skip_contested_by_send'))).toBe(true)
  })

  test('skip_response: system-source sends (recovery, role-claim) bypass the skip lock', async () => {
    const dir = await tempDir()
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hi' }))
    sessions[0]!.onPrompt = async () => {
      router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'tool skip' })
      // when: a system-source send fires (mimicking recovery / role-claim)
      const result = await router.send(
        { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'system-side message' },
        { source: 'system' },
      )
      // then: lock does NOT apply to system sources — the message delivers
      expect(result.ok).toBe(true)
    }
    await router.__testing!.flushDebounce(KEY)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('system-side message')
  })

  test('skip_response: markTurnSkipped after a tool-source send is accepted as a terminal no-op (reply stands)', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hi' }))
    let markResult: ReturnType<ChannelRouter['markTurnSkipped']> | undefined
    sessions[0]!.onPrompt = async () => {
      // given: a tool-source ack has already landed this turn
      const sendResult = await router.send({
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        text: 'On it, reviewing…',
      })
      expect(sendResult.ok).toBe(true)
      // when: the model then goes quiet (the ack-then-wait pattern)
      markResult = router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'waiting for reviewer' })
    }
    await router.__testing!.flushDebounce(KEY)

    // then: the skip is accepted as a no-op; the ack stands and is NOT suppressed
    expect(markResult?.kind).toBe('recorded-after-send')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('On it, reviewing…')
    expect(logs.some((m) => m.includes('skip_after_send'))).toBe(true)
    expect(logs.some((m) => m.includes('skipped_by_tool'))).toBe(false)
  })

  test('skip_response: after a send does NOT drive a re-send livelock (stops at the single ack)', async () => {
    // Regression for the skip-after-send livelock: a model that acks then tries
    // to go quiet must NOT be forced to keep sending. Pre-fix, markTurnSkipped
    // returned 'send-already-happened' and a model that "re-sends only when the
    // skip is refused" would spam up to the per-turn cap.
    const dir = await tempDir()
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'please review PR #1' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'On it' })
      for (let i = 0; i < MAX_CHANNEL_SENDS_PER_TURN + 5; i++) {
        const skip = router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'waiting for reviewer' })
        if (skip.kind === 'recorded-after-send' || skip.kind === 'recorded') break
        await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: `still working (${i})` })
      }
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('On it')
  })

  test('skip_response: send-after-skip lock still applies on the silence-first path', async () => {
    const dir = await tempDir()
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'first' }))
    sessions[0]!.onPrompt = async () => {
      // given: silence-first skip with no prior send arms the send lock
      const r = router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'nothing to add' })
      expect(r.kind).toBe('recorded')
      // when: a later tool-source send is attempted in the same turn
      const send = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'wait, reply' })
      // then: it is rejected by the skip lock
      expect(send.ok).toBe(false)
      expect(send.ok === false ? send.code : '').toBe('skip-locked')
    }
    await router.__testing!.flushDebounce(KEY)
    expect(sent).toHaveLength(0)

    // next turn with no send: skip still records cleanly (per-turn reset)
    let turn2Result: ReturnType<ChannelRouter['markTurnSkipped']> | undefined
    sessions[0]!.onPrompt = () => {
      turn2Result = router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'still nothing' })
      sessions[0]!.setAssistantText('')
    }
    await router.route(inbound({ text: 'second', externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)
    expect(turn2Result?.kind).toBe('recorded')
    expect(sent).toHaveLength(0)
  })

  test('skip_response then contested channel_reply: send stays denied but reply is recovered, not dropped', async () => {
    // Regression for the production drop: the model called skip_response first,
    // then changed its mind and called channel_reply. The send is denied
    // skip-locked (commit-to-silence is binding for the live path), but the
    // reply text must NOT be silently dropped — recovery posts it via system.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'please review again' }))
    let sendResult: SendResult | undefined
    sessions[0]!.onPrompt = async () => {
      // given: silence-first skip, then a contested reply attempt
      router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'on second thought' })
      sendResult = await router.send({
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        text: 'On it — reviewing now.',
      })
      sessions[0]!.setAssistantText('On it — reviewing now.')
    }
    await router.__testing!.flushDebounce(KEY)

    // then: the live tool send is still denied skip-locked...
    expect(sendResult?.ok).toBe(false)
    expect(sendResult?.ok === false ? sendResult.code : '').toBe('skip-locked')
    // ...but recovery surfaces the reply via a system-source send
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('On it — reviewing now.')
    expect(logs.some((m) => m.includes('skip_contested_by_send'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(true)
    expect(logs.some((m) => m.includes('skipped_by_tool'))).toBe(false)
  })

  test('skip_response then contested reply with NO_REPLY text: stays silent (recovery guards still apply)', async () => {
    // A contested skip falls through to recovery, but recovery's existing
    // NO_REPLY guard must still suppress: nothing user-facing to surface.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'anything to add?' }))
    sessions[0]!.onPrompt = async () => {
      router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'nothing actionable' })
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'NO_REPLY' })
      sessions[0]!.setAssistantText('NO_REPLY')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('no_reply'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  test('contested-skip flag does not leak: a clean skip-only turn after a contested turn still stays silent', async () => {
    // Per-turn reset guard: the skipLockedSendTurn flag from a contested turn
    // must not cause a later skip-only turn to bypass its short-circuit.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    // turn 1: contested skip (recovers a reply)
    await router.route(inbound({ text: 'first' }))
    sessions[0]!.onPrompt = async () => {
      router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'changed mind' })
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'turn-1 reply' })
      sessions[0]!.setAssistantText('turn-1 reply')
    }
    await router.__testing!.flushDebounce(KEY)
    expect(sent).toHaveLength(1)

    // turn 2: clean skip-only — must short-circuit, no recovery, no leak
    sessions[0]!.onPrompt = () => {
      router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'nothing to add' })
      sessions[0]!.setAssistantText('this text should NOT be recovered')
    }
    await router.route(inbound({ text: 'second', externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(logs.some((m) => m.includes('skipped_by_tool'))).toBe(true)
  })

  test('policy-denial loop: repeated skip-locked sends (silence-first) abort the run instead of looping', async () => {
    // Regression for the silence-first livelock: the model skips, then retries
    // channel_reply with varied text. Each retry is denied `skip-locked` but
    // never increments the send cap, so pre-fix the loop ran unbounded.
    //
    // Production-faithful: a thrown denial would NOT end the turn (pi catches
    // tool throws into error results), so the router aborts the run's signal
    // instead. We mirror pi's loop: keep retrying until `agent.signal.aborted`,
    // exactly as the real agent loop ends the turn on the next stream once the
    // signal flips.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'just FYI' }))
    const sendResults: SendResult[] = []
    sessions[0]!.onPrompt = async () => {
      router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'nothing to add' })
      // when: the model ignores the lock and retries SEQUENTIALLY with DIFFERENT
      // text each time (so the byte-identical loop-guard never fires), stopping
      // only when the run signal is aborted — as the real agent loop would
      let i = 0
      while (!sessions[0]!.agent.signal.aborted && i < 100) {
        sendResults.push(
          await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: `attempt ${i}` }),
        )
        i++
      }
    }
    await router.__testing!.flushDebounce(KEY)

    // then: the run is aborted exactly at the ceiling, every attempt was a soft
    // skip-locked denial, and nothing was ever delivered to the channel
    expect(sessions[0]!.agent.signal.aborted).toBe(true)
    expect(sendResults).toHaveLength(MAX_POLICY_DENIED_CHANNEL_SENDS_PER_TURN)
    expect(sendResults.every((r) => r.ok === false && r.code === 'skip-locked')).toBe(true)
    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('aborting turn') && m.includes('policy-denied'))).toBe(true)
  })

  test('policy-denial loop: repeated sequential duplicate sends abort the run (Discord incident)', async () => {
    // Regression for the Discord livelock: the model delivers a reply, then
    // re-sends the SAME text on each later iteration. Each is denied `duplicate`
    // (a no-op skip_response interleaves, so the loop-guard's consecutive-streak
    // never fires) and never increments the send cap. The first delivery resets
    // the per-target counter, so the SEQUENTIAL retries that follow must still
    // accumulate and abort the run.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hi' }))
    const dupResults: SendResult[] = []
    sessions[0]!.onPrompt = async () => {
      // given: a first reply lands (resets the per-target denial counter)
      const first = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'same text' })
      expect(first.ok).toBe(true)
      // when: the model re-sends the identical text until the run is aborted
      let i = 0
      while (!sessions[0]!.agent.signal.aborted && i < 100) {
        dupResults.push(await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'same text' }))
        i++
      }
    }
    await router.__testing!.flushDebounce(KEY)

    // then: duplicates are soft until the ceiling aborts the run; only the
    // single first reply was ever delivered
    expect(sessions[0]!.agent.signal.aborted).toBe(true)
    expect(dupResults).toHaveLength(MAX_POLICY_DENIED_CHANNEL_SENDS_PER_TURN)
    expect(dupResults.every((r) => r.ok === false && r.code === 'duplicate')).toBe(true)
    expect(sent).toEqual([{ text: 'same text' }])
    expect(logs.some((m) => m.includes('aborting turn') && m.includes('policy-denied'))).toBe(true)
  })

  test('policy-denial loop: counter resets per turn (denials below the ceiling do not throw, next turn replies)', async () => {
    const dir = await tempDir()
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    // turn 1: skip, then deny just below the ceiling (no throw, no delivery)
    await router.route(inbound({ text: 'first' }))
    sessions[0]!.onPrompt = async () => {
      router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'nothing' })
      for (let i = 0; i < MAX_POLICY_DENIED_CHANNEL_SENDS_PER_TURN - 1; i++) {
        await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: `x${i}` })
      }
    }
    await router.__testing!.flushDebounce(KEY)
    expect(sent).toHaveLength(0)

    // turn 2: a fresh turn — the counter reset means a normal reply lands
    sessions[0]!.onPrompt = async () => {
      const r = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'real reply' })
      expect(r.ok).toBe(true)
    }
    await router.route(inbound({ text: 'second', externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('real reply')
  })

  test('skip_response: markTurnSkipped returns no-live-session when sessionId does not match any live session', () => {
    const result = makeRouter('/tmp/unused').router.markTurnSkipped({
      parentSessionId: 'ses_no_such_session',
      reason: 'whatever',
    })
    expect(result.kind).toBe('no-live-session')
  })

  test('suppresses upstream `(Empty response: ...)` sentinel instead of leaking thinking/signature', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      // given: the upstream provider SDK fabricated a single text block whose
      // body is a Python-repr dump of the raw API response (observed shape
      // verbatim from the 2026-05-21 production leak — thinking content +
      // Anthropic signature inlined).
      sessions[0]!.setAssistantText(
        "(Empty response: {'content': [{'type': 'thinking', 'thinking': 'no need', " +
          "'signature': 'EpQCCkYI...'}], 'stop_reason': 'end_turn', 'model': 'claude-opus-4-5'})",
      )
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('suppressed upstream_empty_response_sentinel'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  test('still recovers legit prose that happens to mention "Empty response" without the python-dict shape', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('Empty response from the cache layer, retrying.')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toEqual([{ text: 'Empty response from the cache layer, retrying.' }])
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(true)
    expect(logs.some((m) => m.includes('suppressed upstream_empty_response_sentinel'))).toBe(false)
  })

  test('suppresses leaked Kimi tool-call delimiter tokens instead of posting them to the channel', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText(
        'channel_reply:0<|tool_call_argument_begin|>{"text": "hi there"}<|tool_calls_section_end|>',
      )
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('suppressed kimi_tool_call_leak'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  test('suppresses the canonical full-shape leak (two consecutive channel_reply calls in one section)', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText(
        '<|tool_calls_section_begin|>' +
          '<|tool_call_begin|>functions.channel_reply:0<|tool_call_argument_begin|>{"text": "first"}<|tool_call_end|>' +
          '<|tool_call_begin|>functions.channel_reply:1<|tool_call_argument_begin|>{"text": "second"}<|tool_call_end|>' +
          '<|tool_calls_section_end|>',
      )
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('suppressed kimi_tool_call_leak'))).toBe(true)
  })

  test('still recovers legit prose that happens to mention "channel_reply" without Kimi delimiter tokens', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('I would normally call channel_reply:0 here but I want to ask you first.')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('channel_reply:0')
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(true)
    expect(logs.some((m) => m.includes('suppressed kimi_tool_call_leak'))).toBe(false)
  })

  test('still recovers documentation-style prose explaining Kimi delimiters without a channel-tool identifier', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'how does Kimi format tool calls?' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText(
        'Kimi wraps tool calls with `<|tool_calls_section_begin|>` and `<|tool_calls_section_end|>`, ' +
          'with each call delimited by `<|tool_call_begin|>` and `<|tool_call_end|>`.',
      )
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('Kimi wraps tool calls')
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(true)
    expect(logs.some((m) => m.includes('suppressed kimi_tool_call_leak'))).toBe(false)
  })

  test('recovers the text arg from a leaked plain-text channel_reply(...) serialization instead of dropping it', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('channel_reply({"text":"hi there"})')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('hi there')
    expect(logs.some((m) => m.includes('recovered plain_text_channel_tool_call kind=reply'))).toBe(true)
  })

  test('recovers the text arg from the unquoted-key channel_reply shape Kimi emits', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'yo typeey' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('channel_reply({ text: "hey! what\'s going on today?" })')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe("hey! what's going on today?")
    expect(logs.some((m) => m.includes('recovered plain_text_channel_tool_call kind=reply'))).toBe(true)
  })

  test('recovers the text arg from a single-quoted channel_reply(...) serialization', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText("channel_reply({text: 'it\\'s me'})")
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe("it's me")
    expect(logs.some((m) => m.includes('recovered plain_text_channel_tool_call kind=reply'))).toBe(true)
  })

  test('recovers the text arg from a truncated channel_reply(...) serialization', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('channel_reply({"text":"hi there, how can I help')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('hi there, how can I help')
    expect(logs.some((m) => m.includes('recovered plain_text_channel_tool_call kind=reply'))).toBe(true)
  })

  test('recovers only the text arg from a leaked channel_send(...), ignoring model-supplied destination', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ chat: string; text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ chat: msg.chat, text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('channel_send({"adapter":"discord-bot","chat":"evil-channel","text":"hi"})')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('hi')
    expect(sent[0]!.chat).not.toBe('evil-channel')
    expect(logs.some((m) => m.includes('recovered plain_text_channel_tool_call kind=send'))).toBe(true)
  })

  test('recovers the real text arg even when an earlier field value contains a "text:" substring', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('channel_reply({ reason: "contains text: foo", text: "real reply" })')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('real reply')
    expect(logs.some((m) => m.includes('recovered plain_text_channel_tool_call kind=reply'))).toBe(true)
  })

  test('recovers the top-level text arg even when a nested object carries its own "text" key', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('channel_reply({ meta: { text: "debug" }, text: "real reply" })')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('real reply')
    expect(logs.some((m) => m.includes('recovered plain_text_channel_tool_call kind=reply'))).toBe(true)
  })

  test('suppresses a leaked channel_reply(...) whose extracted text is itself a no-reply signal', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('channel_reply({"text":"NO_REPLY"})')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
  })

  test('suppresses a leaked channel_reply(...) with no recoverable text arg', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('channel_reply({"reason":"some leaked arg with a " quote"})')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('suppressed unextractable_plain_text_channel_tool_call'))).toBe(true)
  })

  test('suppresses leaked plain-text skip_response(...) serialization instead of posting it to the channel', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('skip_response({ reason: "Empty messages, no content to respond to" })')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('suppressed plain_text_channel_skip_response'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  test('still recovers prose that mentions skip_response in a non-call shape', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'how do you decline a turn?' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('I call the skip_response tool when there is nothing worth replying to.')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('skip_response tool')
    expect(logs.some((m) => m.includes('suppressed plain_text_channel_tool_call'))).toBe(false)
  })

  test('still recovers prose that mentions channel_reply in a non-call shape', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'how do I reply?' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('Use the channel_reply tool — pass `text` and I will deliver it for you.')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('channel_reply tool')
    expect(logs.some((m) => m.includes('suppressed plain_text_channel_tool_call'))).toBe(false)
  })

  describe('getPlainTextChannelToolCallKind', () => {
    test('classifies anchored reply/send/skip serializations', () => {
      expect(getPlainTextChannelToolCallKind('channel_reply({"text":"hi"})')).toBe('reply')
      expect(getPlainTextChannelToolCallKind('channel_send({"chat":"c","text":"hi"})')).toBe('send')
      expect(getPlainTextChannelToolCallKind('skip_response({ reason: "no content" })')).toBe('skip')
    })

    test('returns null for prose that merely mentions a tool name', () => {
      expect(getPlainTextChannelToolCallKind('Use the channel_reply tool to send "text".')).toBeNull()
      expect(getPlainTextChannelToolCallKind('channel_reply does this')).toBeNull()
    })
  })

  describe('extractPlainTextChannelToolCallText', () => {
    test('extracts double-quoted text', () => {
      expect(extractPlainTextChannelToolCallText('channel_reply({"text":"hi there"})')).toBe('hi there')
    })

    test('extracts unquoted-key, single-space, apostrophe-bearing text', () => {
      expect(extractPlainTextChannelToolCallText('channel_reply({ text: "what\'s up" })')).toBe("what's up")
    })

    test('extracts single-quoted value with an escaped inner quote', () => {
      expect(extractPlainTextChannelToolCallText("channel_reply({text: 'it\\'s me'})")).toBe("it's me")
    })

    test('decodes \\n / \\t escapes inside the value', () => {
      expect(extractPlainTextChannelToolCallText('channel_reply({"text":"line1\\nline2\\ttab"})')).toBe(
        'line1\nline2\ttab',
      )
    })

    test('recovers a truncated value missing its closing quote and paren', () => {
      expect(extractPlainTextChannelToolCallText('channel_reply({"text":"hello world')).toBe('hello world')
    })

    test('ignores destination args and extracts only text from channel_send', () => {
      expect(
        extractPlainTextChannelToolCallText('channel_send({"adapter":"discord-bot","chat":"c1","text":"hi"})'),
      ).toBe('hi')
    })

    test('returns null when no text arg is present', () => {
      expect(extractPlainTextChannelToolCallText('channel_reply({"reason":"nope"})')).toBeNull()
    })

    test('returns null for an empty text value', () => {
      expect(extractPlainTextChannelToolCallText('channel_reply({"text":""})')).toBeNull()
      expect(extractPlainTextChannelToolCallText('channel_reply({"text":"   "})')).toBeNull()
    })

    test('returns null for skip_response (never a user-facing reply)', () => {
      expect(extractPlainTextChannelToolCallText('skip_response({ reason: "x" })')).toBeNull()
    })

    test('returns null for prose mentioning the tool name', () => {
      expect(extractPlainTextChannelToolCallText('Use channel_reply with a "text" field.')).toBeNull()
    })

    test('skips a "text:" substring inside an earlier double-quoted field value', () => {
      expect(
        extractPlainTextChannelToolCallText('channel_reply({ reason: "contains text: foo", text: "real reply" })'),
      ).toBe('real reply')
    })

    test('skips a "text:" substring inside an earlier single-quoted field value', () => {
      expect(extractPlainTextChannelToolCallText("channel_reply({ note: 'the text: thing', text: 'right one' })")).toBe(
        'right one',
      )
    })

    test('skips destination strings that merely contain "text:" on channel_send', () => {
      expect(extractPlainTextChannelToolCallText('channel_send({ chat: "no text: here", text: "hi" })')).toBe('hi')
    })

    test('returns null when the only "text:" lives inside a quoted value', () => {
      expect(extractPlainTextChannelToolCallText('channel_reply({ reason: "no text: key here" })')).toBeNull()
    })

    test('skips a "text" key inside a nested object and extracts the top-level text', () => {
      expect(
        extractPlainTextChannelToolCallText('channel_reply({ meta: { text: "debug" }, text: "real reply" })'),
      ).toBe('real reply')
    })

    test('skips deeply nested "text" keys and extracts the top-level text', () => {
      expect(extractPlainTextChannelToolCallText('channel_reply({ a: { b: { text: "deep" } }, text: "top" })')).toBe(
        'top',
      )
    })

    test('skips a "text" key nested inside an array element', () => {
      expect(extractPlainTextChannelToolCallText('channel_reply({ items: [{ text: "arr" }], text: "outer" })')).toBe(
        'outer',
      )
    })

    test('returns null when "text" exists only inside a nested object', () => {
      expect(extractPlainTextChannelToolCallText('channel_reply({ meta: { text: "only nested" } })')).toBeNull()
    })
  })

  test('recovers visible assistant text when no channel tool sent a message', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    const sent: Array<{ chat: string; thread: string | null | undefined; text: string }> = []
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ chat: msg.chat, thread: msg.thread, text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'say hi' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('hi from invisible assistant text')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toEqual([{ chat: 'c1', thread: null, text: 'hi from invisible assistant text' }])
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(true)
    expect(logs.some((m) => m.includes('blocked assistant_text_without_channel_tool'))).toBe(false)
  })

  // Regression for the Kimi-on-Fireworks `kimi-k2p6-turbo` KakaoTalk silence
  // bug: the model narrated a user-facing reply ("16x now") AND committed to a
  // tool plan in the same message (stopReason='toolUse'), then the turn ended
  // before any follow-up message that would have called channel_reply was
  // persisted. The leaf is the assistant message itself, not a toolResult, so
  // 'pre-tool' recovery does not apply. Without 'mid-turn' recovery the prose
  // is silently dropped and the user sees nothing.
  test('mid-turn recovery: recovers prose when leaf is a toolUse assistant with no follow-up', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'go 16x speed' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantMidTurn('Running at 16x speed! Hold on a sec and I will grab a screenshot!')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(
      logs.some((m) => m.includes('recovering assistant_text_without_channel_tool') && m.includes('source=mid-turn')),
    ).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('Running at 16x speed! Hold on a sec and I will grab a screenshot!')
  })

  test('mid-turn recovery: applies the NO_REPLY guard to recovered prose', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'check something' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantMidTurn("Nothing to add here. I'll end with NO_REPLY")
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('no_reply'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  test('mid-turn recovery: applies the Kimi tool-call leak guard to recovered prose', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'check something' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantMidTurn(
        'channel_reply:0<|tool_call_argument_begin|>{"text": "hi there"}<|tool_calls_section_end|>',
      )
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('suppressed kimi_tool_call_leak'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  test('recovery suppresses a github close-out ack while the bot holds CHANGES_REQUESTED (PR #672)', async () => {
    // Regression for PR #672: the bot held a live CHANGES_REQUESTED, the author
    // pushed a fix, and the model ended its turn with "that addresses the
    // concern nicely" as PLAIN PROSE — no channel_reply / channel_send. The
    // re-review guard lives only in those tool handlers, so the recovery path
    // surfaced the verdict-shaped ack via a source:'system' send, stranding the
    // PR's reviewDecision at CHANGES_REQUESTED. The egress guard must suppress.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const githubKey: ChannelKey = { adapter: 'github', workspace: 'acme/repo', chat: 'pr:672', thread: null }
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('github', 'acme/repo', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })
    router.registerReviewStateResolver('github', 'acme/repo', async () => ({
      ok: true,
      selfBlocking: true,
      approve: true,
    }))

    await router.route(inbound({ adapter: 'github', workspace: 'acme/repo', chat: 'pr:672' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('Thanks — that addresses the concern nicely. ✅')
    }
    await router.__testing!.flushDebounce(githubKey)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('suppressed recovery (github review guard)'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  test('recovery still surfaces a github reply when the bot does NOT hold a live block', async () => {
    // The egress guard is scoped: an unblocked PR (no sticky CHANGES_REQUESTED)
    // must not have ordinary recovered prose dropped. Only a close-out claim
    // against a live self-block is suppressed.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const githubKey: ChannelKey = { adapter: 'github', workspace: 'acme/repo', chat: 'pr:672', thread: null }
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('github', 'acme/repo', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })
    router.registerReviewStateResolver('github', 'acme/repo', async () => ({
      ok: true,
      selfBlocking: false,
      approve: true,
    }))

    await router.route(inbound({ adapter: 'github', workspace: 'acme/repo', chat: 'pr:672' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('Looking into the new commits now — will follow up shortly.')
    }
    await router.__testing!.flushDebounce(githubKey)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('Looking into the new commits now — will follow up shortly.')
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(true)
  })

  test('recovery review guard is a no-op for non-github channels', async () => {
    // The guard must not perturb discord/slack recovery: a close-out-shaped ack
    // on a non-github channel carries no review semantics and surfaces normally.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'did you fix it?' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('Yep — that resolves it, looks good. ✅')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('Yep — that resolves it, looks good. ✅')
    expect(logs.some((m) => m.includes('suppressed recovery (github review guard)'))).toBe(false)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(true)
  })

  test('mid-turn recovery: applies the upstream empty-response sentinel guard to recovered prose', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'check something' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantMidTurn(
        "(Empty response: {'content': [{'type': 'thinking', 'thinking': 'no need', " +
          "'signature': 'EpQCCkYI...'}], 'stop_reason': 'end_turn', 'model': 'claude-opus-4-5'})",
      )
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('suppressed upstream_empty_response_sentinel'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  // The leaf-assistant branch recovers ONLY 'stop' and 'toolUse'. length /
  // error / aborted carry visible text too, but it's a truncation or an
  // errored partial, not a deliberate reply — recovering it would post broken
  // output. This is the load-bearing scoping of the mid-turn fix. The truncated
  // prose is NEVER posted; instead the empty-turn guard retries the turn and,
  // on exhaustion, posts the fallback (asserted in the empty-turn suite below).
  for (const stopReason of ['length', 'error', 'aborted'] as const) {
    test(`mid-turn recovery: does NOT recover a leaf assistant with stopReason='${stopReason}'`, async () => {
      const dir = await tempDir()
      const logs: string[] = []
      const sent: Array<{ text: string }> = []
      const { router, sessions } = makeRouter(dir, { logs })
      router.registerOutbound('discord-bot', 'g1', async (msg) => {
        sent.push({ text: msg.text ?? '' })
        return { ok: true }
      })

      await router.route(inbound({ text: 'check something' }))
      sessions[0]!.onPrompt = () => {
        sessions[0]!.setAssistantMidTurn('partial truncated output that must not be posted', stopReason)
      }
      await router.__testing!.flushDebounce(KEY)

      expect(sent.some((s) => s.text.includes('partial truncated output'))).toBe(false)
      expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
    })
  }

  test('empty-turn guard: pure reasoning-loop retries then recovers when a later attempt replies', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'ambiguous thing' }))
    let attempt = 0
    sessions[0]!.onPrompt = async (text) => {
      attempt++
      // First prompt: degenerate empty `length` leaf (no send). Retry nudge
      // arrives as the second prompt; on it the model finally replies.
      if (attempt === 1) {
        sessions[0]!.setAssistantMidTurn('thought-loop output that must not be posted', 'length')
        return
      }
      expect(text).toContain(EMPTY_TURN_RETRY_NUDGE)
      sessions[0]!.setAssistantText('SENT')
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'here is your answer' })
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(2)
    expect(sent.map((s) => s.text)).toEqual(['here is your answer'])
    expect(sent.some((s) => s.text === EMPTY_TURN_FALLBACK_TEXT)).toBe(false)
    expect(logs.some((m) => m.includes('empty_turn_retry attempt=1'))).toBe(true)
    expect(logs.some((m) => m.includes('empty_turn_fallback'))).toBe(false)
  })

  test('cross-turn escalation: a length-retried non-question turn overwrites the prior question signal', async () => {
    // given: turn A is a question (seeds the prior signal); turn B is a
    // NON-question that length-truncates then recovers on retry; turn C is a
    // question. The completed logical turn B must commit its own (non-question)
    // signal, so C sees a non-question predecessor and must NOT mode-3 escalate.
    // Before the pending-commit fix, B's truncated attempt never committed and
    // A's question signal leaked across B, wrongly escalating C.
    const dir = await tempDir()
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    // turn A — a real question, completes cleanly
    await router.route(inbound({ text: 'why did the deployment fail on the staging cluster?' }))
    sessions[0]!.onPrompt = async () => {
      sessions[0]!.setAssistantText('A')
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'because of X' })
    }
    await router.__testing!.flushDebounce(KEY)

    // turn B — a non-question that truncates (length) then replies on retry
    let bAttempt = 0
    sessions[0]!.onPrompt = async (text) => {
      bAttempt++
      if (bAttempt === 1) {
        sessions[0]!.setAssistantMidTurn('thought-loop output that must not be posted', 'length')
        return
      }
      expect(text).toContain(EMPTY_TURN_RETRY_NUDGE)
      sessions[0]!.setAssistantText('B')
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'here you go' })
    }
    await router.route(inbound({ text: 'please apply that fix to the staging cluster now.' }))
    await router.__testing!.flushDebounce(KEY)

    sessions[0]!.thinkingLevels.length = 0

    // turn C — a real question; predecessor is B (non-question) → no escalation
    sessions[0]!.onPrompt = async () => {
      sessions[0]!.setAssistantText('C')
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'sure' })
    }
    await router.route(inbound({ text: 'and how do i roll it back if it breaks again?' }))
    await router.__testing!.flushDebounce(KEY)

    // then: turn C did not escalate (no xhigh) — B overwrote A's question signal.
    expect(sessions[0]!.thinkingLevels).not.toContain('xhigh')
  })

  test('cross-turn escalation: a provider-error question turn does not seed the next turn', async () => {
    // given: turn A is a question whose leaf is a provider `error` (diverted to
    // the error notice, no retry queued); turn B is a question. The failed turn A
    // must not commit its question signal, so B has no question predecessor and
    // must NOT mode-3 escalate.
    const dir = await tempDir()
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    // turn A — a question that ends on a provider error
    await router.route(inbound({ text: 'why did the deployment fail on the staging cluster?' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantMessage({
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'transient upstream blip',
      } as unknown as Parameters<FakeSession['setAssistantMessage']>[0])
    }
    await router.__testing!.flushDebounce(KEY)

    sessions[0]!.thinkingLevels.length = 0

    // turn B — a question; predecessor A failed, so no escalation
    sessions[0]!.onPrompt = async () => {
      sessions[0]!.setAssistantText('B')
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'here you go' })
    }
    await router.route(inbound({ text: 'and how do i actually fix it properly now?' }))
    await router.__testing!.flushDebounce(KEY)

    // then: turn B did not escalate — A's failed question signal was dropped.
    expect(sessions[0]!.thinkingLevels).not.toContain('xhigh')
  })

  test('cross-turn escalation: a retry-exhausted fallback question turn does not seed the next turn', async () => {
    // given: turn A is a question that length-truncates on every attempt until
    // retries are exhausted and the fallback is posted (no usable reply); turn B
    // is a question. The fallback turn must not commit A's question signal, so B
    // has no question predecessor and must NOT mode-3 escalate.
    const dir = await tempDir()
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    // turn A — a question that always truncates → retries exhausted → fallback
    await router.route(inbound({ text: 'why did the deployment fail on the staging cluster?' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantMidTurn('never-ending loop output', 'length')
    }
    await router.__testing!.flushDebounce(KEY)
    expect(sent.map((s) => s.text)).toEqual([EMPTY_TURN_FALLBACK_TEXT])

    sessions[0]!.thinkingLevels.length = 0

    // turn B — a question; predecessor A only produced a fallback → no escalation
    sessions[0]!.onPrompt = async () => {
      sessions[0]!.setAssistantText('B')
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'here you go' })
    }
    await router.route(inbound({ text: 'and how do i actually fix it properly now?' }))
    await router.__testing!.flushDebounce(KEY)

    // then: turn B did not escalate — A's fallback turn never seeded the signal.
    expect(sessions[0]!.thinkingLevels).not.toContain('xhigh')
  })

  test('cross-turn escalation: a NO_REPLY question turn does not seed the next turn', async () => {
    // given: turn A is a question the agent deliberately stays silent on
    // (NO_REPLY — a completed but non-usable turn); turn B is a question. A
    // silent turn produced no usable reply, so it must not seed escalation.
    const dir = await tempDir()
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    // turn A — a question the agent answers with NO_REPLY (no send)
    await router.route(inbound({ text: 'why did the deployment fail on the staging cluster?' }))
    sessions[0]!.onPrompt = () => sessions[0]!.setAssistantText('NO_REPLY')
    await router.__testing!.flushDebounce(KEY)

    sessions[0]!.thinkingLevels.length = 0

    // turn B — a question; predecessor A was silent → no escalation
    sessions[0]!.onPrompt = async () => {
      sessions[0]!.setAssistantText('B')
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'here you go' })
    }
    await router.route(inbound({ text: 'and how do i actually fix it properly now?' }))
    await router.__testing!.flushDebounce(KEY)

    // then: turn B did not escalate — a NO_REPLY turn does not seed the signal.
    expect(sessions[0]!.thinkingLevels).not.toContain('xhigh')
  })

  test('cross-turn escalation: a failed middle turn clears a previously seeded question signal', async () => {
    // given: clean question A seeds the prior signal; failed question B (provider
    // error) sits between; question C follows. C must NOT escalate from A — the
    // failed turn B must CLEAR the prior signal, not merely skip committing, so a
    // stale question cannot leak across the failed logical turn.
    const dir = await tempDir()
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    // turn A — a question, clean reply (seeds the signal)
    await router.route(inbound({ text: 'why did the deployment fail on the staging cluster?' }))
    sessions[0]!.onPrompt = async () => {
      sessions[0]!.setAssistantText('A')
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'because of X' })
    }
    await router.__testing!.flushDebounce(KEY)

    // turn B — a question that fails with a provider error (clears the signal)
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantMessage({
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'transient upstream blip',
      } as unknown as Parameters<FakeSession['setAssistantMessage']>[0])
    }
    await router.route(inbound({ text: 'is the rollback even possible right now?' }))
    await router.__testing!.flushDebounce(KEY)

    sessions[0]!.thinkingLevels.length = 0

    // turn C — a question; A's signal was cleared by B, so no escalation
    sessions[0]!.onPrompt = async () => {
      sessions[0]!.setAssistantText('C')
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'sure' })
    }
    await router.route(inbound({ text: 'and how do i actually fix it properly now?' }))
    await router.__testing!.flushDebounce(KEY)

    // then: turn C did not escalate — B cleared A's signal (no stale leak).
    expect(sessions[0]!.thinkingLevels).not.toContain('xhigh')
  })

  test('empty-turn guard: pure reasoning-loop posts the fallback after retries are exhausted', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'ambiguous thing' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantMidTurn('never-ending loop output', 'length')
    }
    await router.__testing!.flushDebounce(KEY)

    // 1 original prompt + MAX_EMPTY_TURN_RETRIES retry prompts.
    expect(sessions[0]!.prompts).toHaveLength(1 + MAX_EMPTY_TURN_RETRIES)
    expect(sent.map((s) => s.text)).toEqual([EMPTY_TURN_FALLBACK_TEXT])
    expect(logs.some((m) => m.includes(`empty_turn_retry attempt=${MAX_EMPTY_TURN_RETRIES}`))).toBe(true)
    expect(logs.some((m) => m.includes('empty_turn_fallback cause=retries_exhausted'))).toBe(true)
  })

  test('empty-turn guard: a length-truncated retry raises the output-token budget for the re-prompt', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'ambiguous thing' }))
    const budgetsPerPrompt: Array<number | undefined> = []
    let attempt = 0
    sessions[0]!.onPrompt = async () => {
      attempt++
      // Simulate the real session streaming under the installed output cap:
      // every prompt makes a stream call whose maxTokens the cap fills in.
      await streamOnce(sessions[0]!)
      budgetsPerPrompt.push(sessions[0]!.lastStreamMaxTokens)
      if (attempt === 1) {
        // First turn burns its budget reasoning and truncates with no prose.
        sessions[0]!.setAssistantMidTurn('thought-loop output that must not be posted', 'length')
        return
      }
      // The raised-budget retry lets the model finish and reply.
      sessions[0]!.setAssistantText('SENT')
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'here is your answer' })
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(2)
    // Original turn uses the default backstop; the length-retry re-prompt uses
    // the raised budget so genuine reasoning has room to finish.
    expect(budgetsPerPrompt[0]).toBe(CHANNEL_MAX_OUTPUT_TOKENS)
    expect(budgetsPerPrompt[1]).toBe(CHANNEL_EMPTY_TURN_RETRY_MAX_OUTPUT_TOKENS)
    expect(sent.map((s) => s.text)).toEqual(['here is your answer'])
    expect(sent.some((s) => s.text === EMPTY_TURN_FALLBACK_TEXT)).toBe(false)
  })

  test('empty-turn guard: the raised retry budget does not leak into the next fresh user turn', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound({ text: 'ambiguous thing' }))
    let attempt = 0
    sessions[0]!.onPrompt = async () => {
      attempt++
      await streamOnce(sessions[0]!)
      if (attempt < 1 + MAX_EMPTY_TURN_RETRIES) {
        sessions[0]!.setAssistantMidTurn('thought-loop output', 'length')
        return
      }
      // Final retry also truncates → fallback; budget stays raised this turn.
      sessions[0]!.setAssistantMidTurn('thought-loop output', 'length')
    }
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.lastStreamMaxTokens).toBe(CHANNEL_EMPTY_TURN_RETRY_MAX_OUTPUT_TOKENS)

    // A brand-new user turn must reset back to the default backstop.
    sessions[0]!.onPrompt = async () => {
      await streamOnce(sessions[0]!)
      sessions[0]!.setAssistantText('ok')
    }
    await router.route(inbound({ text: 'fresh question' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.lastStreamMaxTokens).toBe(CHANNEL_MAX_OUTPUT_TOKENS)
  })

  test('length-leaf recovery: strips leaked think blocks and posts the surviving answer (no retry)', async () => {
    // Regression for the production silent-drop (2026-06-12): a channel turn hit
    // the output cap after interleaving leaked `<think>` reasoning with a
    // complete final answer; the old recoverableAssistantText threw it all away
    // as an unrecoverable 'length' leaf and the turn fell silent.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'ask something hard' }))
    sessions[0]!.onPrompt = async () => {
      sessions[0]!.setAssistantLengthLeaf('<think>long reasoning</think>', '\n\nHere is the real answer.')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sent.map((s) => s.text)).toEqual(['Here is the real answer.'])
    expect(logs.some((m) => m.includes('empty_turn_retry'))).toBe(false)
    expect(logs.some((m) => m.includes('empty_turn_fallback'))).toBe(false)
  })

  test('length-leaf recovery: a think-only length leaf retries with the raised budget (nothing to post)', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'ask something hard' }))
    let attempt = 0
    sessions[0]!.onPrompt = async () => {
      attempt++
      await streamOnce(sessions[0]!)
      if (attempt === 1) {
        // Pure leaked reasoning, no answer after stripping → must retry, not post.
        sessions[0]!.setAssistantLengthLeaf('<think>never-ending reasoning</think>')
        return
      }
      sessions[0]!.setAssistantText('recovered answer')
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'recovered answer' })
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(2)
    expect(sent.map((s) => s.text)).toEqual(['recovered answer'])
    expect(logs.some((m) => m.includes('empty_turn_retry attempt=1'))).toBe(true)
    expect(sessions[0]!.lastStreamMaxTokens).toBe(CHANNEL_EMPTY_TURN_RETRY_MAX_OUTPUT_TOKENS)
  })

  test('length-leaf recovery: plain length text with NO think evidence stays on the retry path (not posted)', async () => {
    // A truncated 'length' leaf with no `<think>` span is genuinely ambiguous
    // (possibly a broken partial), so it keeps the historical retry behavior
    // rather than posting raw truncated output.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'ask something hard' }))
    sessions[0]!.onPrompt = async () => {
      sessions[0]!.setAssistantLengthLeaf('plain truncated output with no think tags')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent.some((s) => s.text === 'plain truncated output with no think tags')).toBe(false)
    expect(logs.some((m) => m.includes('empty_turn_retry'))).toBe(true)
  })

  test("empty-turn guard: an 'aborted' truncation retries under the DEFAULT cap, not the raised budget", async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound({ text: 'ambiguous thing' }))
    const budgetsPerPrompt: Array<number | undefined> = []
    sessions[0]!.onPrompt = async () => {
      await streamOnce(sessions[0]!)
      budgetsPerPrompt.push(sessions[0]!.lastStreamMaxTokens)
      // `aborted` is the terminal-reply abort, not budget exhaustion, so the
      // raised reasoning budget is unjustified — the retry must stay on the
      // default backstop. (`error` no longer reaches the retry path at all: it
      // diverts to the provider-error notice, covered by its own tests.)
      sessions[0]!.setAssistantMidTurn('truncated output', 'aborted')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(budgetsPerPrompt.every((b) => b === CHANNEL_MAX_OUTPUT_TOKENS)).toBe(true)
    expect(logs.some((m) => m.includes('empty_turn_retry'))).toBe(true)
    expect(logs.some((m) => m.includes(`max_tokens=${CHANNEL_EMPTY_TURN_RETRY_MAX_OUTPUT_TOKENS}`))).toBe(false)
  })

  test('empty-turn guard: skip-locked send thrash stays silent (no fallback) — the model chose silence', async () => {
    // Regression for the production false alarm (thread 1780845903.114339): the
    // model called skip_response (committing to silence), then tried channel_reply
    // anyway. Each send was denied skip-locked; past the cap the run aborted with
    // no recoverable prose (the reply text was a denied tool ARG). The old guard
    // posted "I got stuck putting together a reply…" — a misleading system-failure
    // message for what is the model's own silence decision. Honor the skip: stay
    // silent, log skip_locked_send_thrash_suppressed for production signal.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'say something' }))
    sessions[0]!.onPrompt = async () => {
      router.markTurnSkipped({ parentSessionId: 'ses_fake_1', reason: 'changed my mind' })
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'denied attempt' })
      sessions[0]!.setAssistantMidTurn('stranded loop output', 'length')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('empty_turn_retry'))).toBe(false)
    expect(logs.some((m) => m.includes('empty_turn_fallback'))).toBe(false)
    expect(logs.some((m) => m.includes('skip_locked_send_thrash_suppressed'))).toBe(true)
  })

  test('empty-turn guard: duplicate-loop thrash WITHOUT skip_response does not reach the fallback (a real send landed)', async () => {
    // The non-skip thrash counterpart. A duplicate/turn-cap denial can only
    // accumulate AFTER a send actually landed (the dup-guard reads lastSentText,
    // which is only set by a delivered send; turn-cap needs the full quota first).
    // That successful send makes validateChannelTurn exit early — so the suppression
    // change cannot strand this path, and it never emitted the skip-only fallback.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'say something' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'first' })
      let i = 0
      while (!sessions[0]!.agent.signal.aborted && i < 100) {
        await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'first' })
        i++
      }
      sessions[0]!.setAssistantMidTurn('stranded loop output', 'length')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent.map((s) => s.text)).toEqual(['first'])
    expect(logs.some((m) => m.includes('empty_turn_fallback'))).toBe(false)
    expect(logs.some((m) => m.includes('skip_locked_send_thrash_suppressed'))).toBe(false)
  })

  test('mid-turn recovery: does NOT fire when the model successfully replied (channel send happened)', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'say hi' }))
    sessions[0]!.onPrompt = async () => {
      sessions[0]!.setAssistantMidTurn('narration that should not be recovered')
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'real reply' })
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('real reply')
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  test('leaf recovery: DOES fire when a progress reply landed but the final answer ended as plain prose', async () => {
    // The production bug: a `continue: true` progress reply lands, the model
    // keeps working, then ENDS the turn with its conclusion as plain assistant
    // text (a `stopReason: 'stop'` leaf) and never calls a channel tool again.
    // The conclusion must be recovered and delivered, not dropped.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'fix the tunnel' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'On it — checking now.' })
      sessions[0]!.setAssistantText('Fixed — you will need a restart for it to take effect.')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent.map((s) => s.text)).toEqual([
      'On it — checking now.',
      'Fixed — you will need a restart for it to take effect.',
    ])
    expect(
      logs.some((m) => m.includes('recovering assistant_text_without_channel_tool') && m.includes('source=leaf')),
    ).toBe(true)
  })

  test('leaf recovery: does NOT re-post when the trailing leaf duplicates the reply already sent', async () => {
    // The model called channel_reply (recorded in lastSentText) and the same
    // text is the `stop` leaf. Recovery must not echo a byte-identical re-post,
    // even though the `source:'system'` recovery send bypasses send()'s dup guard.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'status?' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'All good, nothing to do.' })
      sessions[0]!.setAssistantText('All good, nothing to do.')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent.map((s) => s.text)).toEqual(['All good, nothing to do.'])
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  test('leaf recovery after a send: still honors NO_REPLY on the trailing leaf', async () => {
    // The recovered leaf flows through the shared guards: a NO_REPLY conclusion
    // after a real progress reply must stay silent, not get posted.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'anything else?' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'Done.' })
      sessions[0]!.setAssistantText('Nothing more to add. NO_REPLY')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent.map((s) => s.text)).toEqual(['Done.'])
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
    expect(logs.some((m) => m.includes('no_reply'))).toBe(true)
  })

  test('leaf recovery: does NOT re-post when a leaked tool-call leaf EXTRACTS to the reply already sent', async () => {
    // The dedupe must run on the FINAL outbound body, after plain-text-tool-call
    // extraction. A turn sends `Done.`, then ends with a fresh leaked
    // `channel_reply({"text":"Done."})` leaf: the raw leaf differs from `Done.`,
    // but its extracted body equals the reply already sent — must not re-post.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'status?' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'Done.' })
      sessions[0]!.setAssistantText('channel_reply({"text":"Done."})')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent.map((s) => s.text)).toEqual(['Done.'])
    expect(logs.some((m) => m.includes('suppressed recovery (duplicate'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  test('leaf recovery: DOES recover a leaked tool-call leaf whose extracted body is NOT a duplicate', async () => {
    // Guard against over-suppression: a leaked `channel_reply({...})` leaf whose
    // extracted body differs from the sent reply is a real undelivered answer.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'status?' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'Checking now.' })
      sessions[0]!.setAssistantText('channel_reply({"text":"All fixed — restart needed."})')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent.map((s) => s.text)).toEqual(['Checking now.', 'All fixed — restart needed.'])
    expect(logs.some((m) => m.includes('recovered plain_text_channel_tool_call kind=reply'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(true)
  })

  test('logs recovery send failures without crashing the drain loop', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: false, error: 'denied by adapter' }))

    await router.route(inbound({ text: 'say hi' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('hi from invisible assistant text')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(logs.some((m) => m.includes('recovery send failed: denied by adapter'))).toBe(true)
    expect(logs.some((m) => m.includes('prompt threw'))).toBe(false)
  })

  test('does not block visible assistant text after a successful channel send', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound({ text: 'say hi' }))
    sessions[0]!.onPrompt = async () => {
      sessions[0]!.setAssistantText('SENT')
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hi' })
    }
    await router.__testing!.flushDebounce(KEY)

    expect(logs.some((m) => m.includes('blocked assistant_text_without_channel_tool'))).toBe(false)
  })

  // Regression for the Kimi-on-Fireworks `kimi-k2p6-turbo` channel-silence
  // bug observed on 2026-05-26: the model emitted text + a tool call
  // (stopReason='toolUse'), the tool ran successfully, but the upstream
  // pi-agent-core loop never produced a follow-up assistant message after
  // the toolResult. The session JSONL ended with the toolResult as the leaf,
  // `prompt()` resolved cleanly, and the channel router silently dropped the
  // pre-tool commentary. User saw nothing in Discord.
  test('pre-tool recovery: recovers assistant text when leaf is toolResult with no follow-up', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'why is cron not working' }))
    sessions[0]!.onPrompt = () => {
      // given: an assistant message with text + a tool call. The model never
      // produced a follow-up assistant message after the tool result, so the
      // leaf is the toolResult, NOT the assistant message.
      const assistantMsg: AssistantMessage = {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sorry about that. I will look into the cron issue right now.' },
          { type: 'toolCall', id: 'functions.stream_snapshot:0', name: 'stream_snapshot', arguments: { limit: 20 } },
        ],
        api: 'openai-completions',
        provider: 'fireworks',
        model: 'accounts/fireworks/routers/kimi-k2p6-turbo',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 1000,
      }
      const assistantEntry: SessionEntry = {
        type: 'message',
        id: 'assistant-pre-tool',
        parentId: null,
        timestamp: '2026-05-26T04:13:13.000Z',
        message: assistantMsg,
      }
      const toolResultEntry: SessionEntry = {
        type: 'message',
        id: 'tool-result',
        parentId: 'assistant-pre-tool',
        timestamp: '2026-05-26T04:13:16.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'functions.stream_snapshot:0',
          toolName: 'stream_snapshot',
          content: [{ type: 'text', text: 'stream events here' }],
          isError: false,
          timestamp: 1000,
        },
      }
      sessions[0]!.entriesById.set(assistantEntry.id, assistantEntry)
      sessions[0]!.entriesById.set(toolResultEntry.id, toolResultEntry)
      sessions[0]!.leafEntry = toolResultEntry
    }
    await router.__testing!.flushDebounce(KEY)

    expect(
      logs.some((m) => m.includes('recovering assistant_text_without_channel_tool') && m.includes('source=pre-tool')),
    ).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('Sorry about that. I will look into the cron issue right now.')
  })

  test('pre-tool recovery: still applies NO_REPLY / Kimi-leak / empty-sentinel guards', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'check something' }))
    sessions[0]!.onPrompt = () => {
      // given: an assistant message with NO_REPLY text + a tool call. The
      // pre-tool recovery should NOT send this, because the assistant
      // explicitly opted out of replying. The downstream guards must still
      // run on the recovered text.
      const assistantMsg: AssistantMessage = {
        role: 'assistant',
        content: [
          { type: 'text', text: 'NO_REPLY' },
          { type: 'toolCall', id: 't0', name: 'stream_snapshot', arguments: {} },
        ],
        api: 'openai-completions',
        provider: 'fireworks',
        model: 'test',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 1000,
      }
      const assistantEntry: SessionEntry = {
        type: 'message',
        id: 'a',
        parentId: null,
        timestamp: '2026-05-26T04:13:13.000Z',
        message: assistantMsg,
      }
      const toolResultEntry: SessionEntry = {
        type: 'message',
        id: 'tr',
        parentId: 'a',
        timestamp: '2026-05-26T04:13:16.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 't0',
          toolName: 'stream_snapshot',
          content: [{ type: 'text', text: 'x' }],
          isError: false,
          timestamp: 1000,
        },
      }
      sessions[0]!.entriesById.set(assistantEntry.id, assistantEntry)
      sessions[0]!.entriesById.set(toolResultEntry.id, toolResultEntry)
      sessions[0]!.leafEntry = toolResultEntry
    }
    await router.__testing!.flushDebounce(KEY)

    expect(logs.some((m) => m.includes('no_reply'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
    expect(sent).toHaveLength(0)
  })

  test('pre-tool recovery: does NOT fire when the model successfully replied (channel send happened)', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'reply please' }))
    sessions[0]!.onPrompt = async () => {
      // Successful channel send during the turn — guard #1
      // (successfulChannelSends > before) must short-circuit recovery before
      // the leaf is even inspected. We do NOT need to set leafEntry; the
      // first guard returns before it's consulted.
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'real reply' })
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toBe('real reply')
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  // Regression for the "I'll check right now" → silence bug (Discord channel,
  // 2026-06-15). The model posted a `continue: true` status reply ("지금 바로
  // 확인할게"), kept working through several tool calls, then its post-tool
  // follow-up stream was aborted before it could conclude. The session leaf was
  // a toolResult under an unanswered `stopReason: 'toolUse'` assistant carrying
  // NO visible prose (thinking + toolCall only), so pre-tool recovery had
  // nothing to post. Because a send had already landed this turn, the recovery
  // gate short-circuited and the turn ended silently — the promised follow-up
  // never ran and the user got dead air after the status reply. The fix:
  // re-prompt (empty-turn retry) so the model finishes the work it promised and
  // actually replies.
  test('continue-reply guard: re-prompts when the turn strands on an unanswered toolUse with no prose', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    const strandOnUnansweredToolUse = (): void => {
      // A toolUse assistant with ONLY thinking + a toolCall (no visible text),
      // whose post-tool follow-up never landed: leaf is the toolResult.
      const assistantMsg: AssistantMessage = {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Investigating cron behavior…' },
          { type: 'toolCall', id: 'functions.stream_snapshot:0', name: 'stream_snapshot', arguments: { limit: 20 } },
        ] as AssistantMessage['content'],
        api: 'openai-completions',
        provider: 'openai',
        model: 'gpt-5.5',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 1000,
      }
      const assistantEntry: SessionEntry = {
        type: 'message',
        id: 'assistant-strand',
        parentId: null,
        timestamp: '2026-06-15T06:23:45.000Z',
        message: assistantMsg,
      }
      const toolResultEntry: SessionEntry = {
        type: 'message',
        id: 'tool-result-strand',
        parentId: 'assistant-strand',
        timestamp: '2026-06-15T06:23:45.500Z',
        message: {
          role: 'toolResult',
          toolCallId: 'functions.stream_snapshot:0',
          toolName: 'stream_snapshot',
          content: [{ type: 'text', text: 'stream events here' }],
          isError: false,
          timestamp: 1000,
        },
      }
      sessions[0]!.entriesById.set(assistantEntry.id, assistantEntry)
      sessions[0]!.entriesById.set(toolResultEntry.id, toolResultEntry)
      sessions[0]!.leafEntry = toolResultEntry
    }

    await router.route(inbound({ text: '반영했어?' }))
    let attempt = 0
    sessions[0]!.onPrompt = async (text) => {
      attempt++
      if (attempt === 1) {
        // The status reply (the `continue: true` "I'll check now") lands as a
        // real send, then the turn strands on the unanswered toolUse.
        await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: '지금 바로 확인할게.' })
        strandOnUnansweredToolUse()
        return
      }
      // The retry re-prompts the same logical turn with the CONTINUATION nudge
      // (summarize what you already gathered), NOT the budget-exhaustion nudge
      // (which would invite a fresh investigation). The model then posts the
      // conclusion it promised and ends cleanly (the leaf is the reply).
      expect(text).toContain(STRANDED_TOOLUSE_CONTINUATION_NUDGE)
      expect(text).not.toContain(EMPTY_TURN_RETRY_NUDGE)
      await router.send({
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        text: 'cron.json은 비어 있고, 요약은 플러그인에서 와. 재시작해야 반영돼.',
      })
      sessions[0]!.setAssistantText('cron.json은 비어 있고, 요약은 플러그인에서 와. 재시작해야 반영돼.')
    }
    await router.__testing!.flushDebounce(KEY)

    // The turn must NOT end after the bare status reply: a re-prompt fires and
    // the real conclusion is delivered.
    expect(sessions[0]!.prompts).toHaveLength(2)
    expect(sent.map((s) => s.text)).toEqual([
      '지금 바로 확인할게.',
      'cron.json은 비어 있고, 요약은 플러그인에서 와. 재시작해야 반영돼.',
    ])
    expect(logs.some((m) => m.includes('empty_turn_retry attempt=1'))).toBe(true)
  })

  test('continue-reply guard: logs policy-denied abort provenance when retrying stranded toolUse', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'check it' }))
    let attempt = 0
    sessions[0]!.onPrompt = async (text) => {
      attempt++
      if (attempt === 1) {
        await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'checking now' })
        for (let i = 0; i < MAX_POLICY_DENIED_CHANNEL_SENDS_PER_TURN; i++) {
          await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'checking now' })
        }
        strandOnUnansweredToolUse(sessions[0]!, 'policy-denied')
        return
      }
      expect(text).toContain(STRANDED_TOOLUSE_CONTINUATION_NUDGE)
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'done' })
      sessions[0]!.setAssistantText('done')
    }
    await router.__testing!.flushDebounce(KEY)

    const retryLog = logs.find((m) => m.includes('empty_turn_retry') && m.includes('cause=stranded_toolUse_after_send'))
    expect(retryLog).toContain('abort_reason=policy_denied:duplicate')
    expect(sent.map((s) => s.text)).toEqual(['checking now', 'done'])
  })

  test('continue-reply guard: logs unknown abort provenance when no internal abort fired', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'check it' }))
    let attempt = 0
    sessions[0]!.onPrompt = async () => {
      attempt++
      if (attempt === 1) {
        await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'checking now' })
        strandOnUnansweredToolUse(sessions[0]!, 'unknown-abort-reason')
        return
      }
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'done' })
      sessions[0]!.setAssistantText('done')
    }
    await router.__testing!.flushDebounce(KEY)

    const retryLog = logs.find((m) => m.includes('empty_turn_retry') && m.includes('cause=stranded_toolUse_after_send'))
    expect(retryLog).toContain('abort_reason=unknown')
    expect(retryLog).not.toContain('policy_denied:')
    expect(sent.map((s) => s.text)).toEqual(['checking now', 'done'])
  })

  test('continue-reply guard: does NOT re-prompt when the trailing toolUse carries narration and a send landed', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'do the thing' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'real reply' })
      sessions[0]!.setAssistantMidTurn('narration that accompanied the reply')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sent.map((s) => s.text)).toEqual(['real reply'])
    expect(logs.some((m) => m.includes('empty_turn_retry'))).toBe(false)
  })

  test('continue-reply guard: posts the fallback when every retry re-strands until the budget is exhausted', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    const strandOnUnansweredToolUse = (seq: number): void => {
      const assistantMsg: AssistantMessage = {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: `t${seq}`, name: 'stream_snapshot', arguments: {} },
        ] as AssistantMessage['content'],
        api: 'openai-completions',
        provider: 'openai',
        model: 'gpt-5.5',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 1000,
      }
      const assistantEntry: SessionEntry = {
        type: 'message',
        id: `assistant-strand-${seq}`,
        parentId: null,
        timestamp: '2026-06-15T06:23:45.000Z',
        message: assistantMsg,
      }
      const toolResultEntry: SessionEntry = {
        type: 'message',
        id: `tool-result-strand-${seq}`,
        parentId: `assistant-strand-${seq}`,
        timestamp: '2026-06-15T06:23:45.500Z',
        message: {
          role: 'toolResult',
          toolCallId: `t${seq}`,
          toolName: 'stream_snapshot',
          content: [{ type: 'text', text: 'x' }],
          isError: false,
          timestamp: 1000,
        },
      }
      sessions[0]!.entriesById.set(assistantEntry.id, assistantEntry)
      sessions[0]!.entriesById.set(toolResultEntry.id, toolResultEntry)
      sessions[0]!.leafEntry = toolResultEntry
    }

    await router.route(inbound({ text: '반영했어?' }))
    let attempt = 0
    sessions[0]!.onPrompt = async () => {
      attempt++
      // Each retry posts a DISTINCT status (a duplicate would be send-deduped
      // and not count as a fresh send), then re-strands on the no-prose toolUse.
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: `확인 중… (${attempt})` })
      strandOnUnansweredToolUse(attempt)
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1 + MAX_EMPTY_TURN_RETRIES)
    expect(sent.filter((s) => s.text === EMPTY_TURN_FALLBACK_TEXT)).toHaveLength(1)
    expect(logs.some((m) => m.includes('empty_turn_fallback cause=stranded_toolUse_retries_exhausted'))).toBe(true)
  })

  test('silent-leaf observability: logs explicit reason instead of bailing silently', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      // No leaf entry at all — the previous behavior silently returned with
      // zero log output, making the silent-channel bug undiagnosable from
      // logs. Now there's an explicit info log naming the reason.
      sessions[0]!.leafEntry = undefined
    }
    await router.__testing!.flushDebounce(KEY)

    expect(logs.some((m) => m.includes('no recoverable assistant text in branch'))).toBe(true)
  })
})

describe('ChannelRouter consecutive-send accounting', () => {
  test('starts at 0 with no active session for the target', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(0)
  })

  test('increments per successful send to the session origin', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(0)
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'first' })
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(1)
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'second' })
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'third' })
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(3)
  })

  test('does not increment on failed delivery', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: false, error: 'nope' }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'fail' })
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(0)
  })

  test('does not increment for cross-post (no live session at target keyId)', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c-other', text: 'cross-post' })
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c-other' })).toBe(0)
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(0)
  })

  test('resets on the next user batch being drained into the model', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'a' })
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'b' })
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(2)

    await router.route(inbound({ externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(0)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'c' })
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(1)
  })

  test('keys per (chat:thread): different threads in the same chat count independently', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound({ thread: 't-A', externalMessageId: 'mA' }))
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A' })
    await router.route(inbound({ thread: 't-B', externalMessageId: 'mB' }))
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-B' })

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A', text: 'a1' })
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A', text: 'a2' })
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-B', text: 'b1' })

    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A' })).toBe(
      2,
    )
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-B' })).toBe(
      1,
    )
  })
})

describe('ChannelRouter duplicate-send guard', () => {
  test('first send delivers; second identical send is blocked with code=duplicate', async () => {
    const dir = await tempDir()
    let delivered = 0
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => {
      delivered++
      return { ok: true }
    })
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const first = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hello' })
    expect(first).toEqual({ ok: true })

    const second = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hello' })
    expect(second).toEqual({ ok: false, error: DUPLICATE_SEND_ERROR, code: 'duplicate' })
    expect(delivered).toBe(1)
  })

  test('lets a different body through after a recent dup', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'first' })
    const second = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'second' })
    expect(second).toEqual({ ok: true })
  })

  test('passes the adapter messageId/messageIds through to the send result', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true, messageId: 'm1', messageIds: ['m1', 'm2'] }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const result = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hello' })
    expect(result).toEqual({ ok: true, messageId: 'm1', messageIds: ['m1', 'm2'] })
  })

  test('omits messageId when the adapter does not report one', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const result = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hello' })
    expect(result).toEqual({ ok: true })
  })

  test('failed delivery does not reserve a dup slot — retry with same text succeeds', async () => {
    const dir = await tempDir()
    let attempts = 0
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => {
      attempts++
      return attempts === 1 ? { ok: false, error: 'transient' } : { ok: true }
    })
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const first = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'flaky' })
    expect(first.ok).toBe(false)
    const retry = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'flaky' })
    expect(retry).toEqual({ ok: true })
  })

  test('resets on the next user batch so across-turn repeats are not blocked', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    const a = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'yes I am here' })
    expect(a).toEqual({ ok: true })

    await router.route(inbound({ externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)
    const b = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'yes I am here' })
    expect(b).toEqual({ ok: true })
  })

  test('scopes per (chat:thread): same text to a different thread is not flagged', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound({ thread: 't-A', externalMessageId: 'mA' }))
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A' })
    await router.route(inbound({ thread: 't-B', externalMessageId: 'mB' }))
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-B' })

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A', text: 'shared' })
    const b = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      thread: 't-B',
      text: 'shared',
    })
    expect(b).toEqual({ ok: true })
  })

  test('attachments-only sends (text undefined) do not poison the dup tracker', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      attachments: [{ path: '/agent/file.png' }],
    })
    await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      attachments: [{ path: '/agent/file2.png' }],
    })
    // Both succeed; empty-string normalization means attachments-only never sets lastSentText.
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(2)
  })

  test('empty string text is normalized — does not block a follow-up empty-text send', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: '',
      attachments: [{ path: '/agent/a.png' }],
    })
    const second = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: '',
      attachments: [{ path: '/agent/b.png' }],
    })
    expect(second).toEqual({ ok: true })
  })

  test('parallel router.send for same text — only one delivers, the rest are duplicate-denied', async () => {
    const dir = await tempDir()
    let delivered = 0
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => {
      // simulate a tiny adapter latency so all 10 sends are in flight at the same time
      await new Promise((resolve) => setTimeout(resolve, 5))
      delivered++
      return { ok: true }
    })
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const N = 10
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'same-text' }),
      ),
    )
    const okCount = results.filter((r) => r.ok).length
    const dupCount = results.filter((r) => !r.ok && r.code === 'duplicate').length
    expect(okCount).toBe(1)
    expect(dupCount).toBe(N - 1)
    expect(delivered).toBe(1)
  })

  test('system-source send bypasses the duplicate guard (recovery path)', async () => {
    const dir = await tempDir()
    let delivered = 0
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => {
      delivered++
      return { ok: true }
    })
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hello' })
    const sys = await router.send(
      { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hello' },
      { source: 'system' },
    )
    expect(sys).toEqual({ ok: true })
    expect(delivered).toBe(2)
  })
})

describe('ChannelRouter outbound flood guard', () => {
  test('blocks repeated-character outbound text before adapter delivery', async () => {
    const dir = await tempDir()
    let delivered = 0
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => {
      delivered++
      return { ok: true }
    })
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const result = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'ㅋ'.repeat(500) })
    expect(result).toEqual({ ok: false, error: OUTBOUND_FLOOD_ERROR, code: 'outbound-flood' })
    expect(delivered).toBe(0)
  })

  test('does not pre-drop repeated-character inbound messages', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ text: 'ㅋ'.repeat(500) }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('ㅋ'.repeat(500))
  })

  test('allows a normal reply when only the quote anchor contains repeated-character inbound text', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1_000_000 }
    const sent: string[] = []
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(inbound({ text: 'ㅋ'.repeat(500), authorId: 'U_ALICE', authorName: 'Alice' }))
    nowRef.value += 100
    await router.route(
      inbound({
        isBotMention: false,
        externalMessageId: 'm-observed',
        authorId: 'bob',
        authorName: 'bob',
        text: 'also waiting',
      }),
    )
    await router.__testing!.flushDebounce(KEY)
    nowRef.value += 200

    const result = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'normal reply' })
    expect(result).toEqual({ ok: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('normal reply')
  })
})

describe('ChannelRouter per-turn send cap', () => {
  test('blocks the (cap+1)th tool send with code=turn-cap', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    for (let i = 0; i < MAX_CHANNEL_SENDS_PER_TURN; i++) {
      const r = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: `msg-${i}` })
      expect(r).toEqual({ ok: true })
    }
    const overflow = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: `msg-${MAX_CHANNEL_SENDS_PER_TURN}`,
    })
    expect(overflow).toEqual({ ok: false, error: TURN_CAP_ERROR, code: 'turn-cap' })
  })

  test('cap resets on the next user batch', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    for (let i = 0; i < MAX_CHANNEL_SENDS_PER_TURN; i++) {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: `pre-${i}` })
    }
    await router.route(inbound({ externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)

    const fresh = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'post' })
    expect(fresh).toEqual({ ok: true })
  })

  test('system-source bypasses the cap', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    for (let i = 0; i < MAX_CHANNEL_SENDS_PER_TURN; i++) {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: `t-${i}` })
    }
    const sys = await router.send(
      { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'recovery' },
      { source: 'system' },
    )
    expect(sys).toEqual({ ok: true })
  })

  test('parallel router.send for distinct text — at most cap deliveries; the rest turn-capped', async () => {
    const dir = await tempDir()
    let delivered = 0
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      delivered++
      return { ok: true }
    })
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const N = MAX_CHANNEL_SENDS_PER_TURN + 5
    const results = await Promise.all(
      Array.from({ length: N }, (_v, i) =>
        router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: `distinct-${i}` }),
      ),
    )
    const okCount = results.filter((r) => r.ok).length
    const capCount = results.filter((r) => !r.ok && r.code === 'turn-cap').length
    expect(okCount).toBe(MAX_CHANNEL_SENDS_PER_TURN)
    expect(capCount).toBe(N - MAX_CHANNEL_SENDS_PER_TURN)
    expect(delivered).toBe(MAX_CHANNEL_SENDS_PER_TURN)
  })
})

describe('ChannelRouter getSendRate', () => {
  test('reports zero with no active session for the target', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    expect(router.getSendRate({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toEqual({
      count: 0,
      windowMs: SEND_RATE_WINDOW_MS,
    })
  })

  test('counts every send inside the rolling window', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'a' })
    nowRef.value += 100
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'b' })
    nowRef.value += 100
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'c' })
    expect(router.getSendRate({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' }).count).toBe(3)
  })

  test('prunes timestamps older than the window on every read', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'a' })
    nowRef.value += SEND_RATE_WINDOW_MS + 1
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'b' })
    expect(router.getSendRate({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' }).count).toBe(1)
  })

  test('survives turn boundaries: rate is wall-clock, not turn-clock', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'a' })
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'b' })
    expect(router.getSendRate({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' }).count).toBe(2)

    nowRef.value += 500
    await router.route(inbound({ externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)
    expect(router.getSendRate({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' }).count).toBe(2)
  })

  test('scopes per (chat:thread): different threads count independently', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound({ thread: 't-A', externalMessageId: 'mA' }))
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A' })
    await router.route(inbound({ thread: 't-B', externalMessageId: 'mB' }))
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-B' })

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A', text: 'a1' })
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A', text: 'a2' })
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-B', text: 'b1' })

    expect(router.getSendRate({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A' }).count).toBe(2)
    expect(router.getSendRate({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-B' }).count).toBe(1)
  })

  test('emits a structured per-send log line for every successful send', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hello' })

    const sendLog = logs.find((m) => m.includes('[channels]') && m.includes(': send source='))
    expect(sendLog).toBeDefined()
    expect(sendLog).toContain('source=tool')
    expect(sendLog).toContain('turn=1')
    expect(sendLog).toContain('rate=1/')
    expect(sendLog).toContain('text_len=5')
  })

  test('flags a burst with send_rate_warning once rate crosses the warn threshold', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const { router } = makeRouter(dir, { nowRef, logs })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    for (let i = 0; i < SEND_RATE_WARN_THRESHOLD - 1; i++) {
      nowRef.value += 50
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: `pre-${i}` })
    }
    expect(logs.some((m) => m.includes('send_rate_warning'))).toBe(false)

    nowRef.value += 50
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'burst' })

    const warn = logs.find((m) => m.startsWith('warn:') && m.includes('send_rate_warning'))
    expect(warn).toBeDefined()
    expect(warn).toContain(`rate=${SEND_RATE_WARN_THRESHOLD}/${SEND_RATE_WINDOW_MS}ms`)
  })

  test('system-source sends are logged with source=system', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'recovery' }, { source: 'system' })
    const sysLog = logs.find((m) => m.includes(': send source=system'))
    expect(sysLog).toBeDefined()
  })
})

describe('ChannelRouter cross-tool sharing', () => {
  test('first send via channel_reply blocks a follow-up channel_send with the same text', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let delivered = 0
    router.registerOutbound('discord-bot', 'g1', async () => {
      delivered++
      return { ok: true }
    })
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const first = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'shared' })
    expect(first).toEqual({ ok: true })

    const second = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'shared' })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('duplicate')
    expect(delivered).toBe(1)
  })
})

describe('ChannelRouter stop', () => {
  test('aborts in-flight session and disposes', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)
    await router.stop()
    expect(sessions[0]!.aborted).toBe(1)
    expect(sessions[0]!.disposed).toBe(1)
    expect(router.liveCount()).toBe(0)
  })

  test('clears the typing heartbeat on stop', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const calls: number[] = []
    router.registerTyping('discord-bot', 'g1', async () => {
      calls.push(1)
    })
    await router.route(inbound())
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    await router.stop()
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })
})

describe('ChannelRouter commands', () => {
  test('/stop clears a queued channel turn before it reaches the agent', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ text: 'please do this' }))
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    await router.route(inbound({ text: '/stop', externalMessageId: 'm-stop' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.aborted).toBe(1)
    expect(sessions[0]!.prompts).toEqual([])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('/stop aborts an in-flight channel turn without prompting on the command text', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    let releasePrompt: (() => void) | undefined

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => sessions[0]!.prompts.length === 1)

    await router.route(inbound({ text: '/stop', externalMessageId: 'm-stop' }))
    releasePrompt!()
    await draining

    expect(sessions[0]!.aborted).toBe(1)
    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('long task')
  })

  test('unknown commands are consumed instead of sent as prompts', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ text: '/unknown arg' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions).toHaveLength(0)
  })

  test('/stop on a cold channel is consumed without creating a session', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ text: '/stop' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions).toHaveLength(0)
  })

  test('/help replies with the command list on a cold channel without creating a session', async () => {
    const dir = await tempDir()
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: '/help' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions).toHaveLength(0)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('/help')
    expect(sent[0]!.text).toContain('/stop')
  })
})

describe('ChannelRouter.executeCommand (native slash-command surface)', () => {
  test('stop on a live session aborts the in-flight turn', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    let releasePrompt: (() => void) | undefined

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => sessions[0]!.prompts.length === 1)

    const result = await router.executeCommand(KEY, 'stop', { invokerId: 'alice' })
    releasePrompt!()
    await draining

    expect(result).toEqual({ kind: 'handled', name: 'stop', reply: 'Stopped the current turn.' })
    expect(sessions[0]!.aborted).toBe(1)
  })

  test('stop on a queued (pre-drain) session clears the queue and aborts', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ text: 'queued' }))
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    const result = await router.executeCommand(KEY, 'stop', { invokerId: 'alice' })
    await router.__testing!.flushDebounce(KEY)

    expect(result).toEqual({ kind: 'handled', name: 'stop', reply: 'Stopped the current turn.' })
    expect(sessions[0]!.aborted).toBe(1)
    expect(sessions[0]!.prompts).toEqual([])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('stop on a cold channel returns no-live-session (no abort, no session created)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    const result = await router.executeCommand(KEY, 'stop', { invokerId: 'alice' })

    expect(result).toEqual({ kind: 'no-live-session' })
    expect(sessions).toHaveLength(0)
  })

  test('help on a cold channel returns the command list (no live session required)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    const result = await router.executeCommand(KEY, 'help', { invokerId: 'alice' })

    expect(result.kind).toBe('handled')
    expect(result.kind === 'handled' && result.reply).toContain('/help')
    expect(result.kind === 'handled' && result.reply).toContain('/stop')
    expect(sessions).toHaveLength(0)
  })

  test('unknown command returns unknown-command without touching session state', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ text: 'hi' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.aborted).toBe(0)

    const result = await router.executeCommand(KEY, 'nuke', { invokerId: 'alice' })

    expect(result).toEqual({ kind: 'unknown-command', name: 'nuke' })
    expect(sessions[0]!.aborted).toBe(0)
  })

  test('name lookup is case-insensitive (defensive — slash-command sources may send mixed case)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ text: 'hi' }))
    await router.__testing!.flushDebounce(KEY)
    const result = await router.executeCommand(KEY, 'STOP', { invokerId: 'alice' })

    expect(result).toEqual({ kind: 'handled', name: 'stop', reply: 'Stopped the current turn.' })
    expect(sessions[0]!.aborted).toBe(1)
  })

  test('invoker without channel.respond is permission-denied; session NOT aborted', async () => {
    const allowAliceOnly: PermissionService = {
      has: (origin) => origin !== undefined && origin.kind === 'channel' && origin.lastInboundAuthorId === 'alice',
      resolveRole: () => 'member',
      compareRoleSeverity: () => undefined,
      describe: () => ({ role: 'member', permissions: ['channel.respond'] }),
      replaceRoles: () => {},
    }
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir, { permissions: allowAliceOnly })

    await router.route(inbound({ text: 'hi', authorId: 'alice' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(1)

    const result = await router.executeCommand(KEY, 'stop', { invokerId: 'mallory' })

    expect(result).toEqual({ kind: 'permission-denied' })
    expect(sessions[0]!.aborted).toBe(0)
  })

  test('permission gate runs before live-session lookup so denied invokers cannot probe session presence', async () => {
    const denyAll: PermissionService = {
      has: () => false,
      resolveRole: () => 'guest',
      compareRoleSeverity: () => undefined,
      describe: () => ({ role: 'guest', permissions: [] }),
      replaceRoles: () => {},
    }
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir, { permissions: denyAll })

    const result = await router.executeCommand(KEY, 'stop', { invokerId: 'mallory' })

    expect(result).toEqual({ kind: 'permission-denied' })
    expect(sessions).toHaveLength(0)
  })

  test('falls back to a thread-keyed session when slash command carries thread:null (Slack)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ text: 'hi', thread: 'thr-1', isBotMention: true }))
    await router.__testing!.flushDebounce({ ...KEY, thread: 'thr-1' })

    const result = await router.executeCommand({ ...KEY, thread: null }, 'stop', { invokerId: 'alice' })

    expect(result).toEqual({ kind: 'handled', name: 'stop', reply: 'Stopped the current turn.' })
    expect(sessions[0]!.aborted).toBe(1)
  })

  test('exact key match wins over fallback when both apply', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ text: 'top-level' }))
    await router.__testing!.flushDebounce(KEY)
    await router.route(inbound({ text: 'in thread', thread: 'thr-1', isBotMention: true, externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce({ ...KEY, thread: 'thr-1' })

    const result = await router.executeCommand({ ...KEY, thread: null }, 'stop', { invokerId: 'alice' })

    expect(result).toEqual({ kind: 'handled', name: 'stop', reply: 'Stopped the current turn.' })
    expect(sessions[0]!.aborted).toBe(1)
    expect(sessions[1]!.aborted).toBe(0)
  })

  test('returns ambiguous when multiple thread-keyed sessions match the channel-level key', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ text: 'in thread 1', thread: 'thr-1', isBotMention: true, externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce({ ...KEY, thread: 'thr-1' })
    await router.route(inbound({ text: 'in thread 2', thread: 'thr-2', isBotMention: true, externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce({ ...KEY, thread: 'thr-2' })

    const result = await router.executeCommand({ ...KEY, thread: null }, 'stop', { invokerId: 'alice' })

    expect(result).toEqual({ kind: 'ambiguous', matchCount: 2 })
    expect(sessions[0]!.aborted).toBe(0)
    expect(sessions[1]!.aborted).toBe(0)
  })

  test('fallback ignores sessions in other chats (same workspace)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ text: 'hi', thread: 'thr-1', isBotMention: true }))
    await router.__testing!.flushDebounce({ ...KEY, thread: 'thr-1' })

    const result = await router.executeCommand({ ...KEY, chat: 'other-channel', thread: null }, 'stop', {
      invokerId: 'alice',
    })

    expect(result).toEqual({ kind: 'no-live-session' })
    expect(sessions[0]!.aborted).toBe(0)
  })

  test('fallback ignores sessions in other workspaces (same chat id)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ text: 'hi' }))
    await router.__testing!.flushDebounce(KEY)

    const result = await router.executeCommand({ ...KEY, workspace: 'other-workspace', thread: null }, 'stop', {
      invokerId: 'alice',
    })

    expect(result).toEqual({ kind: 'no-live-session' })
    expect(sessions[0]!.aborted).toBe(0)
  })
})

describe('ChannelRouter typing indicator', () => {
  test('does not fire typing for an observe-only inbound', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const calls: Array<{ chat: string }> = []
    router.registerTyping('discord-bot', 'g1', async (target) => {
      calls.push({ chat: target.chat })
    })
    // Prime with carol (mention) so alice's next plain message hits the
    // strict gate and observes (the test contract).
    await router.route(inbound({ isBotMention: true, authorId: 'carol', authorName: 'carol' }))
    await router.__testing!.flushDebounce(KEY)
    calls.length = 0
    await router.route(inbound({ isBotMention: false, text: 'unrelated' }))
    expect(calls).toHaveLength(0)
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('fires typing immediately when an engaged inbound arrives', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const calls: Array<{ chat: string; thread: string | null | undefined }> = []
    router.registerTyping('discord-bot', 'g1', async (target) => {
      calls.push({ chat: target.chat, thread: target.thread })
    })
    await router.route(inbound({ text: 'hi bot' }))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ chat: 'c1', thread: null })
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
  })

  test('repeats typing every heartbeat tick while still draining', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const calls: number[] = []
    router.registerTyping('discord-bot', 'g1', async () => {
      calls.push(1)
    })
    await router.route(inbound({ text: 'hi bot' }))
    expect(calls).toHaveLength(1)
    await router.__testing!.fireTypingHeartbeat(KEY)
    await router.__testing!.fireTypingHeartbeat(KEY)
    expect(calls).toHaveLength(3)
  })

  test('stops the heartbeat after drain completes', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerTyping('discord-bot', 'g1', async () => {})
    await router.route(inbound({ text: 'hi bot' }))
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    await router.__testing!.flushDebounce(KEY)
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('forwards thread id when the inbound is on a thread', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const calls: Array<{ chat: string; thread: string | null | undefined }> = []
    router.registerTyping('discord-bot', 'g1', async (target) => {
      calls.push({ chat: target.chat, thread: target.thread })
    })
    await router.route(inbound({ thread: 'thread-7', text: 'hi bot' }))
    expect(calls[0]).toEqual({ chat: 'c1', thread: 'thread-7' })
  })

  test('forwards typingThread for a flat DM while the session thread stays null', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const calls: Array<{ chat: string; thread: string | null | undefined; typingThread: string | undefined }> = []
    router.registerTyping('discord-bot', 'g1', async (target) => {
      calls.push({ chat: target.chat, thread: target.thread, typingThread: target.typingThread })
    })
    await router.route(inbound({ isDm: true, thread: null, typingThread: 'dm-ts-1', text: 'hi bot' }))
    expect(calls[0]).toEqual({ chat: 'c1', thread: null, typingThread: 'dm-ts-1' })
  })

  test('typing-callback rejection does not crash route', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerTyping('discord-bot', 'g1', async () => {
      throw new Error('discord 503')
    })
    await router.route(inbound({ text: 'hi bot' }))
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    await router.__testing!.flushDebounce(KEY)
  })

  test('fires nothing when no typing callback is registered', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    await router.route(inbound({ text: 'hi bot' }))
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    await router.__testing!.flushDebounce(KEY)
  })

  test('unregisterTyping prevents further heartbeats', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const calls: number[] = []
    const cb = async () => {
      calls.push(1)
    }
    router.registerTyping('discord-bot', 'g1', cb)
    await router.route(inbound({ text: 'hi bot' }))
    expect(calls).toHaveLength(1)
    router.unregisterTyping('discord-bot', 'g1', cb)
    await router.__testing!.fireTypingHeartbeat(KEY)
    expect(calls).toHaveLength(1)
  })

  test('fires phase=stop exactly once when drain completes (so adapters can clear)', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const phases: Array<'tick' | 'stop'> = []
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
    })
    // when
    await router.route(inbound({ text: 'hi bot' }))
    expect(phases).toEqual(['tick'])
    await router.__testing!.flushDebounce(KEY)
    // then
    expect(phases).toEqual(['tick', 'stop'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('awaits phase=stop when a turn is dropped without an outbound reply', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const phases: Array<'tick' | 'stop'> = []
    let releaseStop: (() => void) | undefined
    let flushResolved = false
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
      if (target.phase === 'stop') {
        await new Promise<void>((resolve) => {
          releaseStop = resolve
        })
      }
    })

    await router.route(inbound({ text: 'hi bot' }))
    const flushed = router.__testing!.flushDebounce(KEY).then(() => {
      flushResolved = true
    })
    await waitFor(() => releaseStop !== undefined)

    expect(flushResolved).toBe(false)
    expect(phases).toEqual(['tick', 'stop'])
    releaseStop!()
    await flushed
    expect(flushResolved).toBe(true)
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('a later teardown awaits a stop already started by the heartbeat interval', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    let releasePrompt: (() => void) | undefined
    let releaseStop: (() => void) | undefined
    let flushResolved = false
    router.registerTyping('discord-bot', 'g1', async (target) => {
      if (target.phase === 'stop') {
        await new Promise<void>((resolve) => {
          releaseStop = resolve
        })
      }
    })

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY).then(() => {
      flushResolved = true
    })
    await waitFor(() => releasePrompt !== undefined)
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS

    const interval = router.__testing!.fireTypingInterval(KEY)
    await waitFor(() => releaseStop !== undefined)

    expect(flushResolved).toBe(false)
    releasePrompt!()
    releaseStop!()
    await Promise.all([interval, draining])
    expect(flushResolved).toBe(true)
  })

  test('stops and clears typing after the max heartbeat window while a turn is still draining', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { nowRef, logs })
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
    })

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS

    await router.__testing!.fireTypingInterval(KEY)

    expect(phases).toEqual(['tick', 'stop'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
    expect(logs.some((m) => m.includes('typing indicator paused') && m.includes('prompt still in flight'))).toBe(true)

    releasePrompt!()
    await draining
    expect(phases).toEqual(['tick', 'stop'])
  })

  test('does not restart typing after timeout for a later inbound during the same in-flight turn', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    let promptCount = 0
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
    })

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      promptCount++
      if (promptCount > 1) return
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS
    await router.__testing!.fireTypingInterval(KEY)

    await router.route(inbound({ text: 'still there?', externalMessageId: 'm2' }))

    expect(phases).toEqual(['tick', 'stop'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)

    releasePrompt!()
    await draining
  })

  test('a successful mid-turn channel send keeps typing active so the agent can send again', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
    })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'done' })
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    expect(phases).toEqual(['tick', 'tick'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)

    releasePrompt!()
    await draining
    expect(phases).toEqual(['tick', 'tick', 'stop'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('typing heartbeat keeps ticking across two mid-turn channel sends', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
    })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'okay, checking' })
      await router.__testing!.fireTypingInterval(KEY)
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'here is what I got' })
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    expect(phases).toEqual(['tick', 'tick', 'tick', 'tick'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)

    releasePrompt!()
    await draining
    expect(phases).toEqual(['tick', 'tick', 'tick', 'tick', 'stop'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('a successful mid-turn send fires a fresh tick after the outbound completes', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const events: string[] = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', 'g1', async (target) => {
      events.push(`typing:${target.phase}`)
    })
    router.registerOutbound('discord-bot', 'g1', async () => {
      events.push('outbound:cb')
      return { ok: true }
    })

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'reply' })
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    expect(events).toEqual(['typing:tick', 'outbound:cb', 'typing:tick'])

    releasePrompt!()
    await draining
  })

  test('mid-turn re-arm tick is suppressed when the heartbeat was stopped during the outbound', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
    })
    router.registerOutbound('discord-bot', 'g1', async (_msg) => {
      // simulate teardown happening during the outbound: the heartbeat is
      // stopped after the adapter accepted the send but before send()
      // returns. The re-arm guard must suppress the post-send tick so we
      // don't resurrect typing.
      await router.__testing!.stopTyping(KEY)
      return { ok: true }
    })

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'reply' })
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    // initial route() tick + stopTyping's 'stop'. No extra 'tick' after the send.
    expect(phases).toEqual(['tick', 'stop'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)

    releasePrompt!()
    await draining
  })

  test('phase=stop carries the same chat/thread coordinates as ticks', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const stopTargets: Array<{ chat: string; thread: string | null | undefined }> = []
    router.registerTyping('discord-bot', 'g1', async (target) => {
      if (target.phase === 'stop') stopTargets.push({ chat: target.chat, thread: target.thread })
    })
    await router.route(inbound({ thread: 'thread-7', text: 'hi bot' }))
    await router.__testing!.flushDebounce({ ...KEY, thread: 'thread-7' })
    expect(stopTargets).toEqual([{ chat: 'c1', thread: 'thread-7' }])
  })

  test('tool_execution_end resets the heartbeat clock so a long but progressing prompt keeps typing alive', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { nowRef, logs })
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
    })

    await router.route(inbound({ text: 'long task' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    // given: time advances to the very edge of the cap, but a tool just finished
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS - 1
    sessions[0]!.emit({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'bash', result: 'ok', isError: false })
    // when: we now step past the original cap; the timer should NOT trip
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS + 100
    await router.__testing!.fireTypingInterval(KEY)

    // then: still active, still ticking, no cap warning logged
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    expect(phases.at(-1)).toBe('tick')
    expect(logs.some((m) => m.includes('typing indicator paused'))).toBe(false)

    releasePrompt!()
    await draining
  })

  test('a streamed text_delta resets the heartbeat clock so a long tool-less reply keeps typing alive', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { nowRef, logs })
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
    })

    await router.route(inbound({ text: 'write me a long essay' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    // given: the model is streaming text (no tools) right at the cap edge
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS - 1
    sessions[0]!.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } })
    // when: we step past the original cap; the timer must NOT trip
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS + 100
    await router.__testing!.fireTypingInterval(KEY)

    // then: still active, still ticking, no cap warning logged
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    expect(phases.at(-1)).toBe('tick')
    expect(logs.some((m) => m.includes('typing indicator paused'))).toBe(false)

    releasePrompt!()
    await draining
  })

  test('a streamed thinking_delta resets the heartbeat clock so a long thinking phase keeps typing alive', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { nowRef, logs })
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
    })

    await router.route(inbound({ text: 'reason about this hard problem' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    // given: the model is streaming extended thinking (no text, no tools) at the cap edge
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS - 1
    sessions[0]!.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } })
    // when: we step past the original cap; the timer must NOT trip
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS + 100
    await router.__testing!.fireTypingInterval(KEY)

    // then: still active, still ticking, no cap warning logged
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    expect(phases.at(-1)).toBe('tick')
    expect(logs.some((m) => m.includes('typing indicator paused'))).toBe(false)

    releasePrompt!()
    await draining
  })

  test('a message_update that is not a text/thinking delta does NOT reset the cap', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
    })

    await router.route(inbound({ text: 'tool-call only turn' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    // given: only a toolcall_delta arrives at the cap edge (not a signal of life)
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS - 1
    sessions[0]!.emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '{}' } })
    // when: we step past the cap
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS + 100
    await router.__testing!.fireTypingInterval(KEY)

    // then: the cap tripped — the toolcall_delta did not refresh it
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
    expect(phases).toEqual(['tick', 'stop'])

    releasePrompt!()
    await draining
  })

  test('cap still fires after MAX_TYPING_HEARTBEAT_MS of pure silence (no tool events)', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { nowRef, logs })
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
    })

    await router.route(inbound({ text: 'silent task' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS
    await router.__testing!.fireTypingInterval(KEY)

    expect(phases).toEqual(['tick', 'stop'])
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
    expect(logs.some((m) => m.includes('typing indicator paused') && m.includes('no activity'))).toBe(true)

    releasePrompt!()
    await draining
  })

  test('multiple tool_execution_end events repeatedly push the cap forward', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', 'g1', async () => {})

    await router.route(inbound({ text: 'multi-tool task' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    // given: three tools finish at the cap edge, one after another
    for (let i = 0; i < 3; i++) {
      nowRef.value += MAX_TYPING_HEARTBEAT_MS - 1
      sessions[0]!.emit({
        type: 'tool_execution_end',
        toolCallId: `c${i}`,
        toolName: 'bash',
        result: 'ok',
        isError: false,
      })
      await router.__testing!.fireTypingInterval(KEY)
      expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    }

    releasePrompt!()
    await draining
  })

  test('a streamed text_delta after the cap has tripped revives typing', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
    })

    await router.route(inbound({ text: 'silent then streaming' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    // given: a >2-min silent gap trips the cap and stops the heartbeat
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS
    await router.__testing!.fireTypingInterval(KEY)
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
    expect(phases).toEqual(['tick', 'stop'])

    // when: the model resumes streaming text after the timeout
    sessions[0]!.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'back' } })

    // then: the heartbeat is re-armed and a fresh tick fires
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    expect(phases).toEqual(['tick', 'stop', 'tick'])

    releasePrompt!()
    await draining
  })

  test('a tool_execution_end after the cap has tripped revives typing', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
    })

    await router.route(inbound({ text: 'long tool then resume' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    // given: a long tool call exceeds the cap and the heartbeat stops
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS
    await router.__testing!.fireTypingInterval(KEY)
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)

    // when: that tool finally finishes after the timeout
    sessions[0]!.emit({
      type: 'tool_execution_end',
      toolCallId: 'slow',
      toolName: 'bash',
      result: 'ok',
      isError: false,
    })

    // then: the heartbeat revives
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    expect(phases).toEqual(['tick', 'stop', 'tick'])

    releasePrompt!()
    await draining
  })

  test('revival defers the fresh tick until an in-flight stop clear settles', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    const phases: Array<'tick' | 'stop'> = []
    let releaseCapStop: (() => void) | undefined
    let releasePrompt: (() => void) | undefined
    let stopCount = 0
    // Block ONLY the cap-trip 'stop' so the revival race window stays open;
    // the turn-end 'stop' (after the prompt resolves) must pass through freely.
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
      if (target.phase === 'stop' && ++stopCount === 1) {
        await new Promise<void>((resolve) => {
          releaseCapStop = resolve
        })
      }
    })

    await router.route(inbound({ text: 'race' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    // given: the cap trips and the 'stop' clear is still in flight (blocked)
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS
    const interval = router.__testing!.fireTypingInterval(KEY)
    await waitFor(() => releaseCapStop !== undefined)
    expect(phases).toEqual(['tick', 'stop'])

    // when: deltas arrive while the stop clear has not yet completed
    sessions[0]!.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a' } })
    sessions[0]!.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'b' } })

    // then: no revived tick lands before the clear is released
    expect(phases).toEqual(['tick', 'stop'])

    // when: the stop clear finally settles
    releaseCapStop!()
    await waitFor(() => router.__testing!.isTypingActive(KEY))

    // then: exactly one revived tick fires (queued revivals collapse)
    expect(phases).toEqual(['tick', 'stop', 'tick'])

    releasePrompt!()
    await Promise.all([interval, draining])
  })

  test('a revival queued while the turn ends does NOT re-arm typing after the turn', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    const phases: Array<'tick' | 'stop'> = []
    let releaseCapStop: (() => void) | undefined
    let releasePrompt: (() => void) | undefined
    let stopCount = 0
    // Block ONLY the cap-trip 'stop' so a revival can be queued behind it while
    // the turn finishes; the turn-end 'stop' must pass through.
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
      if (target.phase === 'stop' && ++stopCount === 1) {
        await new Promise<void>((resolve) => {
          releaseCapStop = resolve
        })
      }
    })

    await router.route(inbound({ text: 'race then end' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    // given: the cap trips and its 'stop' clear is in flight (blocked)
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS
    const interval = router.__testing!.fireTypingInterval(KEY)
    await waitFor(() => releaseCapStop !== undefined)

    // given: a late delta queues a revival behind the still-blocked stop
    sessions[0]!.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'late' } })

    // when: the prompt completes (turn ends) while the stop is still blocked,
    // then the blocked stop is released so the queued revival can run
    releasePrompt!()
    releaseCapStop!()
    await Promise.all([interval, draining])

    // then: the queued revival is a no-op — no heartbeat is re-armed post-turn
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
    expect(phases).toEqual(['tick', 'stop'])
  })

  test('a revived heartbeat trips the cap again after another silent window', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { nowRef, logs })
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', 'g1', async (target) => {
      phases.push(target.phase)
    })

    await router.route(inbound({ text: 'silent, loud, silent' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    // given: the cap trips, then a delta revives the heartbeat
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS
    await router.__testing!.fireTypingInterval(KEY)
    sessions[0]!.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'back' } })
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)

    // when: another full silent window elapses with no activity
    nowRef.value += MAX_TYPING_HEARTBEAT_MS
    await router.__testing!.fireTypingInterval(KEY)

    // then: the cap trips again (silence detection preserved)
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
    expect(phases).toEqual(['tick', 'stop', 'tick', 'stop'])

    releasePrompt!()
    await draining
  })

  test('a fresh drain iteration after a long prior turn refreshes the cap clock', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    let releaseFirstPrompt: (() => void) | undefined
    let releaseSecondPrompt: (() => void) | undefined
    let promptCount = 0
    router.registerTyping('discord-bot', 'g1', async () => {})

    await router.route(inbound({ text: 'first' }))
    sessions[0]!.onPrompt = async () => {
      promptCount++
      if (promptCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstPrompt = resolve
        })
      } else {
        await new Promise<void>((resolve) => {
          releaseSecondPrompt = resolve
        })
      }
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releaseFirstPrompt !== undefined)

    // queue a second turn while the first is still in flight
    await router.route(inbound({ text: 'second', externalMessageId: 'm2' }))

    // advance most of the way through the cap, then complete the first turn
    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS - 1000
    releaseFirstPrompt!()
    await waitFor(() => releaseSecondPrompt !== undefined)

    // step past the ORIGINAL cap boundary; if we hadn't refreshed
    // typingStartedAt at the top of the second drain iteration, this
    // would have tripped the cap.
    nowRef.value += 2000
    await router.__testing!.fireTypingInterval(KEY)
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)

    releaseSecondPrompt!()
    await draining
  })
})

describe('ChannelRouter plugin lifecycle hooks', () => {
  function makeRouterWithHooks(
    agentDir: string,
    events: string[],
    options: { transcriptPath?: string } = {},
  ): { router: ChannelRouter; sessions: FakeSession[] } {
    const sessions: FakeSession[] = []
    const hooks: HookBus = {
      registerAll: () => {},
      unregisterAll: () => {},
      runSessionStart: async () => {},
      runSessionEnd: async (e) => {
        events.push(`end:${e.sessionId}`)
      },
      runSessionIdle: async (e) => {
        events.push(`idle:${e.sessionId}:${e.parentTranscriptPath ?? '-'}`)
      },
      runSessionPrompt: async () => {},
      runSessionTurnStart: async () => {},
      runSessionTurnEnd: async () => {},
      runToolBefore: async () => undefined,
      runToolAfter: async () => {},
      count: () => 0,
    }
    const router = createChannelRouter({
      agentDir,
      configForAdapter: () => baseConfig,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      createSessionForChannel: async () => {
        const fake = new FakeSession()
        sessions.push(fake)
        return {
          session: fake as unknown as AgentSession,
          sessionId: `ses_fake_${sessions.length}`,
          dispose: async () => {
            fake.dispose()
          },
          hooks,
          getTranscriptPath: () => options.transcriptPath,
        }
      },
    })
    return { router, sessions }
  }

  test('fires session.idle after each prompt completion with the transcript path', async () => {
    // given
    const dir = await tempDir()
    const events: string[] = []
    const { router, sessions } = makeRouterWithHooks(dir, events, { transcriptPath: '/tmp/t.jsonl' })

    // when
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(events).toEqual(['idle:ses_fake_1:/tmp/t.jsonl'])
  })

  test('passes current channel origin and participants to session.idle', async () => {
    // given
    const dir = await tempDir()
    const idleEvents: SessionIdleEvent[] = []
    const hooks: HookBus = {
      registerAll: () => {},
      unregisterAll: () => {},
      runSessionStart: async () => {},
      runSessionEnd: async () => {},
      runSessionIdle: async (e) => {
        idleEvents.push(e)
      },
      runSessionPrompt: async () => {},
      runSessionTurnStart: async () => {},
      runSessionTurnEnd: async () => {},
      runToolBefore: async () => undefined,
      runToolAfter: async () => {},
      count: () => 0,
    }
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      now: () => 5000,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      createSessionForChannel: async () => ({
        session: new FakeSession() as unknown as AgentSession,
        sessionId: 'ses_fake_1',
        dispose: async () => {},
        hooks,
        getTranscriptPath: () => '/tmp/t.jsonl',
      }),
    })

    // when
    await router.route(
      inbound({
        adapter: 'slack-bot',
        workspace: 'T123',
        chat: 'C456',
        thread: '171234.0001',
        authorId: 'U1',
        authorName: 'Neo',
      }),
    )
    await router.__testing!.flushDebounce({
      adapter: 'slack-bot',
      workspace: 'T123',
      chat: 'C456',
      thread: '171234.0001',
    })

    // then
    expect(idleEvents).toHaveLength(1)
    expect(idleEvents[0]!.origin).toEqual({
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T123',
      chat: 'C456',
      thread: '171234.0001',
      lastInboundAuthorId: 'U1',
      participants: [
        {
          authorId: 'U1',
          authorName: 'Neo',
          firstMessageAt: 5000,
          lastMessageAt: 5000,
          messageCount: 1,
          isBot: false,
        },
      ],
    })
  })

  test('fires session.idle even when prompt throws so plugins still wake up', async () => {
    // given
    const dir = await tempDir()
    const events: string[] = []
    const hooks: HookBus = {
      registerAll: () => {},
      unregisterAll: () => {},
      runSessionStart: async () => {},
      runSessionEnd: async (e) => {
        events.push(`end:${e.sessionId}`)
      },
      runSessionIdle: async (e) => {
        events.push(`idle:${e.sessionId}`)
      },
      runSessionPrompt: async () => {},
      runSessionTurnStart: async () => {},
      runSessionTurnEnd: async () => {},
      runToolBefore: async () => undefined,
      runToolAfter: async () => {},
      count: () => 0,
    }
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      createSessionForChannel: async () => {
        const fake = new FakeSession()
        fake.prompt = async () => {
          throw new Error('llm down')
        }
        return {
          session: fake as unknown as AgentSession,
          sessionId: 'ses_fake_throws',
          dispose: async () => {},
          hooks,
          getTranscriptPath: () => undefined,
        }
      },
    })

    // when
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(events).toEqual(['idle:ses_fake_throws'])
  })

  test('logs LLM soft errors (stopReason=error encoded in message_end) so `typeclaw logs` surfaces them', async () => {
    // given: a live session whose prompt() resolves normally but emits a
    // message_end with stopReason=error mid-turn — pi-coding-agent's
    // documented way of reporting billing/rate-limit failures without
    // throwing. Without the router subscribing, this would be invisible
    // (no reply to the channel, no entry in `typeclaw logs`).
    const dir = await tempDir()
    const errors: string[] = []
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
      createSessionForChannel: async () => {
        const fake = new FakeSession()
        fake.prompt = async (_text) => {
          fake.emit({
            type: 'message_end',
            message: {
              role: 'assistant',
              stopReason: 'error',
              errorMessage: 'billing not active',
            },
          })
        }
        return {
          session: fake as unknown as AgentSession,
          sessionId: 'ses_soft_err',
          dispose: async () => {},
          getTranscriptPath: () => undefined,
        }
      },
    })

    // when
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(errors.some((m) => /LLM call failed: billing not active/.test(m))).toBe(true)
  })

  test('posts a REDACTED LLM soft-error notice to the channel (raw provider text never leaks)', async () => {
    // given: a turn ending with stopReason=error whose raw provider text carries
    // potentially sensitive detail. Without surfacing it the channel sees silence
    // (the "why didn't Paul respond" failure mode); surfacing it RAW would leak
    // backend details into a public/multi-user channel. The router must post the
    // redacted safeMessage instead.
    const dir = await tempDir()
    const sent: string[] = []
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      createSessionForChannel: async () => {
        const fake = new FakeSession()
        fake.prompt = async (_text) => {
          fake.emit({
            type: 'message_end',
            message: {
              role: 'assistant',
              stopReason: 'error',
              errorMessage: 'You have hit your ChatGPT usage limit (team plan). Try again in ~40 min.',
            },
          })
        }
        return {
          session: fake as unknown as AgentSession,
          sessionId: 'ses_soft_err_posts',
          dispose: async () => {},
          getTranscriptPath: () => undefined,
        }
      },
    })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    // when
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(sent.some((t) => /rate-limited/i.test(t))).toBe(true)
    expect(sent.some((t) => /team plan/.test(t))).toBe(false)
  })

  test('posts the LLM soft-error notice ONCE per turn even when the SDK retries (PR #652)', async () => {
    // given: a single turn whose underlying SDK retries internally — each retry
    // emits its own message_end with stopReason=error. The channel must surface
    // one notice for the turn, not one per retry (PR #652 saw 5 duplicates).
    const dir = await tempDir()
    const sent: string[] = []
    let promptCount = 0
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      createSessionForChannel: async () => {
        const fake = new FakeSession()
        fake.prompt = async (_text) => {
          promptCount++
          // Three retry errors within one prompt() call (one turn).
          for (let i = 0; i < 3; i++) {
            fake.emit({
              type: 'message_end',
              message: { role: 'assistant', stopReason: 'error', errorMessage: `transient upstream blip ${i}` },
            })
          }
        }
        return {
          session: fake as unknown as AgentSession,
          sessionId: 'ses_retry_dedup',
          dispose: async () => {},
          getTranscriptPath: () => undefined,
        }
      },
    })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    // when: one user turn that retries 3 times
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    const noticesAfterFirstTurn = sent.filter((t) => /upstream LLM provider failed/i.test(t)).length

    // when: a second, separate user turn that also fails
    await router.route(inbound({ text: 'still there?' }))
    await router.__testing!.flushDebounce(KEY)
    const totalNotices = sent.filter((t) => /upstream LLM provider failed/i.test(t)).length

    // then: one notice per turn, not one per retry
    expect(promptCount).toBe(2)
    expect(noticesAfterFirstTurn).toBe(1)
    expect(totalNotices).toBe(2)
  })

  test('suppresses the soft-error notice when the turn recovers and replies (no stranded false failure)', async () => {
    // given: a turn that hits a transient provider error MID-stream (e.g.
    // server_is_overloaded) but then recovers and produces a real reply — the
    // exact huxley#1755 incident, where the "⚠️ provider failed" notice was
    // stranded above a correct review posted ~83s later.
    const dir = await tempDir()
    const sent: string[] = []
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    // when: error fires, then the turn recovers with assistant prose
    await router.route(inbound({ text: 'review this PR' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage:
            'Codex error: {"error":{"code":"server_is_overloaded","message":"Our servers are currently overloaded."}}',
        },
      })
      sessions[0]!.setAssistantText('Review complete. Clean refactor, no issues.')
    }
    await router.__testing!.flushDebounce(KEY)

    // then: the real reply lands and NO failure notice is posted
    expect(sent.some((t) => /Review complete/.test(t))).toBe(true)
    expect(sent.some((t) => /upstream LLM provider failed/i.test(t))).toBe(false)
  })

  test('carries the soft-error across an empty-turn retry: no notice when the RETRY recovers and replies', async () => {
    // given: the first prompt hits a provider error AND ends truncated with no
    // send, so validateChannelTurn queues an EMPTY_TURN_RETRY_NUDGE (a fresh
    // drain iteration with a new turnSeq). The retry then replies. The pending
    // error must follow the logical turn — posting it at the first iteration's
    // end would strand a false failure above the retry's reply.
    const dir = await tempDir()
    const sent: string[] = []
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(inbound({ text: 'ambiguous thing' }))
    let attempt = 0
    sessions[0]!.onPrompt = async (text) => {
      attempt++
      // when: a transient error fires mid-stream but the turn ends `length`-
      // truncated with no send → retry queued (the carry-forward case). A
      // `length` leaf retries; an `error` leaf would divert straight to the
      // provider notice, which is a different path tested separately.
      if (attempt === 1) {
        sessions[0]!.emit({
          type: 'message_end',
          message: { role: 'assistant', stopReason: 'error', errorMessage: 'transient server_is_overloaded' },
        })
        sessions[0]!.setAssistantMidTurn('thought-loop output that must not be posted', 'length')
        return
      }
      // when: retry recovers and replies
      expect(text).toContain(EMPTY_TURN_RETRY_NUDGE)
      sessions[0]!.setAssistantText('SENT')
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'here is your answer' })
    }
    await router.__testing!.flushDebounce(KEY)

    // then: only the real reply; the carried-forward error is suppressed
    expect(sessions[0]!.prompts).toHaveLength(2)
    expect(sent.some((t) => /here is your answer/.test(t))).toBe(true)
    expect(sent.some((t) => /upstream LLM provider failed/i.test(t))).toBe(false)
  })

  test('does NOT misattribute a carried provider error to a fresh user turn that coalesces with the retry nudge', async () => {
    // given: turn A errors + truncates (no send) → empty-turn retry nudge queued
    // AND carries the provider error forward. Before the reminder-only retry
    // drains, a NEW user message (turn B) arrives. The drain loop splices
    // promptQueue + pendingSystemReminders together, so turn B is a fresh user
    // batch carrying the stale nudge. Turn B then produces no reply. The prior
    // turn's provider notice must NOT post against turn B.
    const dir = await tempDir()
    const sent: string[] = []
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(inbound({ text: 'turn A' }))
    let attempt = 0
    sessions[0]!.onPrompt = async () => {
      attempt++
      // when: turn A hits a transient error mid-stream and ends `length`-
      // truncated (queues the retry nudge + carry), then a fresh user message
      // lands while that nudge is still pending. The leaf is `length`, not
      // `error`: an `error` leaf diverts straight to the provider notice, so it
      // would never queue a carry-forward retry to misattribute in the first place.
      if (attempt === 1) {
        sessions[0]!.emit({
          type: 'message_end',
          message: { role: 'assistant', stopReason: 'error', errorMessage: 'transient server_is_overloaded' },
        })
        sessions[0]!.setAssistantMidTurn('thought-loop output that must not be posted', 'length')
        await router.route(inbound({ externalMessageId: 'mB', text: 'turn B' }))
        return
      }
      // when: turn B (fresh user batch + coalesced nudge) ends with no reply and
      // no further error — a clean empty turn that must not inherit A's notice
      sessions[0]!.setAssistantText('NO_REPLY')
    }
    await router.__testing!.flushDebounce(KEY)

    // then: A's stale provider notice is never posted against turn B
    expect(sessions[0]!.prompts.length).toBeGreaterThanOrEqual(2)
    expect(sent.some((t) => /upstream LLM provider failed/i.test(t))).toBe(false)
  })

  test('an `error`-leaf turn surfaces the provider notice immediately — no empty-turn retries, no misleading "I got stuck" fallback', async () => {
    // given: the turn ends with a `stopReason: 'error'` leaf (an upstream
    // provider failure, e.g. a 401 or an overloaded server). This is NOT a
    // reasoning loop, so it must NOT be re-prompted with EMPTY_TURN_RETRY_NUDGE
    // and must NOT post EMPTY_TURN_FALLBACK_TEXT ("I got stuck…"), which would
    // mask the real failure. The deferred provider-error path owns this turn and
    // posts the REDACTED safeMessage instead. The raw cause stays in operator logs.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(inbound({ text: 'ambiguous thing' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.emit({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: 'transient server_is_overloaded' },
      })
      sessions[0]!.setAssistantMidTurn('never-ending loop output', 'error')
    }
    await router.__testing!.flushDebounce(KEY)

    // then: exactly one prompt (no retries), the provider notice surfaced, the
    // misleading fallback never posted, and the raw cause was logged for operators.
    // `server_is_overloaded` is not a known safe class, so it collapses to the
    // generic redacted notice (never the raw text).
    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sent.some((t) => t === EMPTY_TURN_FALLBACK_TEXT)).toBe(false)
    expect(sent.some((t) => /upstream LLM provider failed/i.test(t))).toBe(true)
    expect(sent.some((t) => /server_is_overloaded/.test(t))).toBe(false)
    expect(logs.some((m) => /empty_turn_retry/.test(m))).toBe(false)
    expect(logs.some((m) => /provider_error_turn/.test(m))).toBe(true)
    expect(logs.some((m) => /LLM call failed: .*server_is_overloaded/.test(m))).toBe(true)
  })

  test('a 401 provider error surfaces the auth notice (not the misleading "I got stuck" fallback)', async () => {
    // given: the production failure — every turn ends with a
    // `stopReason: 'error'` / `401 Unauthorized` leaf because the provider API
    // key is bad/expired. The old code retried then posted EMPTY_TURN_FALLBACK_TEXT
    // ("I got stuck…"), completely masking the auth failure. Now the auth-class
    // safe message surfaces and the raw 401 stays in operator logs.
    const dir = await tempDir()
    const logs: string[] = []
    const sent: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(inbound({ text: 'hey bot, you there?' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.emit({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: '401 Unauthorized' },
      })
      sessions[0]!.setAssistantMidTurn('', 'error')
    }
    await router.__testing!.flushDebounce(KEY)

    // then: one prompt, the auth notice surfaced, no retries, no "I got stuck"
    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sent.some((t) => /unauthorized/i.test(t) && /API key/i.test(t))).toBe(true)
    expect(sent.some((t) => t === EMPTY_TURN_FALLBACK_TEXT)).toBe(false)
    expect(logs.some((m) => /empty_turn_retry/.test(m))).toBe(false)
  })

  test('upgrades hard prompt-throws to logger.error (not warn) so `typeclaw logs` operators see them at the right level', async () => {
    // given
    const dir = await tempDir()
    const warns: string[] = []
    const errors: string[] = []
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      logger: {
        info: () => {},
        warn: (m) => warns.push(m),
        error: (m) => errors.push(m),
      },
      createSessionForChannel: async () => {
        const fake = new FakeSession()
        fake.prompt = async () => {
          throw new Error('network unreachable')
        }
        return {
          session: fake as unknown as AgentSession,
          sessionId: 'ses_hard_err',
          dispose: async () => {},
          getTranscriptPath: () => undefined,
        }
      },
    })

    // when
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(errors.some((m) => /prompt threw.*network unreachable/.test(m))).toBe(true)
    expect(warns.some((m) => /prompt threw/.test(m))).toBe(false)
  })

  test('fires session.end on stop() before disposing each live session', async () => {
    // given
    const dir = await tempDir()
    const events: string[] = []
    const { router, sessions } = makeRouterWithHooks(dir, events)
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // when
    await router.stop()

    // then
    expect(events).toEqual(['idle:ses_fake_1:-', 'end:ses_fake_1'])
    expect(sessions[0]!.disposed).toBe(1)
  })

  test('a hung session.idle hook does not wedge the drain loop forever', async () => {
    // given a session.idle hook that never resolves (production failure
    // mode: a plugin handler awaiting a network call that hangs). Without
    // the watchdog, `live.draining` would stay `true` and every subsequent
    // mention would silently enqueue forever. The test seam shortens the
    // chain ceiling so the path is exercisable in milliseconds.
    const dir = await tempDir()
    const sessions: FakeSession[] = []
    const logs: string[] = []
    const hooks: HookBus = {
      registerAll: () => {},
      unregisterAll: () => {},
      runSessionStart: async () => {},
      runSessionEnd: async () => {},
      runSessionIdle: () => new Promise(() => {}),
      runSessionPrompt: async () => {},
      runSessionTurnStart: async () => {},
      runSessionTurnEnd: async () => {},
      runToolBefore: async () => undefined,
      runToolAfter: async () => {},
      count: () => 0,
    }
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      sessionIdleTimeoutMs: 30,
      logger: {
        info: (m) => logs.push(`info:${m}`),
        warn: (m) => logs.push(`warn:${m}`),
        error: (m) => logs.push(`error:${m}`),
      },
      createSessionForChannel: async () => {
        const fake = new FakeSession()
        sessions.push(fake)
        return {
          session: fake as unknown as AgentSession,
          sessionId: `ses_fake_${sessions.length}`,
          dispose: async () => {
            fake.dispose()
          },
          hooks,
          getTranscriptPath: () => undefined,
        }
      },
    })

    // when a first message engages the bot and a second arrives after the
    // idle-hook watchdog should have fired
    await router.route(inbound({ text: 'first' }))
    await router.__testing!.flushDebounce(KEY)
    await router.route(inbound({ externalMessageId: 'm2', text: 'second' }))
    await router.__testing!.flushDebounce(KEY)

    // then both prompts ran (the second is the real proof — without the
    // watchdog the drain loop would still be parked inside the hung idle
    // hook and `live.draining` would block enqueue from firing a new drain),
    // and a warning naming the timeout was emitted so an operator can
    // attribute the hang. Avoid asserting wall-clock elapsed time here:
    // Windows CI occasionally pauses this process long enough to exceed a
    // tight bound even though the drain loop made forward progress.
    expect(sessions[0]!.prompts).toHaveLength(2)
    const idleWarn = logs.find((l) => l.includes('warn:[channels]') && l.includes('session.idle hook threw'))
    expect(idleWarn).toBeDefined()
    expect(idleWarn).toMatch(/session\.idle timed out after 30ms/)
  })
})

describe('ChannelRouter channel name resolver', () => {
  test('calls the registered resolver and forwards resolved names into the session origin', async () => {
    const dir = await tempDir()
    const { router, origins } = makeRouter(dir)
    const calls: ChannelKey[] = []
    router.registerChannelNameResolver('discord-bot', 'g1', async (key) => {
      calls.push(key)
      return { chatName: 'general', workspaceName: 'Acme Guild' }
    })

    await router.route(inbound())

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: null })
    expect(origins).toHaveLength(1)
    const origin = origins[0]!
    if (origin.kind !== 'channel') throw new Error('expected channel origin')
    expect(origin.chatName).toBe('general')
    expect(origin.workspaceName).toBe('Acme Guild')
  })

  test('falls back to undefined names when no resolver is registered', async () => {
    const dir = await tempDir()
    const { router, origins } = makeRouter(dir)

    await router.route(inbound())

    const origin = origins[0]!
    if (origin.kind !== 'channel') throw new Error('expected channel origin')
    expect(origin.chatName).toBeUndefined()
    expect(origin.workspaceName).toBeUndefined()
  })

  test('routes through to undefined names when the resolver throws (does not break session creation)', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, origins } = makeRouter(dir, { logs })
    router.registerChannelNameResolver('discord-bot', 'g1', async () => {
      throw new Error('rate limited')
    })

    await router.route(inbound())

    const origin = origins[0]!
    if (origin.kind !== 'channel') throw new Error('expected channel origin')
    expect(origin.chatName).toBeUndefined()
    expect(origin.workspaceName).toBeUndefined()
    expect(logs.some((l) => l.startsWith('warn:') && l.includes('name resolver'))).toBe(true)
  })

  test('only invokes the resolver matching the inbound adapter', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let discordCalls = 0
    let slackCalls = 0
    router.registerChannelNameResolver('discord-bot', 'g1', async () => {
      discordCalls++
      return {}
    })
    router.registerChannelNameResolver('slack-bot', 'g1', async () => {
      slackCalls++
      return {}
    })

    await router.route(inbound({ adapter: 'discord-bot' }))

    expect(discordCalls).toBe(1)
    expect(slackCalls).toBe(0)
  })

  test('does not re-call the resolver on a hot session (only at session creation)', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let calls = 0
    router.registerChannelNameResolver('discord-bot', 'g1', async () => {
      calls++
      return { chatName: 'general', workspaceName: 'Acme' }
    })

    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)
    await router.route(inbound({ externalMessageId: 'm2', text: 'second' }))
    await router.__testing!.flushDebounce(KEY)

    expect(calls).toBe(1)
  })

  test('a hung name resolver times out without dragging ensureLive past the per-callback ceiling', async () => {
    // given a name resolver that never resolves (production failure mode:
    // Discord REST stuck during a gateway-disconnect storm)
    const dir = await tempDir()
    const logs: string[] = []
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      resolveChannelNamesTimeoutMs: 50,
      logger: {
        info: (m) => logs.push(`info:${m}`),
        warn: (m) => logs.push(`warn:${m}`),
        error: (m) => logs.push(`error:${m}`),
      },
      createSessionForChannel: async () => {
        const fake = new FakeSession()
        return {
          session: fake as unknown as AgentSession,
          sessionId: 'ses_after_timeout',
          dispose: async () => {
            fake.dispose()
          },
        }
      },
    })
    router.registerChannelNameResolver('discord-bot', 'g1', () => new Promise(() => {}))

    // when an inbound triggers ensureLive
    const start = Date.now()
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)
    const elapsed = Date.now() - start

    // then ensureLive completes without the resolved name (graceful
    // degradation), the timeout is logged, and the session is created
    expect(elapsed).toBeLessThan(500)
    expect(router.liveCount()).toBe(1)
    expect(logs.some((l) => l.includes('name resolver threw') && l.includes('timed out after 50ms'))).toBe(true)
  })
})

describe('ChannelRouter peer-bot loop guard', () => {
  function botInbound(over: Partial<InboundMessage> = {}): InboundMessage {
    return inbound({
      authorIsBot: true,
      authorId: 'peer-bot-1',
      authorName: 'peer-bot-1',
      isBotMention: true,
      ...over,
    })
  }

  test('5 consecutive engaged peer-bot turns trip the warning into the next prompt', async () => {
    // given
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })

    // when: 5 engaged peer-bot inbounds, each with its own drain
    for (let i = 0; i < 5; i++) {
      nowRef.value += 100
      await router.route(botInbound({ externalMessageId: `b${i}`, authorId: `peer-${i}`, text: `bot ${i}` }))
      await router.__testing!.flushDebounce(KEY)
    }

    // then
    const lastPrompt = sessions[0]!.prompts[sessions[0]!.prompts.length - 1]!
    expect(lastPrompt).toContain('[SYSTEM MESSAGE — not from a human]')
    expect(lastPrompt).toContain('Do not acknowledge or reply to this notice')
    expect(lastPrompt).toContain('NO_REPLY')
  })

  test('slow peer-bot ring (>60s gaps) still trips via since-human counter', async () => {
    // given
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })

    // when: 5 peer bots in a slow ring, each 90s apart so the 60s window stays empty
    for (let i = 0; i < 5; i++) {
      await router.route(botInbound({ externalMessageId: `b${i}`, authorId: `peer-${i}`, text: `bot ${i}` }))
      await router.__testing!.flushDebounce(KEY)
      nowRef.value += 90_000
    }

    // then
    const lastPrompt = sessions[0]!.prompts[sessions[0]!.prompts.length - 1]!
    expect(lastPrompt).toContain('[SYSTEM MESSAGE — not from a human]')
  })

  test('a human inbound clears the guard for the next prompt', async () => {
    // given a tripped guard
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    for (let i = 0; i < 5; i++) {
      nowRef.value += 100
      await router.route(botInbound({ externalMessageId: `b${i}`, authorId: `peer-${i}` }))
      await router.__testing!.flushDebounce(KEY)
    }
    expect(sessions[0]!.prompts[sessions[0]!.prompts.length - 1]).toContain('[SYSTEM MESSAGE — not from a human]')

    // when: a human posts
    nowRef.value += 100
    await router.route(inbound({ externalMessageId: 'human-1', text: 'hey bot what now' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    const newest = sessions[0]!.prompts[sessions[0]!.prompts.length - 1]!
    expect(newest).not.toContain('[SYSTEM MESSAGE — not from a human]')
    expect(newest).toContain('hey bot what now')
  })

  test('observed peer-bot messages do not increment the guard', async () => {
    // given a 2-human channel so peer bot messages without mentions OBSERVE
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ authorId: 'alice' }))
    await router.__testing!.flushDebounce(KEY)
    await router.route(inbound({ authorId: 'bob', externalMessageId: 'bob-1' }))
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.prompts.length = 0

    // when: 10 peer-bot messages with NO mention (must observe in 2-human channel)
    for (let i = 0; i < 10; i++) {
      nowRef.value += 100
      await router.route(
        botInbound({
          externalMessageId: `b${i}`,
          authorId: `peer-${i}`,
          isBotMention: false,
        }),
      )
    }

    // then: a follow-up engaged message must NOT carry the loop-guard warning.
    // (A group-chat nudge shares the SYSTEM MESSAGE marker in this 2-human
    // channel, so assert on the loop-guard-specific text, not the marker.)
    nowRef.value += 100
    await router.route(inbound({ authorId: 'alice', externalMessageId: 'alice-2', text: 'follow up' }))
    await router.__testing!.flushDebounce(KEY)
    const lastPrompt = sessions[0]!.prompts[sessions[0]!.prompts.length - 1]!
    expect(lastPrompt).not.toContain('peer bots have engaged you')
  })

  test('loop guard notice is fenced as SYSTEM MESSAGE so models do not reply to it', async () => {
    // The bracketed marker, the horizontal rule fences, AND the "Do not
    // acknowledge" line together form the trust boundary that stops persona-rich
    // models (e.g. Kimi) from acknowledging the notice as if it were human
    // speech. Production symptom this guards against:
    // e.g. "Understood, I'll wrap up the conversation here." — the model treating
    // the loop guard heading as a human telling it to wrap up.

    // given a tripped guard
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    for (let i = 0; i < 5; i++) {
      nowRef.value += 100
      await router.route(botInbound({ externalMessageId: `b${i}`, authorId: `peer-${i}` }))
      await router.__testing!.flushDebounce(KEY)
    }

    // then: the prompt has all three load-bearing pieces of the trust boundary
    const lastPrompt = sessions[0]!.prompts[sessions[0]!.prompts.length - 1]!
    expect(lastPrompt).toContain('---')
    expect(lastPrompt).toContain('**[SYSTEM MESSAGE — not from a human]**')
    expect(lastPrompt).toContain('**Do not acknowledge or reply to this notice.**')
    // and: the old human-readable H2 heading must NOT appear (it was the
    // structural ambiguity that caused the bug)
    expect(lastPrompt).not.toContain('## ⚠️ Loop guard active')
  })

  test('engaged turn in a multi-human group carries the group-chat nudge', async () => {
    // given a 2-human channel
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ authorId: 'alice', isBotMention: true }))
    await router.__testing!.flushDebounce(KEY)
    await router.route(inbound({ authorId: 'bob', externalMessageId: 'bob-1', isBotMention: true }))
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.prompts.length = 0

    // when alice explicitly mentions the bot (engages despite the crowd)
    nowRef.value += 100
    await router.route(inbound({ authorId: 'alice', externalMessageId: 'alice-2', isBotMention: true, text: 'bot?' }))
    await router.__testing!.flushDebounce(KEY)

    // then the nudge is present and fenced, and current message still renders
    const lastPrompt = sessions[0]!.prompts[sessions[0]!.prompts.length - 1]!
    expect(lastPrompt).toContain('You are in a group chat with multiple people.')
    expect(lastPrompt).toContain('**[SYSTEM MESSAGE — not from a human]**')
    expect(lastPrompt).toContain('bot?')
  })

  test('engaged turn in a solo-human channel does NOT carry the group-chat nudge', async () => {
    // given a single-human channel
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    // when alice posts (solo-human fallback engages)
    await router.route(inbound({ authorId: 'alice', isBotMention: false, text: 'just me here' }))
    await router.__testing!.flushDebounce(KEY)

    // then no nudge
    expect(sessions[0]!.prompts[0]).not.toContain('You are in a group chat with multiple people.')
  })

  test('engaged DM turn does NOT carry the group-chat nudge', async () => {
    // given a DM
    const dir = await tempDir()
    const dmKey: ChannelKey = { adapter: 'discord-bot', workspace: '@dm', chat: 'd1', thread: null }
    const { router, sessions } = makeRouter(dir)

    // when a DM message arrives
    await router.route(inbound({ workspace: '@dm', chat: 'd1', isDm: true, text: 'hey' }))
    await router.__testing!.flushDebounce(dmKey)

    // then no nudge even though dmMembership reports a bot participant
    expect(sessions[0]!.prompts[0]).not.toContain('You are in a group chat with multiple people.')
  })

  test('peer-bot author lines are tagged with [bot] in the prompt', async () => {
    // given
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    // when
    await router.route(botInbound({ authorId: 'peer1', authorName: 'PeerBot', text: 'hi from a bot' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(sessions[0]!.prompts[0]).toContain('<@peer1> (PeerBot) [bot]: hi from a bot')
  })

  test('human author lines are NOT tagged with [bot]', async () => {
    // given
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    // when
    await router.route(inbound({ text: 'hi from alice' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(sessions[0]!.prompts[0]).toContain('<@alice> (alice): hi from alice')
    expect(sessions[0]!.prompts[0]).not.toContain('[bot]')
  })

  test('observed peer-bot messages also carry the [bot] tag in Recent context', async () => {
    // given a 2-human channel where peer-bot messages will observe
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ authorId: 'alice' }))
    await router.__testing!.flushDebounce(KEY)
    await router.route(inbound({ authorId: 'bob', externalMessageId: 'bob-1' }))
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.prompts.length = 0

    // when: an observed peer bot, then an engaged human
    nowRef.value += 100
    await router.route(
      botInbound({ externalMessageId: 'observed-bot', authorId: 'peer1', authorName: 'PeerBot', isBotMention: false }),
    )
    nowRef.value += 100
    await router.route(inbound({ authorId: 'alice', externalMessageId: 'a2', text: 'ping' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(sessions[0]!.prompts[0]).toContain('<@peer1> (PeerBot) [bot]: ')
  })
})

describe('ChannelRouter history dispatch', () => {
  test('fetchHistory invokes the registered callback with the args verbatim', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const seen: FetchHistoryArgs[] = []
    router.registerHistory('discord-bot', 'g1', async (args) => {
      seen.push(args)
      return { ok: true, messages: [] }
    })

    const result = await router.fetchHistory('discord-bot', 'g1', { chat: 'c1', thread: 't1', limit: 5, cursor: 'cur' })

    expect(result).toEqual({ ok: true, messages: [] })
    expect(seen).toEqual([{ chat: 'c1', thread: 't1', limit: 5, cursor: 'cur' }])
  })

  test('returns history-not-supported when no callback is registered for the adapter', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)

    const result = await router.fetchHistory('discord-bot', 'g1', { chat: 'c1', thread: null, limit: 1 })

    expect(result).toEqual({ ok: false, error: 'history-not-supported' })
  })

  test('first ok callback wins; later callbacks are not invoked', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let secondCalled = false
    router.registerHistory('discord-bot', 'g1', async () => ({
      ok: true,
      messages: [
        {
          externalMessageId: 'm1',
          authorId: 'u1',
          authorName: 'Alice',
          text: 'hi',
          ts: 1000,
          isBot: false,
          replyToBotMessageId: null,
        },
      ],
    }))
    router.registerHistory('discord-bot', 'g1', async () => {
      secondCalled = true
      return { ok: false, error: 'second' }
    })

    const result = await router.fetchHistory('discord-bot', 'g1', { chat: 'c1', thread: null, limit: 5 })

    expect(result.ok).toBe(true)
    expect(secondCalled).toBe(false)
  })

  test('surfaces the last error verbatim when every callback returns ok: false', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerHistory('discord-bot', 'g1', async () => ({ ok: false, error: 'first-failed' }))
    router.registerHistory('discord-bot', 'g1', async () => ({ ok: false, error: 'second-failed' }))

    const result = await router.fetchHistory('discord-bot', 'g1', { chat: 'c1', thread: null, limit: 1 })

    expect(result).toEqual({ ok: false, error: 'second-failed' })
  })

  test('unregisterHistory removes the callback so subsequent calls fall back to history-not-supported', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const cb: HistoryCallback = async () => ({ ok: true, messages: [] })
    router.registerHistory('discord-bot', 'g1', cb)
    router.unregisterHistory('discord-bot', 'g1', cb)

    const result = await router.fetchHistory('discord-bot', 'g1', { chat: 'c1', thread: null, limit: 1 })

    expect(result).toEqual({ ok: false, error: 'history-not-supported' })
  })

  test('history registrations are isolated per adapter', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let discordCalls = 0
    let slackCalls = 0
    router.registerHistory('discord-bot', 'g1', async () => {
      discordCalls++
      return { ok: true, messages: [] }
    })
    router.registerHistory('slack-bot', 'g1', async () => {
      slackCalls++
      return { ok: true, messages: [] }
    })

    await router.fetchHistory('discord-bot', 'g1', { chat: 'c1', thread: null, limit: 1 })

    expect(discordCalls).toBe(1)
    expect(slackCalls).toBe(0)
  })

  test('a hung history callback times out and degrades to history-not-supported', async () => {
    // given a fetchHistory callback that never resolves (production failure
    // mode: same root cause as the hung name resolver — REST stuck inside
    // the cold-start chain). Without the timeout, prefetchChannelContext
    // would block ensureLive forever even on a known-existing channel.
    const dir = await tempDir()
    const logs: string[] = []
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      fetchHistoryTimeoutMs: 50,
      logger: {
        info: (m) => logs.push(`info:${m}`),
        warn: (m) => logs.push(`warn:${m}`),
        error: (m) => logs.push(`error:${m}`),
      },
    })
    router.registerHistory('discord-bot', 'g1', () => new Promise(() => {}))

    // when fetchHistory is invoked
    const start = Date.now()
    const result = await router.fetchHistory('discord-bot', 'g1', { chat: 'c1', thread: null, limit: 1 })
    const elapsed = Date.now() - start

    // then it returns the not-supported degraded result and logs the timeout
    expect(elapsed).toBeLessThan(500)
    expect(result.ok).toBe(false)
    expect(logs.some((l) => l.includes('history fetch threw') && l.includes('timed out after 50ms'))).toBe(true)
  })
})

describe('ChannelRouter route-key dispatch', () => {
  test('catch-all registration supports proactive outbound without prior inbound', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const sent: string[] = []

    router.registerOutbound('discord', ROUTE_WORKSPACE_ANY, async (msg) => {
      sent.push(`${msg.workspace}:${msg.chat}:${msg.text ?? ''}`)
      return { ok: true }
    })

    const result = await router.send({ adapter: 'discord', workspace: 'guild_999', chat: 'C', text: 'hi' })

    expect(result).toEqual({ ok: true })
    expect(sent).toEqual(['guild_999:C:hi'])
  })

  test('exact workspace registration wins over catch-all fallback', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const sent: string[] = []

    router.registerOutbound('slack', ROUTE_WORKSPACE_ANY, async () => {
      sent.push('catch-all')
      return { ok: true }
    })
    router.registerOutbound('slack', 'WS_A', async () => {
      sent.push('exact')
      return { ok: true }
    })

    await router.send({ adapter: 'slack', workspace: 'WS_A', chat: 'C1', text: 'exact route' })
    await router.send({ adapter: 'slack', workspace: 'WS_unknown', chat: 'C1', text: 'fallback route' })

    expect(sent).toEqual(['exact', 'catch-all'])
  })

  test('isolates outbound callbacks and self identity by adapter workspace route key', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const sent: string[] = []

    router.registerOutbound('slack', 'WS_A', async () => {
      sent.push('WS_A')
      return { ok: true }
    })
    router.registerOutbound('slack', 'WS_B', async () => {
      sent.push('WS_B')
      return { ok: true }
    })
    router.registerSelfIdentity('slack', 'WS_A', () => ({ id: 'SELF_A' }))
    router.registerSelfIdentity('slack', 'WS_B', () => ({ id: 'SELF_B' }))

    const result = await router.send({ adapter: 'slack', workspace: 'WS_A', chat: 'C1', text: 'hello' })

    expect(result.ok).toBe(true)
    expect(sent).toEqual(['WS_A'])
    expect(
      router.__testing!.resolveSelfIdentity({ adapter: 'slack', workspace: 'WS_A', chat: 'C1', thread: null }),
    ).toEqual({
      id: 'SELF_A',
    })
    expect(
      router.__testing!.resolveSelfIdentity({ adapter: 'slack', workspace: 'WS_B', chat: 'C1', thread: null }),
    ).toEqual({
      id: 'SELF_B',
    })
  })
})

function historyMessage(over: Partial<ChannelHistoryMessage> = {}): ChannelHistoryMessage {
  return {
    externalMessageId: 'h1',
    authorId: 'u1',
    authorName: 'Hist Author',
    text: 'historic',
    ts: 100,
    isBot: false,
    replyToBotMessageId: null,
    ...over,
  }
}

describe('isGraceWorthReusing', () => {
  test('reuses when base context exceeds transcript delta', () => {
    expect(isGraceWorthReusing(10_000, 1_000)).toBe(true)
  })

  test('rolls over when transcript delta meets or exceeds base context', () => {
    expect(isGraceWorthReusing(10_000, 10_000)).toBe(false)
    expect(isGraceWorthReusing(10_000, 15_000)).toBe(false)
  })

  test('fails closed when base context is unknown (0 or negative)', () => {
    expect(isGraceWorthReusing(0, 0)).toBe(false)
    expect(isGraceWorthReusing(-1, 0)).toBe(false)
  })
})

describe('sliceHeadTail', () => {
  const m = (id: string): ChannelHistoryMessage => historyMessage({ externalMessageId: id, text: id })

  test('returns all messages without elision when total <= head + tail', () => {
    const result = sliceHeadTail([m('a'), m('b'), m('c')], 2, 1)
    expect(result.map((s) => (s.kind === 'message' ? s.message.externalMessageId : 'ELIDE'))).toEqual(['a', 'b', 'c'])
  })

  test('elides the middle when total > head + tail', () => {
    const result = sliceHeadTail([m('a'), m('b'), m('c'), m('d'), m('e')], 1, 2)
    expect(result.map((s) => (s.kind === 'message' ? s.message.externalMessageId : `ELIDE:${s.elidedCount}`))).toEqual([
      'a',
      'ELIDE:2',
      'd',
      'e',
    ])
  })

  test('head=0 returns only tail with no elision marker when no head requested', () => {
    const result = sliceHeadTail([m('a'), m('b'), m('c'), m('d')], 0, 2)
    expect(result.map((s) => (s.kind === 'message' ? s.message.externalMessageId : `ELIDE:${s.elidedCount}`))).toEqual([
      'ELIDE:2',
      'c',
      'd',
    ])
  })

  test('tail=0 returns only head', () => {
    const result = sliceHeadTail([m('a'), m('b'), m('c'), m('d')], 2, 0)
    expect(result.map((s) => (s.kind === 'message' ? s.message.externalMessageId : `ELIDE:${s.elidedCount}`))).toEqual([
      'a',
      'b',
      'ELIDE:2',
    ])
  })

  test('both zero returns empty', () => {
    expect(sliceHeadTail([m('a'), m('b')], 0, 0)).toEqual([])
  })

  test('rejects negative head/tail', () => {
    expect(() => sliceHeadTail([m('a')], -1, 0)).toThrow()
    expect(() => sliceHeadTail([m('a')], 0, -1)).toThrow()
  })
})

describe('ChannelRouter cold-start prefetch', () => {
  const THREAD_KEY: ChannelKey = { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A' }

  test('prefetches thread history into contextBuffer on a brand-new thread session', async () => {
    // given: a thread cold start with default windows (head=3, tail=10)
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerHistory('discord-bot', 'g1', async () => ({
      ok: true,
      messages: [
        historyMessage({ externalMessageId: 'older1', text: 'thread-opener', authorName: 'Alice' }),
        historyMessage({ externalMessageId: 'mid1', text: 'middle1', authorName: 'Bob' }),
        historyMessage({ externalMessageId: 'mid2', text: 'middle2', authorName: 'Bob' }),
        historyMessage({ externalMessageId: 'recent1', text: 'recent', authorName: 'Carol' }),
      ],
    }))

    // when: an inbound arrives in a fresh thread
    await router.route(inbound({ thread: 't-A', externalMessageId: 'engage1', text: 'hey bot' }))
    await router.__testing!.flushDebounce(THREAD_KEY)

    // then: the composed prompt includes prefetched messages under "Recent context"
    expect(sessions[0]!.prompts).toHaveLength(1)
    const prompt = sessions[0]!.prompts[0]!
    expect(prompt).toContain('## Recent context')
    expect(prompt).toContain('thread-opener')
    expect(prompt).toContain('recent')
    expect(prompt).toContain('## Current message')
    expect(prompt).toContain('hey bot')
  })

  test('a peer bot in prefetched history does NOT make botInThread true (stays quiet on a human-rooted reply-to-other)', async () => {
    // Incident: dobby woke on a fresh thread cold-start whose prefetched
    // history held a PEER bot's message. `hasBotParticipated` counted that
    // peer bot as "we participated", flipping botInThread=true, which
    // neutralized the replyToOtherMessageId suppressor and let dobby engage
    // a thread aimed at another bot. botInThread must mean OUR participation,
    // not "some bot spoke here".
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerSelfIdentity('discord-bot', 'g1', () => ({ id: 'BOT_SELF_ID' }))
    router.registerHistory('discord-bot', 'g1', async () => ({
      ok: true,
      messages: [
        historyMessage({
          externalMessageId: 'peer-hist',
          text: 'peer bot analysis',
          authorId: 'peer1',
          authorName: 'PeerBot',
          isBot: true,
        }),
      ],
    }))

    // when: a human posts a thread reply whose parent (thread root) is another
    // human — Slack's parent_user_id always points at the root, so this is the
    // shape the suppressor exists to catch. No mention/alias/dm.
    await router.route(
      inbound({
        thread: 't-A',
        externalMessageId: 'human-followup',
        text: 'follow-up between others',
        authorId: 'human-asker',
        authorName: 'human-asker',
        isBotMention: false,
        replyToBotMessageId: null,
        replyToOtherMessageId: 't-A',
      }),
    )
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A' })

    // then: observed, not engaged (no prompt produced)
    expect(sessions[0]!.prompts).toHaveLength(0)
  })

  test('our OWN message in prefetched history DOES make botInThread true (PR #58 cold-start participation survives)', async () => {
    // The flip side of the fix: a cold-start that prefetches DOBBY's own past
    // reply (authorId === self identity) must still count as participation, so
    // a human follow-up in a thread we already answered engages rather than
    // being dropped by the replyToOtherMessageId suppressor.
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerSelfIdentity('discord-bot', 'g1', () => ({ id: 'BOT_SELF_ID' }))
    router.registerHistory('discord-bot', 'g1', async () => ({
      ok: true,
      messages: [
        historyMessage({
          externalMessageId: 'own-hist',
          text: 'our earlier reply',
          authorId: 'BOT_SELF_ID',
          authorName: 'Dobby',
          isBot: true,
        }),
      ],
    }))

    await router.route(
      inbound({
        thread: 't-A',
        externalMessageId: 'human-followup',
        text: 'thanks, one more thing',
        authorId: 'human-asker',
        authorName: 'human-asker',
        isBotMention: false,
        replyToBotMessageId: null,
        replyToOtherMessageId: 't-A',
      }),
    )
    await router.__testing!.flushDebounce({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't-A' })

    // then: engaged (a prompt is produced) — our prior participation is honored
    expect(sessions[0]!.prompts).toHaveLength(1)
  })

  test('prefetches channel scrollback (tail-only) when session is not in a thread', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerHistory('discord-bot', 'g1', async () => ({
      ok: true,
      messages: [
        historyMessage({ externalMessageId: 'h1', text: 'channel-msg-1' }),
        historyMessage({ externalMessageId: 'h2', text: 'channel-msg-2' }),
      ],
    }))

    await router.route(inbound({ externalMessageId: 'engage', text: 'help me' }))
    await router.__testing!.flushDebounce(KEY)

    const prompt = sessions[0]!.prompts[0]!
    expect(prompt).toContain('## Recent context')
    expect(prompt).toContain('channel-msg-1')
    expect(prompt).toContain('channel-msg-2')
  })

  test('reopened session (existing sessionId persisted) skips prefetch', async () => {
    const dir = await tempDir()
    // given: a pre-existing channel→session mapping on disk
    await saveChannelSessions(dir, [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_preexisting',
        participants: [],
      },
    ])
    let historyCalls = 0
    const { router, sessions } = makeRouter(dir)
    router.registerHistory('discord-bot', 'g1', async () => {
      historyCalls++
      return { ok: true, messages: [historyMessage({ text: 'should-not-appear' })] }
    })

    await router.route(inbound({ externalMessageId: 'engage', text: 'hi' }))
    await router.__testing!.flushDebounce(KEY)

    expect(historyCalls).toBe(0)
    expect(sessions[0]!.prompts[0]).not.toContain('should-not-appear')
    expect(sessions[0]!.prompts[0]).not.toContain('## Recent context')
  })

  test('rehydrate path: a failed mapping write fails ensureLive and leaves no live session', async () => {
    // given: a pre-existing mapping (forces the rehydrate branch, not cold-start)
    //   and a sessions.json writer that always throws
    const dir = await tempDir()
    await saveChannelSessions(dir, [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_preexisting',
        participants: [],
      },
    ])
    const { router } = makeRouter(dir, {
      saveChannelSessions: async () => {
        throw new Error('disk full')
      },
    })

    // when: an inbound drives ensureLive down the rehydrate path
    // then: route() rejects on the write failure and nothing is installed
    await expect(router.route(inbound({ externalMessageId: 'engage', text: 'hi' }))).rejects.toThrow(/disk full/)
    expect(router.liveCount()).toBe(0)
  })

  test('persisted stale-rollover is deferred while the old session still has a running child', async () => {
    // given: a stale on-disk mapping (no live session) whose old session still
    //   has a running background child — wiping it would re-spawn that child
    const dir = await tempDir()
    const nowRef = { value: 1_000_000 }
    const logs: string[] = []
    await saveChannelSessions(dir, [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_preexisting',
        participants: [],
        lastInboundAt: 0,
      },
    ])
    const factoryCalls: SessionFactoryArgs[] = []
    const { router } = makeRouter(dir, {
      nowRef,
      logs,
      factoryCalls,
      newestRunningChildSubagentStartedAt: (sessionId) =>
        sessionId === 'ses_preexisting' ? nowRef.value - 1000 : null,
    })

    // when: an inbound arrives far past the freshness TTL (persisted-rollover band)
    await router.route(inbound({ externalMessageId: 'engage', text: 'still researching?' }))
    await router.__testing!.flushDebounce(KEY)

    // then: no persisted rollover — the same sessionId is reopened, not replaced
    expect(logs.some((l) => l.includes('stale-rollover (persisted'))).toBe(false)
    expect(factoryCalls[0]?.existingSessionId).toBe('ses_preexisting')
  })

  test('persisted stale-rollover fires once the old session child outlives the pin cap', async () => {
    // given: same stale mapping, but the child started past SESSION_CHILD_PIN_MAX_MS ago
    const dir = await tempDir()
    const nowRef = { value: 10_000_000 }
    const logs: string[] = []
    await saveChannelSessions(dir, [
      {
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        thread: null,
        sessionId: 'ses_preexisting',
        participants: [],
        lastInboundAt: 0,
      },
    ])
    const factoryCalls: SessionFactoryArgs[] = []
    const { router } = makeRouter(dir, {
      nowRef,
      logs,
      factoryCalls,
      newestRunningChildSubagentStartedAt: (sessionId) =>
        sessionId === 'ses_preexisting' ? nowRef.value - SESSION_CHILD_PIN_MAX_MS - 1 : null,
    })

    // when
    await router.route(inbound({ externalMessageId: 'engage', text: 'are you stuck?' }))
    await router.__testing!.flushDebounce(KEY)

    // then: the past-cap override lets the persisted rollover proceed (fresh session)
    expect(logs.some((l) => l.includes('stale-rollover (persisted') && l.includes('past child-pin cap'))).toBe(true)
    expect(factoryCalls[0]?.existingSessionId).toBeUndefined()
  })

  test('history fetch failure is non-fatal; session still processes the engaging message', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerHistory('discord-bot', 'g1', async () => ({ ok: false, error: 'rate-limited' }))

    await router.route(inbound({ externalMessageId: 'engage', text: 'still works' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('still works')
    expect(sessions[0]!.prompts[0]).not.toContain('## Recent context')
    expect(
      logs.some((l) => l.startsWith('warn:') && l.includes('prefetch skipped') && l.includes('rate-limited')),
    ).toBe(true)
  })

  test('no history adapter registered → prefetch quietly skipped, no error', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    // no router.registerHistory call

    await router.route(inbound({ externalMessageId: 'engage', text: 'hello' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).not.toContain('## Recent context')
  })

  test('drops the engaging message itself from prefetched history (dedup by externalMessageId)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerHistory('discord-bot', 'g1', async () => ({
      ok: true,
      messages: [
        historyMessage({ externalMessageId: 'older', text: 'before-engage' }),
        historyMessage({ externalMessageId: 'engage', text: 'engaging-message-duplicated' }),
      ],
    }))

    await router.route(inbound({ externalMessageId: 'engage', text: 'engaging-message-current' }))
    await router.__testing!.flushDebounce(KEY)

    const prompt = sessions[0]!.prompts[0]!
    expect(prompt).toContain('before-engage')
    expect(prompt).not.toContain('engaging-message-duplicated')
    // the engaging message itself appears exactly once, in the Current section
    expect(prompt).toContain('engaging-message-current')
    const occurrences = prompt.split('engaging-message').length - 1
    expect(occurrences).toBe(1)
  })

  test('carries prefetched message attachments into the turn so look_at can resolve them', async () => {
    // given: a thread root that carried an image, fetched via prefetch
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerHistory('discord-bot', 'g1', async () => ({
      ok: true,
      messages: [
        historyMessage({
          externalMessageId: 'root',
          text: 'what is this photo??\n[Slack attachment #1: file image/png name=photo.png]',
          attachments: [{ id: 1, kind: 'file', ref: 'F123', filename: 'photo.png', mimetype: 'image/png' }],
        }),
      ],
    }))

    // The attachment is only resolvable mid-turn (currentTurnAttachments is
    // reset after prompt() returns), so snapshot it the moment prompt() fires —
    // exactly when the agent's look_at_channel_attachment tool would run.
    let resolvedMidTurn: ReturnType<typeof router.lookupInboundAttachment> = null
    let promptDuringTurn = ''

    // when: the agent is later @-mentioned in that thread
    await router.route(inbound({ thread: 't-A', externalMessageId: 'engage', text: 'hey bot' }))
    sessions[0]!.onPrompt = (text) => {
      promptDuringTurn = text
      resolvedMidTurn = router.lookupInboundAttachment({ ...THREAD_KEY, id: 1 })
    }
    await router.__testing!.flushDebounce(THREAD_KEY)

    // then: the placeholder rendered for the model AND the id resolved to the ref
    expect(promptDuringTurn).toContain('[Slack attachment #1: file image/png name=photo.png]')
    expect(resolvedMidTurn).not.toBeNull()
    expect(resolvedMidTurn!.ref).toBe('F123')
  })

  test('emits an elision marker when thread length exceeds head + tail', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir, {
      // override defaults to make elision easy to trigger
      config: {
        engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: { perReply: { window: 60_000 } } },
        enabled: true,
        history: { prefetch: { thread: { head: 1, tail: 1 }, channel: { tail: 0 } } },
      },
    })
    router.registerHistory('discord-bot', 'g1', async () => ({
      ok: true,
      messages: [
        historyMessage({ externalMessageId: 'h1', text: 'oldest-of-three' }),
        historyMessage({ externalMessageId: 'h2', text: 'middle-of-three' }),
        historyMessage({ externalMessageId: 'h3', text: 'newest-of-three' }),
      ],
    }))

    await router.route(inbound({ thread: 't-A', externalMessageId: 'engage', text: 'hi' }))
    await router.__testing!.flushDebounce(THREAD_KEY)

    const prompt = sessions[0]!.prompts[0]!
    expect(prompt).toContain('oldest-of-three')
    expect(prompt).not.toContain('middle-of-three')
    expect(prompt).toContain('newest-of-three')
    expect(prompt).toContain('1 earlier messages elided')
  })

  test('all prefetch windows zero → no fetch is issued', async () => {
    const dir = await tempDir()
    let historyCalls = 0
    const { router, sessions } = makeRouter(dir, {
      config: {
        engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: { perReply: { window: 60_000 } } },
        enabled: true,
        history: { prefetch: { thread: { head: 0, tail: 0 }, channel: { tail: 0 } } },
      },
    })
    router.registerHistory('discord-bot', 'g1', async () => {
      historyCalls++
      return { ok: true, messages: [historyMessage({ text: 'never-fetched' })] }
    })

    await router.route(inbound({ externalMessageId: 'engage', text: 'hello' }))
    await router.__testing!.flushDebounce(KEY)

    expect(historyCalls).toBe(0)
    expect(sessions[0]!.prompts[0]).not.toContain('## Recent context')
  })

  test('passes thread-scoped fetch args (thread id, head+tail+1 limit) on thread cold start', async () => {
    const dir = await tempDir()
    const captured: FetchHistoryArgs[] = []
    const { router } = makeRouter(dir, {
      config: {
        engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: { perReply: { window: 60_000 } } },
        enabled: true,
        history: { prefetch: { thread: { head: 2, tail: 5 }, channel: { tail: 8 } } },
      },
    })
    router.registerHistory('discord-bot', 'g1', async (args) => {
      captured.push(args)
      return { ok: true, messages: [] }
    })

    await router.route(inbound({ thread: 't-A', externalMessageId: 'engage', text: 'hi' }))
    await router.__testing!.flushDebounce(THREAD_KEY)

    expect(captured).toEqual([{ chat: 'c1', thread: 't-A', limit: 8 }])
  })
})

// Idle GC evicts LiveSessions whose lastInboundAt is older than
// SESSION_IDLE_MS. Persistence (channels/sessions.json) is intentionally
// untouched: the next inbound rehydrates from disk against the same
// sessionId, so the agent gets a fresh in-memory session but the on-disk
// transcript continues. Tests drive the GC via the `__testing.runIdleGc()`
// seam; production uses a setInterval.
describe('ChannelRouter idle session GC', () => {
  test('evicts a session that has been idle longer than SESSION_IDLE_MS', async () => {
    // given: an engaged session at t=1000 (creates the session)
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    expect(router.liveCount()).toBe(1)

    // when: time advances past the idle threshold and the GC runs
    nowRef.value = 1000 + SESSION_IDLE_MS + 1
    await router.__testing!.runIdleGc!()

    // then: live map drops the entry, the session is aborted+disposed
    expect(router.liveCount()).toBe(0)
    expect(sessions[0]!.aborted).toBe(1)
    expect(sessions[0]!.disposed).toBe(1)
  })

  test('does not evict a session whose lastInboundAt is within SESSION_IDLE_MS', async () => {
    // given
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // when: advance time but stay just under the threshold
    nowRef.value = 1000 + SESSION_IDLE_MS - 1
    await router.__testing!.runIdleGc!()

    // then
    expect(router.liveCount()).toBe(1)
    expect(sessions[0]!.aborted).toBe(0)
  })

  test('does not evict a session that is currently draining', async () => {
    // given: a session whose prompt() blocks until we release it
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    let release: (() => void) | undefined
    const blocked = new Promise<void>((r) => {
      release = r
    })
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ text: 'hi bot' }))
    sessions[0]!.onPrompt = async () => {
      await blocked
    }
    const draining = router.__testing!.flushDebounce(KEY)

    // when: time leaps past the threshold while the turn is in flight
    nowRef.value = 1000 + SESSION_IDLE_MS + 1
    await router.__testing!.runIdleGc!()

    // then: GC respects the in-flight turn and leaves the session alone
    expect(router.liveCount()).toBe(1)
    expect(sessions[0]!.aborted).toBe(0)

    // cleanup so the test process can exit
    release!()
    await draining
  })

  test('does not evict a session whose background child is still running', async () => {
    // given: an idle session that still has a running background subagent
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const childStartedAt = 1000
    const { router, sessions } = makeRouter(dir, {
      nowRef,
      newestRunningChildSubagentStartedAt: (sessionId) => (sessionId === 'ses_fake_1' ? childStartedAt : null),
    })
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    expect(router.liveCount()).toBe(1)

    // when: time advances past the idle threshold (but within the child-pin cap)
    nowRef.value = 1000 + SESSION_IDLE_MS + 1
    await router.__testing!.runIdleGc!()

    // then: the running child pins the session against eviction
    expect(router.liveCount()).toBe(1)
    expect(sessions[0]!.aborted).toBe(0)
  })

  test('evicts a session whose background child has outlived SESSION_CHILD_PIN_MAX_MS', async () => {
    // given: a session whose child started long enough ago to exceed the pin cap
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const childStartedAt = 1000
    const { router, sessions } = makeRouter(dir, {
      nowRef,
      logs,
      newestRunningChildSubagentStartedAt: (sessionId) => (sessionId === 'ses_fake_1' ? childStartedAt : null),
    })
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // when: GC runs after both the idle threshold AND the pin cap have elapsed
    nowRef.value = childStartedAt + SESSION_CHILD_PIN_MAX_MS + 1
    await router.__testing!.runIdleGc!()

    // then: the pin is overridden and the stuck session is evicted
    expect(router.liveCount()).toBe(0)
    expect(sessions[0]!.aborted).toBe(1)
    expect(logs.some((l) => l.includes('idle_gc evicting') && l.includes('past child-pin cap'))).toBe(true)
  })

  test('next inbound after eviction creates a fresh session and rehydrates the persisted sessionId', async () => {
    // given: session is evicted
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    nowRef.value = 1000 + SESSION_IDLE_MS + 1
    await router.__testing!.runIdleGc!()
    expect(router.liveCount()).toBe(0)

    // when
    await router.route(inbound({ text: 'still here?', externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce(KEY)

    // then
    expect(sessions).toHaveLength(2)
    expect(router.liveCount()).toBe(1)
    const persisted = await loadChannelSessions(dir)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]?.sessionId).toBeDefined()
  })

  test('fires session.end hook on the evicted session before disposing', async () => {
    // given: a session with hooks
    const dir = await tempDir()
    const events: string[] = []
    const nowRef = { value: 1000 }
    const sessions: FakeSession[] = []
    const hooks: HookBus = {
      registerAll: () => {},
      unregisterAll: () => {},
      runSessionStart: async () => {},
      runSessionEnd: async (e) => {
        events.push(`end:${e.sessionId}`)
      },
      runSessionIdle: async (e) => {
        events.push(`idle:${e.sessionId}`)
      },
      runSessionPrompt: async () => {},
      runSessionTurnStart: async () => {},
      runSessionTurnEnd: async () => {},
      runToolBefore: async () => undefined,
      runToolAfter: async () => {},
      count: () => 0,
    }
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      now: () => nowRef.value,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      createSessionForChannel: async () => {
        const fake = new FakeSession()
        sessions.push(fake)
        return {
          session: fake as unknown as AgentSession,
          sessionId: `ses_fake_${sessions.length}`,
          dispose: async () => {
            fake.dispose()
          },
          hooks,
          getTranscriptPath: () => undefined,
        }
      },
    })
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // when
    nowRef.value = 1000 + SESSION_IDLE_MS + 1
    await router.__testing!.runIdleGc!()

    // then: idle fires after the prompt (existing behavior), then end on
    // eviction; end must precede dispose so plugins can still touch state.
    expect(events).toEqual(['idle:ses_fake_1', 'end:ses_fake_1'])
    expect(sessions[0]!.disposed).toBe(1)
  })

  test('observe-only session is not evicted on the next GC tick after creation', async () => {
    // given: a session created by an observe-only inbound (suppressed by
    // mentionsOthers, no engage signal). lastInboundAt is initialized to
    // `now()` at creation (not 0) so a freshly created observe-only
    // session gets a full SESSION_IDLE_MS window before GC, instead of
    // being immediately evicted with a `Date.now() - 0` (~56yr) reading.
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router } = makeRouter(dir, { nowRef })
    await router.route(
      inbound({
        isBotMention: false,
        mentionsOthers: true, // suppressor → observe
        text: 'hey @someone-else look at this',
      }),
    )
    expect(router.liveCount()).toBe(1)

    // when: GC runs at the next tick (well within SESSION_IDLE_MS)
    nowRef.value = 1000 + SESSION_GC_INTERVAL_MS
    await router.__testing!.runIdleGc!()

    // then: session is preserved
    expect(router.liveCount()).toBe(1)
  })

  test('observe-only session DOES evict after SESSION_IDLE_MS (passive observation does not keep it warm forever)', async () => {
    // given: an observe-only session
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router } = makeRouter(dir, { nowRef })
    await router.route(
      inbound({
        isBotMention: false,
        mentionsOthers: true, // suppressor → observe
        text: 'hey @someone-else look at this',
      }),
    )
    expect(router.liveCount()).toBe(1)

    // when: more passive observation arrives but never engages, then time
    // advances past the threshold from session CREATION (not from last
    // observation) — observe deliberately does not bump lastInboundAt
    nowRef.value = 1000 + 5 * 60_000
    await router.route(
      inbound({
        externalMessageId: 'm2',
        isBotMention: false,
        mentionsOthers: true,
        text: 'still chatting with someone else',
      }),
    )
    nowRef.value = 1000 + SESSION_IDLE_MS + 1
    await router.__testing!.runIdleGc!()

    // then: session is evicted; passive traffic does not pin memory
    expect(router.liveCount()).toBe(0)
  })

  test('runIdleGc tolerates dispose throwing and still removes the entry', async () => {
    // given
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const sessions: FakeSession[] = []
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      now: () => nowRef.value,
      logger: {
        info: (m) => logs.push(`info:${m}`),
        warn: (m) => logs.push(`warn:${m}`),
        error: (m) => logs.push(`error:${m}`),
      },
      createSessionForChannel: async () => {
        const fake = new FakeSession()
        sessions.push(fake)
        return {
          session: fake as unknown as AgentSession,
          sessionId: `ses_fake_${sessions.length}`,
          dispose: async () => {
            throw new Error('dispose boom')
          },
        }
      },
    })
    await router.route(inbound({ text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)

    // when
    nowRef.value = 1000 + SESSION_IDLE_MS + 1
    await router.__testing!.runIdleGc!()

    // then
    expect(router.liveCount()).toBe(0)
    expect(logs.some((l) => l.includes('dispose'))).toBe(true)
  })
})

describe('ChannelRouter channel.respond gate', () => {
  type PermissionTable = Record<string, readonly string[]>

  const buildPermissions = (table: PermissionTable, fallback: readonly string[] = []): PermissionService => ({
    has: (origin, permission) => {
      if (origin === undefined || origin.kind !== 'channel') return fallback.includes(permission)
      const authorId = origin.lastInboundAuthorId ?? '*'
      const grants = table[authorId] ?? fallback
      return grants.includes(permission)
    },
    resolveRole: () => 'guest',
    compareRoleSeverity: () => undefined,
    describe: () => ({ role: 'guest', permissions: [] }),
    replaceRoles: () => {},
  })

  test('author has channel.respond → routes through normally', async () => {
    const dir = await tempDir()
    const permissions = buildPermissions({ alice: ['channel.respond'] })
    const { router, sessions } = makeRouter(dir, { permissions })

    await router.route(inbound({ authorId: 'alice' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.prompts).toHaveLength(1)
  })

  test('author lacks channel.respond → inbound dropped, no session created', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const permissions = buildPermissions({ alice: ['channel.respond'] })
    const { router, sessions } = makeRouter(dir, { permissions, logs })

    await router.route(inbound({ authorId: 'stranger', externalMessageId: 'm-stranger' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(sessions).toHaveLength(0)
    expect(router.liveCount()).toBe(0)
    expect(logs.some((l) => l.includes('denied by permissions') && l.includes('author=stranger'))).toBe(true)
  })

  test('denied author + later granted author → only the granted one routes', async () => {
    const dir = await tempDir()
    const permissions = buildPermissions({ alice: ['channel.respond'] })
    const { router, sessions } = makeRouter(dir, { permissions })

    await router.route(inbound({ authorId: 'stranger', externalMessageId: 'm-stranger' }))
    await new Promise((r) => setTimeout(r, 5))
    expect(sessions).toHaveLength(0)
    await router.route(inbound({ authorId: 'alice', externalMessageId: 'm-alice' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.prompts).toHaveLength(1)
  })

  test('respond-capable author WITHOUT session.control cannot /stop via text prefix', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    // guest-shaped: channel.respond granted (can drive turns) but no
    // session.control, so /stop must be refused.
    const permissions = buildPermissions({
      alice: ['channel.respond', 'session.control'],
      stranger: ['channel.respond'],
    })
    const { router, sessions } = makeRouter(dir, { permissions, logs })

    // given: alice (full control) starts a live session
    await router.route(inbound({ authorId: 'alice', externalMessageId: 'm-alice' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions).toHaveLength(1)

    // when: stranger (respond but no control) types /stop
    await router.route(inbound({ authorId: 'stranger', text: '/stop', externalMessageId: 'm-stop' }))
    await new Promise((r) => setTimeout(r, 10))

    // then: the command is refused and the session is not aborted
    expect(sessions[0]!.aborted).toBe(0)
    expect(logs.some((l) => l.includes('session.control') && l.includes('author=stranger'))).toBe(true)
  })

  test('author WITH session.control can /stop via text prefix', async () => {
    const dir = await tempDir()
    const permissions = buildPermissions({ alice: ['channel.respond', 'session.control'] })
    const { router, sessions } = makeRouter(dir, { permissions })

    await router.route(inbound({ authorId: 'alice', externalMessageId: 'm-alice' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions).toHaveLength(1)

    await router.route(inbound({ authorId: 'alice', text: '/stop', externalMessageId: 'm-stop' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(sessions[0]!.aborted).toBe(1)
  })

  test('respond-capable author WITHOUT session.control can still /help via text prefix', async () => {
    const dir = await tempDir()
    const sent: Array<{ text: string }> = []
    const permissions = buildPermissions({ stranger: ['channel.respond'] })
    const { router } = makeRouter(dir, { permissions })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ authorId: 'stranger', text: '/help', externalMessageId: 'm-help' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('Available commands')
  })

  test('author WITHOUT channel.respond can still /help via text prefix (parity with native slash)', async () => {
    const dir = await tempDir()
    const sent: Array<{ text: string }> = []
    // nobody is absent from the table → no channel.respond. /help is ungated,
    // so it must still answer rather than being dropped by the respond gate.
    const permissions = buildPermissions({})
    const { router, sessions } = makeRouter(dir, { permissions })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ authorId: 'nobody', text: '/help', externalMessageId: 'm-help' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('Available commands')
    expect(sessions).toHaveLength(0)
  })

  test('author WITHOUT channel.respond typing /stop is still denied at the respond gate', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const permissions = buildPermissions({})
    const { router } = makeRouter(dir, { permissions, logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ authorId: 'nobody', text: '/stop', externalMessageId: 'm-stop' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(sent).toHaveLength(0)
    expect(logs.some((l) => l.includes('denied by permissions (channel.respond)'))).toBe(true)
  })

  test('author WITHOUT channel.respond typing an unknown /foo is still denied at the respond gate', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const permissions = buildPermissions({})
    const { router } = makeRouter(dir, { permissions, logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ authorId: 'nobody', text: '/foo', externalMessageId: 'm-foo' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(sent).toHaveLength(0)
    expect(logs.some((l) => l.includes('denied by permissions (channel.respond)'))).toBe(true)
    expect(logs.some((l) => l.includes('ignoring unknown command'))).toBe(false)
  })

  test('escaped //help is not executed as a command and stays subject to the respond gate', async () => {
    const dir = await tempDir()
    const sent: Array<{ text: string }> = []
    const permissions = buildPermissions({})
    const { router } = makeRouter(dir, { permissions })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ authorId: 'nobody', text: '//help', externalMessageId: 'm-esc' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(sent).toHaveLength(0)
  })

  test('authorized author typing /help gets exactly one reply (no double execution)', async () => {
    const dir = await tempDir()
    const sent: Array<{ text: string }> = []
    const permissions = buildPermissions({ alice: ['channel.respond', 'session.control'] })
    const { router } = makeRouter(dir, { permissions })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ authorId: 'alice', text: '/help', externalMessageId: 'm-help' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
  })

  test('native executeCommand /help does not require session.control', async () => {
    const dir = await tempDir()
    const permissions = buildPermissions({ stranger: ['channel.respond'] })
    const { router } = makeRouter(dir, { permissions })

    const result = await router.executeCommand(KEY, 'help', { invokerId: 'stranger' })

    expect(result.kind).toBe('handled')
  })

  test('native executeCommand gates on session.control, not channel.respond', async () => {
    const dir = await tempDir()
    const permissions = buildPermissions({
      alice: ['channel.respond', 'session.control'],
      stranger: ['channel.respond'],
    })
    const { router, sessions } = makeRouter(dir, { permissions })

    await router.route(inbound({ authorId: 'alice', externalMessageId: 'm-alice' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions).toHaveLength(1)

    const denied = await router.executeCommand(KEY, 'stop', { invokerId: 'stranger' })
    expect(denied).toEqual({ kind: 'permission-denied' })
    expect(sessions[0]!.aborted).toBe(0)

    const allowed = await router.executeCommand(KEY, 'stop', { invokerId: 'alice' })
    expect(allowed).toEqual({ kind: 'handled', name: 'stop', reply: 'Stopped the current turn.' })
    expect(sessions[0]!.aborted).toBe(1)
  })

  test('deny-all permissions service drops every inbound', async () => {
    const dir = await tempDir()
    const permissions: PermissionService = {
      has: () => false,
      resolveRole: () => 'guest',
      compareRoleSeverity: () => undefined,
      describe: () => ({ role: 'guest', permissions: [] }),
      replaceRoles: () => {},
    }
    const { router, sessions } = makeRouter(dir, { permissions })

    await router.route(inbound())
    await new Promise((r) => setTimeout(r, 10))

    expect(sessions).toHaveLength(0)
    expect(router.liveCount()).toBe(0)
  })
})

describe('ChannelRouter /reload and /restart (session.admin gate)', () => {
  type PermissionTable = Record<string, readonly string[]>

  const buildPermissions = (table: PermissionTable, fallback: readonly string[] = []): PermissionService => ({
    has: (origin, permission) => {
      if (origin === undefined || origin.kind !== 'channel') return fallback.includes(permission)
      const authorId = origin.lastInboundAuthorId ?? '*'
      const grants = table[authorId] ?? fallback
      return grants.includes(permission)
    },
    resolveRole: () => 'guest',
    compareRoleSeverity: () => undefined,
    describe: () => ({ role: 'guest', permissions: [] }),
    replaceRoles: () => {},
  })

  const captureOutbound = (router: ChannelRouter): Array<{ text: string }> => {
    const sent: Array<{ text: string }> = []
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })
    return sent
  }

  test('commands are unregistered (unknown) when onReload/onRestart are not wired', async () => {
    const dir = await tempDir()
    const permissions = buildPermissions({ owner: ['channel.respond', 'session.admin'] })
    const { router } = makeRouter(dir, { permissions })
    const sent = captureOutbound(router)

    await router.route(inbound({ authorId: 'owner', text: '/reload', externalMessageId: 'm-r' }))
    await new Promise((r) => setTimeout(r, 10))

    // Unknown command → no reply, treated as a no-op (not an admin action).
    expect(sent).toHaveLength(0)
    expect(await router.executeCommand(KEY, 'reload', { invokerId: 'owner' })).toEqual({
      kind: 'unknown-command',
      name: 'reload',
    })
  })

  test('/help lists reload and restart when wired', async () => {
    const dir = await tempDir()
    const permissions = buildPermissions({ owner: ['channel.respond', 'session.admin'] })
    const { router } = makeRouter(dir, {
      permissions,
      onReload: async () => 'reloaded',
      onRestart: async () => 'restarting',
    })
    const sent = captureOutbound(router)

    await router.route(inbound({ authorId: 'owner', text: '/help', externalMessageId: 'm-h' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('/reload')
    expect(sent[0]!.text).toContain('/restart')
  })

  test('admin author can /reload via text prefix and gets the callback summary', async () => {
    const dir = await tempDir()
    let calls = 0
    const permissions = buildPermissions({ owner: ['channel.respond', 'session.admin'] })
    const { router } = makeRouter(dir, {
      permissions,
      onReload: async () => {
        calls++
        return 'Reloaded 1 subsystem(s).'
      },
    })
    const sent = captureOutbound(router)

    await router.route(inbound({ authorId: 'owner', text: '/reload', externalMessageId: 'm-r' }))
    await router.__testing!.flushDebounce(KEY)

    expect(calls).toBe(1)
    expect(sent).toEqual([{ text: 'Reloaded 1 subsystem(s).' }])
  })

  test('respond-capable author WITHOUT session.admin cannot /reload via text prefix', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    let calls = 0
    // member-shaped: has channel.respond + session.control but NOT session.admin.
    const permissions = buildPermissions({
      member: ['channel.respond', 'session.control'],
    })
    const { router } = makeRouter(dir, {
      permissions,
      logs,
      onReload: async () => {
        calls++
        return 'reloaded'
      },
    })
    const sent = captureOutbound(router)

    await router.route(inbound({ authorId: 'member', text: '/reload', externalMessageId: 'm-r' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(calls).toBe(0)
    expect(sent).toHaveLength(0)
    expect(logs.some((l) => l.includes('session.admin') && l.includes('author=member'))).toBe(true)
  })

  test('native executeCommand /restart gates on session.admin', async () => {
    const dir = await tempDir()
    let calls = 0
    const permissions = buildPermissions({
      owner: ['channel.respond', 'session.admin'],
      member: ['channel.respond', 'session.control'],
    })
    const { router } = makeRouter(dir, {
      permissions,
      onRestart: async () => {
        calls++
        return 'Restart scheduled.'
      },
    })

    const denied = await router.executeCommand(KEY, 'restart', { invokerId: 'member' })
    expect(denied).toEqual({ kind: 'permission-denied' })
    expect(calls).toBe(0)

    const allowed = await router.executeCommand(KEY, 'restart', { invokerId: 'owner' })
    expect(allowed).toEqual({ kind: 'handled', name: 'restart', reply: 'Restart scheduled.' })
    expect(calls).toBe(1)
  })

  test('/restart passes the live channel session context to onRestart', async () => {
    // given: a live session for the channel and a permissive owner
    const dir = await tempDir()
    const permissions = buildPermissions({ owner: ['channel.respond', 'session.admin'] })
    let invoked = false
    let captured: RestartCommandContext | undefined
    const { router } = makeRouter(dir, {
      permissions,
      transcriptPathFor: (sessionId) => `/tmp/fake/2026-01-01T00-00-00-000Z_${sessionId}.jsonl`,
      onRestart: async (ctx) => {
        invoked = true
        captured = ctx
        return 'restarting'
      },
    })
    await router.route(inbound({ authorId: 'owner', authorName: 'owner' }))
    await router.__testing!.flushDebounce(KEY)
    expect(router.liveCount()).toBe(1)

    // when
    const result = await router.executeCommand(KEY, 'restart', { invokerId: 'owner' })

    // then: ctx carries the originating session's identity + channel handoff key
    expect(result).toEqual({ kind: 'handled', name: 'restart', reply: 'restarting' })
    expect(invoked).toBe(true)
    expect(captured?.originatingSessionId).toBe('ses_fake_1')
    expect(captured?.originatingSessionFile).toBe('/tmp/fake/2026-01-01T00-00-00-000Z_ses_fake_1.jsonl')
    expect(captured?.handoffOrigin).toEqual({ kind: 'channel', key: KEY })
  })

  test('/restart stamps triggeringAuthorId from the command invoker, not the last live-turn speaker', async () => {
    // given: a session whose last turn was spoken by `stranger`, but /restart
    // is invoked by `owner` — the resume must follow the invoker's role.
    const dir = await tempDir()
    let captured: RestartCommandContext | undefined
    const { router } = makeRouter(dir, {
      transcriptPathFor: (sessionId) => `/tmp/fake/2026-01-01T00-00-00-000Z_${sessionId}.jsonl`,
      onRestart: async (ctx) => {
        captured = ctx
        return 'restarting'
      },
    })
    await router.route(inbound({ authorId: 'stranger', authorName: 'stranger' }))
    await router.__testing!.flushDebounce(KEY)
    expect(router.liveCount()).toBe(1)

    // when: the owner invokes /restart via the native dispatch path
    await router.executeCommand(KEY, 'restart', { invokerId: 'owner' })

    // then: the handoff carries the invoker, not the prior speaker
    expect(captured?.originatingSessionId).toBe('ses_fake_1')
    expect(captured?.triggeringAuthorId).toBe('owner')
  })

  test('/restart passes undefined context when no session is live', async () => {
    // given: no live session for the channel
    const dir = await tempDir()
    const permissions = buildPermissions({ owner: ['channel.respond', 'session.admin'] })
    let invoked = false
    let captured: RestartCommandContext | undefined
    const { router } = makeRouter(dir, {
      permissions,
      onRestart: async (ctx) => {
        invoked = true
        captured = ctx
        return 'restarting'
      },
    })
    expect(router.liveCount()).toBe(0)

    // when
    const result = await router.executeCommand(KEY, 'restart', { invokerId: 'owner' })

    // then: still handled, but with no resume context
    expect(result).toEqual({ kind: 'handled', name: 'restart', reply: 'restarting' })
    expect(invoked).toBe(true)
    expect(captured).toBeUndefined()
  })

  test('/reload and /restart do not require a live session', async () => {
    const dir = await tempDir()
    const permissions = buildPermissions({ owner: ['channel.respond', 'session.admin'] })
    const { router } = makeRouter(dir, {
      permissions,
      onReload: async () => 'reloaded',
      onRestart: async () => 'restarting',
    })

    expect(router.liveCount()).toBe(0)
    const reload = await router.executeCommand(KEY, 'reload', { invokerId: 'owner' })
    expect(reload).toEqual({ kind: 'handled', name: 'reload', reply: 'reloaded' })
    const restart = await router.executeCommand(KEY, 'restart', { invokerId: 'owner' })
    expect(restart).toEqual({ kind: 'handled', name: 'restart', reply: 'restarting' })
  })

  test('a /restart handler that reports unavailability is still handled, not unknown', async () => {
    const dir = await tempDir()
    const permissions = buildPermissions({ owner: ['channel.respond', 'session.admin'] })
    // Models the container-less wiring: the command is registered, so it stays
    // in /help and the manifest, but the handler reports it cannot act. The
    // surface must not depend on the environment — the command is always known.
    const { router } = makeRouter(dir, {
      permissions,
      onRestart: async () => 'Restart is unavailable in this environment.',
    })

    const result = await router.executeCommand(KEY, 'restart', { invokerId: 'owner' })
    expect(result).toEqual({
      kind: 'handled',
      name: 'restart',
      reply: 'Restart is unavailable in this environment.',
    })
  })
})

describe('ChannelRouter role-claim bypass', () => {
  type SentMsg = { adapter: string; chat: string; text: string | undefined }

  const denyAllPermissions: PermissionService = {
    has: () => false,
    resolveRole: () => 'guest',
    compareRoleSeverity: () => undefined,
    describe: () => ({ role: 'guest', permissions: [] }),
    replaceRoles: () => {},
  }

  test('DM with claim code → handler is invoked, reply sent, no session created, gate bypassed', async () => {
    const dir = await tempDir()
    const sent: SentMsg[] = []
    let calls = 0
    const claimHandler: ClaimHandler = async (input) => {
      calls++
      expect(input.isDm).toBe(true)
      expect(input.text).toContain('claim-')
      return { kind: 'consumed', reply: 'Welcome owner!' }
    }
    const { router, sessions } = makeRouter(dir, {
      permissions: denyAllPermissions,
      claimHandler,
    })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ adapter: msg.adapter, chat: msg.chat, text: msg.text })
      return { ok: true }
    })

    await router.route(inbound({ isDm: true, text: 'here you go: claim-AAAA-BBBB' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(calls).toBe(1)
    expect(sent).toEqual([{ adapter: 'discord-bot', chat: 'c1', text: 'Welcome owner!' }])
    expect(sessions).toHaveLength(0)
    expect(router.liveCount()).toBe(0)
  })

  test('non-DM (group/channel) with claim code → handler IS invoked, reply sent, no session created, gate bypassed', async () => {
    const dir = await tempDir()
    const sent: SentMsg[] = []
    let calls = 0
    const claimHandler: ClaimHandler = async (input) => {
      calls++
      expect(input.isDm).toBe(false)
      expect(input.text).toContain('claim-')
      return { kind: 'consumed', reply: 'Welcome owner!' }
    }
    const { router, sessions } = makeRouter(dir, {
      permissions: denyAllPermissions,
      claimHandler,
    })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ adapter: msg.adapter, chat: msg.chat, text: msg.text })
      return { ok: true }
    })

    await router.route(inbound({ isDm: false, text: 'claim-AAAA-BBBB' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(calls).toBe(1)
    expect(sent).toEqual([{ adapter: 'discord-bot', chat: 'c1', text: 'Welcome owner!' }])
    expect(sessions).toHaveLength(0)
    expect(router.liveCount()).toBe(0)
  })

  test('DM without a claim code → handler NOT invoked, falls through to gate (denied)', async () => {
    const dir = await tempDir()
    let calls = 0
    const claimHandler: ClaimHandler = async () => {
      calls++
      return { kind: 'consumed', reply: 'x' }
    }
    const { router, sessions } = makeRouter(dir, {
      permissions: denyAllPermissions,
      claimHandler,
    })

    await router.route(inbound({ isDm: true, text: 'hi there' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(calls).toBe(0)
    expect(sessions).toHaveLength(0)
  })

  test('handler returns fallthrough → message proceeds to normal gate (denied here)', async () => {
    const dir = await tempDir()
    const claimHandler: ClaimHandler = async () => ({ kind: 'fallthrough' })
    const { router, sessions } = makeRouter(dir, {
      permissions: denyAllPermissions,
      claimHandler,
    })

    await router.route(inbound({ isDm: true, text: 'claim-AAAA-BBBB' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(sessions).toHaveLength(0)
  })

  test('handler returns fail → reply sent, no session created', async () => {
    const dir = await tempDir()
    const sent: SentMsg[] = []
    const claimHandler: ClaimHandler = async () => ({
      kind: 'fail',
      reply: 'This claim has expired. Run typeclaw role claim again.',
    })
    const { router, sessions } = makeRouter(dir, {
      permissions: denyAllPermissions,
      claimHandler,
    })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ adapter: msg.adapter, chat: msg.chat, text: msg.text })
      return { ok: true }
    })

    await router.route(inbound({ isDm: true, text: 'claim-AAAA-BBBB' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('expired')
    expect(sessions).toHaveLength(0)
  })

  test('no claimHandler registered → claim DMs are dropped by the channel.respond gate', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir, { permissions: denyAllPermissions })

    await router.route(inbound({ isDm: true, text: 'claim-AAAA-BBBB' }))
    await new Promise((r) => setTimeout(r, 10))

    expect(sessions).toHaveLength(0)
  })
})

describe('ChannelRouter injectSubagentCompletionReminder', () => {
  test('matching parentSessionId wakes the channel session with a <system-reminder> turn even when no user inbound is queued', async () => {
    // given a live channel session whose sessionId is the factory-stamped `ses_fake_1`
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)
    expect(sessions).toHaveLength(1)
    const initialPromptCount = sessions[0]!.prompts.length

    // when a subagent completes for that exact sessionId
    const result = router.injectSubagentCompletionReminder({
      parentSessionId: 'ses_fake_1',
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 5_000,
    })

    // then the router reports delivered and the next drain iteration runs
    expect(result.kind).toBe('delivered')
    await waitFor(() => sessions[0]!.prompts.length > initialPromptCount)
    const reminderText = sessions[0]!.prompts[sessions[0]!.prompts.length - 1] ?? ''
    expect(reminderText).toContain('<system-reminder>')
    expect(reminderText).toContain('explorer')
    expect(reminderText).toContain('bg_xyz')
    expect(reminderText).toContain('subagent_output')
  })

  test('reminder text carries the channel-aware nudge (channel_reply, invisible, NO_REPLY)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    router.injectSubagentCompletionReminder({
      parentSessionId: 'ses_fake_1',
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 5_000,
    })
    await waitFor(() => sessions[0]!.prompts.length >= 2)

    const reminderText = sessions[0]!.prompts[sessions[0]!.prompts.length - 1] ?? ''
    expect(reminderText).toContain('channel_reply')
    expect(reminderText).toContain('invisible')
    expect(reminderText).toContain('NO_REPLY')
  })

  test('a github session reminder carries the formal-review carve-out (gh api /reviews)', async () => {
    // given a live github session (sessions are stamped ses_fake_<n> by creation order)
    const dir = await tempDir()
    const githubKey: ChannelKey = { adapter: 'github', workspace: 'acme/repo', chat: 'pr:7', thread: null }
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound({ adapter: 'github', workspace: 'acme/repo', chat: 'pr:7' }))
    await router.__testing!.flushDebounce(githubKey)
    expect(sessions).toHaveLength(1)

    // when a reviewer subagent completes for it
    const result = router.injectSubagentCompletionReminder({
      parentSessionId: 'ses_fake_1',
      subagent: 'reviewer',
      taskId: 'bg_gh',
      ok: true,
      durationMs: 5_000,
    })
    expect(result.kind).toBe('delivered')
    await waitFor(() => sessions[0]!.prompts.length >= 2)

    // then the reminder names the formal-review API path and keeps the base nudge
    const reminderText = sessions[0]!.prompts[sessions[0]!.prompts.length - 1] ?? ''
    expect(reminderText).toContain('channel_reply')
    expect(reminderText).toContain('/reviews')
    expect(reminderText).toMatch(/formal review/i)
  })

  test('a discord session reminder does NOT carry the github carve-out (no gh api leakage)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    router.injectSubagentCompletionReminder({
      parentSessionId: 'ses_fake_1',
      subagent: 'reviewer',
      taskId: 'bg_dc',
      ok: true,
      durationMs: 5_000,
    })
    await waitFor(() => sessions[0]!.prompts.length >= 2)

    const reminderText = sessions[0]!.prompts[sessions[0]!.prompts.length - 1] ?? ''
    expect(reminderText).toContain('channel_reply')
    expect(reminderText).not.toContain('/reviews')
    expect(reminderText).not.toContain('gh api')
  })

  test('non-matching parentSessionId returns no-live-session and does not drain', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)
    const promptsBefore = sessions[0]!.prompts.length

    const result = router.injectSubagentCompletionReminder({
      parentSessionId: 'someone-else',
      subagent: 'explorer',
      taskId: 'bg_other',
      ok: true,
      durationMs: 100,
    })

    expect(result).toEqual({ kind: 'no-live-session' })
    await new Promise((r) => setTimeout(r, 10))
    expect(sessions[0]!.prompts.length).toBe(promptsBefore)
  })

  test('channel-key fallback wakes the rolled-over session when the original parentSessionId is gone', async () => {
    // given a session that rolls over while a background subagent runs:
    // m1 opens ses_fake_1; after the freshness TTL, m2 opens ses_fake_2 for the
    // same channel key. The completion broadcast still carries ses_fake_1.
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)
    nowRef.value = 1000 + SESSION_FRESHNESS_TTL_MS + 1
    await router.route(inbound({ externalMessageId: 'm2', text: 'still there?' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions).toHaveLength(2)
    const promptsBefore = sessions[1]!.prompts.length

    // when the subagent completes carrying the STALE sessionId plus the channel key
    const result = router.injectSubagentCompletionReminder({
      parentSessionId: 'ses_fake_1',
      subagent: 'reviewer',
      taskId: 'bg_rev',
      ok: true,
      durationMs: 360_000,
      channelKey: KEY,
    })

    // then it is delivered to the live successor session, not dropped
    expect(result.kind).toBe('delivered')
    await waitFor(() => sessions[1]!.prompts.length > promptsBefore)
    const reminderText = sessions[1]!.prompts[sessions[1]!.prompts.length - 1] ?? ''
    expect(reminderText).toContain('<system-reminder>')
    expect(reminderText).toContain('bg_rev')
    expect(reminderText).toContain('subagent_output')
  })

  test('exact parentSessionId match is preferred over the channel-key fallback', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)
    const promptsBefore = sessions[0]!.prompts.length

    const result = router.injectSubagentCompletionReminder({
      parentSessionId: 'ses_fake_1',
      subagent: 'reviewer',
      taskId: 'bg_exact',
      ok: true,
      durationMs: 5_000,
      channelKey: KEY,
    })

    expect(result.kind).toBe('delivered')
    await waitFor(() => sessions[0]!.prompts.length > promptsBefore)
    expect(sessions[0]!.prompts[sessions[0]!.prompts.length - 1] ?? '').toContain('bg_exact')
  })

  test('no channelKey and no matching sessionId still returns no-live-session', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    const result = router.injectSubagentCompletionReminder({
      parentSessionId: 'someone-else',
      subagent: 'reviewer',
      taskId: 'bg_nokey',
      ok: true,
      durationMs: 100,
    })

    expect(result).toEqual({ kind: 'no-live-session' })
  })

  test('failed subagent reminder reaches the channel session with FAILED marker and error string', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)
    const initial = sessions[0]!.prompts.length

    router.injectSubagentCompletionReminder({
      parentSessionId: 'ses_fake_1',
      subagent: 'scout',
      taskId: 'bg_err',
      ok: false,
      durationMs: 1_500,
      error: 'provider rate limit',
    })

    await waitFor(() => sessions[0]!.prompts.length > initial)
    const text = sessions[0]!.prompts[sessions[0]!.prompts.length - 1] ?? ''
    expect(text).toContain('FAILED')
    expect(text).toContain('provider rate limit')
    expect(text).toContain('channel_reply')
  })

  test('reminder queued during a same-turn user inbound coalesces into the SAME drain iteration (prepended into the prompt body)', async () => {
    // The drain loop splices `pendingSystemReminders` alongside the
    // promptQueue at the top of each iteration, so a reminder pushed
    // while a user inbound is also pending should appear in the same
    // composed turn text rather than triggering a second prompt(). This
    // pins the composition behavior (system reminder leads, then user
    // inbound) which the channel-router's docstring on
    // `pendingSystemReminders` calls out as load-bearing.
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)
    const promptsAfterFirstUser = sessions[0]!.prompts.length
    expect(promptsAfterFirstUser).toBe(1)

    // Queue another user inbound (held by debounce) then inject the reminder
    // before the debounce fires.
    await router.route(inbound({ externalMessageId: 'm2', text: 'follow up' }))
    router.injectSubagentCompletionReminder({
      parentSessionId: 'ses_fake_1',
      subagent: 'explorer',
      taskId: 'bg_coalesce',
      ok: true,
      durationMs: 100,
    })

    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts.length).toBe(2)
    const combined = sessions[0]!.prompts[1] ?? ''
    expect(combined).toContain('<system-reminder>')
    expect(combined).toContain('bg_coalesce')
    expect(combined).toContain('follow up')
    expect(combined.indexOf('<system-reminder>')).toBeLessThan(combined.indexOf('follow up'))
  })

  test('reminder-only drain with non-empty contextBuffer never emits an EMPTY `## Current message` header', async () => {
    // Regression: when a reminder woke drain() with an empty promptQueue
    // and a non-empty contextBuffer, composeTurnPrompt used to print
    // `## Current message (addressed to you)` with zero lines under it.
    // Persona-rich models read the dangling header as proof there was a
    // new user message they were failing to see and hallucinated content
    // to reply to. The header is now batch-gated.
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    // given: an engaged inbound creates the live session, then an observed
    // inbound from a different author lands in the contextBuffer (engagement
    // 'observe' branch — the contextBuffer is what flushes on the next drain)
    await router.route(inbound({ isBotMention: true, authorId: 'carol', authorName: 'carol', text: 'hi bot' }))
    await router.__testing!.flushDebounce(KEY)
    await router.route(inbound({ isBotMention: false, authorId: 'bob', authorName: 'bob', text: 'side chatter' }))
    const promptsBeforeReminder = sessions[0]!.prompts.length

    // when: a subagent completion fires while the promptQueue is empty
    router.injectSubagentCompletionReminder({
      parentSessionId: 'ses_fake_1',
      subagent: 'explorer',
      taskId: 'bg_empty_current',
      ok: true,
      durationMs: 100,
    })
    await waitFor(() => sessions[0]!.prompts.length > promptsBeforeReminder)

    // then: the reminder prompt carries the reminder + observed context,
    // but the `## Current message` header is absent because there is no
    // queued inbound to live under it
    const reminderPrompt = sessions[0]!.prompts[sessions[0]!.prompts.length - 1] ?? ''
    expect(reminderPrompt).toContain('<system-reminder>')
    expect(reminderPrompt).toContain('bg_empty_current')
    expect(reminderPrompt).toContain('## Recent context')
    expect(reminderPrompt).toContain('side chatter')
    expect(reminderPrompt).not.toContain('## Current message')
    // The history-interpretation note is batch-gated like the header: a
    // reminder-only drain has an empty promptQueue, so it must stay absent.
    expect(reminderPrompt).not.toContain('if earlier turns appear above')
  })

  test('referenceContext renders quote lines above the current author line and truncates at render time', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const longQuote = `${'x'.repeat(QUOTED_REPLY_EXCERPT_MAX_CHARS)}tail`

    await router.route(
      inbound({
        text: 'actual reply',
        referenceContext: {
          kind: 'reply',
          sources: [
            { adapter: 'discord-bot', authorId: 'bob', authorName: 'Bob', text: longQuote },
            { adapter: 'discord-bot', authorId: 'carol', authorName: 'Carol', text: 'linked context' },
          ],
        },
      }),
    )
    await router.__testing!.flushDebounce(KEY)

    const prompt = sessions[0]!.prompts[0] ?? ''
    expect(prompt).toContain(`> <@bob>: ${'x'.repeat(QUOTED_REPLY_EXCERPT_MAX_CHARS - 1)}…`)
    expect(prompt).not.toContain('tail')
    expect(prompt).toContain('> <@carol>: linked context')
    expect(prompt.indexOf('> <@bob>:')).toBeLessThan(prompt.indexOf(`<@alice> (alice): actual reply`))
  })

  test('share-only Slack referenceContext renders even when raw text is empty', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(
      inbound({
        adapter: 'slack-bot',
        workspace: 'T0ACME',
        chat: 'C0CHANNEL',
        text: '',
        referenceContext: {
          kind: 'quote',
          sources: [{ adapter: 'slack-bot', authorId: 'UBOB', authorName: 'Bob', text: 'shared message body' }],
        },
      }),
    )
    await router.__testing!.flushDebounce({
      adapter: 'slack-bot',
      workspace: 'T0ACME',
      chat: 'C0CHANNEL',
      thread: null,
    })

    const prompt = sessions[0]!.prompts[0] ?? ''
    expect(prompt).toContain('> <@UBOB>: shared message body')
    expect(prompt).toContain('<@alice> (alice): ')
    expect(prompt.indexOf('> <@UBOB>: shared message body')).toBeLessThan(prompt.indexOf('<@alice> (alice): '))
  })

  test("reminder lookup skips destroyed sessions (channels GC'd while subagent was running drops the reminder)", async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.stop()

    const result = router.injectSubagentCompletionReminder({
      parentSessionId: 'ses_fake_1',
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 100,
    })
    expect(result).toEqual({ kind: 'no-live-session' })
  })

  test('reminder-only drain restores live origin author (single-speaker prior turn): originRef carries the prior author during prompt()', async () => {
    // The fix's actual invariant is that during the reminder turn,
    // `live.originRef.current.lastInboundAuthorId` is the prior speaker
    // (so tool.before consumers gate on the right author). Asserting on a
    // downstream follow-up inbound doesn't prove this — route() builds its
    // permission origin from event.authorId, not from originRef — so we
    // assert directly on the origin snapshot during prompt().
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ authorId: 'alice', text: 'do the thing' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(1)

    // Capture the origin at the moment FakeSession.prompt() fires for the
    // reminder turn — drain() sets originRef.current immediately before
    // calling prompt(), so observing here is observing the value
    // tool.before would see.
    let originDuringReminder: SessionOrigin | undefined
    sessions[0]!.onPrompt = () => {
      originDuringReminder = router.__testing!.getLiveOriginSnapshot(KEY)
    }

    router.injectSubagentCompletionReminder({
      parentSessionId: 'ses_fake_1',
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 100,
    })
    await waitFor(() => sessions[0]!.prompts.length >= 2)

    expect(originDuringReminder).toBeDefined()
    expect(originDuringReminder!.kind).toBe('channel')
    if (originDuringReminder!.kind !== 'channel') throw new Error('unreachable')
    expect(originDuringReminder!.lastInboundAuthorId).toBe('alice')
  })

  test('reminder-only drain restores LAST speaker from a multi-author prior turn, not the first inserted', async () => {
    // Pins Oracle's finding that "first-inserted Set member" semantics
    // would silently misroute author-scoped roles on multi-author turns.
    // With alice then bob speaking in the same turn, normal-turn semantics
    // set currentTurnAuthorId = bob (batch[batch.length - 1]). The
    // reminder-only restore must match — otherwise a role like
    // `author:U_BOB` would resolve to alice and deny.
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    // Two engaged inbounds debounced into the same batch
    await router.route(inbound({ authorId: 'alice', externalMessageId: 'm1', text: 'first' }))
    await router.route(inbound({ authorId: 'bob', externalMessageId: 'm2', text: 'second' }))
    await router.__testing!.flushDebounce(KEY)
    expect(sessions[0]!.prompts).toHaveLength(1)

    let originDuringReminder: SessionOrigin | undefined
    sessions[0]!.onPrompt = () => {
      originDuringReminder = router.__testing!.getLiveOriginSnapshot(KEY)
    }

    router.injectSubagentCompletionReminder({
      parentSessionId: 'ses_fake_1',
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 100,
    })
    await waitFor(() => sessions[0]!.prompts.length >= 2)

    expect(originDuringReminder).toBeDefined()
    if (originDuringReminder!.kind !== 'channel') throw new Error('unreachable')
    expect(originDuringReminder!.lastInboundAuthorId).toBe('bob')
  })

  test('reminder injected before the first user-turn drain coalesces into the first batch and still carries the triggering author', async () => {
    // Not a true reminder-only drain test (alice's inbound is already in
    // promptQueue from the unflushed route() call above, so the drain's
    // batch is non-empty). This pins the SOFTER invariant that matters in
    // production today: a reminder arriving before the first user-turn
    // drain doesn't leave the resulting turn without an author identity.
    // The session's `lastTurnAuthorId`/`lastTurnAuthorIds` seed from
    // `triggeringAuthorId` is what guarantees this — without the seed, a
    // hypothetical reminder-only path on a fresh session would observe
    // empty author state. The cold-start reminder-only path itself is
    // unreachable through the public API (no caller spawns a subagent
    // before any inbound has been routed), so this test exercises the
    // closest reachable proxy and the seed is verified directly by the
    // sticky-credit test below.
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ authorId: 'alice', text: 'first' }))

    let originDuringReminder: SessionOrigin | undefined
    sessions[0]!.onPrompt = () => {
      if (originDuringReminder === undefined) {
        originDuringReminder = router.__testing!.getLiveOriginSnapshot(KEY)
      }
    }

    router.injectSubagentCompletionReminder({
      parentSessionId: 'ses_fake_1',
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 100,
    })
    await waitFor(() => sessions[0]!.prompts.length >= 1)

    expect(originDuringReminder).toBeDefined()
    if (originDuringReminder!.kind !== 'channel') throw new Error('unreachable')
    expect(originDuringReminder!.lastInboundAuthorId).toBe('alice')
  })

  test('lastTurnAuthorIds Set stays in sync with lastTurnAuthorId string at session creation (symmetric seeding from triggeringAuthorId)', async () => {
    // Pins the load-bearing invariant the cold-start reminder-only path
    // depends on. Asserts directly on the seeded state via __testing
    // because the bug-trigger condition (a reminder firing before any
    // user-turn drain) is unreachable through the public API. If only
    // the string field were seeded, send()'s grantStickyForReplyTargets
    // fallback (`currentTurnAuthorIds.size > 0 ? currentTurnAuthorIds :
    // lastTurnAuthorIds`) would compute an empty `targetIds` on a
    // reminder-only turn and silently drop the grant for the seeded
    // author — silent because the reply itself succeeds. A direct
    // assertion on the state is the smallest test that pins the actual
    // invariant; a regression in the seeding flips this test red
    // immediately, where an integration-level sticky-credit test could
    // still pass via the drain finally-block populating lastTurnAuthorIds
    // before the bug-relevant path runs.
    const dir = await tempDir()
    const { router } = makeRouter(dir)

    // ensureLive runs synchronously inside route() (via the await on the
    // inbound classifier path) — by the time route() returns, the live
    // session exists with its seeded author state, even though the first
    // drain is still pending behind the debounce.
    await router.route(inbound({ authorId: 'alice', text: 'do the thing' }))

    const state = router.__testing!.getLiveAuthorState(KEY)
    expect(state).toBeDefined()
    expect(state!.lastTurnAuthorId).toBe('alice')
    expect(state!.lastTurnAuthorIds).toEqual(['alice'])
  })

  test('runIdleGc does not evict a session whose drain was just woken by a reminder injection (in-flight drain protection)', async () => {
    // Observable invariant: after `injectSubagentCompletionReminder`
    // returns, a GC tick must not evict the session even if its
    // `lastInboundAt` is already stale. In practice this passes via the
    // existing `if (live.draining) continue` guard because
    // injectSubagentCompletionReminder calls drain() synchronously which
    // sets draining=true before the GC tick can observe pendingSystemReminders.
    // The `pendingSystemReminders.length > 0` guard added alongside is a
    // forward-compat redundancy for any future caller that queues a
    // reminder without firing drain — not exercised by this test (and
    // not exercisable through the public API today). The test name
    // reflects what is actually covered.
    const dir = await tempDir()
    const nowRef = { value: 1_000_000 }
    const { router } = makeRouter(dir, { nowRef })
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)
    expect(router.liveCount()).toBe(1)

    nowRef.value += SESSION_IDLE_MS + 1
    router.injectSubagentCompletionReminder({
      parentSessionId: 'ses_fake_1',
      subagent: 'explorer',
      taskId: 'bg_xyz',
      ok: true,
      durationMs: 100,
    })

    await router.__testing!.runIdleGc()
    expect(router.liveCount()).toBe(1)
  })
})

describe('ChannelRouter quote-anchor on outbound', () => {
  test('does NOT prepend a quote when the reply lands within the threshold and nothing intervened', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1_000_000 }
    const sent: string[] = []
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(inbound({ text: 'are you there?' }))
    await router.__testing!.flushDebounce(KEY)

    nowRef.value += 500
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'yes' })
    expect(sent).toEqual(['yes'])
  })

  test('does NOT anchor a cold-start first turn just because prefetched scrollback exists (PR #374 regression)', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1_000_000 }
    const sent: string[] = []
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })
    router.registerHistory('discord-bot', 'g1', async () => ({
      ok: true,
      messages: [
        historyMessage({ externalMessageId: 'h1', text: 'old chatter 1' }),
        historyMessage({ externalMessageId: 'h2', text: 'old chatter 2' }),
      ],
    }))

    await router.route(inbound({ text: 'hey bot', authorName: 'Alice' }))
    await router.__testing!.flushDebounce(KEY)

    nowRef.value += 500
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'hi back' })
    expect(sent).toEqual(['hi back'])
  })

  test('does NOT prepend a quote after a long delay when no message intervened', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1_000_000 }
    const sent: string[] = []
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(inbound({ text: 'are you there?', authorId: 'U_ALICE', authorName: 'Alice' }))
    await router.__testing!.flushDebounce(KEY)

    nowRef.value += 60_000
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'yes I am here' })
    expect(sent).toEqual(['yes I am here'])
  })

  test('prepends a quote on a quote-mode adapter when an observed message landed between inbound and reply, even within the threshold', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1_000_000 }
    const sent: string[] = []
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('slack-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(
      inbound({ adapter: 'slack-bot', text: 'cron status?', authorId: 'U_ALICE', authorName: 'Alice' }),
    )
    nowRef.value += 100
    await router.route(
      inbound({
        adapter: 'slack-bot',
        isBotMention: false,
        externalMessageId: 'm-observed',
        authorId: 'bob',
        authorName: 'bob',
        text: 'unrelated chatter',
      }),
    )
    await router.__testing!.flushDebounce(SLACK_KEY)
    nowRef.value += 200

    await router.send({ adapter: 'slack-bot', workspace: 'g1', chat: 'c1', text: 'still blocked' })
    expect(sent[0]).toContain('> <@U_ALICE>: cron status?')
    expect(sent[0]).toContain('still blocked')
  })

  test('prepends a quote on a quote-mode adapter when an observed message lands after prompt drain but before outbound reply', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1_000_000 }
    const sent: string[] = []
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('slack-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(
      inbound({ adapter: 'slack-bot', text: 'deploy status?', authorId: 'U_ALICE', authorName: 'Alice' }),
    )
    await router.__testing!.flushDebounce(SLACK_KEY)
    nowRef.value += 100
    await router.route(
      inbound({
        adapter: 'slack-bot',
        isBotMention: false,
        externalMessageId: 'm-observed-after-drain',
        authorId: 'bob',
        authorName: 'bob',
        text: 'also waiting',
      }),
    )
    nowRef.value += 200

    await router.send({ adapter: 'slack-bot', workspace: 'g1', chat: 'c1', text: 'still deploying' })
    expect(sent).toEqual(['> <@U_ALICE>: deploy status?\n\nstill deploying'])
  })

  test('Telegram: anchors via native replyTo (not a blockquote) when a message intervened', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1_000_000 }
    const sent: OutboundMessage[] = []
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('telegram-bot', 'g1', async (msg) => {
      sent.push(msg)
      return { ok: true }
    })

    await router.route(
      inbound({
        adapter: 'telegram-bot',
        text: 'cron status?',
        authorId: 'U_ALICE',
        authorName: 'Alice',
        externalMessageId: '500',
      }),
    )
    nowRef.value += 100
    await router.route(
      inbound({
        adapter: 'telegram-bot',
        isBotMention: false,
        externalMessageId: '501',
        authorId: 'bob',
        authorName: 'bob',
        text: 'unrelated chatter',
      }),
    )
    await router.__testing!.flushDebounce({ adapter: 'telegram-bot', workspace: 'g1', chat: 'c1', thread: null })
    nowRef.value += 200

    await router.send({ adapter: 'telegram-bot', workspace: 'g1', chat: 'c1', text: 'still blocked' })
    expect(sent[0]?.replyTo).toEqual({
      externalMessageId: '500',
      source: { adapter: 'telegram-bot', authorId: 'U_ALICE', authorName: 'Alice', text: 'cron status?' },
    })
    expect(sent[0]?.text).toBe('still blocked')
  })

  test('Telegram: consecutive reply (nothing intervened) sends plainly — no replyTo, no quote', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1_000_000 }
    const sent: OutboundMessage[] = []
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('telegram-bot', 'g1', async (msg) => {
      sent.push(msg)
      return { ok: true }
    })

    await router.route(
      inbound({
        adapter: 'telegram-bot',
        text: 'cron status?',
        authorId: 'U_ALICE',
        authorName: 'Alice',
        externalMessageId: '500',
      }),
    )
    await router.__testing!.flushDebounce({ adapter: 'telegram-bot', workspace: 'g1', chat: 'c1', thread: null })
    nowRef.value += 200

    await router.send({ adapter: 'telegram-bot', workspace: 'g1', chat: 'c1', text: 'all good' })
    expect(sent[0]?.replyTo).toBeUndefined()
    expect(sent[0]?.text).toBe('all good')
  })

  test('Discord: anchors via native replyTo (not a blockquote) when a message intervened', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1_000_000 }
    const sent: OutboundMessage[] = []
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg)
      return { ok: true }
    })

    await router.route(
      inbound({ text: 'cron status?', authorId: 'U_ALICE', authorName: 'Alice', externalMessageId: 'd-500' }),
    )
    nowRef.value += 100
    await router.route(
      inbound({
        isBotMention: false,
        externalMessageId: 'd-501',
        authorId: 'bob',
        authorName: 'bob',
        text: 'unrelated chatter',
      }),
    )
    await router.__testing!.flushDebounce(KEY)
    nowRef.value += 200

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'still blocked' })
    expect(sent[0]?.replyTo?.externalMessageId).toBe('d-500')
    expect(sent[0]?.text).toBe('still blocked')
    expect(sent[0]?.text).not.toContain('>')
  })

  test('anchors only the FIRST send of a multi-part reply; subsequent sends in the same turn are bare', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1_000_000 }
    const sent: string[] = []
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('slack-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(
      inbound({ adapter: 'slack-bot', text: 'walk me through it', authorId: 'U_ALICE', authorName: 'Alice' }),
    )
    nowRef.value += 100
    await router.route(
      inbound({
        adapter: 'slack-bot',
        isBotMention: false,
        externalMessageId: 'm-observed',
        authorId: 'bob',
        authorName: 'bob',
        text: 'following along',
      }),
    )
    await router.__testing!.flushDebounce(SLACK_KEY)
    nowRef.value += 60_000

    await router.send({ adapter: 'slack-bot', workspace: 'g1', chat: 'c1', text: 'first chunk' })
    await router.send({ adapter: 'slack-bot', workspace: 'g1', chat: 'c1', text: 'second chunk' })
    await router.send({ adapter: 'slack-bot', workspace: 'g1', chat: 'c1', text: 'third chunk' })
    expect(sent).toEqual(['> <@U_ALICE>: walk me through it\n\nfirst chunk', 'second chunk', 'third chunk'])
  })

  test('resets per turn so the next batch can anchor again', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1_000_000 }
    const sent: string[] = []
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('slack-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(
      inbound({
        adapter: 'slack-bot',
        text: 'turn one',
        authorId: 'U_ALICE',
        authorName: 'Alice',
        externalMessageId: 'm1',
      }),
    )
    nowRef.value += 100
    await router.route(
      inbound({
        adapter: 'slack-bot',
        isBotMention: false,
        externalMessageId: 'm1-observed',
        authorId: 'bob',
        authorName: 'bob',
        text: 'turn one chatter',
      }),
    )
    await router.__testing!.flushDebounce(SLACK_KEY)
    nowRef.value += 60_000
    await router.send({ adapter: 'slack-bot', workspace: 'g1', chat: 'c1', text: 'reply one' })

    await router.route(
      inbound({
        adapter: 'slack-bot',
        text: 'turn two',
        authorId: 'U_ALICE',
        authorName: 'Alice',
        externalMessageId: 'm2',
      }),
    )
    nowRef.value += 100
    await router.route(
      inbound({
        adapter: 'slack-bot',
        isBotMention: false,
        externalMessageId: 'm2-observed',
        authorId: 'bob',
        authorName: 'bob',
        text: 'turn two chatter',
      }),
    )
    await router.__testing!.flushDebounce(SLACK_KEY)
    nowRef.value += 60_000
    await router.send({ adapter: 'slack-bot', workspace: 'g1', chat: 'c1', text: 'reply two' })

    expect(sent[0]).toBe('> <@U_ALICE>: turn one\n\nreply one')
    expect(sent[1]).toBe('> <@U_ALICE>: turn two\n\nreply two')
  })

  test('respects an adapter config opting out via quotedReply.enabled: false', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1_000_000 }
    const sent: string[] = []
    const config: ChannelAdapterConfig = {
      ...baseConfig,
      quotedReply: { enabled: false, queueDelayMs: 0 },
    }
    const { router } = makeRouter(dir, { nowRef, config })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(inbound({ text: 'quiet please', authorName: 'Alice' }))
    await router.__testing!.flushDebounce(KEY)
    nowRef.value += 600_000

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'sure' })
    expect(sent).toEqual(['sure'])
  })

  test('attachments-only sends still anchor (the bare anchor stands alone as the message body)', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1_000_000 }
    const sent: Array<{ text: string | undefined; attachments: unknown }> = []
    const { router } = makeRouter(dir, { nowRef })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push({ text: msg.text, attachments: msg.attachments })
      return { ok: true }
    })

    await router.route(inbound({ text: 'screenshot pls', authorId: 'U_ALICE', authorName: 'Alice' }))
    nowRef.value += 100
    await router.route(
      inbound({
        isBotMention: false,
        externalMessageId: 'm-observed',
        authorId: 'bob',
        authorName: 'bob',
        text: 'also curious',
      }),
    )
    await router.__testing!.flushDebounce(KEY)
    nowRef.value += 60_000

    await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      attachments: [{ path: '/agent/screen.png' }],
    })
    expect(sent[0]?.text).toBe('> <@U_ALICE>: screenshot pls')
  })
})

describe('ChannelRouter per-turn wall-clock anchor', () => {
  test('every composed turn carries a leading <current-time> block before any other content', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ externalMessageId: 'engage', text: 'what day is it' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    const prompt = sessions[0]!.prompts[0]!
    expect(prompt.startsWith('<current-time>')).toBe(true)
    const close = prompt.indexOf('</current-time>')
    expect(close).toBeGreaterThan(-1)
    const englishDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const anchor = prompt.slice(0, close + '</current-time>'.length)
    expect(englishDays.some((d) => anchor.includes(d))).toBe(true)
    expect(prompt).toContain('what day is it')
  })
})

describe('ChannelRouter per-turn live role anchor', () => {
  test('a non-owner turn carries a <your-role> anchor reflecting the resolved role', async () => {
    const dir = await tempDir()
    const guestPermissions: PermissionService = {
      has: () => true,
      resolveRole: () => 'guest',
      compareRoleSeverity: () => undefined,
      describe: () => ({ role: 'guest', permissions: [] }),
      replaceRoles: () => {},
    }
    const { router, sessions } = makeRouter(dir, { permissions: guestPermissions })

    await router.route(inbound({ externalMessageId: 'engage', text: 'save me a copy' }))
    await router.__testing!.flushDebounce(KEY)

    const prompt = sessions[0]!.prompts[0]!
    expect(prompt).toContain('<your-role authority="current-speaker">guest</your-role>')
    expect(prompt).toContain('save me a copy')
  })

  test('an owner turn omits the role anchor (unconstrained default)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    await router.route(inbound({ externalMessageId: 'engage', text: 'do the thing' }))
    await router.__testing!.flushDebounce(KEY)

    const prompt = sessions[0]!.prompts[0]!
    expect(prompt).not.toContain('<your-role>')
  })
})

describe('ChannelRouter post-tool follow-up suppression', () => {
  function afterToolContext(
    toolName: string,
    result: { ok: boolean; continue?: boolean },
    isError: boolean,
    replyText?: string,
  ): AfterToolCallContext {
    const toolResult = {
      content: [{ type: 'text' as const, text: 'ignored' }],
      details: result,
    }
    const args = replyText !== undefined ? { text: replyText } : {}
    return {
      assistantMessage: assistantMessage('') as AfterToolCallContext['assistantMessage'],
      toolCall: { type: 'toolCall', id: 'tc1', name: toolName, arguments: args } as AfterToolCallContext['toolCall'],
      args,
      result: toolResult as AfterToolCallContext['result'],
      isError,
      context: { systemPrompt: '', messages: [], tools: [] },
    }
  }

  async function liveAgentAfterRoute(dir: string): Promise<FakeSession['agent']> {
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)
    return sessions[0]!.agent
  }

  test('aborts the run after a successful channel_reply so no post-tool follow-up LLM call runs', async () => {
    // given a live channel session with the terminal hook installed
    const agent = await liveAgentAfterRoute(await tempDir())
    expect(agent.afterToolCall).toBeDefined()

    // when channel_reply succeeds (details.ok === true, not an error)
    await agent.afterToolCall!(afterToolContext('channel_reply', { ok: true }, false))

    // then the run's abort signal is fired — the follow-up stream sees it aborted
    expect(agent.signal.aborted).toBe(true)
  })

  test('does NOT abort when channel_reply opts out with continue: true', async () => {
    const agent = await liveAgentAfterRoute(await tempDir())
    await agent.afterToolCall!(afterToolContext('channel_reply', { ok: true, continue: true }, false))
    expect(agent.signal.aborted).toBe(false)
  })

  test('does NOT abort when channel_reply was rejected (details.ok === false)', async () => {
    const agent = await liveAgentAfterRoute(await tempDir())
    await agent.afterToolCall!(afterToolContext('channel_reply', { ok: false }, false))
    expect(agent.signal.aborted).toBe(false)
  })

  test('does NOT abort when channel_reply tool result is an error', async () => {
    const agent = await liveAgentAfterRoute(await tempDir())
    await agent.afterToolCall!(afterToolContext('channel_reply', { ok: true }, true))
    expect(agent.signal.aborted).toBe(false)
  })

  test('does NOT abort after a read-only tool so genuine multi-step turns continue', async () => {
    const agent = await liveAgentAfterRoute(await tempDir())
    await agent.afterToolCall!(afterToolContext('read', { ok: true }, false))
    expect(agent.signal.aborted).toBe(false)
  })

  test('does NOT abort after a successful channel_send (only channel_reply is terminal)', async () => {
    const agent = await liveAgentAfterRoute(await tempDir())
    await agent.afterToolCall!(afterToolContext('channel_send', { ok: true }, false))
    expect(agent.signal.aborted).toBe(false)
  })

  test('stashes the reply text on a terminal channel_reply so the willingness nudge can read it', async () => {
    const agent = await liveAgentAfterRoute(await tempDir())
    await agent.afterToolCall!(afterToolContext('channel_reply', { ok: true }, false, '바로 계속 확인하겠습니다'))
    expect(agent.signal.aborted).toBe(true)
  })

  test('does NOT stash when continue:true (the turn stays alive, no nudge needed)', async () => {
    const agent = await liveAgentAfterRoute(await tempDir())
    await agent.afterToolCall!(
      afterToolContext('channel_reply', { ok: true, continue: true }, false, '바로 계속 확인하겠습니다'),
    )
    expect(agent.signal.aborted).toBe(false)
  })
})

describe('ChannelRouter continuation willingness nudge', () => {
  function afterReplyContext(replyText: string): AfterToolCallContext {
    return {
      assistantMessage: assistantMessage('') as AfterToolCallContext['assistantMessage'],
      toolCall: {
        type: 'toolCall',
        id: 'tc1',
        name: 'channel_reply',
        arguments: { text: replyText },
      } as AfterToolCallContext['toolCall'],
      args: { text: replyText },
      result: {
        content: [{ type: 'text' as const, text: 'ignored' }],
        details: { ok: true },
      } as AfterToolCallContext['result'],
      isError: false,
      context: { systemPrompt: '', messages: [], tools: [] },
    }
  }

  // Simulate a terminal channel_reply turn: the model fires channel_reply (the
  // terminal hook stashes the record + aborts), the send lands, and the leaf is
  // the resulting aborted assistant message.
  async function replyTurn(session: FakeSession, router: ChannelRouter, replyText: string): Promise<void> {
    await session.agent.afterToolCall!(afterReplyContext(replyText))
    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: replyText })
    session.setAssistantMidTurn(replyText, 'aborted')
  }

  test('queues a nudge when a terminal reply promises to continue without continue:true', async () => {
    const dir = await tempDir()
    const sent: string[] = []
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(inbound({ text: '다시 확인해봐' }))
    let attempt = 0
    sessions[0]!.onPrompt = async (text) => {
      attempt++
      // given: first turn replies with a continuation promise (no continue:true)
      if (attempt === 1) {
        await replyTurn(sessions[0]!, router, '바로 계속 확인하겠습니다')
        return
      }
      // then: the nudge arrives as a reminder-only re-prompt; now do the work
      expect(text).toContain(WILLINGNESS_NUDGE)
      sessions[0]!.setAssistantText('NO_REPLY')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(2)
  })

  test('does NOT queue a nudge for a final reply with no continuation intent', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound({ text: '리뷰해줘' }))
    sessions[0]!.onPrompt = async () => {
      await replyTurn(sessions[0]!, router, '리뷰 완료했습니다. 문제 없습니다.')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
  })

  test('nudges at most once per logical turn even if the second reply also promises to continue', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound({ text: '확인해봐' }))
    sessions[0]!.onPrompt = async () => {
      // Every turn promises to continue without continue:true. Bound = 1, so
      // only the first reply turn may queue a nudge; the nudge turn's own reply
      // must NOT queue a second one.
      await replyTurn(sessions[0]!, router, '바로 계속 확인하겠습니다')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(2)
  })
})

describe('ChannelRouter channel_send willingness nudge', () => {
  // Set the turn-end leaf to a FRESH empty `stop` (distinct entry id) so the
  // detector's `leaf.id !== lastSendLeafId` check sees post-ack work. Mirrors the
  // production shape: ack via channel_send, tool work, then a clean empty stop.
  function endWithFreshEmptyStop(session: FakeSession, seq: number): void {
    const entry: SessionEntry = {
      type: 'message',
      id: `empty-stop-${seq}`,
      parentId: null,
      timestamp: '2026-06-15T08:27:40.000Z',
      message: {
        ...assistantMessage(''),
        content: [{ type: 'text', text: '' }],
        stopReason: 'stop',
      },
    }
    session.entriesById.set(entry.id, entry)
    session.leafEntry = entry
  }

  test('nudges when a channel_send ack promised to continue then the turn ended on an empty stop', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(inbound({ text: '이 화면 타입 뭐로 해야 해?' }))
    let attempt = 0
    sessions[0]!.onPrompt = async (text) => {
      attempt++
      if (attempt === 1) {
        // given: a channel_send ack that trips continuation-willingness, then
        // post-ack work that degenerates into an empty stop leaf
        await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: '확인해볼게요. 먼저 볼게요.' })
        endWithFreshEmptyStop(sessions[0]!, attempt)
        return
      }
      // then: the nudge arrives as a reminder-only re-prompt; deliver the answer
      expect(text).toContain(SEND_WILLINGNESS_NUDGE)
      await router.send({
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        text: '크레딧 하향 조정으로 하시면 돼요.',
      })
      sessions[0]!.setAssistantText('')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(2)
    expect(sent).toEqual(['확인해볼게요. 먼저 볼게요.', '크레딧 하향 조정으로 하시면 돼요.'])
    expect(logs.some((m) => m.includes('send_willingness_nudge attempt=1'))).toBe(true)
  })

  test('does NOT nudge when the channel_send delivered a substantive answer before the empty stop', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound({ text: '결과 알려줘' }))
    sessions[0]!.onPrompt = async () => {
      // A real answer (no continuation-willingness phrase) followed by the normal
      // terminal empty stop must stay on the historical no_reply path.
      await router.send({
        adapter: 'discord-bot',
        workspace: 'g1',
        chat: 'c1',
        text: '결과는 이래요. 실패했고 인증이 없었어요.',
      })
      endWithFreshEmptyStop(sessions[0]!, 1)
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(logs.some((m) => m.includes('send_willingness_nudge'))).toBe(false)
    expect(logs.some((m) => m.includes('no_reply'))).toBe(true)
  })

  test('does NOT nudge when the ack leaf is unchanged since the send (ack-then-await-user)', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async () => ({ ok: true }))

    await router.route(inbound({ text: '확인 좀' }))
    sessions[0]!.onPrompt = async () => {
      // Set the leaf BEFORE the send so lastSendLeafId === the turn-end leaf id:
      // the model acked and stopped to await the user, not a degenerated turn.
      const entry: SessionEntry = {
        type: 'message',
        id: 'ack-leaf',
        parentId: null,
        timestamp: '2026-06-15T08:27:40.000Z',
        message: { ...assistantMessage(''), content: [{ type: 'text', text: '' }], stopReason: 'stop' },
      }
      sessions[0]!.entriesById.set(entry.id, entry)
      sessions[0]!.leafEntry = entry
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: '확인해볼게요.' })
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(logs.some((m) => m.includes('send_willingness_nudge'))).toBe(false)
  })

  test('posts the fallback instead of looping when the nudge re-degenerates', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(inbound({ text: '확인해줘' }))
    let attempt = 0
    sessions[0]!.onPrompt = async () => {
      attempt++
      // Each turn re-acks (distinct text so it isn't send-deduped) and re-ends on
      // an empty stop. Bound = MAX_WILLINGNESS_NUDGES (1): one nudge, then fallback.
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: `확인해볼게요 (${attempt})` })
      endWithFreshEmptyStop(sessions[0]!, attempt)
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1 + MAX_WILLINGNESS_NUDGES)
    expect(sent.filter((s) => s === EMPTY_TURN_FALLBACK_TEXT)).toHaveLength(1)
    expect(logs.some((m) => m.includes('empty_turn_fallback cause=empty_stop_after_send_ack_nudges_exhausted'))).toBe(
      true,
    )
  })

  test('does NOT nudge when a real user inbound is already queued for the next drain', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', 'g1', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })

    await router.route(inbound({ text: '확인 좀' }))
    sessions[0]!.onPrompt = async () => {
      // given: the ack lands and the turn degenerates to an empty stop, but a new
      // user message arrived during the prompt and is waiting in promptQueue.
      // drain() would splice a pushed reminder into that live batch, so the nudge
      // must be suppressed (the queued inbound supersedes this turn's recovery).
      if (sessions[0]!.prompts.length === 1) {
        await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: '확인해볼게요.' })
        endWithFreshEmptyStop(sessions[0]!, 1)
        await router.route(inbound({ text: 'actually here is more context', externalMessageId: 'm2' }))
      }
    }
    await router.__testing!.flushDebounce(KEY)

    expect(logs.some((m) => m.includes('send_willingness_nudge'))).toBe(false)
    expect(sent.some((s) => s === EMPTY_TURN_FALLBACK_TEXT)).toBe(false)
  })
})

describe('ChannelRouter output-token cap', () => {
  async function invokeStream(session: FakeSession, options: { maxTokens?: number } | undefined): Promise<void> {
    await session.agent.streamFn(
      {} as Parameters<StreamFn>[0],
      { systemPrompt: '', messages: [], tools: [] } as Parameters<StreamFn>[1],
      options as Parameters<StreamFn>[2],
    )
  }

  test('caps output tokens at CHANNEL_MAX_OUTPUT_TOKENS when the caller left maxTokens unset', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await invokeStream(sessions[0]!, undefined)

    expect(sessions[0]!.lastStreamMaxTokens).toBe(CHANNEL_MAX_OUTPUT_TOKENS)
  })

  test('does not override an explicit per-call maxTokens', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await invokeStream(sessions[0]!, { maxTokens: 256 })

    expect(sessions[0]!.lastStreamMaxTokens).toBe(256)
  })
})

describe('ChannelRouter inbound attachment lookup', () => {
  const PHOTO = {
    id: 1,
    kind: 'photo' as const,
    ref: 'https://example.test/photo.jpg',
    mimetype: 'image/jpeg',
  }

  test('resolves the current turn attachment mid-prompt after the queue is drained', async () => {
    // The attachment lives on the promptQueue item until drain() splices the
    // queue empty at the top of the turn. The model only calls
    // look_at_channel_attachment DURING the prompt — by then promptQueue and
    // contextBuffer are both empty, so the lookup must read from the
    // turn-scoped snapshot, not the (now-empty) queues.
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)

    let lookedUp: ReturnType<typeof router.lookupInboundAttachment> = null
    let listedDuringTurn: readonly number[] = []
    await router.route(inbound({ text: 'read this', attachments: [PHOTO] }))
    sessions[0]!.onPrompt = () => {
      lookedUp = router.lookupInboundAttachment({ ...KEY, id: 1 })
      listedDuringTurn = router.listInboundAttachmentIds(KEY)
      sessions[0]!.setAssistantText('NO_REPLY')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(lookedUp).not.toBeNull()
    expect(lookedUp!.ref).toBe(PHOTO.ref)
    expect(listedDuringTurn).toEqual([1])
  })

  test('clears the turn-scoped attachment snapshot after the turn ends', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)

    await router.route(inbound({ text: 'read this', attachments: [PHOTO] }))
    await router.__testing!.flushDebounce(KEY)

    // After the turn fully drains, the attachment is no longer part of any
    // pending or in-flight turn, so a late lookup must miss.
    expect(router.lookupInboundAttachment({ ...KEY, id: 1 })).toBeNull()
    expect(router.listInboundAttachmentIds(KEY)).toEqual([])
  })
})

describe('ChannelRouter history attachment registry', () => {
  const HIST_PHOTO = { id: 1, kind: 'photo' as const, ref: 'https://example.test/hist.jpg', mimetype: 'image/jpeg' }

  async function liveRouter(dir: string) {
    const made = makeRouter(dir)
    // A live session must exist before registerHistoryAttachments has somewhere
    // to stash; route + drain a throwaway inbound to create one.
    await made.router.route(inbound({ text: 'open session' }))
    await made.router.__testing!.flushDebounce(KEY)
    return made
  }

  test('makes a prior-turn attachment resolvable by its placeholder id after channel_history', async () => {
    const { router } = await liveRouter(await tempDir())

    expect(router.lookupInboundAttachment({ ...KEY, id: 1 })).toBeNull()

    router.registerHistoryAttachments(KEY, [historyMessage({ externalMessageId: 'old', attachments: [HIST_PHOTO] })])

    const resolved = router.lookupInboundAttachment({ ...KEY, id: 1 })
    expect(resolved).not.toBeNull()
    expect(resolved!.ref).toBe(HIST_PHOTO.ref)
    expect(router.listInboundAttachmentIds(KEY)).toEqual([1])
  })

  test('a live current-turn #1 still wins over a registered history #1', async () => {
    const { router, sessions } = makeRouter(await tempDir())
    router.registerHistory('discord-bot', 'g1', async () => ({
      ok: true,
      messages: [],
    }))

    // Seed a history attachment #1, then start a turn whose inbound also carries
    // its own attachment #1; the live one must shadow the historical one.
    let resolvedMidTurn: ReturnType<typeof router.lookupInboundAttachment> = null
    await router.route(inbound({ text: 'seed', attachments: [{ id: 1, kind: 'photo', ref: 'LIVE-REF' }] }))
    router.registerHistoryAttachments(KEY, [historyMessage({ attachments: [HIST_PHOTO] })])
    sessions[0]!.onPrompt = () => {
      resolvedMidTurn = router.lookupInboundAttachment({ ...KEY, id: 1 })
      sessions[0]!.setAssistantText('NO_REPLY')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(resolvedMidTurn).not.toBeNull()
    expect(resolvedMidTurn!.ref).toBe('LIVE-REF')
  })

  test('is a no-op when the session is not live', async () => {
    const { router } = makeRouter(await tempDir())
    router.registerHistoryAttachments(KEY, [historyMessage({ attachments: [HIST_PHOTO] })])
    expect(router.lookupInboundAttachment({ ...KEY, id: 1 })).toBeNull()
  })

  test('caps retained history attachments at HISTORY_ATTACHMENT_LIMIT, keeping the freshest', async () => {
    const { router } = await liveRouter(await tempDir())

    const many = Array.from({ length: HISTORY_ATTACHMENT_LIMIT + 5 }, (_, i) =>
      historyMessage({ externalMessageId: `h${i}`, attachments: [{ id: i + 1, kind: 'file', ref: `R${i + 1}` }] }),
    )
    router.registerHistoryAttachments(KEY, many)

    const ids = router.listInboundAttachmentIds(KEY)
    expect(ids).toHaveLength(HISTORY_ATTACHMENT_LIMIT)
    // The first 5 (oldest) were evicted; the freshest survive.
    expect(router.lookupInboundAttachment({ ...KEY, id: 1 })).toBeNull()
    expect(router.lookupInboundAttachment({ ...KEY, id: HISTORY_ATTACHMENT_LIMIT + 5 })!.ref).toBe(
      `R${HISTORY_ATTACHMENT_LIMIT + 5}`,
    )
  })

  test('a newer page wins over a later older-cursor page that collides on the same id', async () => {
    const { router } = await liveRouter(await tempDir())

    // The agent fetches the recent page first (newer ts), then pages back with
    // a cursor and gets an OLDER message reusing id #1. Despite arriving later,
    // the older ref must not shadow the newer one.
    router.registerHistoryAttachments(KEY, [
      historyMessage({ externalMessageId: 'recent', ts: 2000, attachments: [{ id: 1, kind: 'file', ref: 'NEW-REF' }] }),
    ])
    router.registerHistoryAttachments(KEY, [
      historyMessage({ externalMessageId: 'older', ts: 1000, attachments: [{ id: 1, kind: 'file', ref: 'OLD-REF' }] }),
    ])

    expect(router.lookupInboundAttachment({ ...KEY, id: 1 })!.ref).toBe('NEW-REF')
  })

  test('a later older-cursor page is evicted first when the cap is exceeded', async () => {
    const { router } = await liveRouter(await tempDir())

    // Fill the cap with the freshest page, then page back: the older refs must
    // be the ones dropped, never the newer ones already retained.
    const recent = Array.from({ length: HISTORY_ATTACHMENT_LIMIT }, (_, i) =>
      historyMessage({
        externalMessageId: `r${i}`,
        ts: 9000 + i,
        attachments: [{ id: i + 1, kind: 'file', ref: `NEW${i + 1}` }],
      }),
    )
    router.registerHistoryAttachments(KEY, recent)
    router.registerHistoryAttachments(KEY, [
      historyMessage({ externalMessageId: 'older', ts: 10, attachments: [{ id: 999, kind: 'file', ref: 'OLD' }] }),
    ])

    expect(router.lookupInboundAttachment({ ...KEY, id: 999 })).toBeNull()
    expect(router.lookupInboundAttachment({ ...KEY, id: 1 })!.ref).toBe('NEW1')
  })
})

describe('review-thread resolver registry', () => {
  const req = { adapter: 'github' as const, workspace: 'acme/p', chat: 'pr:1', rootCommentId: '1' }

  test('answers unsupported when no resolver is registered', async () => {
    const { router } = await makeRouter(await tempDir())

    const result = await router.resolveReviewThread(req)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('unsupported')
  })

  test('dispatches to the registered resolver', async () => {
    const { router } = await makeRouter(await tempDir())
    router.registerReviewThreadResolver('github', 'acme/p', async () => ({ ok: true }))

    expect((await router.resolveReviewThread(req)).ok).toBe(true)
  })

  test('last-write-wins and a stale unregister does not wipe a fresh resolver', async () => {
    const { router } = await makeRouter(await tempDir())
    const first = async () => ({ ok: false as const, error: 'first', code: 'transient' as const })
    const second = async () => ({ ok: true as const })
    router.registerReviewThreadResolver('github', 'acme/p', first)
    router.registerReviewThreadResolver('github', 'acme/p', second)

    router.unregisterReviewThreadResolver('github', 'acme/p', first)

    expect((await router.resolveReviewThread(req)).ok).toBe(true)
  })

  test('a thrown resolver becomes a transient failure, not a rejection', async () => {
    const { router } = await makeRouter(await tempDir())
    router.registerReviewThreadResolver('github', 'acme/p', async () => {
      throw new Error('boom')
    })

    const result = await router.resolveReviewThread(req)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('transient')
  })
})

describe('resumeRestartHandoff', () => {
  async function seedMapping(dir: string, sessionId: string, sessionFile: string): Promise<void> {
    await mkdir(join(dir, 'channels'), { recursive: true })
    await saveChannelSessions(dir, [
      {
        adapter: KEY.adapter,
        workspace: KEY.workspace,
        chat: KEY.chat,
        thread: KEY.thread,
        sessionId,
        sessionFile,
        lastInboundAt: 0,
        participants: [],
      },
    ])
  }

  function channelHandoff(over: Partial<RestartHandoff> = {}): RestartHandoff {
    return {
      schemaVersion: 2,
      restartedAt: new Date().toISOString(),
      originatingSessionId: 'ses_origin',
      originatingSessionFile: '2026-05-02T16-56-52-380Z_ses_origin.jsonl',
      origin: { kind: 'channel', key: { ...KEY } },
      ...over,
    }
  }

  test('reopens the exact originating session and wakes it (drains a turn)', async () => {
    // given: a persisted mapping for the channel naming the originating session
    const dir = await tempDir()
    await seedMapping(dir, 'ses_origin', '2026-05-02T16-56-52-380Z_ses_origin.jsonl')
    const factoryCalls: SessionFactoryArgs[] = []
    const { router, sessions } = makeRouter(dir, {
      factoryCalls,
      transcriptPathFor: (sessionId) => `/tmp/fake/2026-05-02T16-56-52-380Z_${sessionId}.jsonl`,
    })

    // when
    await router.resumeRestartHandoff(channelHandoff())
    await waitFor(() => sessions.length > 0 && sessions[0]!.prompts.length > 0)

    // then: reopened the same session id + file, and a turn fired
    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.existingSessionId).toBe('ses_origin')
    expect(factoryCalls[0]?.existingSessionFile).toBe('2026-05-02T16-56-52-380Z_ses_origin.jsonl')
    expect(sessions[0]?.prompts.length).toBe(1)
  })

  test('skips when the persisted mapping no longer names the handoff session', async () => {
    // given: the channel rolled over to a different session since the restart
    const dir = await tempDir()
    await seedMapping(dir, 'ses_other', '2026-05-02T16-56-52-380Z_ses_other.jsonl')
    const factoryCalls: SessionFactoryArgs[] = []
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { factoryCalls, logs })

    // when
    await router.resumeRestartHandoff(channelHandoff())

    // then: no reopen, logged the skip
    expect(factoryCalls).toHaveLength(0)
    expect(sessions).toHaveLength(0)
    expect(logs.some((l) => l.includes('restart-resume skipped'))).toBe(true)
  })

  test('is a no-op for a tui-origin handoff', async () => {
    const dir = await tempDir()
    await seedMapping(dir, 'ses_origin', '2026-05-02T16-56-52-380Z_ses_origin.jsonl')
    const factoryCalls: SessionFactoryArgs[] = []
    const { router, sessions } = makeRouter(dir, { factoryCalls })

    await router.resumeRestartHandoff(channelHandoff({ origin: { kind: 'tui' } }))

    expect(factoryCalls).toHaveLength(0)
    expect(sessions).toHaveLength(0)
  })

  test('reopens even when the persisted mapping is far past the freshness TTL (bypasses stale-rollover)', async () => {
    // given: a mapping whose lastInboundAt is well beyond SESSION_FRESHNESS_TTL_MS
    const dir = await tempDir()
    await mkdir(join(dir, 'channels'), { recursive: true })
    await saveChannelSessions(dir, [
      {
        adapter: KEY.adapter,
        workspace: KEY.workspace,
        chat: KEY.chat,
        thread: KEY.thread,
        sessionId: 'ses_origin',
        sessionFile: '2026-05-02T16-56-52-380Z_ses_origin.jsonl',
        lastInboundAt: 1,
        participants: [],
      },
    ])
    const nowRef = { value: SESSION_FRESHNESS_TTL_MS * 100 }
    const factoryCalls: SessionFactoryArgs[] = []
    const { router } = makeRouter(dir, {
      nowRef,
      factoryCalls,
      transcriptPathFor: (sessionId) => `/tmp/fake/2026-05-02T16-56-52-380Z_${sessionId}.jsonl`,
    })

    // when
    await router.resumeRestartHandoff(channelHandoff())

    // then: rehydrated the exact session rather than cold-starting a fresh one
    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.existingSessionId).toBe('ses_origin')
    expect(factoryCalls[0]?.existingSessionFile).toBe('2026-05-02T16-56-52-380Z_ses_origin.jsonl')
  })

  test('leaves the durable mapping untouched when reopen fails (lossless skip)', async () => {
    // given: a router whose session factory throws, so ensureLive fails
    const dir = await tempDir()
    await mkdir(join(dir, 'channels'), { recursive: true })
    const seeded = {
      adapter: KEY.adapter,
      workspace: KEY.workspace,
      chat: KEY.chat,
      thread: KEY.thread,
      sessionId: 'ses_origin',
      sessionFile: 'OLD_ses_origin.jsonl',
      lastInboundAt: 5,
      participants: [],
    }
    await saveChannelSessions(dir, [seeded])
    const logs: string[] = []
    const router = createChannelRouter({
      agentDir: dir,
      configForAdapter: () => baseConfig,
      permissions: grantAllPermissions,
      logger: { info: (m) => logs.push(`info:${m}`), warn: (m) => logs.push(`warn:${m}`), error: () => {} },
      createSessionForChannel: async () => {
        throw new Error('reopen boom')
      },
    })

    // when
    await router.resumeRestartHandoff(channelHandoff())

    // then: the persisted record is byte-for-byte unchanged (no repointed
    // sessionFile, no refreshed lastInboundAt), so the next inbound still
    // stale-rolls into a clean session
    const after = await loadChannelSessions(dir)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ sessionFile: 'OLD_ses_origin.jsonl', lastInboundAt: 5 })
    expect(logs.some((l) => l.includes('restart-resume ensureLive failed'))).toBe(true)
  })

  test('reserve then a racing inbound coalesces onto one session (no rival create)', async () => {
    // given: a reservation installed BEFORE any inbound (the boot ordering)
    const dir = await tempDir()
    await seedMapping(dir, 'ses_origin', '2026-05-02T16-56-52-380Z_ses_origin.jsonl')
    const factoryCalls: SessionFactoryArgs[] = []
    const { router, sessions } = makeRouter(dir, {
      factoryCalls,
      transcriptPathFor: (sessionId) => `/tmp/fake/2026-05-02T16-56-52-380Z_${sessionId}.jsonl`,
    })
    const reservation = router.reserveRestartHandoff(channelHandoff())
    expect(reservation).not.toBeNull()

    // when: a real inbound races in, then the reservation resumes
    const inboundDone = router.route(inbound({ authorId: 'alice', authorName: 'alice' }))
    await reservation!.resume()
    await inboundDone
    await router.__testing!.flushDebounce(KEY)

    // then: exactly ONE session was created (the inbound coalesced onto the
    // reserved resume, not a rival), reopening the originating session
    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.existingSessionId).toBe('ses_origin')
    expect(sessions).toHaveLength(1)
  })

  test('skips the synthetic wake when a real inbound coalesced during boot', async () => {
    // given: a reservation, then a racing inbound (sawInbound becomes true)
    const dir = await tempDir()
    await seedMapping(dir, 'ses_origin', '2026-05-02T16-56-52-380Z_ses_origin.jsonl')
    const { router, sessions } = makeRouter(dir, {
      transcriptPathFor: (sessionId) => `/tmp/fake/2026-05-02T16-56-52-380Z_${sessionId}.jsonl`,
    })
    const reservation = router.reserveRestartHandoff(channelHandoff())!
    // Fire the inbound WITHOUT awaiting: route() coalesces onto the reserved
    // resume (awaits its `creating` gate), so it cannot complete until resume()
    // runs — mirroring the boot window where the inbound arrives first.
    const inboundDone = router.route(inbound({ authorId: 'alice', authorName: 'alice', text: 'hi there' }))
    await waitFor(() => reservation.sawInbound)

    // when
    await reservation.resume()
    await inboundDone
    await router.__testing!.flushDebounce(KEY)

    // then: the only prompt is the real inbound's turn — no extra synthetic
    // wake turn was stacked on top
    expect(sessions).toHaveLength(1)
    const prompts = sessions[0]!.prompts
    expect(prompts.some((p) => p.includes('hi there'))).toBe(true)
    expect(prompts.some((p) => p.includes('container just restarted'))).toBe(false)
  })

  test('still wakes when no inbound races during boot', async () => {
    // given: a reservation with no racing inbound
    const dir = await tempDir()
    await seedMapping(dir, 'ses_origin', '2026-05-02T16-56-52-380Z_ses_origin.jsonl')
    const { router, sessions } = makeRouter(dir, {
      transcriptPathFor: (sessionId) => `/tmp/fake/2026-05-02T16-56-52-380Z_${sessionId}.jsonl`,
    })
    const reservation = router.reserveRestartHandoff(channelHandoff())!

    // when
    await reservation.resume()
    await waitFor(() => sessions.length > 0 && sessions[0]!.prompts.length > 0)

    // then: the synthetic wake turn fired
    expect(reservation.sawInbound).toBe(false)
    expect(sessions[0]?.prompts.some((p) => p.includes('container just restarted'))).toBe(true)
  })

  test('resume wake turn re-seeds the handoff author so author-scoped roles survive restart', async () => {
    // given: a handoff carrying the owner who issued /restart
    const dir = await tempDir()
    await seedMapping(dir, 'ses_origin', '2026-05-02T16-56-52-380Z_ses_origin.jsonl')
    const { router, sessions } = makeRouter(dir, {
      transcriptPathFor: (sessionId) => `/tmp/fake/2026-05-02T16-56-52-380Z_${sessionId}.jsonl`,
    })
    const reservation = router.reserveRestartHandoff(channelHandoff({ triggeringAuthorId: 'U_OWNER' }))!

    let originDuringWake: SessionOrigin | undefined
    const captureOrigin = (): void => {
      originDuringWake = router.__testing!.getLiveOriginSnapshot(KEY)
    }

    // when: the synthetic wake turn drains
    await reservation.resume()
    await waitFor(() => sessions.length > 0)
    sessions[0]!.onPrompt = captureOrigin
    if (sessions[0]!.prompts.length > 0) captureOrigin()
    await waitFor(() => originDuringWake !== undefined)

    // then: the wake turn's origin carries the handoff author, not nothing
    expect(originDuringWake?.kind).toBe('channel')
    if (originDuringWake?.kind !== 'channel') throw new Error('unreachable')
    expect(originDuringWake.lastInboundAuthorId).toBe('U_OWNER')
  })
})

describe('injectPrVerdictActivity (PR-keyed verdict liveness)', () => {
  const WS = 'typeclaw/typeclaw'

  function ghInbound(thread: string | null, over: Partial<InboundMessage> = {}): InboundMessage {
    return inbound({
      adapter: 'github',
      workspace: WS,
      chat: 'pr:1042',
      thread,
      authorId: '931655',
      authorName: 'devxoul',
      text: '@typeey please review',
      isBotMention: true,
      ...over,
    })
  }

  async function spawnTwoSiblingSessions(dir: string) {
    const { router, sessions } = makeRouter(dir)
    await router.route(ghInbound(null))
    await router.__testing!.flushDebounce({ adapter: 'github', workspace: WS, chat: 'pr:1042', thread: null })
    await router.route(ghInbound('3458942280', { externalMessageId: 'm2' }))
    await router.__testing!.flushDebounce({ adapter: 'github', workspace: WS, chat: 'pr:1042', thread: '3458942280' })
    return { router, sessions }
  }

  test('sequential fan-out: a landed verdict stands down the OTHER live pr session, not the publisher', async () => {
    const dir = await tempDir()
    const { router, sessions } = await spawnTwoSiblingSessions(dir)
    expect(sessions).toHaveLength(2)
    const publisherPrompts = sessions[0]!.prompts.length
    const siblingPrompts = sessions[1]!.prompts.length

    // when: session 1 (ses_fake_1, thread:null) lands an APPROVE
    const result = router.injectPrVerdictActivity({
      workspace: WS,
      prNumber: 1042,
      verdict: 'APPROVE',
      sessionId: 'ses_fake_1',
    })

    // then: exactly the sibling is nudged; the publisher is excluded
    expect(result).toEqual({ kind: 'delivered', count: 1 })
    await waitFor(() => sessions[1]!.prompts.length > siblingPrompts)
    const reminder = sessions[1]!.prompts.at(-1) ?? ''
    expect(reminder).toContain('<system-reminder>')
    expect(reminder).toContain('APPROVE')
    expect(reminder).toContain('#1042')
    expect(sessions[0]!.prompts.length).toBe(publisherPrompts)
  })

  test('publisher-exclusion: a single solo session landing a verdict nudges nobody', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    await router.route(ghInbound(null))
    await router.__testing!.flushDebounce({ adapter: 'github', workspace: WS, chat: 'pr:1042', thread: null })

    const result = router.injectPrVerdictActivity({
      workspace: WS,
      prNumber: 1042,
      verdict: 'APPROVE',
      sessionId: 'ses_fake_1',
    })
    expect(result).toEqual({ kind: 'delivered', count: 0 })
    expect(sessions[0]!.prompts.length).toBe(1)
  })

  test('scoped by PR: a verdict on a different PR does not touch this PR session', async () => {
    const dir = await tempDir()
    const { router, sessions } = await spawnTwoSiblingSessions(dir)
    const before = sessions.map((s) => s.prompts.length)

    const result = router.injectPrVerdictActivity({
      workspace: WS,
      prNumber: 999,
      verdict: 'APPROVE',
      sessionId: 'ses_other',
    })
    expect(result).toEqual({ kind: 'delivered', count: 0 })
    expect(sessions.map((s) => s.prompts.length)).toEqual(before)
  })

  test('scoped by workspace: a same-PR-number verdict in a different repo is ignored', async () => {
    const dir = await tempDir()
    const { router, sessions } = await spawnTwoSiblingSessions(dir)
    const before = sessions.map((s) => s.prompts.length)

    const result = router.injectPrVerdictActivity({
      workspace: 'other/repo',
      prNumber: 1042,
      verdict: 'APPROVE',
      sessionId: 'ses_other',
    })
    expect(result).toEqual({ kind: 'delivered', count: 0 })
    expect(sessions.map((s) => s.prompts.length)).toEqual(before)
  })
})
