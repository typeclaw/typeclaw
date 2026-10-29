import { describe, expect, test } from 'bun:test'

import { createReviewerSubagent } from '@/bundled-plugins/reviewer/reviewer'
import { configSchema } from '@/config/config'

import { evalEnabledForSession } from './config'

describe('eval eligibility', () => {
  test('omitted configuration leaves unrestricted sessions disabled', () => {
    const settings = configSchema.parse({}).eval
    const enabled = evalEnabledForSession({ settings, origin: { kind: 'tui', sessionId: 'test' }, tools: ['bash'] })
    expect(enabled).toBe(false)
  })

  test('explicit configuration enables an unrestricted session', () => {
    const settings = configSchema.parse({ eval: { enabled: true, origins: ['cron'] } }).eval
    const enabled = evalEnabledForSession({
      settings,
      origin: { kind: 'cron', jobId: 'test', jobKind: 'prompt' },
      tools: ['bash', 'read'],
    })
    expect(enabled).toBe(true)
  })

  test('reviewer remains excluded when its origin is enabled', () => {
    const reviewer = createReviewerSubagent()
    const settings = configSchema.parse({ eval: { enabled: true, origins: ['subagent'] } }).eval
    const enabled = evalEnabledForSession({
      settings,
      origin: { kind: 'subagent', subagent: 'renamed-reviewer', parentSessionId: 'test' },
      tools: (reviewer.tools ?? []).map((tool) => tool.__builtinTool),
      bashPolicy: reviewer.bashPolicy,
    })
    expect(enabled).toBe(false)
  })

  test('sessions without bash remain excluded', () => {
    const settings = configSchema.parse({ eval: { enabled: true } }).eval
    const enabled = evalEnabledForSession({ settings, origin: { kind: 'tui', sessionId: 'test' }, tools: ['read'] })
    expect(enabled).toBe(false)
  })

  test('origins outside the configured set remain excluded', () => {
    const settings = configSchema.parse({ eval: { enabled: true, origins: ['subagent'] } }).eval
    const enabled = evalEnabledForSession({ settings, origin: { kind: 'tui', sessionId: 'test' }, tools: ['bash'] })
    expect(enabled).toBe(false)
  })

  test('unknown origins remain excluded', () => {
    const settings = configSchema.parse({ eval: { enabled: true } }).eval
    const enabled = evalEnabledForSession({ settings, origin: undefined, tools: ['bash'] })
    expect(enabled).toBe(false)
  })

  test('invalid origins are rejected at the configuration boundary', () => {
    const result = configSchema.safeParse({ eval: { enabled: true, origins: ['unknown'] } })
    expect(result.success).toBe(false)
  })
})
