import { describe, expect, test } from 'bun:test'

import { calculateCost, clampThinkingLevel, getSupportedThinkingLevels, normalizeContext } from '@earendil-works/pi-ai'
import type {
  Api,
  KnownApi,
  Model,
  ModelThinkingLevel,
  SimpleStreamOptions,
  StreamFunction,
} from '@earendil-works/pi-ai'
import { streamSimple as streamCodexResponses } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { streamSimple as streamResponses } from '@earendil-works/pi-ai/api/openai-responses'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'

import {
  defaultThinkingLevelForRef,
  isKnownModelRef,
  isOpenAiFamilyRef,
  isModelRef,
  KNOWN_PROVIDERS,
  type KnownProviderId,
  listKnownModelRefs,
  listKnownProviderVendorIds,
  providerForModelRef,
  providerIdsForVendor,
  supportsApiKey,
  supportsOAuth,
  variantLabel,
  vendorForProviderId,
} from './providers'

// Builds the request a session at `level` sends, through the real transport,
// and stops before any network I/O. Like pi-agent-core (agent.js:305), `off`
// becomes an omitted `reasoning` option.
async function captureRequest<TApi extends Api>(
  stream: StreamFunction<TApi, SimpleStreamOptions>,
  model: Model<TApi>,
  apiKey: string,
  level: ModelThinkingLevel,
): Promise<Record<string, unknown> | undefined> {
  let payload: Record<string, unknown> | undefined
  const events = stream(model, normalizeContext({ messages: [{ role: 'user', content: 'ping', timestamp: 0 }] }), {
    apiKey,
    reasoning: level === 'off' ? undefined : level,
    onPayload: (params) => {
      payload = params as Record<string, unknown>
      throw new Error('captured')
    },
  })
  for await (const _event of events) {
    if (payload !== undefined) break
  }
  return payload
}

