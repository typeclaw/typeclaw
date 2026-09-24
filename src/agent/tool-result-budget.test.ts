import { describe, expect, test } from 'bun:test'

import { defineTool as definePiTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { createBudgetState, wrapAgentToolWithBudget, wrapToolDefinitionWithBudget } from './tool-result-budget'

type CapturedCall = { id: string; size: number }

function makeAgentTool(name: string, bytesPerCall: number, captured: CapturedCall[]) {
  return {
    name,
    label: name,
    description: 'test tool',
    parameters: Type.Object({}),
    async execute(toolCallId: string) {
      captured.push({ id: toolCallId, size: bytesPerCall })
      return {
        content: [{ type: 'text' as const, text: 'x'.repeat(bytesPerCall) }],
        details: undefined,
      }
    },
    renderCall: () => ({}) as never,
    renderResult: () => ({}) as never,
  }
}

describe('wrapAgentToolWithBudget', () => {
  test('passes through tools whose name is not in the budget list', async () => {
    const captured: CapturedCall[] = []
    const tool = makeAgentTool('other', 1024, captured)
    const state = createBudgetState()
    const wrapped = wrapAgentToolWithBudget(tool, { maxTotalBytes: 10, toolNames: ['read'] }, state)

    expect(wrapped).toBe(tool)
    const result = await wrapped.execute('c1', {} as never, undefined, () => {})
    expect((result.content[0] as { text: string }).text.length).toBe(1024)
    expect(state.used).toBe(0)
  })

  test('counts bytes of text content against the shared budget', async () => {
    const captured: CapturedCall[] = []
    const tool = makeAgentTool('read', 1000, captured)
    const state = createBudgetState()
    const wrapped = wrapAgentToolWithBudget(tool, { maxTotalBytes: 5000, toolNames: ['read'] }, state)

    await wrapped.execute('c1', {} as never, undefined, () => {})
    expect(state.used).toBe(1000)
    expect(state.exhausted).toBe(false)

    await wrapped.execute('c2', {} as never, undefined, () => {})
    expect(state.used).toBe(2000)
  })

  test('short-circuits subsequent calls once budget is exhausted', async () => {
    const captured: CapturedCall[] = []
    const tool = makeAgentTool('read', 3000, captured)
    const state = createBudgetState()
    const wrapped = wrapAgentToolWithBudget(tool, { maxTotalBytes: 5000, toolNames: ['read'] }, state)

    await wrapped.execute('c1', {} as never, undefined, () => {})
    await wrapped.execute('c2', {} as never, undefined, () => {})
    expect(state.exhausted).toBe(true)
    expect(captured).toHaveLength(2)

    const result = await wrapped.execute('c3', {} as never, undefined, () => {})
    expect(captured).toHaveLength(2)
    expect((result.content[0] as { text: string }).text).toContain('budget exhausted')
    expect((result.details as unknown as { budgetExhausted?: boolean } | undefined)?.budgetExhausted).toBe(true)
  })

  test('multiple tools wrapped with the same state share the budget', async () => {
    const captured: CapturedCall[] = []
    const tool1 = makeAgentTool('read', 2000, captured)
    const tool2 = makeAgentTool('read2', 2000, captured)
    const state = createBudgetState()
    const budget = { maxTotalBytes: 5000, toolNames: ['read', 'read2'] as const }
    const wrapped1 = wrapAgentToolWithBudget(tool1, budget, state)
    const wrapped2 = wrapAgentToolWithBudget(tool2, budget, state)

    await wrapped1.execute('a1', {} as never, undefined, () => {})
    await wrapped2.execute('a2', {} as never, undefined, () => {})
    await wrapped1.execute('a3', {} as never, undefined, () => {})
    expect(state.exhausted).toBe(true)

    const result = await wrapped2.execute('a4', {} as never, undefined, () => {})
    expect((result.content[0] as { text: string }).text).toContain('budget exhausted')
  })

  test('counts UTF-8 byte length, not JS string length, so Korean text is accounted for correctly', async () => {
    // 한 = 3 bytes UTF-8, so 100 chars of Korean = 300 bytes (not 100).
    const korean = '한'.repeat(100)
    expect(korean.length).toBe(100)
    expect(Buffer.byteLength(korean, 'utf8')).toBe(300)
    const tool = {
      name: 'read',
      label: 'read',
      description: 't',
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text' as const, text: korean }], details: undefined }
      },
      renderCall: () => ({}) as never,
      renderResult: () => ({}) as never,
    }
    const state = createBudgetState()
    const wrapped = wrapAgentToolWithBudget(tool, { maxTotalBytes: 500, toolNames: ['read'] }, state)
    await wrapped.execute('c1', {} as never, undefined, () => {})
    expect(state.used).toBe(300)
  })

  test('non-text content parts (images) are not counted against the byte budget', async () => {
    const tool = {
      name: 'read',
      label: 'read',
      description: 't',
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [
            { type: 'text' as const, text: 'tiny' },
            { type: 'image' as const, data: 'A'.repeat(50000), mimeType: 'image/png' },
          ],
          details: undefined,
        }
      },
      renderCall: () => ({}) as never,
      renderResult: () => ({}) as never,
    }
    const state = createBudgetState()
    const wrapped = wrapAgentToolWithBudget(tool, { maxTotalBytes: 1000, toolNames: ['read'] }, state)
    await wrapped.execute('c1', {} as never, undefined, () => {})
    expect(state.used).toBe(4)
  })

  test('preserves non-undefined details on healthy (non-exhausted) calls', async () => {
    const tool = {
      name: 'read',
      label: 'read',
      description: 't',
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: 'text' as const, text: 'ok' }],
          details: { custom: 42 },
        }
      },
      renderCall: () => ({}) as never,
      renderResult: () => ({}) as never,
    }
    const state = createBudgetState()
    const wrapped = wrapAgentToolWithBudget(tool, { maxTotalBytes: 1000, toolNames: ['read'] }, state)
    const result = await wrapped.execute('c1', {} as never, undefined, () => {})
    expect((result.details as { custom: number }).custom).toBe(42)
  })

  test('uses a custom exhaustedMessage when the budget supplies one', async () => {
    const tool = {
      name: 'read',
      label: 'read',
      description: 't',
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text' as const, text: 'x'.repeat(2000) }], details: undefined }
      },
      renderCall: () => ({}) as never,
      renderResult: () => ({}) as never,
    }
    const state = createBudgetState()
    const wrapped = wrapAgentToolWithBudget(
      tool,
      { maxTotalBytes: 1000, toolNames: ['read'], exhaustedMessage: () => 'CUSTOM-EXHAUSTED-MARKER' },
      state,
    )
    await wrapped.execute('c1', {} as never, undefined, () => {})
    const result = await wrapped.execute('c2', {} as never, undefined, () => {})
    expect((result.content[0] as { text: string }).text).toBe('CUSTOM-EXHAUSTED-MARKER')
  })
})

