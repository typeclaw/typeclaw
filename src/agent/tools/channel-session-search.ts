import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import type { ChannelRouter } from '@/channels/router'

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
      'channel_handoff instead of reading or posting there yourself. Identity comes from your authenticated ' +
      'requester, never from the query. No results means no eligible live session was found.',
    parameters: Type.Object({
      query: Type.String({ description: 'Conversation name, topic, message text, or participant.', minLength: 1 }),
    }),
    async execute(_toolCallId, params) {
      const targets = options.router.searchSessions({ fromSessionId: options.sessionId, query: params.query })
      return {
        content: [
          {
            type: 'text' as const,
            text: targets.length === 0 ? 'No eligible live sessions found.' : JSON.stringify(targets),
          },
        ],
        details: { targets },
      }
    },
  })
}