describe('KNOWN_PROVIDERS', () => {
  test('every provider model carries a baseUrl that matches the outer provider baseUrl', () => {
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        expect(model.baseUrl, `${providerId}/${modelId} baseUrl drift`).toBe(provider.baseUrl)
      }
    }
  })

  test('every model.provider field matches its outer provider id', () => {
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        expect(model.provider, `${providerId}/${modelId} provider drift`).toBe(providerId)
      }
    }
  })

  // pi 0.87 reads these records' request shape only from catalog metadata:
  // Anthropic adaptive thinking (0.73 inferred it from the id) and the Responses
  // effort maps. Drift here is a provider 400 or a silently wrong effort.
  // Records outside this list keep their 0.73 wire behavior (pi still detects
  // their compat from the baseUrl) and are intentionally not pinned to upstream.
  test('catalog-dependent records match pi-ai compat and thinking maps', () => {
    const catalogAligned = [
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-opus-4-7',
      'anthropic/claude-opus-4-8',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-sonnet-5-5',
      'anthropic/claude-opus-5-5',
      'anthropic/claude-fable-5',
      'openai/gpt-6-sol',
      'openai/gpt-6-luna',
      'openai/gpt-6.1-terra',
      'openai-codex/gpt-6-sol',
      'openai-codex/gpt-6-luna',
      'openai-codex/gpt-6.1-terra',
      'xai/grok-4.7',
      'xai/grok-4.3',
    ]
    const checked: string[] = []
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        const ref = `${providerId}/${modelId}`
        if (!catalogAligned.includes(ref)) continue
        checked.push(ref)
        const builtin: Model<KnownApi> | undefined = getBuiltinModel(providerId as never, modelId as never)
        expect(builtin, `${ref} in pi-ai catalog`).toBeDefined()
        const upstreamCompat: Record<string, unknown> = { ...builtin?.compat }
        delete upstreamCompat.allowedFallbackModels
        delete upstreamCompat.supportsStrictTools
        expect(model.api, `${ref} API drift`).toBe(builtin?.api)
        expect('compat' in model ? model.compat : {}, `${ref} compat drift`).toEqual(upstreamCompat)
        expect('thinkingLevelMap' in model ? model.thinkingLevelMap : undefined, `${ref} thinking map drift`).toEqual(
          builtin?.thinkingLevelMap,
        )
      }
    }
    expect(checked.sort()).toEqual([...catalogAligned].sort())
  })

  // Anthropic server-side fallback (`compat.allowedFallbackModels`) makes pi
  // send `fallbacks`, so a refused request is answered and billed by another
  // model. No curated record may opt into that silently.
  test('no curated record enables server-side model fallback', () => {
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        const compat = 'compat' in model ? model.compat : undefined
        expect(compat !== undefined && 'allowedFallbackModels' in compat, `${providerId}/${modelId}`).toBe(false)
      }
    }
  })

  test('apiKeyEnv is set on every api-key-capable provider and null on oauth-only', () => {
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      if (supportsApiKey(provider)) {
        expect(provider.apiKeyEnv, `${providerId} missing apiKeyEnv`).not.toBeNull()
      } else {
        expect(provider.apiKeyEnv, `${providerId} oauth-only but has apiKeyEnv`).toBeNull()
      }
    }
  })

  test('oauthProviderId is set on every oauth-capable provider and null on api-key-only', () => {
    for (const [providerId, provider] of Object.entries(KNOWN_PROVIDERS)) {
      if (supportsOAuth(provider)) {
        expect(provider.oauthProviderId, `${providerId} missing oauthProviderId`).not.toBeNull()
      } else {
        expect(provider.oauthProviderId, `${providerId} api-key-only but has oauthProviderId`).toBeNull()
      }
    }
  })

  test('zai and zai-coding use distinct env vars so users can hold both keys', () => {
    expect(KNOWN_PROVIDERS.zai.apiKeyEnv).not.toBe(KNOWN_PROVIDERS['zai-coding'].apiKeyEnv)
  })

  test('zai and zai-coding use distinct base URLs so paygo keys cannot accidentally hit the coding endpoint', () => {
    expect(KNOWN_PROVIDERS.zai.baseUrl).not.toBe(KNOWN_PROVIDERS['zai-coding'].baseUrl)
  })

  test('anthropic supports both api-key and oauth on the same provider id', () => {
    const anthropic = KNOWN_PROVIDERS.anthropic
    expect(anthropic.baseUrl).toBe('https://api.anthropic.com')
    expect(anthropic.apiKeyEnv).toBe('ANTHROPIC_API_KEY')
    expect(anthropic.oauthProviderId).toBe('anthropic')
    expect(supportsApiKey(anthropic)).toBe(true)
    expect(supportsOAuth(anthropic)).toBe(true)
  })

  test('moonshot and moonshot-coding use distinct env vars so users can hold both keys', () => {
    expect(KNOWN_PROVIDERS.moonshot.apiKeyEnv).not.toBe(KNOWN_PROVIDERS['moonshot-coding'].apiKeyEnv)
  })

  test('moonshot and moonshot-coding use distinct base URLs so paygo keys cannot hit the coding endpoint', () => {
    expect(KNOWN_PROVIDERS.moonshot.baseUrl).not.toBe(KNOWN_PROVIDERS['moonshot-coding'].baseUrl)
  })

  test('xai supports both api-key and oauth against the native x.ai endpoint', () => {
    const xai = KNOWN_PROVIDERS.xai
    expect(xai.baseUrl).toBe('https://api.x.ai/v1')
    expect(xai.apiKeyEnv).toBe('XAI_API_KEY')
    expect(xai.oauthProviderId).toBe('xai')
    expect(supportsApiKey(xai)).toBe(true)
    expect(supportsOAuth(xai)).toBe(true)
  })

  test('opengateway model refs round-trip through providerForModelRef despite the second slash', () => {
    for (const modelId of Object.keys(KNOWN_PROVIDERS.opengateway.models)) {
      const ref = `opengateway/${modelId}`
      expect(providerForModelRef(ref), `${ref} misrouted`).toBe('opengateway')
      expect(isModelRef(ref), `${ref} rejected by isModelRef`).toBe(true)
    }
  })
})

describe('KNOWN_PROVIDER_VENDORS', () => {
  test('every vendor references only known provider ids', () => {
    for (const vendorId of listKnownProviderVendorIds()) {
      for (const providerId of providerIdsForVendor(vendorId)) {
        expect(providerId in KNOWN_PROVIDERS, `${vendorId} references unknown provider ${providerId}`).toBe(true)
      }
    }
  })

  test('every known provider belongs to exactly one vendor (full partition)', () => {
    const assigned = new Map<KnownProviderId, number>()
    for (const vendorId of listKnownProviderVendorIds()) {
      for (const providerId of providerIdsForVendor(vendorId)) {
        assigned.set(providerId, (assigned.get(providerId) ?? 0) + 1)
      }
    }
    for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
      expect(assigned.get(providerId), `${providerId} not assigned to exactly one vendor`).toBe(1)
    }
  })

  test('vendorForProviderId is the inverse of providerIdsForVendor', () => {
    for (const vendorId of listKnownProviderVendorIds()) {
      for (const providerId of providerIdsForVendor(vendorId)) {
        expect(vendorForProviderId(providerId)).toBe(vendorId)
      }
    }
  })

  test('multi-provider vendors supply variant copy for each of their providers', () => {
    for (const vendorId of listKnownProviderVendorIds()) {
      const providers = providerIdsForVendor(vendorId)
      if (providers.length < 2) continue
      for (const providerId of providers) {
        expect(variantLabel(vendorId, providerId), `${vendorId}/${providerId} missing variant label`).not.toBe(
          KNOWN_PROVIDERS[providerId].name,
        )
      }
    }
  })

  test('opengateway does not join the OpenAI family even though it proxies OpenAI models', () => {
    expect(isOpenAiFamilyRef('opengateway/openai/gpt-5.5')).toBe(false)
  })
})

