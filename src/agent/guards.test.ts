import { describe, expect, test } from 'bun:test'

import { CORE_TOOL_NAMES } from '@/plugin/core-tool-names'

import { buildInternalGuards, validateInternalGuardDeclarations } from './guards'

describe('internal guards', () => {
  test('builds the five bundled guards against the core tool catalog', () => {
    const guards = buildInternalGuards('/agent')

    expect(guards.map((guard) => `${guard.owner}.${guard.key}`)).toEqual([
      'guard.imageReadRedirect',
      'guard.nonWorkspaceWrite',
      'bun-hygiene.globalInstall',
      'bun-hygiene.nonBunPackageManager',
      'bun-hygiene.nonBunPackageRunner',
    ])
    expect(CORE_TOOL_NAMES.has('look_at')).toBe(true)
  })

  test('rejects a nonexistent target in the finalized tool catalog', () => {
    expect(() =>
      validateInternalGuardDeclarations(
        [{ owner: 'guard', key: 'typoTarget', tools: ['wirte'], check: () => undefined }],
        CORE_TOOL_NAMES,
      ),
    ).toThrow('targets nonexistent tool "wirte"')
  })

  test('accepts look_at from the shared core tool catalog', () => {
    expect(() =>
      validateInternalGuardDeclarations(
        [{ owner: 'guard', key: 'confirmImage', tools: ['look_at'], check: () => undefined }],
        CORE_TOOL_NAMES,
      ),
    ).not.toThrow()
  })

  test('rejects duplicate, malformed, and reserved declarations', () => {
    const declaration = { owner: 'guard', key: 'sameKey', tools: ['write'] as const, check: () => undefined }
    expect(() => validateInternalGuardDeclarations([declaration, declaration], CORE_TOOL_NAMES)).toThrow(
      'duplicate internal guard key',
    )
    expect(() => validateInternalGuardDeclarations([{ ...declaration, key: 'Bad-key' }], CORE_TOOL_NAMES)).toThrow(
      'does not match',
    )
    expect(() =>
      validateInternalGuardDeclarations([{ ...declaration, key: 'acknowledgeGuards' }], CORE_TOOL_NAMES),
    ).toThrow('collides with the acknowledgement structure')
    expect(() =>
      validateInternalGuardDeclarations([{ ...declaration, tools: ['write', 'write'] }], CORE_TOOL_NAMES),
    ).toThrow('has duplicate tool names')
  })
})
