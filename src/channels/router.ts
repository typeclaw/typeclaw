import { statSync } from 'node:fs'
import { basename } from 'node:path'

import type { AssistantMessage } from '@mariozechner/pi-ai'
import { SessionManager } from '@mariozechner/pi-coding-agent'

import { createSession, renderTurnRoleAnchor, renderTurnTimeAnchor, type AgentSession } from '@/agent'
import { applyTurnThinkingLevel, getQuestionSignal, type QuestionSignal } from '@/agent/attention-escalation'
import { forgetSharedLoopGuardTool } from '@/agent/plugin-tools'
import { subscribeProviderErrors } from '@/agent/provider-error'
import type { RestartHandoff } from '@/agent/restart-handoff'
import type { ChannelParticipant, SessionOrigin } from '@/agent/session-origin'
import { renderSubagentCompletionReminder } from '@/agent/subagent-completion-reminder'
import {
  armRestartKickForOrigin,
  extractTurnUsage,
  recordTurnOutcome,
  recordTurnStart,
  runIdleContinuation,
} from '@/agent/todo/continuation-wiring'
import { SUBAGENT_OUTPUT_TOOL_NAME } from '@/agent/tools/subagent-output'
import { type Command, type CommandPermission, type CommandResult, createCommandRegistry } from '@/commands'
import { CORE_PERMISSIONS, type PermissionService } from '@/permissions'
import type { HookBus } from '@/plugin'
import { extractClaimCode } from '@/role-claim'
import type { Stream } from '@/stream'

import { extractMentionedUserIds } from './adapters/mention-hints'
import { formatChannelCommandHelp } from './commands'
import { detectContinuationWillingness } from './continuation-willingness'
import {
  countEffectiveHumans,
  decideEngagement,
  grantStickyForReplyTargets,
  isMultiHumanGroup,
  StickyLedger,
  type EngagementDecision,
} from './engagement'
import { checkFalseReceipt } from './github-false-receipt'
import { evaluateRereviewGuard } from './github-rereview-guard'
import { resetReviewTurn } from './github-review-turn-ledger'
import { renderPrVerdictStandDownReminder } from './github-verdict-activity'
import {
  MEMBERSHIP_COLD_FETCH_TIMEOUT_MS,
  type MembershipCount,
  type MembershipResolver,
  type MembershipResolverResult,
} from './membership'
import { createMembershipCache, type MembershipCache } from './membership-cache'
import { checkOutboundFlood } from './outbound-flood-filter'
import { updateParticipants } from './participants'
import {
  channelsSessionsPath,
  findRecord,
  loadChannelSessions,
  saveChannelSessions,
  type ChannelSessionRecord,
} from './persistence'
import { QUOTED_REPLY_EXCERPT_MAX_CHARS, type AdapterId, type ChannelAdapterConfig } from './schema'
import type {
  ChannelHistoryMessage,
  ChannelKey,
  ChannelNameResolver,
  ChannelSelfIdentity,
  ChannelSelfIdentityResolver,
  FetchAttachmentArgs,
  FetchAttachmentCallback,
  FetchAttachmentResult,
  FetchHistoryArgs,
  FetchHistoryResult,
  HistoryCallback,
  InboundAttachment,
  InboundMessage,
  InboundReferenceContext,
  RemoveReactionCallback,
  RemoveReactionRequest,
  OutboundCallback,
  OutboundMessage,
  QuoteAnchorSource,
  ReactionCallback,
  ReactionRef,
  ReactionRequest,
  ReactionResult,
  ResolvedChannelNames,
  ReviewStateRequest,
  ReviewStateResolver,
  ReviewStateResult,
  ReviewThreadResolveRequest,
  ReviewThreadResolveResult,
  ReviewThreadResolver,
  SendErrorCode,
  SendResult,
  TypingCallback,
} from './types'
import { channelKeyId } from './types'

export const INITIAL_DEBOUNCE_MS = 600
export const HOT_DEBOUNCE_MS = 1500
export const MAX_DEBOUNCE_MS = 4000
export const HOT_THRESHOLD_MS = 3000
export const MAX_CONSECUTIVE_ABORTS = 3
export const CONTEXT_BUFFER_SIZE = 20
// Observed ("Recent context") messages are awareness-only and replayed in full
// on every turn (uncached), so one long paste would otherwise re-bloat every
// subsequent turn until it ages out. Cap each observed message's text; the
// addressed current message is never capped (it's the actual request).
export const OBSERVED_MESSAGE_MAX_CHARS = 800
// Discord's typing indicator expires after ~10s; an 8s heartbeat keeps it
// continuously visible while we debounce + generate without spamming the API.
export const TYPING_HEARTBEAT_MS = 8000
// A stuck model call or an agent that never yields should not keep re-arming
// platform-side typing forever. Slack Assistant status in particular has a
// documented 2-minute timeout, so repeatedly refreshing it after that point
// turns a temporary status into a permanent-looking artifact.
//
// The cap is measured from `live.typingStartedAt`, which is refreshed by
// these signals of life (see `bumpTypingActivity`):
//   1. Each new `drain()` iteration (a new turn is starting).
//   2. Each `tool_execution_end` from the agent session (a tool just
//      completed — the prompt is progressing, not stuck).
//   3. Each streaming token (`message_update` carrying a `text_delta` or
//      `thinking_delta`) — the model is actively generating, even on a
//      pure-text reply that calls no tools.
// Signal 3 is what keeps a long conversational reply (no tool calls, just
// minutes of streamed text or extended thinking) under the cap: without it,
// such a turn emits no `tool_execution_end` and the indicator was paused
// mid-generation. A genuinely stuck model call — no tokens, no tools — still
// trips the cap. The cap exists to catch *silence*, not duration.
export const MAX_TYPING_HEARTBEAT_MS = 2 * 60 * 1000

// Idle GC: a LiveSession whose `lastInboundAt` is older than
// SESSION_IDLE_MS gets evicted on the next GC tick. Persistence
// (channels/sessions.json) is intentionally untouched — the next inbound
// rehydrates from disk against the same sessionId, so the on-disk
// transcript continues across the eviction. The point is to free memory
// (LiveSession holds an open SessionManager + transcript in RAM) and to
// give the next conversation a fresh start without forcing the user to
// notice anything. `lastInboundAt` is bumped only by *engaged* inbounds
// (see scheduleDebouncedDrain), so passive observation alone won't keep
// a session warm forever — that's intentional. The session is seeded
// with `now()` at creation (not `0`) so a freshly-created observe-only
// session gets a full SESSION_IDLE_MS window before its first GC sweep,
// not a 56-year-old idle reading from `Date.now() - 0`.
export const SESSION_IDLE_MS = 30 * 60 * 1000
export const SESSION_GC_INTERVAL_MS = 60 * 1000

// Hard cap on tool-initiated outbound sends per (chat:thread) per turn.
// The original loop-incident emitted ~50 sends in one turn; even
// legitimate split replies rarely cross 8. 10 leaves headroom for
// genuine multi-part answers while definitively stopping runaway loops.
// Enforced inside router.send for `source: 'tool'` callers; system
// recovery paths (`source: 'system'`) bypass.
export const MAX_CHANNEL_SENDS_PER_TURN = 10
export const ENGAGE_REACTION_EMOJI = 'eyes'
// Best-effort "zipping it / going quiet" ack dropped on the triggering message
// when the model disengages (channel_disengage); fire-and-forget like engage :eyes:.
export const DISENGAGE_REACTION_EMOJI = 'zipper_mouth_face'
// Per-adapter fallback for platforms that cannot render the default. GitHub's
// Reactions API is a fixed 8-emoji set with no zipper-mouth; 'confused' is the
// closest "stepping back" signal it can post, so a GitHub disengage still acks
// instead of silently no-op'ing on the unsupported result.
const DISENGAGE_REACTION_EMOJI_OVERRIDES: Partial<Record<AdapterId, string>> = {
  github: 'confused',
}

export function disengageReactionEmojiFor(adapter: AdapterId): string {
  return DISENGAGE_REACTION_EMOJI_OVERRIDES[adapter] ?? DISENGAGE_REACTION_EMOJI
}

// Wake nudge pushed into a resumed channel session at boot so drain() has a
// non-empty batch and fires a turn. The substantive instruction the model acts
// on is the `typeclaw.restart-self` entry already in the reopened JSONL (pi
// hydrates it as a user message); this nudge only triggers the turn. Uses the
// repo's SYSTEM MESSAGE framing (see composeTurnPrompt) so persona-rich models
// do not reply to it as if a human wrote it.
export const RESTART_RESUME_WAKE_REMINDER = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'The container just restarted and this session was resumed. Act on the',
  'restart instructions already in your context. Do not acknowledge or reply to',
  'this notice itself.',
  '',
  '---',
].join('\n')
// Ceiling on tool-source channel sends that a same-turn router policy DENIED
// without delivering — `skip-locked`, `turn-cap`, or `duplicate`. Such denials
// return a soft error and do NOT increment `consecutiveSends`, so a model that
// ignores the denial and retries never trips `MAX_CHANNEL_SENDS_PER_TURN`.
// Both production livelocks had this shape: the model alternated a no-op
// `skip_response` with a denied `channel_reply` (~200-400x in one
// `session.prompt()`) — the interleaving defeated the byte-identical
// loop-guard's 5-in-a-row streak, and the denials bypassed the send cap. One
// turn was all `skip-locked`, the other all `duplicate` (byte-identical text).
// Past this ceiling we ABORT the run's AbortSignal (`agent.abort()`), which
// ends the turn on the next assistant stream. We can't just throw: the pi tool
// executor catches a tool's throw into an error result and the turn continues.
// Counted per send-target and only when NO concurrent reservation for that
// target is in flight, so a legitimate parallel send-burst (one winner + many
// same-tick duplicate/cap denials) is never mistaken for a loop. Reset at turn
// start alongside `turnSeq`.
export const MAX_POLICY_DENIED_CHANNEL_SENDS_PER_TURN = 3
// Per-request output-token cap for channel sessions, threaded into the agent's
// stream options to override pi-ai's silent `Math.min(model.maxTokens, 32000)`
// default (`buildBaseOptions` in @mariozechner/pi-ai). Without it, Fireworks'
// kimi-k2p6-turbo — which degenerates into single-token repetition on the
// post-tool follow-up turn — runs the full 32000 tokens (~116s of garbage that
// never produces a reply) before `stopReason: 'length'`. The terminal-reply
// hook below removes the turn that triggers this; the cap bounds any other path
// that still reaches a channel LLM call. 4096 fits a thinking block plus a
// nontrivial reply (healthy channel turns observed at ~317 output tokens
// including reasoning). Deliberately NOT lowered in `providers.ts`, where
// `maxTokens` is the model's true capability that compaction math reads.
export const CHANNEL_MAX_OUTPUT_TOKENS = 4096
// Raised output-token budget threaded into the ONE re-prompt that follows a
// `stopReason:'length'` empty turn. The default 4096 backstop bounds kimi's
// degenerate repetition loop, but it is the same ceiling a *legitimate*
// reasoning-heavy turn hits when it spends the whole pool thinking and emits no
// prose — re-prompting under the identical cap reproduces the truncation. A
// `length` truncation that the byte-identical loop guard did NOT catch is
// evidence of genuine reasoning starved for room, not a repetition loop, so the
// retry grants 4x headroom for thinking + a reply. Bounded (not 32000) so a
// turn that IS looping still can't burn the full pi-ai default. Consumed
// one-shot via `LiveSession.nextPromptMaxTokens`, then reset at the next real
// user turn so the raised budget never leaks past the turn that needed it.
export const CHANNEL_EMPTY_TURN_RETRY_MAX_OUTPUT_TOKENS = 16384
// Ceiling on automatic re-prompts for a turn that ended with NO user-facing
// reply AND no attempted send — the pure "the model burned its budget thinking
// and produced nothing" failure. The canonical trigger is Fireworks'
// kimi-k2p6-turbo spiraling into a long reasoning loop on an ambiguous request
// until it hits CHANNEL_MAX_OUTPUT_TOKENS (`stopReason: 'length'`); the same
// path also catches a provider/router `aborted` leaf that left no recoverable
// prose. Each retry injects EMPTY_TURN_RETRY_NUDGE as a reminder-only turn (no
// new inbound) so `drain()` re-runs `session.prompt()` against the same branch.
// Bounded because a genuinely stuck model would otherwise re-loop forever; on
// exhaustion the user gets EMPTY_TURN_FALLBACK_TEXT instead of dead air. Reset
// at turn start alongside `turnSeq`. Deliberately NOT applied to turns that
// ATTEMPTED a send this turn (skip-locked or policy-denied) — those already
// thrashed the send path, so a re-prompt would just re-thrash; they skip
// straight to the fallback. See validateChannelTurn's candidate===null branch.
export const MAX_EMPTY_TURN_RETRIES = 2
// Reminder-only nudge injected before an empty-turn retry. Uses the repo's
// SYSTEM MESSAGE framing (see composeTurnPrompt) so persona-rich models do not
// reply to the notice itself. Names the actual failure (the prior turn ran out
// of its output budget mid-reasoning and produced no reply) and asks the model
// to keep its thinking short and answer directly — the empty turn was budget
// exhaustion, not a forgotten tool call, so a "reply directly" nudge alone
// would re-loop. The matching retry re-prompt also runs with a raised budget
// (CHANNEL_EMPTY_TURN_RETRY_MAX_OUTPUT_TOKENS) so the room actually exists.
export const EMPTY_TURN_RETRY_NUDGE = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'Your previous turn ran out of its output budget before sending a reply — it',
  'spent the whole turn thinking and produced nothing for the channel. This is',
  'an automated signal from the channel router, not a message from anyone in',
  'the chat. **Do not acknowledge or reply to this notice itself.**',
  '',
  'Answer the last user message now: keep any reasoning brief and send a direct',
  'reply via your channel reply tool. If you genuinely have nothing to say,',
  'reply with `NO_REPLY`.',
  '',
  '---',
].join('\n')
// Reminder-only nudge for the stranded-toolUse-after-send retry. Distinct from
// EMPTY_TURN_RETRY_NUDGE: that one diagnoses output-budget exhaustion and tells
// the model to "answer directly", which makes a stranded investigation RE-RUN
// its tools and strand again. Here the model already sent a `continue: true`
// status ack and did real tool work; the turn just ended on an unanswered
// toolUse before final prose. The prior toolUse/toolResult entries are still in
// this session's branch on the re-prompt, so the recovery is to STOP, read what
// it already gathered, and reply — not to start the investigation over.
export const STRANDED_TOOLUSE_CONTINUATION_NUDGE = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'Your previous turn sent a brief status reply, did some tool work, then ended',
  'before sending the answer it promised. This is an automated signal from the',
  'channel router, not a message from anyone in the chat. **Do not acknowledge or',
  'reply to this notice itself.**',
  '',
  'Do NOT start the investigation over. The tool results you already gathered are',
  'still in this conversation above — read them, summarize what you found, and',
  'send your reply now via your channel reply tool. Only call more tools if a',
  'specific fact is genuinely still missing. If you truly have nothing to say,',
  'reply with `NO_REPLY`.',
  '',
  '---',
].join('\n')
// Posted to the channel (via the `source:'system'` one-shot bypass) when an
// empty turn cannot be recovered AND retries are exhausted (or are skipped
// because the turn thrashed the send path). Replaces the historical silent
// drop so the human is never left staring at dead air after a degenerate turn.
export const EMPTY_TURN_FALLBACK_TEXT =
  "⚠️ I got stuck putting together a reply and couldn't finish. Could you rephrase or try again?"
// Distinct from EMPTY_TURN_RETRY_NUDGE: that one diagnoses budget exhaustion
// ("ran out of output budget"), which is FALSE for a clean `stop` with empty
// text. This nudge names the real failure — a turn that ended sending nothing
// to a message addressed to the agent in a one-on-one conversation — and steers
// the model to either answer or record the silence explicitly (skip_response /
// NO_REPLY) rather than ending empty again.
export const COLD_START_REPLY_NUDGE = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'Your previous turn ended without sending anything, but the last message was',
  'addressed to you in a direct, one-on-one conversation — ending silent there',
  'reads as ignoring the person. This is an automated signal from the channel',
  'router, not a message from anyone in the chat. **Do not acknowledge or reply',
  'to this notice itself.**',
  '',
  'Answer the last user message now via your channel reply tool. If you truly',
  'have nothing to add, call `skip_response({ reason })` (preferred) or end with',
  'exactly `NO_REPLY` so the silence is recorded — do not just end empty.',
  '',
  '---',
].join('\n')
// At most one continuation nudge per logical turn. Stricter than the empty-turn
// retry budget (2) because the turn ALREADY delivered a user-facing reply — this
// is a one-shot correction offer, not recovery from no output.
export const MAX_WILLINGNESS_NUDGES = 1
// Injected when a reply that ended the turn (terminal-reply abort) promised to
// keep working but omitted `continue: true`. Reminder-only, SYSTEM MESSAGE
// framing so persona-rich models do not reply to the notice itself.
export const WILLINGNESS_NUDGE = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'Your last reply said you would keep working this turn, but it ended right',
  'after sending — a successful channel reply ends the turn unless you set',
  '`continue: true` on it. This is an automated signal from the channel router,',
  'not a message from anyone in the chat. **Do not acknowledge or reply to this',
  'notice itself.**',
  '',
  'If you still have work to do (fetch data, run a tool, spawn a subagent, then',
  'reply with the result), do it now — and on the status reply that precedes more',
  'work this turn, set `continue: true`. If there is nothing left to do, reply',
  'with `NO_REPLY`.',
  '',
  '---',
].join('\n')
// Injected when a `channel_send` ack tripped continuation-willingness, the model
// did fresh work after it, then ended on an EMPTY `stop` leaf — the answer was
// computed but never sent (the Kimi/Fireworks empty-completion flake). Distinct
// from WILLINGNESS_NUDGE: that path is a `channel_reply` that ended the turn and
// needs `continue: true`; this path is a `channel_send` (which never ends the
// turn) whose follow-up degenerated, so the model just needs to emit the reply it
// already worked out. Shares MAX_WILLINGNESS_NUDGES so a turn can't double-nudge.
export const SEND_WILLINGNESS_NUDGE = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'You said you would keep working this turn and did the work, but the turn ended',
  'without sending the result — nothing reached the channel after your last',
  'message. This is an automated signal from the channel router, not a message',
  'from anyone in the chat. **Do not acknowledge or reply to this notice itself.**',
  '',
  'Send the answer you just worked out now via your channel send tool. If you',
  'genuinely have nothing to report, reply with `NO_REPLY`.',
  '',
  '---',
].join('\n')
// Rolling window for outbound send-rate telemetry. 5s matches Discord's
// rate-limit shape (5 msg / 5 s / channel) and comfortably covers Slack's
// 1 msg/s sustained. The window is observational; exceeding the burst
// threshold below escalates the per-send log to a warning.
export const SEND_RATE_WINDOW_MS = 5_000
// Above this in-window count, the per-send log line escalates to a
// `send_rate_warning` so a burst stands out in the log stream. Every
// send still emits a structured log line regardless of rate — this
// constant only controls when the warning marker appears.
export const SEND_RATE_WARN_THRESHOLD = 3
export const OUTBOUND_FLOOD_ERROR = 'outbound message denied: content looks like a repeated-character flood'

/**
 * Soft freshness boundary: the age of the last engaged inbound past which the
 * provider's server-side KV prompt-cache for this session's prefix is assumed
 * cold. Set to the LLM provider's KV-cache TTL (5 min) so a session reused
 * WITHIN this window is guaranteed a cache hit on the provider side.
 *
 * Reaching this boundary no longer forces an immediate rollover. Between the
 * soft boundary and SESSION_GRACE_HARD_TTL_MS, the live path defers to a
 * cost-aware grace decision (see `isGraceWorthReusing`): a session whose fixed
 * base context (rendered system prompt + injected memory + prefetched channel
 * context) still costs more to rebuild than its accumulated transcript is
 * reused for one more turn rather than torn down. This targets the common
 * channel shape — a human replying a few minutes past the cache TTL — where a
 * full cold-start rebuild of a large memory/index-mode base context dominates
 * the cost of carrying a modest transcript forward.
 *
 * Unlike SESSION_IDLE_MS (which evicts the in-memory entry without rollover), a
 * rollover triggers a full tearDownLive + recreate on the next engaged inbound.
 * The old session's transcript is preserved on disk; only the in-memory live
 * entry and sessions.json pointer are replaced.
 */
export const SESSION_FRESHNESS_TTL_MS = 5 * 60 * 1000

/**
 * Hard ceiling on the cost-aware grace window. Past this age the live session is
 * rolled over unconditionally regardless of base-vs-transcript cost: the grace
 * decision only defers rollover, it never makes the session immortal. Bounding
 * grace at 2x the soft TTL keeps a never-quite-idle session from accumulating an
 * ever-growing, fully-uncached prefix (every turn past the soft boundary re-sends
 * the whole prefix at no provider-cache discount) and prevents grace from
 * silently becoming an unbounded TTL increase.
 */
export const SESSION_GRACE_HARD_TTL_MS = 10 * 60 * 1000

/**
 * Absolute ceiling on how long a running background subagent may pin its parent
 * channel session against idle GC and stale-rollover. A still-running child defers
 * teardown because the next inbound otherwise starts a fresh session that has lost
 * track of the in-flight task and spawns a DUPLICATE child for the same work. The
 * pin is bounded so a stuck/never-completing child cannot make the session
 * immortal: past this age the session is GC'd / rolled over anyway, falling back
 * to the completion-reroute behavior. Measured from the child's start.
 *
 * Set above SESSION_IDLE_MS (30m) — not equal — so a child spawned at session
 * birth still pins the session through its first idle sweep instead of the two
 * windows coinciding. Comfortably above SESSION_GRACE_HARD_TTL_MS (10m) too:
 * real research runs can exceed it (an observed run took 9m18s), so the 10m cap
 * is far too tight to bound the pin.
 */
export const SESSION_CHILD_PIN_MAX_MS = 45 * 60 * 1000

/**
 * Cost-aware grace decision for the soft→hard TTL band. Returns true when reusing
 * the (now cache-cold) live session is cheaper than a fresh cold-start.
 *
 * After the soft TTL the provider prefix is cold either way, so the choice is:
 *   - rollover: pay to rebuild the fixed base context (system prompt + memory +
 *     prefetched context) plus a fresh first model call, OR
 *   - reuse: re-send the cold base context PLUS the accumulated transcript.
 *
 * Rollover only wins once the transcript a reused session would carry forward
 * exceeds the base context a rollover would rebuild. We approximate both with the
 * session transcript file: `baseContextBytes` is its size captured right after
 * cold-start (the rendered prompt before any user turn), and the live delta is
 * the growth since. While `baseContextBytes > transcriptDeltaBytes`, the fixed
 * rebuild is the larger cost and grace is worth it. A `baseContextBytes` of 0
 * (no transcript path available) disables grace — fail closed to the prior
 * roll-over-at-soft-TTL behavior.
 */
export function isGraceWorthReusing(baseContextBytes: number, transcriptDeltaBytes: number): boolean {
  if (baseContextBytes <= 0) return false
  return baseContextBytes > transcriptDeltaBytes
}

