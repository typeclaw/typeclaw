import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile as writeFileFs } from 'node:fs/promises'
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

import { channelsSessionsPath, loadChannelSessions, saveChannelSessions } from './persistence'
import {
  AUTO_RECOVERY_MARKER,
  CHANNEL_MAX_OUTPUT_TOKENS,
  createChannelRouter,
  DUPLICATE_SEND_ERROR,
  MAX_CHANNEL_SENDS_PER_TURN,
  MAX_POLICY_DENIED_CHANNEL_SENDS_PER_TURN,
  MAX_TYPING_HEARTBEAT_MS,
  OUTBOUND_FLOOD_ERROR,
  SEND_RATE_WARN_THRESHOLD,
  SEND_RATE_WINDOW_MS,
  SESSION_GC_INTERVAL_MS,
  SESSION_FRESHNESS_TTL_MS,
  SESSION_IDLE_MS,
  sliceHeadTail,
  StaleLiveSessionError,
  TURN_CAP_ERROR,
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
}

async function tempDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'channels-router-'))
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
    configuredAliases?: () => readonly string[]
    ensureLiveTimeoutMs?: number
    permissions?: PermissionService
    claimHandler?: ClaimHandler
    hooks?: HookBus
    onReload?: () => Promise<string>
    onRestart?: (ctx?: RestartCommandContext) => Promise<string>
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
    ...(options.claimHandler !== undefined ? { claimHandler: options.claimHandler } : {}),
    ...(options.onReload !== undefined ? { onReload: options.onReload } : {}),
    ...(options.onRestart !== undefined ? { onRestart: options.onRestart } : {}),
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

