import { describe, expect, test } from 'bun:test'

import { configSchema, FIELD_EFFECTS } from './config'
import {
  deriveProcessResourceBudgetLimits,
  MODEL_TOOL_LIMIT_HARD_MAX,
  DEFAULT_MODEL_TOOL_LIMITS,
} from './model-tool-limits'

describe('modelTools.limits config', () => {
  test('preserves the existing model-tool budgets when omitted', () => {
    expect(configSchema.parse({}).modelTools.limits).toEqual(DEFAULT_MODEL_TOOL_LIMITS)
    expect(DEFAULT_MODEL_TOOL_LIMITS).toEqual({
      readSnapshotMaxBytes: 64 * 1024 * 1024,
      lookAtImageMaxBytes: 20 * 1024 * 1024,
      lookAtTotalMaxBytes: 20 * 1024 * 1024,
      lookAtMaxImages: 16,
      webFetchTransportMaxBytes: 5 * 1024 * 1024,
      channelAttachmentMaxBytes: 100 * 1024 * 1024,
    })
  })

  test('accepts lower values and each immutable hard maximum', () => {
    const lower = configSchema.parse({
      modelTools: {
        limits: {
          readSnapshotMaxBytes: 1024,
          lookAtImageMaxBytes: 512,
          lookAtTotalMaxBytes: 2048,
          lookAtMaxImages: 2,
          webFetchTransportMaxBytes: 4096,
          channelAttachmentMaxBytes: 8192,
        },
      },
    })
    expect(lower.modelTools.limits.readSnapshotMaxBytes).toBe(1024)

    expect(() =>
      configSchema.parse({
        modelTools: {
          limits: {
            ...MODEL_TOOL_LIMIT_HARD_MAX,
            lookAtTotalMaxBytes: MODEL_TOOL_LIMIT_HARD_MAX.lookAtTotalMaxBytes,
          },
        },
      }),
    ).not.toThrow()
  })

  test.each(Object.entries(MODEL_TOOL_LIMIT_HARD_MAX))('rejects %s above its immutable ceiling', (field, max) => {
    expect(() => configSchema.parse({ modelTools: { limits: { [field]: max + 1 } } })).toThrow()
  })

  test('rejects an aggregate look_at budget below its per-image budget', () => {
    expect(() =>
      configSchema.parse({
        modelTools: { limits: { lookAtImageMaxBytes: 1024, lookAtTotalMaxBytes: 1023 } },
      }),
    ).toThrow(/aggregate|total.*per-image/i)
  })

  test('derives a process-wide snapshot budget that covers every invocation without changing defaults', () => {
    expect(deriveProcessResourceBudgetLimits(DEFAULT_MODEL_TOOL_LIMITS)).toEqual({
      maxMemoryBytes: 256 * 1024 * 1024,
      maxPinnedBytes: 100 * 1024 * 1024,
      maxPinnedCount: 32,
      maxWaiters: 32,
    })

    const raised = configSchema.parse({
      modelTools: {
        limits: {
          readSnapshotMaxBytes: 192 * 1024 * 1024,
          lookAtTotalMaxBytes: 64 * 1024 * 1024,
          lookAtMaxImages: 48,
        },
      },
    }).modelTools.limits
    const processBudget = deriveProcessResourceBudgetLimits(raised)
    expect(processBudget.maxPinnedBytes).toBeGreaterThanOrEqual(raised.readSnapshotMaxBytes)
    expect(processBudget.maxPinnedBytes).toBeGreaterThanOrEqual(raised.lookAtTotalMaxBytes)
    expect(processBudget.maxPinnedCount).toBeGreaterThanOrEqual(raised.lookAtMaxImages)
  })

  test('is restart-required because process-wide reservations are boot snapshots', () => {
    expect(FIELD_EFFECTS.modelTools).toBe('restart-required')
  })
})
