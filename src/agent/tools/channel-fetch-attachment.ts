import { join, sep } from 'node:path'

import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { SessionOrigin } from '@/agent/session-origin'
import { writeFileAnchored } from '@/agent/tool-file-safety'
import type { ChannelRouter } from '@/channels/router'
import type { AdapterId } from '@/channels/schema'
import { config } from '@/config'
import type { PermissionService } from '@/permissions'
import { resolveHiddenPaths } from '@/sandbox'

import { type ChannelToolLogger, consoleChannelLogger, formatChannelToolFailure } from './channel-log'

export type ChannelFetchAttachmentOrigin = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
}

type FetchAttachmentDetails = { ok: boolean; error?: string; path?: string; mimetype?: string; size?: number }

export type CreateChannelFetchAttachmentToolOptions = {
  router: ChannelRouter
  origin: ChannelFetchAttachmentOrigin
  inboxDir?: string
  // Resolved at execute time (role is a property of the live origin, not of
  // construction), and wins over inboxDir/DEFAULT_INBOX_DIR. Lets the save
  // location follow the caller's role so a role hidden from workspace/ never
  // gets a file it can write but not read back (privateSurfaceRead would block
  // its follow-up look_at/read). See buildChannelTools for the decision.
  resolveBaseDir?: () => string
  logger?: ChannelToolLogger
  agentDir?: string
}

// workspace/ is private-surface: readable only by roles with fs.see.private.
export const DEFAULT_INBOX_DIR = '/agent/workspace/inbox'
// public/ is the guest-visible counterpart, so a redirected file stays readable
// back through look_at/read by the same role that fetched it.
export const PUBLIC_INBOX_DIR = '/agent/public/inbox'

export function createChannelFetchAttachmentTool({
  router,
  origin,
  inboxDir,
  resolveBaseDir,
  logger = consoleChannelLogger,
  agentDir = process.cwd(),
}: CreateChannelFetchAttachmentToolOptions) {
  const fallbackBaseDir = inboxDir ?? DEFAULT_INBOX_DIR
  const adapter = origin.adapter
  return defineTool({
    name: 'channel_fetch_attachment',
    label: 'Channel Fetch Attachment',
    description:
      'Download a file attached to a channel message and save it to disk. Use this only when you need the ' +
      'file ON DISK (to edit it, re-upload it, or run a tool over it); to simply VIEW an image, use ' +
      '`look_at_channel_attachment` instead — it returns a description without a disk write. Inbound channel ' +
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

    async execute(_toolCallId, params, signal) {
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
      const result = await router.fetchAttachment(adapter, {
        ref,
        maxBytes: config.modelTools.limits.channelAttachmentMaxBytes,
        signal,
        ...(filename !== undefined ? { filename } : {}),
      })
      if (!result.ok) {
        logger.warn(formatChannelToolFailure('channel_fetch_attachment', `${adapter}: ${result.error}`))
        const text = `channel_fetch_attachment error: ${result.error}`
        const details: FetchAttachmentDetails = { ok: false, error: result.error }
        return { content: [{ type: 'text' as const, text }], details }
      }

      try {
        const safeFilename = sanitizeFilename(result.filename)
        const refSlug = sanitizeRefSlug(ref)
        const baseDir = resolveBaseDir?.() ?? fallbackBaseDir
        const targetDir = join(baseDir, adapter, refSlug)
        const targetPath = join(targetDir, safeFilename)
        try {
          await writeFileAnchored({
            targetPath,
            data: result.buffer,
            agentDir,
            tool: 'channel_fetch_attachment',
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.warn(formatChannelToolFailure('channel_fetch_attachment', `${adapter}: write failed: ${message}`))
          const text = `channel_fetch_attachment error: write failed: ${message}`
          const details: FetchAttachmentDetails = { ok: false, error: `write failed: ${message}` }
          return { content: [{ type: 'text' as const, text }], details }
        }

        const mimetypePart = result.mimetype !== undefined ? ` (${result.mimetype})` : ''
        const text = `saved ${result.size} bytes to ${targetPath}${mimetypePart}`
        const details: FetchAttachmentDetails = {
          ok: true,
          path: targetPath,
          ...(result.mimetype !== undefined ? { mimetype: result.mimetype } : {}),
          size: result.size,
        }
        return { content: [{ type: 'text' as const, text }], details }
      } finally {
        result.budget.release()
      }
    },
  })
}

// Picks the inbox root for the caller's live role. Reuses the guard's own
// deny-list resolution (resolveHiddenPaths) as the single source of truth, so
// the save location can never drift out of sync with what privateSurfaceRead
// will let the same role read back: if workspace/inbox lands under a hidden dir
// the file goes to the guest-visible public/ inbox instead.
//
// The hidden-check joins with the OS-native separator to stay byte-identical to
// resolveHiddenPaths' own dirs, but the RETURNED path is normalized to POSIX:
// this value names a location inside the Linux container (agentDir is /agent),
// so a win32 CI host must not leak backslashes into it.
export function resolveInboxBaseDir(
  permissions: PermissionService,
  origin: SessionOrigin | undefined,
  agentDir: string,
): string {
  const privateInbox = join(agentDir, 'workspace', 'inbox')
  const { dirs } = resolveHiddenPaths(permissions, origin, agentDir)
  const hidden = dirs.some((dir) => privateInbox === dir || privateInbox.startsWith(`${dir}${sep}`))
  return toPosix(hidden ? join(agentDir, 'public', 'inbox') : privateInbox)
}

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

function errorResult(message: string) {
  const details: FetchAttachmentDetails = { ok: false, error: message }
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