function defaultMeasureTranscriptBytes(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

// Watchdog ceiling for ensureLive's full async chain (resolve names →
// fetch membership → open session manager → persist mapping → prefetch
// history). A legitimate cold-start completes in well under a second;
// values above ~10s are always either a hung Discord REST call or a
// rate-limited retry storm. 30s leaves headroom for slow disks or a
// truly large transcript replay without making operator-noticed hangs
// indistinguishable from normal latency. On timeout the throw evicts
// the `creating` map entry so the next inbound retries from scratch
// instead of awaiting the same dead promise forever.
export const ENSURE_LIVE_TIMEOUT_MS = 30_000

// Thrown by ensureLive() when a teardown (roles reload or shutdown) raced
// ahead of an in-flight creation. route() has no special handling — it
// propagates to the adapter's outer catch, dropping this one inbound. The
// next inbound creates a fresh, post-reload session, which is the intended
// outcome: a message that arrived mid-reload is cheap to drop, far cheaper
// than answering it through a session built with the stale role.
export class StaleLiveSessionError extends Error {
  constructor(keyId: string) {
    super(`[channels] ${keyId}: live session creation raced a teardown; discarded`)
    this.name = 'StaleLiveSessionError'
  }
}

// Per-callback ceilings inside the ensureLive chain. The outer watchdog
// catches the worst case, but per-step timeouts give better log
// attribution (which step hung) AND graceful degradation: a hung name
// resolver still lets engagement run on IDs alone, a hung history fetch
// still lets the agent answer without prefetched context. Both paths
// loop over registered callbacks and currently `await` each unbounded.
// 5s matches Discord's median REST p99 with comfortable headroom.
export const RESOLVE_CHANNEL_NAMES_TIMEOUT_MS = 5_000
export const FETCH_HISTORY_TIMEOUT_MS = 5_000

export const HISTORY_ATTACHMENT_LIMIT = 50

// Watchdog over the whole session.idle hook chain. The drain loop awaits
// `fireSessionIdle` between turns; a single hung plugin handler (e.g. a
// memory-logger awaiting a network call that never resolves) wedges the
// loop with `live.draining` stuck `true`, which means subsequent mention
// inbounds enqueue silently and never fire. Observe-decisions still log
// because engagement runs in `route()` before the draining check, so the
// symptom from logs alone is "thread receives observed lines forever
// after the last `prompted elapsed_ms=...`". Bounding the chain here
// matches the ensureLive watchdog (30s) so a misbehaving plugin
// degrades the current turn instead of bricking the channel until
// container restart. Per-handler attribution lives in plugin/hooks.ts.
export const SESSION_IDLE_TIMEOUT_MS = 30_000

// Two-axis loop guard for peer-bot conversation. Peer bots route into
// engagement under the SAME rules as humans, so a small ring (A→B→C→A) or
// a fast cascade can otherwise ping-pong without bound. The guard trips
// when EITHER axis hits its limit and clears on the next human inbound.
//
// Why two axes:
// - The since-human counter catches slow rings that would never fill a
//   60s window (3 bots replying every 30s = 4 turns/min, never trips a
//   60s sliding count).
// - The 60s window catches fast bursts that would never accumulate enough
//   total turns to pressure the since-human counter (a single bot reflex
//   replying to its own mention 5x in 2s).
//
// The model receives a non-fatal warning prepended into composeTurnPrompt
// when tripped; the LLM decides whether to keep replying. Hard interrupt
// is intentionally not part of v1 (would require pi-coding-agent abort
// semantics during in-flight tool calls).
export const PEER_BOT_TURNS_WINDOW_MS = 60_000
export const MAX_PEER_BOT_TURNS_IN_WINDOW = 5
export const MAX_CONSECUTIVE_PEER_BOT_TURNS_SINCE_HUMAN = 5

export type RouterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: RouterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type CreateSessionForChannel = (params: {
  key: ChannelKey
  existingSessionId?: string
  // Basename of the JSONL file the prior session wrote to, captured at
  // creation time and persisted in channels/sessions.json. Used for
  // reopening — without this, sessionId alone is insufficient because
  // pi-coding-agent prefixes filenames with an ISO timestamp at write time
  // that the UUID does not encode. Optional for forward-compat with v2
  // mappings that predate the `sessionFile` field.
  existingSessionFile?: string
  participants: readonly ChannelParticipant[]
  origin: SessionOrigin
  // Mutable holder the router updates per turn (with the current turn's
  // lastInboundAuthorId, participants, etc.) so tool.before events stamp
  // the live actor identity rather than the cold-start snapshot. The
  // factory is expected to pass this through to createSession as
  // `options.originRef`.
  originRef: { current: SessionOrigin | undefined }
}) => Promise<{
  session: ChannelAgentSession
  sessionId: string
  dispose: () => Promise<void>
  hooks?: HookBus
  getTranscriptPath?: () => string | undefined
}>

export type ConfigForAdapter = (adapter: ChannelKey['adapter']) => ChannelAdapterConfig | undefined
export type ConfigRef = () => ChannelAdapterConfig

type QueuedInbound = {
  text: string
  referenceContext?: InboundReferenceContext
  attachments?: readonly InboundAttachment[]
  authorId: string
  authorName: string
  authorIsBot: boolean
  externalMessageId: string
  reactionRef?: ReactionRef
  engageReaction?: Promise<ReactionRef | null>
  isBotMention: boolean
  replyToBotMessageId: string | null
  isDm: boolean
  typingThread?: string
  receivedAt: number
  // Original platform timestamp (Slack/Discord), in ms since epoch. Used
  // by composeTurnPrompt to render an ISO 8601 prefix on each line so the
  // model sees when each message was actually posted, not when the router
  // happened to dequeue it. Zero means "unknown" (the formatter omits the
  // prefix for those).
  ts: number
}

type ObservedInbound = {
  text: string
  referenceContext?: InboundReferenceContext
  attachments?: readonly InboundAttachment[]
  authorId: string
  authorName: string
  authorIsBot: boolean
  receivedAt: number
  ts: number
  // Distinguishes scrollback that was bulk-loaded at session cold-start
  // (`prefetch`) from messages that actually arrived in the channel after
  // the session went live (`observed`). Both share the same in-memory
  // shape because the model sees them identically in the prompt's
  // "Recent context" block, but the quote-anchor decision must treat them
  // differently: prefetched scrollback is HISTORICAL context, not new
  // chatter that happened between the primary inbound and the agent's
  // reply. Counting prefetch entries as "intervening" would fire the
  // anchor on every fresh-thread first turn (the prefetch stamps
  // `receivedAt = now()` AFTER the inbound was received during ensureLive,
  // so by primary-vs-observed timestamp comparison they always look
  // "later"). See captureQuoteCandidate.
  source: 'prefetch' | 'observed'
}

type TimedAttachment = { ts: number; attachment: InboundAttachment }

type ChannelAgentSession = AgentSession & { getAbortReason?: () => string | undefined }

type LiveSession = {
  key: ChannelKey
  keyId: string
  session: ChannelAgentSession
  // The session's creation-time thinking level, captured once. A later escalated
  // turn moves `session.thinkingLevel` to `high`, so the live getter can't be the
  // reset target — this preserves the real default across the session's lifetime.
  turnThinkingDefault: AgentSession['thinkingLevel']
  // Last COMPLETED real user turn's question shape, for cross-turn "Jeff Bezos"
  // escalation. Read by the next turn; committed from pendingUserTurnSignal only
  // when a logical turn finishes (no empty-turn retry queued).
  lastQuestionSignal: QuestionSignal | null
  // A real user turn's question shape captured at turn start but not yet
  // committed: a `length`/`aborted` truncation spans the original batch plus
  // reminder-only retry iterations, so the signal commits to lastQuestionSignal
  // only when that whole logical turn completes (success or fallback), never
  // from the truncated attempt and never leaving stale state across the turn.
  pendingUserTurnSignal: { signal: QuestionSignal } | null
  sessionId: string
  dispose: () => Promise<void>
  hooks: HookBus | undefined
  getTranscriptPath: (() => string | undefined) | undefined
  participants: ChannelParticipant[]
  resolvedNames: ResolvedChannelNames
  originRef: { current: SessionOrigin | undefined }
  promptQueue: QueuedInbound[]
  contextBuffer: ObservedInbound[]
  // Attachments of the messages composing the in-flight turn. drain()
  // splices promptQueue/contextBuffer empty BEFORE calling prompt(), but
  // the model only requests an attachment (look_at_channel_attachment /
  // channel_fetch_attachment) DURING prompt() — by which point both queues
  // are empty. This turn-scoped snapshot, populated right after the splice
  // and cleared when the turn ends, is what the lookup reads so a freshly-
  // arrived attachment stays resolvable for the whole turn it belongs to.
  currentTurnAttachments: readonly InboundAttachment[]
  // Refs from an explicit channel_history look-back. A prior-turn attachment is
  // replayed to the model as a text placeholder but its ref is gone from every
  // turn-scoped queue above, so look_at/fetch can't resolve it; stashing the
  // fetched refs here makes the same `attachment_id: N` resolvable. MUST be
  // searched LAST so a live `#1` still wins over a historical `#1` (the
  // newest-first collision rule lookupInboundAttachment documents). Bounded,
  // never persisted, never exposes the ref to the model. historyTimedAttachments
  // is the ts-tagged source of truth (ordered oldest→newest, deduped by id);
  // historyAttachments is its flat projection consumed by the lookup helpers.
  historyTimedAttachments: readonly TimedAttachment[]
  historyAttachments: InboundAttachment[]
  draining: boolean
  debounceTimer: ReturnType<typeof setTimeout> | null
  typingTimer: ReturnType<typeof setInterval> | null
  typingStartedAt: number
  typingTimedOut: boolean
  typingStopPromise: Promise<void> | null
  // True only while `live.session.prompt()` is actively running. Gates the
  // deferred typing revival: a revival queued behind an in-flight cap-trip
  // 'stop' must NOT re-arm the heartbeat once the prompt has finished, or it
  // leaks a timer that fires past the turn's end.
  promptInFlight: boolean
  lastInboundAt: number
  // Transcript-file size (bytes) captured immediately after cold-start, before
  // any user turn — a proxy for the fixed base-context rebuild cost (rendered
  // system prompt + injected memory + prefetched channel context). Read by the
  // soft-TTL grace decision against the current transcript size to weigh reuse
  // vs rollover. 0 when no transcript path is available, which disables grace.
  baseContextBytes: number
  firstUnprocessedAt: number
  currentTurnAuthorId: string | null
  currentTurnAuthorIds: Set<string>
  // Reaction target of the inbound that triggered THIS turn (the last item in
  // the drained batch, mirroring `currentTurnAuthorId`). Surfaced on the live
  // origin so `channel_react` reacts to the triggering message, not whichever
  // inbound happens to be latest in the queue. Null on reminder-only turns.
  currentTurnReactionRef: ReactionRef | null
  // Typing-status anchor of the inbound that triggered THIS turn (last item in
  // the drained batch, mirroring `currentTurnReactionRef`). Adapter-opaque ts
  // carried only to the typing path; null when the triggering inbound supplied
  // none (every non-DM inbound, and reminder-only turns).
  currentTurnTypingThread: string | null
  // One engage-:eyes:-add promise per inbound coalesced into THIS turn, each
  // resolving to its removable per-instance ref (or null). A debounced turn can
  // batch several inbounds that each got their own :eyes:, so every entry is
  // removed after the reply. Empty on turns with no reactable inbound.
  currentTurnEngageReactions: Array<Promise<ReactionRef | null>>
  lastTurnAuthorIds: Set<string>
  // Mirror of currentTurnAuthorId at end-of-turn (the LAST speaker of the
  // prior batch), preserved across the drain finally-block which resets
  // currentTurnAuthorId to null. Read by the reminder-only branch in
  // drain() so a system-reminder wakeup carries the same author the prior
  // turn's tool.before saw — matching "last speaker" semantics (not "first
  // inserted into Set"), so a multi-author prior turn like alice→bob
  // restores `bob`, the same identity normal turns would have used.
  lastTurnAuthorId: string | null
  consecutiveAborts: number
  // Per-(chat:thread) count of bot messages sent without intervening user
  // input being rendered into the model's context. Reset at the top of each
  // drain() iteration that picks up a non-empty batch (= a new user turn is
  // about to be shown to the model). channel_send reads this BEFORE calling
  // router.send so the hint reflects the position of the about-to-happen send
  // (n-th in a row), nudging the model to yield without forcing it to.
  // Queue of `<system-reminder>...</system-reminder>` strings to prepend
  // into the next turn's user-message body. Populated by
  // `injectSubagentCompletionReminder` (and any future system-injected
  // wakeups) so a backgrounded subagent's completion can wake a channel
  // session that has no pending user inbounds. Drained at the top of
  // every `drain()` iteration alongside the regular promptQueue batch;
  // the drain loop's run condition checks BOTH queues so a system
  // reminder alone is enough to trigger a turn.
  pendingSystemReminders: string[]
  consecutiveSends: Map<string, number>
  // Per-(chat:thread) text of the last reserved bot send. Set
  // SYNCHRONOUSLY inside router.send before the outbound callback awaits,
  // so two concurrent `router.send` calls for the same target cannot both
  // pass the duplicate guard. Cleared on every new prompt batch (same
  // lifecycle as `consecutiveSends`). The scope is "last 1 send within
  // this turn" so legitimate multi-part replies (different bodies) and
  // across-turn callbacks ("yes, I'm here" twice) are not blocked. Empty
  // strings are normalized to undefined before storage so attachments-only
  // sends never poison the tracker. The fuzzy-match upgrade is intentionally
  // deferred — exact-match has zero false-positive risk by construction.
  lastSentText: Map<string, string>
  // Session leaf-entry id captured at the moment the most recent successful
  // channel send landed this turn. `validateChannelTurn` compares it to the
  // turn-end leaf: a DIFFERENT assistant `stop` leaf means the model replied,
  // kept working, then ended with FRESH final prose it forgot to deliver
  // (the `continue: true` progress-reply bug) — recover it. A leaf that still
  // matches is narration the model emitted BEFORE/with the reply that already
  // landed, so it stays suppressed. Reset to null on every new prompt batch.
  lastSendLeafId: string | null
  // Per-(chat:thread) ring of send timestamps (epoch ms) within the rolling
  // SEND_RATE_WINDOW_MS window. Append-on-send, prune-on-read. Lifecycle is
  // wall-clock (NOT cleared on new prompt batches) because rate is a
  // property of the channel over time, not the agent's turn structure — a
  // burst that straddles two adjacent turns is still a burst from the chat
  // platform's POV. Telemetry-only today; the rate is logged when count
  // crosses SEND_RATE_LOG_THRESHOLD so production data can inform a
  // future hard cap without picking a threshold out of thin air.
  sendTimestamps: Map<string, number[]>
  successfulChannelSends: number
  // Monotonic per-LiveSession turn counter incremented just before each
  // `live.session.prompt(...)` call in `drain()`. Used as a turn identity
  // so `skip_response` can record "I skipped turn N" without leaking
  // across turns. `validateChannelTurn` only honors `skippedTurn` when it
  // equals `turnSeq`; a stale value from a crashed/aborted prior turn is
  // ignored (defensive: an unmatched skippedTurn would otherwise silently
  // drop the next user-facing reply). NOT cleared on drain finally — the
  // counter is purely monotonic; the matching comparison is what protects
  // against stale state.
  turnSeq: number
  // Snapshot of `successfulChannelSends` taken at turn start (same
  // moment `turnSeq` increments). Lets `markTurnSkipped` detect "a
  // channel send already landed in this turn" and reject the skip,
  // making the rejection symmetric with the send-after-skip lock in
  // `send()`: commit to silence or commit to replying, not both,
  // regardless of which order the model tried them in. Updated only at
  // turn start; reads against the live counter elsewhere are intentional.
  successfulSendsAtTurnStart: number
  // Per-send-target count of tool-source sends with a reservation currently
  // in flight (slot reserved, outbound callback not yet settled). Lets the
  // policy-denial guard tell a legitimate parallel send-burst (denials that
  // race a still-in-flight winner) from a sequential retry loop (denials with
  // nothing in flight). Incremented at reservation, decremented in the
  // callback-loop `finally` so an adapter throw can't strand a target.
  inFlightToolSends: Map<string, number>
  // Per-send-target count of policy-denied tool sends this turn that did NOT
  // race an in-flight reservation. Drives the throw at
  // `MAX_POLICY_DENIED_CHANNEL_SENDS_PER_TURN` that breaks the alternating-tool
  // livelock the byte-identical loop-guard misses. Reset at turn start and
  // cleared per-target on a successful delivery to that target.
  policyDeniedToolSendsThisTurn: Map<string, number>
  // Count of automatic empty-turn re-prompts already spent on the CURRENT
  // logical turn, bounded by `MAX_EMPTY_TURN_RETRIES`. A "logical turn" spans
  // the original user batch plus any router-injected retry nudges, so this is
  // reset only when a real user/reminder batch starts a fresh turn — NOT on the
  // reminder-only iterations the retry itself queues. `validateChannelTurn`
  // increments it before injecting EMPTY_TURN_RETRY_NUDGE and reads it to decide
  // retry-vs-fallback. See the candidate===null branch.
  emptyTurnRetries: number
  // Count of continuation nudges spent on the CURRENT logical turn, bounded by
  // MAX_WILLINGNESS_NUDGES. Reset alongside `emptyTurnRetries` only when a real
  // user batch starts (batch.length > 0), NOT on the reminder-only iteration the
  // nudge itself queues — same anti-reloop discipline as the empty-turn budget.
  willingnessNudges: number
  // Stashed by `installChannelReplyTerminalHook` just before it aborts the turn
  // after a successful `channel_reply` that omitted `continue: true`. Read once
  // by `validateChannelTurn` to decide the continuation nudge. `turnSeq`-stamped
  // (like `skippedTurn`/`skipLockedSendTurn`) so a stale record from an earlier
  // turn can never trigger a nudge on a later one. `null` when no such reply
  // ended this turn.
  lastTerminalReplyAbort: { turnSeq: number; text: string } | null
  // Stamped by router abort sites and read by `validateChannelTurn` for
  // reason-specific stranded-toolUse recovery logs. `turnSeq`-stamped so stale
  // abort provenance from an earlier turn can never leak into a later retry.
  abortReasonThisTurn: { turnSeq: number; reason: string } | null
  // One-shot output-token budget for the NEXT `session.prompt()` only.
  // `installChannelOutputCap` reads and clears it per stream call, so it
  // overrides the default backstop for exactly one re-prompt. Set by the
  // empty-turn length-retry branch to CHANNEL_EMPTY_TURN_RETRY_MAX_OUTPUT_TOKENS
  // and reset to undefined at each fresh user turn so the raised budget cannot
  // leak past the turn that needed it.
  nextPromptMaxTokens: number | undefined
  // Stamped by `markTurnSkipped` (called from the `skip_response` tool)
  // with the current `turnSeq`. Read at the top of `validateChannelTurn`:
  // if it matches the just-completed turn, recovery is skipped entirely
  // (no NO_REPLY check, no Kimi leak check, no assistant-text recovery).
  // The model has explicitly opted out of this turn and we honor that —
  // UNLESS the model also tried a tool-source send this turn (see
  // `skipLockedSendTurn`), in which case the skip was contested and we let
  // recovery run so the contested reply isn't silently dropped. `null` when
  // no skip has been recorded.
  skippedTurn: { turnSeq: number; reason: string } | null
  // Stamped by `send()` with the current `turnSeq` when a tool-source send is
  // DENIED by the skip lock (the model called `skip_response` first, then
  // changed its mind and tried `channel_reply`). The send still stays denied —
  // "commit to silence" is binding for the live send path — but a contested
  // skip must NOT also suppress the post-turn recovery net: the model produced
  // user-facing reply text that the skip short-circuit would otherwise drop on
  // the floor with no retry (the inbound is already drained). When this matches
  // the just-completed turn, `validateChannelTurn` falls through to the normal
  // `recoverableAssistantText` path, which posts the reply via `source:'system'`
  // (subject to the existing NO_REPLY / leak guards). `null` when no skip-locked
  // send was attempted. Compared by `turnSeq` so a stale value can't leak across
  // turns.
  skipLockedSendTurn: number | null
  // Stamped with the current `turnSeq` by `clearSticky` (called from the
  // `channel_disengage` tool). Read in `send()`'s post-delivery grant block: a
  // successful outbound normally re-grants sticky credit to the turn's authors,
  // which would silently re-arm the engagement the model just dropped if it
  // acks ("ok, backing off") via `channel_reply` in the same turn. When this
  // matches the live `turnSeq`, the grant is suppressed so disengage stays
  // binding for the rest of the turn — the same "commit to it within the turn"
  // shape as the skip lock. `null` when no disengage has been recorded.
  // Compared by `turnSeq` so a stale value can't leak across turns.
  disengagedTurn: number | null
  // Stamped with the current `turnSeq` when validateChannelTurn posts the
  // empty-turn fallback (retry exhaustion). Read by the cross-turn signal commit
  // so a fallback turn — which produced no usable assistant reply — does not seed
  // question escalation. Compared by `turnSeq` so a stale value can't leak across
  // turns.
  emptyTurnFallbackTurn: number | null
  // Captured by drain() at batch dequeue; read+cleared by send() on the
  // first tool-source send of the turn. The anchor decision (delay
  // threshold + intervening-observed check) is evaluated at SEND time
  // against this snapshot — not at drain time — because the relevant
  // signal is how long the user waited from inbound to seeing the reply
  // land, which only the send-side clock knows. Cleared after first
  // consumption so multi-part replies anchor only on chunk 1. A new
  // batch overwrites unconditionally.
  pendingQuoteCandidate: QuoteAnchorCandidate | null
  // Loop-guard state. See PEER_BOT_TURNS_WINDOW_MS / MAX_* constants
  // above. Updated in route() on every engaged peer-bot inbound, reset on
  // any human inbound. The two axes (window ring buffer + since-human
  // counter) are independent — either tripping sets `loopGuardActive`
  // until the next human posts. The active flag is read by
  // composeTurnPrompt() and prepended to the user-turn text.
  recentEngagedPeerBotTurns: { authorId: string; ts: number }[]
  consecutiveEngagedPeerBotTurns: number
  loopGuardActive: boolean
  // Set in route() from the same membership+participants the engagement
  // decision used, so the prompt nudge and sticky suppression agree on
  // "is this a multi-human group". Read by composeTurnPrompt().
  multiHumanGroup: boolean
  // True when this live session was born from a cold-start (no persisted
  // session existed — first contact or a stale-rollover after long idle), as
  // opposed to rehydrating an existing session. Combined with `turnSeq === 0`
  // it pinpoints the very first prompt of a freshly woken session.
  createdFromColdStart: boolean
  // Set in route() when the FIRST turn of a cold-start session engages via the
  // solo-human "answer everything" fallback (not an explicit mention/reply/DM,
  // not a multi-human group). Read by validateChannelTurn: a BARE-EMPTY stop on
  // such a turn is a model whiff on a direct one-on-one question, not deliberate
  // silence, so it earns an empty-turn retry instead of a silent no_reply.
  // Recomputed on every engage, so it self-clears once turnSeq leaves the first
  // turn; explicit NO_REPLY / skip_response and any turn that already sent stay
  // on the historical silent path.
  coldStartSoloFallbackTurnActive: boolean
  membershipFetch: Promise<MembershipCount | null> | null
  // Provider soft-error (`stopReason: 'error'`) captured during the current
  // turn, deferred to turn-end. Upstream surfaces transient errors (e.g.
  // `server_is_overloaded`) MID-turn and the turn often recovers, replying
  // seconds later — posting the "⚠️ provider failed" notice on the spot strands
  // a false failure above the eventual real reply. So the listener only RECORDS
  // here (stamped with the firing turnSeq; raw text logged for operators); the
  // turn-end finally posts `safeMessage` ONLY if no reply landed, else discards.
  // First error per turn wins. Keyed by `turnSeq` so a stale record from a
  // crashed prior turn can't leak into the next.
  pendingProviderError: { turnSeq: number; safeMessage: string } | null
  destroyed: boolean
  unsubProviderErrors: (() => void) | null
  unsubTypingActivity: (() => void) | null
  unsubTodoOutcome: (() => void) | null
}

// `event` is null for command invocations that originated outside the inbound
// pipeline (e.g. Discord native slash commands fired from listener.on
// ('interaction_create')). Handlers that need a real inbound — for some
// future hypothetical command like `/quote` — must guard on event !== null
// instead of assuming it. `live` is null for session-less commands
// (requiresLiveSession:false, e.g. /help); session-control handlers run only
// after the dispatch layer has resolved a live session, so they may assert it.
type ChannelCommandContext = {
  live: LiveSession | null
  event: InboundMessage | null
  // The user who actually invoked the command, supplied by BOTH dispatch
  // paths (text: event.authorId; native slash: options.invokerId, where
  // event is null). /restart stamps the resume handoff's triggeringAuthorId
  // from this so a restart resumes under the INVOKER's author-scoped role,
  // not whichever speaker happened to own the live turn.
  invokerId: string | null
}

export type ExecuteCommandResult =
  | { kind: 'handled'; name: string; reply?: string }
  | { kind: 'unknown-command'; name: string }
  | { kind: 'no-live-session' }
  | { kind: 'permission-denied' }
  | { kind: 'ambiguous'; matchCount: number }

// Identifies who invoked an adapter-driven command. Required so the router
// can run the same channel.respond permission gate the text-prefix command
// path runs (isChannelRespondDenied in route()). Without it, a guest user
// in a public Slack channel could /stop an owner-created session that
// happened to be live, bypassing role gating entirely.
export type ExecuteCommandOptions = {
  invokerId: string
}

export type SendSource = 'tool' | 'system'

export type SendOptions = {
  source?: SendSource
}

export const DUPLICATE_SEND_ERROR =
  'Duplicate not sent. Do not call channel_send/channel_reply again this turn. ' +
  'End with NO_REPLY unless you have genuinely new, non-redundant information.'

export const TURN_CAP_ERROR =
  `Send-cap reached for this turn (${MAX_CHANNEL_SENDS_PER_TURN} messages already sent to this conversation). ` +
  'End your turn now. The user can prompt you again for more output.'

export const SKIP_RESPONSE_LOCK_ERROR =
  'You called `skip_response` earlier in this turn, which committed to staying silent. ' +
  'Channel sends are blocked for the rest of this turn. End your turn now; if you have ' +
  'something to say, send it on the next turn.'

// Adapter-wide catch-all route key suffix. No real workspace uses `*`; adapters
// with workspace-agnostic callbacks register here and exact workspace keys win.
export const ROUTE_WORKSPACE_ANY = '*'

export type ChannelRouter = {
  route: (event: InboundMessage) => Promise<void>
  send: (msg: OutboundMessage, opts?: SendOptions) => Promise<SendResult>
  getConsecutiveSendCount: (target: {
    adapter: ChannelKey['adapter']
    workspace: string
    chat: string
    thread?: string | null
  }) => number
  getSendRate: (target: {
    adapter: ChannelKey['adapter']
    workspace: string
    chat: string
    thread?: string | null
  }) => { count: number; windowMs: number }
  registerOutbound: (adapter: ChannelKey['adapter'], workspace: string, cb: OutboundCallback) => void
  unregisterOutbound: (adapter: ChannelKey['adapter'], workspace: string, cb: OutboundCallback) => void
  registerConfig: (adapter: ChannelKey['adapter'], workspace: string, configRef: ConfigRef) => void
  unregisterConfig: (adapter: ChannelKey['adapter'], workspace: string, configRef: ConfigRef) => void
  // Reaction support is opt-in per adapter: an adapter that never calls
  // registerReaction makes `react` resolve to `code: 'unsupported'`, and
  // auto-react-on-engage becomes a silent no-op for it. Kept separate from
  // the outbound path on purpose — reactions are best-effort side effects, not
  // messages, so they must not flow through send()'s flood/cap/dup/sticky guards.
  registerReaction: (adapter: ChannelKey['adapter'], workspace: string, cb: ReactionCallback) => void
  unregisterReaction: (adapter: ChannelKey['adapter'], workspace: string, cb: ReactionCallback) => void
  react: (req: ReactionRequest) => Promise<ReactionResult>
  registerRemoveReaction: (adapter: ChannelKey['adapter'], workspace: string, cb: RemoveReactionCallback) => void
  unregisterRemoveReaction: (adapter: ChannelKey['adapter'], workspace: string, cb: RemoveReactionCallback) => void
  removeReaction: (req: RemoveReactionRequest) => Promise<ReactionResult>
  registerTyping: (adapter: ChannelKey['adapter'], workspace: string, cb: TypingCallback) => void
  unregisterTyping: (adapter: ChannelKey['adapter'], workspace: string, cb: TypingCallback) => void
  // Deliberately separate from registerTyping: github registers a no-op typing
  // callback (no typing API) yet must stay typing-less, so "has a callback" is
  // the wrong signal. autoReactOnEngage reads this to post :eyes: only as a
  // fallback when no visible typing exists. Unset defaults to false.
  setTypingCapability: (adapter: ChannelKey['adapter'], workspace: string, supported: boolean) => void
  registerChannelNameResolver: (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ChannelNameResolver,
  ) => void
  unregisterChannelNameResolver: (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ChannelNameResolver,
  ) => void
  // Self-identity is a per-adapter singleton (one bot account per adapter),
  // so unlike the multi-resolver registries above this is last-write-wins:
  // register overwrites, unregister clears only if the current resolver is
  // the one being removed (guards against a late stop() of a replaced adapter
  // wiping a fresh registration).
  registerSelfIdentity: (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ChannelSelfIdentityResolver,
  ) => void
  unregisterSelfIdentity: (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ChannelSelfIdentityResolver,
  ) => void
  registerMembership: (adapter: ChannelKey['adapter'], workspace: string, resolver: MembershipResolver) => void
  unregisterMembership: (adapter: ChannelKey['adapter'], workspace: string, resolver: MembershipResolver) => void
  registerHistory: (adapter: ChannelKey['adapter'], workspace: string, cb: HistoryCallback) => void
  unregisterHistory: (adapter: ChannelKey['adapter'], workspace: string, cb: HistoryCallback) => void
  fetchHistory: (
    adapter: ChannelKey['adapter'],
    workspace: string,
    args: FetchHistoryArgs,
  ) => Promise<FetchHistoryResult>
  registerFetchAttachment: (adapter: ChannelKey['adapter'], workspace: string, cb: FetchAttachmentCallback) => void
  unregisterFetchAttachment: (adapter: ChannelKey['adapter'], workspace: string, cb: FetchAttachmentCallback) => void
  fetchAttachment: (
    adapter: ChannelKey['adapter'],
    workspace: string,
    args: FetchAttachmentArgs,
  ) => Promise<FetchAttachmentResult>
  // Review-thread resolution is opt-in per adapter and last-write-wins (one
  // bot account per adapter, like self-identity). An adapter that never calls
  // registerReviewThreadResolver makes `resolveReviewThread` answer
  // `unsupported`. Kept off the outbound path: resolving is a side-effect close-
  // out, not a message, so it bypasses send()'s flood/cap/dup/sticky guards.
  registerReviewThreadResolver: (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ReviewThreadResolver,
  ) => void
  unregisterReviewThreadResolver: (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ReviewThreadResolver,
  ) => void
  resolveReviewThread: (req: ReviewThreadResolveRequest) => Promise<ReviewThreadResolveResult>
  // Re-review stranding guard support: answers whether the bot still holds a
  // blocking CHANGES_REQUESTED on a PR. Opt-in per adapter like the thread
  // resolver; `getReviewState` answers `unsupported` when none is registered.
  registerReviewStateResolver: (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ReviewStateResolver,
  ) => void
  unregisterReviewStateResolver: (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ReviewStateResolver,
  ) => void
  getReviewState: (req: ReviewStateRequest) => Promise<ReviewStateResult>
  lookupInboundAttachment: (args: ChannelKey & { id: number }) => InboundAttachment | null
  listInboundAttachmentIds: (args: ChannelKey) => readonly number[]
  // Stash refs from a channel_history fetch so prior-turn attachments stay
  // resolvable by their placeholder id. Called by the channel_history tool
  // after a successful fetch; no-op when the session is not live.
  registerHistoryAttachments: (key: ChannelKey, messages: readonly ChannelHistoryMessage[]) => void
  // Execute a command by name against an existing live session, bypassing
  // the inbound classifier, engagement gate, debounce, and prompt queue.
  // Used by adapters that receive commands through a native surface
  // (Discord application-command interactions) rather than text. Gates
  // the invoker on channel.respond — same permission gate the text-prefix
  // command path runs — so a guest user cannot abort an owner's session
  // by clicking the slash-command picker. Adapters MUST forward the
  // invoker's platform-specific user id; without it the gate cannot
  // identify the actor and resolves to 'guest' which denies. Returns:
  //   - handled: command ran
  //   - permission-denied: invoker lacks channel.respond
  //   - no-live-session: channel has no active session
  //   - ambiguous: multiple thread-keyed sessions in same chat (Slack);
  //     caller should refuse to act rather than abort an arbitrary one
  //   - unknown-command: name is not registered
  executeCommand: (key: ChannelKey, name: string, options: ExecuteCommandOptions) => Promise<ExecuteCommandResult>
  // Lowered self-aliases (configured + implicit dir-name). Adapters use
  // this to anchor outbound threading on alias-only inbounds — see
  // slack-bot-classify.ts. Read live so a reload of `alias` propagates
  // to adapters without a restart.
  getSelfAliases: () => readonly string[]
  // Inject a `<system-reminder>` block addressed to a live channel session
  // identified by `parentSessionId`. The reminder is rendered into the
  // next turn's user-message body and triggers a drain even if the
  // promptQueue is empty. Returns `delivered` when a matching live
  // session was found and the reminder was queued, `no-live-session`
  // otherwise. Used by the subagent-completion bridge in
  // src/run/index.ts; safe for tests to call directly via a fake router.
  injectSubagentCompletionReminder: (args: {
    parentSessionId: string
    subagent: string
    taskId: string
    ok: boolean
    durationMs: number
    error?: string
    channelKey?: { adapter: string; workspace: string; chat: string; thread: string | null }
  }) => { kind: 'delivered'; keyId: string } | { kind: 'no-live-session' }
  // Fan a LANDED formal review verdict out to the OTHER live sessions reviewing
  // the same PR so they stand down from posting a redundant verdict. Targets every
  // live github session whose chat is `pr:<prNumber>` in `workspace`, EXCLUDING the
  // publisher (`sessionId`). Routes by (workspace, prNumber) across all threads —
  // the duplicate-review fan-out is exactly the per-thread sibling sessions. The
  // injected reminder is advisory (verdict-only stand-down); the hard idempotency
  // guards remain the correctness boundary. Returns how many siblings were nudged.
  injectPrVerdictActivity: (args: {
    workspace: string
    prNumber: number
    verdict: 'APPROVE' | 'REQUEST_CHANGES'
    sessionId: string
  }) => { kind: 'delivered'; count: number }
  // Record that the agent invoked `skip_response` during the current turn
  // for the channel session identified by `parentSessionId`. The reason is
  // logged at INFO level inside `validateChannelTurn` (single log line per
  // skip, so operators see exactly one record per silent turn). Stamps the
  // current `turnSeq` on the live session so a stale record from an earlier
  // turn cannot drop a future legitimate reply.
  //
  // Returns:
  //   - 'recorded'      — silence-first: no send had landed this turn, so the
  //                       skip was stamped and later tool-source sends are
  //                       locked out via the send-after-skip guard in `send()`
  //   - 'recorded-after-send' — reply-first: a tool-source channel send already
  //                       landed this turn and the agent is now going quiet for
  //                       the rest of it (the normal ack-then-wait pattern). The
  //                       delivered reply stands; this skip posts nothing and is
  //                       a terminal no-op. NOT stamped as a skipped turn (a
  //                       reply already landed), and logged inline by the impl.
  //   - 'no-live-session' — no matching channel session (e.g. tool fired
  //                         outside a channel origin); the tool should
  //                         still log the reason but cannot suppress.
  markTurnSkipped: (args: {
    parentSessionId: string
    reason: string
  }) =>
    | { kind: 'recorded'; keyId: string }
    | { kind: 'recorded-after-send'; keyId: string }
    | { kind: 'no-live-session' }
  // Force-clear every sticky credit for one channel key. Stickiness normally
  // expires on TTL or is consumed on the next inbound, but in a busy group each
  // reply re-grants a fresh credit, so the bot can stay force-engaged turn after
  // turn even after being told to stop. This is the escape hatch the
  // `channel_disengage` tool calls to drop back to strict mention/reply/dm
  // engagement without waiting out the window. In-memory only,
  // so a later reply re-grants. `cleared` counts the author credits dropped.
  clearSticky: (key: ChannelKey) => { keyId: string; cleared: number }
  // Two-phase boot restart-resume. Call `reserveRestartHandoff(handoff)` BEFORE
  // `channelManager.start()` to install a per-key gate so an inbound that races
  // the adapters coming online coalesces onto the resume instead of competing
  // with it; then `await reservation.resume()` AFTER start so the reopen + wake
  // reply have registered adapters. Returns null for non-channel handoffs or an
  // unconfigured adapter. `resume()` is safe on a stale/missing mapping — it
  // logs and skips, leaving the todo to resume on the next real inbound.
  reserveRestartHandoff: (handoff: RestartHandoff) => RestartReservation | null
  // Reserve + resume in one call (reserve, then immediately resume). For
  // callers already past adapter startup; prefer the two-phase form at boot.
  resumeRestartHandoff: (handoff: RestartHandoff) => Promise<void>
  stop: () => Promise<void>
  tearDownAllLive: () => Promise<void>
  liveCount: () => number
  __testing?: {
    flushDebounce: (key: ChannelKey) => Promise<void>
    fireTypingHeartbeat: (key: ChannelKey, phase?: 'tick' | 'stop') => Promise<void>
    fireTypingInterval: (key: ChannelKey) => Promise<void>
    isTypingActive: (key: ChannelKey) => boolean
    stopTyping: (key: ChannelKey) => Promise<void>
    resolveSelfIdentity: (key: ChannelKey) => ChannelSelfIdentity | undefined
    runIdleGc: () => Promise<void>
    // Returns the seeded author state on the live session matching
    // `key`, or undefined when no live session exists. Tests use this
    // to pin the symmetric-seeding invariant between `lastTurnAuthorId`
    // (string) and `lastTurnAuthorIds` (Set) at session creation —
    // observable directly here rather than via a downstream sticky-
    // credit grant test that would need to coordinate with multiple
    // subsystems.
    getLiveAuthorState: (key: ChannelKey) =>
      | {
          currentTurnAuthorId: string | null
          currentTurnAuthorIds: readonly string[]
          lastTurnAuthorId: string | null
          lastTurnAuthorIds: readonly string[]
        }
      | undefined
    // Returns a shallow copy of `live.originRef.current` for the live
    // session matching `key`, or undefined when no live session exists.
    // Exists so tests can assert on the per-turn origin that tool.before
    // consumers would see — the origin is normally only observable
    // indirectly via in-flight tool calls, which the fake session doesn't
    // execute. The shallow copy detaches the top-level fields from
    // `originRef` so a later turn replacing `originRef.current` doesn't
    // change a captured assertion. Nested fields (`participants`,
    // `membership`) are still shared by reference; in practice
    // `updateParticipants` returns a fresh array rather than mutating in
    // place, so observed snapshots are stable for the assertions tests
    // make today. NOT a public router method.
    getLiveOriginSnapshot: (key: ChannelKey) => SessionOrigin | undefined
  }
}

// Returns the additional aliases the agent answers to (beyond the
// implicit dir-name). Read from the live config every inbound — `alias`
// is classified `applied` in FIELD_EFFECTS, so a `reload` should change
// engagement behavior immediately. Defaults to an empty list when not
// provided, which means alias-based engagement is effectively off (the
// dir-name is still implicit and added by the router below).
export type AliasesProvider = () => readonly string[]

export type CreateChannelRouterOptions = {
  agentDir: string
  configForAdapter?: ConfigForAdapter
  configuredAliases?: AliasesProvider
  createSessionForChannel?: CreateSessionForChannel
  sessionDir?: string
  logger?: RouterLogger
  // Test seam: clock for sticky/debounce/participants. Defaults to Date.now.
  now?: () => number
  // Test seam: measure a transcript file's byte size for the soft-TTL grace
  // decision. Defaults to a stat()-based reader returning 0 for a missing or
  // unreadable file (grace then fails closed to roll-over-at-soft-TTL).
  measureTranscriptBytes?: (path: string) => number
  // Test seam: override the ensureLive watchdog ceiling so the timeout path
  // is exercisable in <100ms instead of the 30s production default.
  ensureLiveTimeoutMs?: number
  // Test seam: per-callback ceiling for channel name resolvers; mirrors the
  // ensureLive seam so timeout paths can be exercised quickly in tests.
  resolveChannelNamesTimeoutMs?: number
  // Test seam: per-callback ceiling for history fetches.
  fetchHistoryTimeoutMs?: number
  // Test seam: bound the session.idle hook chain so the timeout path is
  // exercisable in tens of milliseconds instead of the 30s default.
  sessionIdleTimeoutMs?: number
  // Wake-up gate: every inbound is gated by `permissions.has(partialOrigin,
  // 'channel.respond')` BEFORE ensureLive. Required by the production
  // wiring (manager.ts forwards `pluginsLoaded.permissions`); defaulted
  // to a grant-all service inside the factory so existing direct test
  // instantiations don't need to inject one. The default is intentionally
  // permissive — the manager-to-router seam is the place where production
  // injection is enforced; direct-router tests opt into gate semantics by
  // passing their own service.
  permissions?: PermissionService
  // Optional role-claim handler. When set, the router intercepts DM
  // inbounds whose text contains a claim code BEFORE the channel.respond
  // gate, hands the inbound to the handler, and short-circuits the normal
  // route path (no session creation, no permission check, no engagement
  // pipeline). The handler returns the reply text the router should send
  // back over the same chat, or null to fall through to normal routing
  // when no pending claim window matches.
  claimHandler?: ClaimHandler
  // Optional in-process Stream. When set, every inbound the router sees
  // is published as a tagged broadcast (`kind: 'channel-inbound'`) so the
  // `/inspect` WS endpoint can surface it live and `stream.scan()` can
  // backfill it on subscribe. Decoupled from the routing decision: even
  // permission-denied and role-claim inbounds publish, so the operator
  // can diagnose silent drops from `typeclaw inspect` alone. Omitted in
  // tests that don't care about inspect surfacing.
  stream?: Stream
  // Operate-the-agent command handlers. When set, the router registers the
  // matching channel command (/reload, /restart) gated on session.admin
  // (owner+trusted). Omitted means the command is not registered at all — it
  // won't appear in /help and a text-prefix or native-slash invocation is
  // treated as unknown. Production wiring (src/run/index.ts via the channel
  // manager) supplies both; tests opt in per-case. `onReload` returns a short
  // human-readable summary posted back to the channel; `onRestart` returns a
  // confirmation string (the container exits shortly after, so the reply is
  // best-effort).
  onReload?: () => Promise<string>
  // `ctx` is present only when the /restart command resolved a live session for
  // the invoking channel (wantsLiveSession). When present, the handler should
  // write a channel-origin resume handoff so the originating conversation
  // resumes on the next boot; when absent (cold channel / native slash with no
  // session) it should just bounce the container with no handoff.
  onRestart?: (ctx?: RestartCommandContext) => Promise<string>
  // Test seam: override the sessions.json writer. Defaults to the disk-backed
  // saveChannelSessions (which swallows its own I/O errors). Tests inject a
  // throwing impl to exercise the persist-failure unwind in ensureLive.
  saveChannelSessions?: (agentDir: string, sessions: readonly ChannelSessionRecord[]) => Promise<void>
  // Returns the start time (epoch ms) of the NEWEST still-running background
  // subagent spawned from `sessionId`, or null when none is running. Lets idle
  // GC and stale-rollover pin a session whose child is still working (the next
  // inbound would otherwise spawn a duplicate child), bounded by
  // SESSION_CHILD_PIN_MAX_MS measured from that start. Newest — not oldest — so a
  // long-running child that crossed the cap cannot unpin the session while a more
  // recently spawned child is still inside its own protection window. Production
  // wiring forwards the LiveSubagentRegistry; omitted (tests, no-subagent setups)
  // means no pin.
  newestRunningChildSubagentStartedAt?: (sessionId: string) => number | null
}

export type RestartCommandContext = {
  originatingSessionId: string
  originatingSessionFile?: string
  handoffOrigin: { kind: 'channel'; key: ChannelKey }
  triggeringAuthorId?: string
}

export type ClaimHandlerInput = {
  adapter: ChannelKey['adapter']
  workspace: string
  chat: string
  isDm: boolean
  authorId: string
  text: string
}

export type ClaimHandlerOutcome =
  | { kind: 'consumed'; reply: string }
  | { kind: 'fail'; reply: string }
  | { kind: 'fallthrough' }

// A boot-time restart-resume reservation for one channel key. `resume()` runs
// the real reopen after adapters are ready; `sawInbound` records whether a real
// inbound coalesced onto it in the meantime (in which case the synthetic wake
// is skipped — the inbound already triggers the turn).
export type RestartReservation = {
  keyId: string
  sawInbound: boolean
  resume: () => Promise<void>
}

export type ClaimHandler = (input: ClaimHandlerInput) => Promise<ClaimHandlerOutcome>

const GRANT_ALL_PERMISSIONS: PermissionService = {
  has: () => true,
  resolveRole: () => 'owner',
  compareRoleSeverity: () => 1,
  describe: () => ({ role: 'owner', permissions: [CORE_PERMISSIONS.channelRespond] }),
  replaceRoles: () => {},
}

export function createChannelRouter(options: CreateChannelRouterOptions): ChannelRouter {
  const routeKeyId = (adapter: ChannelKey['adapter'], workspace: string): string => `${adapter}:${workspace}`
  const resolveRouteKey = <T>(
    map: Map<string, T>,
    adapter: ChannelKey['adapter'],
    workspace: string,
  ): string | null => {
    const exact = routeKeyId(adapter, workspace)
    if (map.has(exact)) return exact
    const catchAll = routeKeyId(adapter, ROUTE_WORKSPACE_ANY)
    return map.has(catchAll) ? catchAll : null
  }
  const resolveRouteEntry = <T>(
    map: Map<string, T>,
    adapter: ChannelKey['adapter'],
    workspace: string,
  ): T | undefined => {
    return map.get(routeKeyId(adapter, workspace)) ?? map.get(routeKeyId(adapter, ROUTE_WORKSPACE_ANY))
  }
  const routeSetHas = (set: Set<string>, adapter: ChannelKey['adapter'], workspace: string): boolean => {
    return set.has(routeKeyId(adapter, workspace)) || set.has(routeKeyId(adapter, ROUTE_WORKSPACE_ANY))
  }
  const logger = options.logger ?? consoleLogger
  const now = options.now ?? Date.now
  const measureTranscriptBytes = options.measureTranscriptBytes ?? defaultMeasureTranscriptBytes
  const ensureLiveTimeoutMs = options.ensureLiveTimeoutMs ?? ENSURE_LIVE_TIMEOUT_MS
  const resolveChannelNamesTimeoutMs = options.resolveChannelNamesTimeoutMs ?? RESOLVE_CHANNEL_NAMES_TIMEOUT_MS
  const fetchHistoryTimeoutMs = options.fetchHistoryTimeoutMs ?? FETCH_HISTORY_TIMEOUT_MS
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS
  const permissions = options.permissions ?? GRANT_ALL_PERMISSIONS
  const claimHandler = options.claimHandler
  const stream = options.stream
  const onReload = options.onReload
  const onRestart = options.onRestart
  const newestRunningChildSubagentStartedAt = options.newestRunningChildSubagentStartedAt ?? (() => null)
  const liveSessions = new Map<string, LiveSession>()
  const creating = new Map<string, Promise<LiveSession>>()
  // Restart-resume reservations, keyed by channelKeyId. Installed by
  // reserveRestartHandoff BEFORE channel adapters start receiving, so an
  // inbound that races the boot resume coalesces onto the reservation (via the
  // `creating` entry it seeds) instead of stale-rolling the mapping or
  // creating a competing session. `sawInbound` is flipped by route() when an
  // inbound waited on it, which suppresses the synthetic wake (the real inbound
  // is the wake). Cleared when the reservation resolves.
  const restartReservations = new Map<string, RestartReservation>()
  // Bumped by tearDownAllLive() and stop() before they tear sessions down. An
  // in-flight ensureLive() captures the value at creation start and re-checks
  // it right before installing into liveSessions; if it changed, a teardown
  // raced ahead of this creation (e.g. a roles.match reload), so the session
  // was built with stale role context and must self-dispose instead of
  // installing — otherwise it would reintroduce the very staleness the
  // teardown was meant to clear.
  let liveGeneration = 0
  // Adapter registries are keyed by route key `${adapter}:${workspace}`, not bare adapter.
  const outboundCallbacks = new Map<string, Set<OutboundCallback>>()
  const configRefs = new Map<string, ConfigRef>()
  const reactionCallbacks = new Map<string, Set<ReactionCallback>>()
  const removeReactionCallbacks = new Map<string, Set<RemoveReactionCallback>>()
  const typingCallbacks = new Map<string, Set<TypingCallback>>()
  const typingCapableAdapters = new Set<string>()
  const channelNameResolvers = new Map<string, Set<ChannelNameResolver>>()
  const membershipResolvers = new Map<string, Set<MembershipResolver>>()
  const selfIdentityResolvers = new Map<string, ChannelSelfIdentityResolver>()
  const membershipCaches = new Map<string, MembershipCache>()
  const historyCallbacks = new Map<string, Set<HistoryCallback>>()
  const fetchAttachmentCallbacks = new Map<string, Set<FetchAttachmentCallback>>()
  const reviewThreadResolvers = new Map<string, ReviewThreadResolver>()
  const reviewStateResolvers = new Map<string, ReviewStateResolver>()
  const stickyLedger = new StickyLedger()
  // The /help handler reads the live registry to enumerate commands, so it
  // forward-references `commands`. Safe at runtime — the handler only runs on
  // invocation, long after the assignment below completes.
  const channelCommands: Command<ChannelCommandContext>[] = [
    {
      name: 'help',
      description: 'List available commands.',
      permission: 'none',
      requiresLiveSession: false,
      handler: () => ({ reply: formatChannelCommandHelp(commands.list()) }),
    },
    {
      name: 'stop',
      description: 'Stop the current agent turn in this channel.',
      permission: 'session.control',
      requiresLiveSession: true,
      handler: async ({ live }) => {
        // requiresLiveSession:true guarantees the dispatch layer resolved a
        // session before running this handler, so `live` is non-null here.
        await stopCurrentChannelTurn(live!)
        return { reply: 'Stopped the current turn.' }
      },
    },
  ]
  // /reload and /restart are registered only when the operate-the-agent
  // callbacks are wired (production via the channel manager). Without them the
  // capability doesn't exist for this router, so the commands stay absent from
  // /help and resolve as unknown — never a silent no-op.
  if (onReload !== undefined) {
    channelCommands.push({
      name: 'reload',
      description: 'Reload typeclaw config and subsystems from disk.',
      permission: 'session.admin',
      requiresLiveSession: false,
      handler: async () => ({ reply: await onReload() }),
    })
  }
  if (onRestart !== undefined) {
    channelCommands.push({
      name: 'restart',
      description: 'Restart the typeclaw container.',
      permission: 'session.admin',
      requiresLiveSession: false,
      // Resolve the live session when one exists so the restart can write a
      // resume handoff for this conversation; still bounces from a cold channel.
      wantsLiveSession: true,
      handler: async ({ live, invokerId }) => ({
        reply: await onRestart(live !== null ? buildRestartCommandContext(live, invokerId) : undefined),
      }),
    })
  }
  const commands = createCommandRegistry<ChannelCommandContext>(channelCommands)

  // Implicit dir-name alias: agent folder basename matches Docker
  // container name (per AGENTS.md), the typical Discord/Slack bot
  // username, and the natural way the operator refers to the agent.
  // Lowered once at construction since basename(agentDir) doesn't change
  // over the router's lifetime; configured aliases are lowered per-call
  // because they're read from live config.
  const dirAlias = basename(options.agentDir).toLocaleLowerCase()
  const computeSelfAliases = (): readonly string[] => {
    const configured = options.configuredAliases?.() ?? []
    const set = new Set<string>([dirAlias])
    for (const a of configured) {
      const lower = a.toLocaleLowerCase()
      if (lower !== '') set.add(lower)
    }
    return Array.from(set)
  }

  const resolveAdapterConfig = (
    adapter: ChannelKey['adapter'],
    workspace: string,
  ): ChannelAdapterConfig | undefined => {
    return resolveRouteEntry(configRefs, adapter, workspace)?.() ?? options.configForAdapter?.(adapter)
  }

  let mappings: ChannelSessionRecord[] | null = null
  let loadOnce: Promise<void> | null = null
  let persistChain: Promise<void> = Promise.resolve()
  // Sealed by teardown so no late fire-and-forget caller appends to persistChain
  // after the flush captured it. `await persistChain` only drains what's enqueued
  // when it evaluates; a write appended afterward would still race a caller that
  // deletes the agent dir right after stop() resolves.
  let closing = false

  const ensureLoaded = async (): Promise<void> => {
    if (mappings !== null) return
    if (loadOnce === null) {
      loadOnce = loadChannelSessions(options.agentDir, logger).then((records) => {
        mappings = records
      })
    }
    await loadOnce
  }

  const saveSessions = options.saveChannelSessions
    ? options.saveChannelSessions
    : (agentDir: string, sessions: readonly ChannelSessionRecord[]): Promise<void> =>
        saveChannelSessions(agentDir, sessions, logger)

  const persist = async (): Promise<void> => {
    if (mappings === null || closing) return
    // Caller awaits `next` un-caught to observe write errors; the chain holds the
    // caught version so one rejection can't poison it or escape as unhandled.
    const next = persistChain.then(async () => {
      if (mappings === null) return
      await saveSessions(options.agentDir, mappings)
    })
    persistChain = next.catch(() => {})
    await next
  }

  const createForChannel: CreateSessionForChannel =
    options.createSessionForChannel ??
    (async ({ key, existingSessionId, existingSessionFile, origin, originRef }) => {
      const sessionDir = options.sessionDir ?? `${options.agentDir}/sessions`
      const sessionManager =
        existingSessionId !== undefined
          ? tryOpenSessionManager(options.agentDir, sessionDir, existingSessionId, existingSessionFile, logger)
          : SessionManager.create(options.agentDir, sessionDir)
      const session = await createSession({
        sessionManager,
        origin,
        originRef,
      })
      const sessionId = sessionManager.getSessionId()
      void key
      return {
        session,
        sessionId,
        dispose: async () => {
          session.dispose()
        },
        getTranscriptPath: () => sessionManager.getSessionFile(),
      }
    })

  const resolveChannelNames = async (key: ChannelKey): Promise<ResolvedChannelNames> => {
    const resolvers = resolveRouteEntry(channelNameResolvers, key.adapter, key.workspace)
    if (!resolvers || resolvers.size === 0) return {}
    const snapshot = Array.from(resolvers)
    const merged: ResolvedChannelNames = {}
    for (const resolver of snapshot) {
      try {
        const result = await raceWithTimeout(
          resolver(key),
          resolveChannelNamesTimeoutMs,
          `[channels] ${channelKeyId(key)}: name resolver`,
        )
        if (result.chatName !== undefined && merged.chatName === undefined) merged.chatName = result.chatName
        if (result.workspaceName !== undefined && merged.workspaceName === undefined) {
          merged.workspaceName = result.workspaceName
        }
      } catch (err) {
        logger.warn(`[channels] name resolver threw for ${channelKeyId(key)}: ${describe(err)}`)
      }
    }
    return merged
  }

  const readMembership = (key: ChannelKey): MembershipCount | null => {
    if (key.workspace === '@dm') return dmMembership(now())
    const cacheKey = resolveRouteKey(membershipCaches, key.adapter, key.workspace)
    return cacheKey !== null ? (membershipCaches.get(cacheKey)?.get(key) ?? null) : null
  }

  const warmMembership = (key: ChannelKey): Promise<MembershipCount | null> | null => {
    if (key.workspace === '@dm') return Promise.resolve(dmMembership(now()))
    const cacheKey = resolveRouteKey(membershipCaches, key.adapter, key.workspace)
    const cache = cacheKey !== null ? membershipCaches.get(cacheKey) : undefined
    if (cache === undefined) return null
    return cache.warmUp(key)
  }

  const resolveThroughRegisteredMembership = async (key: ChannelKey): Promise<MembershipResolverResult> => {
    const resolvers = resolveRouteEntry(membershipResolvers, key.adapter, key.workspace)
    if (!resolvers || resolvers.size === 0) return { kind: 'transient' }
    const snapshot = Array.from(resolvers)
    let lastFailure: MembershipResolverResult = { kind: 'transient' }
    for (const resolver of snapshot) {
      const result = await resolver(key)
      if ('humans' in result) return result
      lastFailure = result
    }
    return lastFailure
  }

  const membershipForPrompt = async (
    key: ChannelKey,
    fetchPromise: Promise<MembershipCount | null> | null,
  ): Promise<MembershipCount | null> => {
    if (key.workspace === '@dm') return dmMembership(now())
    const cached = readMembership(key)
    if (cached !== null) return cached
    if (fetchPromise === null) return null
    return await withMembershipTimeout(fetchPromise, key, logger)
  }

  const membershipForEngagement = async (live: LiveSession): Promise<MembershipCount | null> => {
    if (live.key.workspace === '@dm') return dmMembership(now())
    const cacheKey = resolveRouteKey(membershipCaches, live.key.adapter, live.key.workspace)
    const cache = cacheKey !== null ? membershipCaches.get(cacheKey) : undefined
    if (cache === undefined) return null

    const cached = cache.read(live.key)
    if (cached.kind === 'hit') return cached.membership
    if (cached.kind === 'stale') {
      void cache.warmUp(live.key).catch((err) => {
        logger.warn(`[channels] membership refresh failed for ${live.keyId}: ${describe(err)}`)
      })
      return cached.membership
    }

    const fetchPromise = live.membershipFetch ?? warmMembership(live.key)
    live.membershipFetch = fetchPromise
    if (fetchPromise === null) return null
    const membership = await withMembershipTimeout(fetchPromise, live.key, logger)
    if (live.membershipFetch === fetchPromise) live.membershipFetch = null
    return membership
  }

  // True while a background child spawned from this session is still running AND
  // the newest such child is within SESSION_CHILD_PIN_MAX_MS of its start. Using
  // the newest child keeps the session pinned as long as ANY running child is
  // still inside its protection window — an older child that already crossed the
  // cap must not unpin the session out from under a freshly spawned one. Tearing
  // the session down mid-child lets the next inbound spawn a duplicate child, so
  // GC/rollover defer to this. `label` only annotates the override log.
  const isPinnedByRunningChild = (sessionId: string, keyId: string, label: string): boolean => {
    const childStartedAt = newestRunningChildSubagentStartedAt(sessionId)
    if (childStartedAt === null) return false
    const pinnedForMs = now() - childStartedAt
    if (pinnedForMs <= SESSION_CHILD_PIN_MAX_MS) return true
    logger.info(
      `[channels] ${keyId}: ${label} despite running child (newest pinned ${pinnedForMs}ms, past child-pin cap)`,
    )
    return false
  }

  const shouldRolloverLive = (live: LiveSession, idleMs: number): boolean => {
    // A session mid-prompt looks idle by lastInboundAt (only bumped on engaged
    // inbounds) while session.prompt() is still in flight; rolling it over aborts
    // that work. The runIdleGc path skips draining sessions for the same reason.
    if (live.draining) return false
    if (isPinnedByRunningChild(live.sessionId, live.keyId, 'stale-rollover')) return false
    if (idleMs <= SESSION_FRESHNESS_TTL_MS) return false
    if (idleMs > SESSION_GRACE_HARD_TTL_MS) {
      logger.info(`[channels] ${live.keyId}: stale-rollover (live: ${idleMs}ms idle, past grace cap)`)
      return true
    }
    const transcriptPath = live.getTranscriptPath?.()
    const transcriptBytes = transcriptPath !== undefined ? measureTranscriptBytes(transcriptPath) : 0
    const transcriptDeltaBytes = Math.max(0, transcriptBytes - live.baseContextBytes)
    if (isGraceWorthReusing(live.baseContextBytes, transcriptDeltaBytes)) {
      logger.info(
        `[channels] ${live.keyId}: grace-reuse (live: ${idleMs}ms idle, base=${live.baseContextBytes}B delta=${transcriptDeltaBytes}B)`,
      )
      return false
    }
    logger.info(
      `[channels] ${live.keyId}: stale-rollover (live: ${idleMs}ms idle, base=${live.baseContextBytes}B delta=${transcriptDeltaBytes}B)`,
    )
    return true
  }

  const ensureLive = async (
    key: ChannelKey,
    triggeringMessageId?: string,
    triggeringAuthorId?: string,
    // Restart-resume only: force rehydration of this exact (sessionId,
    // sessionFile) and bypass stale-rollover, so the originating session's
    // `typeclaw.restart-self` entry is reopened rather than rolled into a fresh
    // session (a restart easily outlasts SESSION_FRESHNESS_TTL_MS). The mapping
    // is persisted only through the normal success path below — no pre-mutation
    // — so a reopen failure leaves the durable mapping untouched.
    resumeTarget?: { sessionId: string; sessionFile: string },
  ): Promise<LiveSession> => {
    const keyId = channelKeyId(key)
    const existing = liveSessions.get(keyId)
    if (existing && !existing.destroyed) {
      // A resume that finds the key already live is a no-op for reopening: the
      // session is up, so just hand it back and let the caller enqueue the wake.
      if (resumeTarget !== undefined) return existing
      // Rollover decision (soft TTL → cost-aware grace → hard cap) lives in
      // shouldRolloverLive, which also skips draining sessions so a mid-prompt
      // turn is never aborted by a follow-up's idle check (PR #359 incident).
      const idleMs = now() - existing.lastInboundAt
      if (shouldRolloverLive(existing, idleMs)) {
        await tearDownLive(existing)
        liveSessions.delete(keyId)
        if (mappings) {
          const idx = mappings.findIndex(
            (s) =>
              s.adapter === key.adapter &&
              s.workspace === key.workspace &&
              s.chat === key.chat &&
              (s.thread ?? null) === (key.thread ?? null),
          )
          if (idx >= 0) {
            const prev = mappings[idx]!
            mappings[idx] = {
              adapter: prev.adapter,
              workspace: prev.workspace,
              chat: prev.chat,
              thread: prev.thread,
              participants: prev.participants,
              lastInboundAt: 0,
            }
            await persist()
          }
        }
      } else {
        return existing
      }
    }

    const inFlight = creating.get(keyId)
    if (inFlight) return inFlight

    const generation = liveGeneration

    const promise = (async () => {
      await ensureLoaded()
      const record = mappings ? findRecord(mappings, key) : undefined
      let resolvedRecord = record
      if (
        resumeTarget === undefined &&
        record?.sessionId !== undefined &&
        existing === undefined &&
        now() - (record.lastInboundAt ?? 0) > SESSION_FRESHNESS_TTL_MS &&
        // The live session is already gone here, but a background child it spawned
        // may still be running under its (old) sessionId. Wiping the mapping would
        // start a fresh session that re-spawns the same child. Keep the mapping so
        // the reopen continues the same sessionId until the child finishes (or the
        // pin cap elapses).
        !isPinnedByRunningChild(record.sessionId, keyId, 'stale-rollover (persisted)')
      ) {
        const idleMs = now() - (record.lastInboundAt ?? 0)
        logger.info(`[channels] ${keyId}: stale-rollover (persisted: ${idleMs}ms idle)`)
        resolvedRecord = {
          adapter: record.adapter,
          workspace: record.workspace,
          chat: record.chat,
          thread: record.thread,
          participants: record.participants,
          lastInboundAt: 0,
        }
        if (mappings) {
          const idx = mappings.findIndex(
            (s) =>
              s.adapter === key.adapter &&
              s.workspace === key.workspace &&
              s.chat === key.chat &&
              (s.thread ?? null) === (key.thread ?? null),
          )
          if (idx >= 0) {
            mappings[idx] = resolvedRecord
            await persist()
          }
        }
      }
      if (resumeTarget !== undefined) {
        // Reopen the exact originating session in-memory only; the success
        // path below persists it. Carry the prior record's participants when
        // present so the reopened session keeps its roster.
        resolvedRecord = {
          adapter: key.adapter,
          workspace: key.workspace,
          chat: key.chat,
          thread: key.thread,
          sessionId: resumeTarget.sessionId,
          sessionFile: resumeTarget.sessionFile,
          participants: (record?.participants ?? []) as ChannelParticipant[],
          lastInboundAt: now(),
        }
      }
      const phase = resolvedRecord?.sessionId === undefined ? 'cold-start' : 'rehydrate'
      logger.info(`[channels] ${keyId}: ensureLive begin (${phase})`)
      const participants = (resolvedRecord?.participants ?? []) as ChannelParticipant[]
      const membershipFetch = warmMembership(key)
      // Independent platform lookups — overlap so the chain pays max(), not sum().
      const [resolvedNames, membership] = await Promise.all([
        resolveChannelNames(key),
        membershipForPrompt(key, membershipFetch),
      ])
      logger.info(`[channels] ${keyId}: ensureLive resolved-names-and-membership`)
      // The session-creation origin is what the resource loader sees when it
      // renders the role/permissions block into the system prompt. It must
      // include the triggering author so author-scoped roles
      // (`slack:T/C author:U_ME`) resolve to the same role here that the
      // channel.respond gate just admitted on. Per-turn updates after this
      // point are handled by `originRef.current = buildLiveOrigin(live)`
      // before each prompt() call.
      const self = resolveSelfIdentity(key)
      const origin: SessionOrigin = {
        kind: 'channel',
        adapter: key.adapter,
        workspace: key.workspace,
        ...(resolvedNames.workspaceName !== undefined ? { workspaceName: resolvedNames.workspaceName } : {}),
        chat: key.chat,
        ...(resolvedNames.chatName !== undefined ? { chatName: resolvedNames.chatName } : {}),
        thread: key.thread,
        ...(triggeringAuthorId !== undefined ? { lastInboundAuthorId: triggeringAuthorId } : {}),
        participants,
        ...(membership !== null ? { membership } : {}),
        ...(self !== undefined ? { self } : {}),
      }

      const isColdStart = resolvedRecord?.sessionId === undefined

      // The router writes into this holder before every prompt() so the
      // tool wrappers' getOrigin() sees the current-turn origin.
      const originRef: { current: SessionOrigin | undefined } = { current: origin }

      const created = await createForChannel({
        key,
        ...(resolvedRecord?.sessionId ? { existingSessionId: resolvedRecord.sessionId } : {}),
        ...(resolvedRecord?.sessionFile ? { existingSessionFile: resolvedRecord.sessionFile } : {}),
        participants,
        origin,
        originRef,
      })
      logger.info(`[channels] ${keyId}: ensureLive session-created sessionId=${created.sessionId}`)

      const transcriptPath = created.getTranscriptPath?.()
      const persistedRecord: ChannelSessionRecord = {
        adapter: key.adapter,
        workspace: key.workspace,
        chat: key.chat,
        thread: key.thread,
        sessionId: created.sessionId,
        ...(transcriptPath ? { sessionFile: basename(transcriptPath) } : {}),
        lastInboundAt: now(),
        participants,
      }
      if (mappings) {
        const idx = mappings.findIndex(
          (s) =>
            s.adapter === key.adapter &&
            s.workspace === key.workspace &&
            s.chat === key.chat &&
            (s.thread ?? null) === (key.thread ?? null),
        )
        if (idx >= 0) mappings[idx] = persistedRecord
        else mappings.push(persistedRecord)
      } else {
        mappings = [persistedRecord]
      }
      // Kick off the mapping write now but don't block on it — the disk write is
      // independent of the synchronous `live` build below and the cold-start
      // network prefetch, so we overlap it. Every exit path below MUST settle
      // `persistPromise` (the immediate .catch is only an unhandled-rejection
      // guard; write errors are still surfaced by awaiting it later).
      const persistPromise = persist()
      void persistPromise.catch(() => {})

      const live: LiveSession = {
        key,
        keyId,
        session: created.session,
        turnThinkingDefault: created.session.thinkingLevel,
        lastQuestionSignal: null,
        pendingUserTurnSignal: null,
        sessionId: created.sessionId,
        dispose: created.dispose,
        hooks: created.hooks,
        getTranscriptPath: created.getTranscriptPath,
        participants,
        resolvedNames,
        originRef,
        promptQueue: [],
        pendingSystemReminders: [],
        contextBuffer: [],
        currentTurnAttachments: [],
        historyTimedAttachments: [],
        historyAttachments: [],
        draining: false,
        debounceTimer: null,
        typingTimer: null,
        typingStartedAt: 0,
        typingTimedOut: false,
        typingStopPromise: null,
        promptInFlight: false,
        lastInboundAt: now(),
        baseContextBytes: 0,
        firstUnprocessedAt: 0,
        currentTurnAuthorId: null,
        currentTurnAuthorIds: new Set(),
        currentTurnReactionRef: null,
        currentTurnTypingThread: null,
        currentTurnEngageReactions: [],
        // `lastTurnAuthorId` (string, used for `lastInboundAuthorId` in
        // origin) and `lastTurnAuthorIds` (Set, used by
        // `grantStickyForReplyTargets` as the fallback when
        // `currentTurnAuthorIds` is empty) are seeded TOGETHER from
        // `triggeringAuthorId`. Seeding only the string would leave the
        // Set empty for the cold-start reminder-only path, which is
        // observable when the agent replies during that turn — `send()`
        // would compute an empty `targetIds` and silently drop the
        // sticky-credit grant for the seeded author. The two fields must
        // stay in sync, so they are written in the same statement.
        lastTurnAuthorIds: triggeringAuthorId !== undefined ? new Set([triggeringAuthorId]) : new Set(),
        lastTurnAuthorId: triggeringAuthorId ?? null,
        consecutiveAborts: 0,
        consecutiveSends: new Map(),
        lastSentText: new Map(),
        lastSendLeafId: null,
        sendTimestamps: new Map(),
        successfulChannelSends: 0,
        turnSeq: 0,
        successfulSendsAtTurnStart: 0,
        inFlightToolSends: new Map(),
        policyDeniedToolSendsThisTurn: new Map(),
        emptyTurnRetries: 0,
        willingnessNudges: 0,
        lastTerminalReplyAbort: null,
        abortReasonThisTurn: null,
        nextPromptMaxTokens: undefined,
        skippedTurn: null,
        skipLockedSendTurn: null,
        disengagedTurn: null,
        emptyTurnFallbackTurn: null,
        pendingQuoteCandidate: null,
        recentEngagedPeerBotTurns: [],
        consecutiveEngagedPeerBotTurns: 0,
        loopGuardActive: false,
        multiHumanGroup: false,
        createdFromColdStart: isColdStart,
        coldStartSoloFallbackTurnActive: false,
        membershipFetch,
        pendingProviderError: null,
        destroyed: false,
        unsubProviderErrors: null,
        unsubTypingActivity: null,
        unsubTodoOutcome: null,
      }
      // Raw text is logged on EVERY attempt for operators; the user-facing
      // notice is deferred. The upstream SDK retries internally, and each retry
      // emits its own `message_end` with `stopReason: 'error'` — but the turn
      // frequently recovers and replies anyway. Recording the first error per
      // turn (keyed by `turnSeq`) lets drain()'s turn-end decide: post the
      // notice only if no reply landed, suppress it if the turn recovered. This
      // both dedupes the retry storm AND prevents a stranded false-failure
      // notice above a successful reply. See `pendingProviderError`.
      live.unsubProviderErrors = subscribeProviderErrors(created.session, (err) => {
        logger.error(`[channels] ${live.keyId}: LLM call failed: ${err.message}`)
        if (live.pendingProviderError?.turnSeq === live.turnSeq) return
        live.pendingProviderError = { turnSeq: live.turnSeq, safeMessage: err.safeMessage }
      })
      live.unsubTodoOutcome = created.session.subscribe((event: unknown) => {
        const usage = extractTurnUsage(event)
        if (usage === null) return
        void recordTurnOutcome({
          agentDir: options.agentDir,
          origin: buildLiveOrigin(live),
          turnId: live.sessionId,
          stopReason: usage.stopReason,
          ...(usage.tokens !== undefined ? { tokens: usage.tokens } : {}),
        }).catch((err) => logger.error(`[channels] ${live.keyId}: todo outcome capture failed: ${describe(err)}`))
      })
      live.unsubTypingActivity = subscribeTypingActivity(created.session, live)
      installChannelReplyTerminalHook(live)
      installChannelOutputCap(live)

      // A teardown (roles reload / shutdown) ran while this session was being
      // built, so it carries stale role context. Dispose it instead of
      // installing — installing here is the exact window the race exploits.
      if (generation !== liveGeneration) {
        logger.info(
          `[channels] ${keyId}: discarding session created across a teardown (gen ${generation} → ${liveGeneration})`,
        )
        await tearDownLive(live)
        // Settle the in-flight mapping write before bailing — preserves the
        // pre-overlap contract that a persist failure fails ensureLive.
        await persistPromise
        throw new StaleLiveSessionError(keyId)
      }
      if (isColdStart) {
        // Install before the slow prefetch so a concurrent teardown/shutdown can
        // see and dispose this session during the network fetch.
        liveSessions.set(keyId, live)
        const adapterConfig = resolveAdapterConfig(key.adapter, key.workspace)
        // Overlap the disk mapping-write with the network history prefetch —
        // they are independent. allSettled lets a persist failure take priority
        // (and unwind the install) even if prefetch also rejects.
        const prefetchPromise = adapterConfig
          ? prefetchChannelContext(live, adapterConfig, triggeringMessageId)
          : Promise.resolve()
        const [persistResult, prefetchResult] = await Promise.allSettled([persistPromise, prefetchPromise])
        if (persistResult.status === 'rejected') {
          await unwindInstalledLive(keyId, live)
          throw persistResult.reason
        }
        if (prefetchResult.status === 'rejected') {
          await unwindInstalledLive(keyId, live)
          throw prefetchResult.reason
        }
        if (adapterConfig) logger.info(`[channels] ${keyId}: ensureLive prefetched-context`)
      } else {
        // Rehydrate has no prefetch to overlap, so settle the mapping write
        // before installing — a failed persist must fail ensureLive without
        // leaving a warm session behind for later inbounds to reuse.
        await persistPromise
        liveSessions.set(keyId, live)
      }

      // Snapshot the rendered base context size now, after prefetch and before
      // any user turn, so the soft-TTL grace decision can later compare it
      // against transcript growth. Only meaningful on cold-start (a rehydrated
      // session's file already holds prior conversation, not a clean base).
      const transcriptPathForBase = live.getTranscriptPath?.()
      if (isColdStart && transcriptPathForBase !== undefined) {
        live.baseContextBytes = measureTranscriptBytes(transcriptPathForBase)
      }

      logger.info(`[channels] ${keyId}: ensureLive done (${phase})`)
      return live
    })()

    creating.set(keyId, promise)
    try {
      return await raceWithTimeout(promise, ensureLiveTimeoutMs, `[channels] ${keyId} ensureLive`)
    } catch (err) {
      // The orphaned `promise` may still settle eventually; that's OK because
      // the only side effect it produces post-timeout is a `liveSessions.set`,
      // which the next inbound's existence-check short-circuit at the top of
      // ensureLive will treat as a usable warm session — strictly better than
      // a permanent silent drop. The caller (route() in this file, ultimately
      // the adapter's outer catch) sees the timeout error and logs it.
      logger.error(`[channels] ${keyId}: ensureLive failed: ${describe(err)}`)
      throw err
    } finally {
      // Owner-checked delete: only clear the in-flight marker if it still points
      // at THIS promise. A watchdog timeout can orphan a slow creation whose
      // `finally` runs while a later inbound has already installed its own
      // `creating` entry for the same key; an unconditional delete would drop
      // that newer entry and let a third inbound cold-start a duplicate session
      // (observed: 3 concurrent sessions approving the same PR).
      if (creating.get(keyId) === promise) creating.delete(keyId)
    }
  }

  const prefetchChannelContext = async (
    live: LiveSession,
    adapterConfig: ChannelAdapterConfig,
    triggeringMessageId: string | undefined,
  ): Promise<void> => {
    const prefetch = adapterConfig.history.prefetch
    const isThread = live.key.thread !== null
    const head = isThread ? prefetch.thread.head : 0
    const tail = isThread ? prefetch.thread.tail : prefetch.channel.tail
    if (head === 0 && tail === 0) return

    // One fetch per cold start. We always pass the live thread when present so
    // we get the thread-scoped history; channel cold starts pass `thread: null`
    // so we get the channel scrollback. The router's contract is oldest-first,
    // which lets us slice [head] + [tail] without re-sorting. We over-request
    // by one (head + tail + 1) so we can detect "exactly head + tail" without
    // emitting a misleading elision marker for a zero-length gap.
    const requested = head + tail + 1
    const result = await fetchHistory(live.key.adapter, live.key.workspace, {
      chat: live.key.chat,
      thread: live.key.thread,
      limit: requested,
    })

    if (!result.ok) {
      logger.warn(`[channels] ${live.keyId}: prefetch skipped (history fetch failed: ${result.error})`)
      return
    }

    // Drop the engaging message itself if it appears in the history result.
    // Without this, the model would see the same message twice — once in
    // "Recent context" and once in "Current message". Adapters typically
    // return the latest channel/thread messages, so this overlap is the
    // common case, not the edge case.
    const filteredMessages =
      triggeringMessageId !== undefined
        ? result.messages.filter((m) => m.externalMessageId !== triggeringMessageId)
        : result.messages
    if (filteredMessages.length === 0) return

    const seeded = sliceHeadTail(filteredMessages, head, tail)
    const observed: ObservedInbound[] = []
    for (const item of seeded) {
      if (item.kind === 'message') {
        observed.push({
          text: item.message.text,
          ...(item.message.referenceContext !== undefined ? { referenceContext: item.message.referenceContext } : {}),
          authorId: item.message.authorId,
          authorName: item.message.authorName,
          authorIsBot: item.message.isBot,
          receivedAt: now(),
          ts: item.message.ts,
          source: 'prefetch',
          ...(item.message.attachments !== undefined ? { attachments: item.message.attachments } : {}),
        })
      } else {
        observed.push({
          text: `[… ${item.elidedCount} earlier messages elided; call channel_history for full thread …]`,
          authorId: '__typeclaw_system__',
          authorName: 'TypeClaw',
          authorIsBot: true,
          receivedAt: now(),
          ts: 0,
          source: 'prefetch',
        })
      }
    }

    if (observed.length === 0) return

    // Cold-start prefetch is one-shot and may exceed CONTEXT_BUFFER_SIZE — the
    // 20-message cap exists to bound *runtime* observation drift, not the
    // initial seed. Subsequent observe() calls will trim back to the cap as
    // normal. We push into contextBuffer (not promptQueue) because these are
    // background context for the model, not turns it must respond to.
    live.contextBuffer.push(...observed)
    logger.info(`[channels] ${live.keyId}: prefetched ${observed.length} context messages`)
  }

  const persistParticipants = async (live: LiveSession): Promise<void> => {
    if (mappings === null) return
    const idx = mappings.findIndex(
      (s) =>
        s.adapter === live.key.adapter &&
        s.workspace === live.key.workspace &&
        s.chat === live.key.chat &&
        (s.thread ?? null) === (live.key.thread ?? null),
    )
    if (idx < 0) return
    const next = mappings.slice()
    next[idx] = { ...next[idx]!, participants: live.participants }
    mappings = next
    await persist()
  }

  const fireTyping = async (live: LiveSession, phase: 'tick' | 'stop'): Promise<void> => {
    const callbacks = resolveRouteEntry(typingCallbacks, live.key.adapter, live.key.workspace)
    if (!callbacks || callbacks.size === 0) return
    // Snapshot before iterating: a callback could unregister mid-call.
    const snapshot = Array.from(callbacks)
    const target = {
      adapter: live.key.adapter,
      workspace: live.key.workspace,
      chat: live.key.chat,
      thread: live.key.thread,
      ...(live.currentTurnTypingThread !== null ? { typingThread: live.currentTurnTypingThread } : {}),
      phase,
    }
    await Promise.all(
      snapshot.map((cb) =>
        cb(target).catch((err) => {
          logger.warn(`[channels] typing callback threw for ${live.keyId}: ${describe(err)}`)
        }),
      ),
    )
  }

  const bumpTypingActivity = (live: LiveSession): void => {
    if (live.typingTimer === null) return
    live.typingStartedAt = now()
  }

  // Re-arm a heartbeat that the silence cap already stopped. PR #930 made
  // streamed deltas refresh the clock, but only via `bumpTypingActivity`,
  // which no-ops once `typingTimer` is null. So a turn that goes silent for
  // >MAX_TYPING_HEARTBEAT_MS (a long single tool call, a slow provider, an
  // extended-thinking phase that emits no deltas) trips the cap, and the
  // delta/tool signals that arrive afterwards can no longer revive it —
  // `startTypingHeartbeat` short-circuits on `typingTimedOut`, which only
  // resets at the next drain() iteration (i.e. never, within one long turn).
  // Reviving here lets demonstrable progress after a timeout bring the
  // indicator back. The revival is gated on streamed activity ONLY, never on
  // a new inbound (a later inbound during the same in-flight turn must stay
  // silenced — see the matching router test).
  //
  // On Slack this is the visible bug: its `'stop'` phase sends a permanent
  // empty-string `setStatus` clear that does not auto-expire, so a tripped
  // indicator stays gone. Discord/Telegram mask the same defect because their
  // native indicators auto-expire and self-heal on the next tick.
  const reviveTypingActivity = (live: LiveSession): void => {
    if (live.destroyed) return
    if (!live.typingTimedOut) {
      bumpTypingActivity(live)
      return
    }
    // A `'stop'` clear may still be in flight. Starting a new heartbeat now
    // would short-circuit on the non-null `typingStopPromise` (losing the
    // revival), and firing a fresh `'tick'` before Slack's empty-string clear
    // lands would let the clear wipe the just-revived status. Defer until the
    // stop settles so the new `'tick'` is ordered strictly after the clear.
    const stopPromise = live.typingStopPromise
    if (stopPromise) {
      void stopPromise.catch(() => undefined).then(() => restartTypingAfterTimeout(live))
      return
    }
    restartTypingAfterTimeout(live)
  }

  const restartTypingAfterTimeout = (live: LiveSession): void => {
    // Re-checked after the awaited stop:
    //  - `destroyed`: the session may have been torn down.
    //  - `!typingTimedOut`: an earlier queued revival already cleared the flag
    //    and re-armed (so this one is a no-op — no double interval/tick).
    //  - `!promptInFlight`: the prompt finished while the cap-trip 'stop' was
    //    still in flight. A revival queued by a late delta would otherwise
    //    re-arm a heartbeat after generation ended — a timer nothing stops
    //    (drain()'s turn-end stop already ran with `typingTimer === null`).
    //    `draining` is too coarse: it stays true through the turn-end hook tail
    //    (turn-end/idle/todos) after `prompt()` returns, so a revival running
    //    in that window would still leak. Gate on active generation instead.
    if (live.destroyed || !live.promptInFlight || !live.typingTimedOut) return
    live.typingTimedOut = false
    startTypingHeartbeat(live)
  }

  const subscribeTypingActivity = (session: AgentSession, live: LiveSession): (() => void) => {
    return session.subscribe((event) => {
      if (event.type === 'tool_execution_end') {
        reviveTypingActivity(live)
        return
      }
      if (event.type !== 'message_update') return
      const streamed = event.assistantMessageEvent.type
      if (streamed === 'text_delta' || streamed === 'thinking_delta') {
        reviveTypingActivity(live)
      }
    })
  }

  // After a successful `channel_reply`, the model has delivered its user-facing
  // response and the turn is semantically done. pi-agent-core's loop, however,
  // unconditionally makes one more LLM call after any tool result (the
  // "post-tool follow-up") to let multi-step tool chains continue. On a turn
  // that ended with `channel_reply` there is nothing left to say, and Fireworks'
  // kimi-k2p6-turbo degenerates that empty follow-up into a 32000-token
  // repetition loop (see CHANNEL_MAX_OUTPUT_TOKENS). Aborting the run's signal
  // from `afterToolCall` — which runs during tool execution, before the loop
  // re-enters the LLM stream — makes the follow-up stream observe an already-
  // aborted signal and return `stopReason: 'aborted'` without generating. This
  // is the same `agent.abort()` lever the policy-denied-send cap uses; the
  // tool's own result is already persisted, so the reply still lands.
  //
  // Scope is deliberately narrow: only `channel_reply` (the current-chat user-
  // facing response), only on success, and only for channel sessions. Read-only
  // tools and `channel_send` must keep the follow-up so genuine multi-step turns
  // continue. A prior non-typeclaw `afterToolCall` (none today) would be
  // composed, not clobbered.
  //
  // `channel_reply({ continue: true })` is the explicit opt-out: a mid-turn
  // status reply ("working on it…") that the model follows with more work this
  // turn. The tool surfaces that intent as `details.continue === true`, and we
  // keep the follow-up so the turn proceeds. The kimi 32k loop only recurs when
  // the model genuinely has nothing left to say after a reply, which `continue`
  // asserts is not the case; Layer 2's maxTokens cap still bounds any misuse.
  const installChannelReplyTerminalHook = (live: LiveSession): void => {
    const { agent } = live.session
    const prior = agent.afterToolCall
    agent.afterToolCall = async (context, signal) => {
      const result = prior ? await prior(context, signal) : undefined
      const details = context.result.details as { ok?: unknown; continue?: unknown } | undefined
      const succeeded = context.toolCall.name === 'channel_reply' && !context.isError && details?.ok === true
      const keepTurnAlive = details?.continue === true
      if (succeeded && !keepTurnAlive && agent.signal?.aborted !== true) {
        logger.info(`[channels] ${live.keyId} terminal_after_channel_reply`)
        const replyText = (context.toolCall.arguments as { text?: unknown } | undefined)?.text
        live.lastTerminalReplyAbort = typeof replyText === 'string' ? { turnSeq: live.turnSeq, text: replyText } : null
        live.abortReasonThisTurn = { turnSeq: live.turnSeq, reason: 'terminal_after_channel_reply' }
        agent.abort()
      }
      return result
    }
  }

  // Override pi-ai's hidden `Math.min(model.maxTokens, 32000)` output cap for
  // channel sessions by threading an explicit `maxTokens` into every stream
  // call. See CHANNEL_MAX_OUTPUT_TOKENS for why. Composes the existing streamFn
  // (pi's default `streamSimple` unless a proxy was installed). Precedence:
  // an explicit per-call `maxTokens` always wins; otherwise a one-shot
  // `live.nextPromptMaxTokens` (set by the empty-turn length-retry) is consumed
  // and cleared so the raised budget applies to exactly one stream call;
  // otherwise the default backstop.
  const installChannelOutputCap = (live: LiveSession): void => {
    const { agent } = live.session
    const inner = agent.streamFn
    agent.streamFn = (model, context, options) => {
      let maxTokens = options?.maxTokens
      if (maxTokens === undefined && live.nextPromptMaxTokens !== undefined) {
        maxTokens = live.nextPromptMaxTokens
        live.nextPromptMaxTokens = undefined
      }
      return inner(model, context, { ...options, maxTokens: maxTokens ?? CHANNEL_MAX_OUTPUT_TOKENS })
    }
  }

  const startTypingHeartbeat = (live: LiveSession): void => {
    if (live.typingTimedOut || live.typingStopPromise) return
    if (live.destroyed) return
    if (live.typingTimer) {
      bumpTypingActivity(live)
      return
    }
    live.typingStartedAt = now()
    // Fire immediately so the indicator appears on the very first inbound,
    // not 8 seconds later.
    void fireTyping(live, 'tick')
    live.typingTimer = setInterval(() => {
      if (live.destroyed) {
        void stopTypingHeartbeat(live)
        return
      }
      if (now() - live.typingStartedAt >= MAX_TYPING_HEARTBEAT_MS) {
        logger.warn(
          `[channels] ${live.keyId}: typing indicator paused after ${MAX_TYPING_HEARTBEAT_MS}ms with no activity; prompt still in flight`,
        )
        live.typingTimedOut = true
        void stopTypingHeartbeat(live)
        return
      }
      void fireTyping(live, 'tick')
    }, TYPING_HEARTBEAT_MS)
  }

  const stopTypingHeartbeat = async (live: LiveSession): Promise<void> => {
    if (!live.typingTimer) {
      await live.typingStopPromise
      return
    }
    clearInterval(live.typingTimer)
    live.typingTimer = null
    live.typingStartedAt = 0
    // Fire 'stop' phase even when destroyed: adapters need the chance to
    // clear platform-side state (e.g. Slack's 2-min server timeout) on
    // teardown. The FIFO inside the slack adapter ensures this clear lands
    // AFTER any in-flight 'tick' from the heartbeat that just stopped.
    const stopped = fireTyping(live, 'stop').finally(() => {
      if (live.typingStopPromise === stopped) live.typingStopPromise = null
    })
    live.typingStopPromise = stopped
    await stopped
  }

  const fireSessionIdle = async (live: LiveSession): Promise<void> => {
    if (!live.hooks) return
    const work = live.hooks.runSessionIdle({
      sessionId: live.sessionId,
      parentTranscriptPath: live.getTranscriptPath?.(),
      idleMs: 0,
      origin: buildLiveOrigin(live),
    })
    try {
      await raceWithTimeout(work, sessionIdleTimeoutMs, `[channels] ${live.keyId} session.idle`)
    } catch (err) {
      logger.warn(`[channels] session.idle hook threw for ${live.keyId}: ${describe(err)}`)
    }
  }

  const recordTodoTurnStart = async (live: LiveSession, isRealUserTurn: boolean): Promise<void> => {
    try {
      await recordTurnStart({ agentDir: options.agentDir, origin: buildLiveOrigin(live), isRealUserTurn })
    } catch (err) {
      logger.warn(`[channels] ${live.keyId}: todo turn-start failed: ${describe(err)}`)
    }
  }

  // After the drain queue empties, push at most one continuation reminder into
  // pendingSystemReminders. The enclosing drain `while` re-checks that array,
  // so the reminder is picked up as a batch-empty (injected, non-user) turn in
  // the same drain pass. The episode guard bounds how many times this can
  // re-fire; a reminder-only turn records isRealUserTurn=false so it never
  // resets the budget.
  const maybeContinueTodosChannel = async (live: LiveSession): Promise<void> => {
    if (live.destroyed) return
    if (live.promptQueue.length > 0 || live.pendingSystemReminders.length > 0) return
    try {
      await runIdleContinuation({
        agentDir: options.agentDir,
        origin: buildLiveOrigin(live),
        deliver: (text) => {
          live.pendingSystemReminders.push(text)
        },
      })
    } catch (err) {
      logger.warn(`[channels] ${live.keyId}: todo continuation failed: ${describe(err)}`)
    }
  }

  const fireSessionTurnStart = async (live: LiveSession, userPrompt: string): Promise<{ results: string }> => {
    const retrievalContext = { results: '' }
    if (!live.hooks) return retrievalContext
    try {
      await live.hooks.runSessionTurnStart({
        sessionId: live.sessionId,
        agentDir: options.agentDir,
        userPrompt,
        origin: buildLiveOrigin(live),
        retrievalContext,
      })
    } catch (err) {
      logger.warn(`[channels] session.turn.start hook threw for ${live.keyId}: ${describe(err)}`)
    }
    return retrievalContext
  }

  const fireSessionTurnEnd = async (live: LiveSession): Promise<void> => {
    if (!live.hooks) return
    try {
      await live.hooks.runSessionTurnEnd({
        sessionId: live.sessionId,
        agentDir: options.agentDir,
        origin: buildLiveOrigin(live),
      })
    } catch (err) {
      logger.warn(`[channels] session.turn.end hook threw for ${live.keyId}: ${describe(err)}`)
    }
  }

  const buildRestartCommandContext = (live: LiveSession, invokerId: string | null): RestartCommandContext => {
    // Prefer the command invoker: a restart resumes under the author who ran
    // /restart, not whichever speaker last owned the live turn. Fall back to
    // live turn state only when the dispatch path supplied no invoker.
    const triggeringAuthorId = invokerId ?? live.currentTurnAuthorId ?? live.lastTurnAuthorId ?? undefined
    return {
      originatingSessionId: live.sessionId,
      ...(live.getTranscriptPath?.() !== undefined ? { originatingSessionFile: live.getTranscriptPath!()! } : {}),
      handoffOrigin: { kind: 'channel', key: live.key },
      ...(triggeringAuthorId !== undefined ? { triggeringAuthorId } : {}),
    }
  }

  const buildLiveOrigin = (live: LiveSession): SessionOrigin => {
    const membership = readMembership(live.key)
    const self = resolveSelfIdentity(live.key)
    return {
      kind: 'channel',
      adapter: live.key.adapter,
      workspace: live.key.workspace,
      ...(live.resolvedNames.workspaceName !== undefined ? { workspaceName: live.resolvedNames.workspaceName } : {}),
      chat: live.key.chat,
      ...(live.resolvedNames.chatName !== undefined ? { chatName: live.resolvedNames.chatName } : {}),
      thread: live.key.thread,
      ...(live.currentTurnAuthorId !== null ? { lastInboundAuthorId: live.currentTurnAuthorId } : {}),
      ...(live.currentTurnReactionRef !== null ? { reactionRef: live.currentTurnReactionRef } : {}),
      participants: live.participants,
      ...(membership !== null ? { membership } : {}),
      ...(self !== undefined ? { self } : {}),
    }
  }

  const fireSessionEnd = async (live: LiveSession): Promise<void> => {
    if (!live.hooks) return
    try {
      await live.hooks.runSessionEnd({ sessionId: live.sessionId })
    } catch (err) {
      logger.warn(`[channels] session.end hook threw for ${live.keyId}: ${describe(err)}`)
    }
  }

  const stopCurrentChannelTurn = async (live: LiveSession): Promise<void> => {
    if (live.debounceTimer) clearTimeout(live.debounceTimer)
    live.debounceTimer = null
    live.firstUnprocessedAt = 0
    live.promptQueue.length = 0
    live.pendingSystemReminders.length = 0
    await stopTypingHeartbeat(live)
    try {
      await live.session.abort()
      logger.info(`[channels] ${live.keyId}: command /stop aborted current turn`)
    } catch (err) {
      logger.warn(`[channels] ${live.keyId}: command /stop abort failed: ${describe(err)}`)
    }
  }

  const maybePostDeferredProviderError = async (
    live: LiveSession,
    sentReplyThisTurn: boolean,
    retryQueued: boolean,
  ): Promise<void> => {
    const pending = live.pendingProviderError
    if (pending === null || pending.turnSeq !== live.turnSeq) {
      live.pendingProviderError = null
      return
    }
    // The turn recovered and replied — the provider blip was transient, so a
    // failure notice would be a false alarm stranded above the real reply.
    if (sentReplyThisTurn) {
      live.pendingProviderError = null
      return
    }
    // An empty-turn retry was queued (validateChannelTurn pushed
    // EMPTY_TURN_RETRY_NUDGE): the same logical turn re-prompts in the next
    // drain iteration and may yet recover. Carry the pending error forward,
    // re-stamping to that iteration's turnSeq (drain does `turnSeq++` once per
    // iteration, so it will be exactly `turnSeq + 1`). Posting now would strand
    // a false-failure notice above the retry's eventual reply — the same defect
    // one logical turn later.
    if (retryQueued) {
      live.pendingProviderError = { turnSeq: live.turnSeq + 1, safeMessage: pending.safeMessage }
      return
    }
    live.pendingProviderError = null
    // Genuinely empty turn with no retry left: surface the REDACTED
    // `safeMessage` (never raw provider text, which can carry response bodies /
    // URLs / tokens) via a 'system' send — the one-shot bypass path that lands
    // regardless of per-turn send caps — so the human doesn't just see silence.
    const result = await send(
      {
        adapter: live.key.adapter,
        workspace: live.key.workspace,
        chat: live.key.chat,
        thread: live.key.thread,
        text: `⚠️ ${pending.safeMessage}`,
      },
      { source: 'system' },
    ).catch((sendErr) => {
      logger.warn(`[channels] ${live.keyId}: provider-error notice send threw: ${describe(sendErr)}`)
      return null
    })
    if (result !== null && !result.ok) {
      logger.warn(`[channels] ${live.keyId}: provider-error notice send failed: ${result.error}`)
    }
  }

  const drain = async (live: LiveSession): Promise<void> => {
    if (live.draining || live.destroyed) return
    live.draining = true
    try {
      while ((live.promptQueue.length > 0 || live.pendingSystemReminders.length > 0) && !live.destroyed) {
        live.typingTimedOut = false
        // Heartbeat must run during generation as well as during debounce.
        // Because new inbounds during a turn just push into promptQueue
        // without re-entering route(), the route() call site alone wouldn't
        // keep the indicator alive across multiple drain iterations.
        startTypingHeartbeat(live)
        const batch = live.promptQueue.splice(0, live.promptQueue.length)
        const observed = live.contextBuffer.splice(0, live.contextBuffer.length)
        const reminders = live.pendingSystemReminders.splice(0, live.pendingSystemReminders.length)
        live.currentTurnAttachments = collectTurnAttachments(observed, batch)

        if (batch.length > 0) {
          // A fresh user batch starts a NEW logical turn. Drop any provider
          // error carried forward from a prior turn's empty-turn retry: the
          // drain loop splices promptQueue AND pendingSystemReminders together,
          // so a user message arriving while a retry nudge is pending coalesces
          // into this iteration. Without this clear, the carried error (stamped
          // `turnSeq + 1`) would match this fresh turn and post the prior turn's
          // notice misattributed to an unrelated new message. Carry-forward stays
          // intact for genuinely reminder-only iterations (batch.length === 0),
          // which skip this branch.
          live.pendingProviderError = null
          live.currentTurnAuthorId = batch[batch.length - 1]!.authorId
          live.currentTurnAuthorIds = new Set(batch.map((m) => m.authorId))
          live.currentTurnReactionRef = batch[batch.length - 1]!.reactionRef ?? null
          live.currentTurnTypingThread = batch[batch.length - 1]!.typingThread ?? null
          live.currentTurnEngageReactions = batch.flatMap((m) =>
            m.engageReaction !== undefined ? [m.engageReaction] : [],
          )
          live.consecutiveSends.clear()
          live.lastSentText.clear()
          live.lastSendLeafId = null
          live.pendingQuoteCandidate = captureQuoteCandidate(live.key.adapter, batch, observed)
          // A real user batch starts a fresh logical turn → restore the full
          // empty-turn retry budget and drop any raised output-token budget left
          // over from a prior turn's length-retry. Reset here (batch.length > 0)
          // and NOT in the per-prompt block below, so the reminder-only
          // iterations the retry itself queues do not refill the budget and loop
          // forever (and the raised cap stays scoped to the turn that set it).
          live.emptyTurnRetries = 0
          live.willingnessNudges = 0
          live.abortReasonThisTurn = null
          live.nextPromptMaxTokens = undefined
        } else if (live.lastTurnAuthorId !== null) {
          live.currentTurnEngageReactions = []
          // Reminder-only turn (batch.length === 0, reminders.length > 0):
          // restore the author identity from the prior turn so author-
          // scoped role resolution still works on this turn. The drain
          // finally-block clears `currentTurnAuthorId` between turns, so a
          // reminder arriving while the session is idle would otherwise
          // strip `lastInboundAuthorId` from the tool.before origin and
          // demote roles like `slack:T0/C0 author:U_OWNER` to whichever
          // non-author rule matches — silently breaking the channel_reply
          // that the reminder is asking the agent to send. `lastTurnAuthorId`
          // tracks the LAST speaker of the prior batch (matching normal-
          // turn `batch[batch.length - 1]!.authorId` semantics) so a multi-
          // author prior turn like alice→bob restores `bob`, not alice.
          live.currentTurnAuthorId = live.lastTurnAuthorId
          live.currentTurnAuthorIds = new Set(live.lastTurnAuthorIds)
        } else {
          live.currentTurnEngageReactions = []
        }

        // Update the live origin holder so this turn's tool.before events
        // carry the current actor's id, and resolve the live role from it for
        // the per-turn <your-role> anchor below. Done BEFORE composeTurnPrompt
        // so the anchor reflects the speaker of THIS turn, not the session-
        // creation snapshot the system prompt still renders. Permission gating
        // off `lastInboundAuthorId` happens in the tool layer and sees the same
        // live value.
        live.originRef.current = buildLiveOrigin(live)
        const liveRole = permissions.describe(live.originRef.current).role

        const text = composeTurnPrompt(observed, batch, {
          adapter: live.key.adapter,
          loopGuardActive: live.loopGuardActive,
          groupChatNudge: live.multiHumanGroup,
          systemReminders: reminders,
          role: liveRole,
        })

        // Bracketing logs around the LLM call so a hung prompt() is
        // diagnosable from logs alone (we see prompting without prompted).
        // text length is a proxy for "did we send something at all".
        logger.info(`[channels] ${live.keyId} prompting batch=${batch.length} text_len=${text.length}`)
        const promptStart = now()
        const successfulSendsBeforePrompt = live.successfulChannelSends
        const emptyTurnRetriesBeforePrompt = live.emptyTurnRetries
        const engageAddPromises = live.currentTurnEngageReactions
        live.turnSeq++
        live.successfulSendsAtTurnStart = successfulSendsBeforePrompt
        live.skipLockedSendTurn = null
        live.disengagedTurn = null
        live.emptyTurnFallbackTurn = null
        live.policyDeniedToolSendsThisTurn.clear()
        resetReviewTurn(live.sessionId)
        const isRealUserTurn = batch.length > 0
        const retrievalQuery = composeRetrievalQuery(batch)
        // A fresh real-user batch opens a new logical turn. Capture its question
        // shape as PENDING (committed only once the turn completes below). The
        // drain is serial and retries are reminder-only, so a prior pending must
        // already be resolved; a leftover here means a logical turn never
        // completed — fail closed by discarding it rather than misattributing.
        if (isRealUserTurn) {
          live.pendingUserTurnSignal = { signal: getQuestionSignal(retrievalQuery) }
        }
        const retrievalContext = await fireSessionTurnStart(live, retrievalQuery)
        const promptText = retrievalContext.results.length > 0 ? `${text}\n\n${retrievalContext.results}` : text
        applyTurnThinkingLevel(live.session, retrievalQuery, live.turnThinkingDefault, live.lastQuestionSignal)
        live.promptInFlight = true
        try {
          await live.session.prompt(promptText)
          await validateChannelTurn(live, successfulSendsBeforePrompt)
          live.consecutiveAborts = 0
          // Resolve the pending logical-turn signal on a binary rule: ONLY a
          // usable assistant reply (real model prose the user saw) seeds the next
          // turn's escalation. Every other terminal outcome CLEARS lastQuestionSignal
          // so an older question can't leak across the failed/silent turn:
          //   - retry queued (`length`/`aborted`, budget left): turn still in
          //     flight → leave both for the reminder-only iteration that ends it.
          //   - usable reply → commit the pending signal.
          //   - provider error / empty-turn fallback / NO_REPLY / skip (no usable
          //     reply) → clear BOTH (pending and lastQuestionSignal).
          // A fallback sends via source:'system', which also bumps
          // successfulChannelSends, so it must be excluded explicitly.
          const retryQueuedThisTurn = live.emptyTurnRetries > emptyTurnRetriesBeforePrompt
          const providerErrorThisTurn = assistantLeafStopReason(live.session) === 'error'
          const fallbackPostedThisTurn = live.emptyTurnFallbackTurn === live.turnSeq
          const sentReplyThisTurn = live.successfulChannelSends > successfulSendsBeforePrompt
          const usableReplyThisTurn = sentReplyThisTurn && !fallbackPostedThisTurn && !providerErrorThisTurn
          if (live.pendingUserTurnSignal !== null && !retryQueuedThisTurn) {
            live.lastQuestionSignal = usableReplyThisTurn ? live.pendingUserTurnSignal.signal : null
            live.pendingUserTurnSignal = null
          }
          logger.info(`[channels] ${live.keyId} prompted elapsed_ms=${now() - promptStart}`)
        } catch (err) {
          logger.error(`[channels] ${live.keyId}: prompt threw: ${describe(err)}`)
          live.consecutiveSends.clear()
          live.lastSentText.clear()
          live.lastSendLeafId = null
          // A thrown prompt is a non-usable terminal outcome: drop pending AND
          // clear the prior signal so an older question can't leak across it.
          live.pendingUserTurnSignal = null
          live.lastQuestionSignal = null
        } finally {
          live.promptInFlight = false
          const sentReplyThisTurn = live.successfulChannelSends > successfulSendsBeforePrompt
          if (sentReplyThisTurn) dropEngageReactionsAfterReply(live, engageAddPromises)
          const emptyTurnRetryQueued = live.emptyTurnRetries > emptyTurnRetriesBeforePrompt
          await maybePostDeferredProviderError(live, sentReplyThisTurn, emptyTurnRetryQueued)
          await fireSessionTurnEnd(live)
        }
        await fireSessionIdle(live)
        await recordTodoTurnStart(live, isRealUserTurn)
        await maybeContinueTodosChannel(live)
        live.lastTurnAuthorIds = new Set(live.currentTurnAuthorIds)
        if (live.currentTurnAuthorId !== null) {
          live.lastTurnAuthorId = live.currentTurnAuthorId
        }
      }
    } finally {
      live.draining = false
      live.currentTurnAuthorId = null
      live.currentTurnAuthorIds = new Set()
      live.currentTurnReactionRef = null
      live.currentTurnEngageReactions = []
      live.currentTurnAttachments = []
      // Reset AFTER stopTypingHeartbeat: its final 'stop' tick reads the anchor
      // to clear a flat-DM status; clearing it first would strand the indicator.
      await stopTypingHeartbeat(live)
      live.currentTurnTypingThread = null
    }
  }

  const scheduleDebouncedDrain = (live: LiveSession): void => {
    if (live.debounceTimer) clearTimeout(live.debounceTimer)
    const t = now()
    const sinceLast = t - live.lastInboundAt
    const baseWait = sinceLast < HOT_THRESHOLD_MS ? HOT_DEBOUNCE_MS : INITIAL_DEBOUNCE_MS
    if (live.firstUnprocessedAt === 0) live.firstUnprocessedAt = t
    const elapsedSinceFirst = t - live.firstUnprocessedAt
    const wait = Math.max(0, Math.min(baseWait, MAX_DEBOUNCE_MS - elapsedSinceFirst))
    live.lastInboundAt = t
    if (mappings) {
      const idx = mappings.findIndex(
        (s) =>
          s.adapter === live.key.adapter &&
          s.workspace === live.key.workspace &&
          s.chat === live.key.chat &&
          (s.thread ?? null) === (live.key.thread ?? null),
      )
      if (idx >= 0) {
        mappings[idx] = { ...mappings[idx]!, lastInboundAt: t }
        void persist()
      }
    }
    live.debounceTimer = setTimeout(() => {
      live.debounceTimer = null
      live.firstUnprocessedAt = 0
      void drain(live)
    }, wait)
  }

  const publishInbound = (
    event: InboundMessage,
    decision: 'engage' | 'observe' | 'denied' | 'claim',
    // Undefined before a session exists (denied/claim intercepts). Carried so a
    // session-scoped `typeclaw inspect` only sees its own session's inbounds —
    // the broadcast otherwise fans out to every inspect client.
    sessionId?: string,
  ): void => {
    if (stream === undefined) return
    try {
      stream.publish({
        target: { kind: 'broadcast' },
        payload: {
          kind: 'channel-inbound',
          ...(sessionId !== undefined ? { sessionId } : {}),
          adapter: event.adapter,
          workspace: event.workspace,
          chat: event.chat,
          thread: event.thread,
          authorId: event.authorId,
          authorName: event.authorName,
          authorIsBot: event.authorIsBot,
          isDm: event.isDm,
          isBotMention: event.isBotMention,
          text: event.text,
          externalMessageId: event.externalMessageId,
          ts: event.ts,
          decision,
        },
      })
    } catch (err) {
      logger.warn(`[channels] inbound stream publish failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Executes a parsed channel command and posts its reply (if any) back to the
  // originating channel. Shared by the pre-gate public-command fast path and the
  // post-gate command block so the execute→reply shape can't drift between them.
  // Gating (channel.respond / session.control) and live-session resolution stay
  // at the call sites — this helper only runs the handler and delivers the reply.
  const runChannelCommand = async (event: InboundMessage, live: LiveSession | null): Promise<CommandResult> => {
    const result = await commands.execute(event.text, { live, event, invokerId: event.authorId })
    if (result.kind === 'handled' && result.reply !== undefined) {
      await send(
        {
          adapter: event.adapter,
          workspace: event.workspace,
          chat: event.chat,
          thread: event.thread,
          text: result.reply,
        },
        { source: 'system' },
      )
    }
    return result
  }

  const route = async (event: InboundMessage): Promise<void> => {
    const adapterConfig = resolveAdapterConfig(event.adapter, event.workspace)
    if (!adapterConfig) return

    const key: ChannelKey = {
      adapter: event.adapter,
      workspace: event.workspace,
      chat: event.chat,
      thread: event.thread,
    }

    // Role-claim intercept runs BEFORE the channel.respond gate so the
    // operator can bootstrap permissions on a fresh agent that has no
    // role match rules yet. Cheap pre-check: any inbound whose text
    // contains a `claim-` prefix is a candidate, and only when a handler
    // is registered. Everything else falls straight through to the gate.
    // Claims are accepted from any chat (DM, group, thread) because the
    // resulting match rule is platform-wide + author-scoped — see
    // src/role-claim/match-rule.ts.
    if (claimHandler !== undefined && extractClaimCode(event.text) !== null) {
      const outcome = await claimHandler({
        adapter: event.adapter,
        workspace: event.workspace,
        chat: event.chat,
        isDm: event.isDm,
        authorId: event.authorId,
        text: event.text,
      })
      if (outcome.kind !== 'fallthrough') {
        publishInbound(event, 'claim')
        logger.info(
          `[channels] ${channelKeyId(key)}: claim ${outcome.kind} author=${event.authorId} id=${event.externalMessageId}`,
        )
        await send(
          {
            adapter: event.adapter,
            workspace: event.workspace,
            chat: event.chat,
            thread: event.thread,
            text: outcome.reply,
          },
          { source: 'system' },
        )
        return
      }
    }

    // Parse once, here, so the public-command fast path (below) and the
    // post-gate command block share one parse and lookup.
    const parsedCommand = commands.parse(event.text)
    const commandInfo = parsedCommand === null ? undefined : commands.get(parsedCommand.name)

    // Public-command fast path: a known command that is both ungated
    // (permission:'none') AND informational (requiresLiveSession:false) runs
    // BEFORE the channel.respond gate, mirroring the native-slash path where
    // such commands skip permissions entirely. Both conditions are required so
    // a future "public but live-session-aware" command can't silently bypass
    // the gate. It only reveals already-public command names — it never creates
    // a session or prompts the agent — so it is not a channel.respond bypass in
    // any meaningful sense. Unknown commands, /stop, //escaped text, and plain
    // messages all fall through to the gate unchanged.
    if (parsedCommand !== null && commandInfo?.permission === 'none' && !commandInfo.requiresLiveSession) {
      await runChannelCommand(event, null)
      return
    }

    if (isChannelRespondDenied(event)) {
      publishInbound(event, 'denied')
      logger.info(
        `[channels] ${channelKeyId(key)}: denied by permissions (channel.respond) author=${event.authorId} id=${event.externalMessageId}`,
      )
      return
    }

    if (parsedCommand !== null) {
      // Commands are control traffic, not engaged inbounds; if the session is stale,
      // the next engaged inbound will perform the rollover before prompting.
      const keyId = channelKeyId(key)
      if (commandInfo === undefined) {
        logger.info(`[channels] ${keyId}: ignoring unknown command /${parsedCommand.name}`)
        return
      }
      const requiredPermission = commandPermissionString(commandInfo.permission)
      if (requiredPermission !== null && !permissions.has(inboundAuthorOrigin(event), requiredPermission)) {
        logger.info(
          `[channels] ${keyId}: denied command /${parsedCommand.name} by permissions (${requiredPermission}) author=${event.authorId}`,
        )
        return
      }
      // Session-less commands (e.g. /help) are informational and run without a
      // live session; their handler reply is posted straight back to the channel.
      // `wantsLiveSession` commands (/restart) resolve an existing session when
      // present but do not abort when absent.
      let existingLive: LiveSession | null = null
      if (commandInfo.requiresLiveSession) {
        existingLive = liveSessions.get(keyId) ?? null
        if (existingLive === null || existingLive.destroyed) {
          logger.info(`[channels] ${keyId}: ignoring command /${parsedCommand.name} with no live session`)
          return
        }
      } else if (commandInfo.wantsLiveSession) {
        const candidate = liveSessions.get(keyId) ?? null
        existingLive = candidate !== null && !candidate.destroyed ? candidate : null
      }
      const commandResult = await runChannelCommand(event, existingLive)
      if (commandResult.kind !== 'not-command') return
    }

    // If a boot restart-resume reservation is pending for this key, mark that a
    // real inbound arrived: ensureLive below will coalesce onto the reservation
    // (via its `creating` seed), and the reservation's resume() will skip the
    // synthetic wake since this inbound already triggers the turn.
    const reservation = restartReservations.get(channelKeyId(key))
    if (reservation !== undefined) reservation.sawInbound = true

    const live = await ensureLive(key, event.externalMessageId, event.authorId)

    const isNewAuthor = !live.participants.some((p) => p.authorId === event.authorId)
    live.participants = updateParticipants(
      live.participants,
      event.authorId,
      event.authorName,
      now(),
      event.authorIsBot,
    )
    void persistParticipants(live)

    // A previously-unseen author just spoke. The cached membership count
    // (from /members or history-derived) was computed without them, so
    // invalidate and warm in the background. We don't await — the warmup
    // runs alongside this turn's `membershipForEngagement` call so the
    // *next* turn sees fresh data, but the current turn still gets a
    // fast answer (cache miss → cold fetch with timeout, or stale-ok).
    if (isNewAuthor && live.key.workspace !== '@dm') {
      const cacheKey = resolveRouteKey(membershipCaches, live.key.adapter, live.key.workspace)
      const cache = cacheKey !== null ? membershipCaches.get(cacheKey) : undefined
      if (cache !== undefined) {
        cache.invalidate(live.key)
        void cache.warmUp(live.key).catch((err) => {
          logger.warn(`[channels] membership warmup after new author failed for ${live.keyId}: ${describe(err)}`)
        })
      }
    }

    const membership = await membershipForEngagement(live)

    const effectiveHumans = countEffectiveHumans(live.participants, membership, now())
    live.multiHumanGroup = isMultiHumanGroup(event.isDm, effectiveHumans)

    const decision: EngagementDecision = decideEngagement({
      message: event,
      config: adapterConfig.engagement,
      key: live.keyId,
      ledger: stickyLedger,
      now: now(),
      participants: live.participants,
      membership,
      selfAliases: computeSelfAliases(),
      botInThread: hasBotParticipated(live),
    })

    if (decision === 'observe') {
      publishInbound(event, 'observe', live.sessionId)
      // Log every observe so an unanswered mention is diagnosable from logs
      // alone instead of "routed but no prompting" silence. The bracketed
      // shape mirrors `prompting batch=` so log scraping can pair them.
      logger.info(`[channels] ${live.keyId} observed id=${event.externalMessageId}`)
      observe(live, event)
      return
    }

    publishInbound(event, 'engage', live.sessionId)

    // Arm cold-start bare-empty recovery only for the exact incident shape: the
    // FIRST prompt (`turnSeq === 0`) of a freshly cold-started session that
    // engaged via the solo-human answer-everything fallback — a lone human, no
    // explicit mention/reply/DM, not a multi-human group. Recomputed on every
    // engage so it self-clears once the first turn advances `turnSeq`; explicit
    // address (mention/reply/DM) keeps the historical silent-on-empty path.
    live.coldStartSoloFallbackTurnActive =
      live.createdFromColdStart &&
      live.turnSeq === 0 &&
      effectiveHumans <= 1 &&
      !event.authorIsBot &&
      !event.isDm &&
      !event.isBotMention &&
      event.replyToBotMessageId === null &&
      !live.multiHumanGroup

    const engageReaction = autoReactOnEngage(event)

    updateLoopGuard(live, event)

    enqueue(live, event, engageReaction)

    // Start showing "typing..." the moment we know we're going to engage,
    // so users see the indicator during the debounce window — not just
    // during LLM generation. drain() will keep it alive across iterations
    // and the finally-block will stop it when the queue empties.
    startTypingHeartbeat(live)

    if (live.draining) {
      // In-flight turn; let coalesce-on-drain pick it up. Same-author abort
      // is a v0.2 enhancement once we have safe abort semantics through
      // pi-coding-agent for in-flight tool calls.
      return
    }
    scheduleDebouncedDrain(live)
  }

  const inboundAuthorOrigin = (event: InboundMessage): SessionOrigin => ({
    kind: 'channel',
    adapter: event.adapter,
    workspace: event.workspace,
    chat: event.chat,
    thread: event.thread,
    lastInboundAuthorId: event.authorId,
  })

  const isChannelRespondDenied = (event: InboundMessage): boolean =>
    !permissions.has(inboundAuthorOrigin(event), CORE_PERMISSIONS.channelRespond)

  // Gated separately from channelRespond so a respond-capable guest (an
  // operator can grant guest channelRespond for masked stranger turns)
  // cannot /stop another speaker's in-flight turn. session.control is
  // member-and-up by default.
  // Maps a command's declared permission tier to the concrete permission
  // string gated on both the text-prefix path (route) and the native-slash
  // path (executeCommand). 'none' is never gated. session.admin (owner+trusted,
  // not member) covers /reload and /restart, which mutate global agent state
  // and drop every in-flight session. Centralized so a new tier can't be
  // honored on one path and silently skipped on the other.
  const commandPermissionString = (permission: CommandPermission): string | null => {
    switch (permission) {
      case 'none':
        return null
      case 'session.control':
        return CORE_PERMISSIONS.sessionControl
      case 'session.admin':
        return CORE_PERMISSIONS.sessionAdmin
    }
  }

  const updateLoopGuard = (live: LiveSession, event: InboundMessage): void => {
    if (!event.authorIsBot) {
      live.recentEngagedPeerBotTurns.length = 0
      live.consecutiveEngagedPeerBotTurns = 0
      live.loopGuardActive = false
      return
    }
    const t = now()
    live.consecutiveEngagedPeerBotTurns++
    live.recentEngagedPeerBotTurns.push({ authorId: event.authorId, ts: t })
    const cutoff = t - PEER_BOT_TURNS_WINDOW_MS
    while (live.recentEngagedPeerBotTurns.length > 0 && live.recentEngagedPeerBotTurns[0]!.ts < cutoff) {
      live.recentEngagedPeerBotTurns.shift()
    }
    if (
      live.consecutiveEngagedPeerBotTurns >= MAX_CONSECUTIVE_PEER_BOT_TURNS_SINCE_HUMAN ||
      live.recentEngagedPeerBotTurns.length >= MAX_PEER_BOT_TURNS_IN_WINDOW
    ) {
      live.loopGuardActive = true
    }
  }

  const hasBotParticipated = (live: LiveSession): boolean => {
    if (live.successfulChannelSends > 0) return true
    // Only OUR own prefetched history counts as participation — matching any
    // bot here let a PEER bot's buffered message flip botInThread=true,
    // neutralizing the replyToOtherMessageId suppressor and engaging us in a
    // thread aimed at another bot. Self id is unavailable during the startup
    // identity race; then this falls back to successfulChannelSends, which is
    // safe (conservative: we just don't claim participation we can't prove).
    const selfId = resolveSelfIdentity(live.key)?.id
    if (selfId === undefined) return false
    for (const item of live.contextBuffer) {
      if (item.authorId === selfId) return true
    }
    return false
  }

  const observe = (live: LiveSession, event: InboundMessage): void => {
    live.contextBuffer.push({
      text: event.text,
      ...(event.referenceContext !== undefined ? { referenceContext: event.referenceContext } : {}),
      ...(event.attachments !== undefined && event.attachments.length > 0 ? { attachments: event.attachments } : {}),
      authorId: event.authorId,
      authorName: event.authorName,
      authorIsBot: event.authorIsBot,
      receivedAt: now(),
      ts: event.ts,
      source: 'observed',
    })
    if (live.contextBuffer.length > CONTEXT_BUFFER_SIZE) {
      live.contextBuffer.splice(0, live.contextBuffer.length - CONTEXT_BUFFER_SIZE)
    }
  }

  const enqueue = (
    live: LiveSession,
    event: InboundMessage,
    engageReaction: Promise<ReactionRef | null> | null,
  ): void => {
    live.promptQueue.push({
      text: event.text,
      ...(event.referenceContext !== undefined ? { referenceContext: event.referenceContext } : {}),
      ...(event.attachments !== undefined && event.attachments.length > 0 ? { attachments: event.attachments } : {}),
      authorId: event.authorId,
      authorName: event.authorName,
      authorIsBot: event.authorIsBot,
      externalMessageId: event.externalMessageId,
      ...(event.reactionRef !== undefined ? { reactionRef: event.reactionRef } : {}),
      ...(engageReaction !== null ? { engageReaction } : {}),
      isBotMention: event.isBotMention,
      replyToBotMessageId: event.replyToBotMessageId,
      isDm: event.isDm,
      ...(event.typingThread !== undefined ? { typingThread: event.typingThread } : {}),
      receivedAt: now(),
      ts: event.ts,
    })
    // Make the typing anchor live BEFORE startTypingHeartbeat fires (route()
    // starts the heartbeat right after enqueue, ahead of drain). drain() later
    // refreshes it to the last inbound of a coalesced batch.
    if (event.typingThread !== undefined) live.currentTurnTypingThread = event.typingThread
  }

  const registerOutbound = (adapter: ChannelKey['adapter'], workspace: string, cb: OutboundCallback): void => {
    const rk = routeKeyId(adapter, workspace)
    let set = outboundCallbacks.get(rk)
    if (!set) {
      set = new Set()
      outboundCallbacks.set(rk, set)
    }
    set.add(cb)
  }

  const registerConfig = (adapter: ChannelKey['adapter'], workspace: string, configRef: ConfigRef): void => {
    configRefs.set(routeKeyId(adapter, workspace), configRef)
  }

  const unregisterConfig = (adapter: ChannelKey['adapter'], workspace: string, configRef: ConfigRef): void => {
    const rk = routeKeyId(adapter, workspace)
    if (configRefs.get(rk) === configRef) {
      configRefs.delete(rk)
    }
  }

  const registerReaction = (adapter: ChannelKey['adapter'], workspace: string, cb: ReactionCallback): void => {
    const rk = routeKeyId(adapter, workspace)
    let set = reactionCallbacks.get(rk)
    if (!set) {
      set = new Set()
      reactionCallbacks.set(rk, set)
    }
    set.add(cb)
  }

  const unregisterReaction = (adapter: ChannelKey['adapter'], workspace: string, cb: ReactionCallback): void => {
    reactionCallbacks.get(routeKeyId(adapter, workspace))?.delete(cb)
  }

  const registerRemoveReaction = (
    adapter: ChannelKey['adapter'],
    workspace: string,
    cb: RemoveReactionCallback,
  ): void => {
    const rk = routeKeyId(adapter, workspace)
    let set = removeReactionCallbacks.get(rk)
    if (!set) {
      set = new Set()
      removeReactionCallbacks.set(rk, set)
    }
    set.add(cb)
  }

  const unregisterRemoveReaction = (
    adapter: ChannelKey['adapter'],
    workspace: string,
    cb: RemoveReactionCallback,
  ): void => {
    removeReactionCallbacks.get(routeKeyId(adapter, workspace))?.delete(cb)
  }

  const react = async (req: ReactionRequest): Promise<ReactionResult> => {
    if (req.reactionRef.adapter !== req.adapter) {
      return { ok: false, error: 'reaction ref adapter mismatch', code: 'unsupported' }
    }
    const callbacks = resolveRouteEntry(reactionCallbacks, req.adapter, req.workspace)
    if (!callbacks || callbacks.size === 0) {
      return { ok: false, error: `adapter "${req.adapter}" does not support reactions`, code: 'unsupported' }
    }
    let lastError: ReactionResult | undefined
    for (const cb of Array.from(callbacks)) {
      // A ReactionCallback that throws must not reject this promise: react() is
      // called both fire-and-forget (autoReactOnEngage) and awaited by the
      // channel_react tool, and neither should have to wrap it in try/catch. A
      // throw is converted to a transient failure result so every caller gets a
      // uniform { ok: false } instead of an exception.
      const result = await cb(req).catch(
        (err): ReactionResult => ({ ok: false, error: describe(err), code: 'transient' }),
      )
      if (result.ok) return result
      lastError = result
    }
    return lastError ?? { ok: false, error: 'no reaction callback handled request', code: 'unsupported' }
  }

  const removeReaction = async (req: RemoveReactionRequest): Promise<ReactionResult> => {
    if (req.reactionRef.adapter !== req.adapter) {
      return { ok: false, error: 'reaction ref adapter mismatch', code: 'unsupported' }
    }
    const callbacks = resolveRouteEntry(removeReactionCallbacks, req.adapter, req.workspace)
    if (!callbacks || callbacks.size === 0) {
      return { ok: false, error: `adapter "${req.adapter}" does not support reaction removal`, code: 'unsupported' }
    }
    let lastError: ReactionResult | undefined
    for (const cb of Array.from(callbacks)) {
      const result = await cb(req).catch(
        (err): ReactionResult => ({ ok: false, error: describe(err), code: 'transient' }),
      )
      if (result.ok) return result
      lastError = result
    }
    return lastError ?? { ok: false, error: 'no reaction removal callback handled request', code: 'unsupported' }
  }

  // Best-effort acknowledgment: drop an :eyes: on the triggering inbound the
  // moment we decide to engage — but ONLY when the channel has no visible
  // "typing…" indicator. Where typing renders (slack/discord/telegram) the
  // heartbeat already signals "the bot is working", so the reaction would be
  // redundant noise; the :eyes: is the fallback ack for typing-less channels
  // (github, kakaotalk), replacing the old "On it" comment on GitHub.
  // Fire-and-forget so a reaction failure (missing permission, the adapter not
  // supporting reactions, a transient API error) can NEVER block engagement,
  // enqueueing, or the agent's actual reply. No reactionRef = nothing reactable
  // (synthetic inbounds, reaction-less adapters) = silent skip.
  const autoReactOnEngage = (event: InboundMessage): Promise<ReactionRef | null> | null => {
    if (event.reactionRef === undefined) return null
    if (routeSetHas(typingCapableAdapters, event.adapter, event.workspace)) return null
    const addResult = react({
      adapter: event.adapter,
      workspace: event.workspace,
      chat: event.chat,
      thread: event.thread,
      reactionRef: event.reactionRef,
      emoji: ENGAGE_REACTION_EMOJI,
    })
    const addReactionRef = addResult.then((r) => (r.ok ? (r.reactionRef ?? null) : null)).catch(() => null)
    void addResult
      .then((result) => {
        if (!result.ok && result.code !== 'unsupported') {
          logger.info(`[channels] engage-react failed adapter=${event.adapter} chat=${event.chat}: ${result.error}`)
        }
      })
      .catch((err) => {
        logger.info(`[channels] engage-react threw adapter=${event.adapter} chat=${event.chat}: ${describe(err)}`)
      })
    return addReactionRef
  }

  const dropEngageReactionsAfterReply = (live: LiveSession, addPromises: Array<Promise<ReactionRef | null>>): void => {
    for (const addPromise of addPromises) dropOneEngageReactionAfterReply(live, addPromise)
  }

  const dropOneEngageReactionAfterReply = (live: LiveSession, addPromise: Promise<ReactionRef | null>): void => {
    void addPromise
      .then((reactionRef) => {
        if (reactionRef === null) return undefined
        return removeReaction({
          adapter: live.key.adapter,
          workspace: live.key.workspace,
          chat: live.key.chat,
          thread: live.key.thread,
          reactionRef,
        })
      })
      .then((result) => {
        if (result && !result.ok && result.code !== 'unsupported' && result.code !== 'not-found') {
          logger.info(
            `[channels] engage-unreact failed adapter=${live.key.adapter} chat=${live.key.chat}: ${result.error}`,
          )
        }
      })
      .catch((err) => {
        logger.info(
          `[channels] engage-unreact threw adapter=${live.key.adapter} chat=${live.key.chat}: ${describe(err)}`,
        )
      })
  }

  const unregisterOutbound = (adapter: ChannelKey['adapter'], workspace: string, cb: OutboundCallback): void => {
    outboundCallbacks.get(routeKeyId(adapter, workspace))?.delete(cb)
  }

  const registerTyping = (adapter: ChannelKey['adapter'], workspace: string, cb: TypingCallback): void => {
    const rk = routeKeyId(adapter, workspace)
    let set = typingCallbacks.get(rk)
    if (!set) {
      set = new Set()
      typingCallbacks.set(rk, set)
    }
    set.add(cb)
  }

  const unregisterTyping = (adapter: ChannelKey['adapter'], workspace: string, cb: TypingCallback): void => {
    typingCallbacks.get(routeKeyId(adapter, workspace))?.delete(cb)
  }

  const setTypingCapability = (adapter: ChannelKey['adapter'], workspace: string, supported: boolean): void => {
    const rk = routeKeyId(adapter, workspace)
    if (supported) typingCapableAdapters.add(rk)
    else typingCapableAdapters.delete(rk)
  }

  const registerChannelNameResolver = (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ChannelNameResolver,
  ): void => {
    const rk = routeKeyId(adapter, workspace)
    let set = channelNameResolvers.get(rk)
    if (!set) {
      set = new Set()
      channelNameResolvers.set(rk, set)
    }
    set.add(resolver)
  }

  const unregisterChannelNameResolver = (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ChannelNameResolver,
  ): void => {
    channelNameResolvers.get(routeKeyId(adapter, workspace))?.delete(resolver)
  }

  const registerSelfIdentity = (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ChannelSelfIdentityResolver,
  ): void => {
    selfIdentityResolvers.set(routeKeyId(adapter, workspace), resolver)
  }

  const unregisterSelfIdentity = (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ChannelSelfIdentityResolver,
  ): void => {
    const rk = routeKeyId(adapter, workspace)
    if (selfIdentityResolvers.get(rk) === resolver) {
      selfIdentityResolvers.delete(rk)
    }
  }

  const resolveSelfIdentity = (key: ChannelKey): ChannelSelfIdentity | undefined => {
    const resolver = resolveRouteEntry(selfIdentityResolvers, key.adapter, key.workspace)
    if (resolver === undefined) return undefined
    return resolver(key.workspace) ?? undefined
  }

  const registerMembership = (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: MembershipResolver,
  ): void => {
    const rk = routeKeyId(adapter, workspace)
    let set = membershipResolvers.get(rk)
    if (!set) {
      set = new Set()
      membershipResolvers.set(rk, set)
    }
    set.add(resolver)
    if (!membershipCaches.has(rk)) {
      membershipCaches.set(rk, createMembershipCache({ resolver: resolveThroughRegisteredMembership, now, logger }))
    }
  }

  const unregisterMembership = (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: MembershipResolver,
  ): void => {
    const rk = routeKeyId(adapter, workspace)
    membershipResolvers.get(rk)?.delete(resolver)
    if ((membershipResolvers.get(rk)?.size ?? 0) === 0) {
      membershipCaches.delete(rk)
    }
  }

  const registerHistory = (adapter: ChannelKey['adapter'], workspace: string, cb: HistoryCallback): void => {
    const rk = routeKeyId(adapter, workspace)
    let set = historyCallbacks.get(rk)
    if (!set) {
      set = new Set()
      historyCallbacks.set(rk, set)
    }
    set.add(cb)
  }

  const unregisterHistory = (adapter: ChannelKey['adapter'], workspace: string, cb: HistoryCallback): void => {
    historyCallbacks.get(routeKeyId(adapter, workspace))?.delete(cb)
  }

  const fetchHistory = async (
    adapter: ChannelKey['adapter'],
    workspace: string,
    args: FetchHistoryArgs,
  ): Promise<FetchHistoryResult> => {
    const callbacks = resolveRouteEntry(historyCallbacks, adapter, workspace)
    if (!callbacks || callbacks.size === 0) {
      return { ok: false, error: 'history-not-supported' }
    }
    // Snapshot before iterating, mirroring `send`: a callback that mutates
    // the set (e.g. unregisters mid-call) must not skip siblings.
    const snapshot = Array.from(callbacks)
    let lastError: FetchHistoryResult & { ok: false } = { ok: false, error: 'history-not-supported' }
    for (const cb of snapshot) {
      try {
        const result = await raceWithTimeout(cb(args), fetchHistoryTimeoutMs, `[channels] ${adapter} history fetch`)
        if (result.ok) return result
        lastError = result
      } catch (err) {
        logger.warn(`[channels] history fetch threw for ${adapter}: ${describe(err)}`)
        lastError = { ok: false, error: 'history-not-supported' }
      }
    }
    return lastError
  }

  const registerFetchAttachment = (
    adapter: ChannelKey['adapter'],
    workspace: string,
    cb: FetchAttachmentCallback,
  ): void => {
    const rk = routeKeyId(adapter, workspace)
    let set = fetchAttachmentCallbacks.get(rk)
    if (!set) {
      set = new Set()
      fetchAttachmentCallbacks.set(rk, set)
    }
    set.add(cb)
  }

  const unregisterFetchAttachment = (
    adapter: ChannelKey['adapter'],
    workspace: string,
    cb: FetchAttachmentCallback,
  ): void => {
    fetchAttachmentCallbacks.get(routeKeyId(adapter, workspace))?.delete(cb)
  }

  const fetchAttachment = async (
    adapter: ChannelKey['adapter'],
    workspace: string,
    args: FetchAttachmentArgs,
  ): Promise<FetchAttachmentResult> => {
    const callbacks = resolveRouteEntry(fetchAttachmentCallbacks, adapter, workspace)
    if (!callbacks || callbacks.size === 0) {
      return { ok: false, error: `no fetchAttachment callback registered for "${adapter}"` }
    }
    const snapshot = Array.from(callbacks)
    // Initialized only so TypeScript can prove the variable is assigned
    // before return. The loop body always overwrites it on the failure
    // path (we just returned on the success path), so this string is
    // unreachable at runtime — kept as a clearly-tagged sentinel rather
    // than a non-null assertion so a future loop refactor that breaks
    // this invariant surfaces a recognizable error string.
    let lastError: FetchAttachmentResult & { ok: false } = {
      ok: false,
      error: `fetchAttachment for "${adapter}" returned no result (router bug)`,
    }
    for (const cb of snapshot) {
      const result = await cb(args)
      if (result.ok) return result
      lastError = result
    }
    return lastError
  }

  const registerReviewThreadResolver = (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ReviewThreadResolver,
  ): void => {
    reviewThreadResolvers.set(routeKeyId(adapter, workspace), resolver)
  }

  const unregisterReviewThreadResolver = (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ReviewThreadResolver,
  ): void => {
    const rk = routeKeyId(adapter, workspace)
    if (reviewThreadResolvers.get(rk) === resolver) {
      reviewThreadResolvers.delete(rk)
    }
  }

  const resolveReviewThread = async (req: ReviewThreadResolveRequest): Promise<ReviewThreadResolveResult> => {
    const resolver = resolveRouteEntry(reviewThreadResolvers, req.adapter, req.workspace)
    if (resolver === undefined) {
      return {
        ok: false,
        error: `adapter "${req.adapter}" does not support review-thread resolution`,
        code: 'unsupported',
      }
    }
    return await resolver(req).catch(
      (err): ReviewThreadResolveResult => ({ ok: false, error: describe(err), code: 'transient' }),
    )
  }

  const registerReviewStateResolver = (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ReviewStateResolver,
  ): void => {
    reviewStateResolvers.set(routeKeyId(adapter, workspace), resolver)
  }

  const unregisterReviewStateResolver = (
    adapter: ChannelKey['adapter'],
    workspace: string,
    resolver: ReviewStateResolver,
  ): void => {
    const rk = routeKeyId(adapter, workspace)
    if (reviewStateResolvers.get(rk) === resolver) {
      reviewStateResolvers.delete(rk)
    }
  }

  const getReviewState = async (req: ReviewStateRequest): Promise<ReviewStateResult> => {
    const resolver = resolveRouteEntry(reviewStateResolvers, req.adapter, req.workspace)
    if (resolver === undefined) {
      return { ok: false, error: `adapter "${req.adapter}" does not support review-state lookup`, code: 'unsupported' }
    }
    return await resolver(req).catch(
      (err): ReviewStateResult => ({ ok: false, error: describe(err), code: 'transient' }),
    )
  }

  const lookupInboundAttachment = (args: ChannelKey & { id: number }): InboundAttachment | null => {
    const live = liveSessions.get(channelKeyId(args))
    if (live === undefined) return null
    // Walk newest → oldest so that when an id collides across messages
    // (e.g. two photos in the same session each labelled `#1`) the agent's
    // `attachment_id: 1` always resolves to the CURRENT inbound's
    // attachment. currentTurnAttachments holds the in-flight turn — the
    // only place the about-to-be-viewed attachment lives once drain() has
    // spliced promptQueue empty — and is therefore the freshest; promptQueue
    // then holds any inbound that arrived mid-turn. Within each list,
    // append-order maps to wall-clock order, so iterating in reverse gives
    // recency.
    const found = findAttachmentById(live.currentTurnAttachments, args.id)
    if (found !== null) return found
    const haystacks: ReadonlyArray<ReadonlyArray<{ attachments?: readonly InboundAttachment[] }>> = [
      live.promptQueue,
      live.contextBuffer,
    ]
    for (const haystack of haystacks) {
      for (let i = haystack.length - 1; i >= 0; i--) {
        const item = haystack[i]
        const hit = item?.attachments?.find((attachment) => attachment.id === args.id)
        if (hit !== undefined) return hit
      }
    }
    return findAttachmentById(live.historyAttachments, args.id)
  }

  const listInboundAttachmentIds = (args: ChannelKey): readonly number[] => {
    const live = liveSessions.get(channelKeyId(args))
    if (live === undefined) return []
    const ids = new Set<number>()
    for (const attachment of live.currentTurnAttachments) ids.add(attachment.id)
    for (const item of [...live.promptQueue, ...live.contextBuffer]) {
      for (const attachment of item.attachments ?? []) ids.add(attachment.id)
    }
    for (const attachment of live.historyAttachments) ids.add(attachment.id)
    return Array.from(ids).sort((a, b) => a - b)
  }

  const registerHistoryAttachments = (key: ChannelKey, messages: readonly ChannelHistoryMessage[]): void => {
    const live = liveSessions.get(channelKeyId(key))
    if (live === undefined) return
    const incoming: TimedAttachment[] = messages.flatMap((message) =>
      (message.attachments ?? []).map((attachment) => ({ ts: message.ts, attachment })),
    )
    if (incoming.length === 0) return
    // Order by message freshness, NOT append order: channel_history pages
    // OLDER messages via nextCursor, so a later call can deliver an OLDER ref.
    // findAttachmentById searches end-first, so the list MUST end with the
    // freshest ref or an older paged `#1` would shadow a newer one. Dedupe by
    // id keeping the freshest ts (a re-fetch of the same message is a no-op,
    // not a duplicate), sort ascending by ts, then keep the freshest LIMIT so
    // eviction drops the OLDEST refs, never newer ones.
    const byId = new Map<number, TimedAttachment>()
    for (const entry of [...live.historyTimedAttachments, ...incoming]) {
      const existing = byId.get(entry.attachment.id)
      if (existing === undefined || entry.ts >= existing.ts) byId.set(entry.attachment.id, entry)
    }
    const sorted = Array.from(byId.values()).sort((a, b) => a.ts - b.ts)
    const kept =
      sorted.length > HISTORY_ATTACHMENT_LIMIT ? sorted.slice(sorted.length - HISTORY_ATTACHMENT_LIMIT) : sorted
    live.historyTimedAttachments = kept
    live.historyAttachments = kept.map((entry) => entry.attachment)
  }

  const send = async (msg: OutboundMessage, opts?: SendOptions): Promise<SendResult> => {
    const source: SendSource = opts?.source ?? 'tool'
    const callbacks = resolveRouteEntry(outboundCallbacks, msg.adapter, msg.workspace)
    if (!callbacks || callbacks.size === 0) {
      return { ok: false, error: `no adapter registered for "${msg.adapter}"`, code: 'no-adapter' }
    }

    // Strip leaked `<think>` reasoning off the message itself, up front, so the
    // stripped text flows through EVERY downstream consumer: the flood check,
    // the duplicate guard, the quote-anchor prepend, and the adapter callback.
    // A body that was nothing but a think block collapses to undefined and is
    // delivered as a text-less send (attachments, if any, still go through).
    if (msg.text !== undefined) {
      msg = { ...msg, text: normalizeSendText(msg.text) }
    }

    const authoredText = msg.text
    if (authoredText !== undefined) {
      const flood = checkOutboundFlood(authoredText)
      if (!flood.ok) return { ok: false, error: OUTBOUND_FLOOD_ERROR, code: 'outbound-flood' }
    }

    const keyId = channelKeyId({
      adapter: msg.adapter,
      workspace: msg.workspace,
      chat: msg.chat,
      thread: msg.thread ?? null,
    })
    const live = liveSessions.get(keyId)
    const sendKey = consecutiveSendKey(msg.chat, msg.thread)
    // Tool-source sends consume the captured quote candidate exactly
    // once per turn — the intervening-observed check runs HERE against
    // the live buffer so the relevant signal is actual channel chatter
    // between inbound and reply landing, not drain-vs-send timing
    // artifacts. System sources (recovery, role-
    // claim) skip so they can't accidentally swallow the candidate
    // before the model's own first reply lands. Even when the decision
    // returns null (nothing intervened), the candidate is cleared — a
    // multi-part reply must not retroactively anchor chunk 2.
    if (live && source === 'tool' && live.pendingQuoteCandidate !== null) {
      const quoteCandidate = refreshQuoteCandidate(live.pendingQuoteCandidate, live.contextBuffer)
      const anchor = decideQuoteAnchor(quoteCandidate, now(), resolveAdapterConfig(msg.adapter, msg.workspace))
      if (anchor !== null) {
        msg =
          resolveReplyRenderMode(msg) === 'native'
            ? { ...msg, replyTo: { externalMessageId: anchor.externalMessageId, source: anchor.source } }
            : { ...msg, text: prependQuoteAnchor(msg.text ?? '', anchor.source) }
      }
      live.pendingQuoteCandidate = null
    }
    const text = normalizeSendText(msg.text)

    // Central enforcement. Tool-initiated sends are subject to two policies:
    // a per-turn count cap (kills runaway loops regardless of content) and
    // an exact-duplicate guard (kills the byte-identical-spam sub-mode).
    // Both checks AND the state mutations they consult happen synchronously
    // before any `await`, so two concurrent `router.send` calls for the same
    // target (the parallel-tool-execution race) cannot both pass: the
    // second observer sees the first one's increment / lastSentText write.
    // System sources (validateChannelTurn recovery, role-claim reply) bypass
    // — those are one-shot paths the policy doesn't apply to.
    let priorLastSentText: string | undefined
    let reserved = false
    if (live && source === 'tool') {
      // Every same-turn policy denial (skip-locked / turn-cap / duplicate)
      // returns a soft error and does NOT increment `consecutiveSends`, so a
      // model that ignores the denial and retries never trips the send cap. To
      // bound that loop we route all three through one tally that ABORTS the run
      // past the ceiling. The discriminator that keeps legitimate parallel
      // send-bursts soft: a denial only counts when NO reservation for the same
      // target is in flight. In a `Promise.all` burst the synchronous denials
      // all race the one in-flight winner, so they don't count; a sequential
      // retry loop has nothing in flight, so it does. See
      // `MAX_POLICY_DENIED_CHANNEL_SENDS_PER_TURN`.
      //
      // Why abort, not throw: pi-agent-core's tool executor catches a throw
      // from a tool's execute() and converts it into an `isError` tool result —
      // the turn would continue and the model could retry. The only thing that
      // actually ends an in-flight turn is aborting the run's AbortSignal:
      // `agent.abort()` flips it synchronously, then the NEXT assistant stream
      // (after this tool returns) sees the aborted signal and ends the turn with
      // stopReason 'aborted'. We must NOT call `session.abort()` here — it
      // `await`s `waitForIdle()`, which would deadlock waiting for the very run
      // this tool call belongs to. `agent.abort()` is the signal-only,
      // non-blocking variant. We still return the soft denial for this call.
      const denyPolicyToolSend = (error: string, code: SendErrorCode): SendResult => {
        if ((live.inFlightToolSends.get(sendKey) ?? 0) > 0) {
          return { ok: false, error, code }
        }
        const count = (live.policyDeniedToolSendsThisTurn.get(sendKey) ?? 0) + 1
        live.policyDeniedToolSendsThisTurn.set(sendKey, count)
        if (count >= MAX_POLICY_DENIED_CHANNEL_SENDS_PER_TURN) {
          logger.warn(`[channels] ${live.keyId}: aborting turn — ${count} policy-denied channel sends (last: ${code})`)
          live.abortReasonThisTurn = { turnSeq: live.turnSeq, reason: `policy_denied:${code}` }
          if (live.session.agent.signal?.aborted !== true) live.session.agent.abort()
        }
        return { ok: false, error, code }
      }
      // Tool-source send after `skip_response` for the same turn is a contract
      // violation: the model already committed to silence. Reject before any
      // state mutation so the model gets a clear error and the channel stays
      // silent. System-source sends (recovery, role-claim) are not affected.
      // Record the contested skip so `validateChannelTurn` doesn't ALSO drop the
      // reply text on the floor — the live send stays denied, but the post-turn
      // recovery net must still surface what the model wanted to say.
      if (live.skippedTurn !== null && live.skippedTurn.turnSeq === live.turnSeq) {
        live.skipLockedSendTurn = live.turnSeq
        return denyPolicyToolSend(SKIP_RESPONSE_LOCK_ERROR, 'skip-locked')
      }
      const currentCount = live.consecutiveSends.get(sendKey) ?? 0
      if (currentCount >= MAX_CHANNEL_SENDS_PER_TURN) {
        return denyPolicyToolSend(TURN_CAP_ERROR, 'turn-cap')
      }
      if (text !== undefined && live.lastSentText.get(sendKey) === text) {
        return denyPolicyToolSend(DUPLICATE_SEND_ERROR, 'duplicate')
      }
      // Reserve the slot before awaiting. If the callback rejects we roll
      // back below; if it succeeds we keep the increment. The slot reserve
      // is what makes parallel tool calls safe. We also snapshot the prior
      // lastSentText so a transient delivery failure can be retried with
      // the same text — the dup-guard exists to stop runaway loops, not to
      // strand the model on a flaky adapter.
      priorLastSentText = live.lastSentText.get(sendKey)
      live.consecutiveSends.set(sendKey, currentCount + 1)
      if (text !== undefined) live.lastSentText.set(sendKey, text)
      live.inFlightToolSends.set(sendKey, (live.inFlightToolSends.get(sendKey) ?? 0) + 1)
      reserved = true
    }

    // The adapter needs the typing anchor to clear a flat-DM status (msg.thread
    // is null there, so a thread-keyed clear would no-op). Kept off msg.thread
    // to leave reply threading untouched.
    if (live?.currentTurnTypingThread != null && msg.typingThread === undefined) {
      msg = { ...msg, typingThread: live.currentTurnTypingThread }
    }

    // Snapshot the callbacks before iterating so a callback that mutates the
    // set (e.g. unregisters mid-send) does not cause the iterator to skip
    // siblings or trip into surprising behavior.
    const snapshot = Array.from(callbacks)
    let lastError: string | undefined
    let delivered = false
    let messageId: string | undefined
    let messageIds: readonly string[] | undefined
    try {
      for (const cb of snapshot) {
        const result = await cb(msg)
        if (result.ok) {
          delivered = true
          messageId = result.messageId
          messageIds = result.messageIds
          break
        }
        lastError = result.error
      }
    } finally {
      // Clear the in-flight reservation even if a callback threw, so a flaky
      // adapter can never strand a target as permanently "in flight" and
      // disable the policy-denial guard for it.
      if (live && reserved) {
        const inFlight = (live.inFlightToolSends.get(sendKey) ?? 1) - 1
        if (inFlight <= 0) live.inFlightToolSends.delete(sendKey)
        else live.inFlightToolSends.set(sendKey, inFlight)
      }
    }

    if (!delivered) {
      // Roll back the slot reservation so a failed send doesn't burn cap
      // budget or poison the dup-guard. Restoring lastSentText to its
      // prior value (which may be undefined) lets a legitimate retry of
      // the same text succeed — the dup-guard is for loops, not flake.
      if (live && reserved) {
        const after = (live.consecutiveSends.get(sendKey) ?? 1) - 1
        if (after <= 0) live.consecutiveSends.delete(sendKey)
        else live.consecutiveSends.set(sendKey, after)
        if (priorLastSentText === undefined) live.lastSentText.delete(sendKey)
        else live.lastSentText.set(sendKey, priorLastSentText)
      }
      return { ok: false, error: lastError ?? 'no callback accepted the outbound', code: 'callback-rejected' }
    }

    if (live) {
      live.successfulChannelSends++
      live.lastSendLeafId = live.session.sessionManager.getLeafEntry()?.id ?? null
      live.policyDeniedToolSendsThisTurn.delete(sendKey)
      // Don't stop the heartbeat here: the agent may still be mid-turn and
      // about to send another reply. drain()'s finally block owns turn-end
      // stop. But Slack's adapter outbound callback explicitly clears
      // platform-side typing after every successful postMessage (to defeat
      // the heartbeat-vs-postMessage race fixed in PR #52), so a fresh
      // 'tick' must land in the FIFO right after that clear — otherwise
      // the indicator stays cleared until the next 8s interval, leaving a
      // visible idle gap between mid-turn sends on Slack. The await on
      // cb(msg) above already drained the outbound callback's clearAfterSend
      // through the per-(chat,thread) FIFO, so this tick is guaranteed to
      // land after it. Discord and Telegram treat the extra tick as a
      // no-op refresh of their already-armed (auto-expiring) indicators.
      if (live.typingTimer) void fireTyping(live, 'tick')
      // Disengage is binding for the rest of the turn: if the model dropped
      // sticky via `channel_disengage` this turn, a same-turn ack reply must NOT
      // silently re-grant the credit it just cleared. Skipped only for the live
      // turn (matched by `turnSeq`); the next turn re-grants normally.
      const disengagedThisTurn = live.disengagedTurn !== null && live.disengagedTurn === live.turnSeq
      const adapterConfig = resolveAdapterConfig(msg.adapter, msg.workspace)
      if (adapterConfig && !disengagedThisTurn) {
        const targets = new Set(live.currentTurnAuthorIds.size > 0 ? live.currentTurnAuthorIds : live.lastTurnAuthorIds)
        // A user the agent addresses by @-mention is a reply target too: their
        // next message answers us without re-mentioning the bot. Granting them
        // sticky closes the gap where the agent asks "<@U123> can you confirm?"
        // and that user's plain reply was observed until they re-pinged.
        // Self-mentions (e.g. a quoted inbound) are excluded — we credit the
        // OTHERS we addressed, not ourselves.
        if (text !== undefined) {
          const selfId = resolveSelfIdentity(live.key)?.id
          for (const id of extractMentionedUserIds(msg.adapter, text)) {
            if (id !== selfId) targets.add(id)
          }
        }
        if (targets.size > 0) {
          grantStickyForReplyTargets(stickyLedger, keyId, Array.from(targets), adapterConfig.engagement, now())
        }
      }
      const turnCount = live.consecutiveSends.get(sendKey) ?? 0
      const rateCount = recordSendTimestamp(live, sendKey, now())
      const level = rateCount >= SEND_RATE_WARN_THRESHOLD ? 'warn' : 'info'
      const warn = rateCount >= SEND_RATE_WARN_THRESHOLD ? ' send_rate_warning' : ''
      const textLen = text !== undefined ? text.length : 0
      const fields = `source=${source} turn=${turnCount} rate=${rateCount}/${SEND_RATE_WINDOW_MS}ms text_len=${textLen}`
      logger[level](`[channels] ${live.keyId} send ${fields}${warn}`)
    }

    return {
      ok: true,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(messageIds !== undefined ? { messageIds } : {}),
    }
  }

  // The turn ended via the terminal-reply abort. If that reply promised to keep
  // working but omitted `continue: true`, queue ONE reminder-only re-prompt so
  // the model gets a second chance to actually do it. The abort already fired
  // (safe default preserved); this only adds an optional nudge. Bounded by
  // MAX_WILLINGNESS_NUDGES and gated on `promptQueue` being empty so a real
  // inbound that coalesced into this turn is never answered with a stale nudge.
  const maybeNudgeContinuationWillingness = (live: LiveSession): void => {
    const record = live.lastTerminalReplyAbort
    live.lastTerminalReplyAbort = null
    if (record === null || record.turnSeq !== live.turnSeq) return
    if (live.willingnessNudges >= MAX_WILLINGNESS_NUDGES) return
    if (live.promptQueue.length > 0) return
    if (!detectContinuationWillingness(record.text)) return
    live.willingnessNudges++
    logger.info(
      `[channels] ${live.keyId} willingness_nudge attempt=${live.willingnessNudges}/${MAX_WILLINGNESS_NUDGES}`,
    )
    live.pendingSystemReminders.push(WILLINGNESS_NUDGE)
  }

  const validateChannelTurn = async (live: LiveSession, successfulSendsBeforePrompt: number): Promise<void> => {
    // `skip_response` short-circuit. Honoring it bypasses recovery entirely.
    // Stale-flag protection: only honor when stamped on the just-completed
    // turn. A flag set by a previous turn that crashed before validation
    // would otherwise drop the next legitimate user-facing reply.
    //
    // Contested-skip carve-out: if the model ALSO attempted a tool-source send
    // this turn (denied `skip-locked` in `send()`, stamped on `skipLockedSendTurn`),
    // the skip is no longer a clean opt-out — the model produced reply text it
    // wanted delivered. The live send stays denied, but we must NOT also suppress
    // recovery, or the reply is silently dropped with nothing to retry it (the
    // inbound is already drained). Fall through to the normal recovery path, which
    // posts it via `source:'system'` under the existing NO_REPLY / leak guards.
    const skipContested = live.skipLockedSendTurn === live.turnSeq
    if (live.skippedTurn !== null && live.skippedTurn.turnSeq === live.turnSeq && !skipContested) {
      const { reason } = live.skippedTurn
      live.skippedTurn = null
      logger.info(`[channels] ${live.keyId} skipped_by_tool reason=${JSON.stringify(reason)}`)
      return
    }
    if (live.skippedTurn !== null && live.skippedTurn.turnSeq === live.turnSeq) {
      // Clear the now-contested skip so it can't leak into a later turn's check.
      live.skippedTurn = null
      logger.info(`[channels] ${live.keyId} skip_contested_by_send recovering reply`)
    }
    const postEmptyTurnFallback = async (cause: string): Promise<void> => {
      logger.warn(`[channels] ${live.keyId} empty_turn_fallback cause=${cause}`)
      live.emptyTurnFallbackTurn = live.turnSeq
      const result = await send(
        {
          adapter: live.key.adapter,
          workspace: live.key.workspace,
          chat: live.key.chat,
          thread: live.key.thread,
          text: EMPTY_TURN_FALLBACK_TEXT,
        },
        { source: 'system' },
      )
      if (!result.ok) {
        logger.warn(`[channels] ${live.keyId}: empty-turn fallback send failed: ${result.error}`)
      }
    }

    // A send landed this turn, but the model may have posted a `continue: true`
    // progress reply, kept working, then ENDED with its final answer as plain
    // prose — never calling a channel tool again. The terminal-reply abort fires
    // only for a `channel_reply` WITHOUT `continue: true`, so that `stopReason:
    // 'stop'` text leaf is left undelivered and unguarded (the false-receipt
    // guard is github-only). The discriminator is leaf IDENTITY: only when the
    // turn-end `stop` leaf is a DIFFERENT entry than the one in place at the last
    // send did the model produce fresh post-reply prose. A leaf unchanged since
    // the send is narration the model emitted with/before the reply that already
    // landed — suppress it, as before.
    if (live.successfulChannelSends > successfulSendsBeforePrompt) {
      maybeNudgeContinuationWillingness(live)

      // A `channel_send` ack that promised to keep working, fresh post-ack work,
      // then an EMPTY `stop` leaf: the model computed the answer in its reasoning
      // / tool results but never sent it (the Kimi/Fireworks empty-completion
      // flake). `maybeNudgeContinuationWillingness` above can't catch this — it
      // reads `lastTerminalReplyAbort`, which only a `channel_reply` sets;
      // `channel_send` keeps the turn alive and stamps nothing. And the
      // stranded-toolUse retry below requires `source !== 'leaf'`, but an empty
      // `stop` leaf recovers as `source: 'leaf'`, so this shape would otherwise
      // fall straight through to the `endsWithNoReplySignal('')` → `no_reply`
      // classification. Discriminator (all on existing state, zero false positives
      // measured across the session corpus): a send landed AND the just-sent text
      // trips the precision-tuned willingness detector AND the turn-end leaf is a
      // FRESH empty `stop` (different entry than the ack's leaf — so the model did
      // post-ack work, not an ack-then-await-user stop). Bounded by
      // MAX_WILLINGNESS_NUDGES (shared with the reply path); on exhaustion post the
      // fallback rather than going silent, mirroring the stranded-toolUse path.
      // Gated on an empty `promptQueue` (like maybeNudgeContinuationWillingness): a
      // real inbound that coalesced into the just-finished prompt will be answered
      // by the next drain pass, and drain() splices pending reminders into that
      // batch — so injecting a stale recovery nudge would prepend it to a live user
      // message. Skip the nudge AND the fallback in that case and let the trailing
      // recovery below run; the queued inbound supersedes this turn's silence.
      if (live.promptQueue.length === 0 && live.currentTurnAuthorId !== null && isEmptyStopAfterWillingnessAck(live)) {
        if (live.willingnessNudges < MAX_WILLINGNESS_NUDGES) {
          live.willingnessNudges++
          logger.warn(
            `[channels] ${live.keyId} send_willingness_nudge attempt=${live.willingnessNudges}/${MAX_WILLINGNESS_NUDGES} ` +
              `cause=empty_stop_after_send_ack`,
          )
          live.pendingSystemReminders.push(SEND_WILLINGNESS_NUDGE)
        } else {
          await postEmptyTurnFallback('empty_stop_after_send_ack_nudges_exhausted')
        }
        return
      }

      const trailing = recoverableAssistantText(live.session)
      if (trailing === null || trailing.source !== 'leaf') {
        // A `continue: true` status reply landed, then the turn stranded on an
        // unanswered `toolUse` (the post-tool follow-up never produced an
        // assistant message — aborted loop / cancelled stream). The promised
        // work never finished, so the user is left with a bare "checking now…"
        // and nothing after it. Re-prompt the same logical turn with the
        // continuation nudge so the model SUMMARIZES the tool results it already
        // gathered (still in this branch) and replies, instead of re-running the
        // investigation under EMPTY_TURN_RETRY_NUDGE's "answer directly" framing
        // and stranding again. On retry-exhaustion post the fallback rather than
        // returning silently — a retry turn that re-sends a status and re-strands
        // on the same no-prose shape must not deadair the user. Any postable
        // pre-tool/mid-turn prose is suppressed here as before (it was narration
        // that accompanied the already-landed reply); only the no-prose strand
        // gets a retry-or-fallback.
        if (leafIsStrandedToolUse(live.session) && live.currentTurnAuthorId !== null) {
          if (live.emptyTurnRetries < MAX_EMPTY_TURN_RETRIES) {
            live.emptyTurnRetries++
            const routerAbortReason =
              live.abortReasonThisTurn !== null && live.abortReasonThisTurn.turnSeq === live.turnSeq
                ? live.abortReasonThisTurn.reason
                : undefined
            const agentAbortReason =
              live.session.agent.signal?.aborted === true ? live.session.getAbortReason?.() : undefined
            const abortReason = routerAbortReason ?? agentAbortReason ?? 'unknown'
            logger.warn(
              `[channels] ${live.keyId} empty_turn_retry attempt=${live.emptyTurnRetries}/${MAX_EMPTY_TURN_RETRIES} ` +
                `cause=stranded_toolUse_after_send abort_reason=${abortReason}`,
            )
            live.pendingSystemReminders.push(STRANDED_TOOLUSE_CONTINUATION_NUDGE)
          } else {
            await postEmptyTurnFallback('stranded_toolUse_retries_exhausted')
          }
        }
        return
      }
      if (live.session.sessionManager.getLeafEntry()?.id === live.lastSendLeafId) return
    }

    let candidate = recoverableAssistantText(live.session)
    // A `length` leaf is recovered ONLY when stripping leaked `<think>…</think>`
    // spans actually removed something AND leaves a postable reply. The removal
    // is the positive signal that this was leaked-reasoning-plus-real-prose (the
    // production shape: interleaved think-text ending in a complete answer) — a
    // truncated `length` leaf with no think evidence is genuinely ambiguous and
    // stays on the raised-budget empty-turn retry below, exactly as before.
    if (candidate?.source === 'length-leaf') {
      const stripped = stripThinkBlocks(candidate.text)
      const removedThink = stripped !== candidate.text
      candidate =
        removedThink &&
        stripped !== '' &&
        !endsWithNoReplySignal(stripped) &&
        !isUpstreamEmptyResponseSentinel(stripped)
          ? { ...candidate, text: stripped }
          : null
    }
    if (candidate === null) {
      // No recoverable assistant prose: the turn ended with no usable reply.
      // Three distinct shapes, handled differently:
      //
      //   1a. SKIP-LOCKED thrash — the model called `skip_response` (committed to
      //       silence) then tried to send; every attempt was denied skip-locked
      //       (skipLockedSendTurn === turnSeq). Honor the silence decision: stay
      //       silent, no fallback. Handled first, below.
      //
      //   1b. The model THRASHED the send path WITHOUT a skip commitment — denials
      //       tracked on policyDeniedToolSendsThisTurn (duplicate/cap). In practice
      //       these only accumulate after a real send landed, so the early return
      //       above usually fires first; if one ever reaches here, re-prompting
      //       would just re-thrash, so skip retry and post the fallback once.
      //
      //   2. The PURE reasoning-loop — no send was ever attempted; the model
      //      burned its budget thinking and produced nothing (the canonical
      //      kimi `stopReason: 'length'` / `aborted` degeneration). Re-prompt up
      //      to MAX_EMPTY_TURN_RETRIES with a neutral nudge; on exhaustion, fall
      //      back. The nudge is injected as a reminder-only turn so drain()'s
      //      while-loop re-runs session.prompt() against the same branch.
      //
      // The legitimate empty-state case (a TUI-only check before any user
      // prompt, no inbound this turn) is excluded: no batch means no real turn
      // to retry or apologize for — keep the historical silent bail there.
      const leafStopReason = assistantLeafStopReason(live.session)

      // A `stopReason: 'error'` leaf is an upstream provider failure (401, billing,
      // malformed response, etc.), NOT a reasoning-loop or budget exhaustion. It is
      // already captured by subscribeProviderErrors into `pendingProviderError`
      // (fired synchronously on `message_end` before `prompt()` resolves), and
      // `maybePostDeferredProviderError` in drain()'s finally posts the REDACTED
      // `safeMessage`. Retrying with EMPTY_TURN_RETRY_NUDGE would waste the budget
      // nudging the model about output length when the real fault is the provider;
      // posting EMPTY_TURN_FALLBACK_TEXT would mask the actual failure behind a
      // misleading "I got stuck" notice. Return early so the provider-error path
      // owns this turn's surface.
      if (leafStopReason === 'error') {
        logger.warn(`[channels] ${live.keyId} provider_error_turn deferring to provider-error notice`)
        return
      }

      const skipLockedThisTurn = live.skipLockedSendTurn === live.turnSeq
      const attemptedSendThisTurn = skipLockedThisTurn || live.policyDeniedToolSendsThisTurn.size > 0

      // Skip-locked thrash honors the skip with SILENCE, not the fallback. The
      // model called `skip_response` (committed to silence) then tried to send;
      // the send was denied skip-locked and a retry loop aborts the run, leaving
      // an `aborted` leaf whose reply text was a denied tool ARG — never
      // recoverable prose. EMPTY_TURN_FALLBACK_TEXT would be a false alarm here:
      // it reads as a system failure when the real state is the model's own
      // silence decision contradicted by a late reply. The pure turn-cap/duplicate
      // thrash below (no `skip_response`) never committed to silence, so it still
      // gets the fallback. Distinct log line keeps production signal.
      if (skipLockedThisTurn) {
        logger.warn(
          `[channels] ${live.keyId} skip_locked_send_thrash_suppressed ` +
            `denied_targets=${live.policyDeniedToolSendsThisTurn.size}`,
        )
        return
      }

      // Only a TRUNCATED assistant leaf — `length` (budget exhaustion) or
      // `aborted` (terminal-reply abort) — from a real conversational turn is a
      // degeneration worth retrying. `error` was already diverted above to the
      // provider-error path. A cold/empty turn (no inbound author, or no
      // assistant message at all) keeps the historical silent bail —
      // re-prompting it would manufacture replies to nothing.
      if (live.currentTurnAuthorId === null || leafStopReason === undefined) {
        logger.info(`[channels] ${live.keyId}: no recoverable assistant text in branch`)
        return
      }
      if (!attemptedSendThisTurn && live.emptyTurnRetries < MAX_EMPTY_TURN_RETRIES) {
        live.emptyTurnRetries++
        // Raise the re-prompt's budget ONLY for a `length` truncation: that is
        // the budget-exhaustion case (reasoning ate the whole pool before any
        // prose), so the retry needs room to finish thinking AND reply. `aborted`
        // is the terminal-reply abort, not budget exhaustion, so it retries under
        // the default backstop. Consumed one-shot by installChannelOutputCap on
        // the next prompt().
        if (leafStopReason === 'length') {
          live.nextPromptMaxTokens = CHANNEL_EMPTY_TURN_RETRY_MAX_OUTPUT_TOKENS
        }
        logger.warn(
          `[channels] ${live.keyId} empty_turn_retry attempt=${live.emptyTurnRetries}/${MAX_EMPTY_TURN_RETRIES} ` +
            `max_tokens=${live.nextPromptMaxTokens ?? CHANNEL_MAX_OUTPUT_TOKENS}`,
        )
        live.pendingSystemReminders.push(EMPTY_TURN_RETRY_NUDGE)
        return
      }
      await postEmptyTurnFallback(attemptedSendThisTurn ? 'send_thrash' : 'retries_exhausted')
      return
    }

    const { text: candidateText, source } = candidate
    let assistantText = candidateText

    if (endsWithNoReplySignal(assistantText)) {
      // A BARE-EMPTY stop (no visible text, not an explicit NO_REPLY token) on
      // the armed cold-start solo-human fallback turn is the production "dropped
      // the owner's first question" shape — a model whiff on a direct one-on-one
      // question, not a deliberate decline. Give it the bounded empty-turn retry
      // with a dedicated nudge; on exhaustion post the visible fallback so the
      // human is never stranded on silence. Gated hard so deliberate silence
      // still stays silent: explicit NO_REPLY (non-empty trim), any turn that
      // already sent (successfulChannelSends moved), a queued fresh inbound (the
      // next drain answers it), and every turn outside the armed cold-start solo
      // path all fall through to the historical no_reply below.
      if (
        assistantText.trim() === '' &&
        source === 'leaf' &&
        live.coldStartSoloFallbackTurnActive &&
        live.currentTurnAuthorId !== null &&
        live.successfulChannelSends === successfulSendsBeforePrompt &&
        live.promptQueue.length === 0
      ) {
        if (live.emptyTurnRetries < MAX_EMPTY_TURN_RETRIES) {
          live.emptyTurnRetries++
          logger.warn(
            `[channels] ${live.keyId} empty_turn_retry attempt=${live.emptyTurnRetries}/${MAX_EMPTY_TURN_RETRIES} ` +
              `cause=cold_start_solo_bare_empty`,
          )
          live.pendingSystemReminders.push(COLD_START_REPLY_NUDGE)
          return
        }
        await postEmptyTurnFallback('cold_start_solo_bare_empty_retries_exhausted')
        return
      }
      const leakedReasoning = !isNoReplySignal(assistantText)
      logger.info(`[channels] ${live.keyId} no_reply${leakedReasoning ? ' (with_leaked_reasoning)' : ''}`)
      return
    }

    if (isUpstreamEmptyResponseSentinel(assistantText)) {
      logger.warn(
        `[channels] ${live.keyId}: suppressed upstream_empty_response_sentinel text_len=${assistantText.length}`,
      )
      return
    }

    if (isLikelyKimiChannelToolLeak(assistantText)) {
      logger.warn(`[channels] ${live.keyId}: suppressed kimi_tool_call_leak text_len=${assistantText.length}`)
      return
    }

    // Plain-text tool-call leak: the model serialized a channel tool call as
    // ordinary prose instead of producing a real tool call (a Kimi-on-Fireworks
    // failure mode — see `isLikelyPlainTextChannelToolCall`). We can't post the
    // raw `channel_reply({...})` serialization to the channel, but for
    // reply/send the model's *intent* is unambiguous: deliver the `text` arg.
    // Extract it and recover the actual message. `skip_response` is the
    // opposite — a genuine decline — so it stays suppressed.
    const plainTextToolCallKind = getPlainTextChannelToolCallKind(assistantText)
    if (plainTextToolCallKind === 'skip') {
      logger.warn(
        `[channels] ${live.keyId}: suppressed plain_text_channel_skip_response text_len=${assistantText.length}`,
      )
      return
    }
    if (plainTextToolCallKind !== null) {
      const extracted = extractPlainTextChannelToolCallText(assistantText)
      // Unextractable (no `text` arg, empty value, or fully-truncated): fall
      // back to the historical safe behavior — drop it rather than leak plumbing.
      if (extracted === null) {
        logger.warn(
          `[channels] ${live.keyId}: suppressed unextractable_plain_text_channel_tool_call text_len=${assistantText.length}`,
        )
        return
      }
      // The extracted value is still untrusted model output: if it is itself a
      // no-reply signal, an empty-response sentinel, or another (nested) leaked
      // tool call, suppress it through the same guards rather than re-leaking.
      if (
        endsWithNoReplySignal(extracted) ||
        isUpstreamEmptyResponseSentinel(extracted) ||
        isLikelyKimiChannelToolLeak(extracted) ||
        isLikelyPlainTextChannelToolCall(extracted)
      ) {
        logger.warn(
          `[channels] ${live.keyId}: suppressed plain_text_channel_tool_call (unsafe extracted text) text_len=${extracted.length}`,
        )
        return
      }
      logger.warn(
        `[channels] ${live.keyId}: recovered plain_text_channel_tool_call kind=${plainTextToolCallKind} text_len=${extracted.length}`,
      )
      assistantText = extracted
    }

    // `source` distinguishes the three recovery shapes for log triage:
    //   - 'leaf': the assistant message IS the leaf with stopReason 'stop'
    //     (existing behavior; model ended its turn with text but forgot to
    //     call channel_reply).
    //   - 'mid-turn': the assistant message IS the leaf with stopReason
    //     'toolUse'; the model narrated a reply, committed to a tool plan, and
    //     the turn ended before a follow-up that would have called a channel
    //     tool was persisted. The narration is the only user-facing text.
    //   - 'pre-tool': the leaf is a toolResult (or other non-assistant entry)
    //     and the assistant message lives upstream in the branch. This is the
    //     Kimi-on-Fireworks `kimi-k2p6-turbo` failure mode where the post-tool
    //     follow-up LLM call never produced a persisted assistant message, so
    //     the model's pre-tool commentary is the only user-facing text we have.
    //     Recovering it means the user gets *something* — strictly better than
    //     the historical silent drop.
    // Egress-level GitHub review guards. The false-receipt and re-review
    // stranding guards live inside the channel_reply / channel_send tool
    // handlers, but recovery surfaces trailing assistant prose through a
    // `source:'system'` send that never touches those handlers. A model that
    // ends its turn with a close-out ack ("that addresses the concern") instead
    // of calling a channel tool would otherwise post a verdict-shaped comment
    // while still holding its own CHANGES_REQUESTED — stranding the PR (PR #672).
    // Re-run the guards here and SUPPRESS on block: recovery cannot land the
    // missing formal review on the model's behalf, and posting the unguarded ack
    // is worse than dropping it — the next inbound re-prompts the model, which
    // can then land the verdict properly.
    const recoveryBlock = await evaluateRecoveryReviewGuards(live, assistantText)
    if (recoveryBlock !== null) {
      logger.warn(
        `[channels] ${live.keyId}: suppressed recovery (github review guard) reason=${JSON.stringify(recoveryBlock)} text_len=${assistantText.length}`,
      )
      return
    }

    // Duplicate guard on the FINAL outbound body. Must run here, after the
    // plain-text-tool-call extraction may have rewritten `assistantText` — a
    // dedupe on the raw leaf would miss a fresh `channel_reply({"text":"X"})`
    // leak leaf whose extracted body equals a reply already sent this turn. The
    // recovery send is `source:'system'`, which bypasses send()'s own dup guard,
    // so reject the byte-identical re-post here. No-op on the zero-send path:
    // `lastSentText` is cleared at batch start and only filled by this turn's
    // sends, so it never matches when nothing was sent.
    const sendKey = consecutiveSendKey(live.key.chat, live.key.thread)
    if (live.lastSentText.get(sendKey) === normalizeSendText(assistantText)) {
      logger.info(`[channels] ${live.keyId}: suppressed recovery (duplicate of reply already sent this turn)`)
      return
    }

    logger.warn(
      `[channels] ${live.keyId}: recovering assistant_text_without_channel_tool source=${source} text_len=${assistantText.length}`,
    )
    const result = await send(
      {
        adapter: live.key.adapter,
        workspace: live.key.workspace,
        chat: live.key.chat,
        thread: live.key.thread,
        text: assistantText,
      },
      { source: 'system' },
    )
    if (!result.ok) {
      logger.warn(`[channels] ${live.keyId}: recovery send failed: ${result.error}`)
    }
  }

  // Returns a block reason when the recovered text would be denied by a github
  // review guard, or null when it is safe to surface. Non-github channels and
  // non-PR chats short-circuit inside each guard (adapter / `pr:\d+` checks), so
  // this is a no-op for everything except GitHub PR sessions.
  const evaluateRecoveryReviewGuards = async (live: LiveSession, text: string): Promise<string | null> => {
    const falseReceipt = checkFalseReceipt({
      sessionId: live.sessionId,
      adapter: live.key.adapter,
      workspace: live.key.workspace,
      chat: live.key.chat,
      thread: live.key.thread,
      text,
      isContinue: false,
      resolveReviewThread: false,
    })
    if (falseReceipt.kind === 'block') return falseReceipt.reason

    const rereview = await evaluateRereviewGuard({
      adapter: live.key.adapter,
      workspace: live.key.workspace,
      chat: live.key.chat,
      thread: live.key.thread,
      text,
      wantsResolve: false,
      isContinue: false,
      getReviewState: (req) => getReviewState(req),
    })
    if (rereview.block) return rereview.reason

    return null
  }

  const getConsecutiveSendCount = (target: {
    adapter: ChannelKey['adapter']
    workspace: string
    chat: string
    thread?: string | null
  }): number => {
    const keyId = channelKeyId({
      adapter: target.adapter,
      workspace: target.workspace,
      chat: target.chat,
      thread: target.thread ?? null,
    })
    const live = liveSessions.get(keyId)
    if (!live) return 0
    return live.consecutiveSends.get(consecutiveSendKey(target.chat, target.thread)) ?? 0
  }

  const getSendRate = (target: {
    adapter: ChannelKey['adapter']
    workspace: string
    chat: string
    thread?: string | null
  }): { count: number; windowMs: number } => {
    const keyId = channelKeyId({
      adapter: target.adapter,
      workspace: target.workspace,
      chat: target.chat,
      thread: target.thread ?? null,
    })
    const live = liveSessions.get(keyId)
    if (!live) return { count: 0, windowMs: SEND_RATE_WINDOW_MS }
    const sendKey = consecutiveSendKey(target.chat, target.thread)
    const buf = live.sendTimestamps.get(sendKey)
    if (!buf || buf.length === 0) return { count: 0, windowMs: SEND_RATE_WINDOW_MS }
    const cutoff = now() - SEND_RATE_WINDOW_MS
    let i = 0
    while (i < buf.length && buf[i]! <= cutoff) i++
    if (i > 0) buf.splice(0, i)
    return { count: buf.length, windowMs: SEND_RATE_WINDOW_MS }
  }

  const tearDownLive = async (live: LiveSession): Promise<void> => {
    live.destroyed = true
    if (live.debounceTimer) clearTimeout(live.debounceTimer)
    live.debounceTimer = null
    live.unsubProviderErrors?.()
    live.unsubProviderErrors = null
    live.unsubTypingActivity?.()
    live.unsubTypingActivity = null
    live.unsubTodoOutcome?.()
    live.unsubTodoOutcome = null
    await stopTypingHeartbeat(live)
    try {
      await live.session.abort()
    } catch (err) {
      logger.warn(`[channels] abort failed for ${live.keyId}: ${describe(err)}`)
    }
    await fireSessionEnd(live)
    try {
      await live.dispose()
    } catch (err) {
      logger.warn(`[channels] dispose failed for ${live.keyId}: ${describe(err)}`)
    }
  }

  // Roll back an install when a post-install step (persist/prefetch) fails, so a
  // rejected ensureLive never leaves a warm session behind for later inbounds.
  const unwindInstalledLive = async (keyId: string, live: LiveSession): Promise<void> => {
    if (liveSessions.get(keyId) === live) liveSessions.delete(keyId)
    if (!live.destroyed) await tearDownLive(live)
  }

  const runIdleGc = async (): Promise<void> => {
    const t = now()
    const victims: LiveSession[] = []
    for (const live of liveSessions.values()) {
      if (live.destroyed) continue
      if (live.draining) continue
      if (live.promptQueue.length > 0) continue
      // pendingSystemReminders is checked alongside promptQueue because both
      // represent pending work that drain() will process. Today's only
      // populator (injectSubagentCompletionReminder) also fires drain()
      // synchronously, which sets draining=true and shadows this guard via
      // the line above — but the guard exists to keep the invariant honest
      // for any future caller that queues a reminder without immediately
      // waking the drain loop.
      if (live.pendingSystemReminders.length > 0) continue
      if (t - live.lastInboundAt <= SESSION_IDLE_MS) continue
      if (isPinnedByRunningChild(live.sessionId, live.keyId, 'idle_gc evicting')) continue
      victims.push(live)
    }
    for (const live of victims) {
      liveSessions.delete(live.keyId)
      logger.info(`[channels] ${live.keyId} idle_gc evicting after ${t - live.lastInboundAt}ms idle`)
      await tearDownLive(live)
    }
  }

  let gcTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    void runIdleGc()
  }, SESSION_GC_INTERVAL_MS)
  // Don't keep the Bun process alive just for the GC tick; the host
  // server's WebSocket listener owns process lifetime.
  gcTimer.unref?.()

  const stop = async (): Promise<void> => {
    closing = true
    if (gcTimer) clearInterval(gcTimer)
    gcTimer = null
    liveGeneration++
    const all = Array.from(liveSessions.values())
    liveSessions.clear()
    for (const live of all) {
      await tearDownLive(live)
    }
    await persistChain
  }

  // Drops every in-memory session but KEEPS the on-disk records, so the next
  // inbound per channel rehydrates the same transcript through a fresh
  // createSession() — which re-renders the frozen system-prompt role block.
  // This is how a `roles.<name>.match` reload reaches live channel sessions.
  // Unlike stop() it leaves the GC timer running; unlike stale-rollover it
  // keeps the sessionId, so history survives.
  //
  // Bumping liveGeneration BEFORE the snapshot is what makes this race-free:
  // a session mid-creation (in `creating` but not yet in `liveSessions`) won't
  // appear in the snapshot below, but it captured the old generation and will
  // self-dispose at its install guard instead of resurrecting stale role state.
  const tearDownAllLive = async (): Promise<void> => {
    liveGeneration++
    const all = Array.from(liveSessions.values())
    liveSessions.clear()
    // Seal only around the flush — unlike stop() the router keeps serving after a
    // roles reload, so re-enable persist() once pending writes have drained.
    closing = true
    for (const live of all) {
      await tearDownLive(live)
    }
    await persistChain
    closing = false
  }

  // Boot-time resume for a restart that originated from a channel session, in
  // two phases to close the race with adapters that begin receiving inbounds.
  //
  // PHASE 1 — reserveRestartHandoff(handoff): called BEFORE the adapters start.
  // It seeds a per-key entry in `creating` so any inbound that arrives during
  // boot coalesces onto the (not-yet-run) resume instead of stale-rolling the
  // mapping or creating a competing session. It does NOT touch resolvers or
  // outbound callbacks (not registered yet) — it only installs the gate.
  //
  // PHASE 2 — reservation.resume(): called AFTER channelManager.start(), when
  // adapters (and thus resolvers + the outbound callback the wake reply needs)
  // are ready. It removes its own `creating` seed, reopens the exact session
  // via ensureLive(resumeTarget) (bypassing stale-rollover, persisting only on
  // success), and — only if no real inbound coalesced in the meantime — arms
  // the restart-kick suppressor and enqueues the synthetic wake. If an inbound
  // did arrive, that inbound is the wake, so the synthetic one is skipped to
  // avoid a duplicate/spurious "I'm back" turn.
  //
  // The `typeclaw.restart-self` entry is already in the reopened JSONL (the
  // dying container appended it on the restart broadcast), so reopening the
  // file is what produces the greeting; adapter readiness only matters for
  // delivering the eventual reply.
  const reserveRestartHandoff = (handoff: RestartHandoff): RestartReservation | null => {
    if (handoff.origin.kind !== 'channel') return null
    const key: ChannelKey = {
      adapter: handoff.origin.key.adapter,
      workspace: handoff.origin.key.workspace,
      chat: handoff.origin.key.chat,
      thread: handoff.origin.key.thread,
    }
    const keyId = channelKeyId(key)

    if (resolveAdapterConfig(key.adapter, key.workspace) === undefined) {
      logger.warn(`[channels] ${keyId}: restart-resume skipped — adapter not configured`)
      return null
    }

    let resolveGate!: (live: LiveSession) => void
    let rejectGate!: (err: unknown) => void
    const gate = new Promise<LiveSession>((res, rej) => {
      resolveGate = res
      rejectGate = rej
    })
    // Seed `creating` so a racing inbound's ensureLive awaits this gate rather
    // than starting its own create. Suppress an unhandled-rejection warning on
    // the skip/failure paths that never get an inbound waiter.
    creating.set(keyId, gate)
    gate.catch(() => undefined)

    const reservation: RestartReservation = {
      keyId,
      sawInbound: false,
      resume: async () => {
        // Drop our own seed BEFORE calling ensureLive, or ensureLive would
        // await the gate we are about to resolve and deadlock.
        if (creating.get(keyId) === gate) creating.delete(keyId)
        restartReservations.delete(keyId)

        await ensureLoaded()
        const record = mappings ? findRecord(mappings, key) : undefined
        if (record?.sessionId !== handoff.originatingSessionId) {
          logger.warn(
            `[channels] ${keyId}: restart-resume skipped — persisted session ` +
              `${record?.sessionId ?? '<none>'} no longer matches handoff ${handoff.originatingSessionId}`,
          )
          rejectGate(new StaleLiveSessionError(keyId))
          return
        }

        let live: LiveSession
        try {
          live = await ensureLive(key, undefined, handoff.triggeringAuthorId, {
            sessionId: handoff.originatingSessionId,
            sessionFile: handoff.originatingSessionFile,
          })
        } catch (err) {
          logger.warn(`[channels] ${keyId}: restart-resume ensureLive failed: ${describe(err)}`)
          rejectGate(err)
          return
        }
        resolveGate(live)

        if (live.sessionId !== handoff.originatingSessionId) {
          logger.warn(
            `[channels] ${keyId}: restart-resume reopened a different session ` +
              `(${live.sessionId} != ${handoff.originatingSessionId}); skipping wake`,
          )
          return
        }

        // A real inbound coalesced onto the reservation during boot: it is the
        // wake. Adding the synthetic "I'm back" turn on top would duplicate
        // work / stack a spurious turn, so skip it and let the inbound drain.
        if (reservation.sawInbound) {
          logger.info(`[channels] ${keyId}: restart-resume coalesced with a real inbound; skipping synthetic wake`)
          return
        }

        await armRestartKickForOrigin(options.agentDir, buildLiveOrigin(live)).catch((err) =>
          logger.error(`[channels] ${keyId}: restart-resume arm restart-kick failed: ${describe(err)}`),
        )

        live.pendingSystemReminders.push(RESTART_RESUME_WAKE_REMINDER)
        logger.info(`[channels] ${keyId}: restart-resume waking session ${live.sessionId}`)
        void drain(live)
      },
    }
    restartReservations.set(keyId, reservation)
    return reservation
  }

  // Reserve + resume in one call, for callers (and tests) that run after the
  // adapters are already started and so don't need the pre-start gate. Still
  // benefits from the reservation's sawInbound suppression for inbounds that
  // race between reserve and resume.
  const resumeRestartHandoff = async (handoff: RestartHandoff): Promise<void> => {
    const reservation = reserveRestartHandoff(handoff)
    if (reservation === null) return
    await reservation.resume()
  }

  const executeCommand = async (
    key: ChannelKey,
    name: string,
    options: ExecuteCommandOptions,
  ): Promise<ExecuteCommandResult> => {
    const lowered = name.toLowerCase()
    const commandInfo = commands.get(lowered)
    if (commandInfo === undefined) {
      return { kind: 'unknown-command', name: lowered }
    }
    // Gates on the command's declared tier (session.control for /stop,
    // session.admin for /reload and /restart) — never channel.respond — so a
    // respond-capable guest cannot abort another speaker's turn or bounce the
    // container. Runs BEFORE the live-session lookup so an unauthorized invoker
    // gets 'permission-denied' regardless of session state, rather than leaking
    // session presence via the 'no-live-session' vs 'permission-denied'
    // distinction. Session-less informational commands (e.g. /help) declare
    // permission:'none' and skip both the gate and the lookup so they work in
    // channels with no live turn.
    const requiredPermission = commandPermissionString(commandInfo.permission)
    if (requiredPermission !== null) {
      const partial: SessionOrigin = {
        kind: 'channel',
        adapter: key.adapter,
        workspace: key.workspace,
        chat: key.chat,
        thread: key.thread,
        lastInboundAuthorId: options.invokerId,
      }
      if (!permissions.has(partial, requiredPermission)) {
        return { kind: 'permission-denied' }
      }
    }
    let live: LiveSession | null = null
    if (commandInfo.requiresLiveSession) {
      const resolved = resolveLiveSessionForCommand(liveSessions, key)
      if (resolved.kind === 'none') {
        return { kind: 'no-live-session' }
      }
      if (resolved.kind === 'ambiguous') {
        return { kind: 'ambiguous', matchCount: resolved.count }
      }
      live = resolved.session
    } else if (commandInfo.wantsLiveSession) {
      // Best-effort: resolve a session if exactly one matches, but never fail
      // the command when absent or ambiguous — /restart still bounces.
      const resolved = resolveLiveSessionForCommand(liveSessions, key)
      live = resolved.kind === 'found' ? resolved.session : null
    }
    const result = await commands.execute(`/${lowered}`, { live, event: null, invokerId: options.invokerId })
    if (result.kind === 'handled') {
      return result.reply !== undefined
        ? { kind: 'handled', name: result.name, reply: result.reply }
        : { kind: 'handled', name: result.name }
    }
    // commands.execute can only return not-command (impossible — we pass a
    // leading slash), unknown-command (impossible — we just checked get()),
    // or handled. Any other outcome is a bug.
    return { kind: 'unknown-command', name: lowered }
  }

  const deliverCompletionReminder = (
    live: LiveSession,
    args: {
      parentSessionId: string
      subagent: string
      taskId: string
      ok: boolean
      durationMs: number
      error?: string
      hasRecoverableOutput?: boolean
    },
  ): { kind: 'delivered'; keyId: string } => {
    const adapter = live.keyId.split(':', 1)[0] ?? ''
    const text = renderSubagentCompletionReminder({
      subagent: args.subagent,
      taskId: args.taskId,
      ok: args.ok,
      durationMs: args.durationMs,
      ...(args.error !== undefined ? { error: args.error } : {}),
      ...(args.hasRecoverableOutput === true ? { hasRecoverableOutput: true } : {}),
      channel: true,
      adapter,
    })
    live.pendingSystemReminders.push(text)
    // The reminder tells the agent to fetch this result now; clear the
    // subagent_output window so an earlier premature-polling streak can't
    // hard-block that legitimate fetch.
    forgetSharedLoopGuardTool(live.sessionId, SUBAGENT_OUTPUT_TOOL_NAME)
    logger.info(`[channels] ${live.keyId}: subagent-completion reminder queued task=${args.taskId} ok=${args.ok}`)
    // Wake the drain loop. If a turn is already in flight, the wakeup is
    // a no-op because drain() will pick up the reminder on its next
    // iteration (it now gates on promptQueue OR pendingSystemReminders).
    // If the session is idle, fire drain() immediately rather than going
    // through the debounce path — the reminder is not a user inbound,
    // so the "coalesce nearby inbounds" rationale for debouncing does
    // not apply. Mirrors the TUI path's `idle ? 'interrupt' : 'queue'`
    // semantics: the channel router doesn't have a `delivery: interrupt`
    // mechanism (no in-flight abort during a turn), but firing drain()
    // immediately is the equivalent for an idle session.
    if (!live.draining) {
      void drain(live)
    }
    return { kind: 'delivered', keyId: live.keyId }
  }

  const injectSubagentCompletionReminder = (args: {
    parentSessionId: string
    subagent: string
    taskId: string
    ok: boolean
    durationMs: number
    error?: string
    hasRecoverableOutput?: boolean
    channelKey?: { adapter: string; workspace: string; chat: string; thread: string | null }
  }): { kind: 'delivered'; keyId: string } | { kind: 'no-live-session' } => {
    for (const live of liveSessions.values()) {
      if (live.destroyed) continue
      if (live.sessionId !== args.parentSessionId) continue
      return deliverCompletionReminder(live, args)
    }
    // The exact parent session is gone. If the subagent was spawned from a
    // channel session, the conversation may have rolled over
    // (SESSION_FRESHNESS_TTL_MS) or been idle-evicted onto a fresh sessionId
    // for the same channel key while the subagent ran. Fall back to the live
    // successor for that key so a finished review/result still surfaces
    // instead of being silently dropped.
    if (args.channelKey !== undefined) {
      const targetKeyId = channelKeyId(args.channelKey)
      const successor = liveSessions.get(targetKeyId)
      if (successor !== undefined && !successor.destroyed) {
        logger.info(
          `[channels] ${targetKeyId}: subagent-completion reminder rerouted to live successor (parent ${args.parentSessionId} gone) task=${args.taskId}`,
        )
        return deliverCompletionReminder(successor, args)
      }
    }
    return { kind: 'no-live-session' }
  }

  const injectPrVerdictActivity = (args: {
    workspace: string
    prNumber: number
    verdict: 'APPROVE' | 'REQUEST_CHANGES'
    sessionId: string
  }): { kind: 'delivered'; count: number } => {
    const chat = `pr:${args.prNumber}`
    let count = 0
    for (const live of liveSessions.values()) {
      if (live.destroyed) continue
      if (live.key.adapter !== 'github') continue
      if (live.key.workspace !== args.workspace || live.key.chat !== chat) continue
      // Self-exclude: the session that just landed the verdict must not be told to
      // stand down from its own legitimate review.
      if (live.sessionId === args.sessionId) continue
      const text = renderPrVerdictStandDownReminder({ prNumber: args.prNumber, verdict: args.verdict })
      live.pendingSystemReminders.push(text)
      logger.info(`[channels] ${live.keyId}: pr-verdict stand-down queued pr=${chat} verdict=${args.verdict}`)
      if (!live.draining) void drain(live)
      count++
    }
    return { kind: 'delivered', count }
  }

  const markTurnSkipped = (args: {
    parentSessionId: string
    reason: string
  }):
    | { kind: 'recorded'; keyId: string }
    | { kind: 'recorded-after-send'; keyId: string }
    | { kind: 'no-live-session' } => {
    for (const live of liveSessions.values()) {
      if (live.destroyed) continue
      if (live.sessionId !== args.parentSessionId) continue
      if (live.successfulChannelSends > live.successfulSendsAtTurnStart) {
        // Reply-first skip ("acked, now going quiet"): accept as a terminal
        // no-op, never stamp `skippedTurn`. The delivered reply stands and must
        // not be suppressed, so stamping (which `validateChannelTurn` reads to
        // drop the turn) would be wrong; the send-after-skip lock only needs to
        // arm on the silence-first path. Rejecting this instead deadlocks the
        // agentic loop: denied a clean silent exit the model re-sends, gets
        // re-denied, and repeats until the per-turn send cap trips. Logged here
        // since `validateChannelTurn` won't see a `skippedTurn` for it.
        logger.info(`[channels] ${live.keyId} skip_after_send reason=${JSON.stringify(args.reason)}`)
        return { kind: 'recorded-after-send', keyId: live.keyId }
      }
      live.skippedTurn = { turnSeq: live.turnSeq, reason: args.reason }
      return { kind: 'recorded', keyId: live.keyId }
    }
    return { kind: 'no-live-session' }
  }

  const clearSticky = (key: ChannelKey): { keyId: string; cleared: number } => {
    const keyId = channelKeyId(key)
    const cleared = stickyLedger.clear(keyId)
    // Arm the same-turn re-grant guard so a subsequent ack reply this turn does
    // not re-grant the credit just cleared (see `disengagedTurn`). No-op when
    // the key has no live session — the ledger clear above still stands.
    const live = liveSessions.get(keyId)
    if (live && !live.destroyed) {
      live.disengagedTurn = live.turnSeq
      reactOnDisengage(live)
    }
    logger.info(`[channels] ${keyId} sticky cleared count=${cleared}`)
    return { keyId, cleared }
  }

  const reactOnDisengage = (live: LiveSession): void => {
    if (live.currentTurnReactionRef === null) return
    void react({
      adapter: live.key.adapter,
      workspace: live.key.workspace,
      chat: live.key.chat,
      thread: live.key.thread,
      reactionRef: live.currentTurnReactionRef,
      emoji: disengageReactionEmojiFor(live.key.adapter),
    })
      .then((result) => {
        if (!result.ok && result.code !== 'unsupported') {
          logger.info(
            `[channels] disengage-react failed adapter=${live.key.adapter} chat=${live.key.chat}: ${result.error}`,
          )
        }
      })
      .catch((err) => {
        logger.info(
          `[channels] disengage-react threw adapter=${live.key.adapter} chat=${live.key.chat}: ${describe(err)}`,
        )
      })
  }

  return {
    route,
    send,
    getConsecutiveSendCount,
    getSendRate,
    registerOutbound,
    unregisterOutbound,
    registerConfig,
    unregisterConfig,
    registerReaction,
    unregisterReaction,
    react,
    registerRemoveReaction,
    unregisterRemoveReaction,
    removeReaction,
    registerTyping,
    unregisterTyping,
    setTypingCapability,
    registerChannelNameResolver,
    unregisterChannelNameResolver,
    registerSelfIdentity,
    unregisterSelfIdentity,
    registerMembership,
    unregisterMembership,
    registerHistory,
    unregisterHistory,
    fetchHistory,
    registerFetchAttachment,
    unregisterFetchAttachment,
    fetchAttachment,
    registerReviewThreadResolver,
    unregisterReviewThreadResolver,
    resolveReviewThread,
    registerReviewStateResolver,
    unregisterReviewStateResolver,
    getReviewState,
    lookupInboundAttachment,
    listInboundAttachmentIds,
    registerHistoryAttachments,
    executeCommand,
    getSelfAliases: computeSelfAliases,
    injectSubagentCompletionReminder,
    injectPrVerdictActivity,
    markTurnSkipped,
    clearSticky,
    reserveRestartHandoff,
    resumeRestartHandoff,
    stop,
    tearDownAllLive,
    liveCount: () => liveSessions.size,
    __testing: {
      flushDebounce: async (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        if (!live) return
        if (live.debounceTimer) {
          clearTimeout(live.debounceTimer)
          live.debounceTimer = null
        }
        live.firstUnprocessedAt = 0
        await drain(live)
        // Settle the fire-and-forget `void persist()` from scheduleDebouncedDrain
        // (the lastInboundAt write). Draining alone doesn't await that promise, so
        // a test reading sessions.json right after would race the disk write — the
        // flake that forced wall-clock polling on slow (Windows CI) filesystems.
        await persistChain
      },
      fireTypingHeartbeat: async (key: ChannelKey, phase: 'tick' | 'stop' = 'tick') => {
        const live = liveSessions.get(channelKeyId(key))
        if (!live) return
        await fireTyping(live, phase)
      },
      fireTypingInterval: async (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        if (!live || !live.typingTimer) return
        if (live.destroyed) {
          await stopTypingHeartbeat(live)
          return
        }
        if (now() - live.typingStartedAt >= MAX_TYPING_HEARTBEAT_MS) {
          logger.warn(
            `[channels] ${live.keyId}: typing indicator paused after ${MAX_TYPING_HEARTBEAT_MS}ms with no activity; prompt still in flight`,
          )
          live.typingTimedOut = true
          await stopTypingHeartbeat(live)
          return
        }
        await fireTyping(live, 'tick')
      },
      resolveSelfIdentity,
      isTypingActive: (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        return live?.typingTimer !== null && live?.typingTimer !== undefined
      },
      stopTyping: async (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        if (!live) return
        await stopTypingHeartbeat(live)
      },
      runIdleGc,
      getLiveOriginSnapshot: (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        const origin = live?.originRef.current
        if (origin === undefined) return undefined
        return { ...origin }
      },
      getLiveAuthorState: (key: ChannelKey) => {
        const live = liveSessions.get(channelKeyId(key))
        if (live === undefined) return undefined
        return {
          currentTurnAuthorId: live.currentTurnAuthorId,
          currentTurnAuthorIds: Array.from(live.currentTurnAuthorIds),
          lastTurnAuthorId: live.lastTurnAuthorId,
          lastTurnAuthorIds: Array.from(live.lastTurnAuthorIds),
        }
      },
    },
  }
}

function collectTurnAttachments(
  observed: readonly ObservedInbound[],
  batch: readonly QueuedInbound[],
): readonly InboundAttachment[] {
  const out: InboundAttachment[] = []
  for (const item of observed) out.push(...(item.attachments ?? []))
  for (const item of batch) out.push(...(item.attachments ?? []))
  return out
}

function findAttachmentById(attachments: readonly InboundAttachment[], id: number): InboundAttachment | null {
  for (let i = attachments.length - 1; i >= 0; i--) {
    const attachment = attachments[i]
    if (attachment?.id === id) return attachment
  }
  return null
}

function composeTurnPrompt(
  observed: readonly ObservedInbound[],
  batch: readonly QueuedInbound[],
  state: {
    adapter?: AdapterId
    loopGuardActive: boolean
    groupChatNudge?: boolean
    systemReminders?: readonly string[]
    now?: Date
    role?: string
  } = {
    loopGuardActive: false,
  },
): string {
  const adapter = state.adapter ?? 'discord-bot'
  const parts: string[] = []
  parts.push(renderTurnTimeAnchor(state.now), '')
  const roleAnchor = state.role !== undefined ? renderTurnRoleAnchor(state.role) : undefined
  if (roleAnchor !== undefined) parts.push(roleAnchor, '')
  // System reminders (subagent-completion wakeups today) lead the turn body
  // because they are typically what triggered the drain — when the prompt
  // queue is empty and the only thing in this iteration is a reminder, the
  // model needs to see the reminder before any optional context. The
  // reminder block is self-fenced by its <system-reminder> tags, so no
  // extra framing is needed and the model already learns this shape from
  // the TUI path; channel sessions see the same tags.
  if (state.systemReminders && state.systemReminders.length > 0) {
    for (const reminder of state.systemReminders) {
      parts.push(reminder)
    }
    parts.push('')
  }
  // Loop-guard notice lives in the user-turn text (recomposed every drain)
  // rather than in the system prompt so it does not invalidate the
  // prompt-prefix cache. The cached prefix covers system + tools + earlier
  // turns; the current user-turn suffix is non-cacheable by design, so
  // adding a section here is cache-neutral.
  //
  // SYSTEM MESSAGE convention: any runtime-injected block in the user
  // turn that is NOT from a chat participant MUST use the
  // `**[SYSTEM MESSAGE — not from a human]**` framing fenced by
  // horizontal rules (`---`) — the loop-guard block below is the
  // canonical example. This is structurally distinct from the H2
  // sections used for actual conversation content (`## Recent context`,
  // `## Current message`). Without the fencing, models — especially
  // persona-rich ones like Kimi — read the heading as a human-authored
  // instruction and reply to it (e.g. "Understood, I'll stop here"). The
  // bracketed marker plus the explicit "Do not acknowledge or reply to
  // this notice" line is the trust boundary that prevents this. New
  // runtime notices (rate-limit, schema-mismatch, abort signals, etc.)
  // MUST follow this convention.
  //
  // ONE narrow exception exists: subagent-completion reminders use
  // `<system-reminder>...</system-reminder>` tags (prepended above) for
  // parity with the TUI path's identical tagging (see
  // `renderSubagentCompletionReminder` in
  // `src/agent/subagent-completion-reminder.ts`) so the model sees the
  // same shape across origins. The exception is scoped to that single
  // case: do NOT extend it to new notice types. Anything that is not
  // a true subagent-style completion ping uses framing 1.
  if (state.loopGuardActive) {
    parts.push(
      '---',
      '**[SYSTEM MESSAGE — not from a human]**',
      '',
      `The TypeClaw runtime detected that peer bots have engaged you ${MAX_CONSECUTIVE_PEER_BOT_TURNS_SINCE_HUMAN}+ times in`,
      `a row without any human input (or ${MAX_PEER_BOT_TURNS_IN_WINDOW}+ times in the last ${PEER_BOT_TURNS_WINDOW_MS / 1000}s). This message`,
      'is an automated signal from the channel router, not a message from anyone',
      'in the chat. **Do not acknowledge or reply to this notice.**',
      '',
      'Guidance:',
      '- If the current message clearly needs a reply, send one and ignore this notice.',
      '- If continuing would add noise, reply with `NO_REPLY` to stay silent this turn.',
      '',
      'This notice clears automatically once a human posts again.',
      '',
      '---',
      '',
    )
  }
  // Group-chat nudge: same SYSTEM MESSAGE convention as the loop guard. We
  // engaged this turn — possibly via sticky credit, which now wakes us on
  // every follow-up in a group too (the engagement gate is content-blind by
  // design). In a multi-human room the default "answer everything" posture is
  // wrong, so this nudge is the ONLY thing that makes the bot selective: it
  // tells the model to answer genuine follow-ups and stay silent on chatter.
  // The gate gets us into the turn; the model decides whether to speak.
  // Cache-neutral (user-turn suffix), and skipped when the loop guard already
  // fired to avoid stacking two silence notices in one turn.
  if (state.groupChatNudge === true && !state.loopGuardActive) {
    parts.push(
      '---',
      '**[SYSTEM MESSAGE — not from a human]**',
      '',
      'You are in a group chat with multiple people. This is an automated',
      'signal from the channel router, not a message from anyone in the chat.',
      '**Do not acknowledge or reply to this notice.**',
      '',
      'You are woken on every message from someone you recently talked with, so',
      'most turns you should stay quiet. In a group the target shifts every',
      'message: before replying, identify who THIS latest message is aimed at.',
      'Reply ONLY when:',
      '- the current message is addressed to you (by name, @-mention, or reply), or',
      '- it directly continues your own last exchange and clearly wants an answer',
      '  (e.g. a follow-up question about what you just said).',
      '',
      'If it is aimed at someone else — another person by name or @-mention, a',
      'reply to their message, or another bot — it is not your turn, even if you',
      'were just talking with its author. Otherwise too — chatter, side-',
      'conversation, banter, or anything not actually waiting on you — reply with',
      '`NO_REPLY` (or call `skip_response`) to stay silent and keep watching.',
      'When unsure, prefer silence.',
      '',
      '---',
      '',
    )
  }
  if (observed.length > 0) {
    parts.push('## Recent context (not addressed to you, for awareness only)')
    for (const o of observed) {
      parts.push(formatInboundPromptLines(o, adapter, OBSERVED_MESSAGE_MAX_CHARS))
    }
    parts.push('')
  }
  // Emit the `## Current message(s)` header whenever the batch is non-empty.
  // It is batch-gated (a reminder-only wakeup with an empty promptQueue must
  // not print a header with zero lines under it — persona-rich models read
  // the dangling header as a message they're failing to see and hallucinate a
  // reply). It must NOT also be gated on observed context: a turn carrying
  // only the current message then rendered the batch line bare, or flush under
  // the `## Recent context (not addressed to you …)` header — mislabeling the
  // one line the model is supposed to answer as context it should ignore.
  if (batch.length > 0) {
    // The `## Current message` header is a WITHIN-turn label, but it also gets
    // persisted into the transcript — so after many turns the model sees a
    // chain of turns each headed "addressed to you" and a weak model collapses
    // that into "only the latest turn exists", denying it can see what the user
    // said earlier (those turns are in its own message history). This note
    // re-anchors the header as turn-local. Conditional "if earlier turns
    // appear" wording so it is not a false premise on turn 1 (a fresh session
    // has no history). No leading `>` — that is this repo's quote-anchor syntax
    // and would read as quoted content. Worded to NOT contain the literal
    // `## Current message` heading — a pinned test asserts its absence on
    // reminder-only drains, so it must stay batch-gated and substring-free.
    parts.push(
      'Note: if earlier turns appear above, they are real conversation history you can use.',
      "The heading below marks this turn's new message, not the only message that may exist.",
      '',
    )
    parts.push(batch.length === 1 ? '## Current message (addressed to you)' : '## Current messages (addressed to you)')
    for (const b of batch) {
      parts.push(formatInboundPromptLines(b, adapter))
    }
  }
  return parts.join('\n')
}

// The per-turn memory hook must query on ONLY what the human typed this turn,
// not the composeTurnPrompt envelope (time anchor, system reminders, and the
// "## Recent context" block). That envelope dwarfs the actual message, so
// embedding it lets recent-context drift dominate both retrieval lanes and the
// injected memory tracks the scrollback topic instead of the current question.
// Strip all framing — headings, author attribution, quote anchors — down to raw
// text, one batch entry per line. A reminder-only drain yields '', which
// hybridSearch no-ops: correct, since there is no new user message to match.
function composeRetrievalQuery(batch: readonly QueuedInbound[]): string {
  return batch
    .map((b) => b.text.trim())
    .filter((t) => t.length > 0)
    .join('\n')
}

function formatAuthorLine(
  ts: number,
  adapter: AdapterId,
  authorId: string,
  authorName: string,
  authorIsBot: boolean,
  text: string,
  maxChars?: number,
): string {
  const tag = authorIsBot ? ' [bot]' : ''
  const stamp = ts > 0 ? `[${new Date(ts).toISOString()}] ` : ''
  return `${stamp}${formatAuthorReference(adapter, authorId, authorName)} (${authorName})${tag}: ${capObservedText(text, maxChars)}`
}

// Cap by whole code points so truncation never splits a surrogate pair (emoji,
// astral-plane chars) into a dangling half. `text.length` (UTF-16 code units) is
// a cheap upper bound on the code-point count, so a string already within the
// cap skips the array build.
function capObservedText(text: string, maxChars: number | undefined): string {
  if (maxChars === undefined || text.length <= maxChars) return text
  const points = Array.from(text)
  if (points.length <= maxChars) return text
  return `${points.slice(0, maxChars).join('')} […truncated]`
}

function formatInboundPromptLines(
  inbound: {
    ts: number
    authorId: string
    authorName: string
    authorIsBot: boolean
    text: string
    referenceContext?: InboundReferenceContext
  },
  adapter: AdapterId,
  maxTextChars?: number,
): string {
  const lines = inbound.referenceContext?.sources.map(renderQuoteAnchor) ?? []
  lines.push(
    formatAuthorLine(
      inbound.ts,
      adapter,
      inbound.authorId,
      inbound.authorName,
      inbound.authorIsBot,
      inbound.text,
      maxTextChars,
    ),
  )
  return lines.join('\n')
}

export type { QuoteAnchorSource } from './types'

// Picks the right author syntax for the platform so prompts and rendered
// quote anchors use the same form the user would type in that channel.
// Slack/Discord need id mentions (`<@U…>`), GitHub needs handle mentions
// (`@login`) because inbound author ids are numeric, and adapters without
// stable id-only mention syntax fall back to plain display names.
//
// Notification semantics: Slack and Discord both render `<@…>` as a
// styled mention link inside blockquotes; whether the mentioned user is
// PINGED is a separate platform-level UX (Slack pings on first appearance
// in the message regardless of position, Discord respects the
// `allowed_mentions` field which defaults to "ping everyone parsed").
// This matches PR #374's intent — the user IS being notified that the
// agent replied to them, which is the whole point of a quote anchor.
function formatAuthorReference(adapter: AdapterId, authorId: string, authorName: string): string {
  const displayName = authorName.trim() !== '' ? authorName.trim() : authorId
  switch (adapter) {
    case 'slack':
    case 'slack-bot':
    case 'discord':
    case 'discord-bot':
      return `<@${authorId}>`
    case 'github':
      return displayName.startsWith('@') ? displayName : `@${displayName}`
    case 'telegram-bot':
    case 'webex':
    case 'webex-bot':
    case 'line':
    case 'kakaotalk':
      return displayName
  }
}

// Renders the single-line `> @mention: excerpt` blockquote prepended to
// outbound replies when the router decides the reply needs an anchor.
// Collapses newlines to spaces so a multi-line user message renders on
// one quoted line (markdown blockquote semantics: a blank line ends the
// quote, and `> foo\nbar` would split the quote and the reply); strips
// existing leading `>` so a quote-of-a-quote stays single-level. Empty
// inbound text (mention-only inbounds like `<@bot>`) falls back to a
// generic marker so the user still sees "the bot saw your ping".
export function renderQuoteAnchor(source: QuoteAnchorSource): string {
  const collapsed = source.text
    .replace(/\s+/g, ' ')
    .replace(/^>+\s*/, '')
    .trim()
  const excerpt =
    collapsed === ''
      ? '(no text)'
      : collapsed.length > QUOTED_REPLY_EXCERPT_MAX_CHARS
        ? `${collapsed.slice(0, QUOTED_REPLY_EXCERPT_MAX_CHARS - 1)}…`
        : collapsed
  const mention = formatAuthorReference(source.adapter, source.authorId, source.authorName)
  return `> ${mention}: ${excerpt}`
}

// Separates the anchor from the reply with a blank line (`\n\n`), not a
// single `\n`. In standard GFM and Slack's `markdown` block, a single
// `\n` inside a paragraph is a soft break rendered as whitespace, which
// keeps the `>` blockquote styling running visually through the next
// line — i.e. the agent's reply text gets swallowed into the quote. The
// blank line forces a paragraph boundary that unambiguously ends the
// blockquote on every renderer (CommonMark, GFM, Slack mrkdwn, Discord
// markdown).
export function prependQuoteAnchor(replyText: string, source: QuoteAnchorSource): string {
  const anchor = renderQuoteAnchor(source)
  if (replyText === '') return anchor
  return `${anchor}\n\n${replyText}`
}

type QuoteAnchorBatchEntry = {
  text: string
  authorId: string
  authorName: string
  authorIsBot: boolean
  receivedAt: number
  externalMessageId: string
}

type QuoteAnchorObservedEntry = {
  receivedAt: number
  source: 'prefetch' | 'observed'
}

export type QuoteAnchorCandidate = {
  source: QuoteAnchorSource
  // Native id of the primary inbound, so a native-reply adapter can point at
  // the exact message; the blockquote fallback ignores it.
  externalMessageId: string
  primaryReceivedAt: number
  hadInterveningObserved: boolean
}

export type QuoteAnchorTarget = {
  source: QuoteAnchorSource
  externalMessageId: string
}

// Strips both current `[<Adapter> attachment #N: ...]` and legacy
// `[<Adapter> message with ...]` placeholders that adapter
// classifiers synthesize for non-text inbounds (KakaoTalk stickers,
// Slack/Discord/Telegram attachments). The quote anchor is a UX
// affordance pointing the human at *their words* — quoting a sticker as
// `> Alice: [KakaoTalk attachment #1: sticker name=...]`
// is noise, and for mixed inbounds like `<caption> [KakaoTalk message with
// photo 1254x1254 ...]` the human only wrote the caption, so the placeholder
// is the wrong thing to surface. The callsite (captureQuoteCandidate)
// treats an empty residue as "no quote anchor"; mixed inbounds keep the
// human-written portion. renderQuoteAnchor later collapses whitespace
// so residual double-spaces from mid-string strips are harmless.
const CHANNEL_MEDIA_PLACEHOLDER_RE =
  /\[(?:KakaoTalk|Slack|Discord|Telegram) (?:message with|attachment #\d+:) [^\]]*\]/g

export function stripChannelMediaPlaceholders(text: string): string {
  return text
    .replace(CHANNEL_MEDIA_PLACEHOLDER_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

// Snapshot the primary inbound + observed-buffer state at drain time so
// the send-side decision has the data it needs without holding a
// reference to the batch arrays. Returns null when there's nothing
// anchorable (empty batch, primary is a bot, or primary is a non-text
// inbound with no residual human-written text after stripping the
// adapter's media placeholder).
//
// `hadInterveningObserved` counts ONLY live observations (`source ===
// 'observed'`), not prefetched scrollback. Prefetch stamps `receivedAt =
// now()` inside ensureLive — wall-clock-later than the primary inbound
// that triggered ensureLive — so without this gate, every cold-start
// first turn would see "intervening observed" entries and fire the
// quote anchor even when the reply lands within milliseconds. The
// signal we actually want is "did real new chatter arrive between the
// user's inbound and the agent's reply", which only live observations
// represent.
export function captureQuoteCandidate(
  adapter: AdapterId,
  batch: readonly QuoteAnchorBatchEntry[],
  observed: readonly QuoteAnchorObservedEntry[],
): QuoteAnchorCandidate | null {
  if (batch.length === 0) return null
  const primary = batch[batch.length - 1]!
  if (primary.authorIsBot) return null
  const cleaned = stripChannelMediaPlaceholders(primary.text)
  if (cleaned === '') return null
  return {
    source: { adapter, authorId: primary.authorId, authorName: primary.authorName, text: cleaned },
    externalMessageId: primary.externalMessageId,
    primaryReceivedAt: primary.receivedAt,
    hadInterveningObserved: hasInterveningObserved(primary.receivedAt, observed),
  }
}

function refreshQuoteCandidate(
  candidate: QuoteAnchorCandidate,
  observed: readonly QuoteAnchorObservedEntry[],
): QuoteAnchorCandidate {
  if (candidate.hadInterveningObserved) return candidate
  if (!hasInterveningObserved(candidate.primaryReceivedAt, observed)) return candidate
  return { ...candidate, hadInterveningObserved: true }
}

function hasInterveningObserved(primaryReceivedAt: number, observed: readonly QuoteAnchorObservedEntry[]): boolean {
  return observed.some((o) => o.source === 'observed' && o.receivedAt >= primaryReceivedAt)
}

// Send-time decision: given a captured candidate and the current clock,
// returns the source to anchor against or null. Skips when:
//   - quotedReply is disabled in config
//   - no observed messages came between primary inbound and now
// A null candidate (no batch yet, or batch was bot-only) always skips.
export function decideQuoteAnchor(
  candidate: QuoteAnchorCandidate | null,
  _nowMs: number,
  adapterConfig: ChannelAdapterConfig | undefined,
): QuoteAnchorTarget | null {
  if (candidate === null) return null
  const config = adapterConfig?.quotedReply
  if (config !== undefined && config.enabled === false) return null
  if (!candidate.hadInterveningObserved) return null
  return { source: candidate.source, externalMessageId: candidate.externalMessageId }
}

export type ReplyRenderMode = 'native' | 'quote'

// Per-adapter, per-shape decision: can this exact outbound carry a native
// platform reply, or must it degrade to the blockquote fallback? Conditional
// because native support is not uniform within an adapter — Telegram's
// `sendMessage` accepts `reply_to_message_id` but `sendDocument` does not, so
// an attachment-only Telegram reply must quote; the same text-only restriction
// holds for Discord (`message_reference` rides on the text send, file uploads
// land bare) and KakaoTalk. Slack's primitive is `thread`, not a per-message
// reply, so it stays quote; GitHub's PR-review reply already rides on `thread`.
//
// KakaoTalk is `native` here even though its reply payload can fail to resolve
// at send time — the adapter degrades to the blockquote fallback itself using
// `replyTo.source`, so the router still routes it down the native branch.
const NATIVE_REPLY_TEXT_ADAPTERS = new Set<AdapterId>(['telegram-bot', 'discord-bot', 'kakaotalk'])

// Webex's `parentId` rides on both `sendMessage` and `uploadFile`, so a reply is
// native for every shape — including attachment-only, which the text-gated set
// above cannot express. Special-cased before the text gate so the router sets
// `replyTo` (not a blockquote) even when the reply carries no text.
const NATIVE_REPLY_EVERY_SHAPE_ADAPTERS = new Set<AdapterId>(['webex', 'webex-bot'])

export function resolveReplyRenderMode(msg: OutboundMessage): ReplyRenderMode {
  if (NATIVE_REPLY_EVERY_SHAPE_ADAPTERS.has(msg.adapter)) return 'native'
  const hasText = normalizeSendText(msg.text) !== undefined
  if (hasText && NATIVE_REPLY_TEXT_ADAPTERS.has(msg.adapter)) return 'native'
  return 'quote'
}

type Sliced = { kind: 'message'; message: ChannelHistoryMessage } | { kind: 'elision'; elidedCount: number }

export function sliceHeadTail(messages: readonly ChannelHistoryMessage[], head: number, tail: number): Sliced[] {
  if (head < 0 || tail < 0) throw new Error(`sliceHeadTail: head and tail must be non-negative (got ${head}, ${tail})`)
  if (head === 0 && tail === 0) return []
  if (messages.length <= head + tail) {
    return messages.map((m) => ({ kind: 'message', message: m }))
  }
  const headSlice: Sliced[] = head > 0 ? messages.slice(0, head).map((m) => ({ kind: 'message', message: m })) : []
  const tailSlice: Sliced[] = tail > 0 ? messages.slice(-tail).map((m) => ({ kind: 'message', message: m })) : []
  const elidedCount = messages.length - head - tail
  return [...headSlice, { kind: 'elision', elidedCount }, ...tailSlice]
}

function tryOpenSessionManager(
  agentDir: string,
  sessionDir: string,
  existingSessionId: string,
  existingSessionFile: string | undefined,
  logger: RouterLogger,
): SessionManager {
  if (existingSessionFile === undefined) {
    logger.warn(
      `[channels] session ${existingSessionId} has no sessionFile (v2 mapping not yet migrated); creating new`,
    )
    return SessionManager.create(agentDir, sessionDir)
  }
  try {
    const path = `${sessionDir}/${existingSessionFile}`
    return SessionManager.open(path)
  } catch (err) {
    logger.warn(
      `[channels] could not rehydrate session ${existingSessionId} from ${existingSessionFile}: ${describe(err)}; creating new`,
    )
    return SessionManager.create(agentDir, sessionDir)
  }
}

function consecutiveSendKey(chat: string, thread: string | null | undefined): string {
  return `${chat}:${thread ?? ''}`
}

export type ResolveLiveSessionResult =
  | { kind: 'found'; session: LiveSession }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }

// Lookup policy for adapter-driven commands. Exact-key match always wins.
// On miss, fall back to (adapter, workspace, chat) without thread — but
// only when EXACTLY ONE non-destroyed candidate exists. Ambiguous matches
// return 'ambiguous' so the caller can refuse to act rather than abort an
// arbitrary session.
//
// Why the fallback: Slack slash commands carry channel_id but no thread_ts,
// so a slash invocation from a thread-keyed live session would otherwise
// report no-live-session. Discord doesn't hit this — Discord treats threads
// as channels, so the exact-key path already resolves.
//
// Why ambiguity-rejection: "first match wins" map-iteration semantics would
// abort an arbitrary thread when multiple thread-keyed sessions coexist in
// one channel (plausible on Slack: bot mentioned in multiple threads). The
// user's slash command picker doesn't know about threads; we don't know
// which they meant; refusing is safer than guessing.
export function resolveLiveSessionForCommand(
  liveSessions: ReadonlyMap<string, LiveSession>,
  key: ChannelKey,
): ResolveLiveSessionResult {
  const exact = liveSessions.get(channelKeyId(key))
  if (exact && !exact.destroyed) return { kind: 'found', session: exact }

  const matches: LiveSession[] = []
  for (const candidate of liveSessions.values()) {
    if (candidate.destroyed) continue
    if (
      candidate.key.adapter === key.adapter &&
      candidate.key.workspace === key.workspace &&
      candidate.key.chat === key.chat
    ) {
      matches.push(candidate)
      if (matches.length > 1) {
        return { kind: 'ambiguous', count: matches.length }
      }
    }
  }
  if (matches.length === 1) return { kind: 'found', session: matches[0]! }
  return { kind: 'none' }
}

// Strips leaked `<think>…</think>` reasoning from outbound message text. Some
// models (DeepSeek-R1 / Qwen-QwQ family) emit chain-of-thought inline as a
// literal `<think>` span in `delta.content` rather than a dedicated `thinking`
// content block, so it lands verbatim in the assistant body and — without this
// — gets posted to the channel (production: a reasoning paragraph leaked into a
// Slack thread). The whole block is removed, not just the tags.
//
// THINK_BLOCK_RE matches closed blocks (case-insensitive, attribute-tolerant,
// multi-line). DANGLING_THINK_RE catches an UNCLOSED trailing `<think>` (model
// ran out of budget mid-reasoning) by dropping open-tag-to-end. The final pass
// collapses excision-left blank-line runs and trims.
const THINK_BLOCK_RE = /<think\b[^>]*>[\s\S]*?<\/think\s*>/gi
const DANGLING_THINK_RE = /<think\b[^>]*>[\s\S]*$/i

export function stripThinkBlocks(text: string): string {
  const withoutBlocks = text.replace(THINK_BLOCK_RE, '').replace(DANGLING_THINK_RE, '')
  return withoutBlocks.replace(/\n{3,}/g, '\n\n').trim()
}

function normalizeSendText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  // Strip before the empty-collapse so a turn that was ONLY a think block
  // resolves to `undefined` (suppressed) instead of posting an empty shell.
  const stripped = stripThinkBlocks(text)
  if (stripped === '') return undefined
  return stripped
}

function recordSendTimestamp(live: LiveSession, sendKey: string, ts: number): number {
  const buf = live.sendTimestamps.get(sendKey)
  const cutoff = ts - SEND_RATE_WINDOW_MS
  if (!buf) {
    live.sendTimestamps.set(sendKey, [ts])
    return 1
  }
  let i = 0
  while (i < buf.length && buf[i]! <= cutoff) i++
  if (i > 0) buf.splice(0, i)
  buf.push(ts)
  return buf.length
}

function dmMembership(fetchedAt: number): MembershipCount {
  return { humans: 1, bots: 1, fetchedAt, truncated: false }
}

async function withMembershipTimeout(
  promise: Promise<MembershipCount | null>,
  key: ChannelKey,
  logger: RouterLogger,
): Promise<MembershipCount | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger.warn(
        `[channels] ${channelKeyId(key)}: membership cold fetch timed out after ${MEMBERSHIP_COLD_FETCH_TIMEOUT_MS}ms`,
      )
      resolve(null)
    }, MEMBERSHIP_COLD_FETCH_TIMEOUT_MS)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

// Throwing variant of the membership timeout pattern: races the work against
// a deadline and rejects with a descriptive error on miss. Used wherever a
// hung registered callback (Discord/Slack/Telegram REST) would otherwise
// leave an awaiting caller stuck forever and there is no graceful-
// degradation value the caller could substitute (contrast withMembershipTimeout,
// which returns null because engagement can run on a stale membership reading).
// The helper owns timer lifetime so callers cannot leak timers on a fast
// resolution.
async function raceWithTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

// Walks the session branch backward from the leaf to find a recoverable
// assistant message — i.e., text the user should see but didn't, because the
// model failed to call `channel_reply`/`channel_send` before its turn ended.
//
// Four recovery shapes:
//
//   - source: 'leaf'
//     The leaf entry IS an assistant message with `stopReason === 'stop'`.
//     The model finished its turn with visible text but never called a channel
//     tool. Pre-existing behavior; this is what the historical
//     `latestAssistantText` covered.
//
//   - source: 'length-leaf'
//     The leaf IS an assistant message with `stopReason === 'length'` — the
//     model hit the output cap, typically after interleaving reasoning past the
//     budget, but its text blocks usually hold a complete answer. Returned raw;
//     validateChannelTurn strips leaked `<think>` spans and posts the remainder
//     only if a real reply survives, else diverts to the raised-budget retry.
//     Observed against claude on a channel turn that fell silent (2026-06-12).
//
//   - source: 'mid-turn'
//     The leaf IS an assistant message with `stopReason === 'toolUse'` that
//     carries visible text. The model narrated a user-facing reply ("on it,
//     bumping to 16x now") AND committed to a tool plan in the same message,
//     but the turn ended before any follow-up assistant message that would
//     have called `channel_reply` was persisted — the upstream pi-agent-core
//     loop's post-tool follow-up never landed, or the run was aborted
//     mid-loop. The model treated its visible prose as ambient narration; in
//     a channel session that prose is dead text. Recovers it so the user gets
//     the reply the model thought it had already given. Observed against
//     Fireworks' `kimi-k2p6-turbo` on KakaoTalk: the agent posted speed-change
//     status as narration, kept taking screenshots, and the user saw nothing.
//     This is the leaf-is-assistant twin of the 'pre-tool' shape below.
//
//   - source: 'pre-tool'
//     The leaf is a `toolResult` and the immediately-prior assistant message
//     has `stopReason === 'toolUse'` (it called the tool that produced this
//     toolResult). The upstream pi-agent-core loop SHOULD have made a
//     follow-up LLM call after the tool returned, but that call either never
//     happened or produced no persisted message. Recovers the assistant's
//     pre-tool commentary so the user gets *something* — observed against
//     Fireworks' `accounts/fireworks/routers/kimi-k2p6-turbo` on 2026-05-26.
//
// Returns null when no recovery is appropriate:
//   - No leaf, no messages in branch, branch is malformed
//   - Leaf is an assistant with `stopReason` of 'error' / 'aborted' and is NOT
//     preceded by a toolResult pattern — we don't recover an upstream provider
//     failure ('error') or a terminal-reply abort ('aborted'); neither is a
//     deliberate reply. ('length' IS recovered now — see 'length-leaf' above.)
//   - Leaf is a user/system message (model hasn't responded yet)
//
// `visibleAssistantText` returning '' (empty string) is a valid recovery
// target — the caller's downstream guards (`endsWithNoReplySignal('')` returns
// true) handle the no-content case explicitly via the `no_reply` log.
function recoverableAssistantText(
  session: AgentSession,
): { text: string; source: 'leaf' | 'mid-turn' | 'pre-tool' | 'length-leaf' } | null {
  const leaf = session.sessionManager.getLeafEntry()
  if (!leaf) return null

  if (leaf.type === 'message' && leaf.message.role === 'assistant') {
    if (leaf.message.stopReason === 'stop') {
      return { text: visibleAssistantText(leaf.message), source: 'leaf' }
    }
    // The model committed to a tool plan but its visible prose never reached
    // the channel and no follow-up message that would have called a channel
    // tool was persisted. Recover the stranded prose.
    if (leaf.message.stopReason === 'toolUse') {
      return { text: visibleAssistantText(leaf.message), source: 'mid-turn' }
    }
    // A `length` leaf hit the output cap but routinely carries a complete (or
    // near-complete) answer in its text blocks — the model just kept reasoning
    // past the budget. Surfacing it as 'length-leaf' lets validateChannelTurn
    // strip leaked think-spans and post the answer if any survives, while still
    // diverting a think-only `length` turn to the raised-budget retry. A leaf
    // that also carries a toolCall block was truncated mid-tool-planning, not on
    // a final answer, so it is NOT the recoverable shape. `error` (provider
    // failure) and `aborted` (terminal-reply abort) stay unrecoverable too.
    if (leaf.message.stopReason === 'length' && !hasToolCall(leaf.message)) {
      return { text: visibleAssistantText(leaf.message), source: 'length-leaf' }
    }
    return null
  }

  // Pre-tool recovery: the leaf must be a toolResult message, and walking
  // back through parentId chain must land on an assistant message before any
  // user message (otherwise we'd be recovering text from a turn the user
  // already saw a reply to). Bounded walk with a depth guard so a malformed
  // session can't infinite-loop.
  if (!(leaf.type === 'message' && leaf.message.role === 'toolResult')) return null

  let cursor: { parentId: string | null } | undefined = leaf
  for (let depth = 0; depth < 32 && cursor?.parentId; depth++) {
    const parent = session.sessionManager.getEntry(cursor.parentId)
    if (!parent) return null
    if (parent.type === 'message') {
      if (parent.message.role === 'assistant') {
        return { text: visibleAssistantText(parent.message), source: 'pre-tool' }
      }
      if (parent.message.role === 'user') return null
    }
    cursor = parent
  }
  return null
}

// The non-terminal stop reason when the leaf is an assistant message that did
// NOT cleanly finish — `length` (hit the token cap, the canonical kimi
// reasoning-loop), `error` (an upstream provider failure), or `aborted` (the
// terminal-reply abort) — else undefined. `undefined` is the signature of a
// benign empty/cold turn (leaf undefined / a non-assistant entry). The
// validateChannelTurn recovery path branches on the specific reason: `error`
// diverts to the provider-error notice, `length` gets a raised retry budget,
// `aborted` retries under the default backstop.
function assistantLeafStopReason(session: AgentSession): 'length' | 'error' | 'aborted' | undefined {
  const leaf = session.sessionManager.getLeafEntry()
  if (!leaf || leaf.type !== 'message' || leaf.message.role !== 'assistant') return undefined
  const stop = leaf.message.stopReason
  if (stop === 'length' || stop === 'error' || stop === 'aborted') return stop
  return undefined
}

// True when the branch ends on an UNANSWERED `toolUse` that left NO postable
// prose — the model called a tool and the upstream pi-agent-core post-tool
// follow-up never produced an assistant message (the loop was aborted, or the
// follow-up stream cancelled). Two leaf shapes carry this signature: the leaf
// IS a `toolUse` assistant, or the leaf is a `toolResult` whose nearest
// assistant ancestor (reached before any user message) is `toolUse`. The
// no-prose requirement is the discriminator from a model that narrated a reply
// alongside its tool call and DID land a real send this turn (that trailing
// `toolUse` is delivered narration, not a stranded promise — leave it alone).
// Keys on the model having INTENDED to keep working with nothing yet said; used
// to re-prompt a turn that strands mid-work after a `continue: true` status
// reply instead of ending in silence.
function leafIsStrandedToolUse(session: AgentSession): boolean {
  const leaf = session.sessionManager.getLeafEntry()
  if (!leaf || leaf.type !== 'message') return false
  if (leaf.message.role === 'assistant') {
    return leaf.message.stopReason === 'toolUse' && visibleAssistantText(leaf.message).trim() === ''
  }
  if (leaf.message.role !== 'toolResult') return false
  let cursor: { parentId: string | null } | undefined = leaf
  for (let depth = 0; depth < 32 && cursor?.parentId; depth++) {
    const parent = session.sessionManager.getEntry(cursor.parentId)
    if (!parent) return false
    if (parent.type === 'message') {
      if (parent.message.role === 'assistant') {
        return parent.message.stopReason === 'toolUse' && visibleAssistantText(parent.message).trim() === ''
      }
      if (parent.message.role === 'user') return false
    }
    cursor = parent
  }
  return false
}

// True when the turn-end leaf is a FRESH empty `stop` (no text, no tool call,
// distinct from the leaf in place at the last successful send) AND the most
// recent send to this target was a continuation-willingness ack. This is the
// `channel_send` analogue of the `channel_reply` willingness path: the model
// acked "I'll check…", did post-ack work, then the follow-up came back as a
// clean empty completion that would otherwise be read as a deliberate `NO_REPLY`.
// The fresh-leaf check (`!== lastSendLeafId`) is what separates this degeneration
// from a legitimate ack-then-stop where the model meant to wait for the user.
function isEmptyStopAfterWillingnessAck(live: LiveSession): boolean {
  const leaf = live.session.sessionManager.getLeafEntry()
  if (!leaf || leaf.type !== 'message' || leaf.message.role !== 'assistant') return false
  if (leaf.message.stopReason !== 'stop') return false
  if (hasToolCall(leaf.message) || visibleAssistantText(leaf.message).trim() !== '') return false
  if (leaf.id === live.lastSendLeafId) return false
  const ackText = live.lastSentText.get(consecutiveSendKey(live.key.chat, live.key.thread))
  return ackText !== undefined && detectContinuationWillingness(ackText)
}

function visibleAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function hasToolCall(message: AssistantMessage): boolean {
  return message.content.some((block) => block.type === 'toolCall')
}

// Lenient on purpose: distilled / smaller models routinely drift off the
// documented `NO_REPLY` form. We additionally accept `(NO_REPLY)` (Claude-style
// hedging) and empty visible text (e.g. Kimi-distilled models that emit only a
// thinking block and end the turn) — without the empty case we'd recover an
// empty string into the chat. The prompt contract still teaches the strict
// literal; this just widens what we accept. Shared with channel_send /
// channel_reply so all three call sites stay in lockstep.
export function isNoReplySignal(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  if (trimmed === 'NO_REPLY') return true
  if (trimmed === '(NO_REPLY)') return true
  return false
}

// Looser sibling of isNoReplySignal, used ONLY by validateChannelTurn's
// recovery path. Catches leaked-reasoning turns where the model produced
// prose and then ended with the silent-turn token, e.g.
//   "The user is laughing. ... I'll end with NO_REPLY.NO_REPLY"
// Today those fall through to recovery and the entire reasoning paragraph
// gets posted to the channel — the worst-possible outcome, since the leaked
// prose is itself an admission that the model intended to stay silent.
//
// NOT shared with channel_send / channel_reply misuse guards: those need
// strict literal match so a legitimate message like "set NO_REPLY=true in
// the env" isn't rejected as a misuse of the silent-turn signal. Recovery
// is a different question — by the time we get here the model already
// failed to call the tool, and "ends in NO_REPLY" is strong evidence of
// intent to stay silent, not of intent to send those bytes.
//
// Matches (returns true):
//   "NO_REPLY"                        (strict)
//   "(NO_REPLY)"                      (strict, parenthesized)
//   "... I'll end with NO_REPLY"      (trailing token after whitespace)
//   "... end with NO_REPLY."          (+ sentence punctuation)
//   "... end with NO_REPLY.NO_REPLY"  (model-doubled terminator, glued)
//   "... and stop. (NO_REPLY)"        (parenthesized at end)
// Does not match (returns false):
//   "NO_REPLY means do nothing"       (token at start, prose after)
//   "the env var is NO_REPLY_MODE"    (substring, not whole token)
//   "no reply needed"                 (case-sensitive on purpose)
export function endsWithNoReplySignal(text: string): boolean {
  if (isNoReplySignal(text)) return true
  const trimmed = text.trim()
  if (trimmed === '') return false
  // Strip trailing sentence punctuation / closing brackets / whitespace, then
  // check the last whitespace-or-punctuation-separated token. The leading
  // boundary in the regex (`[\s.!?([]`) treats `.NO_REPLY` as a separate
  // token from the preceding sentence, which covers the model-doubled
  // `...NO_REPLY.NO_REPLY` shape.
  const tail = trimmed.replace(/[.!?)\]\s]+$/, '')
  return /(?:^|[\s.!?([])\(?NO_REPLY\)?$/.test(tail)
}

// Detects the upstream "empty response" debug sentinel: when the LLM ends a
// turn with only a `thinking` block, some provider SDK paths (observed
// against claude-opus-4-5 via pi-ai) fabricate a single text block whose
// body is a Python-repr dump of the raw API response — including the
// model's thinking content and Anthropic's tamper-proof signature. The
// recovery path in validateChannelTurn would otherwise post that sentinel
// straight to the channel (production: signature leaked into a public
// Slack channel on 2026-05-21).
//
// Kept separate from isNoReplySignal on purpose: that helper is the agent's
// deliberate silent-turn protocol, this is upstream damage control. They
// log under distinct subjects (`upstream_empty_response_sentinel` vs
// `no_reply`) so an operator can tell a healthy quiet turn from a stream of
// upstream empties that warrant investigation.
//
// Strict detection: leading `(Empty response:` AND a dict-encoded
// `'stop_reason'` key. Catches the observed shape
// `(Empty response: {'content': [...], 'stop_reason': 'end_turn', ...})`
// while allowing legit prose like "Empty response from the cache layer".
export function isUpstreamEmptyResponseSentinel(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('(Empty response:')) return false
  return trimmed.includes("'stop_reason'")
}

