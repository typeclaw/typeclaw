import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { z } from 'zod'

import type { WrapSystemToolOptions } from '@/agent/plugin-tools'
import { wrapSystemTool } from '@/agent/plugin-tools'
import { wrapToolDefinitionWithBudget, type BudgetState, type ToolResultBudget } from '@/agent/tool-result-budget'
import { noopPermissionService } from '@/permissions/permissions'

import { evalEnabledForSession, type evalConfigSchema } from './config'
import { createEvalDispatch } from './dispatch'
import { EVAL_LIMITS, EvalError } from './protocol'
import { createSandboxedEvalKernel } from './sandbox'

export const EVAL_PROMPT_HINT =
  'Use eval for independent tool batches and local filtering: await parallel([() => tool.read({...}), () => tool.grep({...})]); print(selected). ' +
  'JavaScript bindings persist in this session until idle expiry, authority changes, or kernel failure. ' +
  'Only printed/displayed output is returned. Await all work; no background cells, install helpers, or Python cells.'

export function registerEvalTool(options: {
  readonly settings: z.infer<typeof evalConfigSchema>
  readonly tools: ToolDefinition[]
  readonly activeNames: string[]
  readonly getActiveNames: () => readonly string[]
  readonly wrappers: WrapSystemToolOptions
  readonly budget?: ToolResultBudget
  readonly budgetState?: BudgetState
}): { dispose(): Promise<void> } | undefined {
  const eligible = () =>
    evalEnabledForSession({
      settings: options.settings,
      origin: options.wrappers.getOrigin?.(),
      tools: options.getActiveNames(),
      bashPolicy: options.wrappers.bashPolicy,
    })
  if (!eligible()) return undefined
  const kernel = createSandboxedEvalKernel({
    agentDir: options.wrappers.agentDir,
    sessionId: options.wrappers.sessionId,
    permissions: options.wrappers.permissions ?? noopPermissionService,
    getOrigin: () => options.wrappers.getOrigin?.(),
  })
  const tool = wrapSystemTool(
    defineTool({
      name: 'eval',
      label: 'eval',
      description:
        'Run a foreground JavaScript cell in a persistent, bash-sandboxed Bun kernel. ' +
        'Use await tool.read/grep/find/ls/bash/write/edit/web_search/web_fetch with their normal arguments, ' +
        'parallel(thunks) (up to 8 workers), and print/display(value). tool calls return the normal content/details object. ' +
        'Only active tools are callable; recursion, orchestration, posting, role changes and MCP dispatch are refused. ' +
        '30s default, 60s hard maximum; timeout kills the kernel. Output is capped at 64 KiB / 1000 lines. ' +
        'No background cells, package installation helpers or Python. Use await import(...) for modules.',
      parameters: Type.Object({
        code: Type.String({ maxLength: EVAL_LIMITS.codeBytes }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: EVAL_LIMITS.maxTimeoutMs })),
      }),
      async execute(_id, args, signal, _onUpdate, context) {
        if (!eligible()) {
          await kernel.dispose()
          throw new EvalError('refused', 'eval requires active, unrestricted bash in an enabled origin')
        }
        const result = await kernel.run(args.code, {
          signal,
          timeoutMs: args.timeoutMs,
          dispatch: createEvalDispatch({
            tools: options.tools,
            getActiveNames: options.getActiveNames,
            context,
          }),
        })
        if (result.isError) throw new EvalError('closed', result.text)
        return {
          content: [{ type: 'text', text: result.text || '(no output)' }],
          details: { truncated: result.truncated, restarted: result.restarted },
        }
      },
    }),
    options.wrappers,
  )
  options.tools.push(
    options.budget && options.budgetState
      ? wrapToolDefinitionWithBudget(tool, options.budget, options.budgetState)
      : tool,
  )
  options.activeNames.push('eval')
  return { dispose: () => kernel.dispose() }
}
