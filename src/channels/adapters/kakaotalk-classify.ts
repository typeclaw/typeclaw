import { KAKAO_MESSAGE_TYPE, type KakaoTalkPushMessageEvent } from 'agent-messenger/kakaotalk'

import { matchesAnyAlias } from '@/channels/engagement'
import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundAttachment, InboundMessage, InboundReferenceContext } from '@/channels/types'

export type InboundDropReason = 'self_author' | 'empty_text' | 'unknown_chat' | 'pre_connect' | 'bot_message'

// LOCO message_type 71 is KakaoTalk's notification/feed channel — official
// accounts like "KakaoTalk Customer Center" and "Kakao Account" (login alerts,
// security notices, system messages). These arrive in @kakao-group buckets because
// they aren't normal user chats, but they are not human conversation and
// the agent should never reply to them. Not enumerated in
// agent-messenger's `KAKAO_MESSAGE_TYPE` because that const only covers
// user-composable types (TEXT/PHOTO/VIDEO/AUDIO/FILE/MULTIPHOTO).
const KAKAO_NOTIFICATION_MESSAGE_TYPE = 71

export type InboundClassification =
  | { kind: 'drop'; reason: InboundDropReason }
  | { kind: 'route'; payload: InboundMessage }

export type KakaoChatLookup = (chatId: string) => {
  workspace: '@kakao-dm' | '@kakao-group' | '@kakao-open'
  isDm: boolean
} | null

export type KakaoInboundContext = {
  selfUserId: string | null
  lookupChat: KakaoChatLookup
  selfAliases?: readonly string[]
  // The adapter splits attachment refs out of prompt-visible text before
  // classification. Keeping them on context makes classifyInbound's payload
  // construction the single place that stamps InboundMessage fields.
  attachments?: readonly InboundAttachment[]
}

export function classifyInbound(
  event: KakaoTalkPushMessageEvent,
  _config: ChannelAdapterConfig,
  context: KakaoInboundContext,
): InboundClassification {
  if (context.selfUserId === null) {
    return { kind: 'drop', reason: 'pre_connect' }
  }
  if (String(event.author_id) === context.selfUserId) {
    return { kind: 'drop', reason: 'self_author' }
  }
  if (event.message_type === KAKAO_NOTIFICATION_MESSAGE_TYPE) {
    return { kind: 'drop', reason: 'bot_message' }
  }

  const rawText = event.message ?? ''
  const replyContext = parseReplyContext(event, context.selfUserId)
  const text = rawText
  if (text === '') return { kind: 'drop', reason: 'empty_text' }

  const chatInfo = context.lookupChat(event.chat_id)
  if (chatInfo === null) {
    return { kind: 'drop', reason: 'unknown_chat' }
  }

  // A native @-tag carries the tagged user ids in `mentions`. Alias matching
  // stays alongside it because people also address the bot by name without
  // tagging, which the engagement layer treats as equivalent to a mention.
  const mentionedUserIds = (event.mentions ?? []).map((m) => m.user_id)
  const botTagged = mentionedUserIds.includes(context.selfUserId)
  const aliasMatched = matchesAnyAlias(rawText, context.selfAliases ?? [])

  return {
    kind: 'route',
    payload: {
      adapter: 'kakaotalk',
      workspace: chatInfo.workspace,
      chat: event.chat_id,
      thread: null,
      text,
      ...referenceContextPayload(replyContext),
      ...(context.attachments !== undefined && context.attachments.length > 0
        ? { attachments: context.attachments }
        : {}),
      externalMessageId: event.log_id,
      authorId: String(event.author_id),
      authorName: event.author_name ?? String(event.author_id),
      authorIsBot: false,
      isBotMention: botTagged || aliasMatched,
      replyToBotMessageId: replyContext?.target === 'bot' ? replyContext.logId : null,
      mentionsOthers: mentionedUserIds.length > 0 && !botTagged,
      replyToOtherMessageId: replyContext?.target === 'other' ? replyContext.logId : null,
      isDm: chatInfo.isDm,
      // SDK delivers `sent_at` in Unix seconds (LOCO `sendAt`); contract
      // wants ms (see `src/channels/types.ts`). Without `* 1000`, ms-based
      // renderers (inspect -f, etc.) produce 1970-01-21-shaped dates.
      ts: event.sent_at * 1000,
    },
  }
}

type ParsedReplyContext = {
  logId: string
  authorId: string
  authorName: string
  quotedText: string | null
  target: 'bot' | 'other'
}

function parseReplyContext(event: KakaoTalkPushMessageEvent, selfUserId: string): ParsedReplyContext | null {
  if (event.message_type !== KAKAO_MESSAGE_TYPE.REPLY) return null
  if (event.attachment === null) return null

  const logId = scalarIdField(event.attachment, 'src_logId')
  const sourceAuthorId = decimalIdField(event.attachment, 'src_userId')
  if (logId === null || sourceAuthorId === null) return null

  const quotedText = stringField(event.attachment, 'src_message')
  return {
    logId,
    authorId: sourceAuthorId,
    // classifyInbound is synchronous and has no cheap author resolver access;
    // fall back to Kakao's stable source user id rather than fetching.
    authorName: sourceAuthorId,
    quotedText,
    target: sourceAuthorId === selfUserId ? 'bot' : 'other',
  }
}

function referenceContextPayload(
  replyContext: ParsedReplyContext | null,
): { referenceContext: InboundReferenceContext } | Record<string, never> {
  if (replyContext === null || replyContext.quotedText === null || replyContext.quotedText.trim() === '') return {}
  return {
    referenceContext: {
      kind: 'reply',
      sources: [
        {
          adapter: 'kakaotalk',
          authorId: replyContext.authorId,
          authorName: replyContext.authorName,
          text: replyContext.quotedText,
        },
      ],
    },
  }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

// LOCO reply attachments are unvalidated `JSON.parse` output: `src_userId` arrives
// as a string in production despite the SDK annotating it `number`, so a number-only
// reader dropped every reply-to-bot. `src_userId` gates the bot-vs-other identity
// check, so require digits and keep it as an opaque string — never `Number()` a
// 64-bit id (lossy past 2^53).
function decimalIdField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return /^\d+$/.test(trimmed) ? trimmed : null
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? String(value) : null
  }
  return null
}

// `src_logId` is an opaque message reference we only echo back, never compare for
// identity, so accept any non-empty scalar (string or integer) without digit-gating.
function scalarIdField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? String(value) : null
  }
  return null
}
