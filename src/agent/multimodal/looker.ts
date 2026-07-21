import { open } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'

import { z } from 'zod'

import {
  createPublicSocketLookup,
  defaultPublicHttpDependencies,
  headerValue,
  requestPublicHttpUrl,
  type PublicHttpAddress,
  type PublicHttpDependencies,
  type PublicHttpRequestOptions,
  type PublicHttpResponse,
} from '@/agent/network/safe-http'
import { processResourceBudget, type ResourceLease, type WeightedResourceBudget } from '@/agent/resource-budget'
import { config, DEFAULT_MODEL_TOOL_LIMITS } from '@/config'

const SUPPORTED_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
} as const

// Caps on URL-fetched images. The agent chooses URLs autonomously, so a
// malicious or accidentally-large response could otherwise hang the tool
// (no timeout) or fill memory (no size cap). 20 MB is well above any
// reasonable screenshot/photo and well below container memory budgets;
// 30 s is generous for a single HTTP image fetch over a slow link.
export const URL_FETCH_TIMEOUT_MS = 30_000
export const DEFAULT_LOOK_AT_IMAGE_MAX_BYTES = DEFAULT_MODEL_TOOL_LIMITS.lookAtImageMaxBytes
export const DEFAULT_LOOK_AT_MAX_IMAGES = DEFAULT_MODEL_TOOL_LIMITS.lookAtMaxImages
export const DEFAULT_LOOK_AT_TOTAL_MAX_BYTES = DEFAULT_MODEL_TOOL_LIMITS.lookAtTotalMaxBytes
export const LOOK_AT_MAX_CONCURRENCY = 4
export const LOOK_AT_MAX_REDIRECTS = 5

type Mime = (typeof SUPPORTED_MIME_TYPES)[keyof typeof SUPPORTED_MIME_TYPES]

export type ImageInput =
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'base64'; data: string; mimeType: string }

export const imageInputSchema = z.union([
  z.object({ kind: z.literal('url'), url: z.string().url() }),
  z.object({ kind: z.literal('file'), path: z.string().min(1) }),
  z.object({ kind: z.literal('base64'), data: z.string().min(1), mimeType: z.string().min(1) }),
])

export const multimodalLookerPayloadSchema = z.object({
  images: z.array(imageInputSchema).min(1),
  prompt: z.string().min(1).optional(),
})

export type MultimodalLookerPayload = z.infer<typeof multimodalLookerPayloadSchema>

// System prompt is built per-invocation so the agent sees the exact task. With
// `prompt`: focused Q&A. Without: open-ended description. Tone the same in
// both branches so callers can plug either form into the same downstream
// pipeline (the look_at tool just relays the resulting text).
export function buildMultimodalLookerSystemPrompt(prompt: string | undefined): string {
  const base =
    'You are a multimodal vision subagent. The user message contains one or more images attached to a short instruction.'
  if (prompt !== undefined && prompt.trim() !== '') {
    return [
      base,
      '',
      'Your job is to ANSWER the question below using ONLY what is visible in the attached image(s). Be precise, concrete, and faithful to the visual content. If the image does not contain enough information to answer, say so explicitly.',
      '',
      `Question: ${prompt.trim()}`,
      '',
      'Reply with the answer directly. No preamble, no acknowledgement of the task, no markdown headings.',
    ].join('\n')
  }
  return [
    base,
    '',
    "Your job is to DESCRIBE the attached image(s) faithfully and in detail. Cover: subject(s), composition, colors, text content (transcribed verbatim if legible), notable visual details, and anything that would help a downstream reader who cannot see the image. Do not speculate beyond what's visible.",
    '',
    'Reply with the description directly. No preamble, no markdown headings, no bullet list unless multiple images.',
  ].join('\n')
}

export type ResolvedImage = {
  data: string
  mimeType: string
}

export type LookAtAddress = PublicHttpAddress
export type LookAtRequestOptions = PublicHttpRequestOptions
export type LookAtHttpResponse = PublicHttpResponse
export type LookAtNetworkDependencies = PublicHttpDependencies

type ImageByteBudget = {
  consume(bytes: number): void
}

export type LookAtResourceLimits = {
  maxImageBytes: number
  maxAggregateBytes: number
  maxImages: number
}

export type LookAtResolutionOptions = {
  resourceBudget?: WeightedResourceBudget
  retainResultBudget?: boolean
}

const resolvedImageLeases = new WeakMap<ResolvedImage[], ResourceLease[]>()

const configuredLookAtLimits: LookAtResourceLimits = {
  maxImageBytes: config.modelTools.limits.lookAtImageMaxBytes,
  maxAggregateBytes: config.modelTools.limits.lookAtTotalMaxBytes,
  maxImages: config.modelTools.limits.lookAtMaxImages,
}

