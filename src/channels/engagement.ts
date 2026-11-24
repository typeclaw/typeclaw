import type { ChannelParticipant } from '@/agent/session-origin'

import { MEMBERSHIP_FRESHNESS_MS, type MembershipCount } from './membership'
import type { EngagementConfig } from './schema'
import type { InboundMessage } from './types'

export type EngagementDecision = 'engage' | 'observe'

export type StickyCredit = { authorId: string; expiresAt: number }

// Per-key sticky credit ledger. Each key (channel tuple) carries at most one
// active credit per author at a time (subsequent grants overwrite expiry).
export class StickyLedger {
  private byKey = new Map<string, Map<string, number>>()

  grant(key: string, authorId: string, expiresAt: number): void {
    let inner = this.byKey.get(key)
    if (!inner) {
      inner = new Map()
      this.byKey.set(key, inner)
    }
    inner.set(authorId, expiresAt)
  }

  // A live credit SLIDES its window forward (`now + windowMs`) rather than
  // clearing on first spend. The send-path only re-grants after the reply lands
  // (router `send()`), so a same-author follow-up arriving in that gap finds no
  // credit and observes in a multi-human group (the solo-human fallback masks it
  // in 1-human channels). A refreshed credit keeps that follow-up engaged and
  // still expires after a full quiet window. An expired credit is purged and
  // returns false (the expired-credit contract). `windowMs <= 0` purges on spend.
  consume(key: string, authorId: string, now: number, windowMs: number): boolean {
    const inner = this.byKey.get(key)
    if (!inner) return false
    const expiresAt = inner.get(authorId)
    if (expiresAt === undefined) return false
    if (expiresAt > now && windowMs > 0) {
      inner.set(authorId, now + windowMs)
      return true
    }
    inner.delete(authorId)
    if (inner.size === 0) this.byKey.delete(key)
    return expiresAt > now
  }

  has(key: string, authorId: string, now: number): boolean {
    const expiresAt = this.byKey.get(key)?.get(authorId)
    return expiresAt !== undefined && expiresAt > now
  }

  clear(key: string): number {
    const cleared = this.byKey.get(key)?.size ?? 0
    this.byKey.delete(key)
    return cleared
  }
}

export type EngagementInput = {
  message: InboundMessage
  config: EngagementConfig
  key: string
  ledger: StickyLedger
  now: number
  // Router updates this cache with the current sender BEFORE calling here,
  // so a fresh channel's first human message arrives with length 1. Peer
  // bots DO enter the cache now (they were dropped at adapter level
  // before), so the solo-human fallback below filters them out explicitly
  // — otherwise a 1-human + N-bot channel would silently exit solo mode.
  participants: readonly ChannelParticipant[]
  membership: MembershipCount | null
  // Names the agent answers to in plain text (no @mention syntax). Built
  // by the router as `[basename(agentDir), ...config.alias]` and lowered
  // once. Empty list means alias-based engagement is off — useful for
  // tests and for agents that explicitly want strict-mention behavior.
  // Match semantics: case-insensitive substring of inbound text. This is
  // the operator contract documented in typeclaw-channels; if a name is too
  // generic ("bot", "ai") it WILL produce false matches and the operator
  // owns curation.
  selfAliases: readonly string[]
  // True when the bot has previously sent into this exact thread (or
  // channel — the suppressor only checks this when the message is a
  // thread reply, but the field is general). Set by the router from
  // `live.successfulChannelSends > 0` plus any bot-authored prefetched
  // history in `contextBuffer`. Suppresses the `replyToOtherMessageId`
  // gate below: once the bot is participating in a thread, subsequent
  // replies are part of OUR conversation even when `parent_user_id` (the
  // thread root author) is a human. Without this, a thread that started
  // with a human @-mention drops every follow-up reply because Slack's
  // `parent_user_id` always points at the (human) thread root, never the
  // bot's intermediate replies — see incident in PR #58 follow-up.
  botInThread: boolean
}

