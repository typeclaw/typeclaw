import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { z } from 'zod'

import { buildBuiltinPiToolOverrides, wrapPluginTool } from '@/agent/plugin-tools'
import { createBudgetState, wrapToolDefinitionWithBudget } from '@/agent/tool-result-budget'
import { createPermissionService } from '@/permissions/permissions'
import { createHookBus } from '@/plugin'

import { createEvalDispatch } from './dispatch'
import { testContext, testKernel } from './fixtures.test'
import type { EvalKernel } from './kernel'

// The kernel spawns bash and kills POSIX process groups; eval only runs in the
// Linux container stage.
describe.skipIf(process.platform === 'win32')('eval wrapped tool routing', () => {
  let dir: string
  let kernel: EvalKernel
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'typeclaw-eval-'))
    await mkdir(join(dir, 'workspace'))
    await writeFile(join(dir, 'workspace', 'one.txt'), 'selected line\n')
    await writeFile(join(dir, '.env'), 'HIDDEN=canary')
    kernel = testKernel(dir)
  })
  afterEach(async () => {
    await kernel.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  function tools() {
    return buildBuiltinPiToolOverrides({
      agentDir: dir,
      sessionId: crypto.randomUUID(),
      hooks: createHookBus(),
      permissions: createPermissionService(),
      getOrigin: () => ({ kind: 'tui', sessionId: 'test' }),
    })
  }

  test('a cell batches real wrapped reads and grep while suppressing intermediate data', async () => {
    const dispatch = createEvalDispatch({
      tools: tools(),
      getActiveNames: () => ['read', 'grep'],
      context: testContext(dir),
    })
    const result = await kernel.run(
      'const results = await parallel([() => tool.read({path:"workspace/one.txt"}), () => tool.grep({pattern:"selected",path:"workspace/one.txt"})]); print(results.length)',
      { dispatch },
    )
    expect(result).toMatchObject({ isError: false, text: '2\n' })
  }, 10_000)

  test('guarded reads from a cell fail exactly like the direct wrapped call', async () => {
    const wrapped = tools()
    const read = wrapped.find((tool) => tool.name === 'read')
    if (read === undefined) throw new Error('missing read tool')
    const context = testContext(dir)
    let directError = ''
    try {
      await read.execute('direct', { path: '.env' }, undefined, undefined, context)
    } catch (error) {
      directError = error instanceof Error ? error.message : String(error)
    }
    expect(directError).not.toBe('')
    const result = await kernel.run('try { await tool.read({path:".env"}) } catch (error) { print(error.message) }', {
      dispatch: createEvalDispatch({ tools: wrapped, getActiveNames: () => ['read'], context }),
    })
    expect(result.isError).toBe(false)
    expect(result.text.trim()).toBe(directError)
    expect(result.text).not.toContain('canary')
  })

  test('the final budget wrapper is shared with direct tool calls', async () => {
    const state = createBudgetState()
    const wrapped = tools().map((tool) =>
      wrapToolDefinitionWithBudget(tool, { maxTotalBytes: 1, toolNames: ['read'] }, state),
    )
    const dispatch = createEvalDispatch({ tools: wrapped, getActiveNames: () => ['read'], context: testContext(dir) })
    const result = await kernel.run(
      'await tool.read({path:"workspace/one.txt"}); const second = await tool.read({path:"workspace/one.txt"}); print(second.details.budgetExhausted)',
      { dispatch },
    )
    expect(result.isError).toBe(false)
    expect(result.text.trim()).toBe('true')
    expect(state.exhausted).toBe(true)
  })

  test.each(['eval', 'spawn_subagent', 'coding_agent', 'channel_send', 'mcp_call', 'not_registered'])(
    'refuses %s before executing any target',
    async (name) => {
      const dispatch = createEvalDispatch({ tools: tools(), getActiveNames: () => [name], context: testContext(dir) })
      await expect(dispatch({ name, args: {}, callId: 'test' }, new AbortController().signal)).rejects.toThrow()
    },
  )

  test('a registered but inactive tool remains inaccessible', async () => {
    const dispatch = createEvalDispatch({ tools: tools(), getActiveNames: () => [], context: testContext(dir) })
    await expect(
      dispatch({ name: 'read', args: { path: 'workspace/one.txt' }, callId: 'test' }, new AbortController().signal),
    ).rejects.toThrow()
  })

  test('recursion is refused through the real cell bridge', async () => {
    const dispatch = createEvalDispatch({ tools: tools(), getActiveNames: () => ['eval'], context: testContext(dir) })
    const result = await kernel.run('try { await tool.eval({code:"print(42)"}) } catch (error) { print(error.kind) }', {
      dispatch,
    })
    expect(result.isError).toBe(false)
    expect(result.text.trim()).toBe('refused')
  })

  test('tool argument validation happens before wrapped execution', async () => {
    const dispatch = createEvalDispatch({ tools: tools(), getActiveNames: () => ['read'], context: testContext(dir) })
    await expect(dispatch({ name: 'read', args: {}, callId: 'test' }, new AbortController().signal)).rejects.toThrow()
  })

  test.each([false, true])('active plugin calls retain their hook gate (allowed=%s)', async (allowed) => {
    let calls = 0
    let checked = 0
    const hooks = createHookBus()
    const logger = { info() {}, warn() {}, error() {} }
    hooks.registerAll('test', dir, logger, {
      'tool.before': () => {
        checked += 1
        return allowed ? undefined : { block: true, reason: 'fixture denial' }
      },
    })
    const wrapped = wrapPluginTool(
      {
        description: 'fixture',
        parameters: z.object({}),
        execute: async () => {
          calls += 1
          return { content: [{ type: 'text', text: 'fixture result' }] }
        },
      },
      { pluginName: 'test', toolName: 'plugin_echo', agentDir: dir, sessionId: crypto.randomUUID(), logger, hooks },
    )
    const result = await kernel.run('const response = await tool.plugin_echo({}); print(response.content.length)', {
      dispatch: createEvalDispatch({
        tools: [wrapped],
        getActiveNames: () => ['plugin_echo'],
        context: testContext(dir),
      }),
    })
    expect(result.isError).toBe(false)
    expect(checked).toBe(1)
    expect(calls).toBe(allowed ? 1 : 0)
    expect(result.text.trim()).toBe('1')
  })
})
