import { join } from 'node:path'

import { ModelRuntime } from '@earendil-works/pi-coding-agent'

import { getConfig, resolveModel } from '@/config'
import {
  KNOWN_PROVIDERS,
  providerForModelRef,
  supportsApiKey,
  supportsOAuth,
  type KnownProviderId,
} from '@/config/providers'
import { createSecretsStoreForAgent } from '@/secrets'

export type ProviderAuth = { modelRuntime: ModelRuntime }
type RuntimeProviderConfig = Parameters<ModelRuntime['registerProvider']>[1]

const TEST_DUMMY_API_KEY = 'test_dummy_key'

function secretsJsonPath(): string {
  return join(process.cwd(), 'secrets.json')
}

// Cache the in-flight Promise: concurrent sessions for a provider share one
// runtime and one credential store instead of racing OAuth refresh/setup.
const cached = new Map<KnownProviderId, Promise<ProviderAuth>>()

export function getAuthFor(providerId: KnownProviderId): Promise<ProviderAuth> {
  const existing = cached.get(providerId)
  if (existing) return existing
  const created: Promise<ProviderAuth> = createProviderAuth(providerId).catch((error) => {
    // Evict only this attempt: after a reload, a newer creation may own the key.
    if (cached.get(providerId) === created) cached.delete(providerId)
    throw error
  })
  cached.set(providerId, created)
  return created
}

async function createProviderAuth(providerId: KnownProviderId): Promise<ProviderAuth> {
  const provider = KNOWN_PROVIDERS[providerId]
  const credentials = createSecretsStoreForAgent(secretsJsonPath())
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  })

  // A session can switch to any configured fallback model. Register every
  // curated provider, including built-ins: extension models replace the
  // provider catalog, and composeModelProvider dispatches each passed model
  // by its own api/baseUrl when its transport differs from the built-in.
  for (const knownProvider of Object.values(KNOWN_PROVIDERS)) {
    modelRuntime.registerProvider(knownProvider.id, toRuntimeProviderConfig(knownProvider))
  }

  const oauthProviders = new Set(
    (await credentials.list())
      .filter((credential) => credential.type === 'oauth')
      .map((credential) => credential.providerId),
  )
  for (const knownProvider of Object.values(KNOWN_PROVIDERS)) {
    if (!supportsApiKey(knownProvider) || !knownProvider.apiKeyEnv) continue
    const envKey = process.env[knownProvider.apiKeyEnv]
    // Runtime keys are memory-only. A persisted OAuth credential wins for
    // dual-auth providers and env values never leak into the v2 envelope.
    if (envKey && !oauthProviders.has(knownProvider.id)) {
      await modelRuntime.setRuntimeApiKey(knownProvider.id, envKey)
    }
  }

  if (process.env.NODE_ENV === 'test' && !hasAnyCredentialInEnv(provider.apiKeyEnv)) {
    if (supportsApiKey(provider)) await modelRuntime.setRuntimeApiKey(provider.id, TEST_DUMMY_API_KEY)
    return { modelRuntime }
  }
  // checkAuth deliberately does not refresh OAuth. Boot must only reject a
  // missing credential; a transient refresh failure belongs to the request
  // path where pi can retry it on the next turn.
  if (!(await modelRuntime.checkAuth(provider.id))) {
    console.error(missingCredentialMessage(providerId))
    process.exit(1)
  }
  return { modelRuntime }
}

function toRuntimeProviderConfig(provider: (typeof KNOWN_PROVIDERS)[KnownProviderId]): RuntimeProviderConfig {
  return {
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: Object.values(provider.models)[0]?.api,
    models: Object.values(provider.models) as RuntimeProviderConfig['models'],
  }
}

export function invalidateProviderAuthCache(): void {
  cached.clear()
}

function hasAnyCredentialInEnv(apiKeyEnv: string | null): boolean {
  return apiKeyEnv !== null && process.env[apiKeyEnv] !== undefined && process.env[apiKeyEnv] !== ''
}

function missingCredentialMessage(providerId: KnownProviderId): string {
  const provider = KNOWN_PROVIDERS[providerId]
  const defaultRef = getConfig().models.default.refs[0]!
  const defaultProviderId = providerForModelRef(defaultRef)
  const isDefault = defaultProviderId === providerId
  const modelName = isDefault ? resolveModel(defaultRef).name : null
  const oauthOnly = supportsOAuth(provider) && !supportsApiKey(provider)
  const apiKeyOnly = supportsApiKey(provider) && !supportsOAuth(provider)

  if (oauthOnly) {
    return modelName
      ? `No credentials for ${provider.name}. Run \`typeclaw init\` and pick "OAuth" to log in to ${modelName}.`
      : `No credentials for ${provider.name} (referenced by a non-default profile). Run \`typeclaw init\` and pick "OAuth" to log in.`
  }
  if (apiKeyOnly && provider.apiKeyEnv) {
    return modelName
      ? `Run \`typeclaw init\` to add an API key for ${modelName} via ${provider.name} (stored in secrets.json#providers.${provider.id}.key.value; ${provider.apiKeyEnv} in .env also works for override).`
      : `Run \`typeclaw init\` to add an API key for ${provider.name} (referenced by a non-default profile; stored in secrets.json#providers.${provider.id}.key.value; ${provider.apiKeyEnv} in .env also works for override).`
  }
  return `No credentials for ${provider.name}. Run \`typeclaw init\` to add an API key (stored in secrets.json) or pick "OAuth".`
}
