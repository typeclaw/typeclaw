import { describe, expect, test } from 'bun:test'

import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'

import type { SessionOrigin } from '@/agent/session-origin'

import { listActiveTurns, trackTurnActivity } from './activity'

function fakeSession() {
  let listener: (event: AgentSessionEvent) => void = () => {}
  return {
    subscribe: (fn: (event: AgentSessionEvent) => void) => {
      listener = fn
      return () => {
        listener = () => {}
      }
    },
    emit: (event: Record<string, unknown>) => listener(event as unknown as AgentSessionEvent),
  }
}

const channel: SessionOrigin = { kind: 'channel', adapter: 'github', workspace: 'acme', chat: 'pr:279', thread: null }
const at = () => new Date('2026-11-18T05:17:06.000Z')

describe('trackTurnActivity', () => {
  test('lists a turn while it runs, with the tool still executing, and drops it when it ends', () => {
    const session = fakeSession()
    const untrack = trackTurnActivity(session, () => channel, at)

    session.emit({ type: 'agent_start' })
    session.emit({ type: 'tool_execution_start', toolCallId: '1', toolName: 'read', args: { path: '/secret' } })
    session.emit({ type: 'tool_execution_end', toolCallId: '1', toolName: 'read', result: null, isError: false })
    session.emit({ type: 'tool_execution_start', toolCallId: '2', toolName: 'webfetch', args: { url: 'https://x' } })

    expect(listActiveTurns()).toEqual([
      { origin: 'channel', key: 'github:acme:pr:279:', startedAt: '2026-11-18T05:17:06.000Z', tool: 'webfetch' },
    ])

    session.emit({ type: 'agent_end', messages: [] })
    expect(listActiveTurns()).toEqual([])
    untrack()
  })

  test('disposing a session mid-turn removes it', () => {
    const session = fakeSession()
    const untrack = trackTurnActivity(session, () => undefined, at)
    session.emit({ type: 'agent_start' })

    untrack()

    expect(listActiveTurns()).toEqual([])
  })
})
