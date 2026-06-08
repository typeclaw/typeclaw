import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import { checkFalseReceipt } from '@/channels/github-false-receipt'
import { evaluateRereviewGuard } from '@/channels/github-rereview-guard'
import {
  containsKimiToolDelimiter,
  isNoReplySignal,
  isUpstreamEmptyResponseSentinel,
  type ChannelRouter,
} from '@/channels/router'
import type { AdapterId } from '@/channels/schema'

import { type ChannelToolLogger, consoleChannelLogger, formatChannelToolFailure } from './channel-log'
import { fenceRuntimeNotice, fenceToolResult } from './runtime-notice'

export type ChannelReplyOrigin = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
}

export type CreateChannelReplyToolOptions = {
  router: ChannelRouter
  origin: ChannelReplyOrigin
  // Scopes the per-turn false-receipt ledger. Defaults to '' when a caller (e.g.
  // a focused test) has no session; the guard then simply finds no recorded
  // action and falls back to its safe default.
  sessionId?: string
  logger?: ChannelToolLogger
}

// channel_reply is the happy-path companion to channel_send for channel-routed
// sessions. The session's origin already pins the conversation we're inside
// (adapter, workspace, chat, thread), so the model shouldn't have to copy
// those fields verbatim every turn — that copying is exactly where it has
// historically dropped `thread` and posted to channel root by accident.
//
// channel_reply takes only `text` and addresses the message from the origin.
// channel_send remains for posting somewhere else (different chat, breaking
// out of a thread, sending DMs from a channel session, etc.).
export function createChannelReplyTool({
  router,
  origin,
  sessionId = '',
  logger = consoleChannelLogger,
}: CreateChannelReplyToolOptions) {
  return defineTool({
    name: 'channel_reply',
    label: 'Channel Reply',
    description:
      'Reply in the current conversation. This is your default way to respond to a channel session — ' +
      'addressing fields (adapter, workspace, chat, thread) are filled in from the session origin, so ' +
      'you only supply the text. To post somewhere else (different chat, break out of the current ' +
      'thread, etc.), use `channel_send` instead.',
    parameters: Type.Object({
      text: Type.Optional(
        Type.String({
          description:
            'The message body. Use platform mention syntax `<@USER_ID>` for Slack/Discord mentions. Optional only when `attachments` is set.',
          minLength: 1,
        }),
      ),
      attachments: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({
              description: 'Absolute path inside the agent container to the file to upload.',
              minLength: 1,
            }),
            filename: Type.Optional(Type.String({ minLength: 1 })),
          }),
          {
            description:
              'Optional files to attach. Slack folds `text` into the first file as a caption (single message). Discord uploads files separately and may post `text` as a follow-up message; uploaded files land in channel root even when replying inside a thread (upstream limitation).',
            minItems: 1,
          },
        ),
      ),
      continue: Type.Optional(
        Type.Boolean({
          description:
            'Set `true` when this reply is a mid-turn status update (e.g. "working on it…") and you still have work to do THIS turn — fetching data, running a tool, spawning a subagent, then replying again. ' +
            'Omitting it on such an ack silently truncates the turn: a successful reply ends the turn by default, so the fetch/subagent/answer you intended to do next never runs. ' +
            'A normal final reply omits this (no wasted follow-up LLM call). ' +
            'Do not set it just to seem responsive; only when genuine multi-step work follows in the same turn.',
        }),
      ),
      resolve_review_thread: Type.Optional(
        Type.Boolean({
          description:
            'GitHub review threads ONLY — ignored on Slack, Discord, Telegram, KakaoTalk, and any non-github session, and ignored on a github reply that is not inside a `thread`. On those, leave this unset and ignore the rest of this description. ' +
            'On a github reply inside a review thread you authored: when your `text` acknowledges the concern is fixed/verified/addressed (e.g. "verified at <sha>", "thanks, that resolves it"), treat setting this `true` as the expected close-out — do it in the SAME call. This is a strong instruction, not a schema requirement: the field stays optional and nothing rejects an acknowledgement that omits it, but a bare ack without it leaves the thread open, because a successful reply ends the turn and the resolve cannot run in a later one. So this flag is the only way the close-out actually happens. ' +
            "It is safe to set by default: the runtime resolves BEFORE posting and ONLY if the thread's root comment is yours — it refuses (and blocks the reply) on a human reviewer's thread, so you never close someone else's open question. You need not pre-check authorship; just set it on your acknowledgement and let the runtime enforce ownership. Leave it unset when you intend to keep the thread open (partial fix, disagreement, mid-discussion).",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const text = params.text
      const attachments = params.attachments
      const keepTurnAlive = params.continue === true
      if ((text === undefined || text === '') && (attachments === undefined || attachments.length === 0)) {
        logger.warn(formatChannelToolFailure('channel_reply', 'missing text and attachments'))
        return {
          content: [
            { type: 'text' as const, text: 'channel_reply denied: must provide `text`, `attachments`, or both.' },
          ],
          details: { ok: false, error: 'missing text and attachments' },
        }
      }

      const noReplyError = noReplyMisuseError(text)
      if (noReplyError) {
        logger.warn(formatChannelToolFailure('channel_reply', noReplyError))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${noReplyError}` }],
          details: { ok: false, error: noReplyError },
        }
      }

      const upstreamSentinelError = upstreamEmptyResponseSentinelError(text)
      if (upstreamSentinelError) {
        logger.warn(formatChannelToolFailure('channel_reply', upstreamSentinelError))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${upstreamSentinelError}` }],
          details: { ok: false, error: upstreamSentinelError },
        }
      }

      const kimiLeakError = kimiToolCallLeakError(text)
      if (kimiLeakError) {
        logger.warn(formatChannelToolFailure('channel_reply', kimiLeakError))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${kimiLeakError}` }],
          details: { ok: false, error: kimiLeakError },
        }
      }

      // False-receipt guard: deny a terminal reply that CLAIMS a PR verdict /
      // thread close-out the agent never actually performed this turn. Warn-tier
      // claims fall through and have their notice appended on success below.
      const falseReceipt = checkFalseReceipt({
        sessionId,
        adapter: origin.adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        thread: origin.thread,
        text,
        isContinue: keepTurnAlive,
        resolveReviewThread: params.resolve_review_thread === true,
      })
      if (falseReceipt.kind === 'block') {
        logger.warn(formatChannelToolFailure('channel_reply', falseReceipt.reason))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${falseReceipt.reason}` }],
          details: { ok: false, error: falseReceipt.reason },
        }
      }
      const falseReceiptNotice = falseReceipt.kind === 'warn' ? falseReceipt.notice : null

      // Re-review stranding guard: block a thread close-out / verdict ack while
      // the bot still holds its own CHANGES_REQUESTED on this PR, so it can't
      // silently leave the PR blocked (PR #644). Runs before the resolve so a
      // blocked close-out never mutates the thread.
      const rereview = await evaluateRereviewGuard({
        adapter: origin.adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        thread: origin.thread,
        text,
        wantsResolve: params.resolve_review_thread === true,
        isContinue: keepTurnAlive,
        getReviewState: (req) => router.getReviewState(req),
      })
      if (rereview.block) {
        logger.warn(formatChannelToolFailure('channel_reply', rereview.reason))
        return {
          content: [{ type: 'text' as const, text: `channel_reply denied: ${rereview.reason}` }],
          details: { ok: false, error: rereview.reason },
        }
      }

      // Runs before the resolve so a blocked ack never mutates the thread, and
      // only when the model did NOT opt in with `continue: true` (matching the
      // false-receipt / rereview precedent: an explicit keep-alive is trusted).
      if (!keepTurnAlive) {
        const droppedFollowupError = committedFollowupWithoutContinueError(text)
        if (droppedFollowupError) {
          logger.warn(formatChannelToolFailure('channel_reply', droppedFollowupError))
          return {
            content: [{ type: 'text' as const, text: `channel_reply denied: ${droppedFollowupError}` }],
            details: { ok: false, error: droppedFollowupError },
          }
        }
      }

      // Resolve BEFORE posting: a successful channel_reply ends the turn, so a
      // resolve attempted "after" the ack would never run (the exact bug this
      // flag fixes). Resolve-failure blocks the reply so the agent never posts
      // a "looks resolved" ack next to a still-open thread; the router enforces
      // that only the bot's own threads can be resolved.
      if (params.resolve_review_thread === true) {
        const resolveError = await resolveReviewThreadBeforeReply(router, origin)
        if (resolveError !== null) {
          logger.warn(formatChannelToolFailure('channel_reply', resolveError))
          return {
            content: [{ type: 'text' as const, text: `channel_reply denied: ${resolveError}` }],
            details: { ok: false, error: resolveError },
          }
        }
      }

      const result = await router.send({
        adapter: origin.adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        thread: origin.thread,
        ...(text !== undefined ? { text } : {}),
        ...(attachments !== undefined ? { attachments } : {}),
      })

      if (!result.ok) {
        logger.warn(
          formatChannelToolFailure(
            'channel_reply',
            `${origin.adapter}:${origin.workspace}/${origin.chat}: ${result.error}`,
          ),
        )
      }
      // `continue` is read by the router's terminal hook (installChannelReplyTerminalHook),
      // not by this tool — it suppresses the post-reply abort so a multi-step turn
      // keeps going. Success-only: a denied reply never ran, so there is no turn to keep.
      const details: { ok: boolean; error?: string; continue?: boolean } = result.ok
        ? keepTurnAlive
          ? { ok: true, continue: true }
          : { ok: true }
        : { ok: false, error: result.error }
      // Echo the delivered text back to the model. The adapter classifier
      // drops self-authored messages on the inbound path (`self_author`),
      // so the bot otherwise has ZERO visibility into what it just said —
      // not in the next iteration's context, not in later turns' history.
      // Without this echo, a model that splits a multi-part reply has no
      // way to tell "did I already send part 1?" from "I haven't started
      // yet", and routinely re-sends near-duplicates within the same turn
      // (observed in production: two consecutive identical greeting messages
      // to one prompt).
      //
      // The echo is the model's OWN words, which is uniquely seductive to
      // "reply" to, so on the success path we wrap the whole result in the
      // strong SYSTEM MESSAGE fence (`fenceToolResult`) rather than the weak
      // `[system: tool result...]` prefix — the prefix did not stop Kimi from
      // answering its own echo and looping (PR #481). Denials carry no echoed
      // prose (just machine error text), so they keep the lighter prefix.
      if (result.ok) {
        const echo = renderOutboundEcho(text, attachments)
        const receipt = `posted to ${origin.adapter}:${origin.workspace}/${origin.chat}: ${echo}`
        const hint = consecutiveSendHint(
          router.getConsecutiveSendCount({
            adapter: origin.adapter,
            workspace: origin.workspace,
            chat: origin.chat,
            thread: origin.thread,
          }),
        )
        // Keep fenceToolResult here — do NOT "unify" the success branch back to
        // TOOL_RESULT_PREFIX to match the denial branch below. The prefix is
        // intentionally weaker and is safe ONLY because denials carry no echoed
        // prose; the success result does, and the weak prefix let Kimi loop.
        const warnNote = falseReceiptNotice !== null ? fenceRuntimeNotice(falseReceiptNotice) : ''
        return {
          content: [{ type: 'text' as const, text: `${fenceToolResult(receipt)}${hint}${warnNote}` }],
          details,
        }
      }
      return {
        content: [{ type: 'text' as const, text: `${TOOL_RESULT_PREFIX}channel_reply denied: ${result.error}` }],
        details,
      }
    },
  })
}

