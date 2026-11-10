import { describeError } from '../describe-error'
import type {
  MembershipCount,
  MembershipResolver,
  MembershipResolverFailure,
  MembershipResolverResult,
} from '../membership'
import type { KakaoTalkClient } from './kakaotalk'

export type KakaoMembershipResolverOptions = {
  client: Pick<KakaoTalkClient, 'getMemberSnapshot'>
  // The logged-in agent's own KakaoTalk user_id. Returned in the roster
  // alongside every human in the room, so it must be excluded from the
  // human count — otherwise a 1:1 chat (agent + one human) reports two
  // humans and a real group is off by one. Null before login completes,
  // in which case we cannot prove self-exclusion and fail closed.
  selfUserIdRef: () => string | null
  logger: { warn: (msg: string) => void }
  now?: () => number
}

// Without a registered resolver the router's `resolveEffectiveHumans` falls
// back to `persistedHumans` — only humans who already posted in the live
// session. On a cold-started group that is just the sender, tripping the
// engagement layer's solo-human "answer everything" fallback so the agent
// replies to messages aimed at others. Every other adapter registers a
// resolver; KakaoTalk was the lone gap. The roster is read with `allowPartial`:
// GETMEM can return fewer records than the room's active member count (large
// open chats), where the strict read throws on every call. A complete snapshot
// is reported as non-truncated with its member ids; a partial one is reported
// as truncated without ids, counting humans from the room's active member count, so consumers that need a completeness proof fail
// closed. We never opt into `allowRoomEntry`, because CHATONROOM can advance
// the account's unread state.
// Room rosters list only human accounts plus the agent's own; hence
// `humans = roster excluding self` and `bots: 1` (the agent) — `bots: 0` would
// defeat the engagement layer's peer-bot loop suppression.
export function createKakaoMembershipResolver(options: KakaoMembershipResolverOptions): MembershipResolver {
  const now = options.now ?? Date.now
  return async (key): Promise<MembershipResolverResult> => {
    if (key.adapter !== 'kakaotalk') return { kind: 'permanent' } satisfies MembershipResolverFailure
    const selfUserId = options.selfUserIdRef()
    if (selfUserId === null) {
      // Pre-login: we cannot exclude ourselves from the roster, so any count
      // would over-report humans by one. Fail transient so the router keeps
      // its `persistedHumans` fallback and retries once we have identity.
      return { kind: 'transient' } satisfies MembershipResolverFailure
    }
    try {
      const snapshot = await options.client.getMemberSnapshot(key.chat, { allowPartial: true })
      // Dedupe by user_id defensively; a roster should not repeat a member.
      const memberIds = new Set<string>()
      for (const m of snapshot.members) memberIds.add(m.user_id)
      memberIds.delete(selfUserId)
      const humanMemberIds = [...memberIds]
      if (!snapshot.complete) {
        // The returned records can be a tiny slice of a large room. The
        // server's active count (which includes the agent) keeps the
        // approximate total from collapsing to the solo-human fallback.
        const humans = Math.max(humanMemberIds.length, snapshot.active_members - 1)
        return { humans, bots: 1, fetchedAt: now(), truncated: true } satisfies MembershipCount
      }
      return {
        humans: humanMemberIds.length,
        bots: 1,
        fetchedAt: now(),
        truncated: false,
        humanMemberIds,
      } satisfies MembershipCount
    } catch (err) {
      options.logger.warn(`[kakaotalk] membership chat=${key.chat} failed: ${describeError(err)}`)
      return { kind: 'transient' } satisfies MembershipResolverFailure
    }
  }
}
