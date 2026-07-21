import { join } from 'node:path'

import { Type } from '@mariozechner/pi-ai'
import type { ImageContent } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import { createSessionWithDispose, type SessionOrigin } from '@/agent'
import { readResponseBodyBounded } from '@/agent/network/response-body'
import type { ChannelRouter } from '@/channels/router'
import type { AdapterId } from '@/channels/schema'
import type { FetchAttachmentBudget } from '@/channels/types'
import { config, getConfig, resolveModel, resolveProfile } from '@/config'
import { providerForModelRef } from '@/config/providers'
import type { PermissionService } from '@/permissions'
import { LLM_FETCH_OBSERVER_TIMEOUTS, type LlmFetchObservedRequestInit } from '@/run/llm-fetch-observer'
import { SecretsBackend } from '@/secrets'

import { promptWithSameRefRetryOnly } from '../retry-same-ref'
import {
  buildMultimodalLookerSystemPrompt,
  releaseResolvedImages,
  resolveImagesBounded,
  type ImageInput,
} from './looker'

type ImageParam = { url: string } | { path: string } | { data: string; mimeType: string }

type LookAtArgs = {
  images: ImageParam[]
  prompt?: string
}

type LookAtDetails = {
  count: number
  prompt?: string
  text?: string
  error?: string
}

export type ChannelLookAtOrigin = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
}

export async function withBudgetedAttachmentBase64<T>(
  buffer: Buffer,
  budget: FetchAttachmentBudget,
  consume: (data: string) => Promise<T>,
): Promise<T> {
  try {
    const encodedBytes = Math.ceil(buffer.byteLength / 3) * 4
    const estimatedRetainedBytes = buffer.byteLength + encodedBytes * 2
    if (!budget.tryResize(estimatedRetainedBytes)) {
      throw new Error('channel image exceeds the process-wide memory budget')
    }
    const data = buffer.toString('base64')
    const retainedBytes = buffer.byteLength + data.length * 2
    if (!budget.tryResize(retainedBytes)) {
      throw new Error('channel image exceeds the process-wide memory budget')
    }
    return await consume(data)
  } finally {
    budget.release()
  }
}