// Returns an error string when the resolve should block the reply, or null
// when it's safe to proceed. Only `no-match` (the thread is already gone, so
// there's nothing to close) joins success as non-blocking; every hard failure
// — wrong author, permission denial, HTTP 404 on a misdirected lookup,
// transient API error — blocks, so the agent never claims a thread is settled
// when the resolve did not actually run.
async function resolveReviewThreadBeforeReply(
  router: ChannelRouter,
  origin: ChannelReplyOrigin,
): Promise<string | null> {
  if (origin.adapter !== 'github') {
    return 'resolve_review_thread is only supported on github sessions.'
  }
  if (origin.thread === null) {
    return 'resolve_review_thread requires replying inside a review thread (no thread on this origin).'
  }
  const result = await router.resolveReviewThread({
    adapter: origin.adapter,
    workspace: origin.workspace,
    chat: origin.chat,
    rootCommentId: origin.thread,
  })
  if (result.ok) return null
  if (result.code === 'no-match') return null
  return `could not resolve review thread: ${result.error}`
}

// Tool results reach the model as USER-role messages (OpenAI / Anthropic
// tool-API contract — the engine cannot tag them as system). Without this
// marker a persona-rich model reads its own echo as a fresh user inbound
// and replies to itself. Observed in production: Kimi K2 on KakaoTalk
// re-invoked after a successful send saw only the echo as new context
// and hallucinated a goodbye trigger from it. Mirrored verbatim in
// channel-send.ts so both tools share one greppable marker.
export const TOOL_RESULT_PREFIX = '[system: tool result, not a user message] '

