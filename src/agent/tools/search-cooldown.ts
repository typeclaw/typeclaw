// Process-wide cooldowns for the keyless web search engines.
//
// Every engine web_search can reach is a free public service that rate-limits
// by source IP, and the whole agent egresses from one IP. Once an engine blocks
// us (CAPTCHA, 429, 403, network failure), each further request tends to keep
// the block alive, so the engine is paused instead: calls inside the window
// skip it without touching the network and the chain moves on to the next
// engine.
//
// The first block pauses an engine for ENGINE_COOLDOWN_BASE_MS; each further
// block in a row doubles the pause up to ENGINE_COOLDOWN_MAX_MS. A Retry-After
// hint can lengthen the pause, never beyond the cap. One successful answer
// clears the engine's record. A block reported while the engine is already
// paused (a concurrent request that raced into the same block) extends nothing
// but a longer Retry-After and does not count as another block in a row.
//
// Concurrent requests can finish out of order: a request sent before a block
// may succeed after it. Each block bumps the engine's generation, and a
// success only clears the cooldown when no block was recorded since that
// request was sent, so a stale success never lifts a newer pause.

export type SearchEngineId = 'native-chatgpt' | 'native-claude' | 'exa' | 'ddg'

export type SearchBlockReason = 'challenge' | 'rate_limited' | 'forbidden' | 'network'

export const ENGINE_COOLDOWN_BASE_MS = 60_000
export const ENGINE_COOLDOWN_MAX_MS = 15 * 60_000

type Cooldown = { blocks: number; until: number; reason: SearchBlockReason }

export type ActiveCooldown = { remainingMs: number; reason: SearchBlockReason }

const cooldowns = new Map<SearchEngineId, Cooldown>()
const generations = new Map<SearchEngineId, number>()
let now: () => number = () => Date.now()

// Test-only seam: clears every cooldown and swaps the clock (null restores Date.now).
export function _resetSearchCooldownsForTest(clock: (() => number) | null = null): void {
  cooldowns.clear()
  generations.clear()
  now = clock ?? (() => Date.now())
}

export function blockGeneration(engine: SearchEngineId): number {
  return generations.get(engine) ?? 0
}

export function activeCooldown(engine: SearchEngineId): ActiveCooldown | undefined {
  const cooldown = cooldowns.get(engine)
  const remainingMs = cooldown ? cooldown.until - now() : 0
  return cooldown && remainingMs > 0 ? { remainingMs, reason: cooldown.reason } : undefined
}

export function recordEngineBlock(engine: SearchEngineId, reason: SearchBlockReason, retryAfterMs?: number): void {
  generations.set(engine, blockGeneration(engine) + 1)
  const at = now()
  const requested = Math.min(ENGINE_COOLDOWN_MAX_MS, Math.max(0, retryAfterMs ?? 0))
  const previous = cooldowns.get(engine)
  if (previous && previous.until > at) {
    previous.until = Math.max(previous.until, at + requested)
    return
  }
  const blocks = (previous?.blocks ?? 0) + 1
  const backoff = Math.min(ENGINE_COOLDOWN_MAX_MS, ENGINE_COOLDOWN_BASE_MS * 2 ** (blocks - 1))
  cooldowns.set(engine, { blocks, until: at + Math.max(backoff, requested), reason })
}

// `sentAtGeneration` is blockGeneration(engine) read just before the request went out.
export function recordEngineSuccess(engine: SearchEngineId, sentAtGeneration: number): void {
  if (blockGeneration(engine) !== sentAtGeneration) return
  cooldowns.delete(engine)
}