export async function resolveImagesBounded(
  inputs: ImageInput[],
  signal?: AbortSignal,
  network: LookAtNetworkDependencies = defaultLookAtNetwork,
  limits: LookAtResourceLimits = configuredLookAtLimits,
  options: LookAtResolutionOptions = {},
): Promise<ResolvedImage[]> {
  if (inputs.length > limits.maxImages) {
    throw new Error(`look_at: image count exceeds limit (${inputs.length} > ${limits.maxImages})`)
  }
  let consumed = 0
  const budget: ImageByteBudget = {
    consume(bytes) {
      consumed += bytes
      if (consumed > limits.maxAggregateBytes) {
        throw new Error(`look_at: images exceed aggregate byte limit (${consumed} > ${limits.maxAggregateBytes})`)
      }
    },
  }
  const results = Array.from<ResolvedImage>({ length: inputs.length })
  const siblingController = new AbortController()
  const workerSignal =
    signal === undefined ? siblingController.signal : AbortSignal.any([signal, siblingController.signal])
  let next = 0
  let firstError: unknown
  let failed = false
  const leases: ResourceLease[] = []
  const worker = async (): Promise<void> => {
    try {
      while (next < inputs.length) {
        const index = next++
        const resolved = await resolveImageBudgeted(
          inputs[index] as ImageInput,
          workerSignal,
          budget,
          network,
          limits.maxImageBytes,
          options.resourceBudget ?? processResourceBudget,
        )
        results[index] = resolved.image
        leases.push(resolved.lease)
      }
    } catch (error) {
      if (!failed) firstError = error
      failed = true
      siblingController.abort(error)
      throw error
    }
  }
  await Promise.allSettled(Array.from({ length: Math.min(inputs.length, LOOK_AT_MAX_CONCURRENCY) }, worker))
  if (failed) {
    for (const lease of leases) lease.release()
    throw firstError
  }
  if (options.retainResultBudget === true) resolvedImageLeases.set(results, leases)
  else for (const lease of leases) lease.release()
  return results
}

export function releaseResolvedImages(images: ResolvedImage[]): void {
  const leases = resolvedImageLeases.get(images)
  if (leases === undefined) return
  resolvedImageLeases.delete(images)
  for (const lease of leases) lease.release()
}

// Materializes an ImageInput into the base64-encoded form pi-ai expects.
// - `url`: passthrough; pi-ai's image content does not accept URLs, so we fetch
//   the bytes and base64-encode here (lazy; only when the tool is invoked).
// - `file`: read from disk, infer MIME from extension. Path must be absolute or
//   resolvable against the caller's cwd (callers should normalize ahead of
//   time; this function rejects relative paths to avoid ambiguity).
// - `base64`: passthrough.
export async function resolveImage(
  input: ImageInput,
  signal?: AbortSignal,
  aggregateBudget?: ImageByteBudget,
  network: LookAtNetworkDependencies = defaultLookAtNetwork,
  maxImageBytes: number = configuredLookAtLimits.maxImageBytes,
): Promise<ResolvedImage> {
  const resolved = await resolveImageBudgeted(
    input,
    signal,
    aggregateBudget,
    network,
    maxImageBytes,
    processResourceBudget,
  )
  resolved.lease.release()
  return resolved.image
}

