import type { KnownApi, Model } from '@earendil-works/pi-ai'
import { SettingsManager } from '@earendil-works/pi-coding-agent'

// Compaction trigger expressed as a fraction of the model's context window.
// pi-coding-agent auto-compaction fires when `contextTokens > contextWindow -
// reserveTokens`; deriving `reserveTokens` from the window keeps the trigger at
// the same fraction across models with very different windows (200K Claude vs.
// 1M Gemini vs. 256K Kimi) instead of the SDK's fixed 16384 reserve, which
// drifts to ~94% on a 256K window and ~98% on 1M.
export const COMPACTION_TRIGGER_PERCENT = 0.8

// Absolute ceiling on the compaction trigger, independent of window size. The
// window-relative trigger alone optimizes for overflow avoidance, not token
// cost: at 80% of a large window a session accumulates ~160K (200K window) to
// ~800K (1M window) tokens of history that get re-shipped as `cacheRead` every
// turn before compaction ever fires. Capping the trigger bounds that
// steady-state re-read on big-window models; `min()` keeps the 80% behavior on
// small ones. 64K is 3x keepRecent (invariant asserted in the test), leaving
// growth room after a compaction so it does not retrigger immediately.
export const COMPACTION_ABSOLUTE_TRIGGER_TOKENS = 64_000

// Tokens to keep in the recent window after compaction. Fixed (not a
// percentage) because "recent context" is a property of conversation shape, not
// model capacity. Mirrors pi's DEFAULT_COMPACTION_SETTINGS.keepRecentTokens.
export const COMPACTION_KEEP_RECENT_TOKENS = 20_000

export function compactionTriggerTokens<TApi extends KnownApi>(model: Model<TApi>): number {
  const windowRelative = Math.round(model.contextWindow * COMPACTION_TRIGGER_PERCENT)
  return Math.min(windowRelative, COMPACTION_ABSOLUTE_TRIGGER_TOKENS)
}

export function reserveTokensForModel<TApi extends KnownApi>(model: Model<TApi>): number {
  return Math.max(1, model.contextWindow - compactionTriggerTokens(model))
}

export function createCompactionSettingsManager<TApi extends KnownApi>(model: Model<TApi>): SettingsManager {
  return SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: reserveTokensForModel(model),
      keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS,
    },
  })
}