export function decideEngagement(input: EngagementInput): EngagementDecision {
  const { message, config, key, ledger, now, participants, selfAliases, botInThread } = input

  // Peer bots are excluded from the count — a 1-human-N-bot room is still
  // "solo" for the fallback at the bottom.
  const effectiveHumans = countEngagementHumans(message, participants, input.membership, now, botInThread)

  if (config.trigger.includes('dm') && message.isDm) return 'engage'
  if (config.trigger.includes('mention') && message.isBotMention) return 'engage'
  if (config.trigger.includes('reply') && message.replyToBotMessageId !== null) return 'engage'

  const explicitOnly = message.suppressSticky === true

  // Multi-human pre-sticky target check. In a busy group the conversational
  // target shifts every message: the author we're mid-exchange with (and hold
  // a sticky credit for) may, on THIS turn, structurally address a third party
  // — "@bob what do you think?" or a reply to another human's message. Sticky
  // below is content-blind by design (it answers "am I mid-conversation with
  // this author?"), so without this guard it would force-engage on a message
  // plainly aimed elsewhere and burn the credit.
  //
  // This stays inside the pinned content-blind philosophy: it adds NO semantic
  // text interpretation. It reuses only the adapter-classified structural
  // booleans (`mentionsOthers`, `replyToOtherMessageId`), which apply the same
  // way whether the author or the target is a human or a bot. Plain-text peer
  // bot names (`textTargetsAnyPeerBot`) are deliberately NOT checked here: a
  // name in text is not structural addressing (bots routinely sign or label
  // their own posts and name each other in reports), human names in text never
  // step aside either, and an engaged turn in a multi-human group carries the
  // group-chat nudge telling the model to stay silent when the message is aimed
  // at another person or bot (while the peer-bot loop guard is active, its
  // warning replaces that nudge and only suggests `NO_REPLY` for noise). The
  // cost: `consume` slides the credit's expiry, so a credited author who keeps
  // naming other bots keeps waking us for silent turns, exactly as plain
  // chatter from a credited human already does. The only refinement is
  // ordering: when those structural signals fire in a multi-human group,
  // observe BEFORE consuming
  // sticky, and PRESERVE the credit so the author's next untargeted follow-up
  // still wakes us within the window. A plain follow-up (no suppressor set)
  // is untouched: it falls through to sticky and engages exactly as before.
  //
  // Solo-human channels are deliberately excluded (`effectiveHumans > 1`):
  // there the sticky-over-mentionsOthers behavior is intentional and tested.
  // The `!matchesAnyAlias` guard preserves the ladder invariant "explicit
  // address to us beats structural targeting of others": a message that names
  // us by alias engages on the alias rule below even when it ALSO tags a third
  // party (the "Toto, Lala, both take a look" multi-bot case), so we must not pre-empt
  // it here. We only step aside for a credited author whose message is aimed
  // PURELY elsewhere.
  if (
    effectiveHumans > 1 &&
    config.stickiness !== 'off' &&
    !explicitOnly &&
    !matchesAnyAlias(message.text, selfAliases) &&
    structurallyTargetsSomeoneElse(message, botInThread)
  ) {
    return 'observe'
  }

  // Sticky credit force-engages for the full window. This gate is deliberately
  // content-blind: it answers "am I in an active conversation with this
  // author?", not "does THIS message need a reply?" — a boolean over
  // membership cannot tell "where did you send it?" (reply) from "lol ok"
  // (chatter). Selectivity for plain follow-ups is the MODEL's job: engaged
  // group turns get a `composeTurnPrompt` nudge (keyed off `isMultiHumanGroup`)
  // to answer real follow-ups and `NO_REPLY` chatter. Gating sticky off in
  // groups wholesale (the prior approach) dropped genuine follow-ups outright;
  // the pre-check above is narrower — it only steps aside when the message is
  // STRUCTURALLY addressed elsewhere, leaving plain follow-ups engaged.
  // GitHub review-thread traffic must not spend content-blind sticky credit
  // unless the bot was explicitly addressed.
  if (
    !explicitOnly &&
    config.stickiness !== 'off' &&
    ledger.consume(key, message.authorId, now, config.stickiness.perReply.window)
  ) {
    return 'engage'
  }

  // Plain-text name addressing: the user wrote our name (or an alias)
  // somewhere in the message without using <@id> syntax. Engage at the
  // same priority as an explicit mention — operators add aliases
  // precisely because they expect the bot to respond when called by
  // name. Suppression on `mentionsOthers` would defeat the point: the
  // user can address two bots by name in one message ("Toto, Lala, both
  // take a look") and both should engage. Each bot only knows its own
  // aliases, so cross-bot suppression isn't possible at this layer
  // anyway — the router-side peer-name suppression in the solo-human
  // fallback handles that case (follow-up).
  if (!explicitOnly && matchesAnyAlias(message.text, selfAliases)) return 'engage'

  // Solo-human fallback: the strict mention/reply/dm gate keeps the bot
  // quiet in multi-human conversations, but in a 1-human channel that
  // same gate makes the agent silent on messages plainly meant for it.
  // The fallback engages on any human inbound when the channel has at
  // most one human participant, and reverts to strict the moment a second
  // human posts. Peer bots are tracked as participants for context but
  // excluded from the count here, so a 1-human channel stays "solo" even
  // when several bots also speak in it.
  //
  // Two suppressors override the fallback when the message is clearly
  // addressed to someone else:
  //   1. `mentionsOthers` — the message tags at least one other user and
  //      none of the mentions resolve to us.
  //   2. `replyToOtherMessageId` — the message is a reply, but the parent
  //      was authored by someone other than us (Discord's threaded reply
  //      arrow is the canonical case).
  // Both are populated by the adapter classifiers; either one flips the
  // fallback off for that single message without changing channel state.
  // Explicit triggers (DM, mention-of-us, reply-to-us, sticky) above are
  // unaffected — those still engage even when the message also tags a
  // third party.
  //
  // PEER BOTS NEVER QUALIFY for this fallback. It is a courtesy to humans
  // who don't want to type `@bot` in their own DM-like channel; peer bots
  // have no such ergonomic excuse. Letting peer bots ride the fallback
  // produced bot-to-bot conversations in 1-human-N-bot channels (observed:
  // Momo and Kiki introducing themselves to each other after a single
  // "hey folks" from the human, then continuing to address each other for
  // ~6 turns). The router's loop guard only trips after 5 consecutive
  // peer engagements, which is too late to prevent the embarrassment.
  //
  // PHILOSOPHY (do not relitigate): peer bots remain reachable through
  // the SAME triggers as humans (mention/reply/dm/sticky); we do NOT
  // downgrade them to "mention-only". Bot-to-bot conversation is a
  // legitimate first-class use case in this codebase. The fix is to
  // close the unintended fallback, not to firewall bots behind explicit
  // mentions. A future maintainer (human or AI) tempted to add a
  // `peerBotTriggers: 'mention-only'` config — or any equivalent gate
  // that demands explicit `@bot` from peer bots — should not. The user
  // has rejected that design repeatedly. The right knob is `trigger`
  // (which already applies symmetrically to humans and bots) plus this
  // fallback fix.
  if (targetsSomeoneElse(message, participants, botInThread)) return 'observe'

  // Thread solo-fallback fail-closed gate. A thread is a SEPARATE live session
  // from its parent channel (the participant/membership key carries the thread
  // suffix — see `channelKeyId`), so a freshly-opened thread starts with one
  // known speaker and a cold membership cache. That collapses `effectiveHumans`
  // to ≤1 and would trip the solo-human fallback below, making the bot butt
  // into a thread it was never part of in a busy multi-human channel. Membership
  // is a room property, not a thread property, so a thread may ride the fallback
  // ONLY on a fresh, complete membership read that itself proves ≤1 human; null
  // / truncated / stale reads fail closed to `observe`. Exemptions: DMs (solo by
  // construction) and threads the bot ALREADY participates in (`botInThread` —
  // an established conversation, not an un-addressed intrusion; this is the same
  // escape hatch the `replyToOtherMessageId` suppressor uses). Non-thread solo
  // channels keep the legacy answer-everything fallback untouched.
  //
  // `isThreadRoom` reads the structural `room` signal FIRST so this fires for
  // Discord threads too (their `thread` is null — the thread id lives in
  // `chat`), falling back to `thread !== null` for Slack-shaped inbounds.
  if (isThreadRoom(message) && !botInThread && !isFreshCompleteSoloRoom(input.membership, now)) {
    return 'observe'
  }

  if (effectiveHumans <= 1 && !message.authorIsBot) return 'engage'

  return 'observe'
}

