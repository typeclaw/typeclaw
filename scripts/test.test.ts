import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  collectChangeSet,
  createImportGraph,
  type ImportGraph,
  listModuleFiles,
  readPreloads,
  selectImpactedTests,
} from './test'

function fakeGraph(imports: Record<string, string[]>): ImportGraph {
  return {
    files: [...new Set([...Object.keys(imports), ...Object.values(imports).flat()])],
    importsOf: (file) => imports[file] ?? [],
  }
}

const graph = fakeGraph({
  'src/a/a.test.ts': ['src/a/a.ts'],
  'src/a/a.ts': ['src/shared/util.ts'],
  'src/b/b.test.ts': ['src/b/b.ts'],
  'src/c/c.test.ts': ['src/shared/util.ts'],
  'scripts/require-parallel.ts': ['src/preload-helper.ts'],
})

describe('selectImpactedTests', () => {
  test('selects transitive importers and leaves unrelated tests out', () => {
    expect(selectImpactedTests(['src/shared/util.ts'], [], graph)).toEqual({
      mode: 'files',
      files: ['src/a/a.test.ts', 'src/c/c.test.ts'],
    })
  })

  test('selects a changed test file itself', () => {
    expect(selectImpactedTests(['src/b/b.test.ts'], [], graph)).toEqual({ mode: 'files', files: ['src/b/b.test.ts'] })
  })

  test('terminates on an import cycle', () => {
    const cycle = fakeGraph({ 'src/x.test.ts': ['src/x.ts'], 'src/x.ts': ['src/y.ts'], 'src/y.ts': ['src/x.ts'] })
    expect(selectImpactedTests(['src/y.ts'], [], cycle)).toEqual({ mode: 'files', files: ['src/x.test.ts'] })
  })

  test('selects nothing when only non-inputs changed', () => {
    const changed = ['README.md', 'docs/content/docs/a.mdx', 'docs/app/page.tsx', '.github/workflows/ci.yml']
    expect(selectImpactedTests(changed, [], graph)).toEqual({ mode: 'files', files: [] })
  })

  test.each(['package.json', 'bun.lock', 'bunfig.toml', 'src/skills/a/SKILL.md', 'src/x/__fixtures__/a.txt'])(
    'runs everything when non-module input %s changes',
    (file) => {
      expect(selectImpactedTests([file], [], graph).mode).toBe('full')
    },
  )

  test('runs everything when a module was deleted, since its importers no longer resolve to it', () => {
    expect(selectImpactedTests(['src/deleted.ts'], [], graph).mode).toBe('full')
  })

  test('does not run everything for a deleted test file', () => {
    expect(selectImpactedTests(['src/deleted.test.ts'], [], graph)).toEqual({ mode: 'files', files: [] })
  })

  test('runs everything when a change reaches a test preload', () => {
    expect(selectImpactedTests(['src/preload-helper.ts'], ['scripts/require-parallel.ts'], graph).mode).toBe('full')
    expect(selectImpactedTests(['src/b/b.ts'], ['scripts/require-parallel.ts'], graph).mode).toBe('files')
  })
})

