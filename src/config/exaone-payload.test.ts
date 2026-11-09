import { describe, expect, test } from 'bun:test'

import { normalizeContext, type Context, type Model, type ThinkingLevel } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'

import { KNOWN_PROVIDERS } from './providers'

// Drives pi-ai's real openai-completions adapter with the curated K-EXAONE 2.5
// record and captures the request body via `onPayload`, which throws before any
// network I/O. Same pattern as inception-payload.test.ts.
async function buildExaonePayload(reasoning?: ThinkingLevel): Promise<Record<string, unknown>> {
  const model = KNOWN_PROVIDERS.exaone.models['k-exaone_v2.5'] as Model<'openai-completions'>
  const context: Context = {
    systemPrompt: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: '안녕하세요', timestamp: Date.now() }],
  }

  let captured: Record<string, unknown> | undefined
  const s = streamSimple(model, normalizeContext(context), {
    apiKey: 'test-key',
    reasoning,
    maxTokens: 32000,
    onPayload: (payload) => {
      captured = payload as Record<string, unknown>
      throw new Error('payload-captured')
    },
  })
  for await (const _event of s) {
    if (captured !== undefined) break
  }

  if (captured === undefined) throw new Error('onPayload never fired — adapter path changed')
  return captured
}

describe('exaone k-exaone_v2.5 openai-completions payload', () => {
  test('sends reasoning_effort=low when reasoning is off, overriding the upstream max default', async () => {
    const payload = await buildExaonePayload(undefined)
    expect(payload.reasoning_effort).toBe('low')
  })

  test('maps every pi reasoning level onto an effort EXAONE accepts', async () => {
    const expected: Record<string, string> = {
      minimal: 'low',
      low: 'low',
      medium: 'high',
      high: 'high',
      xhigh: 'max',
    }
    for (const [level, effort] of Object.entries(expected)) {
      const payload = await buildExaonePayload(level as ThinkingLevel)
      expect(payload.reasoning_effort, `level ${level}`).toBe(effort)
      expect(['low', 'high', 'max']).toContain(payload.reasoning_effort as string)
    }
  })

  test('uses max_tokens and never sends store or the developer role', async () => {
    const payload = await buildExaonePayload('medium')
    expect(payload.max_tokens).toBe(32000)
    expect('max_completion_tokens' in payload).toBe(false)
    expect('store' in payload).toBe(false)
    const messages = (payload.messages ?? []) as Array<{ role: string }>
    for (const m of messages) expect(m.role).not.toBe('developer')
  })
})
