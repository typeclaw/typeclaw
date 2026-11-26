const SLACK_API_BASE = 'https://slack.com/api'

// Declaring a Slack app as an agent (manifest `features.agent_view`) grants
// this scope; it is what makes Slack label the bot AGENT instead of APP.
export const SLACK_AGENT_SCOPE = 'assistant:write'

export type SlackAgentSessionStatus = 'processing' | 'active'

// Status calls sit on the typing FIFO that outbound sends await, and the probe
// sits on adapter start, so a stalled Slack request must not hold either. The
// signal also bounds the response body read.
export const SLACK_AGENT_REQUEST_TIMEOUT_MS = 5_000

// Slack reports granted scopes only in auth.test's `X-OAuth-Scopes` response
// header, which the agent-messenger SDK drops, so probe auth.test directly.
export async function fetchSlackAgentMode(
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs = SLACK_AGENT_REQUEST_TIMEOUT_MS,
): Promise<boolean> {
  const response = await fetchImpl(`${SLACK_API_BASE}/auth.test`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  await response.body?.cancel()
  const scopes = response.headers.get('x-oauth-scopes') ?? ''
  return scopes.split(',').some((scope) => scope.trim() === SLACK_AGENT_SCOPE)
}

// Unlike `assistant.threads.setStatus`, a session does not clear itself when
// the bot posts: it stays `processing` (with Slack's "Working…" UX) until the
// app sets `active` or Slack's one-hour timeout fires.
export async function setSlackAgentSessionStatus(
  token: string,
  fetchImpl: typeof fetch,
  args: { chat: string; threadTs: string; status: SlackAgentSessionStatus },
  timeoutMs = SLACK_AGENT_REQUEST_TIMEOUT_MS,
): Promise<void> {
  await postSlackStatus(token, fetchImpl, 'agents.sessions.setStatus', args, timeoutMs)
}

// The agent-mode fallback when Slack refuses the session call. It bypasses the
// SDK's `setAssistantStatus`, which has no request deadline, so the fallback
// stays as bounded as the session call it replaces.
export async function setSlackAssistantStatus(
  token: string,
  fetchImpl: typeof fetch,
  args: { chat: string; threadTs: string; status: string },
  timeoutMs = SLACK_AGENT_REQUEST_TIMEOUT_MS,
): Promise<void> {
  await postSlackStatus(token, fetchImpl, 'assistant.threads.setStatus', args, timeoutMs)
}

async function postSlackStatus(
  token: string,
  fetchImpl: typeof fetch,
  method: string,
  args: { chat: string; threadTs: string; status: string },
  timeoutMs: number,
): Promise<void> {
  const response = await fetchImpl(`${SLACK_API_BASE}/${method}`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body: new URLSearchParams({ channel_id: args.chat, thread_ts: args.threadTs, status: args.status }).toString(),
  })
  const raw = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string }
  if (raw.ok !== true) throw new Error(raw.error ?? `${method} HTTP ${response.status}`)
}
