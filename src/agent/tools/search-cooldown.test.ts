import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  _resetSearchCooldownsForTest,
  activeCooldown,
  blockGeneration,
  ENGINE_COOLDOWN_BASE_MS,
  ENGINE_COOLDOWN_MAX_MS,
  recordEngineBlock,
  recordEngineSuccess,
} from './search-cooldown'

describe('search engine cooldowns', () => {
  let clock: number

  beforeEach(() => {
    clock = 0
    _resetSearchCooldownsForTest(() => clock)
  })

  afterEach(() => {
    _resetSearchCooldownsForTest()
  })

  test('the first block pauses the engine for the base window', () => {
    // when
    recordEngineBlock('exa', 'rate_limited')

    // then
    expect(activeCooldown('exa')).toEqual({ remainingMs: ENGINE_COOLDOWN_BASE_MS, reason: 'rate_limited' })
    clock = ENGINE_COOLDOWN_BASE_MS
    expect(activeCooldown('exa')).toBeUndefined()
  })

  test('each further block in a row doubles the pause up to the cap', () => {
    const pauses: number[] = []
    for (let i = 0; i < 6; i++) {
      recordEngineBlock('ddg', 'challenge')
      const remaining = activeCooldown('ddg')?.remainingMs ?? 0
      pauses.push(remaining)
      clock += remaining
    }

    expect(pauses).toEqual([60_000, 120_000, 240_000, 480_000, ENGINE_COOLDOWN_MAX_MS, ENGINE_COOLDOWN_MAX_MS])
  })

  test('a success clears the record so the next block starts from the base again', () => {
    // given: two blocks in a row
    recordEngineBlock('ddg', 'challenge')
    clock += ENGINE_COOLDOWN_BASE_MS
    recordEngineBlock('ddg', 'challenge')
    clock += 2 * ENGINE_COOLDOWN_BASE_MS

    // when
    recordEngineSuccess('ddg', blockGeneration('ddg'))
    recordEngineBlock('ddg', 'challenge')

    // then
    expect(activeCooldown('ddg')?.remainingMs).toBe(ENGINE_COOLDOWN_BASE_MS)
  })

  test('a block reported during an active pause is not counted as another block in a row', () => {
    // given
    recordEngineBlock('ddg', 'challenge')

    // when: a concurrent request raced into the same block
    clock += 1_000
    recordEngineBlock('ddg', 'challenge')

    // then: the original window stands, and the next real block is only the second in a row
    expect(activeCooldown('ddg')?.remainingMs).toBe(ENGINE_COOLDOWN_BASE_MS - 1_000)
    clock = ENGINE_COOLDOWN_BASE_MS
    recordEngineBlock('ddg', 'challenge')
    expect(activeCooldown('ddg')?.remainingMs).toBe(2 * ENGINE_COOLDOWN_BASE_MS)
  })

  test('Retry-After lengthens the pause but never past the cap', () => {
    recordEngineBlock('exa', 'rate_limited', 5 * 60_000)
    expect(activeCooldown('exa')?.remainingMs).toBe(5 * 60_000)

    recordEngineSuccess('exa', blockGeneration('exa'))
    recordEngineBlock('exa', 'rate_limited', 60 * 60_000)
    expect(activeCooldown('exa')?.remainingMs).toBe(ENGINE_COOLDOWN_MAX_MS)
  })

  test('a success from a request sent before a newer block does not lift that block', () => {
    // given: request A is sent, then a concurrent request B is blocked
    const sentA = blockGeneration('exa')
    recordEngineBlock('exa', 'rate_limited', 5 * 60_000)

    // when: A's success lands after B's block
    recordEngineSuccess('exa', sentA)

    // then
    expect(activeCooldown('exa')?.remainingMs).toBe(5 * 60_000)
  })

  test('engines cool down independently', () => {
    recordEngineBlock('exa', 'forbidden')

    expect(activeCooldown('exa')).toBeDefined()
    expect(activeCooldown('ddg')).toBeUndefined()
  })
})
