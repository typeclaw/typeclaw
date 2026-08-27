import type { DiscordGatewayMessageCreateEvent } from 'agent-messenger/discord'

import { matchesAnyAlias } from '@/channels/engagement'
import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundAttachment, InboundMessage } from '@/channels/types'

import { encodeDiscordReactionRef } from './discord-reactions'

export type DiscordInboundMessageEvent = DiscordGatewayMessageCreateEvent

// WORKAROUND: the USER-token SDK type omits `author.bot` and
// `message_reference`, but the listener spreads the raw Discord payload
// (`{ ...d }`), so both fields exist at runtime. Narrow locally instead of
// augmenting the SDK type globally — do not "simplify" this away.
export type RawDiscordMessageCreateEvent = DiscordGatewayMessageCreateEvent & {
  author: { bot?: boolean }
  message_reference?: { message_id?: string; channel_id?: string; guild_id?: string }
}

export type InboundDropReason = 'self_author' | 'no_user' | 'empty_content' | 'pre_connect'

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

export type DiscordInboundContext = {
  selfUserId: string | null
  selfAliases?: readonly string[]
}

export function classifyInbound(
  event: DiscordInboundMessageEvent,
  _config: ChannelAdapterConfig,
  context: DiscordInboundContext,
): InboundClassification {
  if (context.selfUserId !== null && event.author.id === context.selfUserId)
    return { kind: 'drop', reason: 'self_author' }
  if (event.author.id === '') return { kind: 'drop', reason: 'no_user' }
  const { text, attachments } = splitInbound(event)
  if (text === '') return { kind: 'drop', reason: 'empty_content' }
  if (context.selfUserId === null) return { kind: 'drop', reason: 'pre_connect' }

  const isDm = event.guild_id === undefined
  const workspace = isDm ? '@dm' : (event.guild_id ?? '')
  const hasGroupMention = GROUP_MENTION_PATTERN.test(event.content)
  const isBotMention =
    hasGroupMention ||
    event.content.includes(`<@${context.selfUserId}>`) ||
    event.content.includes(`<@!${context.selfUserId}>`)
  const aliasMatched = !isBotMention && matchesAnyAlias(event.content, context.selfAliases ?? [])
  const mentionedUsers = event.mentions ?? []
  const mentionsOthers = mentionedUsers.length > 0 && !mentionedUsers.some((user) => user.id === context.selfUserId)

  const raw = event as RawDiscordMessageCreateEvent
  const replyToParentId = raw.message_reference?.message_id
  const replyToBotMessageId =
    replyToParentId !== undefined && isReplyToSelf(raw, context.selfUserId) ? replyToParentId : null
  const replyToOtherMessageId = replyToParentId !== undefined && replyToBotMessageId === null ? replyToParentId : null

  return {
    kind: 'route',
    payload: {
      adapter: 'discord',
      workspace,
      chat: event.channel_id,
      thread: null,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      externalMessageId: event.id,
      reactionRef: encodeDiscordReactionRef({ channel: event.channel_id, message: event.id }),
      authorId: event.author.id,
      authorName: event.author.username,
      authorIsBot: raw.author.bot === true,
      isBotMention: isBotMention || aliasMatched,
      replyToBotMessageId,
      mentionsOthers,
      replyToOtherMessageId,
      isDm,
      ts: parseDiscordTimestamp(event.timestamp),
    },
  }
}

// `message_reference` carries only the parent id, not its author, so we infer
// "this reply targets us" from the auto-mention Discord injects into the
// reply's `mentions` array (same trick as the bot adapter). Named "...Self"
// because the user-token identity is a Discord user; the payload field stays
// `replyToBotMessageId` to match the InboundMessage contract.
function isReplyToSelf(event: RawDiscordMessageCreateEvent, selfUserId: string): boolean {
  return (event.mentions ?? []).some((m) => m.id === selfUserId)
}

const GROUP_MENTION_PATTERN = /@(?:everyone|here)/

type SplitInbound = { text: string; attachments: InboundAttachment[] }

function splitInbound(event: DiscordInboundMessageEvent): SplitInbound {
  return splitDiscordAttachments(event.content, event)
}

// Structural so the REST history shape and the gateway event shape share one
// implementation. Exported because `discord.ts`'s history mapper bypasses the
// classifier: without reusing this, an already-posted image renders with no
// `#N` placeholder and registers no ref, so look_at_channel_attachment can
// never resolve it. Same contract discord-bot/slack-bot already document.
export type DiscordAttachmentCarrier = {
  attachments?: readonly { url: string; filename: string; content_type?: string }[]
}

export function splitDiscordAttachments(text: string, carrier: DiscordAttachmentCarrier): SplitInbound {
  const attachments = (carrier.attachments ?? []).map((attachment, index) => ({
    id: index + 1,
    kind: 'file' as const,
    ref: attachment.url,
    filename: attachment.filename,
    ...(attachment.content_type !== undefined ? { mimetype: attachment.content_type } : {}),
  }))
  if (attachments.length === 0) return { text, attachments: [] }
  const summary = attachments.map(renderPlaceholder).join('\n')
  return { text: text === '' ? summary : `${text}\n${summary}`, attachments }
}

function renderPlaceholder(attachment: InboundAttachment): string {
  const parts: string[] = [`Discord attachment #${attachment.id}: ${attachment.kind}`]
  if (attachment.mimetype !== undefined) parts.push(attachment.mimetype)
  if (attachment.filename !== undefined) parts.push(`name=${attachment.filename}`)
  return `[${parts.join(' ')}]`
}

function parseDiscordTimestamp(timestamp: string): number {
  const millis = Date.parse(timestamp)
  return Number.isFinite(millis) ? millis : 0
}
