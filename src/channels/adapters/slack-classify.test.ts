import { describe, expect, test } from 'bun:test'

import type { SlackRTMMessageEvent } from 'agent-messenger/slack'

import { defaultChannelAdapterConfig } from '@/channels/schema'

import { classifyInbound } from './slack-classify'

const config = defaultChannelAdapterConfig()
const context = { teamId: 'T0123456789', selfUserId: 'USELF', selfAliases: ['typeclaw'] }

function event(overrides: Partial<SlackRTMMessageEvent> = {}): SlackRTMMessageEvent {
  return {
    type: 'message',
    channel: 'C0123456789',
    user: 'UUSER',
    text: 'hello',
    ts: '1770000000.000100',
    ...overrides,
  }
}

describe('classifyInbound (slack user)', () => {
  test('drops unrouteable RTM messages', () => {
    expect(classifyInbound(event({ user: 'USELF' }), config, context)).toEqual({ kind: 'drop', reason: 'self_author' })
    expect(classifyInbound(event({ user: undefined }), config, context)).toEqual({ kind: 'drop', reason: 'no_user' })
    expect(classifyInbound(event({ subtype: 'message_changed' }), config, context)).toEqual({
      kind: 'drop',
      reason: 'slack_system_message',
    })
    expect(classifyInbound(event({ text: '' }), config, context)).toEqual({ kind: 'drop', reason: 'empty_text' })
    expect(classifyInbound(event(), config, { ...context, selfUserId: null })).toEqual({
      kind: 'drop',
      reason: 'pre_connect',
    })
  })

  test('routes DMs with @dm workspace and no thread', () => {
    const verdict = classifyInbound(event({ channel: 'D0123456789' }), config, context)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.workspace).toBe('@dm')
    expect(verdict.payload.isDm).toBe(true)
    expect(verdict.payload.thread).toBeNull()
  })

  test('detects self mentions, group mentions, and other mentions', () => {
    const selfMention = classifyInbound(event({ text: 'hello <@USELF>' }), config, context)
    const groupMention = classifyInbound(event({ text: '<!channel> deploy?' }), config, context)
    const otherMention = classifyInbound(event({ text: 'ask <@UOTHER>' }), config, context)

    expect(selfMention.kind === 'route' && selfMention.payload.isBotMention).toBe(true)
    expect(groupMention.kind === 'route' && groupMention.payload.isBotMention).toBe(true)
    expect(otherMention.kind === 'route' && otherMention.payload.mentionsOthers).toBe(true)
  })

  test('anchors English and Korean alias-addressed channel messages', () => {
    const english = classifyInbound(event({ text: 'typeclaw please check this' }), config, context)
    const korean = classifyInbound(event({ text: 'typeclaw 확인해 주세요' }), config, context)

    expect(english.kind === 'route' && english.payload.thread).toBe('1770000000.000100')
    expect(korean.kind === 'route' && korean.payload.thread).toBe('1770000000.000100')
  })
})
