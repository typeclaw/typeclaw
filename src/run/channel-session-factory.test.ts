import { describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionManager } from '@mariozechner/pi-coding-agent'
import type { AgentSession } from '@mariozechner/pi-coding-agent'

import type { CreateSessionOptions } from '@/agent'
import * as realCapJsonlModule from '@/bundled-plugins/tool-result-cap/cap-jsonl'
import {
  capJsonlFileInPlace as realCapJsonlFileInPlace,
  type CapJsonlStats,
} from '@/bundled-plugins/tool-result-cap/cap-jsonl'
import type { CapOptions } from '@/bundled-plugins/tool-result-cap/cap-result'
import type { ChannelRouter, CreateSessionForChannel } from '@/channels'
import type { ReloadRegistry } from '@/reload'
import type { SessionFactory } from '@/sessions'
import type { Stream } from '@/stream'

import { createPluginRuntime, type PluginRuntime } from './plugin-runtime'

let capJsonlFileInPlace = realCapJsonlFileInPlace

mock.module('@/bundled-plugins/tool-result-cap/cap-jsonl', () => ({
  ...realCapJsonlModule,
  capJsonlFileInPlace: (path: string, options: CapOptions): CapJsonlStats => capJsonlFileInPlace(path, options),
}))

// The factory must load after the cap module mock so the test can model the
// file race between the pre-open cap and SessionManager.open.
const { buildChannelSessionFactory } = await import('./channel-session-factory')
function makeFakeRouter(): ChannelRouter {
  return {} as ChannelRouter
}

function makeFakeStream(): Stream {
  return {} as Stream
}

function makeFakeReloadRegistry(): ReloadRegistry {
  return {} as ReloadRegistry
}

function makeFakeSessionFactory(sessionDir: string): SessionFactory {
  return { sessionDir: () => sessionDir } as SessionFactory
}

function makeEmptyRuntime(): PluginRuntime {
  return createPluginRuntime({
    registry: { tools: [], subagents: [], cronJobs: [], skills: [], skillsDirs: [], doctorChecks: [] } as never,
    hooks: {} as never,
    subagents: { byName: new Map(), all: [] } as never,
    pluginSubagentByShim: new WeakMap(),
    hasAnyPluginContent: false,
    loadedPlugins: [],
    materializedSkills: null,
  })
}

function makeRuntimeWithPlugin(): PluginRuntime {
  return createPluginRuntime({
    registry: { tools: [], subagents: [], cronJobs: [], skills: [], skillsDirs: [], doctorChecks: [] } as never,
    hooks: {} as never,
    subagents: { byName: new Map(), all: [] } as never,
    pluginSubagentByShim: new WeakMap(),
    hasAnyPluginContent: true,
    loadedPlugins: [{ name: 'memory', version: undefined, source: '<bundled>' }],

    materializedSkills: null,
  })
}

function writePersistedSession(sessionDir: string, sessionFile: string, sessionId: string): void {
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(
    join(sessionDir, sessionFile),
    `${JSON.stringify({
      type: 'session',
      id: sessionId,
      timestamp: '2026-01-01T00:00:00Z',
      cwd: sessionDir,
      version: 3,
    })}\n`,
  )
}

function codedError(code: string, message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  Object.defineProperty(error, 'code', { value: code })
  return error
}

const STUB_SESSION = { dispose: () => {} } as unknown as AgentSession

const CHANNEL_KEY = {
  adapter: 'discord-bot' as const,
  workspace: '@dm',
  chat: 'c1',
  thread: null,
}

const CHANNEL_ORIGIN = {
  kind: 'channel' as const,
  ...CHANNEL_KEY,
  participants: [],
}

const REHYDRATE_CAP_OPTIONS: CapOptions = {
  imageMaxBytes: 100,
  textMaxBytes: 100,
}

type RehydrateHarness = {
  factory: CreateSessionForChannel
  warnings: string[]
}

