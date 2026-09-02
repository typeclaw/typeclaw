import { matchesAnyAlias } from '@/channels/engagement'
import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

import { splitWebexFiles } from './webex-format'
import type { WebexInboundRecord } from './webex-recovery'

export type WebexInboundMessage = WebexInboundRecord

export type InboundDropReason = 'self_author' | 'empty_content' | 'pre_connect'

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

// `botPersonEmail` is a second self-identity anchor alongside `botPersonRef`:
// legacy Hydra accounts can decode the bot identity to an email on one side and a
// UUID on the other, so a ref-only check leaks the agent's own reply back as a
// new inbound. Matching personEmail closes that echo loop. See webex-classify.ts.
export function classifyInbound(
  event: WebexInboundMessage,
  _config: ChannelAdapterConfig,
  botPersonRef: string | null,
  selfAliases: readonly string[] = [],
  botPersonEmail: string | null = null,
): InboundClassification {
  if (isSelfAuthor(event, botPersonRef, botPersonEmail)) {
    return { kind: 'drop', reason: 'self_author' }
  }

  const { text, attachments } = splitWebexFiles(event.text, event.files)
  if (text === '') return { kind: 'drop', reason: 'empty_content' }

  if (botPersonRef === null) {
    return { kind: 'drop', reason: 'pre_connect' }
  }

  const isDm = event.roomType === 'direct'
  const structuredBotMention = event.mentionedPeopleRefs.includes(botPersonRef) || event.mentionedGroups.includes('all')
  const aliasMatched = !structuredBotMention && matchesAnyAlias(text, selfAliases)
  const isBotMention = structuredBotMention || aliasMatched
  const mentionsOthers = event.mentionedPeopleRefs.length > 0 && !event.mentionedPeopleRefs.includes(botPersonRef)
  const ts = Date.parse(event.created)

  return {
    kind: 'route',
    payload: {
      adapter: 'webex-bot',
      // Webex message events do not include an org/team id; the room ref is the
      // stable permission bucket for group spaces while DMs use the shared key.
      workspace: isDm ? '@dm' : event.roomRef,
      chat: event.roomRef,
      thread: null,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      externalMessageId: event.ref,
      authorId: event.personRef,
      authorName: event.personEmail,
      authorIsBot: false,
      isBotMention,
      // Webex Mercury only exposes parentRef inline, not the parent author. When
      // the reply has a structured bot mention we can identify it as bot-directed;
      // otherwise leave the parent unattributed instead of guessing. Alias matches
      // are mention-equivalent for engagement, but they do not prove the parent
      // is bot-authored; enrichment fetches the parent and attributes it.
      replyToBotMessageId: event.parentRef !== undefined && structuredBotMention ? event.parentRef : null,
      mentionsOthers,
      replyToOtherMessageId: null,
      isDm,
      ts: Number.isFinite(ts) ? ts : 0,
    },
  }
}

function isSelfAuthor(event: WebexInboundMessage, botPersonRef: string | null, botPersonEmail: string | null): boolean {
  if (botPersonRef !== null && event.personRef === botPersonRef) return true
  if (botPersonEmail !== null && event.personEmail !== '') {
    return event.personEmail.toLowerCase() === botPersonEmail.toLowerCase()
  }
  return false
}
