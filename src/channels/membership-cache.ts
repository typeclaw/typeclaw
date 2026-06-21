import {
  MEMBERSHIP_CACHE_PERMANENT_TTL_MS,
  MEMBERSHIP_CACHE_TRANSIENT_TTL_MS,
  MEMBERSHIP_CACHE_TTL_MS,
  type MembershipCount,
  type MembershipResolver,
  type MembershipResolverFailure,
  type MembershipResolverResult,
} from './membership'
import type { ChannelKey } from './types'
import { channelKeyId, channelKeyLabel } from './types'

export type MembershipCacheRead =
  | { kind: 'hit'; membership: MembershipCount | null }
  | { kind: 'stale'; membership: MembershipCount }
  | { kind: 'miss' }

type CacheEntry = {
  result: MembershipResolverResult
  expiresAt: number
  servedStale: boolean
}

export type MembershipCacheLogger = {
  warn: (msg: string) => void
}

export type MembershipCacheOptions = {
  resolver: MembershipResolver
  now?: () => number
  logger?: MembershipCacheLogger
}

export type MembershipCache = {
  read: (key: ChannelKey) => MembershipCacheRead
  get: (key: ChannelKey) => MembershipCount | null
  warmUp: (key: ChannelKey) => Promise<MembershipCount | null>
  invalidate: (key: ChannelKey) => void
}

export function createMembershipCache(options: MembershipCacheOptions): MembershipCache {
  const now = options.now ?? Date.now
  const entries = new Map<string, CacheEntry>()
  const inFlight = new Map<string, Promise<MembershipCount | null>>()

  const read = (key: ChannelKey): MembershipCacheRead => {
    const entry = entries.get(channelKeyId(key))
    if (entry === undefined) return { kind: 'miss' }

    if (entry.expiresAt > now()) return { kind: 'hit', membership: toMembership(entry.result) }
    if (isMembershipCount(entry.result) && !entry.servedStale) {
      entry.servedStale = true
      return { kind: 'stale', membership: entry.result }
    }
    return { kind: 'miss' }
  }

  const warmUp = (key: ChannelKey): Promise<MembershipCount | null> => {
    const keyId = channelKeyId(key)
    const cached = read(key)
    if (cached.kind === 'hit') return Promise.resolve(cached.membership)
    if (cached.kind === 'stale') return Promise.resolve(cached.membership)

    const existing = inFlight.get(keyId)
    if (existing !== undefined) return existing

    const promise = resolveAndStore(key, keyId).finally(() => {
      inFlight.delete(keyId)
    })
    inFlight.set(keyId, promise)
    return promise
  }

  const resolveAndStore = async (key: ChannelKey, keyId: string): Promise<MembershipCount | null> => {
    let result: MembershipResolverResult
    try {
      result = await options.resolver(key)
    } catch (err) {
      options.logger?.warn(`[channels] membership resolver threw for ${channelKeyLabel(key)}: ${describe(err)}`)
      result = { kind: 'transient' }
    }
    entries.set(keyId, { result, expiresAt: now() + ttlFor(result), servedStale: false })
    return toMembership(result)
  }

  return {
    read,
    get: (key) => {
      const cached = read(key)
      return cached.kind === 'hit' ? cached.membership : null
    },
    warmUp,
    invalidate: (key) => {
      entries.delete(channelKeyId(key))
    },
  }
}

function ttlFor(result: MembershipResolverResult): number {
  if (isMembershipCount(result)) return MEMBERSHIP_CACHE_TTL_MS
  return result.kind === 'permanent' ? MEMBERSHIP_CACHE_PERMANENT_TTL_MS : MEMBERSHIP_CACHE_TRANSIENT_TTL_MS
}

function toMembership(result: MembershipResolverResult): MembershipCount | null {
  return isMembershipCount(result) ? result : null
}

function isMembershipCount(result: MembershipResolverResult): result is MembershipCount {
  return 'humans' in result
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export type { MembershipResolverFailure }
