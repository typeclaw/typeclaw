import { formatAuthorAttribution } from '@/channels/router'
import type { AdapterId } from '@/channels/schema'
import type { ChannelHistoryMessage } from '@/channels/types'

// Render history as one line per message, chronological order, using the same
// author attribution and ` [bot]` tag as inbound prompt lines. Bots keep their
// platform id so the agent can address a peer bot directly instead of falling
// back to a broadcast mention like `@here`. Shared by channel_history (origin-
// bound) and channel_read (arbitrary-chat) so both render identically.
export function renderHistoryMessages(messages: readonly ChannelHistoryMessage[], adapter: AdapterId): string {
  if (messages.length === 0) return '(no messages)'
  return messages.map((m) => renderHistoryMessage(m, adapter)).join('\n')
}

export function renderHistoryMessage(m: ChannelHistoryMessage, adapter: AdapterId): string {
  const iso = m.ts > 0 ? new Date(m.ts).toISOString() : 'unknown-time'
  const who = `${formatAuthorAttribution(adapter, m.authorId, m.authorName)}${m.isBot ? ' [bot]' : ''}`
  const messageId = m.externalMessageId ? ` [message_id=${m.externalMessageId}]` : ''
  return `[${iso}]${messageId} ${who}: ${m.text}`
}
