import type { SlackSocketModeSlashCommandArgs } from 'agent-messenger/slackbot'

import type { ExecuteCommandResult } from '@/channels/router'
import type { ChannelKey } from '@/channels/types'

// Slack channel ids: 'C' = public, 'G' = private/legacy multi-party DM,
// 'D' = direct message. Slash-command payloads don't carry `channel_type`,
// so we read the id prefix directly. The slack-bot inbound classifier uses
// `event.channel_type === 'im'` for the same purpose, but that field isn't
// in the slash-command body. Group DMs ('G' prefix) are NOT treated as DMs
// here — they map to `workspace: team_id` like a regular channel, matching
// how the inbound classifier handles MPIM messages (channel_type 'mpim'
// is not 'im' and therefore falls through to the team workspace branch).
const SLACK_DM_CHANNEL_PREFIXES: readonly string[] = ['D']

export type ParsedSlackSlashCommand = {
  name: string
  key: ChannelKey
  invokerId: string
}

export type ParseSlashCommandResult =
  | { kind: 'parsed'; command: ParsedSlackSlashCommand }
  | { kind: 'ignore'; reason: 'unknown-command' | 'no-invoker' | 'no-channel' | 'no-team' | 'malformed' }

export function parseSlashCommand(
  body: SlackSocketModeSlashCommandArgs['body'],
  knownCommands: ReadonlySet<string>,
): ParseSlashCommandResult {
  if (typeof body.command !== 'string' || !body.command.startsWith('/')) {
    return { kind: 'ignore', reason: 'malformed' }
  }
  const name = body.command.slice(1).toLowerCase()
  if (name === '' || !knownCommands.has(name)) {
    return { kind: 'ignore', reason: 'unknown-command' }
  }
  if (typeof body.user_id !== 'string' || body.user_id === '') {
    return { kind: 'ignore', reason: 'no-invoker' }
  }
  if (typeof body.channel_id !== 'string' || body.channel_id === '') {
    return { kind: 'ignore', reason: 'no-channel' }
  }
  // team_id is required for slash commands per Slack's API, but defensively
  // refuse to construct a ChannelKey without it — otherwise the workspace
  // field would collide with a real workspace id named '' downstream.
  if (typeof body.team_id !== 'string' || body.team_id === '') {
    return { kind: 'ignore', reason: 'no-team' }
  }

  const isDm = SLACK_DM_CHANNEL_PREFIXES.some((prefix) => body.channel_id.startsWith(prefix))
  const workspace = isDm ? '@dm' : body.team_id

  return {
    kind: 'parsed',
    command: {
      name,
      // thread is null because Slack slash commands cannot be invoked from
      // inside a thread — Slack's compose box always targets the top-level
      // channel. The router's executeCommand falls back to any live session
      // in the same workspace+chat when an exact key match misses, so a
      // thread-keyed live session still gets hit by a thread-less slash.
      key: { adapter: 'slack-bot', workspace, chat: body.channel_id, thread: null },
      invokerId: body.user_id,
    },
  }
}

// Slack blocks native slash commands inside threads ("/stop is not supported
// in threads. Sorry!"), so the only way to abort a thread-scoped turn from
// inside that thread is a normal message. We recognise a leading `!` as an
// alternate command prefix and route it through the same router.executeCommand
// path as native slashes. The guard is strict: only a first token that resolves
// to a known command name is rewritten, so casual messages like "!nice work"
// pass through untouched as regular agent input.
//
// Unlike native slash payloads (which never carry a thread and rely on the
// router's workspace+chat fallback), a thread message carries `thread_ts`,
// letting us target the exact thread session and skip the ambiguous-match case
// entirely.
export const THREAD_COMMAND_PREFIX = '!'

export type ThreadCommandInput = {
  text: string
  channel: string
  threadTs: string | null
  isDm: boolean
  teamId: string
  invokerId: string
}

export type ParseThreadCommandResult =
  | { kind: 'parsed'; command: ParsedSlackSlashCommand }
  | { kind: 'ignore'; reason: 'no-prefix' | 'unknown-command' }

