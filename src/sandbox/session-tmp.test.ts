import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  enterSubagentTmpScope,
  ensureSessionTmpDir,
  holdSessionTmp,
  isUnderTmp,
  mapVirtualTmpPath,
  SESSION_TMP_ROOT,
  sessionTmpDir,
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
})
