import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { PermissionService } from '@/permissions'

import type { LiveSubagentRegistry } from '../live-subagents'
import type { SessionOrigin } from '../session-origin'
import { authorizeLiveSubagentAccess } from './subagent-access'

export type SubagentCancelToolDetails =
  | { ok: true; taskId: string; subagent: string; alreadyDone: boolean }
  | { ok: false; error: string }

export type CreateSubagentCancelToolOptions = {
  liveRegistry: LiveSubagentRegistry
  getOrigin: () => SessionOrigin | undefined
  permissions?: PermissionService
  callerSessionId?: string
  hasOutstandingReviewThreadCloseout?: (sessionId: string) => boolean
}

export function createSubagentCancelTool(options: CreateSubagentCancelToolOptions) {
  const { liveRegistry, getOrigin, permissions, callerSessionId, hasOutstandingReviewThreadCloseout } = options

  return defineTool({
    name: 'subagent_cancel',
    label: 'Cancel Subagent',
    description:
      'Cancel a running subagent you previously spawned. The subagent receives an abort signal and its current in-flight tool call is interrupted. ' +
      'Use this when the user changes their mind, the spawn is no longer needed, or a runaway subagent must be stopped. ' +
      'Cancelling an already-completed or failed subagent is a no-op (returns ok=true with alreadyDone=true).',
    parameters: Type.Object({
      task_id: Type.String({
        description: 'The task_id returned by a previous spawn_subagent call.',
      }),
    }),

    async execute(_toolCallId, params): Promise<ToolReturn> {
      const access = authorizeLiveSubagentAccess({
        permissions,
        origin: getOrigin(),
        liveRegistry,
        taskId: params.task_id,
        permission: 'subagent.cancel',
        ...(callerSessionId !== undefined ? { callerSessionId } : {}),
      })
      if (!access.ok) {
        return errorResult(access.message)
      }
      const live = access.live
      if (live.status !== 'running') {
        const details: SubagentCancelToolDetails = {
          ok: true,
          taskId: live.taskId,
          subagent: live.subagentName,
          alreadyDone: true,
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `${live.subagentName} (${live.taskId}) is already ${live.status}; nothing to cancel.`,
            },
          ],
          details,
        }
      }
      try {
        await live.abort()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`abort failed: ${message}`)
      }
      live.releaseCoalesceKey?.()
      const owesReviewThreadCloseout =
        callerSessionId !== undefined && hasOutstandingReviewThreadCloseout?.(callerSessionId) === true
      const hasOtherRunningChild =
        callerSessionId !== undefined &&
        liveRegistry
          .list({ parentSessionId: callerSessionId })
          .some((candidate) => candidate.taskId !== live.taskId && candidate.status === 'running')
      const closeoutWarning =
        owesReviewThreadCloseout && !hasOtherRunningChild
          ? ' Warning: cancellation succeeded, but this session still owes its GitHub review thread a close-out. Reply now with an explicit resolve choice, or explain why you are leaving the thread open.'
          : ''
      const details: SubagentCancelToolDetails = {
        ok: true,
        taskId: live.taskId,
        subagent: live.subagentName,
        alreadyDone: false,
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `${live.subagentName} (${live.taskId}) cancellation requested. It will stop on the next abort checkpoint.${closeoutWarning}`,
          },
        ],
        details,
      }
    },
  })
}

type ToolReturn = {
  content: { type: 'text'; text: string }[]
  details: SubagentCancelToolDetails
}

function errorResult(message: string): ToolReturn {
  const details: SubagentCancelToolDetails = { ok: false, error: message }
  return {
    content: [{ type: 'text', text: message }],
    details,
  }
}