function makeRehydrateHarness(
  cwd: string,
  rehydrateCapOptions: CapOptions | null = REHYDRATE_CAP_OPTIONS,
): RehydrateHarness {
  const warnings: string[] = []
  const factory = buildChannelSessionFactory({
    cwd,
    sessionFactory: makeFakeSessionFactory(join(cwd, 'sessions')),
    stream: makeFakeStream(),
    reloadRegistry: makeFakeReloadRegistry(),
    pluginRuntime: makeEmptyRuntime(),
    getChannelRouter: makeFakeRouter,
    createSession: async function createStubSession(): Promise<AgentSession> {
      return STUB_SESSION
    },
    rehydrateCapOptions,
    logger: {
      info: function ignoreInfo() {},
      warn: function captureWarning(message: string) {
        warnings.push(message)
      },
    },
  })
  return { factory, warnings }
}

async function rehydrateChannelSession(
  factory: CreateSessionForChannel,
  existingSessionId: string,
  existingSessionFile: string,
): Promise<string> {
  const result = await factory({
    key: CHANNEL_KEY,
    existingSessionId,
    existingSessionFile,
    participants: [],
    origin: CHANNEL_ORIGIN,
    originRef: { current: undefined },
  })
  return result.sessionId
}

type Captured = CreateSessionOptions | undefined

