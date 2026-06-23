import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'
import type { AdapterId } from '@/channels/schema'
import type { ChannelHistoryMessage } from '@/channels/types'

import { type ChannelToolLogger, consoleChannelLogger, formatChannelToolFailure } from './channel-log'

export type ChannelHistoryOrigin = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
}

export type CreateChannelHistoryToolOptions = {
  router: ChannelRouter
  origin: ChannelHistoryOrigin
  logger?: ChannelToolLogger
}

// channel_history is a lazy "look back" capability for channel-routed
// sessions. The agent only sees the current turn's batch and a small
// observed-context buffer by default; this tool lets it pull older
// messages from the upstream service when context demands it.
//
// Addressing comes from the session origin (same idea as channel_reply):
// the agent supplies only the slicing parameters (limit/cursor/scope).
// `scope` defaults to thread when the origin has one, channel otherwise.
// Thread scope on a channel-root session is rejected rather than silently
// downgraded so the agent doesn't conflate the two views.
export function createChannelHistoryTool({
  router,
  origin,
  logger = consoleChannelLogger,
}: CreateChannelHistoryToolOptions) {
  return defineTool({
    name: 'channel_history',
    label: 'Channel History',
    description:
      'Fetch older messages from the current conversation. Useful when a user references context you do not have ' +
      '(e.g. "as we discussed earlier"). Returns messages oldest-first. Pass `cursor` from a previous result to page further back. ' +
      'Default scope is the current thread when the session is in a thread, otherwise the channel. ' +
      'Thread scope is rejected when the session is not in a thread — switch to `scope: "channel"` if you want channel-root context.',
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({
          description: 'Number of messages to fetch (default 20). Adapters cap this further (Slack 200, Discord 100).',
          minimum: 1,
          maximum: 200,
        }),
      ),
      cursor: Type.Optional(
        Type.String({
          description: 'Opaque cursor from a previous channel_history result. Pass to page further back.',
          minLength: 1,
        }),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal('thread'), Type.Literal('channel')], {
          description:
            'Whether to fetch the current thread or the whole channel. Defaults to thread when the session is in a thread, channel otherwise.',
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const limit = params.limit ?? 20
      const scope = params.scope ?? (origin.thread !== null ? 'thread' : 'channel')
      type Details = { ok: boolean; error?: string; count?: number; nextCursor?: string }

      if (scope === 'thread' && origin.thread === null) {
        logger.warn(formatChannelToolFailure('channel_history', 'thread-scope-requires-thread-session'))
        const text =
          'channel_history error: thread-scope-requires-thread-session — this session is not in a thread; pass `scope: "channel"` instead.'
        const details: Details = { ok: false, error: 'thread-scope-requires-thread-session' }
        return { content: [{ type: 'text' as const, text }], details }
      }

      const result = await router.fetchHistory(origin.adapter, origin.workspace, {
        chat: origin.chat,
        thread: scope === 'thread' ? origin.thread : null,
        limit,
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
      })

      if (!result.ok) {
        logger.warn(formatChannelToolFailure('channel_history', `${origin.adapter}:${origin.chat}: ${result.error}`))
        const details: Details = { ok: false, error: result.error }
        return {
          content: [{ type: 'text' as const, text: `channel_history error: ${result.error}` }],
          details,
        }
      }

      router.registerHistoryAttachments(origin, result.messages)

      const rendered = renderMessages(result.messages)
      const cursorLine =
        result.nextCursor !== undefined
          ? `\n\n(more older messages available — call channel_history again with cursor: ${JSON.stringify(result.nextCursor)})`
          : ''
      const header = `## ${scope} history (${result.messages.length} message${result.messages.length === 1 ? '' : 's'}, oldest first)`
      const details: Details =
        result.nextCursor !== undefined
          ? { ok: true, count: result.messages.length, nextCursor: result.nextCursor }
          : { ok: true, count: result.messages.length }
      return {
        content: [{ type: 'text' as const, text: `${header}\n${rendered}${cursorLine}` }],
        details,
      }
    },
  })
}

// Render history as one line per message, chronological order. `BOT` marker
// distinguishes the agent's own past replies from user messages so the
// model doesn't treat them as user input. Author name is shown alongside
// the id so the agent can refer to people by name in its reply.
function renderMessages(messages: readonly ChannelHistoryMessage[]): string {
  if (messages.length === 0) return '(no messages)'
  const lines: string[] = []
  for (const m of messages) {
    const iso = m.ts > 0 ? new Date(m.ts).toISOString() : 'unknown-time'
    const who = m.isBot ? `BOT (${m.authorName})` : `${m.authorName} (<@${m.authorId}>)`
    lines.push(`[${iso}] ${who}: ${m.text}`)
  }
  return lines.join('\n')
}
