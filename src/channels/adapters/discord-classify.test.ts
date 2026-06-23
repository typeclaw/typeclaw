import { describe, expect, test } from 'bun:test'

import type { DiscordGatewayMessageCreateEvent } from 'agent-messenger/discord'

import { defaultChannelAdapterConfig } from '@/channels/schema'

import { classifyInbound } from './discord-classify'

const config = defaultChannelAdapterConfig()
const context = { selfUserId: '100000000000000001', selfAliases: ['typeclaw', '타입클로'] }

function event(overrides: Partial<DiscordGatewayMessageCreateEvent> = {}): DiscordGatewayMessageCreateEvent {
  return {
    type: 'MESSAGE_CREATE',
    id: '400000000000000004',
    channel_id: '300000000000000003',
    guild_id: '200000000000000002',
    author: { id: '500000000000000005', username: 'alice' },
    content: 'hello',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('classifyInbound (discord user)', () => {
  test('drops unrouteable gateway messages', () => {
    expect(classifyInbound(event({ author: { id: '100000000000000001', username: 'self' } }), config, context)).toEqual(
      {
        kind: 'drop',
        reason: 'self_author',
      },
    )
    expect(classifyInbound(event({ author: { id: '', username: 'alice' } }), config, context)).toEqual({
      kind: 'drop',
      reason: 'no_user',
    })
    expect(classifyInbound(event({ content: '' }), config, context)).toEqual({ kind: 'drop', reason: 'empty_content' })
    expect(classifyInbound(event(), config, { ...context, selfUserId: null })).toEqual({
      kind: 'drop',
      reason: 'pre_connect',
    })
  })

  test('routes DMs with @dm workspace and no thread', () => {
    const verdict = classifyInbound(event({ guild_id: undefined }), config, context)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') return
    expect(verdict.payload.workspace).toBe('@dm')
    expect(verdict.payload.isDm).toBe(true)
    expect(verdict.payload.thread).toBeNull()
  })

  test('detects self mentions, group mentions, and other mentions', () => {
    const selfMention = classifyInbound(event({ content: 'hello <@100000000000000001>' }), config, context)
    const nickMention = classifyInbound(event({ content: 'hello <@!100000000000000001>' }), config, context)
    const groupMention = classifyInbound(event({ content: '@everyone deploy?' }), config, context)
    const otherMention = classifyInbound(
      event({ content: 'ask <@600000000000000006>', mentions: [{ id: '600000000000000006', username: 'bob' }] }),
      config,
      context,
    )

    expect(selfMention.kind === 'route' && selfMention.payload.isBotMention).toBe(true)
    expect(nickMention.kind === 'route' && nickMention.payload.isBotMention).toBe(true)
    expect(groupMention.kind === 'route' && groupMention.payload.isBotMention).toBe(true)
    expect(otherMention.kind === 'route' && otherMention.payload.mentionsOthers).toBe(true)
  })

  test('routes English and Korean alias-addressed channel messages without threads', () => {
    const english = classifyInbound(event({ content: 'typeclaw please check this' }), config, context)
    const korean = classifyInbound(event({ content: '타입클로 확인해 주세요' }), config, context)

    expect(english.kind === 'route' && english.payload.isBotMention).toBe(true)
    expect(korean.kind === 'route' && korean.payload.isBotMention).toBe(true)
    expect(korean.kind === 'route' && korean.payload.thread).toBeNull()
  })
})
