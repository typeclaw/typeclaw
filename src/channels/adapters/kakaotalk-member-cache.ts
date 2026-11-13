import type { KakaoMemberSnapshot, KakaoPartialMemberSnapshot } from 'agent-messenger/kakaotalk'

import type { KakaoTalkClient } from './kakaotalk'

const DEFAULT_TTL_MS = 5 * 60 * 1000
const DEFAULT_FAILURE_TTL_MS = 60 * 1000

type Snapshot = KakaoMemberSnapshot | KakaoPartialMemberSnapshot

export type KakaoRosterRead = { snapshot: Snapshot; fetchedAt: number }

type Entry = { result: Promise<KakaoRosterRead>; expiresAt: number }

export type KakaoMemberSnapshotCache = Pick<KakaoTalkClient, 'getMemberSnapshot'> & {
  // `fetchedAt` is when the server answered, never when the cache served it:
  // freshness checks (grant_role's one-minute membership proof) must not be
  // satisfied by an old roster replayed from cache.
  readMemberSnapshot: (chatId: string) => Promise<KakaoRosterRead>
  invalidate: (chatId: string) => void
}

// One GETMEM per chat per TTL, shared by every roster consumer (author names,
// membership counts, mention tags, provisional chat kinds). Each consumer used
// to read the roster on its own, so one inbound message in a group could fire
// several GETMEMs, and a failing read was retried on every message. KakaoTalk
// is a personal account: request volume like that reads as automation and
// risks an account restriction. Failures are cached for a shorter window so a
// transient error heals without hammering the server.
export function createKakaoMemberSnapshotCache(options: {
  client: Pick<KakaoTalkClient, 'getMemberSnapshot'>
  now?: () => number
  ttlMs?: number
  failureTtlMs?: number
}): KakaoMemberSnapshotCache {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS
  const cache = new Map<string, Entry>()

  // Keyed by chat alone: every caller reads with `allowPartial: true`.
  const read = (chatId: string, readOptions: { allowPartial: true }): Promise<KakaoRosterRead> => {
    const cached = cache.get(chatId)
    if (cached !== undefined && cached.expiresAt > now()) return cached.result
    const entry: Entry = { result: Promise.resolve(null as never), expiresAt: Number.POSITIVE_INFINITY }
    entry.result = options.client.getMemberSnapshot(chatId, readOptions).then(
      (snapshot) => {
        const fetchedAt = now()
        entry.expiresAt = fetchedAt + ttlMs
        return { snapshot, fetchedAt }
      },
      (err: unknown) => {
        entry.expiresAt = now() + failureTtlMs
        throw err
      },
    )
    cache.set(chatId, entry)
    return entry.result
  }

  return {
    getMemberSnapshot: async (chatId, readOptions) => (await read(chatId, readOptions)).snapshot,
    readMemberSnapshot: (chatId) => read(chatId, { allowPartial: true }),
    invalidate: (chatId) => {
      cache.delete(chatId)
    },
  }
}
