import type { KnownApi, Model } from '@earendil-works/pi-ai'
import { SettingsManager } from '@earendil-works/pi-coding-agent'

// Compaction trigger expressed as a fraction of the model's context window.
// pi-coding-agent auto-compaction fires when `contextTokens > contextWindow -
// reserveTokens`; deriving `reserveTokens` from the window keeps the trigger at
// the same fraction across models with very different windows (200K Claude vs.
// 1M Gemini vs. 256K Kimi) instead of the SDK's fixed 16384 reserve, which
// drifts to ~94% on a 256K window and ~98% on 1M.
export const COMPACTION_TRIGGER_PERCENT = 0.8

// Default ceiling on the compaction trigger, independent of window size. The
// window-relative trigger alone optimizes for overflow avoidance, not token
// cost: at 80% of a large window a session accumulates ~160K (200K window) to
// ~800K (1M window) tokens of history that get re-shipped as `cacheRead` every
// turn before compaction ever fires. Capping the trigger bounds that
// steady-state re-read on big-window models; `min()` keeps the 80% behavior on
// small ones. The ceiling was 64K and is now 200K: at 64K a long investigation
// compacted every few turns (six times in forty minutes in one production
// channel session), and each summary dropped the raw evidence later turns had
// to reason over. Cached re-reads are cheap; losing the working set costs
// correctness. 200K stays 10x keepRecent (the >=3x invariant is asserted in
// the test), so a compaction never retriggers immediately. Each agent can set
// its own ceiling for its workload with `compaction.maxTriggerTokens` in
// typeclaw.json; this value is the default.
export const COMPACTION_ABSOLUTE_TRIGGER_TOKENS = 200_000

// Tokens to keep in the recent window after compaction. Fixed (not a
// percentage) because "recent context" is a property of conversation shape, not
// model capacity. Mirrors pi's DEFAULT_COMPACTION_SETTINGS.keepRecentTokens.
export const COMPACTION_KEEP_RECENT_TOKENS = 20_000

export function compactionTriggerTokens<TApi extends KnownApi>(
  model: Model<TApi>,
  maxTriggerTokens: number = COMPACTION_ABSOLUTE_TRIGGER_TOKENS,
): number {
  const windowRelative = Math.round(model.contextWindow * COMPACTION_TRIGGER_PERCENT)
  return Math.min(windowRelative, maxTriggerTokens)
}

export function reserveTokensForModel<TApi extends KnownApi>(model: Model<TApi>, maxTriggerTokens?: number): number {
  return Math.max(1, model.contextWindow - compactionTriggerTokens(model, maxTriggerTokens))
}

export function createCompactionSettingsManager<TApi extends KnownApi>(
  model: Model<TApi>,
  maxTriggerTokens?: number,
): SettingsManager {
  return SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: reserveTokensForModel(model, maxTriggerTokens),
      keepRecentTokens: COMPACTION_KEEP_RECENT_TOKENS,
    },
  })
}
