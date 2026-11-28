import type { Option } from '@clack/prompts'

type FuzzyFilter<Value> = (search: string, option: Option<Value>) => boolean

function optionHaystack<Value>(option: Option<Value>): string {
  const label = option.label ?? String(option.value)
  const hint = option.hint ?? ''
  return `${label} ${String(option.value)} ${hint}`.toLowerCase()
}

function isSubsequence(query: string, haystack: string): boolean {
  let i = 0
  for (let j = 0; j < haystack.length && i < query.length; j++) {
    if (haystack[j] === query[i]) i++
  }
  return i === query.length
}

// Words keep their inner "-", ".", "_" so "gpt4o" still abbreviates "gpt-4o",
// while spaces, "/", "(", "·" and other separators end a word. Combining
// marks (\p{M}) stay inside a word so scripts like Devanagari are not split at
// their vowel signs.
const WORD_SEPARATOR = /[^\p{L}\p{M}\p{N}._-]+/u

// Splitting the query on whitespace lets "gpt 5.5" match "GPT-5.5 Turbo": each
// token is matched independently, so the "-" inside "GPT-5.5" no longer breaks
// the search the way a plain substring "gpt 5.5" would. Tokens are
// order-independent so "turbo gpt" finds "GPT Turbo" too. A token matches as a
// substring anywhere, or as a subsequence of a single word; a subsequence over
// the whole haystack would let "sonnet" match the GPT-5.4 mini option by
// picking one letter from each word of its label and model ref:
// "Plu[s]/Pr[o] · GPT-5.4 mi[n]i ope[n]ai-cod[e]x/gp[t]-5.4-mini".
export function fuzzyMatch<Value>(search: string, option: Option<Value>): boolean {
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const haystack = optionHaystack(option)
  const words = haystack.split(WORD_SEPARATOR).filter(Boolean)
  return tokens.every((token) => haystack.includes(token) || words.some((word) => isSubsequence(token, word)))
}

export const fuzzyFilter: FuzzyFilter<unknown> = fuzzyMatch

export type { FuzzyFilter }
