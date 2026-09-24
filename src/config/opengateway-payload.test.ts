import { describe, expect, test } from 'bun:test'

import { normalizeContext, type Context, type Model } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'

import { resolveModel } from './config'
import { KNOWN_PROVIDERS } from './providers'

// End-to-end payload guard, same shape as upstage-payload.test.ts: drive pi-ai's
// real openai-completions adapter and capture the request body via the public
// `onPayload` hook, which fires before any HTTP call.
//
// The point here is the UNCURATED path. pi-ai infers compat from the baseUrl and
// does not recognise apis.opengateway.ai, so it assumes a first-party OpenAI
// endpoint. The curated models pin compat to stop that; a custom ref only gets
// the same treatment because `resolveModel` copies the template's compat. These
// tests assert the resulting wire payload for both, so the guarantee is proven
// where it is actually observable rather than by inspecting model objects.

type CapturedPayload = Record<string, unknown>

async function buildPayload(model: Model<'openai-completions'>): Promise<CapturedPayload> {
  const context: Context = {
    systemPrompt: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    tools: [
      {
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    ],
  }

  let captured: CapturedPayload | undefined
  const stopMarker = new Error('payload-captured')

  const s = streamSimple(model, normalizeContext(context), {
    apiKey: 'og-test-key',
    onPayload: (payload) => {
      captured = payload as CapturedPayload
      throw stopMarker
    },
  })

  for await (const _event of s) {
    if (captured !== undefined) break
  }

  if (captured === undefined) throw new Error('onPayload never fired — adapter path changed')
  return captured
}

function expectNoOpenAiNativeFields(payload: CapturedPayload, label: string): void {
  expect(payload.max_completion_tokens, `${label} must not send max_completion_tokens`).toBeUndefined()
  expect('max_tokens' in payload, `${label} should send max_tokens`).toBe(true)
  expect('store' in payload, `${label} must not send store`).toBe(false)

  const messages = (payload.messages ?? []) as Array<{ role: string }>
  for (const m of messages) {
    expect(m.role, `${label} emitted the unsupported developer role`).not.toBe('developer')
  }

  const tools = (payload.tools ?? []) as Array<{ function?: { strict?: unknown } }>
  for (const t of tools) {
    expect(t.function?.strict, `${label} must not send strict on tool defs`).toBeUndefined()
  }
}

// Documented in add-a-provider.mdx as a supported custom ref, and present in the
// live catalog, but deliberately not curated — exactly the path that regressed.
const UNCURATED_REF = 'opengateway/google/gemini-3.5-flash'

describe('opengateway openai-completions payload', () => {
  test('curated models omit every OpenAI-native field the gateway does not accept', async () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.opengateway.models)) {
      const payload = await buildPayload(model as Model<'openai-completions'>)
      expectNoOpenAiNativeFields(payload, `opengateway/${modelId}`)
    }
  })

  test('an uncurated custom ref inherits the same guarantees through resolveModel', async () => {
    // `reasoning` is forced on because pi-ai gates the developer role on
    // `model.reasoning && compat.supportsDeveloperRole`. A custom ref with no
    // `customModels` metadata resolves to `reasoning: false`, which suppresses
    // the role on its own and would make that assertion pass even if compat
    // stopped propagating. Enabling it here keeps the pin load-bearing.
    const resolved = resolveModel(UNCURATED_REF) as Model<'openai-completions'>
    const model: Model<'openai-completions'> = { ...resolved, reasoning: true }

    const payload = await buildPayload(model)

    expectNoOpenAiNativeFields(payload, UNCURATED_REF)
  })

  test('resolveModel carries the provider compat onto an uncurated ref', () => {
    // The mechanism behind the payload test above. Asserted separately so a
    // regression names the cause, not just the symptom.
    const model = resolveModel(UNCURATED_REF)

    const compat = (model as { compat?: Record<string, unknown> }).compat
    expect(compat, `${UNCURATED_REF} lost the provider compat`).toBeDefined()
    expect(compat!.supportsStore).toBe(false)
    expect(compat!.supportsDeveloperRole).toBe(false)
    expect(compat!.supportsStrictMode).toBe(false)
    expect(compat!.maxTokensField).toBe('max_tokens')
  })

  test('the uncurated ref keeps the gateway transport and creator-qualified id', () => {
    const model = resolveModel(UNCURATED_REF)

    expect(model.id).toBe('google/gemini-3.5-flash')
    expect(model.provider).toBe('opengateway')
    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://apis.opengateway.ai/v1')
  })
})
