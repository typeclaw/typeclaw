import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import type { SessionOrigin } from '@/agent/session-origin'
import type { PermissionService } from '@/permissions'

import { codingRequestSchema, getCodingAgentService, type CodingAgentService } from './index'

export function createCodingAgentTool(options: {
  agentDir: string
  sessionId: string
  getOrigin: () => SessionOrigin | undefined
  permissions: PermissionService
  service?: CodingAgentService
}) {
  return defineTool({
    name: 'coding_agent',
    label: 'Coding Agent',
    description:
      'Run headless Claude Code, Codex or OmO in an isolated persistent Git worktree through the credential broker. ' +
      'Use a background operator for long runs. New tasks require repo and an anthropic (claude/omo) or openai-codex (codex/omo) modelRef; continuation uses taskId. ' +
      'The baseline is committed HEAD, not dirty source files. Inspect state, finalMessage and the complete patch before applying. ' +
      'Plan mode makes the worktree and Git database read-only. result reads a receipt; dispose requires explicit discard:true.',
    parameters: Type.Union([
      Type.Object({
        action: Type.Literal('run'),
        engine: Type.Union([Type.Literal('claude'), Type.Literal('codex'), Type.Literal('omo')]),
        repo: Type.Optional(Type.String()),
        modelRef: Type.Optional(Type.String()),
        taskId: Type.Optional(Type.String()),
        prompt: Type.String(),
        mode: Type.Optional(Type.Union([Type.Literal('plan'), Type.Literal('code')])),
        timeoutSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 2_147_483.647 })),
      }),
      Type.Object({ action: Type.Literal('result'), taskId: Type.String() }),
      Type.Object({ action: Type.Literal('dispose'), taskId: Type.String(), discard: Type.Literal(true) }),
    ]),
    async execute(_id, params, signal, onUpdate) {
      try {
        const request = codingRequestSchema.parse(params)
        const result = await (options.service ?? getCodingAgentService(options.agentDir)).execute(
          request,
          {
            sessionId: options.sessionId,
            origin: options.getOrigin(),
            permissions: options.permissions,
            onPrepared: (receipt) =>
              onUpdate?.({
                content: [{ type: 'text', text: JSON.stringify(receipt) }],
                details: receipt,
              }),
          },
          signal,
        )
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result }
      } catch (error) {
        const result = { ok: false, diagnostic: error instanceof Error ? error.message : 'Coding delegation failed.' }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result }
      }
    },
  })
}
