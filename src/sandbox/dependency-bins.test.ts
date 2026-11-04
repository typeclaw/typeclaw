import { describe, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

import {
  DEPENDENCY_BIN_DIR_NAME,
  dependencyBinUnavailableHint,
  reconcileDependencyBinWrappers,
} from './dependency-bins'

async function writeRootDependencies(agentDir: string, dependencies: Record<string, string>): Promise<void> {
  await writeFile(join(agentDir, 'package.json'), JSON.stringify({ name: 'test-agent', dependencies }))
}

async function writePackage(
  agentDir: string,
  packageName: string,
  bin: string | Record<string, string>,
): Promise<string> {
  const packageRoot = join(agentDir, 'node_modules', ...packageName.split('/'))
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: packageName, bin }))
  return packageRoot
}

describe('reconcileDependencyBinWrappers', () => {
  test('writes executable package wrappers and is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
    const sessionTmp = join(root, 'session')
    await writeRootDependencies(root, { opensoma: '^1.0.0' })
    const packageRoot = await writePackage(root, 'opensoma', { opensoma: 'dist/cli.js' })
    await mkdir(join(packageRoot, 'dist'))
    await writeFile(join(packageRoot, 'dist/cli.js'), '')

    const options = { agentDir: root, sessionTmp, baselineDirs: [] } as const
    await reconcileDependencyBinWrappers(options)
    const wrapper = join(sessionTmp, DEPENDENCY_BIN_DIR_NAME, 'opensoma')
    const first = await stat(wrapper)
    await reconcileDependencyBinWrappers(options)
    const second = await stat(wrapper)

    expect(await readFile(wrapper, 'utf8')).toBe(
      `#!/bin/sh\nexec bun '${(await realpath(join(packageRoot, 'dist/cli.js'))).split(sep).join('/')}' "$@"\n`,
    )
    if (process.platform !== 'win32') expect(first.mode & 0o777).toBe(0o755)
    expect(second.mtimeMs).toBe(first.mtimeMs)
  })

  test.skipIf(process.platform === 'win32')(
    'executes a package wrapper from the sandbox-visible agent directory',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'typeclaw-non-agent-root-'))
      const sessionTmp = join(root, 'session')
      await writeRootDependencies(root, { 'portable-package': '^1.0.0' })
      const packageRoot = await writePackage(root, 'portable-package', { portable: 'cli.js' })
      await writeFile(join(packageRoot, 'cli.js'), 'console.log(`portable:${process.argv.slice(2).join(",")}`)\n')

      await reconcileDependencyBinWrappers({ agentDir: root, sessionTmp, baselineDirs: [] })
      const wrapper = join(sessionTmp, DEPENDENCY_BIN_DIR_NAME, 'portable')
      const process = Bun.spawn([wrapper, 'one', 'two'], { stdout: 'pipe' })

      expect(await new Response(process.stdout).text()).toBe('portable:one,two\n')
      expect(await process.exited).toBe(0)
      expect(await readFile(wrapper, 'utf8')).toContain(
        (await realpath(join(root, 'node_modules', 'portable-package', 'cli.js'))).split(sep).join('/'),
      )
    },
  )

  test.skipIf(process.platform === 'win32')(
    'makes a direct dependency bin bare-command invocable without exposing a transitive bin',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
      const sessionTmp = join(root, 'session')
      await writeRootDependencies(root, { 'direct-package': '^1.0.0' })
      const directRoot = await writePackage(root, 'direct-package', { 'direct-cli': 'cli.js' })
      await writeFile(join(directRoot, 'cli.js'), 'console.log("direct-ok")\n')
      const transitiveRoot = await writePackage(root, 'transitive-package', { 'transitive-cli': 'cli.js' })
      await writeFile(join(transitiveRoot, 'cli.js'), 'console.log("transitive-bad")\n')

      const reconciliation = await reconcileDependencyBinWrappers({
        agentDir: root,
        sessionTmp,
        baselineDirs: [],
      })
      const entries = await readdir(reconciliation.wrapperDir)
      const child = Bun.spawn(['/bin/sh', '-c', 'direct-cli'], {
        env: { ...process.env, PATH: `${reconciliation.wrapperDir}:${process.env.PATH ?? ''}` },
        stdout: 'pipe',
      })
      const transitive = Bun.spawn(['/bin/sh', '-c', 'command -v transitive-cli'], {
        env: { ...process.env, PATH: `${reconciliation.wrapperDir}:${process.env.PATH ?? ''}` },
        stdout: 'pipe',
      })

      expect(await new Response(child.stdout).text()).toBe('direct-ok\n')
      expect(await child.exited).toBe(0)
      expect(await transitive.exited).not.toBe(0)
      expect(entries).toContain('direct-cli')
      expect(entries).not.toContain('transitive-cli')
    },
  )

  test('wraps runtime-provided bins that are not agent dependencies, without overriding a direct dependency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-runtime-'))
    const sessionTmp = join(root, 'session')
    await writeRootDependencies(root, { opensoma: '^1.0.0' })
    const packageRoot = await writePackage(root, 'opensoma', { opensoma: 'cli.js' })
    await writeFile(join(packageRoot, 'cli.js'), '')

    await reconcileDependencyBinWrappers({
      agentDir: root,
      sessionTmp,
      baselineDirs: [],
      runtimeBins: { typevault: '/runtime/typevault/cli.ts', opensoma: '/runtime/should-not-win.ts' },
    })

    const dir = join(sessionTmp, DEPENDENCY_BIN_DIR_NAME)
    expect(await readFile(join(dir, 'typevault'), 'utf8')).toContain("exec bun '/runtime/typevault/cli.ts'")
    expect(await readFile(join(dir, 'opensoma'), 'utf8')).not.toContain('should-not-win')
  })

  test('renders the structured operator-install hint for a known unavailable dependency bin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
    await writeRootDependencies(root, { opensoma: '^1.0.0' })
    await writePackage(root, 'opensoma', { opensoma: 'missing.js' })
    const reconciliation = await reconcileDependencyBinWrappers({
      agentDir: root,
      sessionTmp: join(root, 'session'),
      baselineDirs: [],
    })

    expect(dependencyBinUnavailableHint('opensoma session list', reconciliation)).toBe(
      '[typeclaw:capability-unavailable capability=dependency-bin dependency=opensoma bin=opensoma action=operator-install]',
    )
  })

  test('never generates a wrapper for the denied typeclaw binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
    await writeRootDependencies(root, { typeclaw: '^1.0.0' })
    const packageRoot = await writePackage(root, 'typeclaw', { typeclaw: 'cli.js', helper: 'helper.js' })
    await writeFile(join(packageRoot, 'cli.js'), '')
    await writeFile(join(packageRoot, 'helper.js'), '')

    const reconciliation = await reconcileDependencyBinWrappers({
      agentDir: root,
      sessionTmp: join(root, 'session'),
      baselineDirs: [],
    })

    expect(await readdir(reconciliation.wrapperDir)).not.toContain('typeclaw')
    expect(await readdir(reconciliation.wrapperDir)).toContain('helper')
  })

  test('never generates a package wrapper that shadows a trusted baseline executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
    const baseline = join(root, 'baseline')
    const bin = process.platform === 'win32' ? 'agent-browser' : 'sh'
    const baselineDirs = process.platform === 'win32' ? [baseline] : undefined
    await writeRootDependencies(root, { 'agent-browser': '^1.0.0' })
    if (baselineDirs !== undefined) await mkdir(baseline)
    const packageRoot = await writePackage(root, 'agent-browser', { [bin]: 'cli.js' })
    if (baselineDirs !== undefined) {
      await writeFile(join(baseline, bin), '#!/bin/sh\n')
      await chmod(join(baseline, bin), 0o755)
    }
    await writeFile(join(packageRoot, 'cli.js'), '')

    const reconciliation = await reconcileDependencyBinWrappers({
      agentDir: root,
      sessionTmp: join(root, 'session'),
      ...(baselineDirs !== undefined ? { baselineDirs } : {}),
    })

    expect(reconciliation.resolutions[0]?.kind).toBe('baseline')
    expect(await readdir(reconciliation.wrapperDir)).not.toContain(bin)
  })

  test('creates a wrapper when the operator installs a direct dependency mid-session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
    const sessionTmp = join(root, 'session')
    await writeRootDependencies(root, { 'late-package': '^1.0.0' })
    const options = { agentDir: root, sessionTmp, baselineDirs: [] } as const
    const first = await reconcileDependencyBinWrappers(options)
    expect(first.issues.some((issue) => issue.package === 'late-package')).toBe(true)

    const packageRoot = await writePackage(root, 'late-package', { 'late-cli': 'cli.js' })
    await writeFile(join(packageRoot, 'cli.js'), '')
    const second = await reconcileDependencyBinWrappers(options)

    expect(second.unavailable).toEqual([])
    expect(await readFile(join(sessionTmp, DEPENDENCY_BIN_DIR_NAME, 'late-cli'), 'utf8')).toContain(
      (await realpath(join(packageRoot, 'cli.js'))).split(sep).join('/'),
    )
  })

  test.skipIf(process.platform === 'win32')(
    'atomically replaces a wrapper symlink without touching its target',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
      const sessionTmp = join(root, 'session')
      await writeRootDependencies(root, { 'safe-package': '^1.0.0' })
      const packageRoot = await writePackage(root, 'safe-package', { safe: 'cli.js' })
      await writeFile(join(packageRoot, 'cli.js'), '')
      const wrapperDir = join(sessionTmp, DEPENDENCY_BIN_DIR_NAME)
      await mkdir(wrapperDir, { recursive: true })
      const protectedFile = join(root, 'protected.txt')
      await writeFile(protectedFile, 'protected')
      await symlink(protectedFile, join(wrapperDir, 'safe'))

      await reconcileDependencyBinWrappers({ agentDir: root, sessionTmp, baselineDirs: [] })

      expect(await readFile(protectedFile, 'utf8')).toBe('protected')
      expect(await readFile(join(wrapperDir, 'safe'), 'utf8')).toContain(
        (await realpath(join(packageRoot, 'cli.js'))).split(sep).join('/'),
      )
    },
  )

  test('parallel reconciliation leaves a complete executable wrapper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
    const sessionTmp = join(root, 'session')
    await writeRootDependencies(root, { 'parallel-package': '^1.0.0' })
    const packageRoot = await writePackage(root, 'parallel-package', { parallel: 'cli.js' })
    await writeFile(join(packageRoot, 'cli.js'), '')
    const options = { agentDir: root, sessionTmp, baselineDirs: [] } as const

    await Promise.all(Array.from({ length: 12 }, () => reconcileDependencyBinWrappers(options)))

    const wrapper = join(sessionTmp, DEPENDENCY_BIN_DIR_NAME, 'parallel')
    expect(await readFile(wrapper, 'utf8')).toBe(
      `#!/bin/sh\nexec bun '${(await realpath(join(packageRoot, 'cli.js'))).split(sep).join('/')}' "$@"\n`,
    )
    if (process.platform !== 'win32') expect((await stat(wrapper)).mode & 0o777).toBe(0o755)
  })

  test.skipIf(process.platform === 'win32')(
    'replaces a symlinked wrapper directory without touching its target',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'typeclaw-dependency-bins-'))
      const sessionTmp = join(root, 'session')
      const external = await mkdtemp(join(tmpdir(), 'typeclaw-wrapper-target-'))
      await writeRootDependencies(root, { 'directory-package': '^1.0.0' })
      const packageRoot = await writePackage(root, 'directory-package', { directory: 'cli.js' })
      await writeFile(join(packageRoot, 'cli.js'), '')
      await mkdir(sessionTmp, { recursive: true })
      await writeFile(join(external, 'keep.txt'), 'keep')
      await symlink(external, join(sessionTmp, DEPENDENCY_BIN_DIR_NAME))

      await reconcileDependencyBinWrappers({ agentDir: root, sessionTmp, baselineDirs: [] })

      expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('keep')
      expect((await lstat(join(sessionTmp, DEPENDENCY_BIN_DIR_NAME))).isSymbolicLink()).toBe(false)
    },
  )
})
