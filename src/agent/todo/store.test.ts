import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { TodoScope } from './scope'
import { incompleteTodos, readTodoList, readTodos, type Todo, todoContentPath, writeTodos } from './store'

const TUI_SCOPE: TodoScope = { kind: 'tui', key: 'tui' }
const CHANNEL_SCOPE: TodoScope = { kind: 'channel', key: 'channel/slack-bot,T1,C1,_root' }

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-todo-store-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('todo store', () => {
  test('reading a non-existent scope returns an empty list', async () => {
    expect(await readTodos(agentDir, TUI_SCOPE)).toEqual([])
  })

  test('write then read round-trips the list', async () => {
    const todos: Todo[] = [
      { content: 'first', status: 'pending', priority: 'high' },
      { content: 'second', status: 'in_progress' },
    ]
    await writeTodos(agentDir, TUI_SCOPE, todos)
    expect(await readTodos(agentDir, TUI_SCOPE)).toEqual(todos)
  })

  test('records when the list was written', async () => {
    await writeTodos(agentDir, TUI_SCOPE, [{ content: 'x', status: 'pending' }], 1234)
    expect(await readTodoList(agentDir, TUI_SCOPE)).toEqual({
      todos: [{ content: 'x', status: 'pending' }],
      updatedAt: 1234,
    })
  })

  test('a list file without a write time reads as unknown age', async () => {
    const path = todoContentPath(agentDir, TUI_SCOPE)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 1, todos: [{ content: 'x', status: 'pending' }] }))
    expect((await readTodoList(agentDir, TUI_SCOPE)).updatedAt).toBeNull()
  })

  test('nested scope keys create their parent directories', async () => {
    await writeTodos(agentDir, CHANNEL_SCOPE, [{ content: 'x', status: 'pending' }])
    expect(await readTodos(agentDir, CHANNEL_SCOPE)).toEqual([{ content: 'x', status: 'pending' }])
  })

  test('atomic write leaves no .tmp file behind', async () => {
    await writeTodos(agentDir, TUI_SCOPE, [{ content: 'x', status: 'pending' }])
    const dir = join(agentDir, 'todo')
    const entries = await readdir(dir)
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false)
    expect(entries).toContain('tui.json')
  })

  test('the persisted file is valid pretty-printed JSON with a version', async () => {
    await writeTodos(agentDir, TUI_SCOPE, [{ content: 'x', status: 'pending' }])
    const raw = await readFile(todoContentPath(agentDir, TUI_SCOPE), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(1)
    expect(raw.endsWith('\n')).toBe(true)
  })

  test('many concurrent writers all resolve and the survivor is one of them', async () => {
    const writers = Array.from({ length: 16 }, (_, i) => [{ content: `w${i}`, status: 'pending' } satisfies Todo])
    await Promise.all(writers.map((todos) => writeTodos(agentDir, TUI_SCOPE, todos)))
    const result = JSON.stringify(await readTodos(agentDir, TUI_SCOPE))
    expect(writers.map((w) => JSON.stringify(w))).toContain(result)
  })
})

describe('readTodos validation (corrupt / hand-edited files)', () => {
  async function writeRaw(scope: TodoScope, body: string): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    const path = todoContentPath(agentDir, scope)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body, 'utf8')
  }

  test('drops malformed items instead of crashing or surfacing them', async () => {
    await writeRaw(
      TUI_SCOPE,
      JSON.stringify({
        version: 1,
        todos: [
          { content: 'good', status: 'pending' },
          null,
          { content: '', status: 'pending' },
          { content: 'bad-status', status: 'frozen' },
          { content: 'ok2', status: 'completed', priority: 'high' },
          { content: 'bad-priority', status: 'pending', priority: 'urgent' },
        ],
      }),
    )
    const todos = await readTodos(agentDir, TUI_SCOPE)
    expect(todos.map((t) => t.content)).toEqual(['good', 'ok2'])
  })

  test('invalid JSON reads as empty rather than throwing', async () => {
    await writeRaw(TUI_SCOPE, 'not json{{')
    expect(await readTodos(agentDir, TUI_SCOPE)).toEqual([])
  })

  test('a non-array todos field reads as empty', async () => {
    await writeRaw(TUI_SCOPE, JSON.stringify({ version: 1, todos: 'nope' }))
    expect(await readTodos(agentDir, TUI_SCOPE)).toEqual([])
  })
})

describe('todoContentPath traversal guard', () => {
  test('throws when a hand-built scope key would escape the todo directory', () => {
    expect(() => todoContentPath(agentDir, { kind: 'tui', key: '../sessions/x' })).toThrow(/escapes the todo directory/)
  })

  test('accepts a normal nested key', () => {
    const path = todoContentPath(agentDir, { kind: 'channel', key: 'channel/sslack,sw,sc,n' })
    expect(path.endsWith(join('todo', 'channel', 'sslack,sw,sc,n.json'))).toBe(true)
  })
})

describe('incompleteTodos', () => {
  test('excludes completed and cancelled, keeps pending and in_progress', () => {
    const todos: Todo[] = [
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'completed' },
      { content: 'd', status: 'cancelled' },
    ]
    expect(incompleteTodos(todos).map((t) => t.content)).toEqual(['a', 'b'])
  })
})
