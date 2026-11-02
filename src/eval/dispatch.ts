import { validateToolArguments } from '@earendil-works/pi-ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

import type { EvalDispatch } from './cell'
import { EvalError } from './protocol'

// These operations need their own model-visible call: recursion would re-enter
// a busy kernel; orchestration/lifecycle tools can outlive or terminate its
// foreground lease; posting and role changes need an explicit separate action.
// MCP dispatch is excluded because its chosen target is not statically known.
// Ordinary active plugin tools retain their normal wrapped execution path.
const refused = new Set([
  'eval',
  'spawn_subagent',
  'coding_agent',
  'subagent_cancel',
  'channel_send',
  'channel_reply',
  'channel_edit',
  'channel_react',
  'channel_handoff',
  'channel_disengage',
  'post_github_review',
  'skip_response',
  'restart',
  'reload',
  'grant_role',
  'mcp_call',
])

export function createEvalDispatch(options: {
  readonly tools: readonly ToolDefinition[]
  readonly getActiveNames: () => readonly string[]
  readonly context: Parameters<ToolDefinition['execute']>[4]
}): EvalDispatch {
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]))
  return async (request, signal) => {
    signal.throwIfAborted()
    if (refused.has(request.name) || !options.getActiveNames().includes(request.name)) {
      throw new EvalError('refused', `tool "${request.name}" is not active or is not batchable in eval`)
    }
    const tool = tools.get(request.name)
    if (tool === undefined) throw new EvalError('refused', `tool "${request.name}" is unavailable`)
    // Use Pi's direct-call validator, followed by the EXACT post-budget
    // definition supplied to createAgentSession. Never rebuild raw builtins.
    const args = validateToolArguments(tool, {
      type: 'toolCall',
      id: request.callId,
      name: request.name,
      arguments: request.args,
    })
    try {
      return await tool.execute(request.callId, args, signal, undefined, options.context)
    } catch (error) {
      if (request.name === 'grep' && error instanceof Error && error.message.includes('regex parse error')) {
        throw new Error(error.message + GREP_REGEX_HINT, { cause: error })
      }
      throw error
    }
  }
}

// Cells keep failing on patterns like '\(' even with the rules in the tool
// description: inside a JS string literal that is just '(', so rg sees an
// unclosed group. Name the cause where the failure surfaces.
const GREP_REGEX_HINT =
  "\nHint: in a JS string '\\(' is just '(' - write '\\\\(' or String.raw`\\(`, or pass literal: true for plain text. Lookaround is unsupported."