export const ECHO_MAX_CHARS = 500

export function renderEcho(text: string): string {
  if (text.length <= ECHO_MAX_CHARS) return JSON.stringify(text)
  return `${JSON.stringify(text.slice(0, ECHO_MAX_CHARS))}... (${text.length} chars total)`
}

// DO NOT remove this echo or replace it with a hash/length-only "receipt" to
// stop the self-reply loop (PR #481). That trade was tried and rejected: the
// echo is the model's only view of what it already said (the inbound path
// drops self-authored messages), so without the FULL text a split reply
// re-sends near-duplicates — the exact bug 58c62c1 added the echo to fix, and
// a fingerprint cannot catch paraphrased near-dupes. The loop is solved by
// FENCING this echo (see fenceToolResult call site below), not by removing it.
export function renderOutboundEcho(
  text: string | undefined,
  attachments: ReadonlyArray<{ path: string; filename?: string }> | undefined,
): string {
  const hasText = text !== undefined && text !== ''
  const hasAttachments = attachments !== undefined && attachments.length > 0
  if (hasText && hasAttachments) {
    const filenames = attachments.map((a) => a.filename ?? a.path.split('/').pop() ?? a.path)
    return `${renderEcho(text)} + ${attachments.length} file(s): ${filenames.join(', ')}`
  }
  if (hasText) return renderEcho(text)
  if (hasAttachments) {
    const filenames = attachments.map((a) => a.filename ?? a.path.split('/').pop() ?? a.path)
    return `${attachments.length} file(s): ${filenames.join(', ')}`
  }
  return '(empty)'
}

