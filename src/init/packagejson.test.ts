import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildBaseDockerfile } from './dockerfile'
import { AGENT_BROWSER_VERSION } from './index'
import { refreshPackageJson } from './packagejson'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-pkgjson-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writePkg(content: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, 'package.json'), `${JSON.stringify(content, null, 2)}\n`)
}

async function readPkg(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>
}

describe('refreshPackageJson', () => {
  test('injects workspaces and creates packages/.gitkeep when both are missing', async () => {
    await writePkg({ name: 'agent', private: true, type: 'module', dependencies: { typeclaw: 'file:../typeclaw' } })

    const result = await refreshPackageJson(root)

    expect(result.changed).toBe(true)
    expect(result.files.sort()).toEqual(['package.json', 'packages/.gitkeep'])
    const pkg = await readPkg()
    expect(pkg.workspaces).toEqual(['packages/*'])
    expect(existsSync(join(root, 'packages', '.gitkeep'))).toBe(true)
  })

  test('is idempotent: a second call after the first reports no changes', async () => {
    await writePkg({ name: 'agent', private: true, type: 'module' })

    const first = await refreshPackageJson(root)
    const second = await refreshPackageJson(root)

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(second.files).toEqual([])
  })

  test('preserves an existing workspaces field (does not clobber a customized layout)', async () => {
    await writePkg({
      name: 'agent',
      private: true,
      type: 'module',
      workspaces: ['custom/*', 'libs/*'],
      overrides: { bson: '6.10.4' },
    })

    const result = await refreshPackageJson(root)

    const pkg = await readPkg()
    expect(pkg.workspaces).toEqual(['custom/*', 'libs/*'])
    // package.json is unchanged, but .gitkeep may still be created if missing
    expect(result.files).not.toContain('package.json')
  })

  test('adds Bun-compatible dependency overrides to existing agents', async () => {
    await writePkg({ name: 'agent', private: true, type: 'module', dependencies: { typeclaw: 'file:../typeclaw' } })

    const result = await refreshPackageJson(root)

    const pkg = await readPkg()
    expect(result.files).toContain('package.json')
    expect(pkg.overrides).toEqual({ bson: '6.10.4' })
  })

  test('preserves existing overrides while adding missing Bun-compatible dependency overrides', async () => {
    await writePkg({
      name: 'agent',
      private: true,
      type: 'module',
      workspaces: ['packages/*'],
      overrides: { 'left-pad': '1.3.0' },
    })

    const result = await refreshPackageJson(root)

    const pkg = await readPkg()
    expect(result.files).toContain('package.json')
    expect(pkg.overrides).toEqual({ 'left-pad': '1.3.0', bson: '6.10.4' })
  })

  test('preserves all other top-level fields (name, deps, scripts, custom keys)', async () => {
    await writePkg({
      name: 'my-agent',
      private: true,
      type: 'module',
      scripts: { test: 'bun test' },
      dependencies: {
        typeclaw: 'file:../typeclaw',
        'agent-browser': '^0.27.0',
        'typeclaw-gws-multi-account': '^0.3.4',
      },
      devDependencies: { '@types/bun': 'latest' },
      customField: { keep: 'me' },
    })

    await refreshPackageJson(root)

    const pkg = await readPkg()
    expect(pkg.name).toBe('my-agent')
    expect(pkg.private).toBe(true)
    expect(pkg.type).toBe('module')
    expect(pkg.scripts).toEqual({ test: 'bun test' })
    expect(pkg.dependencies).toEqual({
      typeclaw: 'file:../typeclaw',
      'agent-browser': '^0.27.0',
      'typeclaw-gws-multi-account': '^0.3.4',
    })
    expect(pkg.devDependencies).toEqual({ '@types/bun': 'latest' })
    expect(pkg.customField).toEqual({ keep: 'me' })
  })

  test('places workspaces immediately after type for clean diffs', async () => {
    await writePkg({
      name: 'agent',
      private: true,
      type: 'module',
      dependencies: { typeclaw: 'file:../typeclaw' },
    })

    await refreshPackageJson(root)

    const raw = await readFile(join(root, 'package.json'), 'utf8')
    const typeIdx = raw.indexOf('"type"')
    const workspacesIdx = raw.indexOf('"workspaces"')
    const dependenciesIdx = raw.indexOf('"dependencies"')
    expect(typeIdx).toBeGreaterThan(-1)
    expect(workspacesIdx).toBeGreaterThan(typeIdx)
    expect(workspacesIdx).toBeLessThan(dependenciesIdx)
  })

  test('skips silently when package.json is missing (folder not initialized)', async () => {
    const result = await refreshPackageJson(root)

    // gitkeep is still created — it's orthogonal to package.json existence
    expect(result.changed).toBe(true)
    expect(result.files).toEqual(['packages/.gitkeep'])
    expect(existsSync(join(root, 'package.json'))).toBe(false)
    expect(existsSync(join(root, 'packages', '.gitkeep'))).toBe(true)
  })

  test('skips silently when package.json is unparseable (never touches corrupt files)', async () => {
    await writeFile(join(root, 'package.json'), '{ not json')

    const result = await refreshPackageJson(root)

    // gitkeep created, but package.json is left alone
    expect(result.files).not.toContain('package.json')
    const raw = await readFile(join(root, 'package.json'), 'utf8')
    expect(raw).toBe('{ not json')
  })

  test('skips silently when package.json is a non-object JSON value', async () => {
    await writeFile(join(root, 'package.json'), '[1, 2, 3]')

    const result = await refreshPackageJson(root)

    expect(result.files).not.toContain('package.json')
    const raw = await readFile(join(root, 'package.json'), 'utf8')
    expect(raw).toBe('[1, 2, 3]')
  })

  test('creates packages/ directory if it does not exist when writing .gitkeep', async () => {
    await writePkg({ name: 'agent', private: true, type: 'module' })

    await refreshPackageJson(root)

    expect(existsSync(join(root, 'packages'))).toBe(true)
    expect(existsSync(join(root, 'packages', '.gitkeep'))).toBe(true)
  })

  test('skips writing .gitkeep when it already exists with non-empty content (does not clobber)', async () => {
    await writePkg({ name: 'agent', private: true, type: 'module' })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, 'packages'), { recursive: true })
    const customContent = '# placeholder for git-tracked empty dir, do not delete\n'
    await writeFile(join(root, 'packages', '.gitkeep'), customContent)

    const result = await refreshPackageJson(root)

    expect(result.files).not.toContain('packages/.gitkeep')
    expect(await readFile(join(root, 'packages', '.gitkeep'), 'utf8')).toBe(customContent)
  })
})

describe('agent-browser version lockstep', () => {
  test('scaffolded agent-runtime dep matches the Dockerfile Layer 4 global install', () => {
    const dockerfile = buildBaseDockerfile()
    const match = dockerfile.match(/bun install -g agent-browser@(\S+)/)

    expect(match?.[1]).toBe(AGENT_BROWSER_VERSION)
  })
})
