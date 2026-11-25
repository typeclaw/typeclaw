import { describe, expect, test } from 'bun:test'

import { createOperatorSubagent, operatorPayloadSchema } from './operator'

describe('operator subagent declaration', () => {
  test('does not require a specific permission (member with generic subagent.spawn can spawn it)', () => {
    const sub = createOperatorSubagent()
    expect(sub.requiresSpecificPermission ?? false).toBe(false)
  })

  test('declares only builtin tools the spawner already holds (spawning grants no new capability)', () => {
    const sub = createOperatorSubagent()
    const names = (sub.tools ?? []).map((tool) => (tool as { __builtinTool: string }).__builtinTool)
    expect(names.toSorted()).toEqual(['bash', 'coding_agent', 'edit', 'find', 'grep', 'ls', 'read', 'watch', 'write'])
  })

  test('declares canSpawnSubagents=true (orchestration tools are wired into its session)', () => {
    const sub = createOperatorSubagent()
    expect(sub.canSpawnSubagents).toBe(true)
  })

  test('uses the default model profile (needs reasoning for multi-step work, not the fast tier)', () => {
    const sub = createOperatorSubagent()
    expect(sub.profile).toBe('default')
  })

  test('tool-result budget is larger than explorers (multi-step work generates more transcript)', () => {
    const sub = createOperatorSubagent()
    expect(sub.toolResultBudget).toBeDefined()
    expect(sub.toolResultBudget?.maxTotalBytes).toBeGreaterThanOrEqual(1_000_000)
  })

  test('inFlightKey returns distinct values for distinct requestId payloads', () => {
    const sub = createOperatorSubagent()
    const k1 = sub.inFlightKey?.({ requestId: 'bg_a' })
    const k2 = sub.inFlightKey?.({ requestId: 'bg_b' })
    expect(k1).toBe('bg_a')
    expect(k2).toBe('bg_b')
  })

  test('inFlightKey falls back to a random value when no requestId is provided', () => {
    const sub = createOperatorSubagent()
    const k1 = sub.inFlightKey?.({})
    const k2 = sub.inFlightKey?.({})
    expect(k1).not.toBe(k2)
  })
})

describe('operatorPayloadSchema', () => {
  test('accepts a full payload with requestId + prompt + description', () => {
    const result = operatorPayloadSchema.safeParse({
      requestId: 'bg_t1',
      prompt: 'open example.com',
      description: 'browser session',
    })
    expect(result.success).toBe(true)
  })

  test('accepts a payload with only requestId (spawn-tool minimum)', () => {
    const result = operatorPayloadSchema.safeParse({ requestId: 'bg_t1' })
    expect(result.success).toBe(true)
  })

  test('passes through unknown fields (forward-compat)', () => {
    const result = operatorPayloadSchema.safeParse({ requestId: 'bg_t1', futureField: 42 })
    expect(result.success).toBe(true)
  })

  test('accepts an optional `profile` override (lets a spawn run operator on a stronger model tier)', () => {
    const result = operatorPayloadSchema.safeParse({ requestId: 'bg_t1', prompt: 'fix the build', profile: 'deep' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.profile).toBe('deep')
  })
})
