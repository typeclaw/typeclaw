import { describe, expect, test } from 'bun:test'

import { createDeepSubagent, DEEP_SYSTEM_PROMPT, deepPayloadSchema } from './deep'

describe('deep subagent declaration', () => {
  test('is registered as visibility=public', () => {
    expect(createDeepSubagent().visibility).toBe('public')
  })

  test('uses the `deep` model profile (quality-over-speed counterpart to operator)', () => {
    expect(createDeepSubagent().profile).toBe('deep')
  })

  test('declares requiresSpecificPermission=true (write-capable power gated like operator)', () => {
    expect(createDeepSubagent().requiresSpecificPermission).toBe(true)
  })

  test('declares canSpawnSubagents=true (orchestration tools wired into its session)', () => {
    expect(createDeepSubagent().canSpawnSubagents).toBe(true)
  })

  test('tools include read+grep+find+ls+bash AND write+edit (write-capable, same surface as operator)', () => {
    const toolNames = (createDeepSubagent().tools ?? []).map((t) => t.__builtinTool).sort()
    expect(toolNames).toEqual(['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'])
  })

  test('tool-result budget is at least operator-sized (multi-step work generates transcript)', () => {
    const sub = createDeepSubagent()
    expect(sub.toolResultBudget).toBeDefined()
    expect(sub.toolResultBudget?.maxTotalBytes).toBeGreaterThanOrEqual(1_000_000)
  })

  test('rosterDescription frames deep as the quality-over-speed execution worker and names the permission gate', () => {
    const desc = createDeepSubagent().rosterDescription ?? ''
    expect(desc).toContain('subagent.spawn.deep')
    expect(desc.toLowerCase()).toMatch(/quality|deep|hard|careful/)
  })

  test('inFlightKey is distinct per requestId and random without one', () => {
    const sub = createDeepSubagent()
    expect(sub.inFlightKey?.({ requestId: 'bg_a' })).toBe('bg_a')
    expect(sub.inFlightKey?.({})).not.toBe(sub.inFlightKey?.({}))
  })
})

describe('deep subagent — load-bearing prompt phrases', () => {
  test.each(
    [
      'final assistant message',
      'Do NOT commit secrets',
      'workspace in a broken state',
      'AGENTS.md',
      'channel_send',
    ].map((p) => [p] as const),
  )('prompt contains %s', (phrase) => {
    expect(DEEP_SYSTEM_PROMPT.toLowerCase()).toContain(phrase.toLowerCase())
  })
})

describe('deepPayloadSchema', () => {
  test('accepts requestId + prompt + description and passes through unknown fields', () => {
    expect(deepPayloadSchema.safeParse({ requestId: 'bg_t1', prompt: 'fix the build', x: 1 }).success).toBe(true)
  })
})
