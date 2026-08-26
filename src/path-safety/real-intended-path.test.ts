import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  RECOVER_MISSING_OR_UNSEARCHABLE_OR_NAME_TOO_LONG,
  RECOVER_MISSING,
  RECOVER_MISSING_OR_UNSEARCHABLE,
  realIntendedPath,
  realIntendedPathSync,
} from './real-intended-path'

function errno(code: string): Error {
  return Object.assign(new Error(`synthetic ${code}`), { code })
}

const FILESYSTEM_ROOT = path.parse(path.resolve(path.sep)).root

// Mimics a barrier the runtime cannot search: every candidate fails with `code`
// until the walk reaches the filesystem root, which always resolves.
function unsearchableUntilRoot(code: string): (candidate: string) => string {
  return (candidate) => {
    if (candidate === FILESYSTEM_ROOT) return FILESYSTEM_ROOT
    throw errno(code)
  }
}

describe('realIntendedPathSync — resolvable prefix', () => {
  test('resolves a symlinked ancestor and reattaches a non-existent tail', () => {
    // given a symlink whose target exists but whose child does not
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'typeclaw-intended-path-')))
    mkdirSync(path.join(root, 'real', 'target'), { recursive: true })
    symlinkSync(path.join(root, 'real', 'target'), path.join(root, 'link'), 'dir')

    // when the tail does not exist
    const resolved = realIntendedPathSync(path.join(root, 'link', 'missing.txt'), realpathSync.native)

    // then the symlink is collapsed and the tail reattached to the real target
    expect(resolved).toBe(path.join(root, 'real', 'target', 'missing.txt'))
  })
})

describe('realIntendedPathSync — unsearchable ancestor (the /root regression)', () => {
  test('EACCES walks to the root and returns the lexical path when opted in', () => {
    // given a mode-700 ancestor the runtime uid cannot traverse
    const target = path.join(path.resolve(path.sep, 'root'), '.config', 'agent-messenger', 'MEMORY.md')

    // when the denylist caller opts into EACCES recovery
    const resolved = realIntendedPathSync(target, unsearchableUntilRoot('EACCES'), {
      recoverable: RECOVER_MISSING_OR_UNSEARCHABLE,
    })

    // then canonicalization degrades to the lexical path instead of throwing
    expect(resolved).toBe(target)
  })

  test('EACCES on the leaf still resolves a denied symlinked parent', () => {
    // given a leaf that cannot be statted but a parent that resolves into a denied dir
    const parent = path.resolve(path.sep, 'agent', 'public', 'gate')
    const deniedReal = path.resolve(path.sep, 'agent', 'memory')
    const leaf = path.join(parent, 'MEMORY.md')

    // when the guard canonicalizes the leaf
    const resolved = realIntendedPathSync(
      leaf,
      (candidate) => {
        if (candidate === leaf) throw errno('EACCES')
        if (candidate === parent) return deniedReal
        throw errno('ENOENT')
      },
      { recoverable: RECOVER_MISSING_OR_UNSEARCHABLE },
    )

    // then the result lands under the denied directory, so the deny-list still matches
    expect(resolved).toBe(path.join(deniedReal, 'MEMORY.md'))
  })

  test('EACCES is NOT recoverable under the default (allowlist) set', () => {
    const target = path.join(path.resolve(path.sep, 'root'), 'secret')

    expect(() => realIntendedPathSync(target, unsearchableUntilRoot('EACCES'))).toThrow(/synthetic EACCES/)
    expect(() =>
      realIntendedPathSync(target, unsearchableUntilRoot('EACCES'), { recoverable: RECOVER_MISSING }),
    ).toThrow(/synthetic EACCES/)
  })
})

