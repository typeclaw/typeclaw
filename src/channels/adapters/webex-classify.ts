// WebexListenerEventMap requires agent-messenger/webex (PR #239); resolves via linked upstream.
import type { WebexListenerEventMap } from 'agent-messenger/webex'

import { matchesAnyAlias } from '@/channels/engagement'
import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

import { splitWebexFiles } from './webex-format'

export type WebexInboundMessage = WebexListenerEventMap['message_created'][0]

export type InboundDropReason = 'self_author' | 'empty_content' | 'pre_connect'

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

// `botPersonRef` is the bot's decoded UUID ref (from WebexPerson.ref), matched
// against the event's *Ref fields so identity comparison happens entirely in
// ref-space — the same currency typeclaw now stores as ChannelKey/authorId.
//
// `botPersonEmail` is a second self-identity anchor: legacy Hydra accounts can
// surface the bot's ref as an email on one side (`/people/me`) and a UUID on the
// other (Mercury event), so a ref-only check leaks the agent's own reply back as
// a new inbound and burns a full prompt cycle. Matching personEmail closes that
// echo loop regardless of which side decoded to which form.
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
      adapter: 'webex',
      // Webex message events do not include an org/team id; the room ref is the
      // stable permission bucket for group spaces while DMs use the shared key.
      // The decoded UUID ref is stored (not the base64 REST id) so the persisted
      // key is human-readable; the SDK re-encodes it for outbound calls.
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
      // Webex Mercury only exposes the parent ref inline, not the parent author.
      // When the reply has a structured bot mention we can identify it as
      // bot-directed; otherwise leave the parent unattributed instead of guessing.
      // Alias matches are mention-equivalent for engagement, but they do not prove
      // the parent is bot-authored; enrichment fetches the parent and attributes it.
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
