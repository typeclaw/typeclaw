import { describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  KNOWN_PROVIDERS,
  supportsApiKey,
  supportsOAuth,
  type KnownProviderId,
  type KnownProviderVendorId,
} from '@/config/providers'
import { checkpointFromSelections, type WizardCheckpointStore } from '@/init/checkpoint'
import type { ModelOption } from '@/init/models-dev'

import {
  collectWizardInputs,
  formatModelLabel,
  shouldConfirmNonEmptyDirectory,
  sortRecommendedFirst,
  WizardAbortedError,
  type WizardPrompts,
} from './init'

describe('init pre-wizard guards', () => {
  test('confirms for foreign non-empty directories', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-init-guard-'))
    try {
      await writeFile(join(cwd, 'README.md'), '# existing project\n')

      expect(shouldConfirmNonEmptyDirectory(cwd)).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test('skips non-empty confirmation for partial TypeClaw init dirs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-init-guard-'))
    try {
      await writeFile(join(cwd, 'typeclaw.json'), '{}\n')

      expect(shouldConfirmNonEmptyDirectory(cwd)).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

describe('collectWizardInputs back-aware flow', () => {
  const fireworksModel: ModelOption = {
    providerId: 'fireworks',
    providerName: 'Fireworks',
    modelId: 'accounts/fireworks/routers/kimi-k2p6-turbo',
    modelName: 'Kimi K2.6 Turbo',
    ref: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
    contextWindow: 256000,
    reasoning: true,
    curated: true,
    supportsVision: true,
  }
  const openaiModel: ModelOption = {
    providerId: 'openai',
    providerName: 'OpenAI',
    modelId: 'gpt-5.4-nano',
    modelName: 'GPT-5.4 Nano',
    ref: 'openai/gpt-5.4-nano',
    contextWindow: 128000,
    reasoning: false,
    curated: true,
    supportsVision: true,
  }
  const codexModel: ModelOption = {
    providerId: 'openai-codex',
    providerName: 'OpenAI Codex',
    modelId: 'gpt-5.4-mini',
    modelName: 'GPT-5.4 Mini',
    ref: 'openai-codex/gpt-5.4-mini',
    contextWindow: 128000,
    reasoning: true,
    curated: true,
    supportsVision: true,
  }
  const zaiTextOnlyModel: ModelOption = {
    providerId: 'zai',
    providerName: 'Z.AI',
    modelId: 'glm-4.6',
    modelName: 'GLM-4.6',
    ref: 'zai/glm-4.6',
    contextWindow: 200000,
    reasoning: true,
    curated: true,
    supportsVision: false,
  }
  const anthropicModel: ModelOption = {
    providerId: 'anthropic',
    providerName: 'Anthropic',
    modelId: 'claude-sonnet-4-6',
    modelName: 'Claude Sonnet 4.6',
    ref: 'anthropic/claude-sonnet-4-6',
    contextWindow: 1000000,
    reasoning: true,
    curated: true,
    supportsVision: true,
  }

  function makeRecorder(): { steps: string[]; record: (name: string) => void } {
    const steps: string[] = []
    return { steps, record: (name) => steps.push(name) }
  }

  function makePrompts(overrides: Partial<WizardPrompts> = {}): WizardPrompts {
    return {
      loadCatalog: async () => ({ options: [fireworksModel, openaiModel, codexModel], source: 'curated' }),
      readExistingApiKey: async () => null,
      hasExistingOAuthCredentials: async () => false,
      pickVendor: async () => ({ kind: 'value', value: 'fireworks' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'fireworks' as KnownProviderId, auto: true }),
      pickModel: async () => ({ kind: 'value', value: fireworksModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'api-key' }),
      askApiKey: async () => ({ kind: 'value', value: 'sk_test' }),
      validateApiKey: async () => ({ kind: 'ok' as const }),
      pickVisionVendor: async () => ({ kind: 'value', value: 'skip' }),
      pickVisionProviderVariant: async () => ({ kind: 'value', value: 'openai' as KnownProviderId, auto: true }),
      pickVisionModel: async () => ({ kind: 'value', value: openaiModel }),
      pickChannel: async () => ({ kind: 'value', value: 'none' }),
      hasExistingChannelSecrets: async () => false,
      runChannelFlow: async () => ({ kind: 'value', value: {} }),
      runOAuthLogin: async () => ({ ok: true }),
      askOAuthFailureRecovery: async () => 'abort',
      confirmResumeCheckpoint: async () => 'start-over',
      ...overrides,
    }
  }

  test('happy path: walks every step in order and returns inputs', async () => {
    const { steps, record } = makeRecorder()
    const prompts = makePrompts({
      loadCatalog: async () => {
        record('load-catalog')
        return { options: [fireworksModel], source: 'curated' }
      },
      pickVendor: async () => {
        record('pick-vendor')
        return { kind: 'value', value: 'fireworks' as KnownProviderVendorId }
      },
      pickModel: async () => {
        record('pick-model')
        return { kind: 'value', value: fireworksModel }
      },
      pickAuthMethod: async () => {
        record('pick-auth-method')
        return { kind: 'value', value: 'api-key' }
      },
      askApiKey: async () => {
        record('enter-api-key')
        return { kind: 'value', value: 'fw_test' }
      },
      pickChannel: async () => {
        record('pick-channel')
        return { kind: 'value', value: 'none' }
      },
      runChannelFlow: async () => {
        record('channel-flow')
        return { kind: 'value', value: {} }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(steps).toEqual([
      'load-catalog',
      'pick-vendor',
      'pick-auth-method',
      'pick-model',
      'enter-api-key',
      'pick-channel',
      'channel-flow',
    ])
    expect(result.model).toBe(fireworksModel)
    expect(result.llmAuth).toEqual({ kind: 'api-key', apiKey: 'fw_test' })
    expect(result.channelSecrets).toEqual({})
  })

  test('back from pick-vendor re-asks the same prompt; cancelling twice aborts', async () => {
    let vendorCalls = 0
    const prompts = makePrompts({
      pickVendor: async () => {
        vendorCalls += 1
        return { kind: 'back' }
      },
    })

    await expect(collectWizardInputs('/agent', prompts)).rejects.toThrow(WizardAbortedError)
    expect(vendorCalls).toBe(2)
  })

  test('back from pick-vendor then pick succeeds (single cancel is still a no-op)', async () => {
    let vendorCalls = 0
    const prompts = makePrompts({
      pickVendor: async () => {
        vendorCalls += 1
        if (vendorCalls === 1) return { kind: 'back' }
        return { kind: 'value', value: 'fireworks' as KnownProviderVendorId }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(vendorCalls).toBe(2)
    expect(result.model).toBe(fireworksModel)
  })

  test('aborts when back from enter-api-key auto-advances back to enter-api-key (single-method provider)', async () => {
    // given: Fireworks is api-key-only, so pickAuthMethod returns autoValue
    //   without prompting. The real CLI uses this code path; here we
    //   simulate it directly with kind: 'value', auto: true.
    let apiKeyCalls = 0
    const prompts = makePrompts({
      pickAuthMethod: async () => ({ kind: 'value', value: 'api-key', auto: true }),
      pickModel: async () => ({ kind: 'value', value: fireworksModel, auto: true }),
      askApiKey: async () => {
        apiKeyCalls += 1
        return { kind: 'back' }
      },
    })

    // when + then
    await expect(collectWizardInputs('/agent', prompts)).rejects.toThrow(WizardAbortedError)
    // The user only ever interacts with the api-key prompt. Two cancels
    // are enough to escape: the second cancel revisits enter-api-key with
    // pendingBackOrigin already set to enter-api-key, so it aborts.
    expect(apiKeyCalls).toBe(2)
  })

  test('back from pick-model returns to pick-vendor, then advances', async () => {
    const calls: string[] = []
    let modelBacked = false
    const prompts = makePrompts({
      pickVendor: async () => {
        calls.push('pick-vendor')
        return { kind: 'value', value: 'fireworks' as KnownProviderVendorId }
      },
      pickModel: async () => {
        calls.push('pick-model')
        if (!modelBacked) {
          modelBacked = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: fireworksModel }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-vendor', 'pick-model', 'pick-vendor', 'pick-model'])
  })

  test('back from pick-channel returns to enter-api-key when api-key was chosen', async () => {
    const calls: string[] = []
    let channelBacked = false
    const prompts = makePrompts({
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'api-key' }
      },
      askApiKey: async () => {
        calls.push('enter-api-key')
        return { kind: 'value', value: 'sk_test' }
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        if (!channelBacked) {
          channelBacked = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'none' }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-auth-method', 'enter-api-key', 'pick-channel', 'enter-api-key', 'pick-channel'])
  })

  test('back from pick-channel returns to pick-auth-method when oauth was chosen', async () => {
    const calls: string[] = []
    let channelBacked = false
    const prompts = makePrompts({
      pickVendor: async () => ({ kind: 'value', value: 'openai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'oauth' }
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        if (!channelBacked) {
          channelBacked = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'none' }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-auth-method', 'pick-channel', 'pick-channel'])
  })

  test('auto-resume: existing api-key skips pick-auth-method and enter-api-key silently', async () => {
    const calls: string[] = []
    let channelBacked = false
    const prompts = makePrompts({
      readExistingApiKey: async () => 'sk_existing',
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'api-key' }
      },
      askApiKey: async () => {
        calls.push('enter-api-key')
        return { kind: 'value', value: 'fw_test' }
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        if (!channelBacked) {
          channelBacked = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'none' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-channel', 'pick-channel'])
    expect(calls).not.toContain('pick-auth-method')
    expect(calls).not.toContain('enter-api-key')
    expect(result.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk_existing' })
  })

  test('changing provider clears the previously picked model so it is re-asked fresh', async () => {
    let providerCallCount = 0
    let apiKeyBacked = false
    let modelCalls = 0
    const modelInitials: (string | undefined)[] = []
    const prompts = makePrompts({
      pickVendor: async () => {
        providerCallCount += 1
        return { kind: 'value', value: (providerCallCount === 1 ? 'fireworks' : 'openai') as KnownProviderVendorId }
      },
      pickProviderVariant: async (vendorId) => {
        return { kind: 'value', value: (vendorId === 'fireworks' ? 'fireworks' : 'openai') as KnownProviderId }
      },
      pickModel: async (_options, providerId, initial) => {
        modelCalls += 1
        modelInitials.push(initial)
        if (providerId === 'fireworks' && modelCalls === 2) return { kind: 'back' }
        return {
          kind: 'value',
          value: providerId === 'fireworks' ? fireworksModel : openaiModel,
        }
      },
      pickAuthMethod: async () => ({ kind: 'value', value: 'api-key' }),
      askApiKey: async () => {
        if (!apiKeyBacked) {
          apiKeyBacked = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'sk_test' }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(providerCallCount).toBe(2)
    expect(modelInitials).toEqual([undefined, fireworksModel.ref, undefined])
  })

  test('picking a different provider on retry discards the prior model selection', async () => {
    let providerCallCount = 0
    let modelBackedOnce = false
    const modelInitials: (string | undefined)[] = []
    const prompts = makePrompts({
      pickVendor: async () => {
        providerCallCount += 1
        return { kind: 'value', value: (providerCallCount === 1 ? 'fireworks' : 'openai') as KnownProviderVendorId }
      },
      pickProviderVariant: async (vendorId) => {
        return { kind: 'value', value: (vendorId === 'fireworks' ? 'fireworks' : 'openai') as KnownProviderId }
      },
      pickModel: async (_options, providerId, initial) => {
        modelInitials.push(initial)
        if (providerId === 'fireworks' && !modelBackedOnce) {
          return { kind: 'value', value: fireworksModel }
        }
        if (providerId === 'fireworks') {
          return { kind: 'back' }
        }
        return { kind: 'value', value: openaiModel }
      },
      pickAuthMethod: async () => ({ kind: 'value', value: 'api-key' }),
      askApiKey: async () => {
        if (!modelBackedOnce) {
          modelBackedOnce = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'sk_test' }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(providerCallCount).toBe(2)
    expect(modelInitials[modelInitials.length - 1]).toBeUndefined()
  })

  test('catalog is loaded once even when stepping back across providers', async () => {
    let catalogLoads = 0
    let providerCallCount = 0
    const prompts = makePrompts({
      loadCatalog: async () => {
        catalogLoads += 1
        return { options: [fireworksModel], source: 'curated' }
      },
      pickVendor: async () => {
        providerCallCount += 1
        return { kind: 'value', value: 'fireworks' as KnownProviderVendorId }
      },
      pickModel: async () => {
        if (providerCallCount === 1) return { kind: 'back' }
        return { kind: 'value', value: fireworksModel }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(catalogLoads).toBe(1)
    expect(providerCallCount).toBe(2)
  })

  test('text-only default model: vision picker runs after auth, before pick-channel', async () => {
    const calls: string[] = []
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [zaiTextOnlyModel, openaiModel], source: 'curated' }),
      pickVendor: async () => ({ kind: 'value', value: 'zai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'zai' as KnownProviderId, auto: true }),
      pickModel: async () => ({ kind: 'value', value: zaiTextOnlyModel }),
      askApiKey: async () => {
        calls.push('enter-api-key')
        return { kind: 'value', value: 'zai_key' }
      },
      pickVisionVendor: async (options) => {
        calls.push('pick-vision-vendor')
        // Vision picker MUST be fed only vision-capable models.
        expect(options.every((o) => o.supportsVision)).toBe(true)
        expect(options.some((o) => o.ref === zaiTextOnlyModel.ref)).toBe(false)
        return { kind: 'value', value: 'openai' as KnownProviderVendorId }
      },
      pickVisionProviderVariant: async () => {
        return { kind: 'value', value: 'openai' as KnownProviderId }
      },
      pickVisionModel: async () => {
        calls.push('pick-vision-model')
        return { kind: 'value', value: openaiModel }
      },
      pickAuthMethod: async (_provider, _initial) => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'api-key' }
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'none' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual([
      'pick-auth-method',
      'enter-api-key',
      'pick-vision-vendor',
      'pick-vision-model',
      'pick-auth-method',
      'enter-api-key',
      'pick-channel',
    ])
    expect(result!.vision?.model.ref).toBe(openaiModel.ref)
    expect(result!.vision?.llmAuth).toEqual({ kind: 'api-key', apiKey: 'zai_key' })
  })

  test('vision-capable default model: vision picker is skipped entirely', async () => {
    const calls: string[] = []
    const prompts = makePrompts({
      pickVendor: async () => ({ kind: 'value', value: 'fireworks' as KnownProviderVendorId }),
      pickModel: async () => ({ kind: 'value', value: fireworksModel }),
      pickVisionVendor: async () => {
        calls.push('pick-vision-vendor')
        return { kind: 'value', value: 'skip' }
      },
      pickVisionModel: async () => {
        calls.push('pick-vision-model')
        return { kind: 'value', value: openaiModel }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual([])
    expect(result!.vision).toBeUndefined()
  })

  test('vision skip returns no vision profile', async () => {
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [zaiTextOnlyModel, openaiModel], source: 'curated' }),
      pickVendor: async () => ({ kind: 'value', value: 'zai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'zai' as KnownProviderId, auto: true }),
      pickModel: async () => ({ kind: 'value', value: zaiTextOnlyModel }),
      pickVisionVendor: async () => ({ kind: 'value', value: 'skip' }),
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(result!.vision).toBeUndefined()
  })

  test('vision provider matches default provider: reuses default credentials, no auth prompt', async () => {
    const calls: string[] = []
    const visionOpenAI: ModelOption = { ...openaiModel, ref: 'openai/gpt-5.4', modelId: 'gpt-5.4' }
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [zaiTextOnlyModel, visionOpenAI], source: 'curated' }),
      pickVendor: async () => ({ kind: 'value', value: 'zai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'zai' as KnownProviderId, auto: true }),
      pickModel: async () => ({ kind: 'value', value: zaiTextOnlyModel }),
      askApiKey: async () => {
        calls.push('enter-api-key')
        return { kind: 'value', value: 'zai_key' }
      },
      pickVisionVendor: async () => ({ kind: 'value', value: 'zai' as KnownProviderVendorId }),
      pickVisionProviderVariant: async () => ({ kind: 'value', value: 'zai' as KnownProviderId, auto: true }),
      pickVisionModel: async () => ({ kind: 'value', value: { ...zaiTextOnlyModel, supportsVision: true } }),
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'api-key' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-auth-method', 'enter-api-key'])
    expect(result!.vision?.llmAuth).toEqual({ kind: 'api-key', apiKey: 'zai_key' })
  })

  test('vision provider with existing key in secrets.json: reuses without re-prompting', async () => {
    const calls: string[] = []
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [zaiTextOnlyModel, openaiModel], source: 'curated' }),
      readExistingApiKey: async (_cwd, providerId) => (providerId === 'openai' ? 'sk_existing_openai' : null),
      pickVendor: async () => ({ kind: 'value', value: 'zai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'zai' as KnownProviderId, auto: true }),
      pickModel: async () => ({ kind: 'value', value: zaiTextOnlyModel }),
      askApiKey: async () => ({ kind: 'value', value: 'zai_key' }),
      pickVisionVendor: async () => ({ kind: 'value', value: 'openai' as KnownProviderVendorId }),
      pickVisionProviderVariant: async () => ({ kind: 'value', value: 'openai' as KnownProviderId }),
      pickVisionModel: async () => ({ kind: 'value', value: openaiModel }),
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'api-key' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-auth-method'])
    expect(result!.vision?.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk_existing_openai' })
  })

  test('back from pick-vision-vendor returns to pick-model', async () => {
    const calls: string[] = []
    let backed = false
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [zaiTextOnlyModel, openaiModel], source: 'curated' }),
      pickVendor: async () => ({ kind: 'value', value: 'zai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'zai' as KnownProviderId, auto: true }),
      pickModel: async () => ({ kind: 'value', value: zaiTextOnlyModel }),
      askApiKey: async () => {
        calls.push('enter-api-key')
        return { kind: 'value', value: 'zai_key' }
      },
      pickVisionVendor: async () => {
        calls.push('pick-vision-vendor')
        if (!backed) {
          backed = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'skip' }
      },
    })

    await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['enter-api-key', 'pick-vision-vendor', 'enter-api-key', 'pick-vision-vendor'])
  })

  test('back from channel-flow returns to pick-channel', async () => {
    const calls: string[] = []
    let flowBacked = false
    const prompts = makePrompts({
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'discord' }
      },
      runChannelFlow: async () => {
        calls.push('channel-flow')
        if (!flowBacked) {
          flowBacked = true
          return { kind: 'back' }
        }
        return { kind: 'value', value: { discordBotToken: 'tok' } }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-channel', 'channel-flow', 'pick-channel', 'channel-flow'])
    expect(result.channelSecrets).toEqual({ discordBotToken: 'tok' })
  })

  test('auto-resume: existing channel secrets are silently reused, skipping channel-flow', async () => {
    const calls: string[] = []
    const runFlow = mock(async () => ({ kind: 'value' as const, value: { discordBotToken: 'tok' } }))
    const prompts = makePrompts({
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'discord' }
      },
      hasExistingChannelSecrets: async (_cwd, channel) => channel === 'discord',
      runChannelFlow: runFlow,
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(runFlow).not.toHaveBeenCalled()
    expect(calls).toEqual(['pick-channel'])
    expect(result.reuseExistingChannel).toBe(true)
    expect(result.channelChoice).toBe('discord')
    expect(result.channelSecrets).toEqual({})
  })

  test('no existing channel secrets: falls through to channel-flow without asking to reuse', async () => {
    const calls: string[] = []
    const prompts = makePrompts({
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'discord' }
      },
      hasExistingChannelSecrets: async () => false,
      runChannelFlow: async () => {
        calls.push('channel-flow')
        return { kind: 'value', value: { discordBotToken: 'tok' } }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual(['pick-channel', 'channel-flow'])
    expect(result.reuseExistingChannel).toBe(false)
    expect(result.channelSecrets).toEqual({ discordBotToken: 'tok' })
  })

  test('reset: forces re-prompting even when channel secrets already exist on disk', async () => {
    const calls: string[] = []
    const hasExisting = mock(async () => true)
    const prompts = makePrompts({
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'discord' }
      },
      hasExistingChannelSecrets: hasExisting,
      runChannelFlow: async () => {
        calls.push('channel-flow')
        return { kind: 'value', value: { discordBotToken: 'fresh' } }
      },
    })

    const result = await collectWizardInputs('/agent', prompts, { reset: true })

    expect(hasExisting).not.toHaveBeenCalled()
    expect(calls).toEqual(['pick-channel', 'channel-flow'])
    expect(result.reuseExistingChannel).toBe(false)
    expect(result.channelSecrets).toEqual({ discordBotToken: 'fresh' })
  })

  test('github: wizard collects structured credentials into channelSecrets.github', async () => {
    const calls: string[] = []
    // Production hasExistingChannelSecrets returns false for github so the
    // auto-resume short-circuit is suppressed. The test mirrors that contract here.
    const hasExisting = mock(async (_cwd: string, channel: string) => channel !== 'github')
    const prompts = makePrompts({
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'github' }
      },
      hasExistingChannelSecrets: hasExisting,
      runChannelFlow: async (choice) => {
        calls.push(`channel-flow:${choice}`)
        return {
          kind: 'value',
          value: {
            github: {
              webhookSecret: 'whsec',
              tunnelProvider: 'external',
              webhookUrl: 'https://example.com/wh',
              webhookPort: 8975,
              repos: ['acme/repo-a', 'acme/repo-b'],
              auth: { type: 'pat', pat: 'ghp_test' },
            },
          },
        }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(hasExisting).toHaveBeenCalledWith('/agent', 'github')
    expect(calls).toEqual(['pick-channel', 'channel-flow:github'])
    expect(result.channelChoice).toBe('github')
    expect(result.reuseExistingChannel).toBe(false)
    expect(result.channelSecrets).toEqual({
      github: {
        webhookSecret: 'whsec',
        tunnelProvider: 'external',
        webhookUrl: 'https://example.com/wh',
        webhookPort: 8975,
        repos: ['acme/repo-a', 'acme/repo-b'],
        auth: { type: 'pat', pat: 'ghp_test' },
      },
    })
  })

  test('oauth path: runs login inside the wizard, before pick-channel', async () => {
    const calls: string[] = []
    const loginCalls: Array<{ cwd: string; model: string; providerName: string }> = []
    const prompts = makePrompts({
      pickVendor: async () => ({ kind: 'value', value: 'openai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'oauth' }
      },
      runOAuthLogin: async (provider, cwd, model) => {
        loginCalls.push({ cwd, model, providerName: provider.name })
        calls.push('run-oauth-login')
        return { ok: true }
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'none' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(loginCalls).toEqual([
      { cwd: '/agent', model: codexModel.ref, providerName: KNOWN_PROVIDERS['openai-codex'].name },
    ])
    expect(calls).toEqual(['pick-auth-method', 'run-oauth-login', 'pick-channel'])
    expect(result.llmAuth).toEqual({ kind: 'oauth-completed' })
  })

  test('oauth path: login failure prompts recovery; user picks retry and succeeds', async () => {
    const calls: string[] = []
    let loginAttempt = 0
    let authMethodCalls = 0
    const prompts = makePrompts({
      pickVendor: async () => ({ kind: 'value', value: 'openai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async () => {
        authMethodCalls += 1
        calls.push(`pick-auth-method:${authMethodCalls}`)
        return { kind: 'value', value: 'oauth' }
      },
      runOAuthLogin: async () => {
        loginAttempt += 1
        calls.push(`run-oauth-login:${loginAttempt}`)
        if (loginAttempt === 1) return { ok: false, reason: 'browser closed' }
        return { ok: true }
      },
      askOAuthFailureRecovery: async (provider, reason) => {
        calls.push(`recovery:${provider.id}:${reason}`)
        return 'retry'
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'none' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual([
      'pick-auth-method:1',
      'run-oauth-login:1',
      'recovery:openai-codex:browser closed',
      'pick-auth-method:2',
      'run-oauth-login:2',
      'pick-channel',
    ])
    expect(result.llmAuth).toEqual({ kind: 'oauth-completed' })
  })

  test('oauth path: login failure → user picks api-key fallback routes to enter-api-key', async () => {
    const calls: string[] = []
    const prompts = makePrompts({
      pickVendor: async () => ({ kind: 'value', value: 'openai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'openai' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: openaiModel }),
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'oauth' }
      },
      runOAuthLogin: async () => {
        calls.push('run-oauth-login')
        return { ok: false, reason: 'token revoked' }
      },
      askOAuthFailureRecovery: async (_provider, _reason, apiKeyAvailable) => {
        calls.push(`recovery:apiKeyAvailable=${apiKeyAvailable}`)
        return 'api-key'
      },
      askApiKey: async () => {
        calls.push('enter-api-key')
        return { kind: 'value', value: 'sk_fallback' }
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'none' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(calls).toEqual([
      'pick-auth-method',
      'run-oauth-login',
      'recovery:apiKeyAvailable=true',
      'enter-api-key',
      'pick-channel',
    ])
    expect(result.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk_fallback' })
  })

  test('oauth path: login failure → user picks abort throws WizardAbortedError', async () => {
    const prompts = makePrompts({
      pickVendor: async () => ({ kind: 'value', value: 'openai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth' }),
      runOAuthLogin: async () => ({ ok: false, reason: 'cancelled' }),
      askOAuthFailureRecovery: async () => 'abort',
    })

    await expect(collectWizardInputs('/agent', prompts)).rejects.toThrow(WizardAbortedError)
  })

  test('oauth path: oauth-only provider gets apiKeyAvailable=false in recovery prompt', async () => {
    let apiKeyAvailableSeen: boolean | undefined
    const prompts = makePrompts({
      pickVendor: async () => ({ kind: 'value', value: 'openai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth' }),
      runOAuthLogin: async () => ({ ok: false, reason: 'whatever' }),
      askOAuthFailureRecovery: async (_provider, _reason, apiKeyAvailable) => {
        apiKeyAvailableSeen = apiKeyAvailable
        return 'abort'
      },
    })

    await expect(collectWizardInputs('/agent', prompts)).rejects.toThrow(WizardAbortedError)
    expect(apiKeyAvailableSeen).toBe(false)
  })

  test('oauth path: runner that throws is coerced to a failure recovery prompt (init never crashes)', async () => {
    const calls: string[] = []
    const prompts = makePrompts({
      pickVendor: async () => ({ kind: 'value', value: 'openai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'oauth' }
      },
      runOAuthLogin: async () => {
        calls.push('run-oauth-login')
        throw new Error('unexpected runner crash')
      },
      askOAuthFailureRecovery: async (_provider, reason) => {
        calls.push(`recovery:${reason}`)
        return 'abort'
      },
    })

    await expect(collectWizardInputs('/agent', prompts)).rejects.toThrow(WizardAbortedError)
    expect(calls).toEqual(['pick-auth-method', 'run-oauth-login', 'recovery:unexpected runner crash'])
  })

  test('oauth path: vision profile also runs login inside the wizard when provider differs', async () => {
    const calls: string[] = []
    const loginCalls: Array<{ cwd: string; model: string; providerName: string }> = []
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [zaiTextOnlyModel, codexModel], source: 'curated' }),
      pickVendor: async () => ({ kind: 'value', value: 'zai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'zai' as KnownProviderId, auto: true }),
      pickModel: async () => ({ kind: 'value', value: zaiTextOnlyModel }),
      askApiKey: async () => ({ kind: 'value', value: 'zai_key' }),
      pickVisionVendor: async () => ({ kind: 'value', value: 'openai' as KnownProviderVendorId }),
      pickVisionProviderVariant: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickVisionModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async (provider) => {
        calls.push(`pick-auth-method:${provider.id}`)
        return { kind: 'value', value: provider.id === 'openai-codex' ? 'oauth' : 'api-key' }
      },
      runOAuthLogin: async (provider, cwd, model) => {
        loginCalls.push({ cwd, model, providerName: provider.name })
        calls.push('run-oauth-login')
        return { ok: true }
      },
      pickChannel: async () => {
        calls.push('pick-channel')
        return { kind: 'value', value: 'none' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(loginCalls).toEqual([
      { cwd: '/agent', model: codexModel.ref, providerName: KNOWN_PROVIDERS['openai-codex'].name },
    ])
    expect(result.vision?.llmAuth).toEqual({ kind: 'oauth-completed' })
    // OAuth login runs immediately after the vision provider's auth method is
    // picked — before pick-channel. The default provider (Z.AI, api-key only)
    // never reaches runOAuthLogin.
    expect(calls).toEqual(['pick-auth-method:zai', 'pick-auth-method:openai-codex', 'run-oauth-login', 'pick-channel'])
  })

  test('oauth path: stale pendingBackOrigin from a pre-OAuth back is cleared by recovery prompt', async () => {
    // Regression for the bug surfaced by self-review: a back press from
    // enter-api-key (which sets pendingBackOrigin = 'enter-api-key') followed
    // by an autoValue OAuth attempt + OAuth failure + recovery=api-key would
    // route back to enter-api-key. The user's first back press there would
    // see the stale pendingBackOrigin and spuriously abort the wizard.
    let askApiKeyCalls = 0
    let askApiKeyBackCount = 0
    const prompts = makePrompts({
      pickVendor: async () => ({ kind: 'value', value: 'openai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'openai' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: openaiModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth' }),
      runOAuthLogin: async () => ({ ok: false, reason: 'failed' }),
      askOAuthFailureRecovery: async () => 'api-key',
      askApiKey: async () => {
        askApiKeyCalls += 1
        if (askApiKeyCalls === 1) {
          askApiKeyBackCount += 1
          return { kind: 'back' }
        }
        return { kind: 'value', value: 'sk_recovered' }
      },
      pickChannel: async () => ({ kind: 'value', value: 'none' }),
    })

    const result = await collectWizardInputs('/agent', prompts)

    // The single back press at enter-api-key must NOT abort — pendingBackOrigin
    // was reset by the recovery prompt, so this is treated as a first-back.
    expect(askApiKeyBackCount).toBe(1)
    expect(result.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk_recovered' })
  })

  test('oauth path: WizardAbortedError carries oauthCredentialsSaved=true after a successful OAuth', async () => {
    // Successful OAuth, then user aborts later (double-back from pick-channel).
    // The wizard must surface that credentials were already written so the CLI
    // can warn the user instead of exiting silently.
    let channelBacks = 0
    const prompts = makePrompts({
      pickVendor: async () => ({ kind: 'value', value: 'openai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel, auto: true }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth', auto: true }),
      runOAuthLogin: async () => ({ ok: true }),
      pickChannel: async () => {
        channelBacks += 1
        return { kind: 'back' }
      },
    })

    try {
      await collectWizardInputs('/agent', prompts)
      throw new Error('expected WizardAbortedError')
    } catch (error) {
      expect(error).toBeInstanceOf(WizardAbortedError)
      expect((error as WizardAbortedError).oauthCredentialsSaved).toBe(true)
    }
    expect(channelBacks).toBeGreaterThanOrEqual(1)
  })

  test('oauth path: WizardAbortedError.oauthCredentialsSaved is false when OAuth never succeeded', async () => {
    const prompts = makePrompts({
      pickVendor: async () => ({ kind: 'value', value: 'openai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth' }),
      runOAuthLogin: async () => ({ ok: false, reason: 'nope' }),
      askOAuthFailureRecovery: async () => 'abort',
    })

    try {
      await collectWizardInputs('/agent', prompts)
      throw new Error('expected WizardAbortedError')
    } catch (error) {
      expect(error).toBeInstanceOf(WizardAbortedError)
      expect((error as WizardAbortedError).oauthCredentialsSaved).toBe(false)
    }
  })

  test('dual-auth provider (anthropic): pickAuthMethod is REAL prompt with both options, not autoValue', async () => {
    // given: anthropic supports both api-key and oauth. Unlike openai
    //   (api-key-only) and openai-codex (oauth-only), pickAuthMethod must
    //   actually ask the user — autoValue is wrong here. We assert the
    //   prompt sees the live provider and that the wizard honors the
    //   user's selection literally.
    let seenProviderId: string | undefined
    let seenBothAuthModes: boolean | undefined
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [anthropicModel], source: 'curated' }),
      pickVendor: async () => ({ kind: 'value', value: 'anthropic' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'anthropic' as KnownProviderId, auto: true }),
      pickModel: async () => ({ kind: 'value', value: anthropicModel }),
      pickAuthMethod: async (provider) => {
        seenProviderId = provider.id
        seenBothAuthModes = supportsApiKey(provider) && supportsOAuth(provider)
        return { kind: 'value', value: 'api-key' }
      },
      askApiKey: async () => ({ kind: 'value', value: 'sk-ant-test' }),
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(seenProviderId).toBe('anthropic')
    expect(seenBothAuthModes).toBe(true)
    expect(result.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk-ant-test' })
  })

  test('dual-auth provider (anthropic): user picks oauth → runOAuthLogin fires with anthropic ref', async () => {
    const loginCalls: Array<{ cwd: string; model: string; providerId: string }> = []
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [anthropicModel], source: 'curated' }),
      pickVendor: async () => ({ kind: 'value', value: 'anthropic' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'anthropic' as KnownProviderId, auto: true }),
      pickModel: async () => ({ kind: 'value', value: anthropicModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth' }),
      runOAuthLogin: async (provider, cwd, model) => {
        loginCalls.push({ cwd, model, providerId: provider.id })
        return { ok: true }
      },
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(loginCalls).toEqual([{ cwd: '/agent', model: 'anthropic/claude-haiku-4-5', providerId: 'anthropic' }])
    expect(result.llmAuth).toEqual({ kind: 'oauth-completed' })
  })

  test('dual-auth provider (anthropic): oauth failure offers api-key fallback (apiKeyAvailable=true)', async () => {
    // given: anthropic's OAuth login fails — distinct from openai-codex,
    //   where api-key fallback is unavailable. The recovery prompt MUST see
    //   apiKeyAvailable=true so the wizard can route to enter-api-key.
    let apiKeyAvailableSeen: boolean | undefined
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [anthropicModel], source: 'curated' }),
      pickVendor: async () => ({ kind: 'value', value: 'anthropic' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'anthropic' as KnownProviderId, auto: true }),
      pickModel: async () => ({ kind: 'value', value: anthropicModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth' }),
      runOAuthLogin: async () => ({ ok: false, reason: 'browser closed' }),
      askOAuthFailureRecovery: async (_provider, _reason, apiKeyAvailable) => {
        apiKeyAvailableSeen = apiKeyAvailable
        return 'api-key'
      },
      askApiKey: async () => ({ kind: 'value', value: 'sk-ant-recovered' }),
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(apiKeyAvailableSeen).toBe(true)
    expect(result.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk-ant-recovered' })
  })

  test('auto-resume: existing OAuth credentials skip the browser login', async () => {
    const runOAuth = mock(async () => ({ ok: true as const }))
    const prompts = makePrompts({
      pickVendor: async () => ({ kind: 'value', value: 'openai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      hasExistingOAuthCredentials: async (_cwd, providerId) => providerId === 'openai-codex',
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth', auto: true }),
      runOAuthLogin: runOAuth,
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(runOAuth).not.toHaveBeenCalled()
    expect(result.llmAuth).toEqual({ kind: 'oauth-completed' })
  })

  test('auto-resume: existing vision OAuth credentials skip the second browser login', async () => {
    const runOAuth = mock(async () => ({ ok: true as const }))
    const prompts = makePrompts({
      loadCatalog: async () => ({ options: [zaiTextOnlyModel, codexModel], source: 'curated' }),
      pickVendor: async () => ({ kind: 'value', value: 'zai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'zai' as KnownProviderId, auto: true }),
      pickModel: async () => ({ kind: 'value', value: zaiTextOnlyModel }),
      askApiKey: async () => ({ kind: 'value', value: 'zai_key' }),
      pickVisionVendor: async () => ({ kind: 'value', value: 'openai' as KnownProviderVendorId }),
      pickVisionProviderVariant: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickVisionModel: async () => ({ kind: 'value', value: codexModel }),
      hasExistingOAuthCredentials: async (_cwd, providerId) => providerId === 'openai-codex',
      pickAuthMethod: async (provider) => ({
        kind: 'value',
        value: provider.id === 'openai-codex' ? 'oauth' : 'api-key',
      }),
      runOAuthLogin: runOAuth,
    })

    const result = await collectWizardInputs('/agent', prompts)

    expect(runOAuth).not.toHaveBeenCalled()
    expect(result.vision?.llmAuth).toEqual({ kind: 'oauth-completed' })
  })

  test('reset: existing OAuth credentials are ignored, browser login runs again', async () => {
    const runOAuth = mock(async () => ({ ok: true as const }))
    const hasOAuth = mock(async () => true)
    const prompts = makePrompts({
      pickVendor: async () => ({ kind: 'value', value: 'openai' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'openai-codex' as KnownProviderId }),
      pickModel: async () => ({ kind: 'value', value: codexModel }),
      hasExistingOAuthCredentials: hasOAuth,
      pickAuthMethod: async () => ({ kind: 'value', value: 'oauth', auto: true }),
      runOAuthLogin: runOAuth,
    })

    const result = await collectWizardInputs('/agent', prompts, { reset: true })

    expect(hasOAuth).not.toHaveBeenCalled()
    expect(runOAuth).toHaveBeenCalledTimes(1)
    expect(result.llmAuth).toEqual({ kind: 'oauth-completed' })
  })

  test('reset: existing api-key on disk is ignored, askApiKey is prompted', async () => {
    const calls: string[] = []
    const readExisting = mock(async () => 'sk_existing')
    const prompts = makePrompts({
      readExistingApiKey: readExisting,
      pickAuthMethod: async () => {
        calls.push('pick-auth-method')
        return { kind: 'value', value: 'api-key' }
      },
      askApiKey: async () => {
        calls.push('enter-api-key')
        return { kind: 'value', value: 'sk_fresh' }
      },
    })

    const result = await collectWizardInputs('/agent', prompts, { reset: true })

    expect(readExisting).not.toHaveBeenCalled()
    expect(calls).toEqual(['pick-auth-method', 'enter-api-key'])
    expect(result.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk_fresh' })
  })

  test('auto-resume + reset: reset honors both api-key AND OAuth bypass; auto-resume off honors both', async () => {
    // Defense-in-depth: a single options.reset must short-circuit every
    // existence check (api-key, OAuth, channel). This is the test that
    // catches a future contributor who plumbs reset through one path
    // but forgets another.
    const readExisting = mock(async () => 'sk_existing')
    const hasOAuth = mock(async () => true)
    const hasChannel = mock(async () => true)
    const prompts = makePrompts({
      readExistingApiKey: readExisting,
      hasExistingOAuthCredentials: hasOAuth,
      hasExistingChannelSecrets: hasChannel,
      pickVendor: async () => ({ kind: 'value', value: 'anthropic' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'anthropic' as KnownProviderId, auto: true }),
      pickModel: async () => ({ kind: 'value', value: anthropicModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'api-key' }),
      askApiKey: async () => ({ kind: 'value', value: 'sk_fresh' }),
      pickChannel: async () => ({ kind: 'value', value: 'discord' }),
      runChannelFlow: async () => ({ kind: 'value', value: { discordBotToken: 'fresh' } }),
    })

    await collectWizardInputs('/agent', prompts, { reset: true })

    expect(readExisting).not.toHaveBeenCalled()
    expect(hasOAuth).not.toHaveBeenCalled()
    expect(hasChannel).not.toHaveBeenCalled()
  })
})

describe('recommended models', () => {
  function model(ref: ModelOption['ref'], overrides: Partial<ModelOption> = {}): ModelOption {
    const slash = ref.indexOf('/')
    const providerId = ref.slice(0, slash) as ModelOption['providerId']
    const modelId = ref.slice(slash + 1)
    return {
      ref,
      providerId,
      providerName: providerId,
      modelId,
      modelName: modelId,
      reasoning: false,
      contextWindow: null,
      curated: true,
      supportsVision: false,
      ...overrides,
    }
  }

  test('formatModelLabel marks gpt-6.1-terra under openai as Recommended', () => {
    const o = model('openai/gpt-6.1-terra', { modelName: 'GPT-6.1 Terra' })
    expect(formatModelLabel(o)).toBe('GPT-6.1 Terra (Recommended)')
  })

  test('formatModelLabel marks gpt-6.1-terra under openai-codex as Recommended', () => {
    const o = model('openai-codex/gpt-6.1-terra', { modelName: 'GPT-6.1 Terra' })
    expect(formatModelLabel(o)).toBe('GPT-6.1 Terra (Recommended)')
  })

  test('formatModelLabel marks claude-sonnet-5-5 as Recommended', () => {
    const o = model('anthropic/claude-sonnet-5-5', { modelName: 'Claude Sonnet 5.5' })
    expect(formatModelLabel(o)).toBe('Claude Sonnet 5.5 (Recommended)')
  })

  test('formatModelLabel leaves non-recommended models unchanged', () => {
    const o = model('openai/gpt-5.4', { modelName: 'GPT-5.4' })
    expect(formatModelLabel(o)).toBe('GPT-5.4')
  })

  test('sortRecommendedFirst floats the recommended OpenAI model to the top', () => {
    const sol = model('openai/gpt-6-sol', { modelName: 'GPT-6 Sol' })
    const luna = model('openai/gpt-6-luna', { modelName: 'GPT-6 Luna' })
    const terra = model('openai/gpt-6.1-terra', { modelName: 'GPT-6.1 Terra' })
    const sorted = sortRecommendedFirst([sol, luna, terra])
    expect(sorted.map((o) => o.ref)).toEqual(['openai/gpt-6.1-terra', 'openai/gpt-6-sol', 'openai/gpt-6-luna'])
  })

  test('sortRecommendedFirst floats the recommended Anthropic model to the top', () => {
    const haiku = model('anthropic/claude-haiku-4-5', { modelName: 'Claude Haiku 4.5' })
    const sonnet = model('anthropic/claude-sonnet-4-6', { modelName: 'Claude Sonnet 4.6' })
    const sonnet5 = model('anthropic/claude-sonnet-5', { modelName: 'Claude Sonnet 5' })
    const opus47 = model('anthropic/claude-opus-4-7', { modelName: 'Claude Opus 4.7' })
    const opus48 = model('anthropic/claude-opus-4-8', { modelName: 'Claude Opus 4.8' })
    const fable5 = model('anthropic/claude-fable-5', { modelName: 'Claude Fable 5' })
    const sonnet55 = model('anthropic/claude-sonnet-5-5', { modelName: 'Claude Sonnet 5.5' })
    const sorted = sortRecommendedFirst([haiku, sonnet, sonnet5, sonnet55, opus47, opus48, fable5])
    expect(sorted.map((o) => o.ref)).toEqual([
      'anthropic/claude-sonnet-5-5',
      'anthropic/claude-haiku-4-5',
      'anthropic/claude-sonnet-4-6',
      'anthropic/claude-sonnet-5',
      'anthropic/claude-opus-4-7',
      'anthropic/claude-opus-4-8',
      'anthropic/claude-fable-5',
    ])
  })

  test('sortRecommendedFirst preserves order when no model is recommended', () => {
    const a = model('openai/gpt-5.4-nano')
    const b = model('openai/gpt-5.4')
    const sorted = sortRecommendedFirst([a, b])
    expect(sorted.map((o) => o.ref)).toEqual(['openai/gpt-5.4-nano', 'openai/gpt-5.4'])
  })
})

describe('collectWizardInputs wizard-answer checkpoint', () => {
  const FIREWORKS_REF = 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'
  const fireworksModel: ModelOption = {
    providerId: 'fireworks',
    providerName: 'Fireworks',
    modelId: 'accounts/fireworks/routers/kimi-k2p6-turbo',
    modelName: 'Kimi K2.6 Turbo',
    ref: FIREWORKS_REF,
    contextWindow: 256000,
    reasoning: true,
    curated: true,
    supportsVision: true,
  }

  function inMemoryStore(initial?: ReturnType<typeof checkpointFromSelections>): {
    store: WizardCheckpointStore
    saved: () => ReturnType<typeof checkpointFromSelections> | undefined
    clears: () => number
  } {
    let current = initial
    let clears = 0
    return {
      store: {
        load: async () => current,
        save: async (_cwd, checkpoint) => {
          current = checkpoint
        },
        clear: async () => {
          current = undefined
          clears += 1
        },
      },
      saved: () => current,
      clears: () => clears,
    }
  }

  function basePrompts(overrides: Partial<WizardPrompts> = {}): WizardPrompts {
    return {
      loadCatalog: async () => ({ options: [fireworksModel], source: 'curated' }),
      readExistingApiKey: async () => null,
      hasExistingOAuthCredentials: async () => false,
      pickVendor: async () => ({ kind: 'value', value: 'fireworks' as KnownProviderVendorId }),
      pickProviderVariant: async () => ({ kind: 'value', value: 'fireworks' as KnownProviderId, auto: true }),
      pickModel: async () => ({ kind: 'value', value: fireworksModel }),
      pickAuthMethod: async () => ({ kind: 'value', value: 'api-key' }),
      askApiKey: async () => ({ kind: 'value', value: 'fw_test' }),
      validateApiKey: async () => ({ kind: 'ok' as const }),
      pickVisionVendor: async () => ({ kind: 'value', value: 'skip' }),
      pickVisionProviderVariant: async () => ({ kind: 'value', value: 'openai' as KnownProviderId, auto: true }),
      pickVisionModel: async () => ({ kind: 'value', value: fireworksModel }),
      pickChannel: async () => ({ kind: 'value', value: 'none' }),
      hasExistingChannelSecrets: async () => false,
      runChannelFlow: async () => ({ kind: 'value', value: {} }),
      runOAuthLogin: async () => ({ ok: true }),
      askOAuthFailureRecovery: async () => 'abort',
      confirmResumeCheckpoint: async () => 'start-over',
      ...overrides,
    }
  }

  test('persists selections to the store as the wizard advances', async () => {
    const { store, saved } = inMemoryStore()
    await collectWizardInputs('/agent', basePrompts(), { checkpointStore: store })

    const checkpoint = saved()
    expect(checkpoint?.vendorId).toBe('fireworks')
    expect(checkpoint?.providerId).toBe('fireworks')
    expect(checkpoint?.modelRef).toBe(FIREWORKS_REF)
    expect(checkpoint?.channelChoice).toBe('none')
  })

  test('never persists secret material', async () => {
    const { store, saved } = inMemoryStore()
    await collectWizardInputs('/agent', basePrompts(), { checkpointStore: store })
    const serialized = JSON.stringify(saved())
    expect(serialized).not.toContain('fw_test')
    expect(serialized).not.toContain('apiKey')
    expect(serialized).not.toContain('llmAuth')
  })

  test('resume auto-skips every checkpoint-covered choice prompt, not just the upstream ones', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-init-resume-'))
    const existing = checkpointFromSelections({
      cwd,
      vendorId: 'fireworks',
      providerId: 'fireworks',
      modelRef: FIREWORKS_REF as Parameters<typeof checkpointFromSelections>[0]['modelRef'],
      authMethod: 'api-key',
      channelChoice: 'none',
    })
    const { store } = inMemoryStore(existing)

    let confirmCalls = 0
    let vendorCalls = 0
    let modelCalls = 0
    let channelCalls = 0
    const result = await collectWizardInputs(
      cwd,
      basePrompts({
        confirmResumeCheckpoint: async () => {
          confirmCalls += 1
          return 'resume'
        },
        readExistingApiKey: async () => 'sk_existing',
        pickVendor: async () => {
          vendorCalls += 1
          return { kind: 'value', value: 'fireworks' as KnownProviderVendorId }
        },
        pickModel: async () => {
          modelCalls += 1
          return { kind: 'value', value: fireworksModel }
        },
        pickChannel: async () => {
          channelCalls += 1
          return { kind: 'value', value: 'none' }
        },
      }),
      { checkpointStore: store },
    )

    expect(confirmCalls).toBe(1)
    expect(vendorCalls).toBe(0)
    expect(modelCalls).toBe(0)
    expect(channelCalls).toBe(0)
    // The seeded model still drives the result even though no prompt fired.
    expect(result.model).toBe(fireworksModel)
    expect(result.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk_existing' })
    expect(result.channelChoice).toBe('none')
  })

  test('resume stops interactively at the first un-checkpointed step (model saved, channel not)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-init-resume-'))
    const existing = checkpointFromSelections({
      cwd,
      vendorId: 'fireworks',
      providerId: 'fireworks',
      modelRef: FIREWORKS_REF as Parameters<typeof checkpointFromSelections>[0]['modelRef'],
      authMethod: 'api-key',
    })
    const { store } = inMemoryStore(existing)

    let modelCalls = 0
    let channelCalls = 0
    let channelInitialWasUndefined = false
    const result = await collectWizardInputs(
      cwd,
      basePrompts({
        confirmResumeCheckpoint: async () => 'resume',
        readExistingApiKey: async () => 'sk_existing',
        pickModel: async () => {
          modelCalls += 1
          return { kind: 'value', value: fireworksModel }
        },
        pickChannel: async (initial) => {
          channelCalls += 1
          channelInitialWasUndefined = initial === undefined
          return { kind: 'value', value: 'none' }
        },
      }),
      { checkpointStore: store },
    )

    // given the model is checkpoint-covered but channelChoice is not:
    expect(modelCalls).toBe(0) // model auto-skipped
    expect(channelCalls).toBe(1) // channel prompt fired for real
    expect(channelInitialWasUndefined).toBe(true) // no saved choice to pre-fill
    expect(result.model).toBe(fireworksModel)
  })

  test('resume does NOT auto-skip the api-key prompt when no key is on disk', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-init-resume-'))
    const existing = checkpointFromSelections({
      cwd,
      vendorId: 'fireworks',
      providerId: 'fireworks',
      modelRef: FIREWORKS_REF as Parameters<typeof checkpointFromSelections>[0]['modelRef'],
      authMethod: 'api-key',
      channelChoice: 'none',
    })
    const { store } = inMemoryStore(existing)

    let askApiKeyCalls = 0
    const result = await collectWizardInputs(
      cwd,
      basePrompts({
        confirmResumeCheckpoint: async () => 'resume',
        readExistingApiKey: async () => null, // key value is never checkpointed
        askApiKey: async () => {
          askApiKeyCalls += 1
          return { kind: 'value', value: 'sk_freshly_entered' }
        },
      }),
      { checkpointStore: store },
    )

    expect(askApiKeyCalls).toBe(1) // secret entry still required
    expect(result.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk_freshly_entered' })
  })

  test('backing out of the first interactive prompt ends replay and re-shows the seeded prior step', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-init-resume-'))
    // channelChoice is intentionally NOT checkpointed, so pick-channel is the
    // first genuinely interactive step after the auto-skipped model.
    const existing = checkpointFromSelections({
      cwd,
      vendorId: 'fireworks',
      providerId: 'fireworks',
      modelRef: FIREWORKS_REF as Parameters<typeof checkpointFromSelections>[0]['modelRef'],
      authMethod: 'api-key',
    })
    const { store } = inMemoryStore(existing)

    let channelCalls = 0
    let modelCalls = 0
    const result = await collectWizardInputs(
      cwd,
      basePrompts({
        confirmResumeCheckpoint: async () => 'resume',
        readExistingApiKey: async () => 'sk_existing',
        pickModel: async () => {
          modelCalls += 1
          return { kind: 'value', value: fireworksModel }
        },
        pickChannel: async () => {
          channelCalls += 1
          // First call (real prompt, model already auto-skipped) backs once;
          // that must re-render pick-model as a real prompt (replay now off),
          // so on the second pick-channel call we commit.
          return channelCalls === 1 ? { kind: 'back' } : { kind: 'value', value: 'none' }
        },
      }),
      { checkpointStore: store },
    )

    // model was auto-skipped on the forward pass, then re-prompted after the
    // back from pick-channel (proving replay ended on the interactive prompt).
    expect(modelCalls).toBe(1)
    expect(channelCalls).toBe(2)
    expect(result.channelChoice).toBe('none')
  })

  test('resume auto-skips the whole vision sub-flow when it was checkpointed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-init-resume-'))
    const zaiTextOnly: ModelOption = {
      providerId: 'zai',
      providerName: 'Z.AI',
      modelId: 'glm-4.6',
      modelName: 'GLM-4.6',
      ref: 'zai/glm-4.6',
      contextWindow: 200000,
      reasoning: true,
      curated: true,
      supportsVision: false,
    }
    const openaiVision: ModelOption = {
      providerId: 'openai',
      providerName: 'OpenAI',
      modelId: 'gpt-5.4-nano',
      modelName: 'GPT-5.4 Nano',
      ref: 'openai/gpt-5.4-nano',
      contextWindow: 128000,
      reasoning: false,
      curated: true,
      supportsVision: true,
    }
    const existing = checkpointFromSelections({
      cwd,
      vendorId: 'zai',
      providerId: 'zai',
      modelRef: zaiTextOnly.ref as Parameters<typeof checkpointFromSelections>[0]['modelRef'],
      authMethod: 'api-key',
      visionVendorId: 'openai',
      visionProviderId: 'openai',
      visionModelRef: openaiVision.ref as Parameters<typeof checkpointFromSelections>[0]['visionModelRef'],
      visionAuthMethod: 'api-key',
      channelChoice: 'none',
    })
    const { store } = inMemoryStore(existing)

    const fired: string[] = []
    const result = await collectWizardInputs(
      cwd,
      basePrompts({
        loadCatalog: async () => ({ options: [zaiTextOnly, openaiVision], source: 'curated' }),
        confirmResumeCheckpoint: async () => 'resume',
        readExistingApiKey: async () => 'sk_existing',
        pickModel: async () => {
          fired.push('pick-model')
          return { kind: 'value', value: zaiTextOnly }
        },
        pickVisionVendor: async () => {
          fired.push('pick-vision-vendor')
          return { kind: 'value', value: 'openai' }
        },
        pickVisionProviderVariant: async () => {
          fired.push('pick-vision-provider-variant')
          return { kind: 'value', value: 'openai' as KnownProviderId }
        },
        pickVisionModel: async () => {
          fired.push('pick-vision-model')
          return { kind: 'value', value: openaiVision }
        },
        pickChannel: async () => {
          fired.push('pick-channel')
          return { kind: 'value', value: 'none' }
        },
      }),
      { checkpointStore: store },
    )

    // No choice prompt fires: model, the entire vision sub-flow, and channel
    // were all checkpoint-covered and auto-skipped.
    expect(fired).toEqual([])
    expect(result.model.ref).toBe(zaiTextOnly.ref)
    expect(result.vision?.model.ref).toBe(openaiVision.ref)
    expect(result.vision?.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk_existing' })
  })

  test('resume reuses existing provider and channel secrets without credential prompts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tc-init-resume-'))
    const existing = checkpointFromSelections({
      cwd,
      vendorId: 'fireworks',
      providerId: 'fireworks',
      modelRef: FIREWORKS_REF as Parameters<typeof checkpointFromSelections>[0]['modelRef'],
      authMethod: 'api-key',
      channelChoice: 'discord',
    })
    const { store } = inMemoryStore(existing)

    let askApiKeyCalls = 0
    let runChannelFlowCalls = 0
    const result = await collectWizardInputs(
      cwd,
      basePrompts({
        confirmResumeCheckpoint: async () => 'resume',
        readExistingApiKey: async () => 'sk_existing',
        pickChannel: async () => ({ kind: 'value', value: 'discord' }),
        hasExistingChannelSecrets: async () => true,
        askApiKey: async (provider) => {
          askApiKeyCalls += 1
          return { kind: 'value', value: `fresh-${provider.name}` }
        },
        runChannelFlow: async () => {
          runChannelFlowCalls += 1
          return { kind: 'value', value: { discordBotToken: 'fresh-discord' } }
        },
      }),
      { checkpointStore: store },
    )

    expect(askApiKeyCalls).toBe(0)
    expect(runChannelFlowCalls).toBe(0)
    expect(result.llmAuth).toEqual({ kind: 'api-key', apiKey: 'sk_existing' })
    expect(result.reuseExistingChannel).toBe(true)
    expect(result.channelSecrets).toEqual({})
  })

  test('start-over discards the existing checkpoint without seeding', async () => {
    const existing = checkpointFromSelections({
      cwd: '/agent',
      vendorId: 'openai',
      providerId: 'openai',
      modelRef: 'openai/gpt-5.4',
    })
    const { store, clears } = inMemoryStore(existing)

    let vendorInitial: string | undefined
    await collectWizardInputs(
      '/agent',
      basePrompts({
        confirmResumeCheckpoint: async () => 'start-over',
        pickVendor: async (_options, initial) => {
          vendorInitial = initial
          return { kind: 'value', value: 'fireworks' as KnownProviderVendorId }
        },
      }),
      { checkpointStore: store },
    )

    expect(vendorInitial).toBeUndefined()
    expect(clears()).toBeGreaterThanOrEqual(1)
  })

  test('--reset ignores the checkpoint entirely (no resume prompt, no save)', async () => {
    const existing = checkpointFromSelections({ cwd: '/agent', vendorId: 'openai' })
    const { store } = inMemoryStore(existing)

    let confirmCalls = 0
    await collectWizardInputs(
      '/agent',
      basePrompts({
        confirmResumeCheckpoint: async () => {
          confirmCalls += 1
          return 'resume'
        },
      }),
      { checkpointStore: store, reset: true },
    )

    expect(confirmCalls).toBe(0)
    // reset leaves the pre-existing checkpoint untouched (no save overwrote it).
    expect(store.load('/agent')).resolves.toEqual(existing)
  })

  test('sanitizes a stale provider out before the resume prompt sees it', async () => {
    // given: a checkpoint whose provider no longer exists in the live catalog
    const cwd = await mkdtemp(join(tmpdir(), 'tc-init-resume-'))
    const stale = {
      version: 1 as const,
      cwd,
      updatedAt: 'now',
      vendorId: 'made-up-vendor',
      providerId: 'made-up-provider',
      channelChoice: 'slack',
    } as unknown as ReturnType<typeof checkpointFromSelections>
    const { store } = inMemoryStore(stale)

    let seen: ReturnType<typeof checkpointFromSelections> | undefined
    await collectWizardInputs(
      cwd,
      basePrompts({
        confirmResumeCheckpoint: async (checkpoint) => {
          seen = checkpoint
          return 'start-over'
        },
      }),
      { checkpointStore: store },
    )

    // then: the stale vendor/provider are pruned, the valid channel survives
    expect(seen?.vendorId).toBeUndefined()
    expect(seen?.providerId).toBeUndefined()
    expect(seen?.channelChoice).toBe('slack')
  })

  test('works without a checkpoint store (back-compat)', async () => {
    const result = await collectWizardInputs('/agent', basePrompts())
    expect(result.model).toBe(fireworksModel)
  })
})
