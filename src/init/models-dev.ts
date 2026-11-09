import type { CustomModelMeta } from '@/config'
import {
  KNOWN_PROVIDERS,
  isKnownModelRef,
  isModelRef,
  listKnownModelRefs,
  providerForModelRef,
  type KnownProviderId,
  type ModelRef,
} from '@/config/providers'

import { fetchOpenGatewayCatalog, type OpenGatewayModel } from './opengateway-catalog'

const MODELS_DEV_URL = 'https://models.dev/api.json'
const REQUEST_TIMEOUT_MS = 10_000

// models.dev keys providers by a string id that does NOT always match our
// KnownProviderId. Specifically, they ship Fireworks under `fireworks-ai`.
// This map is the single place that bridges the two namespaces; every other
// helper in this file works in OUR namespace.
// `null` means "never merge upstream models into this provider". Reserved for
// gateways whose ids are creator-qualified: models.dev lists bare ids like
// `gpt-5.5`, but OpenGateway only accepts `openai/gpt-5.5`, so merging would
// synthesize refs that pass `isModelRef()` and then 404 at request time.
const PROVIDER_TO_MODELS_DEV: Record<KnownProviderId, string | null> = {
  openai: 'openai',
  // openai-codex models live under the `openai` namespace on models.dev too
  // (Codex is a backend, not a separate provider in their taxonomy). Curated
  // entries are surfaced regardless of upstream membership.
  'openai-codex': 'openai',
  anthropic: 'anthropic',
  fireworks: 'fireworks-ai',
  zai: 'zai',
  // zai-coding (GLM Coding Plan) is a billing surface, not a separate model
  // catalog. models.dev tracks the underlying model metadata under `zai`,
  // so we route lookups there. The curated entries still get surfaced.
  'zai-coding': 'zai',
  xai: 'xai',
  minimax: 'minimax',
  deepseek: 'deepseek',
  // models.dev has listed Upstage since 2025-07-09 (solar-pro2 + solar-mini,
  // then solar-pro3 on 2026-01-13 and solar-pro4 on 2026-08-06), so this
  // mapping hits rather than misses — harmless either way, since `buildOption`
  // lets upstream fill gaps but never override the curated Solar records, and
  // those specify every field. solar-open2 is partner-program only and still
  // absent upstream, so it surfaces curated.
  upstage: 'upstage',
  moonshot: 'moonshot',
  // moonshot-coding (Kimi Code subscription) is a billing surface, not a
  // separate model catalog. models.dev tracks the underlying Kimi model
  // metadata under `moonshot`, so we route lookups there; the curated
  // `kimi-for-coding` alias is surfaced regardless of upstream membership.
  'moonshot-coding': 'moonshot',
  opengateway: null,
  // models.dev's `inception` catalog lists only Mercury 2 / 2.5 / Edit 2, which
  // are retired for new users or don't serve chat. Surface the curated
  // Mercury 3 record alone.
  inception: null,
  // models.dev has no EXAONE catalog. Surface the curated K-EXAONE 2.5 record.
  exaone: null,
}

function upstreamProviderFor(
  data: Record<string, ModelsDevProvider>,
  providerId: KnownProviderId,
): ModelsDevProvider | undefined {
  const modelsDevId = PROVIDER_TO_MODELS_DEV[providerId]
  if (modelsDevId === null) return undefined
  return data[modelsDevId]
}

export type ModelOption = {
  ref: ModelRef | string
  providerId: KnownProviderId
  providerName: string
  modelId: string
  modelName: string
  reasoning: boolean
  contextWindow: number | null
  maxTokens?: number | null
  cost?: ModelOptionCost | null
  curated: boolean
  // True iff the model accepts image input. Sourced from the curated
  // `Model.input` array (which is the source of truth — pi-ai consumes it
  // directly) with a fallback to models.dev's `modalities.input` when the
  // curated entry omits the field. The init wizard uses this to decide
  // whether to prompt for a separate `vision` profile after the user picks
  // a text-only `default` model.
  supportsVision: boolean
}

export type ModelOptionCost = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

type ModelsDevModel = {
  id?: string
  name?: string
  reasoning?: boolean
  tool_call?: boolean
  status?: string
  release_date?: string
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    cache_read?: number
    cache_write?: number
  }
}

type ModelsDevProvider = {
  id?: string
  name?: string
  models?: Record<string, ModelsDevModel>
}

export type FetchModelsResult = {
  options: ModelOption[]
  source: 'models.dev' | 'curated'
  sources: {
    modelsDev: 'live' | 'unavailable'
    openGatewayCatalog: 'live' | 'unavailable'
    openGatewayPrices: 'live' | 'unavailable'
  }
  warnings: string[]
  warning?: string
}

