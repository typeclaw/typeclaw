import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _internal, ensureGitIdentity, isFallbackGitIdentity, resolveGitIdentity } from './resolve-identity'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn({
    cmd: ['git', '-c', 'core.hooksPath=/dev/null', ...args],
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await proc.exited).toBe(0)
}

describe('resolveGitIdentity', () => {
  test('reads a complete repository-local identity', async () => {
    const repo = await tempDir('typeclaw-git-identity-')
    await git(repo, ['init', '-q'])
    await git(repo, ['config', '--local', 'user.name', 'Agent Smith'])
    await git(repo, ['config', '--local', 'user.email', 'agent@example.com'])

    await expect(resolveGitIdentity(repo)).resolves.toEqual({ name: 'Agent Smith', email: 'agent@example.com' })
  })

  test('reads identity through a linked worktree git pointer', async () => {
    const repo = await tempDir('typeclaw-git-identity-main-')
    const worktree = await tempDir('typeclaw-git-identity-worktree-')
    await rm(worktree, { recursive: true })
    await git(repo, ['init', '-q'])
    await git(repo, ['config', '--local', 'user.name', 'Worktree Agent'])
    await git(repo, ['config', '--local', 'user.email', 'worktree@example.com'])
    await writeFile(join(repo, 'README.md'), 'test\n')
    await git(repo, ['add', 'README.md'])
    await git(repo, ['commit', '-qm', 'init'])
    await git(repo, ['worktree', 'add', '-q', '-b', 'test-worktree', worktree])
    await git(repo, ['config', 'extensions.worktreeConfig', 'true'])
    await git(worktree, ['config', '--worktree', 'user.name', 'Worktree Override'])

    await expect(resolveGitIdentity(worktree)).resolves.toEqual({
      name: 'Worktree Override',
      email: 'worktree@example.com',
    })
  })

  test('reads identity from a relocated .gitstore repository', async () => {
    const repo = await tempDir('typeclaw-git-identity-store-')
    await git(repo, ['init', '-q', '--separate-git-dir', join(repo, '.gitstore')])
    await rm(join(repo, '.git'))
    await git(repo, [
      '--git-dir',
      join(repo, '.gitstore'),
      '--work-tree',
      repo,
      'config',
      '--local',
      'user.name',
      'Store Agent',
    ])
    await git(repo, [
      '--git-dir',
      join(repo, '.gitstore'),
      '--work-tree',
      repo,
      'config',
      '--local',
      'user.email',
      'store@example.com',
    ])

    await expect(resolveGitIdentity(repo)).resolves.toEqual({ name: 'Store Agent', email: 'store@example.com' })
  })

  test('returns null for a partial identity or a non-repository', async () => {
    const partial = await tempDir('typeclaw-git-identity-partial-')
    const plain = await tempDir('typeclaw-git-identity-plain-')
    await git(partial, ['init', '-q'])
    await git(partial, ['config', '--local', 'user.name', 'Name Only'])

    await expect(resolveGitIdentity(partial)).resolves.toBeNull()
    await expect(resolveGitIdentity(plain)).resolves.toBeNull()
  })

  test('ensureGitIdentity persists a folder-name identity when none is configured', async () => {
    const repo = join(await tempDir('typeclaw-git-identity-ensure-'), 'Paul Agent')
    await mkdir(repo)
    await git(repo, ['init', '-q'])

    const expected = { name: 'Paul Agent', email: 'paul-agent@typeclaw.local' }
    await expect(ensureGitIdentity(repo)).resolves.toEqual(expected)
    await expect(resolveGitIdentity(repo)).resolves.toEqual(expected)
  })

  test('ensureGitIdentity keeps configured values and fills only the missing key', async () => {
    const complete = await tempDir('typeclaw-git-identity-keep-')
    await git(complete, ['init', '-q'])
    await git(complete, ['config', '--local', 'user.name', 'Agent Smith'])
    await git(complete, ['config', '--local', 'user.email', 'agent@example.com'])
    const partial = join(await tempDir('typeclaw-git-identity-partial-fill-'), '폴')
    await mkdir(partial)
    await git(partial, ['init', '-q'])
    await git(partial, ['config', '--local', 'user.name', '폴 (Paul)'])

    await expect(ensureGitIdentity(complete)).resolves.toEqual({ name: 'Agent Smith', email: 'agent@example.com' })
    await expect(ensureGitIdentity(partial)).resolves.toEqual({ name: '폴 (Paul)', email: 'agent@typeclaw.local' })
    await expect(resolveGitIdentity(partial)).resolves.toEqual({ name: '폴 (Paul)', email: 'agent@typeclaw.local' })
  })

  test('isFallbackGitIdentity matches only the identity ensureGitIdentity synthesized', async () => {
    const synthesized = join(await tempDir('typeclaw-git-identity-marker-'), 'Paul')
    await mkdir(synthesized)
    await git(synthesized, ['init', '-q'])
    const configured = join(await tempDir('typeclaw-git-identity-configured-'), 'Paul')
    await mkdir(configured)
    await git(configured, ['init', '-q'])
    await git(configured, ['config', '--local', 'user.name', 'Paul'])
    await git(configured, ['config', '--local', 'user.email', 'paul@example.com'])

    const fallback = await ensureGitIdentity(synthesized)
    const kept = await ensureGitIdentity(configured)

    expect(fallback).toEqual({ name: 'Paul', email: 'paul@typeclaw.local' })
    await expect(isFallbackGitIdentity(synthesized, fallback!)).resolves.toBe(true)
    await expect(isFallbackGitIdentity(synthesized, { name: 'Hatched', email: 'paul@typeclaw.local' })).resolves.toBe(
      false,
    )
    await expect(isFallbackGitIdentity(configured, kept!)).resolves.toBe(false)
  })

  test('ensureGitIdentity leaves a non-repository untouched', async () => {
    const plain = await tempDir('typeclaw-git-identity-ensure-plain-')

    await expect(ensureGitIdentity(plain)).resolves.toBeNull()
  })

  test('ignores ambient Git config injection when resolving repository identity', async () => {
    const repo = await tempDir('typeclaw-git-identity-injection-')
    await git(repo, ['init', '-q'])
    const previous = {
      count: process.env.GIT_CONFIG_COUNT,
      key0: process.env.GIT_CONFIG_KEY_0,
      value0: process.env.GIT_CONFIG_VALUE_0,
      key1: process.env.GIT_CONFIG_KEY_1,
      value1: process.env.GIT_CONFIG_VALUE_1,
    }
    process.env.GIT_CONFIG_COUNT = '2'
    process.env.GIT_CONFIG_KEY_0 = 'user.name'
    process.env.GIT_CONFIG_VALUE_0 = 'Injected Agent'
    process.env.GIT_CONFIG_KEY_1 = 'user.email'
    process.env.GIT_CONFIG_VALUE_1 = 'injected@example.com'
    try {
      await expect(resolveGitIdentity(repo)).resolves.toBeNull()
    } finally {
      for (const [name, value] of [
        ['GIT_CONFIG_COUNT', previous.count],
        ['GIT_CONFIG_KEY_0', previous.key0],
        ['GIT_CONFIG_VALUE_0', previous.value0],
        ['GIT_CONFIG_KEY_1', previous.key1],
        ['GIT_CONFIG_VALUE_1', previous.value1],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  test('scrubs Git controls case-insensitively for Windows environment semantics', () => {
    expect(
      _internal.withoutGitOverrides({
        git_config_count: '1',
        Git_Config_Key_0: 'user.name',
        GIT_CONFIG_VALUE_0: 'Injected Agent',
        Git_Dir: 'decoy',
        git_work_tree: 'decoy',
        PATH: 'safe',
      }),
    ).toEqual({ PATH: 'safe' })
  })
})
