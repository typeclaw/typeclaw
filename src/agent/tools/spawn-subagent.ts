import { randomUUID } from 'node:crypto'

import { Type } from '@mariozechner/pi-ai'
import { defineTool } from '@mariozechner/pi-coding-agent'

import type { PermissionService } from '@/permissions'
import type { Stream } from '@/stream'

import { type LiveSubagentRegistry, type SubagentCompletion } from '../live-subagents'
import type { SessionOrigin } from '../session-origin'
import { type CreateSessionForSubagent, type Subagent, type SubagentRegistry, startSubagent } from '../subagents'

export const SPAWN_TASK_ID_PREFIX = 'bg_'

export type SpawnSubagentToolDetails =
  | {
      ok: true
      mode: 'sync'
      subagent: string
      taskId: string
      sessionId: string | undefined
      durationMs: number
      finalMessage?: string
    }
  | {
      ok: true
      mode: 'background'
      subagent: string
      taskId: string
      sessionId: string | undefined
    }
  | { ok: false; error: string }

export type CreateSpawnSubagentToolOptions = {
  registry: SubagentRegistry
  liveRegistry: LiveSubagentRegistry
  createSessionForSubagent: CreateSessionForSubagent
  agentDir: string
  parentSessionId: string
  getOrigin: () => SessionOrigin | undefined
  permissions?: PermissionService
  stream?: Stream
  generateTaskId?: () => string
  now?: () => number
}

export function createSpawnSubagentTool(options: CreateSpawnSubagentToolOptions) {
  const {
    registry,
    liveRegistry,
    createSessionForSubagent,
    agentDir,
    parentSessionId,
    getOrigin,
    permissions,
    stream,
    generateTaskId = () => `${SPAWN_TASK_ID_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    now = () => Date.now(),
  } = options

  return defineTool({
    name: 'spawn_subagent',
    label: 'Spawn Subagent',
    description: spawnSubagentDescription(registry),
    parameters: Type.Object({
      subagent_type: Type.String({
        description:
          'Name of the subagent to spawn. Must be a public subagent registered with this agent. See the system prompt section "Subagent orchestration" for the available list.',
      }),
      prompt: Type.String({
        description:
          'The full task description for the subagent. Use the [CONTEXT]/[GOAL]/[REQUEST] structure described in the system prompt. The subagent does not see the parent conversation; everything it needs must be in this string.',
      }),
      description: Type.Optional(
        Type.String({
          description: '3-5 word label for this spawn, used for logs and the status_summary. Optional.',
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description:
            'When true, the spawn returns immediately with a task_id; the subagent runs in the background and a system-reminder is delivered when it completes. ' +
            'When false (default), the spawn blocks until the subagent finishes and returns its final message synchronously. ' +
            'Use background mode for long-running tasks where you want to keep the conversation moving (Mode B) or for parallel fan-out (Mode A).',
        }),
      ),
      payload: Type.Optional(
        Type.Object(
          {},
          {
            additionalProperties: true,
            description:
              'Structured data passed to the subagent in addition to the prompt, validated against the subagent\'s payload schema. Example: a reviewer accepts { reviewTarget: { kind: "github-pr", owner, repo, pullNumber } }. The reserved keys requestId/prompt/description are always set by the runtime and cannot be overridden here.',
          },
        ),
      ),
    }),

    async execute(_toolCallId, params): Promise<ToolReturn> {
      const origin = getOrigin()
      const subagent = lookupPublicSubagent(registry, params.subagent_type)
      if (subagent === null) {
        return errorResult(formatUnknownSubagentError(registry, params.subagent_type))
      }
      if (!hasPermissionForSubagent(permissions, origin, params.subagent_type, subagent)) {
        return errorResult('subagent.spawn denied: insufficient permissions')
      }

      const taskId = generateTaskId()
      const subagentName = params.subagent_type
      const background = params.run_in_background === true
      const callerPayload =
        typeof params.payload === 'object' && params.payload !== null && !Array.isArray(params.payload)
          ? (params.payload as Record<string, unknown>)
          : {}
      const reserved: Record<string, unknown> = { requestId: taskId, prompt: params.prompt }
      if (params.description !== undefined) reserved.description = params.description
      // Reserved spread LAST so a prompt-injected payload.requestId/prompt cannot
      // hijack the runtime-owned fields the spawn machinery and live registry rely on.
      const payload: Record<string, unknown> = { ...callerPayload, ...reserved }

      const startedAt = now()
      const { handle, completion } = startSubagent(subagentName, {
        registry,
        createSessionForSubagent,
        agentDir,
        userPrompt: params.prompt,
        payload: subagent.payloadSchema ? payload : undefined,
        parentSessionId,
        ...(origin !== undefined ? { spawnedByOrigin: origin } : {}),
        taskId,
      })

      let resolvedHandle: { taskId: string; sessionId: string | undefined; abort: () => Promise<void> } | undefined
      try {
        resolvedHandle = await handle
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(`failed to spawn ${subagentName}: ${message}`)
      }

      const live = {
        taskId,
        sessionId: resolvedHandle.sessionId ?? '<pending>',
        subagentName,
        parentSessionId,
        startedAt,
        status: 'running' as const,
        abort: resolvedHandle.abort,
      }
      liveRegistry.register(live)

      void completion.then((c) => {
        const durationMs = now() - startedAt
        liveRegistry.recordCompletion(taskId, completionToFinalShape(c, durationMs))
        if (stream && background) {
          stream.publish({
            target: { kind: 'broadcast' },
            payload: {
              kind: 'subagent.completed',
              taskId,
              subagent: subagentName,
              parentSessionId,
              ok: c.ok,
              durationMs,
              ...(c.ok ? {} : { error: c.error }),
            },
          })
        }
      })

      if (background) {
        const details: SpawnSubagentToolDetails = {
          ok: true,
          mode: 'background',
          subagent: subagentName,
          taskId,
          sessionId: resolvedHandle.sessionId,
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `Spawned ${subagentName} in background. task_id=${taskId}. You will receive a system-reminder when it completes. Use subagent_output to check progress or fetch results.`,
            },
          ],
          details,
        }
      }

      const result = await completion
      const durationMs = now() - startedAt
      if (!result.ok) {
        const details: SpawnSubagentToolDetails = { ok: false, error: result.error }
        return {
          content: [{ type: 'text' as const, text: `${subagentName} failed after ${durationMs}ms: ${result.error}` }],
          details,
        }
      }
      const details: SpawnSubagentToolDetails = {
        ok: true,
        mode: 'sync',
        subagent: subagentName,
        taskId,
        sessionId: resolvedHandle.sessionId,
        durationMs,
        ...(result.finalMessage !== undefined ? { finalMessage: result.finalMessage } : {}),
      }
      return {
        content: [
          {
            type: 'text' as const,
            text:
              result.finalMessage !== undefined
                ? result.finalMessage
                : `${subagentName} completed in ${durationMs}ms with no final message.`,
          },
        ],
        details,
      }
    },
  })
}

export function spawnSubagentDescription(registry: SubagentRegistry): string {
  const publicNames = publicSubagentNames(registry)
  const available = publicNames.length > 0 ? publicNames.join(', ') : '(none registered yet)'
  return (
    `Spawn a subagent to do focused work on your behalf. Use this when a task is heavy enough to deserve a fresh context window (research fan-out) ` +
    `or long-running enough that you want to keep the conversation moving while it runs (delegate-and-converse). ` +
    `Available subagents: ${available}. ` +
    `When run_in_background=true (preferred for long-running work), the tool returns a task_id immediately and the subagent runs concurrently — ` +
    `you will receive a system-reminder when it completes; do NOT poll subagent_output. ` +
    `When run_in_background=false (default), the tool blocks and returns the subagent's final message synchronously. ` +
    `Subagents cannot recursively spawn other subagents.`
  )
}