// Pulls live catalogs from models.dev and OpenGateway, keeps every curated
// entry, and appends non-curated models whose provider refs TypeClaw can route.
//
// Falls back to the curated list alone if the network is unreachable, the
// response is malformed, or any unexpected error fires — the wizard MUST
// stay functional offline because `typeclaw init` is the very first thing a
// user does on a fresh machine, often before networking is sorted.
export async function fetchModelOptions(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<FetchModelsResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const [modelsDev, openGateway] = await Promise.all([
    fetchModelsDev(fetchImpl, timeoutMs),
    fetchOpenGatewayCatalog({ fetchImpl, timeoutMs }),
  ])
  // Composition is inside the guard because only the models.dev ROOT is shape-
  // checked on fetch: a well-formed envelope can still carry a malformed nested
  // model, and this function's contract is that `typeclaw init` keeps working
  // on a fresh machine no matter what the network returns.
  let baseOptions: ModelOption[]
  let compositionWarning: string | undefined
  try {
    baseOptions = modelsDev.status === 'live' ? mergeWithCurated(modelsDev.data) : curatedOptions()
  } catch (error) {
    baseOptions = curatedOptions()
    compositionWarning = `models.dev returned unusable data (${error instanceof Error ? error.message : String(error)})`
  }
  const mergedOptions = mergeOpenGateway(baseOptions, openGateway.models)
  const warnings = [
    ...(modelsDev.status === 'unavailable' ? [modelsDev.warning] : []),
    ...(compositionWarning !== undefined ? [compositionWarning] : []),
    ...openGateway.warnings,
  ]
  const warning = warnings.length > 0 ? warnings.join('; ') : undefined
  return {
    options: mergedOptions,
    source: modelsDev.status === 'live' ? 'models.dev' : 'curated',
    sources: {
      modelsDev: modelsDev.status,
      openGatewayCatalog: openGateway.catalog,
      openGatewayPrices: openGateway.prices,
    },
    warnings,
    ...(warning !== undefined ? { warning } : {}),
  }
}

type ModelsDevResult =
  | { status: 'live'; data: Record<string, ModelsDevProvider> }
  | { status: 'unavailable'; warning: string }

async function fetchModelsDev(fetchImpl: typeof fetch, timeoutMs: number): Promise<ModelsDevResult> {
  try {
    const res = await fetchImpl(MODELS_DEV_URL, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) {
      return { status: 'unavailable', warning: `models.dev returned ${res.status}` }
    }
    const data: unknown = await res.json()
    if (!isRecord(data)) return { status: 'unavailable', warning: 'models.dev returned malformed JSON' }
    return { status: 'live', data: data as Record<string, ModelsDevProvider> }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { status: 'unavailable', warning: reason }
  }
}

// The curated-only path: every model in KNOWN_PROVIDERS, sorted with the
// default model first so the picker can use index-0 as `initialValue`.
export function curatedOptions(): ModelOption[] {
  const refs = listKnownModelRefs()
  return refs.map((ref) => buildOption(ref, { curated: true }))
}

export function customModelMetaFromOption(option: ModelOption): CustomModelMeta | undefined {
  if (isKnownModelRef(option.ref)) return undefined
  if (!isModelRef(option.ref)) return undefined
  return {
    name: option.modelName,
    reasoning: option.reasoning,
    input: option.supportsVision ? ['text', 'image'] : ['text'],
    ...(option.contextWindow !== null ? { contextWindow: option.contextWindow } : {}),
    ...(option.maxTokens !== undefined && option.maxTokens !== null ? { maxTokens: option.maxTokens } : {}),
    ...(option.cost !== undefined && option.cost !== null ? { cost: option.cost } : {}),
  }
}

// `data` is the parsed models.dev JSON. We keep every curated entry first
// (including provider-specific aliases models.dev does not list), then append
// live upstream models whose refs validate against a known TypeClaw provider.
function mergeWithCurated(data: Record<string, ModelsDevProvider>): ModelOption[] {
  const out: ModelOption[] = []
  const seen = new Set<string>()
  for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
    const known = KNOWN_PROVIDERS[providerId]
    const upstream = upstreamProviderFor(data, providerId)
    const upstreamModels = upstream?.models ?? {}
    for (const modelId of Object.keys(known.models)) {
      const upstreamModel = upstreamModels[modelId]
      const ref = `${providerId}/${modelId}`
      out.push(buildOption(ref, { curated: true, upstream: upstreamModel }))
      seen.add(ref)
    }
  }

  for (const providerId of Object.keys(KNOWN_PROVIDERS) as KnownProviderId[]) {
    const upstream = upstreamProviderFor(data, providerId)
    const upstreamModels = upstream?.models ?? {}
    for (const [fallbackModelId, upstreamModel] of Object.entries(upstreamModels)) {
      if (!isRecord(upstreamModel)) continue
      const modelId = upstreamModel.id ?? fallbackModelId
      if (modelId.trim().length === 0) continue
      const ref = `${providerId}/${modelId}`
      if (seen.has(ref) || !isModelRef(ref)) continue
      out.push(buildOption(ref, { curated: isKnownModelRef(ref), upstream: upstreamModel }))
      seen.add(ref)
    }
  }
  return out
}

