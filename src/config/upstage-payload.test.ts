import { describe, expect, test } from 'bun:test'

import { normalizeContext, type Context, type Model, type ThinkingLevel } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'

import { KNOWN_PROVIDERS } from './providers'

// End-to-end payload guard: drive pi-ai's real openai-completions adapter with
// each curated Upstage model and capture the request body it would send via the
// public `onPayload` hook (which fires before the HTTP call). This proves the
// wire payload only carries fields Upstage documents — the compat flags and
// thinkingLevelMap on the model objects are the mechanism, this asserts the
// resulting behavior. `onPayload` throwing short-circuits before any network I/O.

type CapturedPayload = Record<string, unknown>

async function buildUpstagePayload(
  model: Model<'openai-completions'>,
  reasoning?: ThinkingLevel,
): Promise<CapturedPayload> {
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
    apiKey: 'up_test-key',
    reasoning,
    onPayload: (payload) => {
      captured = payload as CapturedPayload
      throw stopMarker
    },
  })

  for await (const _event of s) {
    // Drain until the adapter reaches onPayload and throws; the stream surfaces
    // that as an error event, after which we stop.
    if (captured !== undefined) break
  }

  if (captured === undefined) throw new Error('onPayload never fired — adapter path changed')
  return captured
}

// Upstage splits these into two groups with opposite defaults: pro4/open2 reason
// unless sent `none`, while pro3/pro2 stay off unless asked and top out at `high`.
const REASONS_BY_DEFAULT_MODEL_IDS = ['solar-pro4', 'solar-open2'] as const
const XHIGH_CLAMPED_MODEL_IDS = ['solar-pro3', 'solar-pro2'] as const
const REASONING_MODEL_IDS = [...REASONS_BY_DEFAULT_MODEL_IDS, ...XHIGH_CLAMPED_MODEL_IDS] as const

describe('upstage openai-completions payload', () => {
  test('uses max_tokens (never max_completion_tokens) for every model', async () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.upstage.models)) {
      const payload = await buildUpstagePayload(model as Model<'openai-completions'>)
      expect(payload.max_completion_tokens, `upstage/${modelId} must not send max_completion_tokens`).toBeUndefined()
      expect('max_tokens' in payload, `upstage/${modelId} should send max_tokens`).toBe(true)
    }
  })

  test('never sends the store field for any model', async () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.upstage.models)) {
      const payload = await buildUpstagePayload(model as Model<'openai-completions'>)
      expect('store' in payload, `upstage/${modelId} must not send store`).toBe(false)
    }
  })

  test('emits only system/user/assistant roles — never the developer role', async () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.upstage.models)) {
      const payload = await buildUpstagePayload(model as Model<'openai-completions'>)
      const messages = (payload.messages ?? []) as Array<{ role: string }>
      for (const m of messages) {
        expect(m.role, `upstage/${modelId} emitted an unsupported role`).not.toBe('developer')
      }
    }
  })

  test('does not attach strict to tool definitions for any model', async () => {
    for (const [modelId, model] of Object.entries(KNOWN_PROVIDERS.upstage.models)) {
      const payload = await buildUpstagePayload(model as Model<'openai-completions'>)
      const tools = (payload.tools ?? []) as Array<{ function?: { strict?: unknown } }>
      for (const t of tools) {
        expect(t.function?.strict, `upstage/${modelId} must not send strict on tool defs`).toBeUndefined()
      }
    }
  })

  test('clamps the pre-pro4 reasoning models\u2019 xhigh level to Upstage\u2019s max reasoning_effort=high', async () => {
    for (const modelId of XHIGH_CLAMPED_MODEL_IDS) {
      const model = KNOWN_PROVIDERS.upstage.models[modelId] as Model<'openai-completions'>
      const payload = await buildUpstagePayload(model, 'xhigh')
      expect(payload.reasoning_effort, `upstage/${modelId} must clamp xhigh -> high`).toBe('high')
    }
  })

  // Upstage's `minimal` (and, on pro3/pro2, `low`) are documented as values that
  // turn reasoning OFF, while pi's `minimal`/`low` are enabled levels. Forwarding
  // them verbatim would disable reasoning on a request that asked for it, so every
  // level pi can select must emit a value in that model's reasoning-ON set.
  const REASONING_ON_VALUES: Record<string, ReadonlyArray<string>> = {
    'solar-pro4': ['low', 'medium', 'high', 'xhigh'],
    'solar-open2': ['low', 'medium', 'high', 'xhigh'],
    'solar-pro3': ['medium', 'high'],
    'solar-pro2': ['medium', 'high'],
  }

  test('every pi reasoning level emits a value Upstage treats as reasoning-on', async () => {
    for (const modelId of REASONING_MODEL_IDS) {
      const model = KNOWN_PROVIDERS.upstage.models[modelId] as Model<'openai-completions'>
      const onValues = REASONING_ON_VALUES[modelId]!
      for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
        const payload = await buildUpstagePayload(model, level)
        expect(onValues, `upstage/${modelId} level ${level} emitted ${String(payload.reasoning_effort)}`).toContain(
          payload.reasoning_effort as string,
        )
      }
    }
  })

  test('passes the levels each model documents as reasoning-on through unchanged', async () => {
    for (const modelId of REASONING_MODEL_IDS) {
      const model = KNOWN_PROVIDERS.upstage.models[modelId] as Model<'openai-completions'>
      for (const level of REASONING_ON_VALUES[modelId]!) {
        if (level === 'xhigh' || level === 'max') continue
        const payload = await buildUpstagePayload(model, level as ThinkingLevel)
        expect(payload.reasoning_effort, `upstage/${modelId} level ${level}`).toBe(level)
      }
    }
  })

  test('the reasoning-on-by-default models send xhigh unchanged rather than clamping it', async () => {
    for (const modelId of REASONS_BY_DEFAULT_MODEL_IDS) {
      const model = KNOWN_PROVIDERS.upstage.models[modelId] as Model<'openai-completions'>
      const payload = await buildUpstagePayload(model, 'xhigh')
      expect(payload.reasoning_effort, `upstage/${modelId} must send xhigh unclamped`).toBe('xhigh')
    }
  })

  test('the reasoning-on-by-default models emit an explicit reasoning_effort=none when reasoning is off', async () => {
    // pi expresses "off" by omitting `reasoning`, and these models reason unless
    // told otherwise — so an omitted reasoning_effort would silently leave
    // reasoning on. pro3/pro2 omit the field to disable it instead.
    for (const modelId of REASONS_BY_DEFAULT_MODEL_IDS) {
      const model = KNOWN_PROVIDERS.upstage.models[modelId] as Model<'openai-completions'>
      const payload = await buildUpstagePayload(model, undefined)
      expect(payload.reasoning_effort, `upstage/${modelId} must send none to disable reasoning`).toBe('none')
    }
  })

  test('the reasoning-off-by-default models omit reasoning_effort entirely when reasoning is off', async () => {
    for (const modelId of XHIGH_CLAMPED_MODEL_IDS) {
      const model = KNOWN_PROVIDERS.upstage.models[modelId] as Model<'openai-completions'>
      const payload = await buildUpstagePayload(model, undefined)
      expect(payload.reasoning_effort, `upstage/${modelId} must omit reasoning_effort when off`).toBeUndefined()
    }
  })

  test('solar-mini never emits reasoning_effort (it does not reason)', async () => {
    const model = KNOWN_PROVIDERS.upstage.models['solar-mini'] as Model<'openai-completions'>
    const payload = await buildUpstagePayload(model, 'high')
    expect(payload.reasoning_effort).toBeUndefined()
  })
})
