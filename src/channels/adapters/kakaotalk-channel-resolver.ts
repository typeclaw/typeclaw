import { classifyKakaoChat, type KakaoChat, type KakaoChatKind, type KakaoMember } from 'agent-messenger/kakaotalk'

import type { ChannelKey, ChannelNameResolver, ResolvedChannelNames } from '@/channels/types'

import { describeError } from '../describe-error'
import type { KakaoTalkClient } from './kakaotalk'

const DEFAULT_TTL_MS = 5 * 60 * 1000

export type KakaoWorkspace = '@kakao-dm' | '@kakao-group' | '@kakao-open'

export function kakaoWorkspaceForType(kind: KakaoChatKind): KakaoWorkspace {
  if (kind === 'dm') return '@kakao-dm'
  if (kind === 'open') return '@kakao-open'
  return '@kakao-group'
}

export type KakaoChatLookupValue = {
  workspace: KakaoWorkspace
  isDm: boolean
  // True while the entry is a strict fallback guess (@kakao-group) — the chat
  // is absent from getChats and its member roster proved nothing. Callers that
  // must know the real type decide per-feature: typing sends for provisional
  // entries (the @kakao-group guess is never @kakao-open, and a mis-guessed
  // OpenChat's linkless ACTION fails soft), while allow-rule enforcement keeps
  // treating the strict bucket as authoritative until a real refresh upgrades
  // it.
  provisional: boolean
}

// What a member roster PROVES about a chat — never what it merely suggests.
//
// A roster read is only ever a SUBSET of the true membership: it is read with
// `allowPartial`, and GETMEM can return fewer records than the room has active
// members. So only conclusions that survive adding unseen members are sound:
//
//   - an open marker present proves OpenChat — a subset cannot invent one
//     (`open_token` / `open_profile_link_id` / `open_permission` are
//     SDK-populated for OpenChat rooms only)
//   - two or more counterparts proves not-a-DM — adding members keeps it true
//
// "Exactly one counterpart" proves NOTHING, because the remainder may simply be
// unobserved. So a DM is never inferred here; callers keep the strict bucket.
// Do NOT "restore" a `others.length <= 1 -> dm` branch: a truncated roster for a
// large room would then be cached as an authoritative DM, relaxing both the
// engagement ladder and `kakao:dm/*` allow-rule matching.
export function provenKindFromMembers(
  members: readonly KakaoChatMemberSignal[],
  selfUserId: string | null,
): Extract<KakaoChatKind, 'open' | 'group'> | null {
  if (members.some(isOpenChatMember)) return 'open'
  const others = members.filter((member) => member.user_id !== selfUserId)
  return others.length >= 2 ? 'group' : null
}

export type KakaoChatMemberSignal = Pick<
  KakaoMember,
  'user_id' | 'open_token' | 'open_profile_link_id' | 'open_permission'
>

function isOpenChatMember(member: KakaoChatMemberSignal): boolean {
  return member.open_token !== null || member.open_profile_link_id !== null || member.open_permission !== null
}

export type KakaoChannelResolver = {
  resolve: ChannelNameResolver
  lookupChat: (chatId: string) => KakaoChatLookupValue | null
  refresh: () => Promise<void>
  // Register a chat we learned about from an inbound push event, used as a
  // fallback when `refresh()` did not surface it (e.g. memo chats, certain
  // open chats, or chats whose membership has not yet propagated to
  // getChats({all:true})). Upgrades the entry only to what a per-chat member
  // read PROVES, and otherwise falls back to @kakao-group — the strictest
  // bucket, matching the history callback's existing fallback — so allow-rule
  // enforcement stays strict on chats the roster could not establish.
  // Returns the bucket it settled on so callers can log the real outcome.
  ingestProvisional: (chatId: string) => Promise<KakaoWorkspace>
}

export type KakaoChannelResolverOptions = {
  client: Pick<KakaoTalkClient, 'getChats' | 'getMemberSnapshot'>
  now?: () => number
  ttlMs?: number
  logger?: { warn: (msg: string) => void }
  selfUserId?: () => string | null
}

