import type { KnownApi, Model } from '@mariozechner/pi-ai'
import { SettingsManager } from '@mariozechner/pi-coding-agent'

// Compaction trigger threshold expressed as a percentage of the model's
// context window. pi-coding-agent's auto-compaction fires when
// `contextTokens > contextWindow - reserveTokens`. To honor a percentage-
// based intent across models with very different window sizes (200K Claude
// vs. 1M Gemini vs. 256K Kimi), we derive `reserveTokens` per-model from
// the model's `contextWindow`. SDK defaults (16384 reserve) are a fixed
// number of tokens that drift in relative terms across models — at 256K
// that's ~6% headroom (94% trigger), at 1M it's ~1.6% (98% trigger). A
// percentage-derived reserve trips at the same fraction regardless of
// model, which is what we actually want.
//
// 0.7 (was 0.8) lowers the trigger from 80% to 70% of the window. The
// previous 80% setting waited until very close to context exhaustion before
// compacting, which meant a long-lived channel session that gradually
// accumulated many normal turns would spend a meaningful chunk of its life
// shipping a near-maximum context to the LLM on every prompt. Empirically:
// a kakao session that had only ~75K tokens (29% of 256K) but 3.5MB on disk
// — bloated by one oversized tool result — could not be helped by
// compaction because the token threshold wasn't reached. That specific
// shape is handled by the tool-result-cap plugin. This change addresses
// the orthogonal "many normal turns" case: at 70% we compact 10 percentage
// points earlier, freeing context bandwidth for the upcoming turn's
// thinking + tool calls without sacrificing recent history (which is still
// preserved verbatim per COMPACTION_KEEP_RECENT_TOKENS).
export const COMPACTION_TRIGGER_PERCENT = 0.7

// Tokens to keep in the recent window after compaction. Fixed (not a
// percentage) because "recent context" is a property of conversation
// shape, not model capacity — the same recent ~20K is roughly the right
// amount of history regardless of whether the model has 200K or 1M total.
// Mirrors pi's DEFAULT_COMPACTION_SETTINGS.keepRecentTokens.
export const COMPACTION_KEEP_RECENT_TOKENS = 20_000

export function reserveTokensForModel<TApi extends KnownApi>(model: Model<TApi>): number {
  return Math.max(1, Math.round(model.contextWindow * (1 - COMPACTION_TRIGGER_PERCENT)))
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
