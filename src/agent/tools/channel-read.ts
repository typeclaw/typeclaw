import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'
import { ADAPTER_IDS, type AdapterId } from '@/channels/schema'
import type { ChannelListEntry } from '@/channels/types'

import { renderHistoryMessage, renderHistoryMessages } from './channel-history-render'
import { type ChannelToolLogger, consoleChannelLogger, formatChannelToolFailure } from './channel-log'

export type CreateChannelReadToolOptions = {
  router: ChannelRouter
  logger?: ChannelToolLogger
}

const DEFAULT_LIMIT = 20

// channel_read is the arbitrary-addressing read counterpart to channel_send:
// where channel_history is locked to the current session's chat, channel_read
// takes an explicit adapter/workspace/chat so the agent can look at a DIFFERENT
// conversation ("check the #general messages", "what's this message id"). Three
// modes share one tool to keep the per-turn tool-schema budget small, mirroring
// web_fetch's strategy union; mode-specific required params are validated at
// runtime since JSON-Schema can't express "required-if".
export function createChannelReadTool({ router, logger = consoleChannelLogger }: CreateChannelReadToolOptions) {
  return defineTool({
    name: 'channel_read',
    label: 'Channel Read',
    description:
      'Read from an external messenger channel you are NOT necessarily engaged in. Always specify `adapter` and `workspace`. ' +
      'Three modes:\n' +
      '- "history": fetch recent messages from `chat` (optionally a `thread`). Returns oldest-first; pass `cursor` to page further back. Use for "check the #general messages".\n' +
      '- "message": fetch ONE message from `chat` by `message_id`. Use for "what do you think of <message id>".\n' +
      '- "list": discover channels/chats in `workspace` (no `chat` needed). Use when you do not yet know a chat id.\n' +
      'For Discord guild channels, `workspace` is the guild id; for Slack team channels, `workspace` is the team id (e.g. "T0ACME"); for DMs, "@dm". ' +
      'On failure returns { ok: false, error }. Not every adapter supports every mode — an unsupported mode returns a not-supported error rather than throwing. ' +
      'This is read-only; use channel_send to post.',
    parameters: Type.Object({
      mode: Type.Union([Type.Literal('history'), Type.Literal('message'), Type.Literal('list')], {
        description:
          'What to read: "history" (recent messages), "message" (one message by id), or "list" (discover chats).',
      }),
      adapter: Type.Union(
        ADAPTER_IDS.map((a) => Type.Literal(a)),
        { description: 'Adapter id, e.g. "discord-bot", "slack-bot".' },
      ),
      workspace: Type.String({
        description: 'Discord guild id or Slack team id (e.g. "T0ACME"); "@dm" for direct messages.',
        minLength: 1,
      }),
      chat: Type.Optional(
        Type.String({
          description: 'Channel/chat id. Required for mode "history" and "message"; omit for mode "list".',
          minLength: 1,
        }),
      ),
      thread: Type.Optional(
        Type.String({
          description: 'Optional thread id/ts to narrow history or a threaded message lookup.',
          minLength: 1,
        }),
      ),
      message_id: Type.Optional(
        Type.String({ description: 'Message id to fetch. Required for mode "message".', minLength: 1 }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: 'history/list: number of items to fetch (default 20). Adapters cap this further.',
          minimum: 1,
          maximum: 200,
        }),
      ),
      cursor: Type.Optional(
        Type.String({
          description: 'history/list: opaque cursor from a previous result to page further.',
          minLength: 1,
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const adapter = params.adapter as AdapterId
      const limit = params.limit ?? DEFAULT_LIMIT

      if (params.mode === 'history') {
        return await readHistory({ router, logger, adapter, params, limit })
      }
      if (params.mode === 'message') {
        return await readMessage({ router, logger, adapter, params })
      }
      return await readList({ router, logger, adapter, params, limit })
    },
  })
}

type Details = { ok: boolean; error?: string; count?: number; nextCursor?: string }

function fail(error: string): { content: [{ type: 'text'; text: string }]; details: Details } {
  return { content: [{ type: 'text' as const, text: `channel_read error: ${error}` }], details: { ok: false, error } }
}

async function readHistory(args: {
  router: ChannelRouter
  logger: ChannelToolLogger
  adapter: AdapterId
  params: { workspace: string; chat?: string; thread?: string; cursor?: string }
  limit: number
}) {
  const { router, logger, adapter, params, limit } = args
  if (params.chat === undefined) {
    logger.warn(formatChannelToolFailure('channel_read', 'history-requires-chat'))
    return fail('mode "history" requires `chat`.')
  }
  const result = await router.fetchHistory(adapter, {
    chat: params.chat,
    thread: params.thread ?? null,
    limit,
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
  })
  if (!result.ok) {
    logger.warn(formatChannelToolFailure('channel_read', `${adapter}:${params.chat}: ${result.error}`))
    return fail(result.error)
  }
  const rendered = renderHistoryMessages(result.messages)
  const cursorLine =
    result.nextCursor !== undefined
      ? `\n\n(more older messages available — call channel_read again with cursor: ${JSON.stringify(result.nextCursor)})`
      : ''
  const header = `## ${adapter}:${params.workspace}/${params.chat} history (${result.messages.length} message${result.messages.length === 1 ? '' : 's'}, oldest first)`
  const details: Details =
    result.nextCursor !== undefined
      ? { ok: true, count: result.messages.length, nextCursor: result.nextCursor }
      : { ok: true, count: result.messages.length }
  return { content: [{ type: 'text' as const, text: `${header}\n${rendered}${cursorLine}` }], details }
}

async function readMessage(args: {
  router: ChannelRouter
  logger: ChannelToolLogger
  adapter: AdapterId
  params: { workspace: string; chat?: string; thread?: string; message_id?: string }
}) {
  const { router, logger, adapter, params } = args
  if (params.chat === undefined) {
    logger.warn(formatChannelToolFailure('channel_read', 'message-requires-chat'))
    return fail('mode "message" requires `chat`.')
  }
  if (params.message_id === undefined) {
    logger.warn(formatChannelToolFailure('channel_read', 'message-requires-message_id'))
    return fail('mode "message" requires `message_id`.')
  }
  const result = await router.getMessage(adapter, {
    chat: params.chat,
    thread: params.thread ?? null,
    messageId: params.message_id,
  })
  if (!result.ok) {
    logger.warn(formatChannelToolFailure('channel_read', `${adapter}:${params.chat}: ${result.error}`))
    return fail(result.error)
  }
  const header = `## ${adapter}:${params.workspace}/${params.chat} message ${params.message_id}`
  return {
    content: [{ type: 'text' as const, text: `${header}\n${renderHistoryMessage(result.message)}` }],
    details: { ok: true, count: 1 } satisfies Details,
  }
}

async function readList(args: {
  router: ChannelRouter
  logger: ChannelToolLogger
  adapter: AdapterId
  params: { workspace: string; cursor?: string }
  limit: number
}) {
  const { router, logger, adapter, params, limit } = args
  const result = await router.listChannels(adapter, {
    workspace: params.workspace,
    limit,
    ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
  })
  if (!result.ok) {
    logger.warn(formatChannelToolFailure('channel_read', `${adapter}:${params.workspace}: ${result.error}`))
    return fail(result.error)
  }
  const rendered = renderChannelList(result.entries)
  const cursorLine =
    result.nextCursor !== undefined
      ? `\n\n(more channels available — call channel_read again with cursor: ${JSON.stringify(result.nextCursor)})`
      : ''
  const header = `## ${adapter}:${params.workspace} channels (${result.entries.length})`
  const details: Details =
    result.nextCursor !== undefined
      ? { ok: true, count: result.entries.length, nextCursor: result.nextCursor }
      : { ok: true, count: result.entries.length }
  return { content: [{ type: 'text' as const, text: `${header}\n${rendered}${cursorLine}` }], details }
}

function renderChannelList(entries: readonly ChannelListEntry[]): string {
  if (entries.length === 0) return '(no channels)'
  return entries
    .map((e) => {
      const member = e.isMember === undefined ? '' : e.isMember ? ', member' : ', not-member'
      return `${e.name} (chat=${e.chat}, ${e.kind}${member})`
    })
    .join('\n')
}
