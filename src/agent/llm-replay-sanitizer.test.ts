import { describe, expect, it } from 'bun:test'

import type { AssistantMessage, Message, ToolResultMessage } from '@earendil-works/pi-ai'

import { sanitizeMessagesForLlmReplay } from '@/agent/llm-replay-sanitizer'

function user(text: string): Message {
  return { role: 'user', content: text, timestamp: 1 }
}

function assistant(toolCallIds: string[], stopReason: AssistantMessage['stopReason'] = 'toolUse'): AssistantMessage {
  return {
    role: 'assistant',
    content: toolCallIds.map((id) => ({ type: 'toolCall' as const, id, name: 'restart', arguments: {} })),
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1,
  }
}

function toolResult(toolCallId: string): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'restart',
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
    timestamp: 1,
  }
}

function ids(messages: Message[]): string[] {
  return messages.map((m) => {
    if (m.role === 'toolResult') return `result:${m.toolCallId}`
    if (m.role === 'assistant') {
      const calls = m.content.filter((b) => b.type === 'toolCall').map((b) => (b as { id: string }).id)
      return `assistant:${calls.join(',')}`
    }
    return 'user'
  })
}

describe('sanitizeMessagesForLlmReplay', () => {
  it('passes valid tool-use history through unchanged', () => {
    const input = [user('hi'), assistant(['a']), toolResult('a'), assistant([], 'stop')]
    const { messages, stats } = sanitizeMessagesForLlmReplay(input)
    expect(messages).toEqual(input)
    expect(stats).toEqual({ droppedOrphans: 0, droppedDuplicates: 0, droppedErrorAssistants: 0 })
  })

  it('drops a toolResult whose producing assistant was error/aborted (the error-poison case)', () => {
    const input = [user('restart'), assistant(['toolu_x'], 'error'), toolResult('toolu_x'), user('you back?')]
    const { messages, stats } = sanitizeMessagesForLlmReplay(input)
    expect(ids(messages)).toEqual(['user', 'user'])
    expect(stats.droppedErrorAssistants).toBe(1)
    expect(stats.droppedOrphans).toBe(1)
  })

  it('drops a true orphan toolResult with no preceding toolCall at all', () => {
    const input = [user('hi'), toolResult('ghost'), assistant([], 'stop')]
    const { messages, stats } = sanitizeMessagesForLlmReplay(input)
    expect(ids(messages)).toEqual(['user', 'assistant:'])
    expect(stats.droppedOrphans).toBe(1)
  })

  it('keeps multiple tool calls from one assistant with interleaved out-of-order results', () => {
    const input = [assistant(['a', 'b']), toolResult('b'), toolResult('a')]
    const { messages, stats } = sanitizeMessagesForLlmReplay(input)
    expect(ids(messages)).toEqual(['assistant:a,b', 'result:b', 'result:a'])
    expect(stats.droppedOrphans).toBe(0)
  })

  it('dedupes a duplicate toolResult for the same toolCallId', () => {
    const input = [assistant(['a']), toolResult('a'), toolResult('a')]
    const { messages, stats } = sanitizeMessagesForLlmReplay(input)
    expect(ids(messages)).toEqual(['assistant:a', 'result:a'])
    expect(stats.droppedDuplicates).toBe(1)
  })

  it('drops a late result that arrives after a user message closed the window', () => {
    const input = [assistant(['a']), toolResult('a'), user('next'), toolResult('a')]
    const { messages, stats } = sanitizeMessagesForLlmReplay(input)
    expect(ids(messages)).toEqual(['assistant:a', 'result:a', 'user'])
    expect(stats.droppedOrphans).toBe(1)
  })

  it('drops a result belonging to a prior assistant window once a new assistant turn starts', () => {
    const input = [assistant(['a']), assistant(['b']), toolResult('a'), toolResult('b')]
    const { messages, stats } = sanitizeMessagesForLlmReplay(input)
    expect(ids(messages)).toEqual(['assistant:a', 'assistant:b', 'result:b'])
    expect(stats.droppedOrphans).toBe(1)
  })

  it('leaves a bare toolCall when its only result was an orphan (pi-ai synthesizes the placeholder)', () => {
    const input = [assistant(['a']), user('interrupt'), toolResult('a')]
    const { messages, stats } = sanitizeMessagesForLlmReplay(input)
    expect(ids(messages)).toEqual(['assistant:a', 'user'])
    expect(stats.droppedOrphans).toBe(1)
  })
})
