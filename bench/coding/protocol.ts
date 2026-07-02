// Duplicated from src/shared/protocol.ts (not imported) to keep bench/ a
// self-contained sibling with no compile coupling to src/, mirroring docs/.

export type BenchClientMessage = { type: 'prompt'; text: string } | { type: 'abort' }

export type BenchUsage = {
  input: number
  output: number
  totalTokens: number
  cost: number
}

export type BenchToolCall = {
  toolCallId: string
  name: string
  args: unknown
  result?: unknown
  isError?: boolean
  durationMs?: number
}

export type BenchServerMessage =
  | { type: 'connected'; sessionId: string; serverVersion?: string }
  | { type: 'prompt_started'; messageId: string; text: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; name: string; error: boolean; result: unknown; durationMs: number }
  | { type: 'done'; usage?: BenchUsage }
  | { type: 'error'; message: string }
  | { type: 'queue_state'; pending: { id: string; text: string; ts: number }[] }
  | { type: string; [key: string]: unknown }

export function isServerMessage(value: unknown): value is BenchServerMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}
