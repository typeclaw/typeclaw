import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { DevDepError, type GitResult, type SpawnGit, switchTypeclawDependency } from './index'

let root: string
let agentRoot: string
let localCheckout: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-devdep-'))
  agentRoot = join(root, 'agent')
  localCheckout = join(root, 'typeclaw')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function setupAgent(typeclawSpec: string): Promise<void> {
  await mkdir(agentRoot)
  await writeFile(
    join(agentRoot, 'package.json'),
    `${JSON.stringify({ name: 'agent', private: true, dependencies: { typeclaw: typeclawSpec } }, null, 2)}\n`,
  )
}

async function setupLocalCheckout(name = 'typeclaw'): Promise<void> {
  await mkdir(localCheckout)
  await writeFile(join(localCheckout, 'package.json'), JSON.stringify({ name, version: '9.9.9' }))
}

async function mkdir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  await (await import('node:fs/promises')).mkdir(dir, { recursive: true })
}

async function readSpec(): Promise<string | undefined> {
  const raw = await readFile(join(agentRoot, 'package.json'), 'utf8')
  return (JSON.parse(raw) as { dependencies?: Record<string, string> }).dependencies?.typeclaw
}

// Records git invocations and answers from a scripted state machine so commit
// behavior is testable without a real repo. `dirtyFiles` is emitted in
// `git status --porcelain` shape (`XY <path>`) so the gate parser is exercised.
function fakeGit(opts: { isRepo: boolean; dirtyFiles?: string[] }): {
  spawnGit: SpawnGit
  calls: string[][]
} {
  const calls: string[][] = []
  const spawnGit: SpawnGit = async (args) => {
    calls.push([...args])
    const ok = (stdout = ''): GitResult => ({ exitCode: 0, stdout, stderr: '' })
    if (args[0] === 'rev-parse')
      return opts.isRepo ? ok('true\n') : { exitCode: 128, stdout: '', stderr: 'not a git repository' }
    if (args[0] === 'status') return ok((opts.dirtyFiles ?? []).map((f) => ` M ${f}`).join('\n'))
    if (args[0] === 'add') return ok()
    if (args[0] === 'commit') return ok()
    return ok()
  }
  return { spawnGit, calls }
}

describe('switchTypeclawDependency — local mode', () => {
  test('writes a file: spec relative to the agent root and commits package.json', async () => {
    await setupAgent('^0.39.0')
    await setupLocalCheckout()
    const git = fakeGit({ isRepo: true })

    const result = await switchTypeclawDependency({
      agentRoot,
      mode: 'local',
      localPath: localCheckout,
      spawnGit: git.spawnGit,
    })

    expect(result.changed).toBe(true)
    expect(result.oldSpec).toBe('^0.39.0')
    expect(result.newSpec).toBe(`file:${relative(agentRoot, localCheckout).split(/[\\/]/).join('/')}`)
    expect(await readSpec()).toBe(result.newSpec)
    expect(result.committed).toBe(true)
    expect(result.commitSubject).toBe('deps: switch typeclaw to local')
    expect(git.calls.some((c) => c[0] === 'commit' && c.includes('deps: switch typeclaw to local'))).toBe(true)
  })

  test('rejects a --path whose package.json#name is not "typeclaw"', async () => {
    await setupAgent('^0.39.0')
    await setupLocalCheckout('not-typeclaw')

    await expect(
      switchTypeclawDependency({ agentRoot, mode: 'local', localPath: localCheckout, commit: false }),
    ).rejects.toMatchObject({ detail: { kind: 'local-path-not-typeclaw' } })
  })

  test('reuses an existing file: spec when no --path is given', async () => {
    await setupLocalCheckout()
    await setupAgent(`file:${relative(agentRoot, localCheckout).split(/[\\/]/).join('/')}`)

    const result = await switchTypeclawDependency({ agentRoot, mode: 'local', commit: false })

    expect(result.changed).toBe(false)
  })

  test('errors when no --path and no local checkout can be derived from an npm spec', async () => {
    await setupAgent('^0.39.0')

    await expect(
      switchTypeclawDependency({
        agentRoot,
        mode: 'local',
        commit: false,
        findRunningCliCheckout: () => null,
      }),
    ).rejects.toMatchObject({ detail: { kind: 'local-path-unresolved' } })
  })
})

