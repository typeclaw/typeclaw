import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'

import type { SessionOrigin } from '@/agent/session-origin'
import { resolveTodoScope, type TodoScope } from '@/agent/todo/scope'
import { incompleteTodos, type Todo, TODO_PRIORITIES, TODO_STATUSES, readTodos, writeTodos } from '@/agent/todo/store'

export type CreateTodoToolsOptions = {
  agentDir: string
  getOrigin: () => SessionOrigin | undefined
}

const NO_SCOPE_NOTICE =
  'Todos are owned by the originating session. This session (a subagent, system task, or one ' +
  'with no resolvable origin) does not own a todo list, so the call was a no-op.'

type TodoToolDetails = {
  ok: boolean
  reason?: string
  total?: number
  remaining?: number
}

// Resolve the scope for the current origin, or null when this session owns no
// todo list. An UNDEFINED origin is treated as no-scope, NOT defaulted to the
// shared TUI scope — defaulting would fail open, silently routing an unknown
// actor's todos into the operator's global `tui` list.
function scopeForOrigin(getOrigin: () => SessionOrigin | undefined): TodoScope | null {
  const origin = getOrigin()
  return origin === undefined ? null : resolveTodoScope(origin)
}

const TODO_ITEM = Type.Object({
  content: Type.String({ minLength: 1, description: 'What the task is.' }),
  status: Type.Union(
    TODO_STATUSES.map((s) => Type.Literal(s)),
    { description: 'One of: pending, in_progress, completed, cancelled.' },
  ),
  priority: Type.Optional(Type.Union(TODO_PRIORITIES.map((p) => Type.Literal(p)))),
  id: Type.Optional(Type.String()),
})

export function createTodoTools({ agentDir, getOrigin }: CreateTodoToolsOptions) {
  const writeTool = defineTool({
    name: 'todo_write',
    label: 'Write Todos',
    description:
      'Replace your entire todo list for this session with the provided items. Maintain a todo ' +
      'list for any multi-step or long-running task so that if this session is interrupted ' +
      '(restart, crash, or a later turn), you can resume the remaining work instead of silently ' +
      'dropping it. Mark items `completed` (or `cancelled`) as you finish them by writing the full ' +
      'list again with updated statuses. This is a full replace, not a merge: include every item ' +
      'you still care about on each call. When the list you write has no incomplete items left, ' +
      'the runtime clears it for you — no separate cleanup call is needed.',
    parameters: Type.Object({
      todos: Type.Array(TODO_ITEM, { description: 'The complete todo list. Replaces any prior list.' }),
    }),
    async execute(_toolCallId, params) {
      const scope = scopeForOrigin(getOrigin)
      if (scope === null) {
        const details: TodoToolDetails = { ok: false, reason: 'no-scope' }
        return { content: [{ type: 'text' as const, text: NO_SCOPE_NOTICE }], details }
      }
      const todos = params.todos as Todo[]
      const remaining = incompleteTodos(todos).length

      // Collapse a fully-resolved list to empty in the SAME write that
      // completed it, rather than relying on a follow-up todo_clear. That
      // follow-up can be lost to an abort landing on the next turn, leaving a
      // resolved list on disk (harmless to continuation, but it never gets
      // cleaned up). Clearing here makes the cleanup race-free by construction.
      if (remaining === 0 && todos.length > 0) {
        await writeTodos(agentDir, scope, [])
        const details: TodoToolDetails = { ok: true, total: todos.length, remaining: 0 }
        return {
          content: [
            {
              type: 'text' as const,
              text: `All ${todos.length} todo(s) done; list cleared.`,
            },
          ],
          details,
        }
      }

      await writeTodos(agentDir, scope, todos)
      const details: TodoToolDetails = { ok: true, total: todos.length, remaining }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Saved ${todos.length} todo(s); ${remaining} remaining (${todos.length - remaining} done).`,
          },
        ],
        details,
      }
    },
  })

  const readTool = defineTool({
    name: 'todo_read',
    label: 'Read Todos',
    description: 'Return your current todo list for this session. Use it to re-sync after an interruption.',
    parameters: Type.Object({}),
    async execute() {
      const scope = scopeForOrigin(getOrigin)
      if (scope === null) {
        const details: TodoToolDetails = { ok: false, reason: 'no-scope' }
        return { content: [{ type: 'text' as const, text: NO_SCOPE_NOTICE }], details }
      }
      const todos = await readTodos(agentDir, scope)
      const details: TodoToolDetails = { ok: true, total: todos.length }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(todos, null, 2) }],
        details,
      }
    },
  })

  const clearTool = defineTool({
    name: 'todo_clear',
    label: 'Clear Todos',
    description:
      'Empty your todo list for this session. Use this only to abandon a task with items still ' +
      'incomplete, so the runtime stops tracking pending work. A list with no incomplete items ' +
      'left is cleared automatically by `todo_write`, so you do not need to call this after ' +
      'finishing everything.',
    parameters: Type.Object({}),
    async execute() {
      const scope = scopeForOrigin(getOrigin)
      if (scope === null) {
        const details: TodoToolDetails = { ok: false, reason: 'no-scope' }
        return { content: [{ type: 'text' as const, text: NO_SCOPE_NOTICE }], details }
      }
      await writeTodos(agentDir, scope, [])
      const details: TodoToolDetails = { ok: true }
      return { content: [{ type: 'text' as const, text: 'Todo list cleared.' }], details }
    },
  })

  return [writeTool, readTool, clearTool]
}
