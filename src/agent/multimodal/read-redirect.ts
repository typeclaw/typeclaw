import path from 'node:path'

import type { InternalGuardResult } from '@/agent/guard-types'
import { GUARD_IMAGE_READ_REDIRECT } from '@/bundled-plugins/guard/keys'

export { GUARD_IMAGE_READ_REDIRECT } from '@/bundled-plugins/guard/keys'

// Mirrors the IMAGE_MIME_TYPES set in @mariozechner/pi-coding-agent
// (dist/utils/mime.ts). Keeping the trigger surface aligned with the upstream
// read tool's image-attachment behavior means we redirect on exactly the
// extensions that would otherwise inject `{ type: 'image' }` content parts
// into the main agent's history.
//
// Extension-only matching is preferred over the upstream MIME sniffer's
// 4100-byte file open because this check runs on every `read` call;
// extensionless image files still leak as before (no regression), and the
// agent can force-read via `acknowledgeGuards.guard.imageReadRedirect: true` when
// it genuinely needs the bytes (e.g. writing image-processing code).
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

export function checkImageReadRedirect(options: {
  tool: string
  args: Readonly<Record<string, unknown>>
}): InternalGuardResult {
  const { tool, args } = options
  if (tool !== 'read') return undefined
  const rawPath = args.path
  if (typeof rawPath !== 'string' || rawPath === '') return undefined

  const ext = path.extname(rawPath).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(ext)) return undefined

  return {
    kind: 'acknowledgement-required',
    reason: [
      `Guard \`${GUARD_IMAGE_READ_REDIRECT}\` blocked read of an image file: ${rawPath}.`,
      `Reading images via \`read\` injects the raw bytes into your message history as an image attachment, which can quickly fill your context window.`,
      `Use \`look_at\` with \`path: ${JSON.stringify(rawPath)}\` instead — it routes the bytes through a vision-capable subagent and returns only text to you. Pass an optional \`prompt\` to ask a specific question (returns shorter text than the default describe-everything path).`,
      `If you genuinely need the raw image bytes (e.g. writing image-processing code), retry with \`acknowledgeGuards.guard.${GUARD_IMAGE_READ_REDIRECT}: true\` in the tool arguments.`,
    ].join(' '),
  }
}
