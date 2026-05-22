// Citation format: `memory/yyyy-MM-dd#<fragment-id>`. The id is the full
// UUIDv7 of the fragment event in the daily JSONL stream. The date prefix is
// redundant with the id's timestamp (UUIDv7 encodes minting time in the first
// 48 bits) but kept for human grep-ability — readers should be able to see
// "this came from yesterday's stream" without parsing the id.
//
// The format does NOT accept line ranges. The prior `:43-45` shape is gone
// (see the "drop backward compat" decision in the PR description). Parsing
// silently ignores any line in MEMORY.md that doesn't match this exact shape,
// so legacy citations from before the cutover are dropped — they no longer
// pin fragments alive against compaction.

const CITATION_LINE = /^[\s-]*(?:memory|streams)\/(\d{4}-\d{2}-\d{2})#([\w-]+)\s*$/im

const CITATION_LINE_GLOBAL = /(?:memory|streams)\/(\d{4}-\d{2}-\d{2})#([\w-]+)/g

export type Citation = { date: string; fragmentId: string }

export function formatCitation(date: string, fragmentId: string): string {
  return `streams/${date}#${fragmentId}`
}

// Parse every citation in `text` and return them grouped by date. The
// returned Map is empty when no citations appear. Used by:
//   - dreaming.ts compaction to decide which fragments are still referenced
//     by MEMORY.md and must survive GC.
//   - tests pinning the format.
export function parseCitations(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const match of text.matchAll(CITATION_LINE_GLOBAL)) {
    const date = match[1]!
    const fragmentId = match[2]!
    let set = out.get(date)
    if (set === undefined) {
      set = new Set<string>()
      out.set(date, set)
    }
    set.add(fragmentId)
  }
  return out
}

export function isCitationLine(line: string): boolean {
  return CITATION_LINE.test(line)
}