describe('realIntendedPathSync — oversized component', () => {
  test('ENAMETOOLONG walks to a resolvable prefix when denylist recovery is opted in', () => {
    const parent = path.resolve(path.sep, 'agent', 'public', 'gate')
    const oversized = '긴'.repeat(100)
    const leaf = path.join(parent, oversized)
    const deniedReal = path.resolve(path.sep, 'agent', 'memory')

    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(255)
    expect(
      realIntendedPathSync(
        leaf,
        (candidate) => {
          if (candidate === leaf) throw errno('ENAMETOOLONG')
          if (candidate === parent) return deniedReal
          throw errno('ENOENT')
        },
        { recoverable: RECOVER_MISSING_OR_UNSEARCHABLE_OR_NAME_TOO_LONG },
      ),
    ).toBe(path.join(deniedReal, oversized))
  })

  test('ENAMETOOLONG remains fatal under the default and allowlist-oriented sets', () => {
    const target = path.resolve(path.sep, 'agent', 'public', 'x')

    expect(() => realIntendedPathSync(target, unsearchableUntilRoot('ENAMETOOLONG'))).toThrow(/synthetic ENAMETOOLONG/)
    expect(() =>
      realIntendedPathSync(target, unsearchableUntilRoot('ENAMETOOLONG'), { recoverable: RECOVER_MISSING }),
    ).toThrow(/synthetic ENAMETOOLONG/)
    expect(() =>
      realIntendedPathSync(target, unsearchableUntilRoot('ENAMETOOLONG'), {
        recoverable: RECOVER_MISSING_OR_UNSEARCHABLE,
      }),
    ).toThrow(/synthetic ENAMETOOLONG/)
  })
})

describe('realIntendedPathSync — non-recoverable errors stay fatal', () => {
  for (const code of ['ELOOP', 'ENOTDIR', 'EPERM', 'EIO']) {
    test(`${code} rethrows even with the broadest recoverable set`, () => {
      const target = path.resolve(path.sep, 'agent', 'public', 'x')
      expect(() =>
        realIntendedPathSync(target, unsearchableUntilRoot(code), {
          recoverable: RECOVER_MISSING_OR_UNSEARCHABLE_OR_NAME_TOO_LONG,
        }),
      ).toThrow(new RegExp(`synthetic ${code}`))
    })
  }

  test('a non-errno throw rethrows', () => {
    const target = path.resolve(path.sep, 'agent', 'public', 'x')
    expect(() =>
      realIntendedPathSync(
        target,
        () => {
          throw new Error('bare failure')
        },
        { recoverable: RECOVER_MISSING_OR_UNSEARCHABLE_OR_NAME_TOO_LONG },
      ),
    ).toThrow(/bare failure/)
  })
})

describe('realIntendedPathSync — exhaustion behavior', () => {
  test('onExhausted "throw" reports an unresolvable path', () => {
    const target = path.resolve(path.sep, 'agent', 'x')
    expect(() =>
      realIntendedPathSync(
        target,
        () => {
          throw errno('ENOENT')
        },
        { onExhausted: 'throw' },
      ),
    ).toThrow(/could not resolve existing parent/)
  })

  test('onExhausted "return-input" falls back to the lexical input', () => {
    const target = path.resolve(path.sep, 'agent', 'x')
    const resolved = realIntendedPathSync(
      target,
      () => {
        throw errno('ENOENT')
      },
      { onExhausted: 'return-input' },
    )
    expect(resolved).toBe(target)
  })
})

describe('realIntendedPath (async) mirrors the sync variant', () => {
  test('resolves a symlinked ancestor and reattaches a non-existent tail', async () => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'typeclaw-intended-path-async-')))
    mkdirSync(path.join(root, 'real', 'target'), { recursive: true })
    symlinkSync(path.join(root, 'real', 'target'), path.join(root, 'link'), 'dir')

    const resolved = await realIntendedPath(path.join(root, 'link', 'missing.txt'), realpath)

    expect(resolved).toBe(path.join(root, 'real', 'target', 'missing.txt'))
  })

  test('EACCES rejects under the default set and recovers under the opt-in set', async () => {
    const target = path.join(path.resolve(path.sep, 'root'), '.config', 'x')
    const failing = async (candidate: string) => unsearchableUntilRoot('EACCES')(candidate)

    await expect(realIntendedPath(target, failing)).rejects.toThrow(/synthetic EACCES/)
    await expect(realIntendedPath(target, failing, { recoverable: RECOVER_MISSING_OR_UNSEARCHABLE })).resolves.toBe(
      target,
    )
  })
})
