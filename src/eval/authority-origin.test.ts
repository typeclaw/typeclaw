import { describe, expect, test } from 'bun:test'

import type { SessionOrigin } from '@/agent/session-origin'

import { authorityOrigin } from './sandbox'

const channel = (overrides: Partial<Extract<SessionOrigin, { kind: 'channel' }>> = {}): SessionOrigin => ({
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: 'T0123456789',
  workspaceName: 'Acme',
  chat: 'C0123456789',
  chatName: 'general',
  thread: null,
  lastInboundAuthorId: 'U1',
  participants: [{ authorId: 'U1', authorName: 'Alice', firstMessageAt: 1, lastMessageAt: 1, messageCount: 1 }],
  ...overrides,
})

const same = (a: SessionOrigin, b: SessionOrigin) =>
  JSON.stringify(authorityOrigin(a)) === JSON.stringify(authorityOrigin(b))

describe('authorityOrigin', () => {
  test('ignores conversational state that changes on every inbound message', () => {
    const next = channel({
      participants: [{ authorId: 'U1', authorName: 'Alice', firstMessageAt: 1, lastMessageAt: 9, messageCount: 4 }],
      chatName: '일반',
      membership: { humans: 3, bots: 1 } as never,
    })

    expect(same(channel(), next)).toBe(true)
  })

  test('changes when the principal or audience changes', () => {
    expect(same(channel(), channel({ lastInboundAuthorId: 'U2' }))).toBe(false)
    expect(same(channel(), channel({ chat: 'C9876543210' }))).toBe(false)
    expect(same(channel(), channel({ thread: '171234.0001' }))).toBe(false)
  })

  test('applies the same rule to a subagent spawned from a channel', () => {
    const spawned = (origin: SessionOrigin): SessionOrigin => ({
      kind: 'subagent',
      subagent: 'operator',
      parentSessionId: 'parent',
      spawnedByOrigin: origin,
    })

    expect(same(spawned(channel()), spawned(channel({ chatName: 'renamed' })))).toBe(true)
    expect(same(spawned(channel()), spawned(channel({ lastInboundAuthorId: 'U2' })))).toBe(false)
  })
})