// Detects any Kimi-family tool-call delimiter token. Kimi-family deployments
// emit tool calls inline in their native chat template using these tokens:
//
//   <|tool_calls_section_begin|>
//     <|tool_call_begin|>functions.<name>:<idx><|tool_call_argument_begin|>{...}<|tool_call_end|>
//   <|tool_calls_section_end|>
//
// (Source: https://github.com/MoonshotAI/Kimi-K2/blob/1b4022b/docs/tool_call_guidance.md;
// the documented set is exactly five tokens — the section begin/end markers,
// the per-call begin/end markers, and the argument-begin separator. There is
// no `<|tool_call_argument_end|>`: arguments terminate at `<|tool_call_end|>`.)
//
// Production inference servers are expected to parse this format server-side
// and translate it into OpenAI-shaped `choice.delta.tool_calls`. When the
// translation breaks (observed against Fireworks' `kimi-k2p6-turbo` router on
// 2026-05-24; vLLM had a similar class of leak fixed in
// https://github.com/vllm-project/vllm/pull/38579), the raw tokens flow
// through `choice.delta.content` instead. pi-ai's `openai-completions`
// provider is vendor-neutral and has no Kimi-specific parser, so they land
// verbatim in the assistant message's text content with `stopReason: 'stop'`.
//
// Used as a defense-in-depth check at the `channel_send` / `channel_reply`
// tool boundary so a model that somehow passes raw delimiter text as the
// message body is denied. NOT used directly by the recovery path in
// `validateChannelTurn` — see `isLikelyKimiChannelToolLeak` below.
const KIMI_TOOL_DELIMITER_RE = /<\|tool_calls_section_(?:begin|end)\|>|<\|tool_call_(?:begin|end|argument_begin)\|>/