describe('providerForModelRef', () => {
  test('distinguishes zai from zai-coding by the slash-prefixed match (not substring)', () => {
    expect(providerForModelRef('zai-coding/glm-5')).toBe('zai-coding')
    expect(providerForModelRef('zai/glm-4.6')).toBe('zai')
  })

  test('distinguishes moonshot from moonshot-coding by the slash-prefixed match (not substring)', () => {
    expect(providerForModelRef('moonshot-coding/kimi-for-coding')).toBe('moonshot-coding')
    expect(providerForModelRef('moonshot/kimi-k2.6')).toBe('moonshot')
  })
})

describe('model ref predicates', () => {
  test('isKnownModelRef accepts curated refs only', () => {
    expect(isKnownModelRef('openai/gpt-5.4-nano')).toBe(true)
    expect(isKnownModelRef('openai/gpt-6-live')).toBe(false)
  })

  test('isModelRef accepts custom refs for known providers', () => {
    expect(isModelRef('openai/gpt-6-live')).toBe(true)
    expect(isModelRef('fireworks/accounts/fireworks/models/qwen3-next')).toBe(true)
  })

  test('isModelRef rejects unknown providers and malformed refs', () => {
    expect(isModelRef('unknown/gpt-6-live')).toBe(false)
    expect(isModelRef('openai/')).toBe(false)
    expect(isModelRef('OpenAI/gpt-6-live')).toBe(false)
    expect(isModelRef('openai/gpt 6')).toBe(false)
  })
})

