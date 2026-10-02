import type { SlackInboundMessageEvent } from './slack-bot-classify'
import { slackInboundRevision } from './slack-inbound-revision'

export const SLACK_DEDUPE_CAPACITY = 256

export type SlackDedupeMatch = 'client_msg_id' | 'channel_ts'

export type SlackDedupeKeys = {
  channelTs: string
  clientMsgId: string | null
}

export type SlackDedupe = {
  check: (event: Pick<SlackInboundMessageEvent, 'channel' | 'ts' | 'client_msg_id'>) => SlackDedupeMatch | null
  mark: (event: Pick<SlackInboundMessageEvent, 'channel' | 'ts' | 'client_msg_id'>) => void
}

// Two parallel insertion-ordered Sets. `client_msg_id` is the primary key
// because it is stable across Slack-side resends of the same user gesture
// (observed in the wild: a single Slack mention surfaced as two `message`
// events ~21s apart with different `ts` values, identical text, and — per
// Slack's API contract — identical `client_msg_id`). `channel:ts` is the
// fallback because it is the only key available for events Slack does not
// stamp with `client_msg_id` (bot messages, system messages, and historically
// `app_mention` envelopes).
export function createSlackDedupe(capacity: number = SLACK_DEDUPE_CAPACITY): SlackDedupe {
  const tsRing = new Set<string>()
  const clientMsgIdRing = new Set<string>()

  const remember = (ring: Set<string>, key: string): void => {
    if (ring.has(key)) return
    if (ring.size >= capacity) {
      const oldest = ring.values().next().value
      if (oldest !== undefined) ring.delete(oldest)
    }
    ring.add(key)
  }

  return {
    check: (event) => {
      const revision = slackInboundRevision(event)
      const cmid = event.client_msg_id
      if (cmid !== undefined && cmid !== '' && clientMsgIdRing.has(`${cmid}:${revision}`)) return 'client_msg_id'
      if (tsRing.has(`${event.channel}:${event.ts}:${revision}`)) return 'channel_ts'
      return null
    },
    mark: (event) => {
      const revision = slackInboundRevision(event)
      remember(tsRing, `${event.channel}:${event.ts}:${revision}`)
      const cmid = event.client_msg_id
      if (cmid !== undefined && cmid !== '') remember(clientMsgIdRing, `${cmid}:${revision}`)
    },
  }
}
