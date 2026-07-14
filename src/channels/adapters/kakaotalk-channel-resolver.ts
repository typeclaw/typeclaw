import { classifyKakaoChat, type KakaoChat, type KakaoChatKind, type KakaoTalkClient } from 'agent-messenger/kakaotalk'

import type { ChannelKey, ChannelNameResolver, ResolvedChannelNames } from '@/channels/types'

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
  provisional: boolean
}

export type KakaoChannelResolver = {
  resolve: ChannelNameResolver
  lookupChat: (chatId: string) => KakaoChatLookupValue | null
  refresh: () => Promise<void>
  // Register a chat we learned about from an inbound push event, used as a
  // fallback when `refresh()` did not surface it (e.g. memo chats, certain
  // open chats, or chats whose membership has not yet propagated to
  // getChats({all:true})). Provisional entries default to @kakao-group —
  // the strictest bucket, matching the history callback's existing fallback
  // — so allow-rule enforcement stays strict. A subsequent real refresh
  // upgrades the entry to its authoritative kind.
  ingestProvisional: (chatId: string) => void
}

export type KakaoChannelResolverOptions = {
  client: Pick<KakaoTalkClient, 'getChats'>
  now?: () => number
  ttlMs?: number
  logger?: { warn: (msg: string) => void }
}

type Entry = {
  workspace: KakaoWorkspace
  isDm: boolean
  provisional: boolean
  chatName: string | null
  expiresAt: number
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
      options.logger?.warn(`[kakaotalk] channel resolver refresh failed: ${describe(err)}`)
    }
  }

  const ingest = (chat: KakaoChat, expiresAt: number): void => {
    const kind = classifyKakaoChat(chat)
    const workspace = kakaoWorkspaceForType(kind)
    cache.set(chat.chat_id, {
      workspace,
      isDm: kind === 'dm',
      provisional: false,
      chatName: chat.title ?? chat.display_name,
      expiresAt,
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

  const ingestProvisional = (chatId: string): void => {
    const existing = cache.get(chatId)
    if (existing !== undefined && existing.expiresAt > now()) return
    cache.set(chatId, {
      workspace: '@kakao-group',
      isDm: false,
      provisional: true,
      chatName: null,
      expiresAt: now() + ttlMs,
    })
  }

  return { resolve, lookupChat, refresh, ingestProvisional }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
