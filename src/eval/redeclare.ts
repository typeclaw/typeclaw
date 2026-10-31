// Kernel-child helper, so it must stay dependency-free (see entry.ts).
//
// Models habitually reuse names like `const [a, b] = ...` across cells, and a
// REPL keeps top-level lexical bindings, so a later cell fails with "Can't
// create duplicate variable". A var cannot shadow an existing const either, so
// every cell's top-level const/let becomes var before it runs. Nested scopes
// keep their block semantics.
const REGEX_PRECEDERS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''))
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'await', 'yield', 'case', 'in', 'of', 'void', 'delete', 'new'])
const CONTROL_HEADERS = new Set(['if', 'while', 'for', 'with'])

export function topLevelDeclarationsToVar(code: string): string {
  let out = ''
  let depth = 0
  // Brace depths at which an open `${` returns to its enclosing template.
  const templates: number[] = []
  // Whether each open `(` is a control header: `/` after `if (x)` starts a
  // regex, while `/` after a call like `f(x)` is division.
  const parens: boolean[] = []
  let previous = ''
  let word = ''
  let i = 0
  const isIdent = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_$]/u.test(c)

  const readTemplate = () => {
    while (i < code.length) {
      const c = code[i]
      if (c === '\\') {
        out += code.slice(i, i + 2)
        i += 2
        continue
      }
      if (c === '`') {
        out += c
        i += 1
        return
      }
      if (c === '$' && code[i + 1] === '{') {
        out += '${'
        i += 2
        templates.push(depth)
        depth += 1
        return
      }
      out += c
      i += 1
    }
  }

  while (i < code.length) {
    const c = code[i] as string
    const next = code[i + 1]
    if (c === '/' && next === '/') {
      const end = code.indexOf('\n', i)
      const stop = end === -1 ? code.length : end
      out += code.slice(i, stop)
      i = stop
      continue
    }
    if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2)
      const stop = end === -1 ? code.length : end + 2
      out += code.slice(i, stop)
      i = stop
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < code.length && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1
      out += code.slice(i, j + 1)
      i = j + 1
      previous = c
      word = ''
      continue
    }
    if (c === '`') {
      out += c
      i += 1
      readTemplate()
      previous = '`'
      word = ''
      continue
    }
    if (c === '/' && (previous === '' || REGEX_PRECEDERS.has(previous) || REGEX_KEYWORDS.has(word))) {
      let j = i + 1
      let inClass = false
      while (j < code.length && code[j] !== '\n') {
        if (code[j] === '\\') j += 1
        else if (code[j] === '[') inClass = true
        else if (code[j] === ']') inClass = false
        else if (code[j] === '/' && !inClass) break
        j += 1
      }
      j += 1
      while (isIdent(code[j])) j += 1
      out += code.slice(i, j)
      i = j
      previous = '/'
      word = ''
      continue
    }
    if (isIdent(c)) {
      let j = i
      while (isIdent(code[j])) j += 1
      const token = code.slice(i, j)
      if (
        depth === 0 &&
        (token === 'const' || token === 'let') &&
        code[i - 1] !== '.' &&
        /^\s*[[{\p{L}_$]/u.test(code.slice(j))
      ) {
        out += 'var'
      } else {
        out += token
      }
      i = j
      previous = token.at(-1) as string
      word = token
      continue
    }
    if (c === '(') parens.push(CONTROL_HEADERS.has(word))
    if (c === '(' || c === '[' || c === '{') depth += 1
    if (c === ')' && parens.pop() === true) {
      depth -= 1
      out += c
      i += 1
      previous = ';'
      word = ''
      continue
    }
    if (c === ')' || c === ']' || c === '}') {
      depth -= 1
      if (c === '}' && templates.at(-1) === depth) {
        templates.pop()
        out += c
        i += 1
        readTemplate()
        previous = '`'
        word = ''
        continue
      }
    }
    out += c
    i += 1
    if (!/\s/.test(c)) {
      previous = c
      word = ''
    }
  }
  return out
}