function publicSubagentNames(registry: SubagentRegistry): string[] {
  return Object.entries(registry)
    .filter(([, sub]) => isPublicSubagent(sub))
    .map(([name]) => name)
    .sort()
}

function isPublicSubagent(sub: Subagent<unknown>): boolean {
  return sub.visibility === 'public'
}

function lookupPublicSubagent(registry: SubagentRegistry, name: string): Subagent<unknown> | null {
  const sub = registry[name]
  if (sub === undefined) return null
  if (!isPublicSubagent(sub)) return null
  return sub
}

function formatUnknownSubagentError(registry: SubagentRegistry, requested: string): string {
  const names = publicSubagentNames(registry)
  const available = names.length > 0 ? names.join(', ') : '(none)'
  return `Unknown subagent: ${requested}. Available: ${available}.`
}

function hasPermissionForSubagent(
  permissions: PermissionService | undefined,
  origin: SessionOrigin | undefined,
  subagentName: string,
  subagent: Subagent<unknown>,
): boolean {
  if (permissions === undefined) return true
  const specific = `subagent.spawn.${subagentName}`
  if (subagent.requiresSpecificPermission === true) {
    return permissions.has(origin, specific)
  }
  if (permissions.has(origin, specific)) return true
  return permissions.has(origin, 'subagent.spawn')
}

function completionToFinalShape(
  c: { ok: true; finalMessage?: string } | { ok: false; error: string },
  durationMs: number,
): SubagentCompletion {
  if (c.ok) {
    return { ok: true, durationMs, ...(c.finalMessage !== undefined ? { finalMessage: c.finalMessage } : {}) }
  }
  return { ok: false, error: c.error, durationMs }
}

type ToolReturn = {
  content: { type: 'text'; text: string }[]
  details: SpawnSubagentToolDetails
}

function errorResult(message: string): ToolReturn {
  const details: SpawnSubagentToolDetails = { ok: false, error: message }
  return {
    content: [{ type: 'text', text: message }],
    details,
  }
}