describe('wrapToolDefinitionWithBudget', () => {
  test('wraps custom ToolDefinition execute and enforces budget', async () => {
    const calls: string[] = []
    const tool = definePiTool({
      name: 'read',
      label: 'read',
      description: 'test',
      parameters: Type.Object({}),
      async execute(toolCallId) {
        calls.push(toolCallId)
        return { content: [{ type: 'text' as const, text: 'y'.repeat(2500) }], details: undefined }
      },
    })
    const state = createBudgetState()
    const wrapped = wrapToolDefinitionWithBudget(tool, { maxTotalBytes: 4000, toolNames: ['read'] }, state)

    await wrapped.execute('c1', {} as never, undefined, () => {}, {} as never)
    await wrapped.execute('c2', {} as never, undefined, () => {}, {} as never)
    expect(state.exhausted).toBe(true)
    expect(calls).toHaveLength(2)

    const result = await wrapped.execute('c3', {} as never, undefined, () => {}, {} as never)
    expect(calls).toHaveLength(2)
    expect((result.content[0] as { text: string }).text).toContain('budget exhausted')
  })

  test('returns the underlying tool unchanged when the name is not budgeted', async () => {
    const tool = definePiTool({
      name: 'append',
      label: 'append',
      description: 'test',
      parameters: Type.Object({}),
      async execute() {
        return { content: [{ type: 'text' as const, text: 'ok' }], details: undefined }
      },
    })
    const state = createBudgetState()
    const wrapped = wrapToolDefinitionWithBudget(tool, { maxTotalBytes: 10, toolNames: ['read'] }, state)

    expect(wrapped).toBe(tool)
  })
})
