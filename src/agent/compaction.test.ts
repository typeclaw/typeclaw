import { describe, expect, test } from 'bun:test'

import type { Model } from '@mariozechner/pi-ai'

import {
  COMPACTION_KEEP_RECENT_TOKENS,
  COMPACTION_TRIGGER_PERCENT,
  createCompactionSettingsManager,
  reserveTokensForModel,
} from './compaction'

function fakeModel(contextWindow: number): Model<'openai-completions'> {
  return {
    id: 'fake',
    name: 'Fake',
    api: 'openai-completions',
    provider: 'fake',
    baseUrl: 'https://example',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: contextWindow,
  } as unknown as Model<'openai-completions'>
}

describe('reserveTokensForModel', () => {
  test('reserves the (1 - COMPACTION_TRIGGER_PERCENT) fraction of the window', () => {
    // given
    const window = 256_000
    const model = fakeModel(window)

    // when
    const reserve = reserveTokensForModel(model)

    // then
    expect(reserve).toBe(Math.round(window * (1 - COMPACTION_TRIGGER_PERCENT)))
    expect(reserve).toBe(76_800)
  })

  test('scales with the model context window so trigger fraction stays constant', () => {
    // given
    const small = fakeModel(200_000)
    const large = fakeModel(1_000_000)

    // when
    const triggerSmall = small.contextWindow - reserveTokensForModel(small)
    const triggerLarge = large.contextWindow - reserveTokensForModel(large)

    // then: both trip at ~80% of their own window
    expect(triggerSmall / small.contextWindow).toBeCloseTo(COMPACTION_TRIGGER_PERCENT, 3)
    expect(triggerLarge / large.contextWindow).toBeCloseTo(COMPACTION_TRIGGER_PERCENT, 3)
  })

  test('clamps to at least 1 so a degenerate zero-window model never produces a non-positive reserve', () => {
    // given
    const broken = fakeModel(0)

    // when
    const reserve = reserveTokensForModel(broken)

    // then
    expect(reserve).toBeGreaterThanOrEqual(1)
  })
})

describe('createCompactionSettingsManager', () => {
  test('produces a SettingsManager whose getCompactionSettings() reflects our chosen values', () => {
    // given
    const model = fakeModel(256_000)

    // when
    const sm = createCompactionSettingsManager(model)
    const settings = sm.getCompactionSettings()

    // then
    expect(settings.enabled).toBe(true)
    expect(settings.reserveTokens).toBe(reserveTokensForModel(model))
    expect(settings.keepRecentTokens).toBe(COMPACTION_KEEP_RECENT_TOKENS)
  })

  test('different models produce different reserveTokens but the same keepRecentTokens', () => {
    // given
    const a = fakeModel(200_000)
    const b = fakeModel(1_000_000)

    // when
    const sa = createCompactionSettingsManager(a).getCompactionSettings()
    const sb = createCompactionSettingsManager(b).getCompactionSettings()

    // then
    expect(sa.reserveTokens).not.toBe(sb.reserveTokens)
    expect(sa.keepRecentTokens).toBe(sb.keepRecentTokens)
  })
})