// Both ignore reasons (`no-prefix`, `unknown-command`) are non-fatal: the
// caller lets the message flow through as ordinary agent input.
export function parseThreadCommand(
  input: ThreadCommandInput,
  knownCommands: ReadonlySet<string>,
): ParseThreadCommandResult {
  const trimmed = input.text.trimStart()
  if (!trimmed.startsWith(THREAD_COMMAND_PREFIX)) {
    return { kind: 'ignore', reason: 'no-prefix' }
  }
  const firstToken = trimmed.slice(THREAD_COMMAND_PREFIX.length).split(/\s/, 1)[0] ?? ''
  const name = firstToken.toLowerCase()
  if (name === '' || !knownCommands.has(name)) {
    return { kind: 'ignore', reason: 'unknown-command' }
  }

  const workspace = input.isDm ? '@dm' : input.teamId
  return {
    kind: 'parsed',
    command: {
      name,
      key: { adapter: 'slack-bot', workspace, chat: input.channel, thread: input.threadTs },
      invokerId: input.invokerId,
    },
  }
}

// A click on Slack's native agent stop button (`agent_session_stopped`); the
// clicker is the invoker the /stop permission gate checks. In a channel the
// event names the exact session thread, so it targets that thread like
// `!stop`. A DM is one flat session whose status is anchored on a message ts,
// so a DM click keys on the conversation (`thread: null`) and the router
// resolves the DM's live session, refusing if several are live.
export function parseAgentSessionStopped(
  event: Readonly<Record<string, unknown>>,
  teamId: string,
): ParsedSlackSlashCommand | null {
  const { channel, thread_ts: threadTs, user } = event
  if (typeof user !== 'string' || user === '') return null
  if (typeof channel !== 'string' || channel === '') return null
  if (typeof threadTs !== 'string' || threadTs === '') return null
  const isDm = SLACK_DM_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix))
  return {
    name: 'stop',
    key: isDm
      ? { adapter: 'slack-bot', workspace: '@dm', chat: channel, thread: null }
      : { adapter: 'slack-bot', workspace: teamId, chat: channel, thread: threadTs },
    invokerId: user,
  }
}

export const SLACK_SLASH_REPLY_ABORTED = 'Stopped the current turn.'
export const SLACK_SLASH_REPLY_NO_LIVE_SESSION = 'Nothing to stop — no active turn in this channel.'
export const SLACK_SLASH_REPLY_FAILED = 'Could not stop the current turn (internal error).'
export const SLACK_SLASH_REPLY_PERMISSION_DENIED =
  'You do not have permission to stop the current turn in this channel.'
// Native slash commands cannot be invoked from a thread, so the only way to
// disambiguate is the `!stop` thread-message fallback — advise that, not the
// impossible `/stop`-in-thread.
export const SLACK_SLASH_REPLY_AMBIGUOUS =
  'Multiple active turns in this channel. Reply `!stop` inside the specific thread you want to stop.'

// Single outcome→reply mapping shared by the native-slash (ack payload) and
// `!cmd` thread (postMessage) delivery paths so the two never drift.
export function commandResultReply(result: ExecuteCommandResult): string {
  switch (result.kind) {
    case 'handled':
      // Dynamic commands (e.g. /help) carry their own reply; static control
      // commands (/stop) leave it undefined and fall back to the fixed string.
      return result.reply ?? SLACK_SLASH_REPLY_ABORTED
    case 'no-live-session':
      return SLACK_SLASH_REPLY_NO_LIVE_SESSION
    case 'permission-denied':
      return SLACK_SLASH_REPLY_PERMISSION_DENIED
    case 'ambiguous':
      return SLACK_SLASH_REPLY_AMBIGUOUS
    case 'unknown-command':
      return SLACK_SLASH_REPLY_FAILED
  }
}

// Slack's ack callback accepts an optional response payload that becomes
// the user-visible reply. `response_type: 'ephemeral'` keeps the reply
// visible only to the invoker (vs. 'in_channel' which posts to everyone).
// Control gestures should stay ephemeral — same rationale as Discord's
// EPHEMERAL flag on interaction callbacks.
export type SlashAckPayload = { response_type: 'ephemeral'; text: string }

export function buildSlashAckPayload(text: string): SlashAckPayload {
  return { response_type: 'ephemeral', text }
}
