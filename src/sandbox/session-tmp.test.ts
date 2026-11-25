import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  __setSessionTmpRenameForTesting,
  enterSubagentTmpScope,
  ensureSessionTmpDir,
  holdSessionTmp,
  isUnderTmp,
  leaseSessionTmp,
  mapVirtualTmpPath,
  SESSION_TMP_ROOT,
  sessionTmpDir,
  sweepSessionTmp,
} from './session-tmp'

describe('session-tmp path mapping', () => {
  test('sessionTmpDir namespaces by session id under the shared root', () => {
    expect(sessionTmpDir('abc')).toBe(`${SESSION_TMP_ROOT}/abc`)
  })

  test('maps an absolute /tmp path to the session backing dir', () => {
    expect(mapVirtualTmpPath('/agent', 'sid', '/tmp/review.json')).toBe(`${SESSION_TMP_ROOT}/sid/review.json`)
  })

  test('maps a nested /tmp path preserving subdirs', () => {
    expect(mapVirtualTmpPath('/agent', 'sid', '/tmp/sub/dir/f.txt')).toBe(`${SESSION_TMP_ROOT}/sid/sub/dir/f.txt`)
  })

  test('maps bare /tmp to the session root', () => {
    expect(mapVirtualTmpPath('/agent', 'sid', '/tmp')).toBe(`${SESSION_TMP_ROOT}/sid`)
  })

  test('returns undefined for a non-/tmp absolute path', () => {
    expect(mapVirtualTmpPath('/agent', 'sid', '/etc/passwd')).toBeUndefined()
  })

  test('returns undefined for a relative path resolved inside the agent dir', () => {
    expect(mapVirtualTmpPath('/agent', 'sid', 'workspace/x.json')).toBeUndefined()
  })

  test('does not redirect project paths when the agent fixture itself is under /tmp', () => {
    expect(isUnderTmp('/tmp/typeclaw-agent', 'workspace/x.json')).toBe(false)
    expect(mapVirtualTmpPath('/tmp/typeclaw-agent', 'sid', '.')).toBeUndefined()
  })

  test('does not treat a /tmpfoo sibling as under /tmp', () => {
    expect(mapVirtualTmpPath('/agent', 'sid', '/tmpfoo/x')).toBeUndefined()
    expect(isUnderTmp('/agent', '/tmpfoo/x')).toBe(false)
  })

  test('isUnderTmp matches /tmp and its children only', () => {
    expect(isUnderTmp('/agent', '/tmp/x')).toBe(true)
    expect(isUnderTmp('/agent', '/tmp')).toBe(true)
    expect(isUnderTmp('/agent', 'workspace/x')).toBe(false)
  })
})

describe('session-tmp subagent scope', () => {
  test('a subagent tree shares its top-level subagent scratch, never the spawning session scratch', () => {
    const releaseReviewer = enterSubagentTmpScope('tree-reviewer', 'tree-channel')
    const releaseExplorer = enterSubagentTmpScope('tree-explorer', 'tree-reviewer')

    expect(sessionTmpDir('tree-channel')).toBe(`${SESSION_TMP_ROOT}/tree-channel`)
    expect(sessionTmpDir('tree-reviewer')).toBe(`${SESSION_TMP_ROOT}/tree-reviewer`)
    expect(mapVirtualTmpPath('/agent', 'tree-explorer', '/tmp/review-checkout-x/a.md')).toBe(
      `${SESSION_TMP_ROOT}/tree-reviewer/review-checkout-x/a.md`,
    )
    expect(sessionTmpDir('tree-unrelated')).toBe(`${SESSION_TMP_ROOT}/tree-unrelated`)

    releaseExplorer()
    releaseReviewer()
  })

  test('sibling top-level subagents of one session do not share scratch', () => {
    const releaseFirst = enterSubagentTmpScope('sib-a', 'sib-channel')
    const releaseSecond = enterSubagentTmpScope('sib-b', 'sib-channel')

    expect(sessionTmpDir('sib-a')).not.toBe(sessionTmpDir('sib-b'))

    releaseFirst()
    releaseSecond()
  })

  test('a descendant keeps the anchor scratch after its intermediate parent is released', () => {
    const releaseReviewer = enterSubagentTmpScope('keep-reviewer', 'keep-channel')
    const releaseChild = enterSubagentTmpScope('keep-child', 'keep-reviewer')
    const releaseGrandchild = enterSubagentTmpScope('keep-grandchild', 'keep-child')

    releaseChild()

    expect(sessionTmpDir('keep-grandchild')).toBe(`${SESSION_TMP_ROOT}/keep-reviewer`)
    releaseGrandchild()
    releaseReviewer()
    expect(sessionTmpDir('keep-grandchild')).toBe(`${SESSION_TMP_ROOT}/keep-grandchild`)
  })

  test('an entry stays until every registration for the session is released', () => {
    const releaseReviewer = enterSubagentTmpScope('ref-reviewer', 'ref-channel')
    const first = enterSubagentTmpScope('ref-child', 'ref-reviewer')
    const second = enterSubagentTmpScope('ref-child', 'ref-reviewer')

    first()
    expect(sessionTmpDir('ref-child')).toBe(`${SESSION_TMP_ROOT}/ref-reviewer`)
    second()
    expect(sessionTmpDir('ref-child')).toBe(`${SESSION_TMP_ROOT}/ref-child`)
    releaseReviewer()
  })
})