type Entry = {
  workspace: KakaoWorkspace
  isDm: boolean
  chatName: string | null
  expiresAt: number
  provisional: boolean
}

export function createKakaoChannelResolver(options: KakaoChannelResolverOptions): KakaoChannelResolver {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const cache = new Map<string, Entry>()
  let inflight: Promise<void> | null = null

  const refresh = async (): Promise<void> => {
    if (inflight !== null) {
      await inflight
      return
    }
    const promise = loadAll().finally(() => {
      inflight = null
    })
    inflight = promise
    await promise
  }

  const loadAll = async (): Promise<void> => {
    try {
      const chats = await options.client.getChats({ all: true })
      const expiresAt = now() + ttlMs
      for (const chat of chats) ingest(chat, expiresAt)
    } catch (err) {
      options.logger?.warn(`[kakaotalk] channel resolver refresh failed: ${describeError(err)}`)
    }
  }

  const ingest = (chat: KakaoChat, expiresAt: number): void => {
    const kind = classifyKakaoChat(chat)
    const workspace = kakaoWorkspaceForType(kind)
    cache.set(chat.chat_id, {
      workspace,
      isDm: kind === 'dm',
      chatName: chat.title ?? chat.display_name,
      expiresAt,
      provisional: false,
    })
  }

  const resolve: ChannelNameResolver = async (key: ChannelKey): Promise<ResolvedChannelNames> => {
    const entry = cache.get(key.chat)
    if (entry === undefined || entry.expiresAt <= now()) await refresh()
    const fresh = cache.get(key.chat)
    if (fresh === undefined) return {}
    const result: ResolvedChannelNames = {}
    if (fresh.chatName !== null && fresh.chatName !== '') result.chatName = fresh.chatName
    return result
  }

  // Sync lookup. Returns null when the entry is missing OR stale; callers
  // (e.g. inbound classification, history allow checks) MUST treat null as
  // "refresh needed", not "unknown forever". The classifier handles this
  // by awaiting `refresh()` and re-checking before dropping the message —
  // see kakaotalk.ts handleMessageEvent.
  const lookupChat = (chatId: string): KakaoChatLookupValue | null => {
    const entry = cache.get(chatId)
    if (entry === undefined || entry.expiresAt <= now()) return null
    return { workspace: entry.workspace, isDm: entry.isDm, provisional: entry.provisional }
  }

  const liveEntry = (chatId: string): Entry | null => {
    const entry = cache.get(chatId)
    return entry !== undefined && entry.expiresAt > now() ? entry : null
  }

  const provenKindFor = async (chatId: string): Promise<'open' | 'group' | null> => {
    try {
      const snapshot = await options.client.getMemberSnapshot(chatId, { allowPartial: true })
      return provenKindFromMembers(snapshot.members, options.selfUserId?.() ?? null)
    } catch (err) {
      options.logger?.warn(`[kakaotalk] provisional member lookup failed chat=${chatId}: ${describeError(err)}`)
      return null
    }
  }

  const ingestProvisional = async (chatId: string): Promise<KakaoWorkspace> => {
    const cached = liveEntry(chatId)
    if (cached !== null) return cached.workspace

    const kind = await provenKindFor(chatId)

    // The member read was awaited, so a concurrent `refresh()` may have landed
    // a getChats-authoritative entry meanwhile. Re-check instead of writing
    // blind: clobbering it would replace a real classification with a weaker
    // member-derived one — or with the strict fallback — for a whole TTL.
    const current = liveEntry(chatId)
    if (current !== null && !current.provisional) return current.workspace

    const workspace = kind === null ? '@kakao-group' : kakaoWorkspaceForType(kind)
    cache.set(chatId, {
      workspace,
      isDm: false,
      chatName: null,
      expiresAt: now() + ttlMs,
      provisional: kind === null,
    })
    return workspace
  }

  return { resolve, lookupChat, refresh, ingestProvisional }
}
