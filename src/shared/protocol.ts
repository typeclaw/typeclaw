export type ReloadResultPayload =
  | { scope: string; ok: true; summary: string; details?: unknown }
  | { scope: string; ok: false; reason: string }

// Structurally mirrors ReloadCause in src/reload/types.ts. Kept as its own
// declaration so the wire protocol stays free of subsystem imports, the same
// way ReloadResultPayload mirrors ReloadResult.
export type ReloadCausePayload = { kind: 'credential-rotation'; adapter: string }

export type PromptDelivery = 'queue' | 'steer' | 'interrupt'

export type DoctorRequestId = string

export type DoctorCheckPayload = {
  id: string
  pluginName: string
  checkName: string
  description: string
  category: string
  status: 'ok' | 'warning' | 'error'
  message: string
  details?: string[]
  fix?: { description: string; hasApply: boolean }
}

export type DoctorFixPayload =
  | { ok: true; checkId: string; summary: string; changedPaths: string[] }
  | { ok: false; checkId: string; error: string }

export type ClaimRoleChoice = 'owner' | 'member' | 'trusted' | (string & {})

export type TunnelRequestId = string

export type TunnelSnapshot = {
  name: string
  provider: 'external' | 'cloudflare-quick' | 'cloudflare-named'
  for: { kind: 'channel'; name: string } | { kind: 'manual' }
  url: string | null
  status: 'stopped' | 'starting' | 'healthy' | 'unhealthy' | 'permanently-failed'
  lastUrlAt: number | null
  detail: string
}

export type TunnelLogsClientMessage = { type: 'subscribe'; name: string; follow: boolean }

export type TunnelLogsServerMessage =
  | { type: 'snapshot'; lines: string[] }
  | { type: 'line'; line: string }
  | { type: 'error'; message: string }
  | { type: 'end' }

export type InspectClientMessage =
  | {
      type: 'subscribe'
      sessionId: string
      // sinceMs is a wall-clock cutoff for backfilling broadcasts from the
      // in-process Stream ring buffer. The client uses Date.now() - duration;
      // omit to skip broadcast backfill. AgentSession events are NEVER
      // backfilled (the session's pi-coding-agent subscribe API delivers
      // future events only).
      sinceMs?: number
    }
  // Steady-state liveness probe echoed back as a pong. A live tail is
  // legitimately quiet for long stretches, so absence of inbound frames cannot
  // distinguish "idle" from "dead"; a missed pong can. Guards a wedged
  // WebSocket that stays ESTABLISHED yet never fires 'close'/'error'.
  | { type: 'ping'; id: number }
  // One-shot query for sessions live in the container's registry but not yet on
  // disk (pi-coding-agent defers the first .jsonl write to the first assistant
  // message). Lets the host-stage inspect picker show in-flight sessions before
  // their reply lands. Answered with a single `live_sessions` reply.
  | { type: 'list_live' }

// Wire mirror of MinimalSessionOrigin (@/agent/session-meta). Duplicated rather
// than imported because @/shared is a leaf module — @/agent depends on it, so
// importing back would create a cycle. A compile-time assertion in session-meta
// keeps the two structurally in sync; drift fails typecheck.
export type LiveSessionOriginPayload =
  | { kind: 'tui' }
  | { kind: 'cron'; jobId: string; jobKind: 'prompt' | 'exec' | 'subagent' | 'handler' | 'watch' }
  | {
      kind: 'channel'
      adapter: string
      workspace: string
      workspaceName?: string
      chat: string
      chatName?: string
      thread: string | null
    }
  | { kind: 'subagent'; subagent: string; parentSessionId: string }
  | { kind: 'system'; component: string }

export type LiveSessionPayload = {
  sessionId: string
  origin: LiveSessionOriginPayload
  registeredAtMs: number
}