// Mirror of the same guard used by channel_send. Blocks any silent-turn
// signal (per `isNoReplySignal`) from being sent as a message body — same
// misuse, same denial, regardless of which sending tool the model picked.
// Returns '' when text is undefined (attachments-only reply, can't be
// misusing the signal) or when text is non-empty and not a signal.
function noReplyMisuseError(text: string | undefined): string {
  if (text === undefined) return ''
  if (text.trim() === '') return ''
  if (!isNoReplySignal(text)) return ''
  return (
    '`NO_REPLY` is the silent-turn signal, not a message body. ' +
    'To stay silent, end your turn with `NO_REPLY` as your entire visible response and NO channel tool call. ' +
    'To send an actual reply, call this tool again with different text.'
  )
}

// Mirror of the same guard used by channel_send. Blocks the upstream
// `(Empty response: ...)` debug sentinel from being sent verbatim — that
// payload carries the model's thinking content and signature, never a
// real user-facing message.
function upstreamEmptyResponseSentinelError(text: string | undefined): string {
  if (text === undefined) return ''
  if (!isUpstreamEmptyResponseSentinel(text)) return ''
  return (
    'refusing to forward an upstream `(Empty response: ...)` sentinel; ' +
    "that string is a provider-SDK debug dump containing the model's thinking content and signature, " +
    'not a message body. End your turn silently (visible text empty or `NO_REPLY`) instead.'
  )
}

function kimiToolCallLeakError(text: string | undefined): string {
  if (text === undefined) return ''
  if (!containsKimiToolDelimiter(text)) return ''
  return (
    'refusing to forward raw provider tool-call control tokens; these are chat-template ' +
    'delimiters that should have been parsed into a real tool call upstream. ' +
    'Re-issue the intended channel reply as plain user-visible text only.'
  )
}

