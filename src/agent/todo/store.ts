import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'

import type { TodoScope } from './scope'

export const TODO_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled'] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

export const TODO_PRIORITIES = ['high', 'medium', 'low'] as const
export type TodoPriority = (typeof TODO_PRIORITIES)[number]

export type Todo = {
  content: string
  status: TodoStatus
  priority?: TodoPriority
  id?: string
}

type TodoFile = {
  version: 1
  todos: Todo[]
  // Epoch ms of the last write. Optional: files written before it existed
  // have none, and readers treat that as unknown age.
  updatedAt?: number
}

export type TodoList = {
  todos: Todo[]
  updatedAt: number | null
}

export function todoDir(agentDir: string): string {
  return join(agentDir, 'todo')
}

// Defense-in-depth: the resolved file must stay inside todo/. Scope keys from
// resolveTodoScope are already collision- and traversal-safe, but this function
// is an exported primitive — a future caller passing a hand-built scope like
// `{ key: '../sessions/x' }` would otherwise escape. We assert here rather than
// trust every caller to use resolveTodoScope.
export function todoContentPath(agentDir: string, scope: TodoScope): string {
  const dir = todoDir(agentDir)
  const path = join(dir, `${scope.key}.json`)
  const rel = relative(dir, path)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`todo scope key escapes the todo directory: ${JSON.stringify(scope.key)}`)
  }
  return path
}

export async function readTodos(agentDir: string, scope: TodoScope): Promise<Todo[]> {
  return (await readTodoList(agentDir, scope)).todos
}

export async function readTodoList(agentDir: string, scope: TodoScope): Promise<TodoList> {
  const path = todoContentPath(agentDir, scope)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    if (isEnoent(err)) return { todos: [], updatedAt: null }
    throw err
  }
  let parsed: Partial<TodoFile>
  try {
    parsed = JSON.parse(raw) as Partial<TodoFile>
  } catch {
    return { todos: [], updatedAt: null }
  }
  const updatedAt = typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : null
  if (!Array.isArray(parsed.todos)) return { todos: [], updatedAt }
  // The file is force-committed and hand-editable, so a corrupt or partially
  // edited entry can appear. Drop anything that is not a well-formed Todo
  // rather than let a `null`/malformed item crash incompleteTodos (`t.status`)
  // or surface as trusted state to the model.
  return { todos: parsed.todos.filter(isValidTodo), updatedAt }
}

function isValidTodo(value: unknown): value is Todo {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Record<string, unknown>
  if (typeof t.content !== 'string' || t.content.length === 0) return false
  if (typeof t.status !== 'string' || !(TODO_STATUSES as readonly string[]).includes(t.status)) return false
  if (t.priority !== undefined && !(TODO_PRIORITIES as readonly string[]).includes(t.priority as string)) return false
  if (t.id !== undefined && typeof t.id !== 'string') return false
  return true
}

// Write is atomic (temp file + rename) so a crash mid-write can never leave a
// half-serialized JSON file that the next read would throw on. Mirrors the
// channels/sessions.json writer. A scope is normally owned by a single live
// session (see resolveTodoScope), so the only concurrent writers are the rare
// duplicate-attach case, where last-writer-wins on the rename is acceptable —
// the alternative (lost-update detection) is not worth a lock for a todo list.
export async function writeTodos(
  agentDir: string,
  scope: TodoScope,
  todos: Todo[],
  now: number = Date.now(),
): Promise<void> {
  const path = todoContentPath(agentDir, scope)
  const payload: TodoFile = { version: 1, todos, updatedAt: now }
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await renameWithRetry(tmp, path)
}

// Windows workaround: rename() onto an existing destination is not atomic and
// fails transiently (EPERM/EACCES/EBUSY/EEXIST) when another writer or a virus
// scanner / file indexer momentarily holds the target open — concurrent
// writeTodos calls onto the same scope file reliably trip this. The retry keeps
// last-writer-wins instead of rejecting a writer. POSIX rename never hits this.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST'])

async function renameWithRetry(from: string, to: string, attempts = 10): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
      if (attempt >= attempts || typeof code !== 'string' || !RENAME_RETRY_CODES.has(code)) throw err
      await new Promise((resolve) => setTimeout(resolve, attempt * 10))
    }
  }
}

export function incompleteTodos(todos: readonly Todo[]): Todo[] {
  return todos.filter((t) => t.status !== 'completed' && t.status !== 'cancelled')
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
}
