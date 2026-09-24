import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionManager } from '@earendil-works/pi-coding-agent'

import { createSessionFactory } from '@/sessions'

import { SESSION_META_CUSTOM_TYPE, sessionMetaPayload } from './session-meta'
import type { SessionOrigin } from './session-origin'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-session-meta-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('sessionMetaPayload (minimal projection)', () => {
  test('tui origin keeps only kind', () => {
    const out = sessionMetaPayload({ kind: 'tui', sessionId: 'ses_abc' })
    expect(out).toEqual({ origin: { kind: 'tui' } })
  })

  test('cron origin keeps jobId and jobKind, drops scheduledByOrigin', () => {
    const origin: SessionOrigin = {
      kind: 'cron',
      jobId: 'daily-dream',
      jobKind: 'prompt',
      scheduledByRole: 'owner',
      scheduledByOrigin: { kind: 'tui', sessionId: 'parent' },
    }
    expect(sessionMetaPayload(origin)).toEqual({
      origin: { kind: 'cron', jobId: 'daily-dream', jobKind: 'prompt' },
    })
  })

  test('channel origin keeps addressing ids and workspace/chat names, drops participants/membership/authors', () => {
    const origin: SessionOrigin = {
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0123',
      workspaceName: 'Acme Corp',
      chat: 'C0ABC',
      chatName: '#general',
      thread: '1234.567',
      lastInboundAuthorId: 'U_SECRET',
      participants: [{ authorId: 'U1', authorName: 'Alice', firstMessageAt: 0, lastMessageAt: 0, messageCount: 1 }],
    }
    expect(sessionMetaPayload(origin)).toEqual({
      origin: {
        kind: 'channel',
        adapter: 'slack-bot',
        workspace: 'T0123',
        workspaceName: 'Acme Corp',
        chat: 'C0ABC',
        chatName: '#general',
        thread: '1234.567',
      },
    })
  })

  test('channel origin omits workspaceName/chatName fields when unset (does not write key:undefined)', () => {
    const origin: SessionOrigin = {
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0123',
      chat: 'C0ABC',
      thread: null,
    }
    const out = sessionMetaPayload(origin)
    expect(out).toEqual({
      origin: {
        kind: 'channel',
        adapter: 'slack-bot',
        workspace: 'T0123',
        chat: 'C0ABC',
        thread: null,
      },
    })
    if (out.origin.kind !== 'channel') throw new Error('unreachable')
    expect('workspaceName' in out.origin).toBe(false)
    expect('chatName' in out.origin).toBe(false)
  })

  test('subagent origin keeps subagent name and parentSessionId, drops spawnedByOrigin', () => {
    const origin: SessionOrigin = {
      kind: 'subagent',
      subagent: 'memory-logger',
      parentSessionId: 'ses_parent',
      spawnedByRole: 'owner',
      spawnedByOrigin: { kind: 'tui', sessionId: 'parent' },
    }
    expect(sessionMetaPayload(origin)).toEqual({
      origin: { kind: 'subagent', subagent: 'memory-logger', parentSessionId: 'ses_parent' },
    })
  })

  test('does not include author handles or participants on disk', () => {
    const origin: SessionOrigin = {
      kind: 'channel',
      adapter: 'discord-bot',
      workspace: '9999',
      workspaceName: 'Acme Org',
      chat: '8888',
      chatName: 'general',
      thread: null,
      lastInboundAuthorId: 'U_SENSITIVE',
      participants: [
        { authorId: 'U1', authorName: 'Real Person Name', firstMessageAt: 0, lastMessageAt: 0, messageCount: 5 },
      ],
    }
    const stamped = JSON.stringify(sessionMetaPayload(origin))
    expect(stamped).not.toContain('Real Person Name')
    expect(stamped).not.toContain('U_SENSITIVE')
    expect(stamped).not.toContain('"participants"')
    expect(stamped).not.toContain('"lastInboundAuthorId"')
  })
})

describe('session-meta integration with pi-coding-agent', () => {
  // given: a fresh persisted SessionManager from typeclaw's session factory
  function freshSessionManager() {
    const factory = createSessionFactory({ agentDir })
    return factory.createPersisted()
  }

  test('appendCustomEntry on a fresh session does not crash and survives a first turn', () => {
    // given
    const sm = freshSessionManager()
    const origin: SessionOrigin = { kind: 'tui', sessionId: 'ses_test' }

    // when: stamp before first message, then complete a turn
    sm.appendCustomEntry(SESSION_META_CUSTOM_TYPE, sessionMetaPayload(origin))
    const now = Date.now()
    sm.appendMessage({ role: 'user', content: 'hi', timestamp: now })
    sm.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      api: 'fake',
      provider: 'fake',
      model: 'fake',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
      },
      stopReason: 'stop',
      timestamp: now + 1,
    })

    // then
    const entries = sm.getEntries()
    const meta = entries.find((e) => e.type === 'custom' && e.customType === SESSION_META_CUSTOM_TYPE)
    expect(meta).toBeDefined()
    if (meta?.type !== 'custom') throw new Error('unreachable')
    expect(meta.data).toEqual({ origin: { kind: 'tui' } })
  })

  test('stamped session file is still readable by SessionManager.open()', async () => {
    // given
    const sm = freshSessionManager()
    const file = sm.getSessionFile()
    if (!file) throw new Error('expected persisted session file')

    // when: stamp + turn → flush
    sm.appendCustomEntry(SESSION_META_CUSTOM_TYPE, sessionMetaPayload({ kind: 'cron', jobId: 'j1', jobKind: 'prompt' }))
    const now = Date.now()
    sm.appendMessage({ role: 'user', content: 'hi', timestamp: now })
    sm.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'reply' }],
      api: 'fake',
      provider: 'fake',
      model: 'fake',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
      },
      stopReason: 'stop',
      timestamp: now + 1,
    })

    // when: reopen
    const reopened = SessionManager.open(file)

    // then: SessionManager.open does not return [] (would mean broken file)
    const entries = reopened.getEntries()
    expect(entries.length).toBeGreaterThan(0)
    const messages = entries.filter((e) => e.type === 'message')
    expect(messages).toHaveLength(2)
    const meta = entries.find((e) => e.type === 'custom' && e.customType === SESSION_META_CUSTOM_TYPE)
    expect(meta).toBeDefined()
  })

  test('first JSONL line on disk remains the session header (pi invariant)', async () => {
    // given
    const sm = freshSessionManager()
    const file = sm.getSessionFile()
    if (!file) throw new Error('expected persisted session file')

    // when
    sm.appendCustomEntry(SESSION_META_CUSTOM_TYPE, sessionMetaPayload({ kind: 'tui', sessionId: 'ses_x' }))
    const now = Date.now()
    sm.appendMessage({ role: 'user', content: 'hi', timestamp: now })
    sm.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'r' }],
      api: 'fake',
      provider: 'fake',
      model: 'fake',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
      },
      stopReason: 'stop',
      timestamp: now + 1,
    })

    // then
    const content = await readFile(file, 'utf8')
    const firstLine = content.split('\n')[0]!
    const firstEntry = JSON.parse(firstLine)
    expect(firstEntry.type).toBe('session')
  })
})
