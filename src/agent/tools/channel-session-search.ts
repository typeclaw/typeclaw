import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'

// Idle sessions are evicted and cross-platform identities rarely resolve a role
// in the target, so an empty result is common. Without a next step here the
// model reads it as "unreachable" and stops.
const NO_TARGETS_TEXT =
  'No eligible live sessions found. The conversation may still be reachable: read it directly with `channel_read` ' +
  '(`mode: "list"` finds chat ids) and, if that read is allowed, post there with `channel_send`. If `channel_read` ' +
  "is denied, don't post there; tell the speaker no live session owns that conversation."

export function createChannelSessionSearchTool(options: {
  router: Pick<ChannelRouter, 'searchSessions'>
  sessionId: string
}) {
  return defineTool({
    name: 'channel_session_search',
    label: 'Channel Session Search',
    description:
      'Find the session that owns another conversation across all adapters. Search conversation names, recent ' +
      'messages, or participants in any language. Returns up to 20 authorized, live handoff targets with short ' +
      'activity hints, newest first. For work belonging elsewhere, search here and pass a result target to ' +
      'channel_handoff instead of posting there yourself. Identity comes from your authenticated requester, ' +
      'never from the query. Only live, recently active sessions are listed, so no results does not mean the ' +
      'conversation is unreachable.',
    parameters: Type.Object({
      query: Type.String({ description: 'Conversation name, topic, message text, or participant.', minLength: 1 }),
    }),
    async execute(_toolCallId, params) {
      const targets = options.router.searchSessions({ fromSessionId: options.sessionId, query: params.query })
      return {
        content: [
          {
            type: 'text' as const,
            text: targets.length === 0 ? NO_TARGETS_TEXT : JSON.stringify(targets),
          },
        ],
        details: { targets },
      }
    },
  })
}