export function containsKimiToolDelimiter(text: string): boolean {
  return KIMI_TOOL_DELIMITER_RE.test(text)
}

// Narrower predicate used by `validateChannelTurn` to decide whether to
// suppress recovery of assistant text. Requires BOTH:
//   (1) at least one Kimi tool-call delimiter token, AND
//   (2) a recognizable channel-tool-call identifier (`channel_reply:N` or
//       `channel_send:N`, with or without the `functions.` prefix).
//
// The two-signal rule narrows the false-positive surface to "the model was
// trying to call a channel tool and the upstream parser failed". Bare-text
// discussion of the Kimi protocol — e.g. the agent answering "explain Kimi's
// tool-call format" with documentation-style prose containing `<|tool_call_begin|>`
// — does NOT trigger suppression and reaches the user normally. The leak shape
// observed in production (`channel_reply:0<|tool_call_argument_begin|>{...}<|tool_calls_section_end|>`)
// satisfies both conditions trivially.
//
// The tool-name regex deliberately stays loose on the index suffix
// (`channel_reply:0` / `channel_reply:1` / `channel_send:0` / ...): every
// observed leak uses the canonical `functions.<name>:<idx>` shape, but partial
// parsers may strip the `functions.` prefix before the leak surfaces.
const KIMI_CHANNEL_TOOL_ID_RE = /(?:functions\.)?channel_(?:reply|send):\d+/

