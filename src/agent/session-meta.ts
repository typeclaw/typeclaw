import type { LiveSessionOriginPayload } from '@/shared'

import type { SessionOrigin } from './session-origin'

// Bidirectional structural equality with the wire mirror in @/shared/protocol.
// @/shared cannot import this module (it is a leaf), so the type cannot be
// shared directly; these assignments fail typecheck if either side drifts.
const _originIsWireCompatible: LiveSessionOriginPayload = null as unknown as MinimalSessionOrigin
const _wireIsOriginCompatible: MinimalSessionOrigin = null as unknown as LiveSessionOriginPayload
void _originIsWireCompatible
void _wireIsOriginCompatible

export const SESSION_META_CUSTOM_TYPE = 'typeclaw.session-meta'

export type SessionMetaPayload = {
  origin: MinimalSessionOrigin
}

export type MinimalSessionOrigin =
  | { kind: 'tui' }
  | Pick<Extract<SessionOrigin, { kind: 'cron' }>, 'kind' | 'jobId' | 'jobKind'>
  | {
      kind: 'channel'
      adapter: string
      workspace: string
      // Optional human-readable names persisted alongside IDs so offline
      // tooling (`typeclaw inspect`, future report commands) can render
      // sessions as `Slack acme-corp/#general` instead of bare IDs without
      // re-querying the adapter at runtime. Workspace/chat NAMES are not
      // secrets — they are visible to any participant — and they are
      // stable across reopens, so the tradeoff is one-time write cost for
      // permanent offline readability. Author handles, participant lists,
      // and membership counts remain dropped (those carry author identity
      // and would land in `sessions/`'s auto-backup git history).
      workspaceName?: string
      chat: string
      chatName?: string
      thread: string | null
    }
  | { kind: 'subagent'; subagent: string; parentSessionId: string }
  | { kind: 'system'; component: string }

// Reduce a full SessionOrigin to the minimum projection persisted to disk.
// Drops participant lists, membership counts, recursive provenance (including
// the system origin's `triggeredBy`, which can carry channel author identity),
// and author identifiers — none of which `typeclaw usage` reads, and all of
// which would otherwise land in git history when sessions/ is auto-backed-up.
// Kept as a separate function so the boundary between "data the LLM sees in
// the system prompt" (full origin) and "data persisted for usage reporting"
// (this projection) stays explicit.
export function sessionMetaPayload(origin: SessionOrigin): SessionMetaPayload {
  return { origin: minimalOrigin(origin) }
}

function minimalOrigin(origin: SessionOrigin): MinimalSessionOrigin {
  switch (origin.kind) {
    case 'tui':
      return { kind: 'tui' }
    case 'cron':
      return { kind: 'cron', jobId: origin.jobId, jobKind: origin.jobKind }
    case 'channel':
      return {
        kind: 'channel',
        adapter: origin.adapter,
        workspace: origin.workspace,
        ...(origin.workspaceName !== undefined ? { workspaceName: origin.workspaceName } : {}),
        chat: origin.chat,
        ...(origin.chatName !== undefined ? { chatName: origin.chatName } : {}),
        thread: origin.thread,
      }
    case 'subagent':
      return { kind: 'subagent', subagent: origin.subagent, parentSessionId: origin.parentSessionId }
    case 'system':
      return { kind: 'system', component: origin.component }
  }
}
