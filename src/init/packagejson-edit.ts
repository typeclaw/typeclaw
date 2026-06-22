import { writeFile } from 'node:fs/promises'

// Scoped, formatting-preserving edit of a single `dependencies.<name>` spec in
// a package.json. Extracted from auto-upgrade.ts so the dev-dep switch command
// can reuse the exact same battle-tested edit instead of duplicating it.
//
// The naive `raw.replace(/"name":.../)` is unscoped: it silently rewrites a
// `devDependencies.<name>` entry that appears before `dependencies.<name>` in
// the file. We slice the dependencies object's textual range, edit inside it,
// then splice back to preserve whitespace, key order, and trailing newline. If
// the slice fails (unusual JSON shape), fall back to a full JSON round-trip —
// formatting churn is acceptable; silently updating the wrong key is not.

export type ParsedPackage = {
  raw: string
  parsed: { dependencies?: Record<string, string> } & Record<string, unknown>
}

export async function writeDependencySpec(
  packageJsonPath: string,
  pkg: ParsedPackage,
  name: string,
  newSpec: string,
): Promise<void> {
  await writeFile(packageJsonPath, editDependencySpec(pkg, name, newSpec))
}

// Pure: returns the new package.json text without touching the filesystem, so
// the scoped-edit invariants (key isolation, whitespace preservation, fallback)
// are unit-testable without a tmp dir.
export function editDependencySpec(pkg: ParsedPackage, name: string, newSpec: string): string {
  const { raw, parsed } = pkg
  const scoped = sliceDependenciesRange(raw, parsed)
  if (scoped !== null) {
    const { start, end } = scoped
    const block = raw.slice(start, end)
    const keyPattern = new RegExp(`(${escapeRegExp(JSON.stringify(name))}\\s*:\\s*)"[^"]+"`)
    const replaced = block.replace(keyPattern, (_m, prefix: string) => `${prefix}${JSON.stringify(newSpec)}`)
    if (replaced !== block) {
      return `${raw.slice(0, start)}${replaced}${raw.slice(end)}`
    }
  }
  const deps = { ...parsed.dependencies, [name]: newSpec }
  const next = { ...parsed, dependencies: deps }
  const indent = detectIndent(raw)
  return `${JSON.stringify(next, null, indent)}\n`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Returns the [start, end) byte range of the "dependencies" object's value in
// `raw`, or null if it can't be located unambiguously. Uses a brace-counting
// tokenizer that respects string literals so a `dependencies` key inside a
// string value (e.g. inside a `description`) cannot fool it.
function sliceDependenciesRange(raw: string, parsed: ParsedPackage['parsed']): { start: number; end: number } | null {
  if (parsed.dependencies === undefined || parsed.dependencies === null) return null
  const keyMatch = raw.match(/"dependencies"\s*:\s*\{/)
  if (!keyMatch || keyMatch.index === undefined) return null
  const startOfOpenBrace = keyMatch.index + keyMatch[0].length - 1
  const closeBrace = findMatchingCloseBrace(raw, startOfOpenBrace)
  if (closeBrace === null) return null
  return { start: startOfOpenBrace, end: closeBrace + 1 }
}

function findMatchingCloseBrace(raw: string, openIndex: number): number | null {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = openIndex; i < raw.length; i++) {
    const ch = raw[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return null
}

function detectIndent(raw: string): number | string {
  // Default to 2 — matches `JSON.stringify(_, _, 2)` behavior and the
  // project's existing scaffold style. Only override when we can see a clear
  // non-2 indent on the first indented line.
  const match = raw.match(/\n([\t ]+)\S/)
  if (!match) return 2
  const sample = match[1]!
  if (sample.startsWith('\t')) return '\t'
  return sample.length
}