describe('listKnownModelRefs', () => {
  test('includes both zai and zai-coding models', () => {
    const refs = listKnownModelRefs()
    expect(refs).toContain('zai/glm-4.6')
    expect(refs).toContain('zai-coding/glm-5.1')
  })

  test('includes GPT-6 Sol, Luna, and 6.1 Terra for API-key and Codex OAuth routing', () => {
    const refs = listKnownModelRefs()
    const expected = [
      ['openai/gpt-6-sol', 'openai'],
      ['openai/gpt-6-luna', 'openai'],
      ['openai/gpt-6.1-terra', 'openai'],
      ['openai-codex/gpt-6-sol', 'openai-codex'],
      ['openai-codex/gpt-6-luna', 'openai-codex'],
      ['openai-codex/gpt-6.1-terra', 'openai-codex'],
    ] as const
    for (const [ref, providerId] of expected) {
      expect(refs).toContain(ref)
      expect(providerForModelRef(ref)).toBe(providerId)
    }
  })

  test('prices GPT-6.1 Terra at the long-context rate only above 272K input tokens', () => {
    const cost = (model: Model<Api>, input: number) =>
      calculateCost(model, {
        input,
        output: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + 1_000_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      })
    for (const model of [
      KNOWN_PROVIDERS.openai.models['gpt-6.1-terra'],
      KNOWN_PROVIDERS['openai-codex'].models['gpt-6.1-terra'],
    ]) {
      // given a request exactly at the threshold, then the base rate applies
      const base = cost(model, 272_000)
      expect(base.input).toBeCloseTo(0.272, 9)
      expect(base.output).toBeCloseTo(5, 9)
      // given a request one token above, then the whole request is billed at 2x/1.5x
      const long = cost(model, 272_001)
      expect(long.input).toBeCloseTo(0.544002, 9)
      expect(long.output).toBeCloseTo(7.5, 9)
    }
  })

  test('maps Opus 5.5 to its supported adaptive efforts and never to disabled thinking', () => {
    const model = KNOWN_PROVIDERS.anthropic.models['claude-opus-5-5']
    expect(clampThinkingLevel(model, 'off')).not.toBe('off')
    expect(getSupportedThinkingLevels(model)).toContain('max')
    expect(clampThinkingLevel(model, 'max')).toBe('max')
  })

  test('sends every offered GPT-6 effort on the wire, off as none, through max', async () => {
    for (const model of [KNOWN_PROVIDERS.openai.models['gpt-6-sol'], KNOWN_PROVIDERS.openai.models['gpt-6-luna']]) {
      expect(getSupportedThinkingLevels(model)).toContain('off')
      expect(getSupportedThinkingLevels(model)).not.toContain('minimal')
      expect(getSupportedThinkingLevels(model)).toContain('max')
      expect(clampThinkingLevel(model, 'minimal')).toBe('low')
      expect(clampThinkingLevel(model, 'max')).toBe('max')
      // With an API key, pi-ai 1.3+ carries the level in a trailing
      // configuration_update item (compat.supportsMidConvoEffort); `off` has no
      // reasoning option and still goes out as reasoning.effort none.
      for (const level of getSupportedThinkingLevels(model)) {
        const payload = await captureRequest(streamResponses, model, 'sk-test', level)
        const updates = ((payload?.input ?? []) as Array<Record<string, unknown>>).filter(
          (item) => item.type === 'configuration_update',
        )
        if (level === 'off') {
          expect(payload?.reasoning).toMatchObject({ effort: 'none' })
          expect(updates).toEqual([])
        } else {
          expect(updates.at(-1)).toEqual({ type: 'configuration_update', reasoning: { effort: level } })
        }
      }
    }
    for (const model of [
      KNOWN_PROVIDERS['openai-codex'].models['gpt-6-sol'],
      KNOWN_PROVIDERS['openai-codex'].models['gpt-6-luna'],
    ]) {
      expect(model.thinkingLevelMap?.minimal).toBe('low')
      expect(model.thinkingLevelMap?.max).toBe('max')
    }
  })

  // pi 0.87's Codex transport sends `off` as effort none (pi 0.73.1 dropped
  // the field and ran the backend default), so every level reaches the wire.
  test('sends every Codex GPT-6 level as an explicit reasoning effort', async () => {
    const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } }
    const apiKey = `e30.${btoa(JSON.stringify(claims))}.sig`
    for (const id of ['gpt-6-sol', 'gpt-6-luna'] as const) {
      const model = KNOWN_PROVIDERS['openai-codex'].models[id]
      expect(getSupportedThinkingLevels(model)).toContain('off')
      for (const level of getSupportedThinkingLevels(model)) {
        const payload = await captureRequest(streamCodexResponses, model, apiKey, level)
        expect(payload?.model).toBe(id)
        expect(payload?.reasoning).toMatchObject({ effort: model.thinkingLevelMap?.[level] })
      }
    }
  })

  // On pi 0.87 Grok 4.7 runs on Responses, which carries reasoning.effort.
  // `off`, `minimal` and `max` are not xAI efforts, so they clamp onto real levels.
  test('sends Grok 4.7 efforts through Responses reasoning.effort', async () => {
    const model = KNOWN_PROVIDERS.xai.models['grok-4.7']
    expect(getSupportedThinkingLevels(model)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(clampThinkingLevel(model, 'off')).toBe('low')
    expect(clampThinkingLevel(model, 'minimal')).toBe('low')
    expect(clampThinkingLevel(model, 'max')).toBe('xhigh')
    for (const level of getSupportedThinkingLevels(model)) {
      const payload = await captureRequest(streamResponses, model, 'xai-test', level)
      expect(payload?.model).toBe('grok-4.7')
      expect(payload?.reasoning).toMatchObject({ effort: level })
    }
  })
})

describe('providerForModelRef anthropic', () => {
  test('routes claude-sonnet-4-6 to anthropic', () => {
    expect(providerForModelRef('anthropic/claude-sonnet-4-6')).toBe('anthropic')
  })
})

describe('isOpenAiFamilyRef', () => {
  test('tracks every provider in the OpenAI vendor family', () => {
    expect(isOpenAiFamilyRef('openai/gpt-5.4-nano')).toBe(true)
    expect(isOpenAiFamilyRef('openai-codex/gpt-5.5')).toBe(true)
    expect(isOpenAiFamilyRef('anthropic/claude-opus-4-7')).toBe(false)
  })
})

describe('defaultThinkingLevelForRef', () => {
  test('every known model ref defers to the SDK default (no family is pinned)', () => {
    for (const ref of listKnownModelRefs()) {
      expect(defaultThinkingLevelForRef(ref), `${ref} should defer to the SDK default`).toBeUndefined()
    }
  })
})
