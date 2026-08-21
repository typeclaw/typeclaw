import { describe, expect, it } from 'bun:test'

import { createBoundedMap, createDeliveryDedup } from './dedup'

describe('createBoundedMap', () => {
  it('evicts the least-recently inserted entry once it reaches the cap', () => {
    const values = createBoundedMap<string, number>(2)
    values.set('a', 1)
    values.set('b', 2)
    values.set('c', 3)

    expect(values.has('a')).toBe(false)
    expect(values.get('b')).toBe(2)
    expect(values.get('c')).toBe(3)
    expect(values.size()).toBe(2)
  })
})

describe('createDeliveryDedup', () => {
  it('keeps recent deliveries and evicts least-recently inserted ids', () => {
    const dedup = createDeliveryDedup(2)
    dedup.add('a')
    dedup.add('b')
    expect(dedup.has('a')).toBe(true)
    dedup.add('c')
    expect(dedup.has('a')).toBe(false)
    expect(dedup.has('b')).toBe(true)
    expect(dedup.has('c')).toBe(true)
    expect(dedup.size()).toBe(2)
  })
})