describe('switchTypeclawDependency — npm mode', () => {
  test('writes ^<version> from an explicit version and commits', async () => {
    await setupAgent('file:../typeclaw')
    const git = fakeGit({ isRepo: true })

    const result = await switchTypeclawDependency({
      agentRoot,
      mode: 'npm',
      version: '0.40.0',
      spawnGit: git.spawnGit,
    })

    expect(result.newSpec).toBe('^0.40.0')
    expect(await readSpec()).toBe('^0.40.0')
    expect(result.commitSubject).toBe('deps: switch typeclaw to npm')
  })

  test('normalizes a caret-prefixed version input', async () => {
    await setupAgent('file:../typeclaw')

    const result = await switchTypeclawDependency({ agentRoot, mode: 'npm', version: '^1.2.3', commit: false })

    expect(result.newSpec).toBe('^1.2.3')
  })

  test('rejects an invalid version', async () => {
    await setupAgent('file:../typeclaw')

    await expect(
      switchTypeclawDependency({ agentRoot, mode: 'npm', version: 'latest', commit: false }),
    ).rejects.toMatchObject({ detail: { kind: 'invalid-version' } })
  })

  test('defaults to the agent installed version when no --version is given (source-checkout safe)', async () => {
    await setupAgent('file:../typeclaw')
    await mkdir(join(agentRoot, 'node_modules', 'typeclaw'))
    await writeFile(
      join(agentRoot, 'node_modules', 'typeclaw', 'package.json'),
      JSON.stringify({ name: 'typeclaw', version: '0.41.0' }),
    )

    const result = await switchTypeclawDependency({ agentRoot, mode: 'npm', commit: false })

    expect(result.newSpec).toBe('^0.41.0')
  })

  test('falls back to a release ^version when no --version and no installed package (CLI_VERSION)', async () => {
    await setupAgent('file:../typeclaw')

    const result = await switchTypeclawDependency({ agentRoot, mode: 'npm', commit: false })

    expect(result.newSpec).toMatch(/^\^\d+\.\d+\.\d+$/)
  })
})

describe('switchTypeclawDependency — commit safety', () => {
  test('refuses to commit and leaves package.json unchanged when unrelated changes exist', async () => {
    await setupAgent('^0.39.0')
    await setupLocalCheckout()
    const git = fakeGit({ isRepo: true, dirtyFiles: ['other.ts'] })

    await expect(
      switchTypeclawDependency({ agentRoot, mode: 'local', localPath: localCheckout, spawnGit: git.spawnGit }),
    ).rejects.toBeInstanceOf(DevDepError)

    expect(await readSpec()).toBe('^0.39.0')
    expect(git.calls.some((c) => c[0] === 'commit')).toBe(false)
  })

  test('refuses to commit a pre-existing package.json change so it is not bundled', async () => {
    await setupAgent('^0.39.0')
    await setupLocalCheckout()
    const git = fakeGit({ isRepo: true, dirtyFiles: ['package.json'] })

    await expect(
      switchTypeclawDependency({ agentRoot, mode: 'local', localPath: localCheckout, spawnGit: git.spawnGit }),
    ).rejects.toMatchObject({ detail: { kind: 'commit-blocked-dirty' } })

    expect(await readSpec()).toBe('^0.39.0')
    expect(git.calls.some((c) => c[0] === 'commit')).toBe(false)
  })

  test('writes package.json but does not commit in a non-git folder', async () => {
    await setupAgent('^0.39.0')
    await setupLocalCheckout()
    const git = fakeGit({ isRepo: false })

    const result = await switchTypeclawDependency({
      agentRoot,
      mode: 'local',
      localPath: localCheckout,
      spawnGit: git.spawnGit,
    })

    expect(result.changed).toBe(true)
    expect(result.committed).toBe(false)
    expect(git.calls.some((c) => c[0] === 'commit')).toBe(false)
  })

  test('--no-commit writes package.json without touching git', async () => {
    await setupAgent('^0.39.0')
    await setupLocalCheckout()
    const git = fakeGit({ isRepo: true })

    const result = await switchTypeclawDependency({
      agentRoot,
      mode: 'local',
      localPath: localCheckout,
      commit: false,
      spawnGit: git.spawnGit,
    })

    expect(result.committed).toBe(false)
    expect(git.calls.length).toBe(0)
  })
})

describe('switchTypeclawDependency — errors', () => {
  test('throws no-package-json when agent folder has none', async () => {
    await mkdir(agentRoot)

    await expect(
      switchTypeclawDependency({ agentRoot, mode: 'npm', version: '1.0.0', commit: false }),
    ).rejects.toMatchObject({ detail: { kind: 'no-package-json' } })
  })

  test('throws no-typeclaw-dependency when dependencies lacks typeclaw', async () => {
    await mkdir(agentRoot)
    await writeFile(join(agentRoot, 'package.json'), JSON.stringify({ name: 'agent', dependencies: { zod: '^4' } }))

    await expect(
      switchTypeclawDependency({ agentRoot, mode: 'npm', version: '1.0.0', commit: false }),
    ).rejects.toMatchObject({ detail: { kind: 'no-typeclaw-dependency' } })
  })
})