function isThreadRoom(message: InboundMessage): boolean {
  if (message.isDm) return false
  return message.room?.kind === 'thread' || message.thread !== null
}

function isFreshCompleteSoloRoom(membership: MembershipCount | null, now: number): boolean {
  if (membership === null) return false
  if (membership.truncated) return false
  if (now - membership.fetchedAt >= MEMBERSHIP_FRESHNESS_MS) return false
  return membership.humans <= 1
}

// Structural "this message is addressed to someone other than us" test, pure
// over adapter-classified booleans. Used alone by the multi-human pre-sticky
// check, and as the base of `targetsSomeoneElse` for the solo-human fallback
// suppressors so the two can never drift apart.
//
//   - `mentionsOthers` — the message tags at least one other user and none of
//     the mentions resolve to us.
//   - `replyToOtherMessageId !== null && !botInThread` — the message replies to
//     a non-bot message AND we haven't sent into this thread yet. Slack's
//     `parent_user_id` is the THREAD ROOT author, not the immediate parent, so
//     a thread a human opens by @-mentioning us would otherwise drop every
//     follow-up; `botInThread` is the escape hatch once we're participating.
function structurallyTargetsSomeoneElse(message: InboundMessage, botInThread: boolean): boolean {
  if (message.mentionsOthers) return true
  if (message.replyToOtherMessageId !== null && !botInThread) return true
  return false
}

