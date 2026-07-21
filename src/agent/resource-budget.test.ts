import { describe, expect, test } from 'bun:test'

import { configSchema } from '@/config'

import { createProcessResourceBudget, WeightedResourceBudget } from './resource-budget'

const LIMITS = { maxMemoryBytes: 10, maxPinnedBytes: 20, maxPinnedCount: 2, maxWaiters: 2 }

describe('WeightedResourceBudget', () => {
  test('admits concurrent weighted claims only after retained capacity is released', async () => {
    const budget = new WeightedResourceBudget(LIMITS)
    const first = await budget.acquire({ memoryBytes: 7 })
    let admitted = false
    const secondPromise = budget.acquire({ memoryBytes: 4 }).then((lease) => {
      admitted = true
      return lease
    })

    await Bun.sleep(5)
    expect(admitted).toBeFalse()
    first.release()
    const second = await secondPromise
    expect(admitted).toBeTrue()
    second.release()
    expect(budget.usage()).toEqual({ memoryBytes: 0, pinnedBytes: 0, pinnedCount: 0, waiters: 0 })
  })

  test('removes an aborted waiter without retaining its request state', async () => {
    const budget = new WeightedResourceBudget(LIMITS)
    const holder = await budget.acquire({ memoryBytes: 10 })
    const controller = new AbortController()
    const waiting = budget.acquire({ memoryBytes: 1 }, controller.signal)
    controller.abort('cancelled')

    await expect(waiting).rejects.toThrow(/abort|cancel/i)
    expect(budget.usage().waiters).toBe(0)
    holder.release()
  })

  test('rejects incremental growth that would cross a dimension ceiling', async () => {
    const budget = new WeightedResourceBudget(LIMITS)
    const lease = await budget.acquire({ memoryBytes: 6, pinnedBytes: 5, pinnedCount: 1 })

    expect(lease.tryResize({ memoryBytes: 11, pinnedBytes: 5, pinnedCount: 1 })).toBeFalse()
    expect(lease.tryResize({ memoryBytes: 6, pinnedBytes: 21, pinnedCount: 1 })).toBeFalse()
    expect(lease.tryResize({ memoryBytes: 6, pinnedBytes: 5, pinnedCount: 3 })).toBeFalse()
    expect(budget.usage()).toMatchObject({ memoryBytes: 6, pinnedBytes: 5, pinnedCount: 1 })
    lease.release()
  })

  test('keeps the waiter queue finite', async () => {
    const budget = new WeightedResourceBudget({ ...LIMITS, maxWaiters: 1 })
    const holder = await budget.acquire({ memoryBytes: 10 })
    const controller = new AbortController()
    const waiting = budget.acquire({ memoryBytes: 1 }, controller.signal)

    await expect(budget.acquire({ memoryBytes: 1 })).rejects.toThrow(/waiter queue is full/i)
    controller.abort()
    await waiting.catch(() => undefined)
    holder.release()
  })

  test('builds the boot budget from raised validated config limits', async () => {
    const limits = configSchema.parse({
      modelTools: { limits: { readSnapshotMaxBytes: 192 * 1024 * 1024, lookAtMaxImages: 48 } },
    }).modelTools.limits
    const budget = createProcessResourceBudget(limits)

    const lease = await budget.acquire({ pinnedBytes: 192 * 1024 * 1024, pinnedCount: 48 })
    expect(budget.usage()).toMatchObject({ pinnedBytes: 192 * 1024 * 1024, pinnedCount: 48 })
    lease.release()
  })
})
