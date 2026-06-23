import { Type } from '@mariozechner/pi-ai'
import type { ImageContent } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import { createSessionWithDispose, type SessionOrigin } from '@/agent'
import type { ChannelRouter } from '@/channels/router'
import type { AdapterId } from '@/channels/schema'

import { buildMultimodalLookerSystemPrompt, resolveImage, type ImageInput } from './looker'

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
export const lookAtTool = defineTool({
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
        path: Type.Optional(Type.String({ description: 'Absolute filesystem path (inside /agent or a mounted dir).' })),
        data: Type.Optional(Type.String({ description: 'Base64-encoded image bytes (pair with mimeType).' })),
        mimeType: Type.Optional(Type.String({ description: 'MIME type when using `data` (e.g. "image/png").' })),
      }),
      { minItems: 1, description: 'One or more images to look at.' },
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
      const resolved = await Promise.all(imageInputs.map((i) => resolveImage(i, signal)))
      const imageContents: ImageContent[] = resolved.map((r) => toImageContent(r.data, r.mimeType))
      return await runLookAtImages(imageContents, args.prompt)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return errorResult(message, { count: args.images.length, prompt: args.prompt })
    }
  },
})

// Channel attachments intentionally use a separate tool instead of adding
// channel-only dependencies to the global look_at implementation. This keeps
// non-channel sessions' image source validation unchanged while channel
// sessions get router-validated attachment_id lookup.
export function createChannelLookAtTool(router: ChannelRouter, origin: ChannelLookAtOrigin) {
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
    async execute(_toolCallId, params) {
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
      const result = await router.fetchAttachment(origin.adapter, origin.workspace, {
        ref: found.ref,
        ...(found.filename !== undefined ? { filename: found.filename } : {}),
      })
      if (!result.ok) return errorResult(result.error, { count: 0, prompt: params.prompt })
      return await runLookAtImages(
        [toImageContent(result.buffer.toString('base64'), result.mimetype ?? 'image/jpeg')],
        params.prompt,
      )
    },
  })
}

function toImageContent(data: string, mimeType: string): ImageContent {
  return { type: 'image', data, mimeType }
}

async function runLookAtImages(imageContents: ImageContent[], prompt: string | undefined) {
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
    await session.prompt(userText, { images: imageContents })
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