// Fallback-suppressor variant: the structural test plus `textTargetsAnyPeerBot`
// — the text names a known peer bot (observed via `participants[]`). In a
// 1-human-N-bot room, addressing a bot by plain name ("라라야 cron 좀 봐줘") is
// the only signal that keeps every OTHER bot's solo-human fallback from
// answering. A never-seen peer's first addressing slips through, then is
// caught forever once that peer has spoken once.
function targetsSomeoneElse(
  message: InboundMessage,
  participants: readonly ChannelParticipant[],
  botInThread: boolean,
): boolean {
  if (structurallyTargetsSomeoneElse(message, botInThread)) return true
  return textTargetsAnyPeerBot(message.text, participants)
}

// Membership is a room property, so a Slack thread inherits its parent
// channel's count. Once the bot is part of the thread, the thread's own
// speakers are the better signal: a thread between one human and the bot is a
// solo conversation even inside a crowded channel, and a second human posting
// there flips it back to multi-human.
export function countEngagementHumans(
  message: InboundMessage,
  participants: readonly ChannelParticipant[],
  membership: MembershipCount | null,
  now: number,
  botInThread: boolean,
): number {
  if (botInThread && isThreadRoom(message)) return participants.filter((p) => p.isBot !== true).length
  return countEffectiveHumans(participants, membership, now)
}

export function countEffectiveHumans(
  participants: readonly ChannelParticipant[],
  membership: MembershipCount | null,
  now: number,
): number {
  const persistedHumans = participants.filter((p) => p.isBot !== true).length
  return resolveEffectiveHumans(persistedHumans, membership, now)
}

// A multi-human group is where the prompt's default "answer everything"
// eagerness needs tempering. The router reads this in `route()` to decide
// whether to append the group-chat nudge that tells the model to be selective
// (answer real follow-ups, `NO_REPLY` chatter) on its engaged turns. DMs and
// solo-human channels skip the nudge — there, replying to everything is right.
export function isMultiHumanGroup(isDm: boolean, effectiveHumans: number): boolean {
  return !isDm && effectiveHumans > 1
}

function textTargetsAnyPeerBot(text: string, participants: readonly ChannelParticipant[]): boolean {
  const haystack = text.toLocaleLowerCase()
  for (const p of participants) {
    if (p.isBot !== true) continue
    if (p.authorName === '') continue
    if (haystack.includes(p.authorName.toLocaleLowerCase())) return true
  }
  return false
}

export function resolveEffectiveHumans(
  persistedHumans: number,
  membership: MembershipCount | null,
  now: number,
): number {
  if (membership === null) return persistedHumans
  // A fresh complete API read is the only signal that can see lurkers AND
  // prune recent leavers. Letting persisted speakers win here would preserve
  // the exact stale-authorship bug the membership lookup exists to fix.
  const isFresh = now - membership.fetchedAt < MEMBERSHIP_FRESHNESS_MS
  if (!membership.truncated && isFresh) return membership.humans
  // Truncated and stale reads are useful quieting hints, not ground truth.
  // Persisted speakers are bounded to the last 7 days, so `max()` avoids
  // under-counting active humans while the platform count is approximate.
  return Math.max(persistedHumans, membership.humans)
}

export function grantStickyForReplyTargets(
  ledger: StickyLedger,
  key: string,
  authorIds: readonly string[],
  config: EngagementConfig,
  now: number,
): void {
  if (config.stickiness === 'off') return
  const window = config.stickiness.perReply.window
  for (const id of authorIds) {
    ledger.grant(key, id, now + window)
  }
}

export function matchesAnyAlias(text: string, lowercasedAliases: readonly string[]): boolean {
  if (lowercasedAliases.length === 0) return false
  const haystack = text.toLocaleLowerCase()
  for (const alias of lowercasedAliases) {
    if (haystack.includes(alias)) return true
  }
  return false
}
