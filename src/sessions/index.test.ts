import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionManager } from '@earendil-works/pi-coding-agent'

import { createSessionFactory } from './index'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-sessions-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('createSessionFactory', () => {
  test('creates the sessions directory under the agent dir on construction', () => {
    const factory = createSessionFactory({ agentDir })

    expect(factory.sessionDir()).toBe(join(agentDir, 'sessions'))
    expect(existsSync(factory.sessionDir())).toBe(true)
    expect(statSync(factory.sessionDir()).isDirectory()).toBe(true)
  })

  test('createPersisted returns a SessionManager whose file is under sessionDir and ends in .jsonl', () => {
    const factory = createSessionFactory({ agentDir })

    const mgr = factory.createPersisted()
    const file = mgr.getSessionFile()

    expect(file).toBeDefined()
    expect(file?.startsWith(factory.sessionDir())).toBe(true)
    expect(file?.endsWith('.jsonl')).toBe(true)
  })

  test('two createPersisted calls produce two different session files', () => {
    const factory = createSessionFactory({ agentDir })

    const a = factory.createPersisted()
    const b = factory.createPersisted()

    expect(a.getSessionFile()).not.toBe(b.getSessionFile())
  })

  test('appended messages survive on disk once a turn completes (user + assistant)', () => {
    // Pi defers the first write until the first assistant message arrives, to
    // avoid creating empty session files for sessions that never produced a
    // turn. We rely on that contract; testing it pins the contract in place.

    // given
    const factory = createSessionFactory({ agentDir })
    const writer = factory.createPersisted()
    const file = writer.getSessionFile()
    if (!file) throw new Error('expected persisted session file')
    const now = Date.now()
    writer.appendMessage({ role: 'user', content: 'hello', timestamp: now })
    writer.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi back' }],
      api: 'openai-completions',
      provider: 'fake',
      model: 'fake',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: now + 1,
    })

    // when
    const reader = SessionManager.open(file)

    // then
    const messageEntries = reader.getEntries().filter((e) => e.type === 'message')
    expect(messageEntries).toHaveLength(2)
    if (messageEntries[0]?.type !== 'message') throw new Error('unreachable')
    expect(messageEntries[0].message.role).toBe('user')
    if (messageEntries[1]?.type !== 'message') throw new Error('unreachable')
    expect(messageEntries[1].message.role).toBe('assistant')
  })
})
