// The per-session prompt suffix (origin, role, git nudge) rides as the last
// section of the leading system message. pi renders sections in key order after
// the preamble, project context, skills, and cwd, so a section added here lands
// after all of them. It is added at request time and never persisted, so pi's
// own section diffing never sees it and never emits a patch for it.
const SESSION_TAIL_SECTION = 'typeclaw_session'

// Headers that only the session suffix renders. A persisted preamble that
// already carries one was written by the inline layout, before the suffix moved.
const INLINE_TAIL_MARKERS = ['## Session origin', '## Uncommitted changes at session start'] as const

type SystemLike = { role: string; sections?: Record<string, string | null> }
type EntryLike = { type: string; message?: { role?: string; sections?: Record<string, string | null> } }

// A resumed session keeps the layout it was created with: moving the suffix out
// of a preamble the model already saw would duplicate it in the leading prompt.
export function persistedPromptHasInlineSessionTail(entries: readonly EntryLike[]): boolean {
  const system = entries.find((entry) => entry.type === 'message' && entry.message?.role === 'system')
  const preamble = system?.message?.sections?.preamble
  return typeof preamble === 'string' && INLINE_TAIL_MARKERS.some((marker) => preamble.includes(marker))
}

export function appendSessionTail<T extends { role: string }>(messages: T[], tail: string): T[] {
  const [first, ...rest] = messages
  if (tail === '' || first === undefined || first.role !== 'system') return messages
  const system = first as T & SystemLike
  return [{ ...system, sections: { ...system.sections, [SESSION_TAIL_SECTION]: tail } }, ...rest]
}
