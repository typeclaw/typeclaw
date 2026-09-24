import { describe, expect, test } from 'bun:test'

import type { SessionManager } from '@earendil-works/pi-coding-agent'

import { buildRestartHandoffWiring, currentChannelAuthor } from './index'
import type { SessionOrigin } from './session-origin'

function fakeSessionManager(sessionFile: string | undefined): SessionManager {
  return { getSessionFile: () => sessionFile } as unknown as SessionManager
}

const tuiOrigin: SessionOrigin = { kind: 'tui', sessionId: 'ses-1' }
const channelOrigin: SessionOrigin = {
  kind: 'channel',
  adapter: 'discord-bot',
  workspace: 'g1',
  chat: 'c1',
  thread: 't1',
}

describe('buildRestartHandoffWiring', () => {
  test('emits a tui handoff for a persisted TUI session', () => {
    const result = buildRestartHandoffWiring(
      { origin: tuiOrigin, plugins: { agentDir: '/agent' } },
      fakeSessionManager('/agent/sessions/ses-1.jsonl'),
    )
    expect(result).toEqual({
      agentDir: '/agent',
      originatingSessionFile: '/agent/sessions/ses-1.jsonl',
      handoffOrigin: { kind: 'tui' },
    })
  })

  test('emits a channel handoff carrying the channel key for a persisted channel session', () => {
    const result = buildRestartHandoffWiring(
      { origin: channelOrigin, plugins: { agentDir: '/agent' } },
      fakeSessionManager('/agent/sessions/ses-2.jsonl'),
    )
    expect(result).toEqual({
      agentDir: '/agent',
      originatingSessionFile: '/agent/sessions/ses-2.jsonl',
      handoffOrigin: { kind: 'channel', key: { adapter: 'discord-bot', workspace: 'g1', chat: 'c1', thread: 't1' } },
    })
  })

  test('emits nothing for cron / subagent / system origins', () => {
    const cron: SessionOrigin = { kind: 'cron', jobId: 'j1', jobKind: 'prompt' }
    const subagent: SessionOrigin = { kind: 'subagent', subagent: 'explorer', parentSessionId: 'p1' }
    const system: SessionOrigin = { kind: 'system', component: 'backup' }
    for (const origin of [cron, subagent, system]) {
      expect(
        buildRestartHandoffWiring({ origin, plugins: { agentDir: '/agent' } }, fakeSessionManager('/f.jsonl')),
      ).toEqual({})
    }
  })

  test('emits nothing when the session is not persisted (no file on disk)', () => {
    expect(
      buildRestartHandoffWiring({ origin: tuiOrigin, plugins: { agentDir: '/agent' } }, fakeSessionManager(undefined)),
    ).toEqual({})
  })

  test('emits nothing when agentDir is absent', () => {
    expect(buildRestartHandoffWiring({ origin: tuiOrigin }, fakeSessionManager('/agent/sessions/ses-1.jsonl'))).toEqual(
      {},
    )
  })

  test('emits nothing when origin is undefined', () => {
    expect(
      buildRestartHandoffWiring({ plugins: { agentDir: '/agent' } }, fakeSessionManager('/agent/sessions/ses-1.jsonl')),
    ).toEqual({})
  })
})

describe('currentChannelAuthor', () => {
  test('reads the LIVE turn author, not the session-creation author', () => {
    // given: a live origin holder advanced to a SECOND author after creation
    const ref: { current: SessionOrigin | undefined } = {
      current: { ...channelOrigin, lastInboundAuthorId: 'U_OPENER' },
    }
    const getOrigin = (): SessionOrigin | undefined => ref.current
    expect(currentChannelAuthor(getOrigin)).toBe('U_OPENER')

    // when: a different speaker drives the current turn
    ref.current = { ...channelOrigin, lastInboundAuthorId: 'U_LATER' }

    // then: the provider reflects the current turn, not the opener
    expect(currentChannelAuthor(getOrigin)).toBe('U_LATER')
  })

  test('returns undefined for tui and channel-without-author origins', () => {
    expect(currentChannelAuthor(() => tuiOrigin)).toBeUndefined()
    expect(currentChannelAuthor(() => channelOrigin)).toBeUndefined()
    expect(currentChannelAuthor(() => undefined)).toBeUndefined()
  })
})