function mergeOpenGateway(options: ModelOption[], models: OpenGatewayModel[]): ModelOption[] {
  const out = [...options]
  const seen = new Set(options.map((option) => option.ref))
  for (const model of models) {
    const ref = `opengateway/${model.id}`
    if (seen.has(ref) || !isModelRef(ref)) continue
    const sibling = nativeSiblingFor(model)
    out.push({
      ref,
      providerId: 'opengateway',
      providerName: KNOWN_PROVIDERS.opengateway.name,
      modelId: model.id,
      modelName: sibling?.name ?? model.id,
      reasoning: sibling?.reasoning ?? false,
      contextWindow: sibling?.contextWindow ?? null,
      maxTokens: sibling?.maxTokens ?? null,
      cost: model.cost,
      curated: false,
      supportsVision: model.input.includes('image'),
    })
    seen.add(ref)
  }
  return out
}

type NativeSibling = {
  name: string
  reasoning?: boolean
  contextWindow?: number
  maxTokens?: number
}

function nativeSiblingFor(model: OpenGatewayModel): NativeSibling | undefined {
  const slash = model.id.indexOf('/')
  if (slash === -1) return undefined
  const creator = model.id.slice(0, slash)
  const modelId = model.id.slice(slash + 1)
  const providerId = nativeProviderId(model.ownedBy) ?? nativeProviderId(creator)
  if (providerId === undefined) return undefined
  return (KNOWN_PROVIDERS[providerId].models as Record<string, NativeSibling>)[modelId]
}

// The gateway namespaces some creators differently from this registry's
// provider ids (`moonshotai` vs `moonshot`, `x-ai` vs `xai`, `z-ai` vs `zai`).
// Without the alias the sibling lookup misses and the model loses its
// contextWindow/maxTokens, which neither OpenGateway endpoint publishes.
function nativeProviderId(value: string): KnownProviderId | undefined {
  const aliases: Record<string, KnownProviderId> = { moonshotai: 'moonshot', 'x-ai': 'xai', 'z-ai': 'zai' }
  const candidate = aliases[value] ?? value
  if (!(candidate in KNOWN_PROVIDERS) || candidate === 'opengateway') return undefined
  return candidate as KnownProviderId
}

type BuildOptionOpts = {
  curated: boolean
  upstream?: ModelsDevModel
}

// The curated record wins every field it specifies; upstream only fills gaps.
// A known ref always resolves to the curated record at runtime — `resolveModel`
// reads `KNOWN_PROVIDERS`, never models.dev, and `customModelMetaFromOption`
// declines to persist metadata for known refs — so letting upstream win here
// only desynchronized the picker from the model it was describing. It showed in
// what `formatModelLabel`/`formatModelHint` render (name, context, reasoning):
// models.dev names solar-pro3/pro2/mini with their bare ids, so the picker
// offered "solar-pro3" where the curated record says "Solar Pro 3". maxTokens
// and cost reach no surface today, so aligning them is consistency within the
// record, not a visible fix. `supportsVision` already resolved this way (see
// `resolveInput`, and the note on `ModelOption.supportsVision`); this extends
// the rule to the rest. Refs we do not curate still take everything from
// upstream, which is the whole point of merging it in.
function buildOption(ref: ModelRef | string, opts: BuildOptionOpts): ModelOption {
  const providerId = providerForModelRef(ref)
  const modelId = ref.slice(providerId.length + 1)
  const provider = KNOWN_PROVIDERS[providerId]
  const curatedModel = (
    provider.models as Record<
      string,
      {
        name: string
        contextWindow?: number
        maxTokens?: number
        reasoning?: boolean
        input?: ReadonlyArray<string>
        cost?: ModelOptionCost
      }
    >
  )[modelId]
  const input = resolveInput(curatedModel?.input, opts.upstream?.modalities?.input)
  return {
    ref,
    providerId,
    providerName: provider.name,
    modelId,
    modelName: curatedModel?.name ?? opts.upstream?.name ?? modelId,
    reasoning: curatedModel?.reasoning ?? opts.upstream?.reasoning ?? false,
    contextWindow: curatedModel?.contextWindow ?? opts.upstream?.limit?.context ?? null,
    maxTokens: curatedModel?.maxTokens ?? opts.upstream?.limit?.output ?? null,
    cost: curatedModel?.cost ?? resolveCost(opts.upstream?.cost),
    curated: opts.curated,
    supportsVision: input.includes('image'),
  }
}

function resolveInput(
  curatedInput: ReadonlyArray<string> | undefined,
  upstreamInput: ReadonlyArray<string> | undefined,
): string[] {
  if (curatedInput !== undefined) return [...curatedInput]
  if (upstreamInput !== undefined && upstreamInput.length > 0) return [...upstreamInput]
  return ['text']
}

function resolveCost(cost: ModelsDevModel['cost']): ModelOptionCost | null {
  if (cost === undefined) return null
  return {
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cacheRead: cost.cacheRead ?? cost.cache_read ?? 0,
    cacheWrite: cost.cacheWrite ?? cost.cache_write ?? 0,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