async function waitForPersistedLastInboundAt(agentDir: string, expected: number): Promise<void> {
  // Wall-clock-bounded poll, not iteration-bounded. The original 20-iteration
  // × 1ms-sleep budget (~20ms total) was tight enough to lose the race
  // against tmpdir fs persistence under `bun test --parallel` contention.
  // The persistence chain is route -> flushDebounce -> writeFile(atomic
  // temp + rename); each fs op can stall hundreds of ms when libuv's
  // threadpool is saturated across 18 workers. 2s is the same shape every
  // other waitFor helper in the repo uses (see scripts/require-parallel.ts
  // for the global-timeout rationale).
  const deadline = performance.now() + 2_000
  while (performance.now() < deadline) {
    const loaded = await loadChannelSessions(agentDir)
    if (loaded[0]?.lastInboundAt === expected) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  const loaded = await loadChannelSessions(agentDir)
  throw new Error(`lastInboundAt persisted as ${String(loaded[0]?.lastInboundAt)}, expected ${expected}`)
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
    router.registerSelfIdentity('discord-bot', () => ({ id: 'BOT_SELF_ID' }))

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

    // then phase logs appear in order: begin → resolved-names → resolved-membership
    //   → session-created → done. The bracketing is what makes a stuck phase
    //   visible from logs alone (begin without done == hung at that phase).
    const phaseLogs = logs
      .filter((l) => l.startsWith('info:[channels]') && l.includes('ensureLive'))
      .map((l) => l.replace(/^.*ensureLive /, ''))
    const beginIdx = phaseLogs.findIndex((p) => p.startsWith('begin'))
    const namesIdx = phaseLogs.findIndex((p) => p.startsWith('resolved-names'))
    const membershipIdx = phaseLogs.findIndex((p) => p.startsWith('resolved-membership'))
    const createdIdx = phaseLogs.findIndex((p) => p.startsWith('session-created'))
    const doneIdx = phaseLogs.findIndex((p) => p.startsWith('done'))
    expect(beginIdx).toBeGreaterThanOrEqual(0)
    expect(namesIdx).toBeGreaterThan(beginIdx)
    expect(membershipIdx).toBeGreaterThan(namesIdx)
    expect(createdIdx).toBeGreaterThan(membershipIdx)
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
    await firstRun.router.route(inbound({ text: '재시작해줘' }))
    await firstRun.router.__testing!.flushDebounce(KEY)
    await firstRun.router.stop()

    // when: a fresh router instance (simulating container restart) handles a new inbound
    // for the same channel
    const factoryCalls: SessionFactoryArgs[] = []
    const secondRun = makeRouter(dir, { transcriptPathFor, factoryCalls })
    await secondRun.router.route(inbound({ text: '다시 해봐', externalMessageId: 'm-followup' }))
    await secondRun.router.__testing!.flushDebounce(KEY)

    // then: the factory was called with BOTH existingSessionId AND existingSessionFile
    // (regression: previously only existingSessionId was passed, and the consumer
    // constructed `${sessionDir}/${sessionId}.jsonl` which never matched the on-disk
    // ${ISO}_${sessionId}.jsonl, silently creating a fresh session every restart)
    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.existingSessionId).toBe('ses_fake_1')
    expect(factoryCalls[0]?.existingSessionFile).toBe('2026-05-02T16-56-52-380Z_ses_fake_1.jsonl')
  })

  test('restart with a v2 mapping (no sessionFile, file actually present) migrates and reopens', async () => {
    // given: a v2 mapping on disk plus the matching pi-coding-agent file
    const dir = await tempDir()
    const sessionsDir = join(dir, 'sessions')
    await mkdir(sessionsDir, { recursive: true })
    await writeFileFs(
      join(sessionsDir, '2026-05-02T16-56-52-380Z_ses_legacy.jsonl'),
      '{"type":"session","version":3,"id":"ses_legacy","timestamp":"2026-05-02T16:56:52.380Z","cwd":"/agent"}\n',
    )
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
            sessionId: 'ses_legacy',
            participants: [],
          },
        ],
      }),
    )

    const factoryCalls: SessionFactoryArgs[] = []
    const transcriptPathFor = (sessionId: string): string =>
      `${sessionsDir}/2026-05-02T16-56-52-380Z_${sessionId}.jsonl`
    const { router } = makeRouter(dir, { factoryCalls, transcriptPathFor })

    // when: a new inbound arrives after the v2→v3 migration
    await router.route(inbound({ text: 'hi' }))
    await router.__testing!.flushDebounce(KEY)

    // then: the migrated sessionFile was passed to the factory
    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.existingSessionId).toBe('ses_legacy')
    expect(factoryCalls[0]?.existingSessionFile).toBe('2026-05-02T16-56-52-380Z_ses_legacy.jsonl')
  })

  test('restart with a v2 mapping whose session file is missing creates a fresh session', async () => {
    // given: a v2 mapping pointing at a session id with no on-disk file
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

    // existingSessionId still propagates, but existingSessionFile is undefined,
    // signaling the consumer to create a fresh SessionManager
    expect(factoryCalls).toHaveLength(1)
    expect(factoryCalls[0]?.existingSessionId).toBe('ses_lost')
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
    await waitForPersistedLastInboundAt(dir, 1000 + SESSION_FRESHNESS_TTL_MS)
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

  test('lastInboundAt persisted to sessions.json after every engaged inbound', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router } = makeRouter(dir, { nowRef })

    await router.route(inbound({ externalMessageId: 'm1' }))
    await router.__testing!.flushDebounce(KEY)
    await waitForPersistedLastInboundAt(dir, 1000)

    nowRef.value = 2000
    await router.route(inbound({ externalMessageId: 'm2', text: 'second' }))
    await router.__testing!.flushDebounce(KEY)
    await waitForPersistedLastInboundAt(dir, 2000)
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
        if (callCount === 1) await new Promise(() => {})
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
        authorName: 'devxoul',
        text: '@typeey can you review this PR',
      }),
    )
    await router.__testing!.flushDebounce(key)

    expect(sessions[0]!.prompts[0]).toContain('@devxoul (devxoul): @typeey can you review this PR')
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
    router.registerMembership('discord-bot', async () => ({
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
    router.registerMembership('discord-bot', async () => ({ kind: 'transient' }))

    await router.route(inbound({ isBotMention: false, text: 'solo hello' }))
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('solo hello')
  })

  test('large approximate membership counts still quiet plain chatter', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerMembership('discord-bot', async () => ({
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
    router.registerMembership('discord-bot', async () => {
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
    router.registerMembership('discord-bot', async () => {
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
        text: `Hey ${dirName.toUpperCase()}, cron 좀 봐줘`,
        isBotMention: false,
        authorId: 'devxoul',
        authorName: 'devxoul',
      }),
    )
    await router.__testing!.flushDebounce(KEY)
    await router.route(
      inbound({
        externalMessageId: 'm2',
        text: `Hey ${dirName}, cron 좀 봐줘`,
        isBotMention: false,
        authorId: 'second-human',
        authorName: 'second-human',
      }),
    )
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts).toHaveLength(2)
  })

  test('engages on configured alias substring', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir, {
      config: { ...baseConfig, engagement: { trigger: [], stickiness: 'off' } },
      configuredAliases: () => ['봉봉', 'bongbong'],
    })

    await router.route(
      inbound({
        text: '봉봉아 cron 좀 봐줘',
        isBotMention: false,
        authorId: 'devxoul',
        authorName: 'devxoul',
      }),
    )
    await router.__testing!.flushDebounce(KEY)
    await router.route(
      inbound({
        externalMessageId: 'm2',
        text: '봉봉아 cron 좀 봐줘',
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
        text: '봉봉아 cron',
        isBotMention: false,
        authorId: 'devxoul',
        authorName: 'devxoul',
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

    aliases = ['봉봉']
    await router.route(
      inbound({
        externalMessageId: 'm3',
        text: '봉봉아 cron',
        isBotMention: false,
        authorId: 'devxoul',
        authorName: 'devxoul',
      }),
    )
    await router.__testing!.flushDebounce(KEY)

    expect(sessions[0]!.prompts.some((p) => p.includes('봉봉아 cron'))).toBe(true)
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound({ authorId: 'bob', externalMessageId: 'bob-1', isBotMention: true, text: 'bot hi' }))
    await router.__testing!.flushDebounce(KEY)
    nowRef.value = 1200
    sessions[0]!.onPrompt = async () => {
      await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'ㅇㅇ 방금 보냄' })
    }
    await router.route(
      inbound({ authorId: 'alice', externalMessageId: 'alice-1', isBotMention: true, text: 'bot 보냄?' }),
    )
    await router.__testing!.flushDebounce(KEY)
    sessions[0]!.onPrompt = undefined
    sessions[0]!.prompts.length = 0

    // when alice posts a plain follow-up with no mention (the regressed case)
    nowRef.value = 2000
    await router.route(
      inbound({ authorId: 'alice', externalMessageId: 'alice-2', isBotMention: false, text: '어디다 보냄' }),
    )
    await router.__testing!.flushDebounce(KEY)

    // then we engage (sticky woke us) and the nudge rides along so the model
    // can still self-select silence for true chatter
    expect(sessions[0]!.prompts).toHaveLength(1)
    expect(sessions[0]!.prompts[0]).toContain('어디다 보냄')
    expect(sessions[0]!.prompts[0]).toContain('You are in a group chat with multiple people.')
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async () => ({ ok: false, error: 'denied by allow rules' }))
    const result = await router.send({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      text: 'nope',
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false ? result.error : '').toContain('denied')
  })
})

