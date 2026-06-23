import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'
import type { AdapterId } from '@/channels/schema'

import { type ChannelToolLogger, consoleChannelLogger, formatChannelToolFailure } from './channel-log'

export type ChannelFetchAttachmentOrigin = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
}

export type CreateChannelFetchAttachmentToolOptions = {
  router: ChannelRouter
  origin: ChannelFetchAttachmentOrigin
  inboxDir?: string
  logger?: ChannelToolLogger
}

export const DEFAULT_INBOX_DIR = '/agent/workspace/inbox'

export function createChannelFetchAttachmentTool({
  router,
  origin,
  inboxDir,
  logger = consoleChannelLogger,
}: CreateChannelFetchAttachmentToolOptions) {
  const baseDir = inboxDir ?? DEFAULT_INBOX_DIR
  const adapter = origin.adapter
  return defineTool({
    name: 'channel_fetch_attachment',
    label: 'Channel Fetch Attachment',
    description:
      'Download a file attached to a channel message and save it to disk. Inbound channel ' +
      'messages with attachments show `[<Platform> attachment #N: <kind> <metadata>]` in the text. Pass `N` as ' +
      '`attachment_id`; do not invent ids that are not present in the message. The router resolves the private ' +
      'platform ref itself. Attachments on the CURRENT inbound message resolve directly; for one from an EARLIER ' +
      'message, call channel_history first (it makes those attachments resolvable by the same id). On success ' +
      'returns the absolute path of the saved file plus its detected mimetype and size.',
    parameters: Type.Object({
      attachment_id: Type.Integer({
        description:
          'The number N from the inbound `[<Platform> attachment #N: ...]` placeholder. Must be present in this turn.',
        minimum: 1,
      }),
      filename: Type.Optional(
        Type.String({
          description:
            'Override the saved filename. Defaults to the upstream filename (Slack) or the URL basename (Discord).',
          minLength: 1,
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      type Details = { ok: boolean; error?: string; path?: string; mimetype?: string; size?: number }
      const found = router.lookupInboundAttachment({
        adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        thread: origin.thread,
        id: params.attachment_id,
      })
      if (found === null) {
        const validIds = router.listInboundAttachmentIds({
          adapter,
          workspace: origin.workspace,
          chat: origin.chat,
          thread: origin.thread,
        })
        const validMsg =
          validIds.length === 0
            ? 'no attachments are resolvable right now'
            : `resolvable attachment_ids: ${validIds.join(', ')}`
        return errorResult(
          `no attachment with id=${params.attachment_id} (${validMsg}). For an attachment from an earlier message, call channel_history first to make it resolvable; otherwise do not invent ids that are not in the inbound message.`,
        )
      }
      if (found.ref === '') {
        return errorResult(
          `attachment #${params.attachment_id} (${found.kind}) has no fetchable ref — likely a sticker or an upstream payload without a public URL. Acknowledge the user but do not promise to view it.`,
        )
      }
      const ref = found.ref
      const filename = params.filename ?? found.filename
      const result = await router.fetchAttachment(adapter, origin.workspace, {
        ref,
        ...(filename !== undefined ? { filename } : {}),
      })
      if (!result.ok) {
        logger.warn(formatChannelToolFailure('channel_fetch_attachment', `${adapter}: ${result.error}`))
        const text = `channel_fetch_attachment error: ${result.error}`
        const details: Details = { ok: false, error: result.error }
        return { content: [{ type: 'text' as const, text }], details }
      }

      const safeFilename = sanitizeFilename(result.filename)
      const refSlug = sanitizeRefSlug(ref)
      const targetDir = join(baseDir, adapter, refSlug)
      const targetPath = join(targetDir, safeFilename)
      try {
        await mkdir(targetDir, { recursive: true })
        await writeFile(targetPath, result.buffer)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.warn(formatChannelToolFailure('channel_fetch_attachment', `${adapter}: write failed: ${message}`))
        const text = `channel_fetch_attachment error: write failed: ${message}`
        const details: Details = { ok: false, error: `write failed: ${message}` }
        return { content: [{ type: 'text' as const, text }], details }
      }

      const mimetypePart = result.mimetype !== undefined ? ` (${result.mimetype})` : ''
      const text = `saved ${result.size} bytes to ${targetPath}${mimetypePart}`
      const details: Details = {
        ok: true,
        path: targetPath,
        ...(result.mimetype !== undefined ? { mimetype: result.mimetype } : {}),
        size: result.size,
      }
      return { content: [{ type: 'text' as const, text }], details }
    },
  })
}

function errorResult(message: string) {
  const details = { ok: false, error: message }
  return { content: [{ type: 'text' as const, text: `channel_fetch_attachment error: ${message}` }], details }
}

const UNSAFE_FILENAME_CHARS = /[^A-Za-z0-9._-]/g

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(UNSAFE_FILENAME_CHARS, '_')
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'attachment'
  return cleaned
}

function sanitizeRefSlug(ref: string): string {
  const trailing =
    ref
      .split('/')
      .filter((s) => s.length > 0)
      .pop() ?? 'ref'
  const cleaned = trailing.replace(UNSAFE_FILENAME_CHARS, '_').slice(0, 64)
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'ref'
  return cleaned
}