export type InspectFramePayload =
  | { kind: 'text_delta'; sessionId: string; delta: string }
  // Reasoning trace from the model, streamed as deltas like text. `thinking_end`
  // closes a thinking block; `text` is the joined deltas (empty when redacted).
  // `redacted: true` means the upstream provider hid the content behind a
  // safety filter and only the opaque continuation payload survives.
  | { kind: 'thinking_delta'; sessionId: string; delta: string }
  | { kind: 'thinking_end'; sessionId: string; text: string; redacted?: boolean }
  | { kind: 'tool_start'; sessionId: string; toolCallId: string; name: string; args: unknown }
  | {
      kind: 'tool_end'
      sessionId: string
      toolCallId: string
      name: string
      result: unknown
      isError: boolean
      durationMs: number
    }
  | {
      kind: 'message_end'
      sessionId: string
      role: string
      content: unknown
      provider?: string
      model?: string
      stopReason?: string
      errorMessage?: string
      usage?: {
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
        totalTokens: number
        cost: number
      }
    }
  | { kind: 'broadcast'; payload: unknown; meta?: Record<string, string> }
  | { kind: 'cron-fire'; jobId: string; payload: unknown }
  // Channel inbound message observed by the router. Surfaced regardless
  // of the engagement decision so inspect can show what the agent saw,
  // not just what it chose to act on. `decision` mirrors the router's
  // EngagementDecision plus 'denied' (channel.respond gate) and 'claim'
  // (role-claim intercept) for completeness. `text` is the raw inbound
  // text — no batching, no compose-prompt wrapping.
  | {
      kind: 'channel_inbound'
      // Channel session this inbound belongs to. Absent for denied/claim
      // intercepts that fire before a session exists. The inspect server drops
      // frames whose sessionId does not match the watched session.
      sessionId?: string
      adapter: string
      workspace: string
      chat: string
      thread: string | null
      authorId: string
      authorName: string
      authorIsBot: boolean
      isDm: boolean
      isBotMention: boolean
      text: string
      externalMessageId: string
      // 0 = platform timestamp unknown; the renderer uses the frame's
      // wall-clock ts instead.
      ts: number
      decision: 'engage' | 'observe' | 'denied' | 'claim'
    }

export type InspectServerMessage =
  // supportsPing is the heartbeat capability flag. A pre-heartbeat server omits
  // it; the client must treat its absence as "no ping support" and never send a
  // ping (an old server answers an unknown ping with an error + close, killing
  // the tail). Strict opt-in: only an explicit true arms round-trip probing.
  | { type: 'subscribed'; sessionId: string; sessionLive: boolean; supportsPing?: true }
  | { type: 'frame'; ts: number; payload: InspectFramePayload }
  | { type: 'error'; message: string }
  | { type: 'pong'; id: number }
  | { type: 'live_sessions'; sessions: LiveSessionPayload[] }

export type ClientMessage =
  | { type: 'prompt'; text: string; delivery?: PromptDelivery }
  | { type: 'reload'; scope?: string; cause?: ReloadCausePayload }
  | { type: 'restart' }
  | { type: 'abort' }
  | { type: 'queue_cancel'; messageId: string }
  | { type: 'doctor'; requestId: DoctorRequestId }
  | { type: 'doctor_fix'; requestId: DoctorRequestId; checkId: string }
  | { type: 'cron_list'; requestId: CronListRequestId }
  | { type: 'tunnel_list_request'; requestId: TunnelRequestId }
  | { type: 'tunnel_status_request'; requestId: TunnelRequestId; name: string }
  | { type: 'claim_start'; code: string; role: ClaimRoleChoice; channel?: string; ttlMs: number }
  | { type: 'claim_cancel' }
  | {
      type: 'exec_command'
      callId: string
      name: string
      args: unknown
      isolated?: boolean
      // Parent origin to stamp as spawnedByOrigin on the command's session.
      // When unset, the runner stamps a synthetic TUI origin (host CLI
      // operator). When set, the runner trusts the JSON verbatim as a
      // SessionOrigin (e.g. cron-shaped, carrying scheduledByRole).
      // Permission resolution chases through to the parent origin's role.
      parentOriginJson?: string
    }
  | { type: 'command_stdin'; callId: string; chunk: string }
  | { type: 'command_stdin_end'; callId: string }
  | { type: 'command_abort'; callId: string; reason: string }

