// Shared renderer for the `<system-reminder>` block injected into a parent
// session's prompt queue when one of its backgrounded subagents finishes.
// Used by the TUI route in src/server/index.ts and the channel-router
// bridge so the model sees identical wording across origins. The
// `channel` knob is the only per-origin difference: channel sessions
// need the "end your reply via channel_reply" nudge because plain-text
// output is invisible there AND the reminder is not a user message —
// the channel origin block's MUST-call-channel_reply rule is keyed to
// user messages, so a model that reads the spec literally would
// otherwise leave the reply un-sent.

export type CompletionReminderArgs = {
  subagent: string
  taskId: string
  ok: boolean
  durationMs: number
  error?: string
  hasRecoverableOutput?: boolean
  channel?: boolean
  adapter?: string
}

const CHANNEL_REPLY_NUDGE =
  'This reminder is a system message, not a user inbound — but you are in a channel session, ' +
  'so end your turn via `channel_reply` (or `channel_send`) to surface the result. ' +
  'Plain-text output is invisible here. If you spawned this subagent to answer a user, ' +
  'this is the turn where that promised reply lands — fetch the result via `subagent_output` ' +
  'and send it. If the result is genuinely empty or duplicates something you already replied ' +
  'with in this conversation, call `skip_response({ reason: "..." })` instead so the operator ' +
  'can see why the post-completion turn was silent. `NO_REPLY` is the legacy fallback only when ' +
  '`skip_response` is unavailable.'

// Conditional carve-out for github channel sessions. The base nudge above
// steers EVERY completion to `channel_reply`, which on github is a plain PR
// comment — fine for most subagents, but wrong for a finished `reviewer`:
// a verdict delivered as a comment leaves the PR "awaiting review" with no
// formal approval. This reminder cannot tell a review turn from any other
// completion, so the carve-out is phrased conditionally ("if this was a PR
// review") to redirect only the review case without misleading the rest.
const GITHUB_REVIEW_NUDGE =
  'If this was a PR review, the verdict is a formal review, not a `channel_reply`: ' +
  'post it via `gh api -X POST /repos/owner/repo/pulls/<N>/reviews` (APPROVE/REQUEST_CHANGES/COMMENT) ' +
  'and end the turn with `skip_response`. A `channel_reply` that merely says "Approved" posts a ' +
  'comment and leaves the PR awaiting review.'

export function renderSubagentCompletionReminder(args: CompletionReminderArgs): string {
  const durationStr = formatReminderDuration(args.durationMs)
  const githubTail = args.channel === true && args.adapter === 'github' ? ` ${GITHUB_REVIEW_NUDGE}` : ''
  const channelTail = args.channel === true ? ` ${CHANNEL_REPLY_NUDGE}${githubTail}` : ''
  if (args.ok) {
    return (
      `<system-reminder>\n` +
      `Subagent \`${args.subagent}\` (${args.taskId}) completed in ${durationStr}. ` +
      `Use subagent_output to fetch the result.${channelTail}\n` +
      `</system-reminder>`
    )
  }
  const err = args.error ?? 'unknown error'
  const recoveryHint =
    args.hasRecoverableOutput === true
      ? `It produced output before failing — call subagent_output to recover it as partial recovery data, not a completed verdict, instead of redoing the work. `
      : `Use subagent_output to inspect. `
  return (
    `<system-reminder>\n` +
    `Subagent \`${args.subagent}\` (${args.taskId}) FAILED after ${durationStr}: ${err}. ` +
    `${recoveryHint}If this work was tracked in your todo list, ` +
    `keep the item pending (or add a recovery item) via todo_write so it is not ` +
    `dropped.${channelTail}\n` +
    `</system-reminder>`
  )
}

export function formatReminderDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}m${sec}s`
}

export type SubagentCompletedChannelKey = {
  adapter: string
  workspace: string
  chat: string
  thread: string | null
}

export type SubagentCompletedPayload = {
  taskId: string
  subagent: string
  parentSessionId: string
  ok: boolean
  durationMs: number
  error?: string
  // A failed subagent can still carry a recoverable result (e.g. a researcher
  // that produced its `<report>` then timed out). The boolean — not the content
  // — rides the broadcast so the reminder can tell the parent to fetch it via
  // subagent_output; the body stays in the registry retrieval path, off the
  // broadcast bus, to keep large/sensitive output out of every subscriber.
  hasRecoverableOutput?: boolean
  // Present when the parent was a channel session. Lets the router fall back
  // to the live successor session for the same channel key when the parent
  // rolled over after 60 minutes idle (SESSION_FRESHNESS_TTL_MS) or was
  // idle-evicted while the subagent ran — otherwise the completion is silently dropped.
  channelKey?: SubagentCompletedChannelKey
}

// Type guard for the `subagent.completed` broadcast payload. Subscribers
// to `target: { kind: 'broadcast' }` see every broadcast; this guard
// filters and narrows in one place so callers don't repeat the
// typeof-checking dance.
export function parseSubagentCompletedPayload(payload: unknown): SubagentCompletedPayload | null {
  if (payload === null || typeof payload !== 'object') return null
  const p = payload as {
    kind?: unknown
    taskId?: unknown
    subagent?: unknown
    parentSessionId?: unknown
    ok?: unknown
    durationMs?: unknown
    error?: unknown
    hasRecoverableOutput?: unknown
    channelKey?: unknown
  }
  if (p.kind !== 'subagent.completed') return null
  if (typeof p.parentSessionId !== 'string') return null
  const channelKey = parseChannelKey(p.channelKey)
  return {
    taskId: typeof p.taskId === 'string' ? p.taskId : '<unknown>',
    subagent: typeof p.subagent === 'string' ? p.subagent : 'subagent',
    parentSessionId: p.parentSessionId,
    ok: p.ok === true,
    durationMs: typeof p.durationMs === 'number' ? p.durationMs : 0,
    ...(typeof p.error === 'string' ? { error: p.error } : {}),
    ...(p.hasRecoverableOutput === true ? { hasRecoverableOutput: true } : {}),
    ...(channelKey !== null ? { channelKey } : {}),
  }
}

function parseChannelKey(value: unknown): SubagentCompletedChannelKey | null {
  if (value === null || typeof value !== 'object') return null
  const k = value as { adapter?: unknown; workspace?: unknown; chat?: unknown; thread?: unknown }
  if (typeof k.adapter !== 'string' || typeof k.workspace !== 'string' || typeof k.chat !== 'string') return null
  if (k.thread !== null && typeof k.thread !== 'string') return null
  return { adapter: k.adapter, workspace: k.workspace, chat: k.chat, thread: k.thread }
}