async function resolveImageBudgeted(
  input: ImageInput,
  signal: AbortSignal | undefined,
  aggregateBudget: ImageByteBudget | undefined,
  network: LookAtNetworkDependencies,
  maxImageBytes: number,
  resourceBudget: WeightedResourceBudget,
): Promise<{ image: ResolvedImage; lease: ResourceLease }> {
  if (input.kind === 'base64') {
    if (!input.mimeType.startsWith('image/')) {
      throw new Error(`look_at: base64 mimeType must be image/* (got "${input.mimeType}")`)
    }
    const decodedBytes = decodedBase64Size(input.data, maxImageBytes)
    if (decodedBytes > maxImageBytes) {
      throw new Error(`look_at: base64 image too large (${decodedBytes} bytes > ${maxImageBytes} cap)`)
    }
    aggregateBudget?.consume(decodedBytes)
    const lease = await resourceBudget.acquire({ memoryBytes: input.data.length * 2 }, signal)
    return { image: { data: input.data, mimeType: input.mimeType }, lease }
  }
  if (input.kind === 'file') {
    if (!isAbsolute(input.path)) {
      throw new Error(`look_at: file path must be absolute (got "${input.path}")`)
    }
    const ext = extname(input.path).toLowerCase() as keyof typeof SUPPORTED_MIME_TYPES
    const mimeType = (SUPPORTED_MIME_TYPES[ext] ?? null) as Mime | null
    if (mimeType === null) {
      throw new Error(
        `look_at: unsupported image extension "${ext}" for ${input.path} (supported: ${Object.keys(SUPPORTED_MIME_TYPES).join(', ')})`,
      )
    }
    const handle = await open(input.path, 'r').catch(() => {
      throw new Error(`look_at: file not found at ${input.path}`)
    })
    try {
      const size = (await handle.stat()).size
      if (size > maxImageBytes) {
        throw new Error(`look_at: file too large (${size} bytes > ${maxImageBytes} cap)`)
      }
      aggregateBudget?.consume(size)
      const encodedBytes = encodedBase64Length(size)
      const lease = await resourceBudget.acquire({ memoryBytes: size + 1 + encodedBytes * 2 }, signal)
      const bytes = Buffer.alloc(size + 1)
      try {
        let offset = 0
        while (offset < bytes.byteLength) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, null)
          if (bytesRead === 0) break
          offset += bytesRead
        }
        const finalSize = (await handle.stat()).size
        if (offset !== size || finalSize !== size) {
          throw new Error(`look_at: file changed while being read: ${input.path}`)
        }
        const data = bytes.subarray(0, offset).toString('base64')
        if (!lease.tryResize({ memoryBytes: data.length * 2 })) {
          throw lookAtMemoryBudgetExceeded(data.length * 2)
        }
        return { image: { data, mimeType }, lease }
      } catch (error) {
        lease.release()
        throw error
      }
    } finally {
      await handle.close()
    }
  }
  // URL branch: independent timeout + size cap on top of any caller-provided
  // signal. The two abort signals are merged so the tool's overall abort wins
  // over our timeout AND vice versa.
  const timeoutSignal = AbortSignal.timeout(URL_FETCH_TIMEOUT_MS)
  const mergedSignal = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const requested = await requestPublicHttpUrl(input.url, {
    signal: mergedSignal,
    headers: { Accept: 'image/*' },
    maxRedirects: LOOK_AT_MAX_REDIRECTS,
    dependencies: network,
  })
  const { response: res, finalUrl } = requested
  const declared = Number(headerValue(res.headers, 'content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxImageBytes) {
    res.cancel()
    throw new Error(`look_at: ${input.url} response too large (${declared} bytes > ${maxImageBytes} cap)`)
  }
  const reservedRaw = Number.isFinite(declared) && declared > 0 ? declared : 0
  const lease = await resourceBudget.acquire({ memoryBytes: reservedRaw }, mergedSignal).catch((error) => {
    res.cancel()
    throw error
  })
  try {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`look_at: failed to fetch ${finalUrl}: HTTP ${res.statusCode}`)
    }
    const mimeType = headerValue(res.headers, 'content-type')?.split(';')[0]?.trim() ?? 'application/octet-stream'
    if (!mimeType.startsWith('image/')) {
      throw new Error(`look_at: ${input.url} did not return an image content-type (got "${mimeType}")`)
    }
    // Streaming size check: arrayBuffer() would read the whole body before we
    // could enforce a cap. Read chunk-by-chunk and abort once we cross the
    // limit. Content-Length is checked first when present, but absent or lying
    // headers fall through to the streaming check.
    const chunks: Uint8Array[] = []
    let total = 0
    for await (const value of res.body) {
      total += value.byteLength
      if (total > maxImageBytes) {
        throw new Error(`look_at: ${input.url} response exceeded ${maxImageBytes}-byte cap`)
      }
      const retainedRaw = Math.max(total, reservedRaw)
      if (!lease.tryResize({ memoryBytes: retainedRaw })) throw lookAtMemoryBudgetExceeded(retainedRaw)
      aggregateBudget?.consume(value.byteLength)
      chunks.push(value)
    }
    if (!lease.tryResize({ memoryBytes: total * 2 })) throw lookAtMemoryBudgetExceeded(total * 2)
    const buf = Buffer.concat(chunks)
    chunks.length = 0
    const encodedBytes = encodedBase64Length(total)
    if (!lease.tryResize({ memoryBytes: total + encodedBytes * 2 })) {
      throw lookAtMemoryBudgetExceeded(total + encodedBytes * 2)
    }
    const data = buf.toString('base64')
    if (!lease.tryResize({ memoryBytes: data.length * 2 })) {
      throw lookAtMemoryBudgetExceeded(data.length * 2)
    }
    return { image: { data, mimeType }, lease }
  } catch (error) {
    lease.release()
    throw error
  } finally {
    res.cancel()
  }
}

function encodedBase64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

function lookAtMemoryBudgetExceeded(bytes: number): Error {
  return new Error(`look_at: images exceed the process-wide memory budget (${bytes} weighted bytes requested)`)
}

const defaultLookAtNetwork = defaultPublicHttpDependencies

export { createPublicSocketLookup }

function decodedBase64Size(data: string, maxImageBytes: number): number {
  if (data.length > Math.ceil(maxImageBytes / 3) * 4) {
    throw new Error(`look_at: base64 image too large (encoded length exceeds ${maxImageBytes}-byte cap)`)
  }
  if (data.length % 4 !== 0 || !/^[A-Za-z\d+/]*={0,2}$/.test(data)) {
    throw new Error('look_at: invalid base64 image data')
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return (data.length / 4) * 3 - padding
}
