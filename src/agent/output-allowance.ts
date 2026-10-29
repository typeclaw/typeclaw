export const DEFAULT_MAX_OUTPUT_TOKENS = 32_000

// The output cap every session request sends when the caller set none.
// Undefined leaves the provider's own default in place.
export function defaultOutputAllowance(model: { maxTokens: number }): number | undefined {
  return model.maxTokens > 0 ? Math.min(model.maxTokens, DEFAULT_MAX_OUTPUT_TOKENS) : undefined
}