describe('with a real repository', () => {
  let root: string | undefined

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  function fixture(files: Record<string, string>): string {
    root = mkdtempSync(join(tmpdir(), 'impacted-tests-'))
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    return root
  }

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false']
    return (await Bun.$`git ${identity} ${args}`.cwd(cwd).quiet()).stdout.toString().trim()
  }

  test('the graph follows imports through path aliases and a symlinked checkout, and drops type-only imports', () => {
    const repo = fixture({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
      'src/a.test.ts':
        "#!/usr/bin/env bun\nimport { a } from '@/a'\nimport type { T } from './types'\nimport 'node:fs'\n",
      'src/a.ts': 'export const a = 1\n',
      'src/types.ts': 'export type T = string\n',
    })
    const linked = `${repo}-link`
    symlinkSync(repo, linked)

    try {
      const graph = createImportGraph(linked, ['src/a.test.ts', 'src/a.ts', 'src/types.ts'])

      expect(graph.importsOf('src/a.test.ts')).toEqual(['src/a.ts'])
    } finally {
      rmSync(linked, { force: true })
    }
  })

  test('the graph follows modules that a test only reaches by path', () => {
    const files = {
      'app/cli/role.test.ts': "const entry = join(import.meta.dir, 'index.ts')\nBun.spawn(['bun', entry])\n",
      'app/cli/index.ts': '',
      'app/run/process.test.ts': "const worker = `import { x } from './app/run/worker.ts'`\n",
      'app/run/worker.ts': '',
      'app/run/url.test.ts': "new URL('../cli/index.ts', import.meta.url)\nawait import(`./lazy?v=${Date.now()}`)\n",
      'app/run/lazy.ts': '',
      'app/run/nested.test.ts': "join(import.meta.dir, '..', 'plugin', 'index.ts')\n",
      'app/plugin/index.ts': '',
      'app/run/unrelated.test.ts': "const message = 'nothing/here.ts'\n",
    }
    const graph = createImportGraph(fixture(files), Object.keys(files))

    expect(graph.importsOf('app/cli/role.test.ts')).toEqual(['app/cli/index.ts'])
    expect(graph.importsOf('app/run/process.test.ts')).toEqual(['app/run/worker.ts'])
    expect([...graph.importsOf('app/run/url.test.ts')].sort()).toEqual(['app/cli/index.ts', 'app/run/lazy.ts'])
    expect(graph.importsOf('app/run/nested.test.ts')).toEqual(['app/plugin/index.ts'])
    expect(graph.importsOf('app/run/unrelated.test.ts')).toEqual([])
  })

  test('a runtime module counts siblings it names as quoted files, but not prose or repo-root paths', () => {
    const files = {
      'app/launcher.ts': "const script = join(import.meta.dir, 'worker.ts')\n",
      'app/worker.ts': '',
      'app/prose.ts': "// worker.ts and `worker.ts` are mentioned here\nconst note = 'app/worker.ts'\n",
    }
    const graph = createImportGraph(fixture(files), Object.keys(files))

    expect(graph.importsOf('app/launcher.ts')).toEqual(['app/worker.ts'])
    expect(graph.importsOf('app/prose.ts')).toEqual([])
  })

  test('the graph tells the caller how to recover from a file it cannot scan', () => {
    const repo = fixture({ 'src/broken.ts': 'import {{{ from\n' })

    expect(() => createImportGraph(repo, ['src/broken.ts']).importsOf('src/broken.ts')).toThrow('--full')
  })

  test('the change set counts branch, staged, unstaged, and untracked files but not commits on main', async () => {
    const remote = fixture({ 'src/main-later.ts': '', 'src/branch.ts': '', 'src/staged.ts': '', 'src/unstaged.ts': '' })
    await git(remote, 'init', '-q', '-b', 'main')
    await git(remote, 'add', '.')
    await git(remote, 'commit', '-qm', 'init')
    await git(remote, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    await git(remote, 'switch', '-qc', 'feature')
    writeFileSync(join(remote, 'src/branch.ts'), 'export const a = 1\n')
    await git(remote, 'commit', '-qam', 'branch')

    // origin/main moves past the merge-base with a change the branch does not have.
    await git(remote, 'switch', '-qc', 'later', 'origin/main')
    writeFileSync(join(remote, 'src/main-later.ts'), 'export const b = 1\n')
    await git(remote, 'commit', '-qam', 'later')
    await git(remote, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    await git(remote, 'switch', '-q', 'feature')

    writeFileSync(join(remote, 'src/staged.ts'), 'export const c = 1\n')
    await git(remote, 'add', 'src/staged.ts')
    writeFileSync(join(remote, 'src/unstaged.ts'), 'export const d = 1\n')
    writeFileSync(join(remote, 'src/untracked.ts'), '')

    const changeSet = await collectChangeSet(remote)

    expect(changeSet.files).toEqual(['src/branch.ts', 'src/staged.ts', 'src/unstaged.ts', 'src/untracked.ts'])
    expect(changeSet.baseLabel).toBe('merge-base with origin/main')
  })

  test('the change set falls back to HEAD without origin/main', async () => {
    const repo = fixture({ 'src/a.ts': '' })
    await git(repo, 'init', '-q', '-b', 'main')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-qm', 'init')
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1\n')

    const changeSet = await collectChangeSet(repo)

    expect(changeSet.base).toBe(await git(repo, 'rev-parse', 'HEAD'))
    expect(changeSet.files).toEqual(['src/a.ts'])
  })

  test('the change set fails with a recovery hint outside a git checkout', async () => {
    const repo = fixture({ 'src/a.ts': '' })

    await expect(collectChangeSet(repo)).rejects.toThrow('--full')
  })

  test('module listing keeps tracked and untracked modules under the module roots only', async () => {
    const repo = fixture({
      'src/tracked.ts': '',
      'src/removed.ts': '',
      'scripts/tool.ts': '',
      'docs/app/page.tsx': '',
      'src/skill.md': '',
      '.gitignore': 'src/ignored.ts\n',
      'src/ignored.ts': '',
    })
    await git(repo, 'init', '-q', '-b', 'main')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-qm', 'init')
    rmSync(join(repo, 'src/removed.ts'))
    writeFileSync(join(repo, 'src/untracked.ts'), '')

    expect((await listModuleFiles(repo)).sort()).toEqual(['scripts/tool.ts', 'src/tracked.ts', 'src/untracked.ts'])
  })

  test('preloads keep repository paths and skip packages', () => {
    const repo = fixture({ 'bunfig.toml': '[test]\npreload = ["./scripts/setup.ts", "@acme/preload"]\n' })

    expect(readPreloads(repo)).toEqual(['scripts/setup.ts'])
  })
})
