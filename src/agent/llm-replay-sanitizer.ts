// Defensive projection applied to the LLM message array right before each
// provider call, layered on top of pi-coding-agent's `convertToLlm`. It exists
// to un-wedge sessions whose persisted transcript contains a `toolResult` with
// no live preceding `toolCall` — the exact shape Anthropic rejects with
// "unexpected `tool_use_id` found in `tool_result` blocks" (HTTP 400).
//
// How a transcript gets poisoned: the self-`restart` tool exits the container
// mid-turn. The assistant turn carrying the restart `toolCall` can land in the
// JSONL with `stopReason: "error"/"aborted"` (or be torn down), while its
// `toolResult` is persisted. On replay, pi-ai's provider-side `transformMessages`
// DROPS error/aborted assistant turns but passes the `toolResult` through
// unchanged, leaving a true orphan that the API rejects on every subsequent
// turn — the session is permanently stuck.
//
// pi-ai's `transformMessages` already handles the inverse cases (a `toolCall`
// with no result → synthetic "No result provided" result; error/aborted
// assistant turns → dropped). The one gap is an orphaned `toolResult`. This
// sanitizer fills exactly that gap and nothing more.
//
// Invariant (local pending-window, NOT a global id union — Anthropic requires
// tool results to belong to the immediately preceding tool-use turn):
//   1. Assistant turns with stopReason "error"/"aborted" are dropped here, so
//      orphan detection sees the same message set the provider will after its
//      own drop pass. Without this, a result tied to a dropped assistant would
//      survive us and be orphaned downstream — the original bug.
//   2. A `toolResult` is kept only if its `toolCallId` was declared by the most
//      recent kept assistant tool-use turn AND has not already been emitted in
//      that window. Any user or assistant message closes the window.
//   3. Missing results are NOT synthesized here — pi-ai's existing pass inserts
//      the synthetic placeholder, so dropping an orphan that leaves a bare
//      `toolCall` is safe and self-healing.
//
// This is a read-only projection: it never mutates the persisted JSONL, so an
// already-poisoned session becomes usable without destructive migration.

import type { Message } from '@earendil-works/pi-ai'

export type ReplaySanitizerStats = {
  droppedOrphans: number
  droppedDuplicates: number
  droppedErrorAssistants: number
}

export type SanitizeResult = {
  messages: Message[]
  stats: ReplaySanitizerStats
}

function isErroredAssistant(message: Message): boolean {
  return message.role === 'assistant' && (message.stopReason === 'error' || message.stopReason === 'aborted')
}

function toolCallIdsOf(message: Extract<Message, { role: 'assistant' }>): string[] {
  return message.content
    .filter((block): block is Extract<typeof block, { type: 'toolCall' }> => block.type === 'toolCall')
    .map((block) => block.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

export function sanitizeMessagesForLlmReplay(messages: Message[]): SanitizeResult {
  const output: Message[] = []
  const stats: ReplaySanitizerStats = {
    droppedOrphans: 0,
    droppedDuplicates: 0,
    droppedErrorAssistants: 0,
  }

  let pendingToolCallIds = new Set<string>()
  let emittedResultIds = new Set<string>()

  const closeWindow = () => {
    pendingToolCallIds = new Set()
    emittedResultIds = new Set()
  }

  for (const message of messages) {
    if (message.role === 'assistant') {
      closeWindow()

      // Mirror pi-ai's provider-side drop of incomplete turns so orphan
      // detection matches the message set the provider will actually send.
      if (isErroredAssistant(message)) {
        stats.droppedErrorAssistants += 1
        continue
      }

      const callIds = toolCallIdsOf(message)
      if (callIds.length > 0) pendingToolCallIds = new Set(callIds)
      output.push(message)
      continue
    }

    if (message.role === 'user') {
      closeWindow()
      output.push(message)
      continue
    }

    if (message.role === 'toolResult') {
      const id = message.toolCallId
      if (!pendingToolCallIds.has(id)) {
        // Orphan: true orphan, stale late result, or result for a dropped
        // error/aborted assistant turn.
        stats.droppedOrphans += 1
        continue
      }
      if (emittedResultIds.has(id)) {
        stats.droppedDuplicates += 1
        continue
      }
      emittedResultIds.add(id)
      output.push(message)
      continue
    }

    output.push(message)
  }

  return { messages: output, stats }
}
