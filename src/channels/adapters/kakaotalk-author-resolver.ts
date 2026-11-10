import { describeError } from '../describe-error'
import type { KakaoTalkClient } from './kakaotalk'

const DEFAULT_TTL_MS = 5 * 60 * 1000

export type KakaoAuthorResolver = {
  resolve: (authorId: string, chatId: string) => Promise<string | null>
}

export type KakaoAuthorResolverOptions = {
  client: Pick<KakaoTalkClient, 'getMemberSnapshot'>
  now?: () => number
  ttlMs?: number
  logger?: { warn: (msg: string) => void }
}

type ChatCacheEntry = {
  members: Map<string, string>
  expiresAt: number
}

// Resolves author IDs to nicknames via LOCO GETMEM (one call per chat per
// TTL window). Only invoked when the inline `author_name` from the chat-
// list snapshot is missing — the agent-messenger client already covers
// "display members" (~5 per chat) for free, and this resolver fills the
// gap for larger groups and open chats.
//
// Lazy by design: a chat's member list is fetched on the first lookup
// miss, not eagerly on connect. Most agent folders watch a small handful
// of chats; prefetching every chat's member list at startup would burn
// LOCO calls on rooms the agent never sees a message in.
export function createKakaoAuthorResolver(options: KakaoAuthorResolverOptions): KakaoAuthorResolver {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const logger = options.logger
  const cache = new Map<string, ChatCacheEntry>()
  const inflight = new Map<string, Promise<ChatCacheEntry | null>>()

  const fetchMembers = (chatId: string): Promise<ChatCacheEntry | null> => {
    const existing = inflight.get(chatId)
    if (existing !== undefined) return existing
    const promise = options.client
      .getMemberSnapshot(chatId, { allowPartial: true })
      .then((snapshot): ChatCacheEntry => {
        // A partial roster still names most authors; misses fall back to the
        // raw user_id exactly as a failed read does.
        const map = new Map<string, string>()
        for (const m of snapshot.members) map.set(m.user_id, m.nickname)
        const entry: ChatCacheEntry = { members: map, expiresAt: now() + ttlMs }
        cache.set(chatId, entry)
        return entry
      })
      .catch((err: unknown): null => {
        // Author resolution is best-effort. Failing here makes the message
        // render with the raw user_id, which is uglier but still routes.
        logger?.warn(`[kakaotalk] getMemberSnapshot(${chatId}) failed: ${describeError(err)}`)
        return null
      })
      .finally(() => {
        inflight.delete(chatId)
      })
    inflight.set(chatId, promise)
    return promise
  }

  const resolve = async (authorId: string, chatId: string): Promise<string | null> => {
    const cached = cache.get(chatId)
    if (cached !== undefined && cached.expiresAt > now()) {
      return cached.members.get(authorId) ?? null
    }
    const fresh = await fetchMembers(chatId)
    if (fresh === null) return null
    return fresh.members.get(authorId) ?? null
  }

  return { resolve }
}
