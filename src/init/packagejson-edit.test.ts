import { describe, expect, test } from 'bun:test'

import { editDependencySpec, type ParsedPackage } from './packagejson-edit'

function pkgFrom(raw: string): ParsedPackage {
  return { raw, parsed: JSON.parse(raw) as ParsedPackage['parsed'] }
}

describe('editDependencySpec', () => {
  test('rewrites only dependencies.typeclaw, leaving devDependencies.typeclaw untouched', () => {
    const raw = `{
  "name": "agent",
  "devDependencies": {
    "typeclaw": "do-not-touch"
  },
  "dependencies": {
    "typeclaw": "^0.39.0"
  }
}
`

    const next = editDependencySpec(pkgFrom(raw), 'typeclaw', 'file:../typeclaw')

    const parsed = JSON.parse(next) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(parsed.dependencies.typeclaw).toBe('file:../typeclaw')
    expect(parsed.devDependencies.typeclaw).toBe('do-not-touch')
  })

  test('preserves indentation, key order, unrelated fields, and trailing newline', () => {
    const raw = `{
  "name": "agent",
  "private": true,
  "dependencies": {
    "zod": "^4.0.0",
    "typeclaw": "^0.39.0",
    "citty": "^0.2.2"
  }
}
`

    const next = editDependencySpec(pkgFrom(raw), 'typeclaw', '^0.40.0')

    expect(next).toBe(`{
  "name": "agent",
  "private": true,
  "dependencies": {
    "zod": "^4.0.0",
    "typeclaw": "^0.40.0",
    "citty": "^0.2.2"
  }
}
`)
  })

  test('respects tab indentation', () => {
    const raw = '{\n\t"dependencies": {\n\t\t"typeclaw": "^0.39.0"\n\t}\n}\n'

    const next = editDependencySpec(pkgFrom(raw), 'typeclaw', '^0.40.0')

    expect(next).toContain('\t\t"typeclaw": "^0.40.0"')
  })

  test('falls back to JSON round-trip when the dependency is absent (adds it scoped to dependencies)', () => {
    const raw = `{
  "name": "agent",
  "dependencies": {
    "zod": "^4.0.0"
  }
}
`

    const next = editDependencySpec(pkgFrom(raw), 'typeclaw', '^0.40.0')

    const parsed = JSON.parse(next) as { dependencies: Record<string, string> }
    expect(parsed.dependencies.typeclaw).toBe('^0.40.0')
    expect(parsed.dependencies.zod).toBe('^4.0.0')
  })

  test('is not fooled by a "dependencies" substring inside a string value', () => {
    const raw = `{
  "description": "manages dependencies for agents",
  "dependencies": {
    "typeclaw": "^0.39.0"
  }
}
`

    const next = editDependencySpec(pkgFrom(raw), 'typeclaw', '^0.40.0')

    const parsed = JSON.parse(next) as {
      description: string
      dependencies: Record<string, string>
    }
    expect(parsed.description).toBe('manages dependencies for agents')
    expect(parsed.dependencies.typeclaw).toBe('^0.40.0')
  })
})