describe('session-tmp lifetime', () => {
  test('a session scratch dir is discarded when its session releases it', async () => {
    // given
    const sessionId = `life-${randomUUID()}`
    const release = holdSessionTmp(sessionId)
    const dir = await ensureSessionTmpDir(sessionId)
    await writeFile(join(dir, 'checkout.txt'), 'x')

    // when
    await release()

    // then
    expect(existsSync(dir)).toBe(false)
  })

  test('a subagent tree keeps its shared scratch until the last session in it releases', async () => {
    // given
    const anchor = `tree-${randomUUID()}`
    const child = `${anchor}-child`
    const leaveAnchor = enterSubagentTmpScope(anchor, 'tree-channel')
    const leaveChild = enterSubagentTmpScope(child, anchor)
    const releaseAnchor = holdSessionTmp(anchor)
    const releaseChild = holdSessionTmp(child)
    const dir = await ensureSessionTmpDir(child)

    // when
    await releaseAnchor()

    // then
    expect(existsSync(dir)).toBe(true)
    await releaseChild()
    expect(existsSync(dir)).toBe(false)
    leaveChild()
    leaveAnchor()
  })

  test('the sweep removes stale unheld dirs and keeps held or recently touched ones', async () => {
    // given
    const root = await mkdtemp(join(tmpdir(), 'session-tmp-sweep-'))
    const now = Date.now()
    const old = new Date(now - 2 * 60 * 60 * 1000)
    const stale = `stale-${randomUUID()}`
    const held = `held-${randomUUID()}`
    const fresh = `fresh-${randomUUID()}`
    for (const name of [stale, held, fresh]) await mkdir(join(root, name, 'review-checkout-a'), { recursive: true })
    await utimes(join(root, stale), old, old)
    await utimes(join(root, held), old, old)
    await mkdir(join(root, '.discard-crashed-mid-delete'))
    const release = holdSessionTmp(held)

    try {
      // when
      const removed = await sweepSessionTmp({ root, now })

      // then
      expect(removed).toBe(1)
      expect((await readdir(root)).sort()).toEqual([fresh, held].sort())
    } finally {
      await release()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('the boot sweep removes every unheld dir regardless of age', async () => {
    // given
    const root = await mkdtemp(join(tmpdir(), 'session-tmp-boot-'))
    await mkdir(join(root, `fresh-${randomUUID()}`))

    try {
      // when
      const removed = await sweepSessionTmp({ root, minAgeMs: 0 })

      // then
      expect(removed).toBe(1)
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('a malformed session id never directs the discard outside the scratch root', async () => {
    // given
    const name = `session-tmp-victim-${randomUUID()}`
    const victim = join(SESSION_TMP_ROOT, '..', name)
    await mkdir(victim, { recursive: true })
    await writeFile(join(victim, 'keep.txt'), 'x')
    const release = holdSessionTmp(`../${name}`)

    try {
      // when
      await release()

      // then
      expect(existsSync(join(victim, 'keep.txt'))).toBe(true)
    } finally {
      await rm(victim, { recursive: true, force: true })
    }
  })

  test('a session reclaiming its id while the old dir is being discarded gets a fresh dir that survives', async () => {
    // given
    const sessionId = `reclaim-${randomUUID()}`
    const first = holdSessionTmp(sessionId)
    await writeFile(join(await ensureSessionTmpDir(sessionId), 'old.txt'), 'old')

    // when
    const discarding = first()
    const second = holdSessionTmp(sessionId)
    const dir = await ensureSessionTmpDir(sessionId)
    await writeFile(join(dir, 'new.txt'), 'new')
    await discarding

    // then
    expect(existsSync(join(dir, 'new.txt'))).toBe(true)
    expect(existsSync(join(dir, 'old.txt'))).toBe(false)
    await second()
  })

  test('a bash lease keeps a dir through its session release and the sweep, and its own release discards nothing', async () => {
    // given
    const sessionId = `lease-${randomUUID()}`
    const releaseSession = holdSessionTmp(sessionId)
    const releaseLease = leaseSessionTmp(sessionId)
    const dir = await ensureSessionTmpDir(sessionId)
    await utimes(dir, new Date(0), new Date(0))

    // when
    await releaseSession()
    // Only a dir back-dated past 30 minutes is eligible, so a parallel test's
    // fresh scratch under the shared root is never touched.
    await sweepSessionTmp({ minAgeMs: 30 * 60 * 1000 })

    // then
    expect(existsSync(dir)).toBe(true)
    releaseLease()
    expect(existsSync(dir)).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'the sweep reclaims read-only trees without touching what their symlinks point at',
    async () => {
      // given: a Go-module-cache-like tree of read-only dirs, holding a symlink
      // to a read-only dir outside the scratch root
      const root = await mkdtemp(join(tmpdir(), 'session-tmp-readonly-'))
      const outside = await mkdtemp(join(tmpdir(), 'session-tmp-outside-'))
      await chmod(outside, 0o500)
      const cache = join(root, `orphan-${randomUUID()}`, 'pkg', 'mod', 'example.com')
      await mkdir(cache, { recursive: true })
      await writeFile(join(cache, 'go.mod'), 'module example.com\n')
      await symlink(outside, join(cache, 'link'))
      for (const dir of [cache, dirname(cache), dirname(dirname(cache))]) await chmod(dir, 0o555)
      await mkdir(join(root, `orphan-${randomUUID()}`))
      const logs: string[] = []

      try {
        // when
        const removed = await sweepSessionTmp({ root, minAgeMs: 0, log: (m) => logs.push(m) })

        // then
        expect(removed).toBe(2)
        expect(await readdir(root)).toEqual([])
        expect(logs).toEqual([])
        expect((await stat(outside)).mode & 0o777).toBe(0o500)
      } finally {
        await chmod(outside, 0o700)
        await rm(outside, { recursive: true, force: true })
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  test('a sweep reaching a dir whose final release is mid-move leaves it to that move instead of renaming again', async () => {
    // given
    const sessionId = `overlap-${randomUUID()}`
    const first = holdSessionTmp(sessionId)
    const old = await ensureSessionTmpDir(sessionId)
    await utimes(old, new Date(0), new Date(0))
    const renames: string[] = []
    const unblock = Promise.withResolvers<void>()
    __setSessionTmpRenameForTesting(async (from, to) => {
      // The sweep walks the shared root; only this test's dir is counted and held.
      if (String(from) !== old) return rename(from, to)
      renames.push(String(from))
      if (renames.length === 1) await unblock.promise
      await rename(from, to)
    })

    try {
      // when
      const releasing = first()
      await sweepSessionTmp({ minAgeMs: 30 * 60 * 1000 })
      const second = holdSessionTmp(sessionId)
      const preparing = ensureSessionTmpDir(sessionId)
      unblock.resolve()
      await releasing
      const dir = await preparing
      await writeFile(join(dir, 'new.txt'), 'new')

      // then
      expect(renames).toEqual([old])
      expect(existsSync(join(dir, 'new.txt'))).toBe(true)
      await second()
    } finally {
      unblock.resolve()
      __setSessionTmpRenameForTesting(undefined)
    }
  })

  test('a second final release while the first is mid-move joins it instead of renaming again', async () => {
    // given
    const sessionId = `coalesce-${randomUUID()}`
    const first = holdSessionTmp(sessionId)
    const old = await ensureSessionTmpDir(sessionId)
    const renames: string[] = []
    const unblock = Promise.withResolvers<void>()
    __setSessionTmpRenameForTesting(async (from, to) => {
      if (String(from) !== old) return rename(from, to)
      renames.push(String(from))
      if (renames.length === 1) await unblock.promise
      await rename(from, to)
    })

    try {
      // when
      const firstRelease = first()
      const secondRelease = holdSessionTmp(sessionId)()
      const third = holdSessionTmp(sessionId)
      let prepared = false
      const preparing = ensureSessionTmpDir(sessionId).then((dir) => {
        prepared = true
        return dir
      })
      await Promise.resolve()
      expect(prepared).toBe(false)
      unblock.resolve()
      await Promise.all([firstRelease, secondRelease])
      const dir = await preparing
      await writeFile(join(dir, 'new.txt'), 'new')

      // then
      expect(renames).toEqual([old])
      expect(existsSync(join(dir, 'new.txt'))).toBe(true)
      await third()
    } finally {
      unblock.resolve()
      __setSessionTmpRenameForTesting(undefined)
    }
  })

  test('the sweep is a no-op when no session ever created scratch', async () => {
    expect(await sweepSessionTmp({ root: join(tmpdir(), `session-tmp-missing-${randomUUID()}`) })).toBe(0)
  })
})
