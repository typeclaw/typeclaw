import { parseCitations } from './citations'

export type CitationSupersetVerdict = { ok: true } | { ok: false; missing: Array<{ date: string; fragmentId: string }> }

export function checkCitationSuperset(oldText: string, newText: string): CitationSupersetVerdict {
  const oldCitations = parseCitations(oldText)
  if (oldCitations.size === 0) return { ok: true }

  const newCitations = parseCitations(newText)
  const missing: Array<{ date: string; fragmentId: string }> = []

  const dates = [...oldCitations.keys()].sort()
  for (const date of dates) {
    const oldIds = oldCitations.get(date) ?? new Set<string>()
    const newIds = newCitations.get(date) ?? new Set<string>()
    const oldIdList = [...oldIds].sort()
    for (const id of oldIdList) {
      if (!newIds.has(id)) missing.push({ date, fragmentId: id })
    }
  }

  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

export function checkCitationSupersetAcrossFiles(
  oldFiles: ReadonlyMap<string, string>,
  newFiles: ReadonlyMap<string, string>,
): CitationSupersetVerdict {
  const oldUnion = unionCitations(oldFiles)
  if (oldUnion.size === 0) return { ok: true }

  const newUnion = unionCitations(newFiles)
  const missing: Array<{ date: string; fragmentId: string }> = []

  const dates = [...oldUnion.keys()].sort()
  for (const date of dates) {
    const oldIds = oldUnion.get(date) ?? new Set<string>()
    const newIds = newUnion.get(date) ?? new Set<string>()
    const oldIdList = [...oldIds].sort()
    for (const id of oldIdList) {
      if (!newIds.has(id)) missing.push({ date, fragmentId: id })
    }
  }

  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

function unionCitations(files: ReadonlyMap<string, string>): Map<string, Set<string>> {
  const union = new Map<string, Set<string>>()
  for (const [, text] of files) {
    const citations = parseCitations(text)
    for (const [date, ids] of citations) {
      const existing = union.get(date)
      if (existing === undefined) {
        union.set(date, new Set(ids))
      } else {
        for (const id of ids) existing.add(id)
      }
    }
  }
  return union
}

export function summarizeMissingCitations(missing: ReadonlyArray<{ date: string; fragmentId: string }>): string {
  const total = missing.length
  const sample = missing.slice(0, 3).map((m) => `${m.date}#${m.fragmentId}`)
  if (total <= 3) return sample.join(', ')
  return `${sample.join(', ')} (+${total - 3} more)`
}