// Routes an image-bearing turn to a vision-capable subagent so the main
// session never sees the bytes. Saves main-agent context: when `models.default`
// is text-only, this is the only way to get vision; when `models.default` IS
// vision-capable, it still buys cheaper main-agent inference because the
// image payload (which can be many KB after base64) only enters the vision
// model's context.
//
// Output is the subagent's text response. The subagent itself decides whether
// to answer the user's question (when `prompt` is supplied) or describe the
// image (when `prompt` is omitted) via its dynamic system prompt.
export function createLookAtTool(permissions?: PermissionService) {
  return defineTool({
    name: 'look_at',
    label: 'Look at images',
    description:
      'Route image(s) through a vision-capable subagent and get a text result. ' +
      'Use this when you need to see an image: a screenshot the user shared, a diagram in a doc, a photo, a chart, etc. ' +
      'Each image is specified by ONE of `url` (https://...), `path` (absolute filesystem path), or `data`+`mimeType` (base64). ' +
      'The optional `prompt` is a question to ask about the image(s); without it, the subagent returns a faithful description. ' +
      'The image bytes never enter your context — only the resulting text comes back.',
    parameters: Type.Object({
      images: Type.Array(
        Type.Object({
          url: Type.Optional(Type.String({ description: 'https:// URL to fetch the image from.' })),
          path: Type.Optional(
            Type.String({ description: 'Absolute filesystem path (inside /agent or a mounted dir).' }),
          ),
          data: Type.Optional(Type.String({ description: 'Base64-encoded image bytes (pair with mimeType).' })),
          mimeType: Type.Optional(Type.String({ description: 'MIME type when using `data` (e.g. "image/png").' })),
        }),
        {
          minItems: 1,
          maxItems: config.modelTools.limits.lookAtMaxImages,
          description: 'One or more images to look at.',
        },
      ),
      prompt: Type.Optional(
        Type.String({
          description:
            'Optional question to ask about the image(s). When omitted, the subagent returns a faithful description.',
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const args = params as LookAtArgs
      try {
        const imageInputs = args.images.map(toImageInput)
        const resolved = await resolveImagesBounded(imageInputs, signal, undefined, undefined, {
          retainResultBudget: true,
        })
        try {
          const imageContents: ImageContent[] = resolved.map((r) => toImageContent(r.data, r.mimeType))
          return await runLookAtImages(imageContents, args.prompt, permissions)
        } finally {
          releaseResolvedImages(resolved)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return errorResult(message, { count: args.images.length, prompt: args.prompt })
      }
    },
  })
}

export const lookAtTool = createLookAtTool()

// Channel attachments intentionally use a separate tool instead of adding
// channel-only dependencies to the global look_at implementation. This keeps
// non-channel sessions' image source validation unchanged while channel
// sessions get router-validated attachment_id lookup.
export function createChannelLookAtTool(
  router: ChannelRouter,
  origin: ChannelLookAtOrigin,
  permissions?: PermissionService,
) {
  return defineTool({
    name: 'look_at_channel_attachment',
    label: 'Look at channel attachment',
    description:
      'View an image attached to a channel message. Inbound messages show ' +
      '`[<Platform> attachment #N: <kind> <metadata>]`; pass `N` as `attachment_id`. Do not invent ids. ' +
      'Images on the CURRENT inbound resolve directly; for one from an EARLIER message, call channel_history ' +
      'first to make it resolvable by the same id.',
    parameters: Type.Object({
      attachment_id: Type.Integer({
        description: 'The number N from the inbound `[<Platform> attachment #N: ...]` placeholder.',
        minimum: 1,
      }),
      prompt: Type.Optional(
        Type.String({ description: 'Optional question to ask about the image; omitted means describe it.' }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const found = router.lookupInboundAttachment({ ...origin, id: params.attachment_id })
      if (found === null) {
        const validIds = router.listInboundAttachmentIds(origin)
        const validMsg =
          validIds.length === 0
            ? 'no attachments are resolvable right now'
            : `resolvable attachment_ids: ${validIds.join(', ')}`
        return errorResult(
          `no attachment with id=${params.attachment_id} (${validMsg}). For an attachment from an earlier message, call channel_history first to make it resolvable; otherwise do not invent ids that are not in the inbound message.`,
          { count: 0, prompt: params.prompt },
        )
      }
      if (found.ref === '') {
        return errorResult(
          `attachment #${params.attachment_id} (${found.kind}) has no fetchable ref — likely a sticker or an upstream payload without a public URL. Acknowledge the user but do not promise to view it.`,
          { count: 0, prompt: params.prompt },
        )
      }
      const maxBytes = Math.min(
        config.modelTools.limits.lookAtImageMaxBytes,
        config.modelTools.limits.channelAttachmentMaxBytes,
      )
      const result = await router.fetchAttachment(origin.adapter, {
        ref: found.ref,
        maxBytes,
        memoryMaxBytes: maxBytes + Math.ceil(maxBytes / 3) * 4 * 2,
        signal,
        ...(found.filename !== undefined ? { filename: found.filename } : {}),
      })
      if (!result.ok) return errorResult(result.error, { count: 0, prompt: params.prompt })
      try {
        return await withBudgetedAttachmentBase64(
          result.buffer,
          result.budget,
          async (data) =>
            await runLookAtImages([toImageContent(data, result.mimetype ?? 'image/jpeg')], params.prompt, permissions),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return errorResult(message, { count: 0, prompt: params.prompt })
      }
    },
  })
}

function toImageContent(data: string, mimeType: string): ImageContent {
  return { type: 'image', data, mimeType }
}

async function runLookAtImages(
  imageContents: ImageContent[],
  prompt: string | undefined,
  permissions?: PermissionService,
) {
  // Exception for text-only GLM Coding Plan models: the subagent below would
  // resolve to the same image-blind model and silently fail. GLM-4.6V vision is
  // reachable on the coding-plan endpoint with the same key (POST
  // /api/coding/paas/v4 → 200, drawn from the plan's vision quota). Only this
  // setup diverts; every other one keeps the subagent path.
  if (shouldUseGlmCodingPlanVision()) {
    return await analyzeWithGlmCodingPlanVision(imageContents, prompt)
  }

  const systemPrompt = buildMultimodalLookerSystemPrompt(prompt)
  const userText =
    prompt !== undefined && prompt.trim() !== '' ? prompt.trim() : 'Please describe the attached image(s).'

  const origin: SessionOrigin = {
    kind: 'subagent',
    subagent: 'multimodal-looker',
    parentSessionId: '<look-at-tool>',
  }

  // TODO(usage-accounting): this falls through to SessionManager.inMemory()
  // because no sessionManager is passed, so the look_at subagent's
  // message.usage never reaches the sessions/ JSONLs that `typeclaw usage`
  // and the bundled `backup` plugin scan. Same root-cause class as the
  // plugin-command/cron-handler path fixed in `runPromptForCommand`
  // (src/server/command-runner.ts). Fixing this requires threading a
  // SessionFactory into pi-coding-agent's tool execute() signature, which
  // is a separate change.
  const { session, dispose } = await createSessionWithDispose({
    systemPromptOverride: systemPrompt,
    origin,
    ...(permissions !== undefined ? { permissions } : {}),
    profile: 'vision',
    // Both knobs are required to fully disarm the subagent's tool surface:
    // `customTools: []` blocks typeclaw's system tools (web_search/web_fetch/
    // look_at/restart/...) — without it, the look_at tool would recurse
    // into itself. `tools: []` blocks pi-coding-agent's defaults
    // (read/bash/edit/write) — without it, a vision model could be talked
    // into running shell commands or editing files inside its short-lived
    // session. The looker should only describe images, not act.
    tools: [],
    customTools: [],
  })

  try {
    await promptWithSameRefRetryOnly(session, userText, { images: imageContents })
    const text = extractLastAssistantText(session.messages)
    if (text === null) {
      return errorResult('multimodal-looker returned no text response', {
        count: imageContents.length,
        prompt,
      })
    }
    return successResult(text, { count: imageContents.length, prompt })
  } finally {
    session.dispose()
    await dispose()
  }
}

const GLM_VISION_PROVIDER = 'zai-coding'
const GLM_VISION_MODEL = 'glm-4.6v'
const GLM_VISION_ENDPOINT = 'https://api.z.ai/api/coding/paas/v4/chat/completions'
const GLM_VISION_MAX_TOKENS = 32768
export const GLM_VISION_MAX_RESPONSE_BYTES = 2 * 1024 * 1024

// Vision requests carry a base64 image body the server must decode before it can
// send response headers, so the observer's 15s default TTFB (tuned for ~1s text
// completions) is too tight and flakes on cold connections. 45s is 3x the
// observed-under-load window; env-overridable for operators who need more.
export const GLM_VISION_TTFB_MS = 45_000
const ENV_GLM_VISION_TTFB_MS = 'TYPECLAW_GLM_VISION_TTFB_MS'

export function resolveGlmVisionTtfbMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_GLM_VISION_TTFB_MS]
  if (raw === undefined || raw === '') return GLM_VISION_TTFB_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return GLM_VISION_TTFB_MS
  return parsed
}

function shouldUseGlmCodingPlanVision(): boolean {
  const ref = resolveProfile(getConfig().models, 'vision').ref
  return providerForModelRef(ref) === GLM_VISION_PROVIDER && !resolveModel(ref).input.includes('image')
}

async function analyzeWithGlmCodingPlanVision(imageContents: ImageContent[], prompt: string | undefined) {
  const details = { count: imageContents.length, prompt }
  const apiKey = new SecretsBackend(join(process.cwd(), 'secrets.json')).tryReadProviderApiKeySync(GLM_VISION_PROVIDER)
  if (apiKey === null) {
    return errorResult('GLM Coding Plan vision unavailable: no zai-coding API key', details)
  }

  const requestInit: LlmFetchObservedRequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GLM_VISION_MODEL,
      max_tokens: GLM_VISION_MAX_TOKENS,
      messages: buildGlmVisionMessages(imageContents, prompt),
    }),
    [LLM_FETCH_OBSERVER_TIMEOUTS]: { ttfbMs: resolveGlmVisionTtfbMs() },
  }
  let response: Response
  try {
    response = await fetch(GLM_VISION_ENDPOINT, requestInit)
  } catch (error) {
    return errorResult(`GLM vision request failed: ${error instanceof Error ? error.message : String(error)}`, details)
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return errorResult(`GLM vision request failed: HTTP ${response.status}`, details)
  }

  let body: unknown
  try {
    const bytes = await readResponseBodyBounded(response, GLM_VISION_MAX_RESPONSE_BYTES)
    body = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    return errorResult(`GLM vision response failed: ${error instanceof Error ? error.message : String(error)}`, details)
  }
  const text = extractGlmVisionText(body)
  if (text === null) {
    return errorResult('GLM vision returned no text response', details)
  }
  return successResult(text, details)
}

// Mirror the subagent path's systemPromptOverride so the direct route keeps
// the same visible-only / faithful-transcription / no-preamble behavior.
export function buildGlmVisionMessages(imageContents: ImageContent[], prompt: string | undefined) {
  const userText =
    prompt !== undefined && prompt.trim() !== '' ? prompt.trim() : 'Please describe the attached image(s).'
  return [
    { role: 'system' as const, content: buildMultimodalLookerSystemPrompt(prompt) },
    {
      role: 'user' as const,
      content: [
        ...imageContents.map((image) => ({
          type: 'image_url' as const,
          image_url: { url: `data:${image.mimeType};base64,${image.data}` },
        })),
        { type: 'text' as const, text: userText },
      ],
    },
  ]
}

export function extractGlmVisionText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const choices = (body as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const message = (choices[0] as { message?: unknown }).message
  const text = (message as { content?: unknown } | undefined)?.content
  if (typeof text !== 'string' || text.trim() === '') return null
  return text.trim()
}

function toImageInput(p: ImageParam): ImageInput {
  const hasUrl = 'url' in p && p.url !== undefined && p.url !== ''
  const hasPath = 'path' in p && p.path !== undefined && p.path !== ''
  const hasData = 'data' in p && p.data !== undefined && p.data !== ''
  const hasMime = 'mimeType' in p && p.mimeType !== undefined && p.mimeType !== ''

  // `data` and `mimeType` are paired — accept both as one source. `mimeType`
  // alone with no `data` is rejected as an incomplete base64 spec.
  const sources: string[] = []
  if (hasUrl) sources.push('url')
  if (hasPath) sources.push('path')
  if (hasData || hasMime) sources.push('data+mimeType')

  if (sources.length === 0) {
    throw new Error('look_at: each image must specify exactly one of `url`, `path`, or `data`+`mimeType`')
  }
  if (sources.length > 1) {
    throw new Error(
      `look_at: each image must specify exactly one of \`url\`, \`path\`, or \`data\`+\`mimeType\` (got: ${sources.join(', ')})`,
    )
  }
  if (hasUrl) return { kind: 'url', url: (p as { url: string }).url }
  if (hasPath) return { kind: 'file', path: (p as { path: string }).path }
  if (hasData && hasMime) {
    return { kind: 'base64', data: (p as { data: string }).data, mimeType: (p as { mimeType: string }).mimeType }
  }
  throw new Error('look_at: base64 image requires both `data` and `mimeType`')
}

// Pulls the most recent assistant turn's text content. The subagent's reply
// shows up here once `session.prompt()` resolves. Tool calls in the assistant
// message are ignored — multimodal-looker's session has no tools wired in
// (`tools: []` + `customTools: []` at session creation), so in practice this
// is pure text plus optional thinking blocks (which we skip).
function extractLastAssistantText(messages: ReadonlyArray<unknown>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: unknown; content?: unknown } | undefined
    if (msg === undefined || msg.role !== 'assistant') continue
    const content = msg.content
    if (!Array.isArray(content)) continue
    const texts: string[] = []
    for (const part of content) {
      if (part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const t = (part as { text?: unknown }).text
        if (typeof t === 'string') texts.push(t)
      }
    }
    if (texts.length > 0) return texts.join('\n').trim()
  }
  return null
}

function successResult(text: string, partial: Omit<LookAtDetails, 'text' | 'error'>) {
  const details: LookAtDetails = { ...partial, text }
  return {
    content: [{ type: 'text' as const, text }],
    details,
  }
}

function errorResult(message: string, partial: Omit<LookAtDetails, 'text' | 'error'>) {
  const details: LookAtDetails = { ...partial, error: message }
  return {
    content: [{ type: 'text' as const, text: `look_at failed: ${message}` }],
    details,
  }
}
