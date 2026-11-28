import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectMissingDeps, ensureDepsInstalled } from './ensure-deps'
import { COPYFILE_INSTALL_MARKER, type InstallResult, runBunInstall, runBunUpdate } from './run-bun-install'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-ensure-deps-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writePackageJson(dir: string, content: Record<string, unknown>): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(content, null, 2)}\n`)
}

async function installFakeDep(name: string, content: Record<string, unknown> = {}): Promise<void> {
  await writePackageJson(join(root, 'node_modules', name), { name, version: '1.0.0', ...content })
}

describe('detectMissingDeps', () => {
  test('returns empty when every declared direct dep is installed', async () => {
    await writePackageJson(root, { name: 'agent', dependencies: { typeclaw: '^0.1.0' } })
    await installFakeDep('typeclaw')

    expect(await detectMissingDeps(root)).toEqual([])
  })

  test('reports missing direct deps by name', async () => {
    await writePackageJson(root, { name: 'agent', dependencies: { typeclaw: '^0.1.0', other: '^1' } })
    await installFakeDep('typeclaw')

    expect(await detectMissingDeps(root)).toEqual(['other'])
  })

  test('reports a transitive dep missing when the installed direct dep declares it', async () => {
    // given: agent declares typeclaw; typeclaw is installed; typeclaw's package.json
    // declares zod as a dep; zod is NOT installed at the root (the canonical bug).
    await writePackageJson(root, { name: 'agent', dependencies: { typeclaw: '^0.1.0' } })
    await installFakeDep('typeclaw', { dependencies: { zod: '^4' } })

    expect(await detectMissingDeps(root)).toEqual(['zod'])
  })

  test('does not report a transitive dep that IS hoisted', async () => {
    await writePackageJson(root, { name: 'agent', dependencies: { typeclaw: '^0.1.0' } })
    await installFakeDep('typeclaw', { dependencies: { zod: '^4' } })
    await installFakeDep('zod')

    expect(await detectMissingDeps(root)).toEqual([])
  })

  test('returns empty when package.json declares no dependencies field', async () => {
    await writePackageJson(root, { name: 'agent' })

    expect(await detectMissingDeps(root)).toEqual([])
  })

  test('returns empty when the agent folder has no package.json at all', async () => {
    expect(await detectMissingDeps(root)).toEqual([])
  })

  test('ignores an unreadable transitive package.json (no false positives from corrupt installs)', async () => {
    // given: typeclaw's package.json is invalid JSON. detectMissingDeps must
    // not throw — it should just skip that transitive walk. Otherwise a single
    // corrupted dep in node_modules/ would brick `typeclaw start`.
    await writePackageJson(root, { name: 'agent', dependencies: { typeclaw: '^0.1.0' } })
    await mkdir(join(root, 'node_modules', 'typeclaw'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'typeclaw', 'package.json'), 'not json {{{')

    expect(await detectMissingDeps(root)).toEqual([])
  })

  test('returns missing deps in sorted order (deterministic output for diagnostics)', async () => {
    await writePackageJson(root, { name: 'agent', dependencies: { c: '^1', a: '^1', b: '^1' } })

    expect(await detectMissingDeps(root)).toEqual(['a', 'b', 'c'])
  })

  test("finds a transitive dep that lives next to the parent's realpath, not at cwd/node_modules", async () => {
    // given: Bun's isolated linker layout. node_modules/typeclaw is a symlink
    // into .bun/typeclaw@.../node_modules/typeclaw/, and typeclaw's own
    // transitive deps (zod, etc.) live as siblings in that same .bun nested
    // node_modules — NOT hoisted to cwd/node_modules/. The old lexical probe
    // (cwd/node_modules/zod/package.json) reports zod missing here; the
    // realpath-walking probe finds it.
    await writePackageJson(root, { name: 'agent', dependencies: { typeclaw: 'file:...' } })
    const storeDir = join(root, 'node_modules', '.bun', 'typeclaw@x', 'node_modules')
    await writePackageJson(join(storeDir, 'typeclaw'), {
      name: 'typeclaw',
      version: '1.0.0',
      dependencies: { zod: '^4' },
    })
    await writePackageJson(join(storeDir, 'zod'), { name: 'zod', version: '4.0.0' })
    await symlink(join(storeDir, 'typeclaw'), join(root, 'node_modules', 'typeclaw'))

    expect(await detectMissingDeps(root)).toEqual([])
  })

  test("still flags a transitive dep that's missing from BOTH cwd and the parent's realpath", async () => {
    // given: same isolated-linker layout but zod is not installed anywhere.
    // The walker must reach the filesystem root without finding it and report
    // it missing.
    await writePackageJson(root, { name: 'agent', dependencies: { typeclaw: 'file:...' } })
    const storeDir = join(root, 'node_modules', '.bun', 'typeclaw@x', 'node_modules')
    await writePackageJson(join(storeDir, 'typeclaw'), {
      name: 'typeclaw',
      version: '1.0.0',
      dependencies: { zod: '^4' },
    })
    await symlink(join(storeDir, 'typeclaw'), join(root, 'node_modules', 'typeclaw'))

    expect(await detectMissingDeps(root)).toEqual(['zod'])
  })

  test('reports a root dep as missing even when an ancestor folder has it installed', async () => {
    // given: the agent folder is nested inside another node project. The
    // ancestor has typeclaw installed at ancestor/node_modules/typeclaw, but
    // the agent folder itself does NOT. Since only the agent folder gets
    // bind-mounted into the container, finding typeclaw in an ancestor must
    // NOT satisfy the gate — otherwise `docker run` would later crash with
    // "Cannot find package 'typeclaw'", which is exactly what this whole
    // module exists to prevent.
    const ancestor = root
    const agentDir = join(ancestor, 'nested', 'agent')
    await writePackageJson(agentDir, { name: 'agent', dependencies: { typeclaw: '^0.1.0' } })
    await writePackageJson(join(ancestor, 'node_modules', 'typeclaw'), {
      name: 'typeclaw',
      version: '1.0.0',
    })

    expect(await detectMissingDeps(agentDir)).toEqual(['typeclaw'])
  })
})

describe('ensureDepsInstalled', () => {
  test('runs install when drift is detected and reports installed=true', async () => {
    let installed = 0
    let detectCalls = 0
    const result = await ensureDepsInstalled({
      cwd: root,
      detect: async () => {
        detectCalls++
        return detectCalls === 1 ? ['zod'] : []
      },
      install: async () => {
        installed++
        return { ok: true }
      },
    })

    expect(installed).toBe(1)
    expect(detectCalls).toBe(2)
    expect(result).toMatchObject({ ok: true, installed: true })
  })

  test('skips install when no drift is detected and reports installed=false', async () => {
    let installed = 0
    const result = await ensureDepsInstalled({
      cwd: root,
      detect: async () => [],
      install: async () => {
        installed++
        return { ok: true }
      },
    })

    expect(installed).toBe(0)
    expect(result).toMatchObject({ ok: true, installed: false })
  })

  test('returns ok:false with the install reason when bun install fails', async () => {
    const result = await ensureDepsInstalled({
      cwd: root,
      detect: async () => ['zod'],
      install: async () => ({ ok: false, reason: 'lockfile is read-only' }),
    })

    expect(result).toEqual({ ok: false, reason: 'lockfile is read-only', missing: ['zod'] })
  })

  test('returns ok:false when install succeeds but deps are still missing afterward', async () => {
    // given: bun install returns 0, but the missing deps did not actually
    // appear. This is the file:-linked dep silent-no-op case the comment in
    // ensure-deps.ts calls out — we MUST surface this rather than proceeding
    // to docker run with a broken node_modules.
    let calls = 0
    const result = await ensureDepsInstalled({
      cwd: root,
      detect: async () => {
        calls++
        return ['zod']
      },
      install: async () => ({ ok: true }),
    })

    expect(calls).toBe(2)
    expect(result).toMatchObject({
      ok: false,
      missing: ['zod'],
    })
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('still missing')
    expect(result.reason).toContain('zod')
  })

  test('detects drift end-to-end through the real filesystem (no detect injection)', async () => {
    // given: a real agent folder where typeclaw is installed but its declared
    // zod dep is not. This exercises the actual detectMissingDeps path, so a
    // regression that breaks fs-level detection fails this test.
    await writePackageJson(root, { name: 'agent', dependencies: { typeclaw: '^0.1.0' } })
    await installFakeDep('typeclaw', { dependencies: { zod: '^4' } })
    await writeFile(join(root, 'node_modules', COPYFILE_INSTALL_MARKER), '')

    let installed = 0
    const result = await ensureDepsInstalled({
      cwd: root,
      install: async () => {
        installed++
        await installFakeDep('zod')
        return { ok: true }
      },
    })

    expect(installed).toBe(1)
    expect(result).toMatchObject({ ok: true, installed: true })
  })

  test('force=true skips pre-install detect and calls install with force=true', async () => {
    // given: drift-detect would report nothing missing (so the default path
    // would skip install entirely). force=true should bypass that and run
    // the install anyway.
    let detectCalls = 0
    const installOptsSeen: Array<{ force?: boolean } | undefined> = []
    const result = await ensureDepsInstalled({
      cwd: root,
      force: true,
      detect: async () => {
        detectCalls++
        return []
      },
      install: async (_cwd, opts) => {
        installOptsSeen.push(opts)
        return { ok: true }
      },
    })

    expect(detectCalls).toBe(1)
    expect(installOptsSeen).toEqual([{ force: true }])
    expect(result).toMatchObject({ ok: true, installed: true })
  })

  test('rebuilds a legacy tree from empty, dropping stale entries and shared inodes, once', async () => {
    // given: a pre-copyfile tree with a stale package and a file hardlinked to an outside cache copy
    const cache = await mkdtemp(join(tmpdir(), 'typeclaw-ensure-deps-cache-'))
    try {
      await writePackageJson(root, { name: 'agent', dependencies: { dep: 'file:./dep' } })
      await mkdir(join(root, 'dep'), { recursive: true })
      await writeFile(join(root, 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }))
      await writeFile(join(cache, 'index.js'), 'cache copy')
      await mkdir(join(root, 'node_modules', 'stale'), { recursive: true })
      await link(join(cache, 'index.js'), join(root, 'node_modules', 'stale', 'index.js'))

      // when: two starts in a row
      const first = await ensureDepsInstalled({ cwd: root })
      const second = await ensureDepsInstalled({
        cwd: root,
        install: async () => ({ ok: false, reason: 'unexpected' }),
      })

      // then: the tree was rebuilt and verified once, and the outside copy is untouched
      expect(first).toMatchObject({ ok: true, installed: true })
      expect(second).toMatchObject({ ok: true, installed: false })
      expect(existsSync(join(root, 'node_modules', COPYFILE_INSTALL_MARKER))).toBe(true)
      expect(existsSync(join(root, 'node_modules', 'stale'))).toBe(false)
      expect(existsSync(join(root, 'node_modules.typeclaw-legacy'))).toBe(false)
      expect(await readFile(join(cache, 'index.js'), 'utf8')).toBe('cache copy')
      expect((await stat(join(cache, 'index.js'))).nlink).toBe(1)
    } finally {
      await rm(cache, { recursive: true, force: true })
    }
  })

  test('puts the legacy tree back when the rebuild installs but a dependency is still missing', async () => {
    await mkdir(join(root, 'node_modules', 'kept'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'kept', 'index.js'), 'old')

    const result = await ensureDepsInstalled({
      cwd: root,
      detect: async () => ['zod'],
      install: async () => ({ ok: true }),
    })

    expect(result).toMatchObject({ ok: false, missing: ['zod'] })
    expect(await readFile(join(root, 'node_modules', 'kept', 'index.js'), 'utf8')).toBe('old')
    expect(existsSync(join(root, 'node_modules.typeclaw-legacy'))).toBe(false)
    expect(existsSync(join(root, 'node_modules', COPYFILE_INSTALL_MARKER))).toBe(false)
  })

  test('restores the backup of an interrupted rebuild before trying again', async () => {
    // given: a rebuild that stopped after Bun created a partial tree beside the backup
    await mkdir(join(root, 'node_modules.typeclaw-legacy', 'kept'), { recursive: true })
    await writeFile(join(root, 'node_modules.typeclaw-legacy', 'kept', 'index.js'), 'old')
    await mkdir(join(root, 'node_modules', 'partial'), { recursive: true })

    // when: the retry also fails
    const result = await ensureDepsInstalled({
      cwd: root,
      detect: async () => [],
      install: async () => ({ ok: false, reason: 'registry unreachable' }),
    })

    // then: the last working tree is back, not the partial one
    expect(result).toMatchObject({ ok: false })
    expect(await readFile(join(root, 'node_modules', 'kept', 'index.js'), 'utf8')).toBe('old')
    expect(existsSync(join(root, 'node_modules', 'partial'))).toBe(false)
  })

  test('puts the legacy tree back when the rebuild install fails', async () => {
    await mkdir(join(root, 'node_modules', 'kept'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'kept', 'index.js'), 'old')

    const result = await ensureDepsInstalled({
      cwd: root,
      detect: async () => [],
      install: async () => ({ ok: false, reason: 'registry unreachable' }),
    })

    expect(result).toMatchObject({ ok: false, reason: 'registry unreachable' })
    expect(await readFile(join(root, 'node_modules', 'kept', 'index.js'), 'utf8')).toBe('old')
  })

  test('force=false (default) does not pass force to the install runner', async () => {
    const installOptsSeen: Array<{ force?: boolean } | undefined> = []
    await ensureDepsInstalled({
      cwd: root,
      detect: async () => ['zod'],
      install: async (_cwd, opts) => {
        installOptsSeen.push(opts)
        return { ok: true }
      },
    })

    expect(installOptsSeen).toEqual([{ force: false }])
  })

  test('refresh=true runs a plain install even when nothing is missing', async () => {
    const installOptsSeen: Array<{ force?: boolean } | undefined> = []
    const result = await ensureDepsInstalled({
      cwd: root,
      refresh: true,
      detect: async () => [],
      install: async (_cwd, opts) => {
        installOptsSeen.push(opts)
        return { ok: true }
      },
    })

    expect(installOptsSeen).toEqual([{ force: false }])
    expect(result).toMatchObject({ ok: true, installed: true })
  })

  test('refresh re-copies a changed file: dependency through a real bun install', async () => {
    // given: an agent with a local file: dependency (no deps of its own, so no network) installed once
    const source = join(root, 'local-dep')
    const agent = join(root, 'agent')
    await writePackageJson(source, { name: 'local-dep', version: '1.0.0' })
    await writeFile(join(source, 'index.js'), 'export const value = 1\n')
    await writePackageJson(agent, { name: 'agent', private: true, dependencies: { 'local-dep': 'file:../local-dep' } })
    expect(await ensureDepsInstalled({ cwd: agent })).toEqual({ ok: true, installed: true })

    // when: without a version bump, a source file is atomically replaced and a new one is added, then the copy is refreshed
    await writeFile(join(source, 'index.js.next'), 'export const value = 2\n')
    await rename(join(source, 'index.js.next'), join(source, 'index.js'))
    await writeFile(join(source, 'added.js'), 'export const added = true\n')
    const result = await ensureDepsInstalled({ cwd: agent, refresh: true })

    // then: the installed copy holds the new bytes. Bun may link each file of a file: dependency to its source
    // instead of copying it, which makes the replaced file current without an install; only an install adds the new file.
    const installed = join(agent, 'node_modules', 'local-dep')
    expect(result).toEqual({ ok: true, installed: true })
    expect(await readFile(join(installed, 'index.js'), 'utf8')).toBe('export const value = 2\n')
    expect(await readFile(join(installed, 'added.js'), 'utf8')).toBe('export const added = true\n')
  }, 60_000)

  test('force=true still re-detects post-install (silent no-op guard preserved)', async () => {
    // given: force install succeeds, but the deps the runner was supposed to
    // populate did not appear. The re-detect guard must still fire under
    // force, otherwise --force could hide a broken file:-linked dep that
    // the runner silently no-op'd against.
    await writePackageJson(root, { name: 'agent', dependencies: { typeclaw: '^0.1.0' } })

    const result = await ensureDepsInstalled({
      cwd: root,
      force: true,
      install: async () => ({ ok: true }),
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.reason).toContain('still missing')
    expect(result.reason).toContain('typeclaw')
  })
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

// Every pending microtask (async detect, the queue hand-off) runs before an
// immediate fires, so this lets started work show up without waiting on time.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const nothingMissing = async (): Promise<readonly string[]> => []

describe('ensureDepsInstalled concurrency', () => {
  test('concurrent warm refreshes run one at a time', async () => {
    // given: an install whose runs finish only when the test releases them
    const events: string[] = []
    const releases = new Map<string, (result: InstallResult) => void>()
    let closing = false
    const install = async (cwd: string): Promise<InstallResult> => {
      events.push(`start ${cwd}`)
      if (closing) return { ok: true }
      const release = deferred<InstallResult>()
      releases.set(cwd, release.resolve)
      const result = await release.promise
      events.push(`end ${cwd}`)
      return result
    }

    try {
      // when: two warm refreshes start together
      const first = ensureDepsInstalled({ cwd: 'a', refresh: true, detect: nothingMissing, install })
      const second = ensureDepsInstalled({ cwd: 'b', refresh: true, detect: nothingMissing, install })
      await settle()

      // then: the second starts only after the first finished
      expect(events).toEqual(['start a'])
      releases.get('a')?.({ ok: true })
      expect(await first).toEqual({ ok: true, installed: true })
      await settle()
      expect(events).toEqual(['start a', 'end a', 'start b'])
      releases.get('b')?.({ ok: true })
      expect(await second).toEqual({ ok: true, installed: true })
    } finally {
      closing = true
      for (const release of releases.values()) release({ ok: false, reason: 'released' })
    }
  })

  test('a stalled warm refresh does not hold back cold or forced installs', async () => {
    // given: a warm refresh whose install never finishes on its own
    const stalled = deferred<InstallResult>()
    let warmStarted = false
    try {
      const warm = ensureDepsInstalled({
        cwd: 'warm',
        refresh: true,
        detect: nothingMissing,
        install: async () => {
          warmStarted = true
          return stalled.promise
        },
      })
      await settle()
      expect(warmStarted).toBe(true)

      // when: a cold install (a dep is missing) and a forced install start behind it
      let coldDetects = 0
      const settled: string[] = []
      void ensureDepsInstalled({
        cwd: 'cold',
        detect: async () => (coldDetects++ === 0 ? ['zod'] : []),
        install: async () => ({ ok: true }),
      }).then((result) => settled.push(`cold ${result.ok}`))
      void ensureDepsInstalled({
        cwd: 'forced',
        force: true,
        detect: nothingMissing,
        install: async () => ({ ok: true }),
      }).then((result) => settled.push(`forced ${result.ok}`))
      await settle()

      // then: both finished while the warm refresh is still running
      expect(settled.sort()).toEqual(['cold true', 'forced true'])
      stalled.resolve({ ok: true })
      expect(await warm).toEqual({ ok: true, installed: true })
    } finally {
      stalled.resolve({ ok: false, reason: 'released' })
    }
  })

  test('a warm refresh stops waiting behind a stalled one after the wait cap', async () => {
    // given: a warm refresh that stalls, as one resolving a bumped registry pin can while its local copy is stale
    const stalled = deferred<InstallResult>()
    let stalledEnded = false
    try {
      void ensureDepsInstalled({
        cwd: 'stalled',
        refresh: true,
        detect: nothingMissing,
        install: async () => {
          const result = await stalled.promise
          stalledEnded = true
          return result
        },
      })

      // when: another agent's warm refresh queues behind it with a short wait cap
      const refresh = await ensureDepsInstalled({
        cwd: 'healthy',
        refresh: true,
        maxQueueWaitMs: 1,
        detect: nothingMissing,
        install: async () => ({ ok: true }),
      })

      // then: it ran once the cap passed, while the stalled refresh is still running
      expect(refresh).toEqual({ ok: true, installed: true })
      expect(stalledEnded).toBe(false)
    } finally {
      stalled.resolve({ ok: false, reason: 'released' })
    }
  })

  test('a stalled bun update does not hold back a warm refresh', async () => {
    // given: a `bun update` child that exits only when released, and a refresh child that exits at once
    const closed = (): ReadableStream<Uint8Array> =>
      new ReadableStream({
        start(controller) {
          controller.close()
        },
      })
    const fakeChild = (exited: Promise<number>, kill: () => void) =>
      (() => ({ exited, stdout: closed(), stderr: closed(), kill })) as unknown as typeof Bun.spawn
    const updateExit = deferred<number>()
    const refreshExit = deferred<number>()
    const updateSpawn = fakeChild(updateExit.promise, () => updateExit.resolve(137))
    const refreshSpawn = fakeChild(refreshExit.promise, () => refreshExit.resolve(137))
    refreshExit.resolve(0)
    try {
      const update = runBunUpdate('updating', 'typeclaw', { timeoutMs: 600_000, spawn: updateSpawn })

      // when: another agent refreshes its local copy through the real install runner meanwhile
      const settled: string[] = []
      void ensureDepsInstalled({
        cwd: 'refreshing',
        refresh: true,
        detect: nothingMissing,
        install: (cwd, opts) => runBunInstall(cwd, { ...opts, timeoutMs: 600_000, spawn: refreshSpawn }),
      }).then((result) => settled.push(`refresh ${result.ok}`))
      await settle()

      // then: the refresh finished while the update is still running
      expect(settled).toEqual(['refresh true'])
      updateExit.resolve(0)
      expect(await update).toEqual({ ok: true })
    } finally {
      updateExit.resolve(137)
      refreshExit.resolve(137)
    }
  })
})
