import { describe, expect, test } from 'bun:test'

import type { LinePushMessageEvent } from 'agent-messenger/line'

import { normalizeLineContentType, splitInboundLine } from './line-attachment'

function event(overrides: Partial<LinePushMessageEvent> = {}): LinePushMessageEvent {
  const metadata = { content_metadata: {} as Record<string, string> }
  return {
    type: 'message',
    chat_id: 'C1',
    message_id: 'M1',
    author_id: 'U_other',
    text: null,
    content_type: 'NONE',
    sent_at: '2025-01-02T03:04:05.000Z',
    ...metadata,
    ...overrides,
  }
}

describe('normalizeLineContentType', () => {
  test('maps numeric thrift enum forms to symbolic names', () => {
    expect(normalizeLineContentType('7')).toBe('STICKER')
    expect(normalizeLineContentType('1')).toBe('IMAGE')
    expect(normalizeLineContentType('0')).toBe('NONE')
  })

  test('treats missing, blank, and TEXT spellings as NONE', () => {
    expect(normalizeLineContentType(null)).toBe('NONE')
    expect(normalizeLineContentType(undefined)).toBe('NONE')
    expect(normalizeLineContentType('   ')).toBe('NONE')
    expect(normalizeLineContentType('text')).toBe('NONE')
    expect(normalizeLineContentType('TEXT')).toBe('NONE')
  })

  test('uppercases unknown symbolic types', () => {
    expect(normalizeLineContentType('sticker')).toBe('STICKER')
    expect(normalizeLineContentType('flex')).toBe('FLEX')
  })
})

describe('splitInboundLine', () => {
  test('passes text through untouched for NONE content', () => {
    const result = splitInboundLine(event({ content_type: 'NONE', text: 'hello' }))
    expect(result).toEqual({ text: 'hello', attachments: [] })
  })

  test('keeps NONE text empty so the classifier can drop it', () => {
    const result = splitInboundLine(event({ content_type: 'NONE', text: null }))
    expect(result).toEqual({ text: '', attachments: [] })
  })

  test('routes an undecryptable message with a placeholder instead of dropping it', () => {
    const missingKey = splitInboundLine(
      event({ content_type: 'NONE', text: null, decryption_error: { code: 'missing_e2ee_key', message: 'no key' } }),
    )
    expect(missingKey).toEqual({ text: '[LINE message could not be decrypted: missing E2EE key]', attachments: [] })

    const failed = splitInboundLine(
      event({ content_type: 'NONE', text: null, decryption_error: { code: 'decrypt_failed', message: 'boom' } }),
    )
    expect(failed).toEqual({ text: '[LINE message could not be decrypted]', attachments: [] })
  })

  test('synthesizes a placeholder + ref-free attachment for stickers', () => {
    const result = splitInboundLine(event({ content_type: 'STICKER' }))
    expect(result.text).toBe('[LINE sticker]')
    expect(result.attachments).toEqual([{ id: 1, kind: 'sticker', ref: '' }])
  })

  test('maps IMAGE/VIDEO/AUDIO/FILE to photo/video/audio/file kinds', () => {
    expect(splitInboundLine(event({ content_type: 'IMAGE' })).attachments[0]?.kind).toBe('photo')
    expect(splitInboundLine(event({ content_type: 'VIDEO' })).attachments[0]?.kind).toBe('video')
    expect(splitInboundLine(event({ content_type: 'AUDIO' })).attachments[0]?.kind).toBe('audio')
    expect(splitInboundLine(event({ content_type: 'FILE' })).attachments[0]?.kind).toBe('file')
  })

  test('appends the placeholder when the event also carries a caption', () => {
    const result = splitInboundLine(event({ content_type: 'IMAGE', text: 'look at this' }))
    expect(result.text).toBe('look at this\n[LINE photo]')
    expect(result.attachments).toEqual([{ id: 1, kind: 'photo', ref: '' }])
  })

  test('routes contact and location as placeholder-only text, no attachment', () => {
    expect(splitInboundLine(event({ content_type: 'CONTACT' }))).toEqual({
      text: '[LINE contact]',
      attachments: [],
    })
    expect(splitInboundLine(event({ content_type: 'LOCATION' }))).toEqual({
      text: '[LINE location]',
      attachments: [],
    })
  })

  test('renders an unknown content type as a labeled placeholder with no attachment', () => {
    const result = splitInboundLine(event({ content_type: 'FLEX' }))
    expect(result).toEqual({ text: '[LINE message: FLEX]', attachments: [] })
  })

  test('honors a custom start id for the attachment', () => {
    const result = splitInboundLine(event({ content_type: 'STICKER' }), 5)
    expect(result.attachments[0]?.id).toBe(5)
  })
})
