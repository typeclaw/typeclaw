import { expect, test } from 'bun:test'

import { GUARD_ACKNOWLEDGEMENTS } from './guard-acknowledgements'

test('folds the exact model-facing acknowledgement keys for every supported tool', () => {
  expect(Object.fromEntries([...GUARD_ACKNOWLEDGEMENTS].map(([tool, keys]) => [tool, [...keys]]))).toEqual({
    read: ['imageReadRedirect'],
    write: ['nonWorkspaceWrite'],
    edit: ['nonWorkspaceWrite'],
    bash: ['globalInstall', 'nonBunPackageManager', 'nonBunPackageRunner'],
  })
})
