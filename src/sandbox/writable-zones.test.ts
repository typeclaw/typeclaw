import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { COPYFILE_INSTALL_MARKER } from '@/init/run-bun-install'

import { CANONICAL_AGENT_SECRET_DIRS, CANONICAL_AGENT_SECRET_FILES } from './canonical-secrets'
import {
  resolveProtectedZones,
  resolveRuntimeDependencyZones,
  resolveWritableZones,
  subtractMasked,
} from './writable-zones'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-writable-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('resolveWritableZones', () => {
  test('includes only the allowed dirs that actually exist', async () => {
    await mkdir(join(agentDir, 'workspace'))
    await mkdir(join(agentDir, 'public'))

    const { dirs } = await resolveWritableZones(agentDir)

    expect(dirs).toEqual([join(agentDir, 'workspace'), join(agentDir, 'public')])
  })

  test('excludes .agents/skills and packages even when present (guarded/executable surfaces)', async () => {
    await mkdir(join(agentDir, '.agents', 'skills'), { recursive: true })
    await mkdir(join(agentDir, 'packages'))

    const { dirs } = await resolveWritableZones(agentDir)

    expect(dirs).not.toContain(join(agentDir, '.agents/skills'))
    expect(dirs).not.toContain(join(agentDir, 'packages'))
  })

  test('includes only the allowed root files that exist', async () => {
    await writeFile(join(agentDir, 'AGENTS.md'), '# agents')
    await writeFile(join(agentDir, 'IDENTITY.md'), '# identity')

    const { files } = await resolveWritableZones(agentDir)

    expect(files).toEqual([join(agentDir, 'AGENTS.md'), join(agentDir, 'IDENTITY.md')])
  })

  test('excludes the semantically-guarded managed files (cron.json, typeclaw.json)', async () => {
    await writeFile(join(agentDir, 'AGENTS.md'), '# agents')
    await writeFile(join(agentDir, 'cron.json'), '{"jobs":[]}')
    await writeFile(join(agentDir, 'typeclaw.json'), '{}')

    const { files } = await resolveWritableZones(agentDir)

    expect(files).not.toContain(join(agentDir, 'cron.json'))
    expect(files).not.toContain(join(agentDir, 'typeclaw.json'))
    expect(files).toContain(join(agentDir, 'AGENTS.md'))
  })

  test('rejects a zone dir that is a symlink (RW bind would follow it outside)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'typeclaw-outside-'))
    try {
      await symlink(outside, join(agentDir, 'workspace'))

      const { dirs } = await resolveWritableZones(agentDir)

      expect(dirs).not.toContain(join(agentDir, 'workspace'))
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('rejects a root file that is a symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'typeclaw-outside-'))
    try {
      const target = join(outside, 'real.md')
      await writeFile(target, '# real')
      await symlink(target, join(agentDir, 'AGENTS.md'))

      const { files } = await resolveWritableZones(agentDir)

      expect(files).not.toContain(join(agentDir, 'AGENTS.md'))
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('does not treat a same-named file as a writable dir (or vice versa)', async () => {
    await writeFile(join(agentDir, 'workspace'), 'not a dir')
    await mkdir(join(agentDir, 'AGENTS.md'))

    const { dirs, files } = await resolveWritableZones(agentDir)

    expect(dirs).not.toContain(join(agentDir, 'workspace'))
    expect(files).not.toContain(join(agentDir, 'AGENTS.md'))
  })

  test('returns empty lists for a bare agent dir', async () => {
    const { dirs, files } = await resolveWritableZones(agentDir)

    expect(dirs).toEqual([])
    expect(files).toEqual([])
  })

  test('includes .git when it exists so bash can commit', async () => {
    await mkdir(join(agentDir, '.git'))

    const { dirs } = await resolveWritableZones(agentDir)

    expect(dirs).toContain(join(agentDir, '.git'))
  })

  test('omits .git when absent (bwrap would abort binding a missing source)', async () => {
    const { dirs } = await resolveWritableZones(agentDir)

    expect(dirs).not.toContain(join(agentDir, '.git'))
  })

  describe('configured writablePaths', () => {
    test('adds a configured agent-relative dir that exists', async () => {
      await mkdir(join(agentDir, '.metabase-cli'))

      const { dirs } = await resolveWritableZones(agentDir, ['.metabase-cli'])

      expect(dirs).toContain(join(agentDir, '.metabase-cli'))
    })

    test('supports a nested configured dir', async () => {
      await mkdir(join(agentDir, 'workspace', 'cache'), { recursive: true })

      const { dirs } = await resolveWritableZones(agentDir, ['workspace/cache'])

      expect(dirs).toContain(join(agentDir, 'workspace/cache'))
    })

    test('drops a configured dir that does not exist', async () => {
      const { dirs } = await resolveWritableZones(agentDir, ['.metabase-cli'])

      expect(dirs).not.toContain(join(agentDir, '.metabase-cli'))
    })

    test('drops a configured path that is a file, not a dir', async () => {
      await writeFile(join(agentDir, '.metabase-cli'), 'not a dir')

      const { dirs } = await resolveWritableZones(agentDir, ['.metabase-cli'])

      expect(dirs).not.toContain(join(agentDir, '.metabase-cli'))
    })

    test('drops a configured dir whose root is a symlink (RW bind would follow it out)', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'typeclaw-outside-'))
      try {
        await symlink(outside, join(agentDir, '.metabase-cli'))

        const { dirs } = await resolveWritableZones(agentDir, ['.metabase-cli'])

        expect(dirs).not.toContain(join(agentDir, '.metabase-cli'))
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })

    test('drops a configured path whose INTERMEDIATE component symlinks OUTSIDE the agent dir', async () => {
      const outside = await mkdtemp(join(tmpdir(), 'typeclaw-outside-'))
      try {
        // given /agent/alias -> /tmp/outside, a config of `alias/sub` is lexically
        // /agent/alias/sub (passes isInside) but its real path is /tmp/outside/sub
        await mkdir(join(outside, 'sub'), { recursive: true })
        await symlink(outside, join(agentDir, 'alias'))

        const { dirs } = await resolveWritableZones(agentDir, ['alias/sub'])

        expect(dirs).not.toContain(join(agentDir, 'alias/sub'))
        expect(dirs.some((d) => d.includes('outside'))).toBe(false)
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })

    test('drops a configured path whose INTERMEDIATE component symlinks onto a forbidden root', async () => {
      // given /agent/alias -> /agent/sessions, a config of `alias/sub` is lexically
      // /agent/alias/sub but its real path is /agent/sessions/sub (forbidden)
      await mkdir(join(agentDir, 'sessions', 'sub'), { recursive: true })
      await symlink(join(agentDir, 'sessions'), join(agentDir, 'alias'))

      const { dirs } = await resolveWritableZones(agentDir, ['alias/sub'])

      expect(dirs).not.toContain(join(agentDir, 'alias/sub'))
      expect(dirs).not.toContain(join(agentDir, 'sessions/sub'))
    })

    test('drops a configured path that escapes the agent dir via ..', async () => {
      const { dirs } = await resolveWritableZones(agentDir, ['../escape'])

      expect(dirs.every((d) => d.startsWith(agentDir))).toBe(true)
      expect(dirs).not.toContain(join(agentDir, '../escape'))
    })

    test.each([
      ...new Set([
        '.git',
        ...CANONICAL_AGENT_SECRET_FILES,
        ...CANONICAL_AGENT_SECRET_DIRS,
        'sessions',
        'memory',
        '.typeclaw',
        'node_modules',
      ]),
    ])('drops the security-sensitive root %p even when it exists', async (root) => {
      await mkdir(join(agentDir, root), { recursive: true })

      const { dirs } = await resolveWritableZones(agentDir, [root])

      // .git is a built-in writable zone, so it is present via WRITABLE_DIRS —
      // but the configured path must not be what re-adds it. The other roots
      // must be absent entirely.
      if (root !== '.git') expect(dirs).not.toContain(join(agentDir, root))
    })

    test('drops a configured path nested under a forbidden root', async () => {
      await mkdir(join(agentDir, 'sessions', 'sub'), { recursive: true })

      const { dirs } = await resolveWritableZones(agentDir, ['sessions/sub'])

      expect(dirs).not.toContain(join(agentDir, 'sessions/sub'))
    })

    test.each(['.', ''])('drops a configured path that resolves to the agent root (%p)', async (root) => {
      const { dirs } = await resolveWritableZones(agentDir, [root])

      expect(dirs).not.toContain(agentDir)
    })

    test('does not duplicate a configured path that overlaps a built-in zone', async () => {
      await mkdir(join(agentDir, 'workspace'))

      const { dirs } = await resolveWritableZones(agentDir, ['workspace'])

      expect(dirs.filter((d) => d === join(agentDir, 'workspace'))).toHaveLength(1)
    })

    test('keeps built-in zones alongside configured ones', async () => {
      await mkdir(join(agentDir, 'workspace'))
      await mkdir(join(agentDir, '.metabase-cli'))

      const { dirs } = await resolveWritableZones(agentDir, ['.metabase-cli'])

      expect(dirs).toContain(join(agentDir, 'workspace'))
      expect(dirs).toContain(join(agentDir, '.metabase-cli'))
    })
  })
})

describe('resolveRuntimeDependencyZones', () => {
  async function installPackage(dir: string, name: string, dependencies: Record<string, string> = {}): Promise<void> {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', dependencies }))
  }

  test('keeps a tree without the copyfile marker read-only as a whole', async () => {
    await installPackage(join(agentDir, 'node_modules', 'typeclaw'), 'typeclaw')

    expect(await resolveRuntimeDependencyZones(agentDir, ['typeclaw'])).toEqual([join(agentDir, 'node_modules')])
  })

  test('protects only the dependency closure of the runtime packages in a copyfile tree', async () => {
    // given: typeclaw -> zod (hoisted) and -> ws (nested), a plugin, and an agent-installed CLI
    const nodeModules = join(agentDir, 'node_modules')
    await mkdir(nodeModules, { recursive: true })
    await writeFile(join(nodeModules, COPYFILE_INSTALL_MARKER), '')
    await installPackage(join(nodeModules, 'typeclaw'), 'typeclaw', { zod: '^4', ws: '^8' })
    await installPackage(join(nodeModules, 'typeclaw', 'node_modules', 'ws'), 'ws')
    await installPackage(join(nodeModules, 'zod'), 'zod')
    await installPackage(join(nodeModules, '@acme', 'plugin'), '@acme/plugin', { zod: '^4' })
    await installPackage(join(nodeModules, 'agent-cli'), 'agent-cli')

    // when
    const dirs = await resolveRuntimeDependencyZones(agentDir, ['typeclaw', '@acme/plugin'])

    // then: nested deps are covered by their parent bind, and the agent's CLI stays writable
    expect(dirs.sort()).toEqual(
      [join(nodeModules, '@acme', 'plugin'), join(nodeModules, 'typeclaw'), join(nodeModules, 'zod')].sort(),
    )
  })

  test('returns nothing when node_modules is absent', async () => {
    expect(await resolveRuntimeDependencyZones(agentDir, ['typeclaw'])).toEqual([])
  })
})

describe('resolveProtectedZones', () => {
  test('leaves an installed node_modules writable so the agent can install into its own package', async () => {
    await mkdir(join(agentDir, 'node_modules'))

    const { dirs, files } = await resolveProtectedZones(agentDir)

    expect(dirs).toEqual([])
    expect(files).toEqual([])
  })

  test('does not create node_modules when it is absent', async () => {
    await resolveProtectedZones(agentDir)

    expect(existsSync(join(agentDir, 'node_modules'))).toBe(false)
  })

  test('re-protects .git/hooks and .git/config when present', async () => {
    await mkdir(join(agentDir, '.git', 'hooks'), { recursive: true })
    await writeFile(join(agentDir, '.git', 'config'), '[core]\n')

    const { dirs, files } = await resolveProtectedZones(agentDir)

    expect(dirs).toContain(join(agentDir, '.git/hooks'))
    expect(files).toEqual([join(agentDir, '.git/config')])
  })

  test('ensures and protects .git/hooks + .git/config even when absent', async () => {
    await mkdir(join(agentDir, '.git'))

    const { dirs, files } = await resolveProtectedZones(agentDir)

    // given .git existed but hooks/config did not, they are created AND returned
    expect(dirs).toContain(join(agentDir, '.git/hooks'))
    expect(files).toEqual([join(agentDir, '.git/config')])
    expect((await stat(join(agentDir, '.git/hooks'))).isDirectory()).toBe(true)
    expect((await stat(join(agentDir, '.git/config'))).isFile()).toBe(true)
  })

  test('rejects a symlinked .git/hooks rather than protecting the wrong target', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'typeclaw-outside-'))
    try {
      await mkdir(join(agentDir, '.git'))
      await symlink(outside, join(agentDir, '.git', 'hooks'))

      await expect(resolveProtectedZones(agentDir)).rejects.toThrow(/symlink/i)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('also protects a core.hooksPath that points inside the agent dir', async () => {
    await mkdir(join(agentDir, '.git'), { recursive: true })
    await writeFile(join(agentDir, '.git', 'config'), '[core]\n\thooksPath = workspace/hooks\n')

    const { dirs } = await resolveProtectedZones(agentDir)

    expect(dirs).toContain(join(agentDir, 'workspace/hooks'))
    expect((await lstat(join(agentDir, 'workspace/hooks'))).isDirectory()).toBe(true)
  })

  test('uses Git parsing for quoted, escaped, and commented hooksPath values', async () => {
    await mkdir(join(agentDir, '.git'), { recursive: true })
    await writeFile(
      join(agentDir, '.git', 'config'),
      '[core]\n\t# hooksPath = workspace/ignored\n\thooksPath = "workspace/hook\\\\dir"\n',
    )

    const { dirs } = await resolveProtectedZones(agentDir)

    expect(dirs).toContain(join(agentDir, 'workspace/hook\\dir'))
  })

  test('protects agent-local config includes that could later redirect core.hooksPath', async () => {
    await mkdir(join(agentDir, '.git'), { recursive: true })
    await mkdir(join(agentDir, 'workspace'), { recursive: true })
    await writeFile(join(agentDir, '.git', 'config'), '[include]\n\tpath = ../workspace/git.inc\n')
    await writeFile(join(agentDir, 'workspace', 'git.inc'), '[core]\n\thooksPath = workspace/hooks\n')

    const { dirs, files } = await resolveProtectedZones(agentDir)

    expect(files).toContain(join(agentDir, 'workspace/git.inc'))
    expect(dirs).toContain(join(agentDir, 'workspace/hooks'))
  })

  test('honors matching includeIf config through Git semantics', async () => {
    await mkdir(join(agentDir, '.git', 'objects'), { recursive: true })
    await mkdir(join(agentDir, '.git', 'refs', 'heads'), { recursive: true })
    await writeFile(join(agentDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await mkdir(join(agentDir, 'workspace'), { recursive: true })
    await writeFile(join(agentDir, '.git', 'config'), '[includeIf "gitdir:**"]\n\tpath = ../workspace/git.inc\n')
    await writeFile(join(agentDir, 'workspace', 'git.inc'), '[core]\n\thooksPath = workspace/conditional-hooks\n')

    const { dirs, files } = await resolveProtectedZones(agentDir)

    expect(files).toContain(join(agentDir, 'workspace/git.inc'))
    expect(dirs).toContain(join(agentDir, 'workspace/conditional-hooks'))
  })

  test('protects tilde-expanded and nested agent-local includes', async () => {
    await mkdir(join(agentDir, '.git'), { recursive: true })
    await mkdir(join(agentDir, 'workspace'), { recursive: true })
    await writeFile(join(agentDir, '.git', 'config'), '[include]\n\tpath = ~/workspace/first.inc\n')
    await writeFile(join(agentDir, 'workspace', 'first.inc'), '[include]\n\tpath = nested.inc\n')
    await writeFile(join(agentDir, 'workspace', 'nested.inc'), '[core]\n\thooksPath = workspace/nested-hooks\n')

    const { dirs, files } = await resolveProtectedZones(agentDir)

    expect(files).toContain(join(agentDir, 'workspace/first.inc'))
    expect(files).toContain(join(agentDir, 'workspace/nested.inc'))
    expect(dirs).toContain(join(agentDir, 'workspace/nested-hooks'))
  })

  test('protects Git effective hooksPath when the root overrides an included value', async () => {
    await mkdir(join(agentDir, '.git'), { recursive: true })
    await mkdir(join(agentDir, 'workspace'), { recursive: true })
    await writeFile(
      join(agentDir, '.git', 'config'),
      '[include]\n\tpath = ../workspace/git.inc\n[core]\n\thooksPath = workspace/final-hooks\n',
    )
    await writeFile(join(agentDir, 'workspace', 'git.inc'), '[core]\n\thooksPath = workspace/stale-hooks\n')

    const { dirs } = await resolveProtectedZones(agentDir)

    expect(dirs).toContain(join(agentDir, 'workspace/final-hooks'))
    expect(dirs).not.toContain(join(agentDir, 'workspace/stale-hooks'))
  })

  test('ignores a core.hooksPath that resolves outside the agent dir', async () => {
    await mkdir(join(agentDir, '.git'), { recursive: true })
    await writeFile(join(agentDir, '.git', 'config'), '[core]\n\thooksPath = /etc\n')

    const { dirs } = await resolveProtectedZones(agentDir)

    expect(dirs).not.toContain('/etc')
    expect(dirs).toContain(join(agentDir, '.git/hooks'))
  })

  test('a masked-dir core.hooksPath is dropped by subtractMasked (no mask re-exposure)', async () => {
    await mkdir(join(agentDir, '.git'), { recursive: true })
    await writeFile(join(agentDir, '.git', 'config'), '[core]\n\thooksPath = workspace/hooks\n')

    // given a guest whose workspace/ is masked, protecting workspace/hooks would
    // re-expose the hidden dir; subtractMasked (as applyBashSandbox applies it)
    // must drop it — the masked path is unwritable, so it needs no protection
    const protectedZones = await resolveProtectedZones(agentDir)
    const filtered = subtractMasked(protectedZones, { dirs: [join(agentDir, 'workspace')], files: [] })

    expect(filtered.dirs).not.toContain(join(agentDir, 'workspace/hooks'))
    expect(filtered.dirs).toContain(join(agentDir, '.git/hooks'))
  })

  test('resolves a worktree .git file and protects the real gitdir controls', async () => {
    const commonDir = await mkdtemp(join(tmpdir(), 'typeclaw-common-git-'))
    try {
      const gitDir = join(commonDir, 'worktrees', 'agent')
      await mkdir(gitDir, { recursive: true })
      await writeFile(join(gitDir, 'commondir'), '../..\n')
      await writeFile(join(agentDir, '.git'), `gitdir: ${gitDir}\n`)
      await writeFile(join(commonDir, 'config'), '[core]\n\thooksPath = workspace/hooks\n')

      const { dirs, files } = await resolveProtectedZones(agentDir)

      expect(dirs).toContain(join(commonDir, 'hooks'))
      expect(dirs).toContain(join(agentDir, 'workspace/hooks'))
      expect(files).toContain(join(agentDir, '.git'))
      expect(files).toContain(join(commonDir, 'config'))
    } finally {
      await rm(commonDir, { recursive: true, force: true })
    }
  })
})

describe('resolveWritableZones package lifecycle boundary', () => {
  test('does not create node_modules while resolving ordinary writable zones', async () => {
    await resolveWritableZones(agentDir)
    expect(existsSync(join(agentDir, 'node_modules'))).toBe(false)
  })

  test.each(['node_modules', 'node_modules/typeclaw', 'src', 'scripts', 'packages'])(
    'does not expose executable dependency path %s as a normal writable zone',
    async (relative) => {
      await mkdir(join(agentDir, relative), { recursive: true })
      const zones = await resolveWritableZones(agentDir)
      expect(zones.dirs).not.toContain(join(agentDir, relative))
    },
  )

  test.each(['bun.lock', 'cron.json', 'package.json', 'typeclaw.json'])(
    'does not expose lifecycle/managed root file %s as a normal writable file',
    async (relative) => {
      await writeFile(join(agentDir, relative), 'x')
      const zones = await resolveWritableZones(agentDir)
      expect(zones.files).not.toContain(join(agentDir, relative))
    },
  )

  test('retains ordinary non-install scratch writes', async () => {
    for (const dir of ['workspace', 'public', 'mounts']) await mkdir(join(agentDir, dir))
    const zones = await resolveWritableZones(agentDir)
    expect(zones.dirs).toEqual(expect.arrayContaining(['workspace', 'public', 'mounts'].map((d) => join(agentDir, d))))
  })
})

describe('subtractMasked', () => {
  const w = (dirs: string[], files: string[]) => ({ dirs, files })

  test('drops a writable dir that is itself masked (guest workspace stays hidden)', () => {
    const result = subtractMasked(w(['/a/workspace', '/a/public', '/a/mounts'], ['/a/AGENTS.md']), {
      dirs: ['/a/workspace', '/a/memory', '/a/sessions'],
      files: ['/a/.env', '/a/secrets.json'],
    })

    expect(result.dirs).toEqual(['/a/public', '/a/mounts'])
    expect(result.files).toEqual(['/a/AGENTS.md'])
  })

  test('keeps all writable dirs when nothing is masked (member: only secret files masked)', () => {
    const result = subtractMasked(w(['/a/workspace', '/a/public', '/a/mounts'], ['/a/AGENTS.md']), {
      dirs: [],
      files: ['/a/.env', '/a/secrets.json'],
    })

    expect(result.dirs).toEqual(['/a/workspace', '/a/public', '/a/mounts'])
  })

  test('drops a writable path nested under a masked dir', () => {
    const result = subtractMasked(w(['/a/workspace/sub'], []), { dirs: ['/a/workspace'], files: [] })

    expect(result.dirs).toEqual([])
  })

  test('drops a writable file that is masked', () => {
    const result = subtractMasked(w([], ['/a/.env', '/a/AGENTS.md']), { dirs: [], files: ['/a/.env'] })

    expect(result.files).toEqual(['/a/AGENTS.md'])
  })

  test('does not drop a sibling that merely shares a masked prefix string', () => {
    const result = subtractMasked(w(['/a/workspace-public'], []), { dirs: ['/a/workspace'], files: [] })

    expect(result.dirs).toEqual(['/a/workspace-public'])
  })
})