describe('buildChannelSessionFactory — production wiring contract', () => {
  test('creates sessions with channelRouter set (the bug this factory fixes)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const router = makeFakeRouter()
    let captured: Captured = undefined
    const fakeCreateSession = async (options?: CreateSessionOptions) => {
      captured = options
      return STUB_SESSION
    }

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: () => router,
      createSession: fakeCreateSession,
      rehydrateCapOptions: null,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(captured).toBeDefined()
    expect(captured!.channelRouter).toBe(router)
  })

  test('threads stream and reloadRegistry into the session (so reload + stream tools are wired)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const stream = makeFakeStream()
    const reloadRegistry = makeFakeReloadRegistry()
    let captured: Captured = undefined

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream,
      reloadRegistry,
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
      rehydrateCapOptions: null,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(captured!.stream).toBe(stream)
    expect(captured!.reloadRegistry).toBe(reloadRegistry)
  })

  test('omits plugin wiring when the runtime has no plugin content (avoids cost of plugin tool injection)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    let captured: Captured = undefined

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
      rehydrateCapOptions: null,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(captured!.plugins).toBeUndefined()
  })

  test('threads plugin runtime into the session when plugins are present', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const runtime = makeRuntimeWithPlugin()
    let captured: Captured = undefined

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: runtime,
      getChannelRouter: makeFakeRouter,
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
      rehydrateCapOptions: null,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(captured!.plugins).toBeDefined()
    expect(captured!.plugins!.registry).toBe(runtime.get().registry)
    expect(captured!.plugins!.hooks).toBe(runtime.get().hooks)
    expect(captured!.plugins!.agentDir).toBe(tmp)
  })

  test('passes through the channel origin verbatim so channel_send target matches inbound', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    let captured: Captured = undefined
    const origin = {
      kind: 'channel' as const,
      adapter: 'discord-bot' as const,
      workspace: 'guild-123',
      chat: 'channel-456',
      thread: null,
      participants: [{ authorId: 'u1', authorName: 'alice', firstMessageAt: 1, lastMessageAt: 1, messageCount: 1 }],
    }

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
      rehydrateCapOptions: null,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: 'guild-123', chat: 'channel-456', thread: null },
      participants: origin.participants,
      origin,
      originRef: { current: undefined },
    })

    expect(captured!.origin).toEqual(origin)
  })

  test('reads getChannelRouter lazily so the manager-router construction cycle resolves', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    let router: ChannelRouter | null = null
    let captured: Captured = undefined

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: () => {
        if (router === null) throw new Error('router not yet bound')
        return router
      },
      createSession: async (options) => {
        captured = options
        return STUB_SESSION
      },
      rehydrateCapOptions: null,
    })

    router = makeFakeRouter()

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(captured!.channelRouter).toBe(router)
  })

  test('uses sessionFactory.sessionDir() so persisted sessions land where the rest of the runtime expects', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const sessionDir = join(tmp, 'sessions')
    let capturedSm: SessionManager | null = null

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(sessionDir),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async (options) => {
        capturedSm = options?.sessionManager ?? null
        return STUB_SESSION
      },
      rehydrateCapOptions: null,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(capturedSm).not.toBeNull()
  })

  test('returns hooks and getTranscriptPath so the channel router can fire session.idle/session.end', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const runtime = makeRuntimeWithPlugin()

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: runtime,
      getChannelRouter: makeFakeRouter,
      createSession: async () => STUB_SESSION,
      rehydrateCapOptions: null,
    })

    const result = await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(result.hooks).toBe(runtime.get().hooks)
    expect(typeof result.getTranscriptPath).toBe('function')
    expect(result.getTranscriptPath?.()).toMatch(/sessions[/\\]/)
  })

  test('omits hooks when no plugin runtime content (matches existing plugin-omission policy)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(join(tmp, 'sessions')),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async () => STUB_SESSION,
      rehydrateCapOptions: null,
    })

    const result = await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(result.hooks).toBeUndefined()
  })

  test('caps oversized tool results in the JSONL before pi-coding-agent opens it', async () => {
    const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs')
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const sessionDir = join(tmp, 'sessions')
    mkdirSync(sessionDir, { recursive: true })
    const sessionFile = 'poisoned.jsonl'
    const sessionPath = join(sessionDir, sessionFile)
    const lines = [
      JSON.stringify({ type: 'session', id: 'poisoned-id', timestamp: '2026-05-12T00:00:00Z', cwd: tmp, version: 3 }),
      JSON.stringify({
        type: 'message',
        id: 'e1',
        parentId: null,
        timestamp: '2026-05-12T00:00:01Z',
        message: {
          role: 'toolResult',
          toolCallId: 'functions.read:1',
          toolName: 'read',
          content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(5000) }],
        },
      }),
    ]
    writeFileSync(sessionPath, `${lines.join('\n')}\n`)
    const capLogs: string[] = []
    const warnLogs: string[] = []

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(sessionDir),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async () => STUB_SESSION,
      rehydrateCapOptions: { imageMaxBytes: 100, textMaxBytes: 100, exemptTools: new Set() },
      logger: { info: (msg) => capLogs.push(msg), warn: (msg) => warnLogs.push(msg) },
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      existingSessionId: 'poisoned-id',
      existingSessionFile: sessionFile,
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    const after = readFileSync(sessionPath, 'utf8')
    expect(after).not.toContain('A'.repeat(5000))
    expect(after).toContain('tool-result-cap')
    expect(capLogs.some((l) => l.includes('rehydrate-cap'))).toBe(true)
  })

  test('leaves the JSONL untouched when rehydrateCapOptions is null', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const sessionDir = join(tmp, 'sessions')
    mkdirSync(sessionDir, { recursive: true })
    const sessionFile = 'untouched.jsonl'
    const sessionPath = join(sessionDir, sessionFile)
    const original = `${JSON.stringify({
      type: 'session',
      id: 'untouched-id',
      timestamp: '2026-05-12T00:00:00Z',
      cwd: tmp,
      version: 3,
    })}\n${JSON.stringify({
      type: 'message',
      id: 'e1',
      parentId: null,
      timestamp: '2026-05-12T00:00:01Z',
      message: {
        role: 'toolResult',
        toolCallId: 'functions.read:1',
        toolName: 'read',
        content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(5000) }],
      },
    })}\n`
    writeFileSync(sessionPath, original)

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(sessionDir),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async () => STUB_SESSION,
      rehydrateCapOptions: null,
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      existingSessionId: 'untouched-id',
      existingSessionFile: sessionFile,
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(readFileSync(sessionPath, 'utf8')).toBe(original)
  })

  test('rejects path-traversal sessionFile and falls back to a fresh session', async () => {
    const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import('node:fs')
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const sessionDir = join(tmp, 'sessions')
    mkdirSync(sessionDir, { recursive: true })
    // A bystander file outside sessions/ that the cap pass must never touch
    // even if a tampered channels/sessions.json#sessionFile points at it.
    const bystander = join(tmp, 'bystander.jsonl')
    const bystanderContent = `${JSON.stringify({
      type: 'message',
      id: 'b1',
      parentId: null,
      timestamp: '2026-05-12T00:00:01Z',
      message: {
        role: 'toolResult',
        toolCallId: 'functions.read:1',
        toolName: 'read',
        content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(5000) }],
      },
    })}\n`
    writeFileSync(bystander, bystanderContent)
    const warnLogs: string[] = []

    const factory = buildChannelSessionFactory({
      cwd: tmp,
      sessionFactory: makeFakeSessionFactory(sessionDir),
      stream: makeFakeStream(),
      reloadRegistry: makeFakeReloadRegistry(),
      pluginRuntime: makeEmptyRuntime(),
      getChannelRouter: makeFakeRouter,
      createSession: async () => STUB_SESSION,
      rehydrateCapOptions: { imageMaxBytes: 100, textMaxBytes: 100, exemptTools: new Set() },
      logger: { info: () => {}, warn: (msg) => warnLogs.push(msg) },
    })

    await factory({
      key: { adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null },
      existingSessionId: 'malicious',
      existingSessionFile: '../bystander.jsonl',
      participants: [],
      origin: { kind: 'channel', adapter: 'discord-bot', workspace: '@dm', chat: 'c1', thread: null, participants: [] },
      originRef: { current: undefined },
    })

    expect(readFileSync(bystander, 'utf8')).toBe(bystanderContent)
    expect(existsSync(join(sessionDir, '../bystander.jsonl.cap.tmp'))).toBe(false)
    expect(warnLogs).toContain('[channels] persisted session file is invalid; creating new')
  })

  test('suppresses an ENOENT cap race when the persisted session opens', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    writePersistedSession(join(tmp, 'sessions'), 'persisted.jsonl', 'persisted-session')
    const originalCap = capJsonlFileInPlace
    capJsonlFileInPlace = () => {
      throw new Error('wrapper', { cause: codedError('ENOENT', 'private missing path') })
    }
    try {
      const { factory, warnings } = makeRehydrateHarness(tmp)
      const sessionId = await rehydrateChannelSession(factory, 'persisted-session', 'persisted.jsonl')
      expect(sessionId).toBe('persisted-session')
      expect(warnings).toEqual([])
    } finally {
      capJsonlFileInPlace = originalCap
    }
  })

  test('self-heals a missing transcript after an ENOENT cap without warning', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const originalCap = capJsonlFileInPlace
    capJsonlFileInPlace = () => {
      throw new Error('wrapper', { cause: codedError('ENOENT', 'private missing path') })
    }
    try {
      const { factory, warnings } = makeRehydrateHarness(tmp)
      const sessionId = await rehydrateChannelSession(factory, 'missing-session', 'missing.jsonl')
      expect(sessionId).not.toBe('missing-session')
      expect(warnings).toEqual([])
    } finally {
      capJsonlFileInPlace = originalCap
    }
  })

  test('warns for a non-ENOENT cap failure while reopening the session', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    writePersistedSession(join(tmp, 'sessions'), 'persisted.jsonl', 'persisted-session')
    const originalCap = capJsonlFileInPlace
    capJsonlFileInPlace = () => {
      throw new Error('wrapper', { cause: codedError('EIO', 'private storage failure') })
    }
    try {
      const { factory, warnings } = makeRehydrateHarness(tmp)
      const sessionId = await rehydrateChannelSession(factory, 'persisted-session', 'persisted.jsonl')
      expect(sessionId).toBe('persisted-session')
      expect(warnings).toEqual(['[channels] rehydrate-cap unavailable; continuing with open'])
    } finally {
      capJsonlFileInPlace = originalCap
    }
  })

  test('warns when malformed JSONL is silently replaced during rehydrate', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const sessionId = 'private-persisted-session'
    const sessionFile = 'private-persisted-session.jsonl'
    const malformedJsonl = 'private malformed JSONL payload'
    const sessionDir = join(tmp, 'sessions')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, sessionFile), malformedJsonl)

    const { factory, warnings } = makeRehydrateHarness(tmp, null)
    const replacementSessionId = await rehydrateChannelSession(factory, sessionId, sessionFile)

    expect(replacementSessionId).not.toBe(sessionId)
    expect(readFileSync(join(sessionDir, sessionFile), 'utf8')).not.toContain(malformedJsonl)
    expect(warnings).toEqual(['[channels] persisted session was replaced during rehydrate'])
    expect(warnings.join('\n')).not.toContain(sessionId)
    expect(warnings.join('\n')).not.toContain(sessionFile)
    expect(warnings.join('\n')).not.toContain(tmp)
    expect(warnings.join('\n')).not.toContain(malformedJsonl)
  })

  test('self-heals a non-ENOENT open failure with a distinct warning', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    writePersistedSession(join(tmp, 'sessions'), 'persisted.jsonl', 'persisted-session')
    const originalOpen = SessionManager.open
    Object.defineProperty(SessionManager, 'open', {
      configurable: true,
      value: () => {
        throw codedError('EIO', 'private open failure')
      },
      writable: true,
    })
    try {
      const { factory, warnings } = makeRehydrateHarness(tmp, null)
      const sessionId = await rehydrateChannelSession(factory, 'persisted-session', 'persisted.jsonl')
      expect(sessionId).not.toBe('persisted-session')
      expect(warnings).toEqual(['[channels] persisted session rehydrate failed; creating new'])
    } finally {
      Object.defineProperty(SessionManager, 'open', {
        configurable: true,
        value: originalOpen,
        writable: true,
      })
    }
  })

  test('self-heals a nested ENOENT open failure without warning', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const originalOpen = SessionManager.open
    Object.defineProperty(SessionManager, 'open', {
      configurable: true,
      value: () => {
        throw new Error('wrapper', { cause: codedError('ENOENT', 'private open path') })
      },
      writable: true,
    })
    try {
      const { factory, warnings } = makeRehydrateHarness(tmp, null)
      const sessionId = await rehydrateChannelSession(factory, 'missing-session', 'missing.jsonl')
      expect(sessionId).not.toBe('missing-session')
      expect(warnings).toEqual([])
    } finally {
      Object.defineProperty(SessionManager, 'open', {
        configurable: true,
        value: originalOpen,
        writable: true,
      })
    }
  })

  test('propagates fresh-session creation failures after rehydration fails', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const originalOpen = SessionManager.open
    const originalCreate = SessionManager.create
    const createFailure = codedError('ENOSPC', 'private create failure')
    Object.defineProperty(SessionManager, 'open', {
      configurable: true,
      value: () => {
        throw codedError('ENOENT', 'private open failure')
      },
      writable: true,
    })
    Object.defineProperty(SessionManager, 'create', {
      configurable: true,
      value: () => {
        throw createFailure
      },
      writable: true,
    })
    try {
      const { factory } = makeRehydrateHarness(tmp, null)
      await expect(rehydrateChannelSession(factory, 'missing-session', 'missing.jsonl')).rejects.toBe(createFailure)
    } finally {
      Object.defineProperty(SessionManager, 'open', {
        configurable: true,
        value: originalOpen,
        writable: true,
      })
      Object.defineProperty(SessionManager, 'create', {
        configurable: true,
        value: originalCreate,
        writable: true,
      })
    }
  })

  test('sanitizes fallback warnings', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'channel-session-factory-'))
    const sessionId = 'private-session-identifier'
    const sessionFile = 'private-session-file.jsonl'
    const privateDetail = 'private-path-and-error-detail'
    writePersistedSession(join(tmp, 'sessions'), sessionFile, sessionId)
    const originalCap = capJsonlFileInPlace
    const originalOpen = SessionManager.open
    capJsonlFileInPlace = () => {
      throw codedError('EIO', privateDetail)
    }
    Object.defineProperty(SessionManager, 'open', {
      configurable: true,
      value: () => {
        throw codedError('EIO', privateDetail)
      },
      writable: true,
    })
    try {
      const { factory, warnings } = makeRehydrateHarness(tmp)
      await rehydrateChannelSession(factory, sessionId, sessionFile)
      expect(warnings).toEqual([
        '[channels] rehydrate-cap unavailable; continuing with open',
        '[channels] persisted session rehydrate failed; creating new',
      ])
      expect(warnings.join('\n')).not.toContain(sessionId)
      expect(warnings.join('\n')).not.toContain(sessionFile)
      expect(warnings.join('\n')).not.toContain(privateDetail)
    } finally {
      capJsonlFileInPlace = originalCap
      Object.defineProperty(SessionManager, 'open', {
        configurable: true,
        value: originalOpen,
        writable: true,
      })
    }
  })
})
