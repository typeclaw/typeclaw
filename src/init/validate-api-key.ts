import { effectiveBaseUrl } from '@/agent/model-overrides'
import { KNOWN_PROVIDERS, type KnownProviderId } from '@/config/providers'

// `successShape` is what a 200 must look like to count as a validated key.
// Default `models-list` requires `{ data: [...] }`, which every /v1/models probe
// below returns. `json-object` is the weaker check for probes that answer with a
// bare object instead of a list — it still rejects the captive-portal HTML case
// that motivated shape-checking in the first place.
type ProbeSuccessShape = 'models-list' | 'json-object'

type Probe = {
  url: string
  authHeader: 'bearer' | 'x-api-key'
  successShape?: ProbeSuccessShape
}

const PROVIDER_PROBE: Partial<Record<KnownProviderId, Probe>> = {
  openai: { url: 'https://api.openai.com/v1/models', authHeader: 'bearer' },
  anthropic: { url: 'https://api.anthropic.com/v1/models', authHeader: 'x-api-key' },
  fireworks: { url: 'https://api.fireworks.ai/inference/v1/models', authHeader: 'bearer' },
  zai: { url: 'https://api.z.ai/api/paas/v4/models', authHeader: 'bearer' },
  'zai-coding': { url: 'https://api.z.ai/api/coding/paas/v4/models', authHeader: 'bearer' },
  xai: { url: 'https://api.x.ai/v1/models', authHeader: 'bearer' },
  minimax: { url: 'https://api.minimax.io/v1/models', authHeader: 'bearer' },
  deepseek: { url: 'https://api.deepseek.com/models', authHeader: 'bearer' },
  upstage: { url: 'https://api.upstage.ai/v1/models', authHeader: 'bearer' },
  moonshot: { url: 'https://api.moonshot.ai/v1/models', authHeader: 'bearer' },
  'moonshot-coding': { url: 'https://api.kimi.com/coding/v1/models', authHeader: 'bearer' },
  // NOT /v1/models: OpenGateway serves its catalog PUBLICLY (verified — HTTP 200
  // with `{data:[...]}` for a missing key and for a garbage key), so probing it
  // would hand back `ok` for any string the user pastes. That is worse than no
  // validation, because init would vouch for a key that cannot complete a single
  // request. /v1/me is the cheapest endpoint that actually 401s on a bad key.
  opengateway: { url: 'https://apis.opengateway.ai/v1/me', authHeader: 'bearer', successShape: 'json-object' },
  // inception has no probe: its /v1/models is public and returns 200 for any
  // key, so probing it would vouch for garbage.
  // exaone has no probe: the platform documents only /v1/chat/completions, and an
  // undocumented /v1/models could reject a valid key.
}

// When a base-URL override (ANTHROPIC_BASE_URL / OPENAI_BASE_URL) points at a
// proxy, probe THAT endpoint — validating against the public API would test the
// wrong gateway (and may reject a proxy-only credential). The path suffix is
// whatever the hardcoded default probe URL adds on top of the provider's
// default baseUrl, so providers with different version-segment conventions
// (anthropic baseUrl omits `/v1`, openai includes it) each keep their own path.
function probeUrlFor(providerId: KnownProviderId, defaultUrl: string): string {
  const defaultBase = KNOWN_PROVIDERS[providerId].baseUrl
  const base = effectiveBaseUrl(providerId, defaultBase)
  if (base === undefined) return defaultUrl
  return `${base}${defaultUrl.slice(defaultBase.length)}`
}

export type KeyValidationResult =
  | { kind: 'ok' }
  | { kind: 'skipped'; reason: 'no-probe' | 'network-error'; detail?: string }
  | { kind: 'rejected'; status: number }

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>

const TIMEOUT_MS = 5_000

