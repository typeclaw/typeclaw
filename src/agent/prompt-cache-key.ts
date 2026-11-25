import type { SessionOrigin } from './session-origin'

// Mirrors pi-ai's OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH, which pi applies before
// `onPayload` runs, so a replaced key must be bounded here too. Truncation can
// only merge two long-named origins into one cache bucket, which is harmless.
const PROMPT_CACHE_KEY_MAX_LENGTH = 64

// pi defaults OpenAI's `prompt_cache_key` to the session id, and OpenAI routes
// requests to cache machines by that key. Every new subagent/cron/channel
// session therefore landed on a cold machine and re-paid its whole ~10K-token
// system+tools prefix even though sibling sessions of the same kind had just
// sent the identical prefix. Keying by origin kind (and subagent/component
// name, whose prompts differ) lets those sessions share the warm prefix.
export function promptCacheKeyForOrigin(origin: SessionOrigin | undefined): string | undefined {
  const key = unboundedPromptCacheKey(origin)
  return key === undefined ? undefined : Array.from(key).slice(0, PROMPT_CACHE_KEY_MAX_LENGTH).join('')
}

function unboundedPromptCacheKey(origin: SessionOrigin | undefined): string | undefined {
  if (origin === undefined) return undefined
  switch (origin.kind) {
    case 'subagent':
      return `typeclaw:subagent:${origin.subagent}`
    case 'system':
      return `typeclaw:system:${origin.component}`
    case 'tui':
    case 'cron':
    case 'channel':
      return `typeclaw:${origin.kind}`
  }
}

// Providers route cache affinity by the stream `sessionId` pi turns into
// session-affinity headers (`session-id`, `x-session-affinity`, `x-affinity`, …)
// and default cache keys, so rewriting the body key alone does not reach a warm
// machine. On the ChatGPT Codex backend, a live probe of identical prefixes on
// fresh connections got 0% reuse with per-session ids and the same body key,
// and ~96% once the session id was shared. Short-lived subagent and system
// sessions therefore send their origin key as the session id on every
// provider, and each cron fire (a fresh session that repeats its job's prompt)
// shares one id per job. Long-lived tui/channel sessions keep their own id so
// one hot shared key cannot spill their long histories onto overflow machines.
// The id travels in HTTP headers, whose values must be Latin-1, so characters
// outside printable ASCII are percent-encoded. ASCII names stay identical to
// their body cache key.
export function sharedSessionIdForOrigin(origin: SessionOrigin | undefined): string | undefined {
  const shared =
    origin?.kind === 'subagent' || origin?.kind === 'system'
      ? unboundedPromptCacheKey(origin)!
      : origin?.kind === 'cron'
        ? `typeclaw:cron:${origin.jobId}`
        : undefined
  if (shared === undefined) return undefined
  const key = shared.replace(/[^\x20-\x7e]/gu, (char) => encodeURIComponent(char))
  return key.slice(0, PROMPT_CACHE_KEY_MAX_LENGTH)
}

// pi puts the system prompt in the Codex Responses top-level `instructions`.
// The ChatGPT Codex backend does not serve that field from the prompt cache
// for every model: on gpt-6.2-sol each follow-up request re-billed the whole
// system prompt uncached, while the same text as a leading developer input
// item was served from cache on every follow-up (terra cached both ways).
// `instructions` keeps pi's own fallback for an empty prompt, so the request
// shape stays one pi already sends.
const CODEX_PLACEHOLDER_INSTRUCTIONS = 'You are a helpful assistant.'

export function withInstructionsAsDeveloperInput(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) return payload
  const { instructions, input } = payload as { instructions?: unknown; input?: unknown }
  if (typeof instructions !== 'string' || !Array.isArray(input)) return payload
  return {
    ...payload,
    instructions: CODEX_PLACEHOLDER_INSTRUCTIONS,
    input: [{ role: 'developer', content: instructions }, ...input],
  }
}

// Rewrites only payloads that already carry a string `prompt_cache_key`, so
// providers without the field and `cacheRetention: 'none'` (which omits it)
// are left untouched.
export function withPromptCacheKey(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return payload
  if (typeof (payload as { prompt_cache_key?: unknown }).prompt_cache_key !== 'string') return payload
  return { ...payload, prompt_cache_key: key }
}
