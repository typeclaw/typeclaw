import { describe, expect, test } from 'bun:test'

import { rewriteCell, topLevelDeclarationsToVar } from './redeclare'

describe('topLevelDeclarationsToVar', () => {
  test('rewrites top-level const and let, including destructuring', () => {
    expect(topLevelDeclarationsToVar('const [a, b] = x; let {c} = y\nconst d = 1')).toBe(
      'var [a, b] = x; var {c} = y\nvar d = 1',
    )
  })

  test('leaves nested scopes, loops and callbacks alone', () => {
    const code = 'for (const x of xs) { const y = x }\nfunction f() { let z = 1 }\nxs.map((v) => { const w = v })'
    expect(topLevelDeclarationsToVar(code)).toBe(code)
  })

  test('ignores keywords inside strings, templates, comments and regex literals', () => {
    const code =
      'print(\'const a = 1\', "let b"); // const c = 1\n/* let d = 1 */ const re = /const e/g; print(`const ${`let f`} ${{ g: 1 }.g}`)'
    expect(topLevelDeclarationsToVar(code)).toBe(code.replace('const re', 'var re'))
  })

  test('treats / after a control header as a regex and after a call as division', () => {
    const code = 'if (true) /const [a-z]+/.test("x")\nwhile (x) /let/g.exec(s)\nconst half = f(x) / 2 / g(y)'
    expect(topLevelDeclarationsToVar(code)).toBe(code.replace('const half', 'var half'))
  })

  test('keeps non-ASCII text intact', () => {
    expect(topLevelDeclarationsToVar("const 메모 = '배포 const'")).toBe("var 메모 = '배포 const'")
  })

  test('leaves property access named let or const alone', () => {
    expect(topLevelDeclarationsToVar('o.const = 1; o.let = 2')).toBe('o.const = 1; o.let = 2')
  })

  test('reports top-level binding names but not initializers, nested scopes or strings', () => {
    const code =
      'const [old, tool] = await f(text); let n\nprint(n); var {a, b} = g()\nfunction h() { const inner = 1 } const s = "const q = 1"'
    expect(rewriteCell(code).declared).toEqual(['old', 'tool', 'n', 'a', 'b', 's'])
  })

  test('resumes after each declarator comma, including across a line break', () => {
    const code = 'const result = await f({a: 1, b}), text = result\nlet x = g(1, 2),\n  print = 3\nh(y, z)'
    expect(rewriteCell(code).declared).toEqual(['result', 'text', 'x', 'print'])
  })
})
