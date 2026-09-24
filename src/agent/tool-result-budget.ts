import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { TSchema } from 'typebox'

// Subagents that read large files (memory-logger and dreaming each read parent
// session transcripts that can run hundreds of KB) are vulnerable to a class
// of bug where a single tool malfunction — a broken `find_entry`, a missing
// watermark, a transcript that no longer contains the watermark id — causes
// the agent to fall back to scanning the file in 50KB chunks. Every chunk
// stays in the subagent's conversation history and gets re-sent to the model
// on every turn until the subagent stops, so a 1MB transcript can balloon a
// memory-logger run from ~10K input tokens to several hundred thousand.
//
// The budget here is a fail-safe ceiling on the total bytes of tool-result
// text a subagent run is allowed to accumulate from a chosen set of tools.
// Once exhausted, subsequent calls to those tools short-circuit with a
// constant-size message that tells the agent to advance the watermark to the
// latest entry and exit. The budget is per-run (one BudgetState per session)
// and tracked only for the named tools; tools like `append` (which write,
// not read) are unaffected.

export type ToolResultBudget = {
  maxTotalBytes: number
  toolNames: readonly string[]
  exhaustedMessage?: (used: number, max: number) => string
}

export type BudgetState = {
  used: number
  exhausted: boolean
}

export function createBudgetState(): BudgetState {
  return { used: 0, exhausted: false }
}

function defaultExhaustedMessage(used: number, max: number): string {
  const usedKb = Math.round(used / 1024)
  const maxKb = Math.round(max / 1024)
  return [
    `[tool-result budget exhausted: used ${usedKb}KB of ${maxKb}KB this run]`,
    '',
    'Stop reading. This session has consumed its byte budget across calls to',
    'this tool. Do not call this tool again. Stop and exit; future runs will',
    'continue from wherever your normal end-of-run bookkeeping left off.',
  ].join('\n')
}

function bytesOfContent(content: { type: string; text?: string }[] | undefined): number {
  if (!content) return 0
  let total = 0
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      total += Buffer.byteLength(part.text, 'utf8')
    }
  }
  return total
}

function buildExhaustedResult(budget: ToolResultBudget, state: BudgetState) {
  const text = (budget.exhaustedMessage ?? defaultExhaustedMessage)(state.used, budget.maxTotalBytes)
  return {
    content: [{ type: 'text' as const, text }],
    details: { budgetExhausted: true, used: state.used, max: budget.maxTotalBytes },
  }
}

// Wraps an AgentTool's execute so that returned text content is counted against
// `state` and the tool short-circuits once `budget.maxTotalBytes` is exceeded.
// Tools whose name is not in `budget.toolNames` are returned unchanged so the
// caller can pass an entire `tools` array through and only the tracked tools
// are affected. The original tool object is preserved by spreading; only
// `execute` is replaced.
export function wrapAgentToolWithBudget<TParams extends TSchema, TDetails = unknown>(
  tool: AgentTool<TParams, TDetails>,
  budget: ToolResultBudget,
  state: BudgetState,
): AgentTool<TParams, TDetails> {
  if (!budget.toolNames.includes(tool.name)) return tool
  const originalExecute = tool.execute.bind(tool)
  return {
    ...tool,
    async execute(toolCallId, args, signal, onUpdate) {
      if (state.exhausted) {
        return buildExhaustedResult(budget, state) as Awaited<ReturnType<typeof originalExecute>>
      }
      const result = await originalExecute(toolCallId, args, signal, onUpdate)
      state.used += bytesOfContent(result.content as { type: string; text?: string }[] | undefined)
      if (state.used >= budget.maxTotalBytes) {
        state.exhausted = true
      }
      return result
    },
  }
}

// Same wrapper for ToolDefinition (the customTools surface). Identical
// semantics; ToolDefinition's execute has an extra `onUpdate` callback and a
// `ctx` argument that we forward verbatim.
export function wrapToolDefinitionWithBudget<TParams extends TSchema, TDetails = unknown, TState = unknown>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  budget: ToolResultBudget,
  state: BudgetState,
): ToolDefinition<TParams, TDetails, TState> {
  if (!budget.toolNames.includes(tool.name)) return tool
  const originalExecute = tool.execute.bind(tool)
  return {
    ...tool,
    async execute(toolCallId, args, signal, onUpdate, ctx) {
      if (state.exhausted) {
        return buildExhaustedResult(budget, state) as Awaited<ReturnType<typeof originalExecute>>
      }
      const result = await originalExecute(toolCallId, args, signal, onUpdate, ctx)
      state.used += bytesOfContent(result.content as { type: string; text?: string }[] | undefined)
      if (state.used >= budget.maxTotalBytes) {
        state.exhausted = true
      }
      return result
    },
  }
}
