import type { TeamsRealtimeMessage, TeamsUser } from 'agent-messenger/teams'

import { matchesAnyAlias } from '@/channels/engagement'
import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage } from '@/channels/types'

import type { TeamsChatInfo } from './teams'
import { encodeTeamsChannelKey, encodeTeamsChatKey } from './teams-key'

export type TeamsInboundEvent = TeamsRealtimeMessage

export type InboundDropReason = 'self_author' | 'empty_content' | 'pre_connect' | 'unknown_chat' | 'unknown_channel'

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

// Resolved (teamId, channelId) for a channel realtime event. The SDK only
// emits `conversationType: 'channel'` once it has mapped the thread to a team,
// so both ids are guaranteed present by the time the adapter builds this.
export type TeamsChannelInfo = { teamId: string; channelId: string }

// A message the agent's own account sent is delivered back over the socket.
// Chat vs channel routing keys differ, but every routed inbound shares the
// engagement contract below. Chat DMs engage via the `dm` trigger; group chats
// and channels engage ONLY when the bot is explicitly addressed — by a
// structured mention whose display name matches, or by the bot's alias in the
// (mention-stripped) text — and otherwise fail closed via
// `suppressSticky`/`mentionsOthers` so the agent never barges into a
// conversation it was not named in.
export function classifyChatInbound(
  event: TeamsInboundEvent,
  _config: ChannelAdapterConfig,
  self: TeamsUser | null,
  chat: TeamsChatInfo | undefined,
  selfAliases: readonly string[] = [],
): InboundClassification {
  if (self === null) return { kind: 'drop', reason: 'pre_connect' }
  if (chat === undefined) return { kind: 'drop', reason: 'unknown_chat' }

  const text = event.content.trim()
  if (text === '') return { kind: 'drop', reason: 'empty_content' }

  const isDm = chat.type === 'oneOnOne' || chat.type === 'self'
  const addressed = isAddressedToBot(event, self, selfAliases)

  return {
    kind: 'route',
    payload: buildPayload({
      event,
      chat: encodeTeamsChatKey(event.chatId),
      isDm,
      addressed,
      text,
    }),
  }
}

export function classifyChannelInbound(
  event: TeamsInboundEvent,
  _config: ChannelAdapterConfig,
  self: TeamsUser | null,
  channel: TeamsChannelInfo,
  selfAliases: readonly string[] = [],
): InboundClassification {
  if (self === null) return { kind: 'drop', reason: 'pre_connect' }

  const text = event.content.trim()
  if (text === '') return { kind: 'drop', reason: 'empty_content' }

  const addressed = isAddressedToBot(event, self, selfAliases)

  return {
    kind: 'route',
    payload: buildPayload({
      event,
      chat: encodeTeamsChannelKey(channel.teamId, channel.channelId),
      isDm: false,
      addressed,
      text,
    }),
  }
}

function buildPayload(args: {
  event: TeamsInboundEvent
  chat: string
  isDm: boolean
  addressed: boolean
  text: string
}): InboundMessage {
  const { event, chat, isDm, addressed, text } = args
  const ts = Date.parse(event.timestamp)
  return {
    adapter: 'teams',
    workspace: 'teams',
    chat,
    thread: null,
    text,
    externalMessageId: event.id,
    authorId: event.author.id,
    authorName: event.author.displayName,
    authorIsBot: false,
    isBotMention: addressed,
    // Teams sends expose no parent id on the realtime event, so a reply can
    // never be attributed to a specific prior message.
    replyToBotMessageId: null,
    // Non-DM traffic (group chat + channel) fails closed: an unaddressed
    // message is marked `mentionsOthers` (suppresses the solo-human fallback)
    // and `suppressSticky` (stops a prior addressed turn from keeping the agent
    // engaged on later unaddressed messages). Neither fires in a DM.
    suppressSticky: !isDm && !addressed,
    mentionsOthers: !isDm && !addressed,
    replyToOtherMessageId: null,
    isDm,
    ts: Number.isFinite(ts) ? ts : 0,
  }
}

// The realtime `content` has had its `<at>` mention HTML stripped by the SDK,
// but the structured `mentions[]` array survives — match the bot by a mention
// whose display name is the bot's name or a configured alias. `mentions[].mri`
// is NOT used for self-matching: `testAuth()` returns the placeholder id `'ME'`,
// so the adapter cannot know its own MRI to compare against. Alias text
// matching stays as a fallback for when a user types the bot's name without a
// real @mention (in which case `mentions[]` is empty).
function isAddressedToBot(event: TeamsInboundEvent, self: TeamsUser, selfAliases: readonly string[]): boolean {
  const selfNames = [self.displayName, ...selfAliases].map((name) => name.trim().toLocaleLowerCase())
  // A structured mention names one specific person, so it must match a self
  // name EXACTLY — substring matching would wrongly treat a mention of
  // "Build Bot" as addressing a bot named "Bot". The plain-text fallback below
  // stays a substring match (matchesAnyAlias lowercases only the haystack, so
  // its needles must be pre-lowercased), because free text has no such
  // one-name-per-token guarantee.
  const structuredSelfMention = event.mentions.some((mention) =>
    selfNames.includes(mention.displayName.trim().toLocaleLowerCase()),
  )
  if (structuredSelfMention) return true
  return matchesAnyAlias(event.content, selfNames)
}

export function normalizeTeamsText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// Teams is the only adapter whose classifier never returns `self_author` — the
// user SDK reports `'ME'` for every author, so the send/echo fingerprint is the
// ONLY thing standing between the agent and answering its own message. That
// makes the comparison worth hardening: we fingerprint what we handed the SDK,
// but Teams stores messages as HTML, so the text comes back escaped-then-decoded
// and the two sides are not the same string. How many entity layers come back
// depends on the SDK and the message shape: a tag-free channel body without a
// `messagetype` returns still escaped, a typed body is decoded once, and older
// SDKs decoded lossily (`&amp;lt;` -> `<`). Any mismatch would miss the
// reservation and route the agent's message back in as inbound. Decoding both
// sides until no entity layer remains gives the same key for every one of those
// shapes; on text holding no entities it is a no-op.
export function teamsEchoTextKey(text: string): string {
  let decoded = text
  for (;;) {
    const next = decodeTeamsEntities(decoded)
    if (next === decoded) break
    decoded = next
  }
  return normalizeTeamsText(decoded)
}

function decodeTeamsEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}