export async function validateApiKey(
  providerId: KnownProviderId,
  key: string,
  fetchImpl: FetchFn = fetch,
): Promise<KeyValidationResult> {
  const probe = PROVIDER_PROBE[providerId]
  if (!probe) return { kind: 'skipped', reason: 'no-probe' }
  const provider = KNOWN_PROVIDERS[providerId]
  if (!provider) return { kind: 'skipped', reason: 'no-probe' }

  const headers: Record<string, string> = {}
  if (probe.authHeader === 'bearer') {
    headers.Authorization = `Bearer ${key}`
  } else {
    headers['x-api-key'] = key
    headers['anthropic-version'] = '2023-06-01'
  }

  try {
    const res = await fetchImpl(probeUrlFor(providerId, probe.url), {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Probe URLs are hardcoded, but the provider could 3xx the response
      // mid-flight (CDN, regional bounce, captive portal). Auto-following
      // would send the credential to whatever Location said. Treat redirects
      // as "couldn't verify" instead.
      redirect: 'manual',
    })
    if (res.status >= 300 && res.status < 400) {
      return { kind: 'skipped', reason: 'network-error', detail: `HTTP ${res.status}` }
    }
    if (res.ok) {
      // A captive portal / WAF / corporate-MITM proxy can return HTTP 200
      // with an HTML login page in front of an unauthenticated request.
      // Treat the response as "ok" only if it parses as the expected
      // JSON shape (`{ data: [...] }` for /v1/models on every probed
      // provider).
      const shapeOk = await hasExpectedShape(res, probe.successShape ?? 'models-list')
      if (shapeOk) return { kind: 'ok' }
      return { kind: 'skipped', reason: 'network-error', detail: 'unexpected response shape' }
    }
    if (res.status === 401 || res.status === 403) {
      // Fireworks issues two key classes that probe the same /v1/models
      // endpoint differently:
      //   * Standard keys (fw_...)  → 200 with the models list
      //   * Fire Pass keys (fpk_...) → 403 with {"error":{"code":"FORBIDDEN",
      //     "message":"Fire Pass API keys are not authorized for this route."}}
      // The 403 *proves* authentication succeeded — the route is just out of
      // scope for the key. Fire Pass keys do work at chat-completions, which
      // is exactly the surface typeclaw needs (the only Fireworks model wired
      // here is the Fire Pass router `kimi-k2p6-turbo`). Treating that 403
      // as `rejected` is the bug; recognize the marker and accept the key.
      // Genuinely bad keys still come back as 401 UNAUTHORIZED, untouched.
      if (providerId === 'fireworks' && res.status === 403) {
        const body = await readCapped(res, MAX_BODY_BYTES)
        if (body !== null && isFireworksFirePassForbidden(body)) {
          return { kind: 'ok' }
        }
      }
      return { kind: 'rejected', status: res.status }
    }
    return { kind: 'skipped', reason: 'network-error', detail: `HTTP ${res.status}` }
  } catch (err) {
    return {
      kind: 'skipped',
      reason: 'network-error',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

const MAX_BODY_BYTES = 4096

function isFireworksFirePassForbidden(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } }
    const err = parsed.error
    if (!err || typeof err !== 'object') return false
    if (err.code === 'FORBIDDEN' && typeof err.message === 'string' && err.message.includes('Fire Pass')) {
      return true
    }
    return false
  } catch {
    return false
  }
}

async function hasExpectedShape(res: Response, shape: ProbeSuccessShape): Promise<boolean> {
  const text = await readCapped(res, MAX_BODY_BYTES)
  if (text === null) return false
  try {
    const parsed = JSON.parse(text) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    if (shape === 'json-object') return true
    return Array.isArray((parsed as { data?: unknown }).data)
  } catch {
    return false
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return null
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  let read = 0
  try {
    while (read < maxBytes) {
      const { value, done } = await reader.read()
      if (done) break
      read += value.byteLength
      out += decoder.decode(value, { stream: true })
      if (read >= maxBytes) break
    }
    out += decoder.decode()
    return out
  } catch {
    return null
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export const API_KEY_DASHBOARD_URL: Partial<Record<KnownProviderId, string>> = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  fireworks: 'https://fireworks.ai/account/api-keys',
  zai: 'https://docs.z.ai/devpack/tool/claude#api-key',
  'zai-coding': 'https://docs.z.ai/devpack/tool/claude#api-key',
  xai: 'https://console.x.ai',
  minimax: 'https://platform.minimax.io/user-center/basic-information/interface-key',
  deepseek: 'https://platform.deepseek.com/api_keys',
  upstage: 'https://console.upstage.ai/api-keys',
  moonshot: 'https://platform.moonshot.ai/console/api-keys',
  'moonshot-coding': 'https://www.kimi.com/code/console',
  opengateway: 'https://opengateway.ai/docs/reference/guides/authentication',
  inception: 'https://platform.inceptionlabs.ai',
  // The overview page hosts the "Get an API Key" entry point; there is no
  // separate console host.
  exaone: 'https://docs.exaone.ai/en/docs/overview',
}

// MiniMax sells the same `minimax` provider under two billing surfaces that
// each hand out a key on a DIFFERENT dashboard page: pay-as-you-go API keys
// (the API_KEY_DASHBOARD_URL above) and Token Plan "Subscription Keys"
// (sk-cp-…, this URL). Both keys are Bearer tokens for the same api.minimax.io
// endpoint and store in the same MINIMAX_API_KEY slot — the runtime doesn't
// care which. The init wizard surfaces the choice only to deep-link the
// correct dashboard, so a Token Plan subscriber isn't sent to the paygo page.
export const MINIMAX_TOKEN_PLAN_DASHBOARD_URL = 'https://platform.minimax.io/user-center/payment/token-plan'

export function providersWithApiKeyProbe(): KnownProviderId[] {
  return Object.keys(PROVIDER_PROBE) as KnownProviderId[]
}
