import { describe, expect, test } from 'bun:test'

import { projectTranscriptLine } from './transcript-view'

describe('projectTranscriptLine', () => {
  test('removes tool replay signatures while preserving tool evidence and the canonical record', () => {
    const call = {
      type: 'toolCall',
      id: 'call-1',
      name: 'read',
      arguments: { thoughtSignature: '사용자가 제공한 데이터', path: 'notes.md' },
      namespace: 'tools',
      argumentsError: 'partial arguments',
      unknownField: 'retain',
      thoughtSignature: 'opaque-provider-replay'.repeat(2000),
    }
    const entry = { type: 'message', id: 'entry-1', message: { role: 'assistant', content: [call] } }
    const canonical = JSON.stringify(entry)
    const projected = projectTranscriptLine(canonical)
    const { thoughtSignature: _signature, ...evidence } = call

    expect(JSON.parse(projected).message.content).toEqual([evidence])
    expect(Buffer.byteLength(projected)).toBeLessThan(Buffer.byteLength(canonical))
    expect(JSON.stringify(entry)).toBe(canonical)
  })

  test.each([
    ['user', '입력에 있는 usage, model, thinkingSignature는 그대로 보존해 주세요.'],
    ['toolResult', '利用者は変更前に承認を求めています。'],
  ])('preserves %s evidence and nested fields named like provider metadata', (role, text) => {
    const entry = {
      type: 'message',
      id: 'entry-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role,
        timestamp: 1767225600000,
        toolCallId: 'call-1',
        toolName: 'read',
        isError: true,
        errorMessage: 'The result is partial.',
        model: 'a domain model, not assistant transport',
        usage: { label: 'domain usage evidence' },
        content: [
          { type: 'text', text },
          { type: 'image', mimeType: 'image/png', data: 'image-content' },
        ],
        details: { usage: 'domain evidence', model: 'domain model', thinkingSignature: 'user data' },
      },
    }

    expect(JSON.parse(projectTranscriptLine(JSON.stringify(entry)))).toEqual(entry)
  })

  test.each([
    '{"type":"message","id":"partial"',
    '{"type":"custom","id":"provenance","data":{"model":"source-model"}}',
    '{"type":"message","id":"unknown","message":"raw evidence"}',
  ])('keeps incomplete and unfamiliar records recoverable: %s', (line) => {
    expect(projectTranscriptLine(line)).toBe(line)
  })
})
