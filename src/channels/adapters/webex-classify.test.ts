import { describe, expect, test } from 'bun:test'

import { defaultChannelAdapterConfig } from '@/channels/schema'

import { classifyInbound, type WebexInboundMessage } from './webex-classify'

const config = defaultChannelAdapterConfig()

function message(overrides: Partial<WebexInboundMessage> = {}): WebexInboundMessage {
  return {
    id: 'msg-1',
    ref: 'msg-1',
    roomId: 'room-1',
    roomRef: 'room-1',
    personId: 'user-1',
    personRef: 'user-1',
    personEmail: 'user@example.com',
    text: 'hello',
    created: '2026-01-01T00:00:00.000Z',
    roomType: 'group',
    mentionedPeople: [],
    mentionedPeopleRefs: [],
    mentionedGroups: [],
    files: [],
    raw: {} as WebexInboundMessage['raw'],
    ...overrides,
  }
}

describe('classifyInbound for Webex user channel', () => {
  test('drops self-authored messages', () => {
    expect(classifyInbound(message({ personId: 'self-blob', personRef: 'self-1' }), config, 'self-1')).toEqual({
      kind: 'drop',
      reason: 'self_author',
    })
  })

  test('drops self-authored messages by email when personRef desyncs from the bot ref', () => {
    // Legacy Hydra accounts can surface the bot identity as an email while the
    // Mercury event carries a UUID personRef (or vice versa), so a ref-only
    // self-check leaks the agent's own message back as a new inbound. Matching
    // personEmail against the bot's email closes that echo loop.
    expect(
      classifyInbound(
        message({ personRef: 'uuid-from-mercury', personEmail: 'typeey@typeclaw.dev' }),
        config,
        'legacy-email-ref',
        [],
        'typeey@typeclaw.dev',
      ),
    ).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('self-email match is case-insensitive', () => {
    expect(
      classifyInbound(
        message({ personRef: 'uuid-from-mercury', personEmail: 'TypeEy@TypeClaw.DEV' }),
        config,
        'legacy-email-ref',
        [],
        'typeey@typeclaw.dev',
      ),
    ).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('does not drop a human whose email differs from the bot email', () => {
    const verdict = classifyInbound(
      message({ personRef: 'human-ref', personEmail: 'human@example.com', text: 'typeclaw hi' }),
      config,
      'self-1',
      ['typeclaw'],
      'typeey@typeclaw.dev',
    )
    expect(verdict.kind).toBe('route')
  })

  test('drops empty messages without files', () => {
    expect(classifyInbound(message({ text: '' }), config, 'self-1')).toEqual({ kind: 'drop', reason: 'empty_content' })
  })

  test('drops before self identity is known', () => {
    expect(classifyInbound(message(), config, null)).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })

  test('routes structured mentions', () => {
    const verdict = classifyInbound(
      message({ mentionedPeople: ['self-blob'], mentionedPeopleRefs: ['self-1'] }),
      config,
      'self-1',
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.adapter).toBe('webex')
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.mentionsOthers).toBe(false)
  })

  test('routes alias mentions', () => {
    const verdict = classifyInbound(message({ text: 'typeclaw please check this' }), config, 'self-1', ['typeclaw'])

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
  })

  test('routes non-English alias mentions', () => {
    const verdict = classifyInbound(message({ text: '타입클로 확인해줘' }), config, 'self-1', ['타입클로'])

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
    expect(verdict.payload.text).toBe('타입클로 확인해줘')
  })

  test('marks direct messages as DMs', () => {
    const verdict = classifyInbound(message({ roomType: 'direct' }), config, 'self-1')

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.workspace).toBe('@dm')
    expect(verdict.payload.isDm).toBe(true)
  })

  test('renders file attachments into routed text', () => {
    const verdict = classifyInbound(
      message({ text: '', files: ['https://files.webexcontent.com/path/report.pdf'] }),
      config,
      'self-1',
    )

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.attachments).toEqual([
      { id: 1, kind: 'file', ref: 'https://files.webexcontent.com/path/report.pdf', filename: 'report.pdf' },
    ])
    expect(verdict.payload.text).toContain('Webex attachment #1')
  })
})
