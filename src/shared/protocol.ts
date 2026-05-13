export type ReloadResultPayload =
  | { scope: string; ok: true; summary: string; details?: unknown }
  | { scope: string; ok: false; reason: string }

export type PromptDelivery = 'queue' | 'steer' | 'interrupt'

export type DoctorRequestId = string

export type DoctorCheckPayload = {
  id: string
  pluginName: string
  checkName: string
  description: string
  category: string
  status: 'ok' | 'warning' | 'error' | 'info'
  message: string
  details?: string[]
  fix?: { description: string; hasApply: boolean }
}

export type DoctorFixPayload =
  | { ok: true; checkId: string; summary: string; changedPaths: string[] }
  | { ok: false; checkId: string; error: string }

export type ClientMessage =
  | { type: 'prompt'; text: string; delivery?: PromptDelivery }
  | { type: 'reload'; scope?: string }
  | { type: 'abort' }
  | { type: 'queue_cancel'; messageId: string }
  | { type: 'doctor'; requestId: DoctorRequestId }
  | { type: 'doctor_fix'; requestId: DoctorRequestId; checkId: string }

export type QueueStateItem = { id: string; text: string; ts: number }

export type ServerMessage =
  | { type: 'connected'; sessionId: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool_end'; toolCallId: string; name: string; error: boolean; result: unknown; durationMs: number }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'reload_result'; results: ReloadResultPayload[] }
  | { type: 'notification'; payload: unknown; replyTo?: string; meta?: Record<string, string> }
  | { type: 'queue_state'; pending: QueueStateItem[] }
  | { type: 'prompt_started'; messageId: string; text: string }
  | { type: 'doctor_result'; requestId: DoctorRequestId; checks: DoctorCheckPayload[]; error?: string }
  | { type: 'doctor_fix_result'; requestId: DoctorRequestId; result: DoctorFixPayload }