// Same-turn work-commitment markers: a FIRST-PERSON, IMMEDIATE promise to do
// work right now ("I'll re-check", "let me look", "다시 확인해볼게", "찾아볼게").
// Deliberately narrow — see the exclusion guards in `promisesSameTurnFollowup`
// for why conditionals, imperatives-to-the-user, and past-tense statements must
// NOT match.
const SAME_TURN_COMMITMENT = [
  // English: first-person future/immediate work verbs.
  /\bi(?:'| a)?ll\s+(?:re-?)?(?:check|look|verify|confirm|research|find|search|dig|investigate|fetch|grab|pull|see)\b/i,
  /\blet me\s+(?:re-?)?(?:check|look|verify|confirm|research|find|search|dig|investigate|fetch|grab|pull|see)\b/i,
  /\b(?:on it|working on it|hold on|one sec|gimme a sec|gonna (?:check|look|research|find))\b/i,
  // Korean: first-person immediate-commitment ending `~ㄹ게/~ㄹ게요` on a work
  // verb (확인/찾아/알아보/검색/조회/볼/해보). Matches `확인해볼게`, `찾아볼게`,
  // `검색해볼게`, `알아볼게`, `다시 볼게`.
  /(?:확인|찾아|알아보|알아볼|검색|조회|뒤져|살펴)\S*(?:볼게|볼께|할게|할께|해볼게|해볼께)/,
  /다시\s*(?:확인|찾아|볼게|볼께|체크)/,
]

// Past-tense / already-done markers. If the reply states the work is DONE, it
// is a terminal answer carrying results, not a same-turn commitment — never block.
// Korean past tense: `~했음/봤음/봄/찾음/완료`. English: "I checked/looked/found".
const WORK_ALREADY_DONE = [
  /(?:했음|봤음|찾았|찾아봤|찾아봄|확인했|검색했|알아봤|조회했|완료|끝냈|끝남)/,
  /\bi\s+(?:already\s+)?(?:checked|looked|found|verified|confirmed|researched|searched|dug)\b/i,
]

// Imperative-to-the-user markers: the bot is telling the USER to go check, not
// promising to do it itself. Korean `~해봐/~해보셈/~확인해봐/~체크해`. These are
// terminal advice, never a same-turn commitment.
const USER_IMPERATIVE = [/(?:확인해봐|확인해보셈|체크해보셈|체크해봐|해보셈|알아봐|찾아봐|봐바|보셈)/]

// Conditional markers: `~(으)면 ...할게` ("if you ..., I'll ..."). A promise
// gated on a future user action is not same-turn work — never block.
const CONDITIONAL = [/(?:면|으면|주면|하면)\s*\S*(?:볼게|볼께|할게|할께|해볼게)/, /\bif you\b/i]

// True only for a BARE ack that promises same-turn work but omits `continue: true`.
// Without the flag a successful reply ends the turn (router terminal-abort hook),
// so the work the model just promised never runs — a silently dropped task. We
// refuse the ack so the model must set `continue: true` or do the work first;
// the failed reply keeps `details.ok` false, so the turn stays alive. Tuned
// conservative: false negatives are cheap, false positives (blocking a real final
// reply) are not. The length/newline test below treats any substantive reply as
// a real answer, not an ack.
function promisesSameTurnFollowup(text: string | undefined): boolean {
  if (text === undefined) return false
  const trimmed = text.trim()
  if (trimmed === '') return false
  if (trimmed.length > 160) return false
  if (trimmed.includes('\n')) return false
  if (WORK_ALREADY_DONE.some((re) => re.test(trimmed))) return false
  if (USER_IMPERATIVE.some((re) => re.test(trimmed))) return false
  if (CONDITIONAL.some((re) => re.test(trimmed))) return false
  return SAME_TURN_COMMITMENT.some((re) => re.test(trimmed))
}

function committedFollowupWithoutContinueError(text: string | undefined): string {
  if (!promisesSameTurnFollowup(text)) return ''
  return (
    'this reply promises follow-up work THIS turn but omits `continue: true`. ' +
    'A successful reply ends the turn, so the fetch/tool/subagent you just said ' +
    "you'd do would never run. Either set `continue: true` on this reply and then " +
    'do the work, or do the work first and reply once with the result.'
  )
}

// Mirror of the same hint used by channel_send. Kept identical so the model
// sees the same yield signal regardless of which tool it picked. The body
// is wrapped via `fenceRuntimeNotice` (in `./runtime-notice`) so persona-rich
// models cannot read the trailing prose as a chat instruction and reply to
// it in-character. See that helper's comment for the failure mode that
// motivated the framing.
function consecutiveSendHint(countAfterSend: number): string {
  if (countAfterSend <= 1) return ''
  const body =
    countAfterSend === 2
      ? 'this is your 2nd consecutive message in this conversation; continue only if the reply genuinely needs splitting.'
      : `${countAfterSend}th consecutive message with no user reply; end your turn now unless the user explicitly asked for a multi-step response.`
  return fenceRuntimeNotice(body)
}