export type CronListRequestId = string

export type CronListSourcePayload = { kind: 'user' } | { kind: 'plugin'; pluginName: string; localId: string }

export type CronListEntryPayload = {
  id: string
  source: CronListSourcePayload
  kind: 'prompt' | 'exec' | 'handler'
  schedule?: string
  at?: string
  until?: string
  count?: number
  timezone?: string
  enabled: boolean
  scheduledByRole?: string
  nextFireMs: number | null
  scheduleError?: string
  prompt?: string
  subagent?: string
  command?: readonly string[]
}

export type CronListResultPayload =
  | { ok: true; jobs: CronListEntryPayload[]; nowMs: number }
  | { ok: false; reason: string }

export type QueueStateItem = { id: string; text: string; ts: number }

export type ClaimStartedPayload = {
  code: string
  role: string
  channel?: string
  expiresAt: number
}

export type ClaimCompletedPayload = {
  code: string
  role: string
  matchRule: string
  adapter: string
  authorId: string
}

export type ClaimErrorPayload = {
  code: string
  reason: string
}

// `ts` (ms since epoch) is the server send time, stamped centrally in `send()`,
// for the variants the TUI renders into scrollback. Optional on the wire so an
// old CLI parses a new server's frames; control frames the TUI never timestamps
// (queue_state, doctor, tunnel, claim, command_*) omit it by design.
export type ServerMessage =
  // serverVersion is optional so an old CLI talking to a new server still
  // parses cleanly. The server impl always emits it; consumers that care
  // about host/agent skew (the TUI command in particular) read it to warn
  // the user when their CLI is on a different version than the container.
  | { type: 'connected'; sessionId: string; serverVersion?: string }
  | { type: 'text_delta'; delta: string; ts?: number }
  | { type: 'tool_start'; toolCallId: string; name: string; args: unknown; ts?: number }
  | {
      type: 'tool_end'
      toolCallId: string
      name: string
      error: boolean
      result: unknown
      durationMs: number
      ts?: number
    }
  | { type: 'done'; ts?: number; usage?: { input: number; output: number; totalTokens: number; cost: number } }
  | { type: 'error'; message: string; ts?: number }
  | { type: 'reload_result'; results: ReloadResultPayload[] }
  | { type: 'restart_result'; status: 'accepted' | 'failed'; message?: string; error?: string }
  | { type: 'notification'; payload: unknown; replyTo?: string; meta?: Record<string, string> }
  | { type: 'queue_state'; pending: QueueStateItem[] }
  | { type: 'prompt_started'; messageId: string; text: string; ts?: number }
  | { type: 'doctor_result'; requestId: DoctorRequestId; checks: DoctorCheckPayload[] }
  | { type: 'doctor_fix_result'; requestId: DoctorRequestId; result: DoctorFixPayload }
  | { type: 'cron_list_result'; requestId: CronListRequestId; result: CronListResultPayload }
  | ({ type: 'tunnel_list_response'; requestId: TunnelRequestId } & (
      | { ok: true; tunnels: TunnelSnapshot[] }
      | { ok: false; error: string }
    ))
  | ({ type: 'tunnel_status_response'; requestId: TunnelRequestId } & (
      | { ok: true; tunnel: TunnelSnapshot }
      | { ok: false; error: string }
    ))
  | { type: 'claim_started'; payload: ClaimStartedPayload }
  | { type: 'claim_completed'; payload: ClaimCompletedPayload }
  | { type: 'claim_error'; payload: ClaimErrorPayload }
  | { type: 'command_stdout'; callId: string; chunk: string }
  | { type: 'command_stderr'; callId: string; chunk: string }
  | { type: 'command_exit'; callId: string; code: number }
  | { type: 'command_error'; callId: string; message: string }