export function isLikelyKimiChannelToolLeak(text: string): boolean {
  if (!containsKimiToolDelimiter(text)) return false
  return KIMI_CHANNEL_TOOL_ID_RE.test(text)
}

// Detects the *plain-text* shape of a leaked tool invocation — the model
// serialized a tool call as ordinary prose instead of producing a real tool
// call. Observed against Kimi-family deployments on KakaoTalk: the entire
// assistant message body is literally
//
//   channel_reply({"text":"<the user-facing greeting the bot meant to send>"})
//
// with no Kimi delimiter tokens (`<|tool_call_begin|>` etc.), so
// `isLikelyKimiChannelToolLeak` cannot catch it. Without a guard the
// recovery path in `validateChannelTurn` posts this raw function-call
// serialization straight to the channel, which is exactly what
// users see in the reported screenshots.
//
// `skip_response` belongs here too, and is the more insidious case: the model
// means to *decline* the turn but serializes the decision as prose —
//
//   skip_response({ reason: "Empty messages, no content to respond to" })
//
// Because the recovery path treats this as ordinary assistant text, the bot
// posts its own "I'm staying silent" plumbing to the channel, the exact
// opposite of the intended no-op. It is never a legitimate user-facing reply.
//
// Structural-only detection (NOT a substring search): the trimmed text must
// *start* with `channel_reply(`, `channel_send(`, or `skip_response(`, and
// that opening paren must enclose at least one quote — `"` or `'` (the
// serialized argument). The single-quote arm matters because the extractor
// recovers single-quoted values too; if the classifier only matched `"`, a
// single-quoted leak like `channel_reply({text: 'hi'})` would bypass the
// extractor and post raw plumbing. This deliberately matches the leak shape
// while letting prose that merely
// *mentions* a tool name (e.g. "I would normally call channel_reply here
// but...") reach the user — that false-positive class is already locked in by
// the `still recovers prose that mentions channel_reply` test.
//
// The trailing close paren is NOT required: the model sometimes truncates
// mid-serialization, and a half-leaked `channel_reply({"text":"..."` is
// just as user-hostile as the full shape.
const PLAIN_TEXT_CHANNEL_TOOL_CALL_RE = /^(channel_reply|channel_send|skip_response)\s*\(\s*[^)]*["']/

export type PlainTextChannelToolCallKind = 'reply' | 'send' | 'skip'

export function getPlainTextChannelToolCallKind(text: string): PlainTextChannelToolCallKind | null {
  const match = PLAIN_TEXT_CHANNEL_TOOL_CALL_RE.exec(text.trim())
  if (match === null) return null
  switch (match[1]) {
    case 'channel_reply':
      return 'reply'
    case 'channel_send':
      return 'send'
    case 'skip_response':
      return 'skip'
    default:
      return null
  }
}

export function isLikelyPlainTextChannelToolCall(text: string): boolean {
  return getPlainTextChannelToolCallKind(text) !== null
}

// Tolerant single-purpose scanner that pulls the `text` argument out of a
// plain-text-serialized `channel_reply(...)` / `channel_send(...)` leak. A
// single regex covering every shape (double/single/unquoted keys, escaped
// quotes, mid-serialization truncation) is fragile, so this walks the string
// once and extracts only the first string-valued `text` property. `channel_send`
// also carries `adapter`/`chat`/`thread`, which are intentionally ignored —
// recovery always routes back through the current channel, never a
// model-supplied destination. Returns null when no recoverable, non-empty
// `text` value is present so the caller can fall back to suppression.
export function extractPlainTextChannelToolCallText(text: string): string | null {
  const trimmed = text.trim()
  if (!/^(?:channel_reply|channel_send)\s*\(/.test(trimmed)) return null

  // Walk the serialization once, honoring a `text` key only at the top level of
  // the argument object (braceDepth 1, outside any array). Two failure classes
  // motivate the bookkeeping: a `text:` inside an earlier quoted value, e.g.
  // `channel_send({ reason: "see text: here", text: "real" })`, and a `text:`
  // inside a *nested* object, e.g. `channel_reply({ meta: { text: "x" }, text:
  // "real" })`. Skipping string literals defeats the first; tracking
  // brace/bracket depth and matching keys only at top level defeats the second.
  // Either way the scanner lands on the real reply instead of leaking the wrong
  // value or dropping the message.
  let braceDepth = 0
  let bracketDepth = 0
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!

    if (ch === '"' || ch === "'") {
      i = skipStringLiteral(trimmed, i, ch)
      continue
    }

    if (ch === '{') {
      braceDepth++
      if (braceDepth === 1 && bracketDepth === 0) {
        const value = readTextKeyValueAt(trimmed, i + 1)
        if (value !== undefined) return value
      }
      continue
    }
    if (ch === '}') {
      if (braceDepth > 0) braceDepth--
      continue
    }
    if (ch === '[') {
      bracketDepth++
      continue
    }
    if (ch === ']') {
      if (bracketDepth > 0) bracketDepth--
      continue
    }

    if (ch === ',' && braceDepth === 1 && bracketDepth === 0) {
      const value = readTextKeyValueAt(trimmed, i + 1)
      if (value !== undefined) return value
    }
  }

  return null
}

// Returns the recovered value (string or null) when a `text` key starts at
// `from`, or undefined when no `text` key is present there so the scanner keeps
// walking. The null/undefined split lets a malformed `text` value short-circuit
// to suppression while a non-`text` delimiter is simply skipped.
function readTextKeyValueAt(s: string, from: number): string | null | undefined {
  const afterKey = matchTextKey(s, from)
  if (afterKey === null) return undefined

  const quote = s[afterKey]
  if (quote !== '"' && quote !== "'") return null
  return readStringValue(s, afterKey + 1, quote)
}

// Returns the closing-quote index, or the last index when the literal is
// truncated, so the caller's `i++` resumes past the consumed string.
function skipStringLiteral(s: string, openIdx: number, quote: string): number {
  let escaped = false
  for (let i = openIdx + 1; i < s.length; i++) {
    const ch = s[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === quote) return i
  }
  return s.length
}

function matchTextKey(s: string, from: number): number | null {
  const m = /^\s*(?:"text"|'text'|text)\s*:\s*/.exec(s.slice(from))
  return m === null ? null : from + m[0].length
}

function readStringValue(s: string, from: number, quote: string): string | null {
  let value = ''
  let escaped = false
  for (let i = from; i < s.length; i++) {
    const ch = s[i]!
    if (escaped) {
      value += ESCAPE_REPLACEMENTS[ch] ?? ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === quote) break
    value += ch
  }
  return value.trim().length > 0 ? value : null
}

const ESCAPE_REPLACEMENTS: Record<string, string> = { n: '\n', r: '\r', t: '\t' }

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Used by tests / external diagnostics.
export type { ChannelSessionRecord }
export { channelsSessionsPath }
