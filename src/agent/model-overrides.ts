import type { Api, Model } from '@earendil-works/pi-ai'

import { providerForModelRef, type KnownModelRef, type KnownProviderId, type ModelRef } from '@/config/providers'

// Providers whose base URL can be swapped to an upstream-compatible gateway at
// runtime. Each env var mirrors the upstream SDK's own name so a credential /
// endpoint pair that works with the official CLI carries over:
//   * ANTHROPIC_BASE_URL — native Anthropic Messages protocol (`/v1/messages`,
//     `x-api-key` / OAuth Bearer). NOT raw AWS Bedrock (SigV4, different
//     transport) — that needs a distinct transport, not a base-URL swap.
//   * OPENAI_BASE_URL — OpenAI-compatible endpoints (LiteLLM, Azure-style
//     gateways, corporate proxies) speaking the same request shape as
//     api.openai.com. Targets the `openai` provider only; `openai-codex` is
//     an OAuth-only ChatGPT backend, not an API-key endpoint, so it is out of
//     scope here.
export const PROVIDER_BASE_URL_ENV = {
  anthropic: 'ANTHROPIC_BASE_URL',
  openai: 'OPENAI_BASE_URL',
} as const satisfies Partial<Record<KnownProviderId, string>>

type OverridableProviderId = keyof typeof PROVIDER_BASE_URL_ENV

// Separate from `resolveModel` so resolution stays a pure table lookup; this
// is the per-process "prepare the model" seam run just before pi-coding-agent
// receives it. Clones because the `KNOWN_PROVIDERS` literals are shared static
// data that must never be mutated.
export function applyModelRuntimeOverrides<TApi extends Api>(
  model: Model<TApi>,
  ref: KnownModelRef | ModelRef | string,
  env: NodeJS.ProcessEnv = process.env,
): Model<TApi> {
  const providerId = providerForModelRef(ref)
  if (!isOverridable(providerId)) return model

  const baseUrl = normalizeBaseUrl(PROVIDER_BASE_URL_ENV[providerId], env[PROVIDER_BASE_URL_ENV[providerId]])
  if (baseUrl === undefined) return model

  return { ...model, baseUrl }
}

// Resolves the effective base URL for a provider, falling back to the provider
// default when the override is unset. Returns `undefined` for providers without
// a base-URL override so callers can keep their hardcoded probe URL. Used by
// callers outside the session path (e.g. the init-time API-key probe) that need
// to hit the same endpoint the runtime will use.
export function effectiveBaseUrl(
  providerId: KnownProviderId,
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!isOverridable(providerId)) return undefined
  const envVar = PROVIDER_BASE_URL_ENV[providerId]
  return normalizeBaseUrl(envVar, env[envVar]) ?? fallback
}

function isOverridable(providerId: KnownProviderId): providerId is OverridableProviderId {
  return providerId in PROVIDER_BASE_URL_ENV
}

// `undefined` for unset/blank (caller keeps the default); throws on a value
// that isn't a parseable http(s) URL so a typo fails loudly at boot rather
// than silently falling back to the public API with the wrong credential.
function normalizeBaseUrl(envVar: string, value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === '') return undefined

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`${envVar} is not a valid URL: ${trimmed}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${envVar} must use http:// or https://, got: ${trimmed}`)
  }
  return url.toString().replace(/\/+$/, '')
}