describe('ChannelRouter auto-react on engage', () => {
  const REACTION_REF = { adapter: 'discord-bot' as const, value: 'msg-ref' }

  test('adds an :eyes: reaction to the triggering inbound when engaging', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const captured: ReactionRequest[] = []
    router.registerReaction('discord-bot', async (req) => {
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
    router.registerReaction('discord-bot', async () => {
      called = true
      return { ok: true }
    })

    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    expect(called).toBe(false)
  })

  test('a throwing reaction callback never blocks engagement (session still created, reply still sends)', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerReaction('discord-bot', async () => {
      throw new Error('reaction api exploded')
    })
    const outbound: string[] = []
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerReaction('discord-bot', async () => ({ ok: true }))
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
    router.registerReaction('discord-bot', async () => {
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

describe('ChannelRouter drop-eyes-after-reply', () => {
  const TARGET_REF: ReactionRef = { adapter: 'discord-bot', value: 'msg-ref' }
  const INSTANCE_REF: ReactionRef = { adapter: 'discord-bot', value: 'reaction-instance' }

  test('removes the engage-added eyes reaction after a successful reply', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    const removed: RemoveReactionRequest[] = []
    router.registerReaction('discord-bot', async () => ({ ok: true, reactionRef: INSTANCE_REF }))
    router.registerRemoveReaction('discord-bot', async (req) => {
      removed.push(req)
      return { ok: true }
    })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))

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
    router.registerReaction('discord-bot', async (req) => ({
      ok: true,
      reactionRef: instanceFor[req.reactionRef.value]!,
    }))
    router.registerRemoveReaction('discord-bot', async (req) => {
      removed.push(req)
      return { ok: true }
    })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))

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
    router.registerReaction('discord-bot', async () => ({ ok: true, reactionRef: INSTANCE_REF }))
    router.registerRemoveReaction('discord-bot', async (req) => {
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
      async () =>
        await new Promise((resolve: (result: { ok: true; reactionRef: ReactionRef }) => void) => {
          resolveAdd = (ref) => resolve({ ok: true, reactionRef: ref })
        }),
    )
    router.registerRemoveReaction('discord-bot', async (req) => {
      removed.push(req)
      return { ok: true }
    })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))

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
    router.registerReaction('discord-bot', async () => ({ ok: true }))
    router.registerRemoveReaction('discord-bot', async () => {
      removed = true
      return { ok: true }
    })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))

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
    router.registerReaction('discord-bot', async () => ({ ok: false, error: 'nope', code: 'unsupported' }))
    router.registerRemoveReaction('discord-bot', async () => {
      removed = true
      return { ok: true }
    })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))

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
    router.registerReaction('discord-bot', async () => ({ ok: true, reactionRef: INSTANCE_REF }))
    router.registerRemoveReaction('discord-bot', async () => ({ ok: false, error: 'already gone', code: 'not-found' }))
    router.registerRemoveReaction('discord-bot', async () => ({ ok: false, error: 'unsupported', code: 'unsupported' }))
    router.registerOutbound('discord-bot', async () => ({ ok: true }))

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

    router.registerRemoveReaction('discord-bot', async () => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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

  test('suppresses recovery when assistant ends with NO_REPLY after leaked reasoning', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    expect(sent[0]!.text).toContain('On it — reviewing now.')
    expect(sent[0]!.text).toContain(AUTO_RECOVERY_MARKER)
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('Empty response from the cache layer, retrying.')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('Empty response from the cache layer, retrying.')
    expect(sent[0]!.text).toContain(AUTO_RECOVERY_MARKER)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(true)
    expect(logs.some((m) => m.includes('suppressed upstream_empty_response_sentinel'))).toBe(false)
  })

  test('suppresses leaked Kimi tool-call delimiter tokens instead of posting them to the channel', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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

  test('suppresses leaked plain-text channel_reply(...) function-call serialization instead of posting it to the channel', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('channel_reply({"text":"hi there"})')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('suppressed plain_text_channel_tool_call'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  test('suppresses leaked plain-text channel_send(...) serialization the same way', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('channel_send({"adapter":"discord-bot","chat":"c1","text":"hi"})')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('suppressed plain_text_channel_tool_call'))).toBe(true)
  })

  test('suppresses leaked plain-text skip_response(...) serialization instead of posting it to the channel', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'hello' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('skip_response({ reason: "Empty messages, no content to respond to" })')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(0)
    expect(logs.some((m) => m.includes('suppressed plain_text_channel_tool_call'))).toBe(true)
    expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
  })

  test('still recovers prose that mentions skip_response in a non-call shape', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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

  test('recovers visible assistant text when no channel tool sent a message', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    const sent: Array<{ chat: string; thread: string | null | undefined; text: string }> = []
    router.registerOutbound('discord-bot', async (msg) => {
      sent.push({ chat: msg.chat, thread: msg.thread, text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'say hi' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantText('hi from invisible assistant text')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.chat).toBe('c1')
    expect(sent[0]!.thread).toBe(null)
    expect(sent[0]!.text).toContain('hi from invisible assistant text')
    expect(sent[0]!.text).toContain(AUTO_RECOVERY_MARKER)
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
    router.registerOutbound('discord-bot', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: '16배속 가자' }))
    sessions[0]!.onPrompt = () => {
      sessions[0]!.setAssistantMidTurn('16배속으로 실행 중! 잠깐 기다렸다가 스크린샷 찍어볼게요!')
    }
    await router.__testing!.flushDebounce(KEY)

    expect(
      logs.some((m) => m.includes('recovering assistant_text_without_channel_tool') && m.includes('source=mid-turn')),
    ).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('16배속으로 실행 중! 잠깐 기다렸다가 스크린샷 찍어볼게요!')
    expect(sent[0]!.text).toContain(AUTO_RECOVERY_MARKER)
  })

  test('recovery marks a false action claim so it cannot pose as a confirmed reply', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async (msg) => {
      sent.push({ text: msg.text ?? '' })
      return { ok: true }
    })

    await router.route(inbound({ text: 'did you review it?' }))
    sessions[0]!.onPrompt = () => {
      // given: the model narrates an action claim as plain text, never sending it
      sessions[0]!.setAssistantText('I posted the APPROVED review on PR #310!')
    }
    await router.__testing!.flushDebounce(KEY)

    // then: the claim is delivered but prefixed so it reads as unsent, not confirmed
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text.startsWith(AUTO_RECOVERY_MARKER)).toBe(true)
    expect(sent[0]!.text).toContain('I posted the APPROVED review on PR #310!')
  })

  test('mid-turn recovery: applies the NO_REPLY guard to recovered prose', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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

  test('mid-turn recovery: applies the upstream empty-response sentinel guard to recovered prose', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async (msg) => {
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
  // output. This is the load-bearing scoping of the mid-turn fix.
  for (const stopReason of ['length', 'error', 'aborted'] as const) {
    test(`mid-turn recovery: does NOT recover a leaf assistant with stopReason='${stopReason}'`, async () => {
      const dir = await tempDir()
      const logs: string[] = []
      const sent: Array<{ text: string }> = []
      const { router, sessions } = makeRouter(dir, { logs })
      router.registerOutbound('discord-bot', async (msg) => {
        sent.push({ text: msg.text ?? '' })
        return { ok: true }
      })

      await router.route(inbound({ text: 'check something' }))
      sessions[0]!.onPrompt = () => {
        sessions[0]!.setAssistantMidTurn('partial truncated output that must not be posted', stopReason)
      }
      await router.__testing!.flushDebounce(KEY)

      expect(sent).toHaveLength(0)
      expect(logs.some((m) => m.includes('recovering assistant_text_without_channel_tool'))).toBe(false)
      expect(logs.some((m) => m.includes('no recoverable assistant text in branch'))).toBe(true)
    })
  }

  test('mid-turn recovery: does NOT fire when the model successfully replied (channel send happened)', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async (msg) => {
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

  test('logs recovery send failures without crashing the drain loop', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async () => ({ ok: false, error: 'denied by adapter' }))

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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))

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
    router.registerOutbound('discord-bot', async (msg) => {
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
          { type: 'text', text: '죄송해요. 크론 이슈는 지금 바로 확인해볼게요.' },
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
    expect(sent[0]!.text).toContain('죄송해요. 크론 이슈는 지금 바로 확인해볼게요.')
    expect(sent[0]!.text).toContain(AUTO_RECOVERY_MARKER)
  })

  test('pre-tool recovery: still applies NO_REPLY / Kimi-leak / empty-sentinel guards', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const sent: Array<{ text: string }> = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => ({ ok: false, error: 'nope' }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'fail' })
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(0)
  })

  test('does not increment for cross-post (no live session at target keyId)', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c-other', text: 'cross-post' })
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c-other' })).toBe(0)
    expect(router.getConsecutiveSendCount({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1' })).toBe(0)
  })

  test('resets on the next user batch being drained into the model', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => {
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
    await router.route(inbound())
    await router.__testing!.flushDebounce(KEY)

    await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'first' })
    const second = await router.send({ adapter: 'discord-bot', workspace: 'g1', chat: 'c1', text: 'second' })
    expect(second).toEqual({ ok: true })
  })

  test('failed delivery does not reserve a dup slot — retry with same text succeeds', async () => {
    const dir = await tempDir()
    let attempts = 0
    const { router } = makeRouter(dir)
    router.registerOutbound('discord-bot', async () => {
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => {
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
    router.registerOutbound('discord-bot', async () => {
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
    router.registerOutbound('discord-bot', async () => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => {
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => ({ ok: true }))
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
    router.registerOutbound('discord-bot', async () => {
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
    router.registerTyping('discord-bot', async () => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerTyping('discord-bot', async (target) => {
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
    router.registerTyping('discord-bot', async (target) => {
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
    router.registerTyping('discord-bot', async () => {
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
    router.registerTyping('discord-bot', async () => {})
    await router.route(inbound({ text: 'hi bot' }))
    expect(router.__testing!.isTypingActive(KEY)).toBe(true)
    await router.__testing!.flushDebounce(KEY)
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
  })

  test('forwards thread id when the inbound is on a thread', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const calls: Array<{ chat: string; thread: string | null | undefined }> = []
    router.registerTyping('discord-bot', async (target) => {
      calls.push({ chat: target.chat, thread: target.thread })
    })
    await router.route(inbound({ thread: 'thread-7', text: 'hi bot' }))
    expect(calls[0]).toEqual({ chat: 'c1', thread: 'thread-7' })
  })

  test('forwards typingThread for a flat DM while the session thread stays null', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const calls: Array<{ chat: string; thread: string | null | undefined; typingThread: string | undefined }> = []
    router.registerTyping('discord-bot', async (target) => {
      calls.push({ chat: target.chat, thread: target.thread, typingThread: target.typingThread })
    })
    await router.route(inbound({ isDm: true, thread: null, typingThread: 'dm-ts-1', text: 'hi bot' }))
    expect(calls[0]).toEqual({ chat: 'c1', thread: null, typingThread: 'dm-ts-1' })
  })

  test('typing-callback rejection does not crash route', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerTyping('discord-bot', async () => {
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
    router.registerTyping('discord-bot', cb)
    await router.route(inbound({ text: 'hi bot' }))
    expect(calls).toHaveLength(1)
    router.unregisterTyping('discord-bot', cb)
    await router.__testing!.fireTypingHeartbeat(KEY)
    expect(calls).toHaveLength(1)
  })

  test('fires phase=stop exactly once when drain completes (so adapters can clear)', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const phases: Array<'tick' | 'stop'> = []
    router.registerTyping('discord-bot', async (target) => {
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
    router.registerTyping('discord-bot', async (target) => {
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
    router.registerTyping('discord-bot', async (target) => {
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
    router.registerTyping('discord-bot', async (target) => {
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
    router.registerTyping('discord-bot', async (target) => {
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
    router.registerTyping('discord-bot', async (target) => {
      phases.push(target.phase)
    })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))

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
    router.registerTyping('discord-bot', async (target) => {
      phases.push(target.phase)
    })
    router.registerOutbound('discord-bot', async () => ({ ok: true }))

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
    router.registerTyping('discord-bot', async (target) => {
      events.push(`typing:${target.phase}`)
    })
    router.registerOutbound('discord-bot', async () => {
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
    router.registerTyping('discord-bot', async (target) => {
      phases.push(target.phase)
    })
    router.registerOutbound('discord-bot', async (_msg) => {
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
    router.registerTyping('discord-bot', async (target) => {
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
    router.registerTyping('discord-bot', async (target) => {
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

  test('cap still fires after MAX_TYPING_HEARTBEAT_MS of pure silence (no tool events)', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { nowRef, logs })
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', async (target) => {
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
    router.registerTyping('discord-bot', async () => {})

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

  test('tool_execution_end after the cap has already tripped does NOT resurrect typing', async () => {
    const dir = await tempDir()
    const nowRef = { value: 1000 }
    const { router, sessions } = makeRouter(dir, { nowRef })
    const phases: Array<'tick' | 'stop'> = []
    let releasePrompt: (() => void) | undefined
    router.registerTyping('discord-bot', async (target) => {
      phases.push(target.phase)
    })

    await router.route(inbound({ text: 'silent then loud' }))
    sessions[0]!.onPrompt = async () => {
      await new Promise<void>((resolve) => {
        releasePrompt = resolve
      })
    }
    const draining = router.__testing!.flushDebounce(KEY)
    await waitFor(() => releasePrompt !== undefined)

    nowRef.value = 1000 + MAX_TYPING_HEARTBEAT_MS
    await router.__testing!.fireTypingInterval(KEY)
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)

    sessions[0]!.emit({
      type: 'tool_execution_end',
      toolCallId: 'late',
      toolName: 'bash',
      result: 'ok',
      isError: false,
    })
    expect(router.__testing!.isTypingActive(KEY)).toBe(false)
    expect(phases).toEqual(['tick', 'stop'])

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
    router.registerTyping('discord-bot', async () => {})

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
    const start = Date.now()
    await router.route(inbound({ text: 'first' }))
    await router.__testing!.flushDebounce(KEY)
    await router.route(inbound({ externalMessageId: 'm2', text: 'second' }))
    await router.__testing!.flushDebounce(KEY)
    const elapsed = Date.now() - start

    // then both prompts ran (the second is the real proof — without the
    // watchdog the drain loop would still be parked inside the hung idle
    // hook and `live.draining` would block enqueue from firing a new drain),
    // the run completed within the watchdog window, and a warning naming
    // the timeout was emitted so an operator can attribute the hang
    expect(sessions[0]!.prompts).toHaveLength(2)
    expect(elapsed).toBeLessThan(2000)
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
    router.registerChannelNameResolver('discord-bot', async (key) => {
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
    router.registerChannelNameResolver('discord-bot', async () => {
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
    router.registerChannelNameResolver('discord-bot', async () => {
      discordCalls++
      return {}
    })
    router.registerChannelNameResolver('slack-bot', async () => {
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
    router.registerChannelNameResolver('discord-bot', async () => {
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
    router.registerChannelNameResolver('discord-bot', () => new Promise(() => {}))

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
    // "알겠습니다, Neo! 대화 여기까지 할게요." — the model treating the loop guard
    // heading as Neo telling it to wrap up.

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
    router.registerHistory('discord-bot', async (args) => {
      seen.push(args)
      return { ok: true, messages: [] }
    })

    const result = await router.fetchHistory('discord-bot', { chat: 'c1', thread: 't1', limit: 5, cursor: 'cur' })

    expect(result).toEqual({ ok: true, messages: [] })
    expect(seen).toEqual([{ chat: 'c1', thread: 't1', limit: 5, cursor: 'cur' }])
  })

  test('returns history-not-supported when no callback is registered for the adapter', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)

    const result = await router.fetchHistory('discord-bot', { chat: 'c1', thread: null, limit: 1 })

    expect(result).toEqual({ ok: false, error: 'history-not-supported' })
  })

  test('first ok callback wins; later callbacks are not invoked', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let secondCalled = false
    router.registerHistory('discord-bot', async () => ({
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
    router.registerHistory('discord-bot', async () => {
      secondCalled = true
      return { ok: false, error: 'second' }
    })

    const result = await router.fetchHistory('discord-bot', { chat: 'c1', thread: null, limit: 5 })

    expect(result.ok).toBe(true)
    expect(secondCalled).toBe(false)
  })

  test('surfaces the last error verbatim when every callback returns ok: false', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    router.registerHistory('discord-bot', async () => ({ ok: false, error: 'first-failed' }))
    router.registerHistory('discord-bot', async () => ({ ok: false, error: 'second-failed' }))

    const result = await router.fetchHistory('discord-bot', { chat: 'c1', thread: null, limit: 1 })

    expect(result).toEqual({ ok: false, error: 'second-failed' })
  })

  test('unregisterHistory removes the callback so subsequent calls fall back to history-not-supported', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    const cb: HistoryCallback = async () => ({ ok: true, messages: [] })
    router.registerHistory('discord-bot', cb)
    router.unregisterHistory('discord-bot', cb)

    const result = await router.fetchHistory('discord-bot', { chat: 'c1', thread: null, limit: 1 })

    expect(result).toEqual({ ok: false, error: 'history-not-supported' })
  })

  test('history registrations are isolated per adapter', async () => {
    const dir = await tempDir()
    const { router } = makeRouter(dir)
    let discordCalls = 0
    let slackCalls = 0
    router.registerHistory('discord-bot', async () => {
      discordCalls++
      return { ok: true, messages: [] }
    })
    router.registerHistory('slack-bot', async () => {
      slackCalls++
      return { ok: true, messages: [] }
    })

    await router.fetchHistory('discord-bot', { chat: 'c1', thread: null, limit: 1 })

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
    router.registerHistory('discord-bot', () => new Promise(() => {}))

    // when fetchHistory is invoked
    const start = Date.now()
    const result = await router.fetchHistory('discord-bot', { chat: 'c1', thread: null, limit: 1 })
    const elapsed = Date.now() - start

    // then it returns the not-supported degraded result and logs the timeout
    expect(elapsed).toBeLessThan(500)
    expect(result.ok).toBe(false)
    expect(logs.some((l) => l.includes('history fetch threw') && l.includes('timed out after 50ms'))).toBe(true)
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
    router.registerHistory('discord-bot', async () => ({
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

  test('prefetches channel scrollback (tail-only) when session is not in a thread', async () => {
    const dir = await tempDir()
    const { router, sessions } = makeRouter(dir)
    router.registerHistory('discord-bot', async () => ({
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
    router.registerHistory('discord-bot', async () => {
      historyCalls++
      return { ok: true, messages: [historyMessage({ text: 'should-not-appear' })] }
    })

    await router.route(inbound({ externalMessageId: 'engage', text: 'hi' }))
    await router.__testing!.flushDebounce(KEY)

    expect(historyCalls).toBe(0)
    expect(sessions[0]!.prompts[0]).not.toContain('should-not-appear')
    expect(sessions[0]!.prompts[0]).not.toContain('## Recent context')
  })

  test('history fetch failure is non-fatal; session still processes the engaging message', async () => {
    const dir = await tempDir()
    const logs: string[] = []
    const { router, sessions } = makeRouter(dir, { logs })
    router.registerHistory('discord-bot', async () => ({ ok: false, error: 'rate-limited' }))

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
    router.registerHistory('discord-bot', async () => ({
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
    router.registerHistory('discord-bot', async () => ({
      ok: true,
      messages: [
        historyMessage({
          externalMessageId: 'root',
          text: '이 사진 머임??\n[Slack attachment #1: file image/png name=photo.png]',
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
    router.registerHistory('discord-bot', async () => ({
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
    router.registerHistory('discord-bot', async () => {
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
    router.registerHistory('discord-bot', async (args) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
      sent.push(msg.text ?? '')
      return { ok: true }
    })
    router.registerHistory('discord-bot', async () => ({
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('slack-bot', async (msg) => {
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
    router.registerOutbound('slack-bot', async (msg) => {
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
    router.registerOutbound('telegram-bot', async (msg) => {
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
    router.registerOutbound('telegram-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('slack-bot', async (msg) => {
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
    router.registerOutbound('slack-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
    router.registerOutbound('discord-bot', async (msg) => {
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
  ): AfterToolCallContext {
    const toolResult = {
      content: [{ type: 'text' as const, text: 'ignored' }],
      details: result,
    }
    return {
      assistantMessage: assistantMessage('') as AfterToolCallContext['assistantMessage'],
      toolCall: { type: 'toolCall', id: 'tc1', name: toolName, arguments: {} } as AfterToolCallContext['toolCall'],
      args: {},
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
    await router.route(inbound({ text: '이거 읽어봐', attachments: [PHOTO] }))
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

    await router.route(inbound({ text: '이거 읽어봐', attachments: [PHOTO] }))
    await router.__testing!.flushDebounce(KEY)

    // After the turn fully drains, the attachment is no longer part of any
    // pending or in-flight turn, so a late lookup must miss.
    expect(router.lookupInboundAttachment({ ...KEY, id: 1 })).toBeNull()
    expect(router.listInboundAttachmentIds(KEY)).toEqual([])
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
    router.registerReviewThreadResolver('github', async () => ({ ok: true }))

    expect((await router.resolveReviewThread(req)).ok).toBe(true)
  })

  test('last-write-wins and a stale unregister does not wipe a fresh resolver', async () => {
    const { router } = await makeRouter(await tempDir())
    const first = async () => ({ ok: false as const, error: 'first', code: 'transient' as const })
    const second = async () => ({ ok: true as const })
    router.registerReviewThreadResolver('github', first)
    router.registerReviewThreadResolver('github', second)

    router.unregisterReviewThreadResolver('github', first)

    expect((await router.resolveReviewThread(req)).ok).toBe(true)
  })

  test('a thrown resolver becomes a transient failure, not a rejection', async () => {
    const { router } = await makeRouter(await tempDir())
    router.registerReviewThreadResolver('github', async () => {
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
})
