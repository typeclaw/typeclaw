import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import {
  _internal,
  editLocalConfigAtomically,
  ensureGitIdentity,
  hasExplicitGitIdentity,
  isFallbackGitIdentity,
  resolveGitIdentity,
  trackGithubGitIdentityEnv,
  syncConfiguredGitIdentity,
} from './resolve-identity'

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

  test('syncConfiguredGitIdentity replaces the synthesized fallback with git.user', async () => {
    const repo = await tempDir('typeclaw-git-identity-sync-')
    await git(repo, ['init', '-q'])
    await ensureGitIdentity(repo)

    await expect(syncConfiguredGitIdentity(repo, { name: '현무', email: 'hyeonmu@typeclaw.local' })).resolves.toBe(true)

    const identity = await resolveGitIdentity(repo)
    expect(identity).toEqual({ name: '현무', email: 'hyeonmu@typeclaw.local' })
    await expect(isFallbackGitIdentity(repo, identity!)).resolves.toBe(false)
  })

  test('syncConfiguredGitIdentity makes an exact fallback pair explicit', async () => {
    const repo = await tempDir('typeclaw-git-identity-sync-same-')
    await git(repo, ['init', '-q'])
    const fallback = await ensureGitIdentity(repo)

    await expect(syncConfiguredGitIdentity(repo, fallback!)).resolves.toBe(true)

    await expect(isFallbackGitIdentity(repo, fallback!)).resolves.toBe(false)
  })

  test('syncConfiguredGitIdentity refuses, without writing, when a config.worktree identity would shadow git.user', async () => {
    const repo = await tempDir('typeclaw-git-identity-sync-shadow-')
    await git(repo, ['init', '-q'])
    await git(repo, ['config', 'extensions.worktreeConfig', 'true'])
    await git(repo, ['config', '--worktree', 'user.name', 'Worktree Override'])
    const config = join(repo, '.git', 'config')
    const original = await readFile(config, 'utf8')

    await expect(syncConfiguredGitIdentity(repo, { name: 'Agent', email: 'agent@example.com' })).resolves.toBe(false)

    expect(await readFile(config, 'utf8')).toBe(original)
  })

  test('editLocalConfigAtomically applies no edit when a later one fails', async () => {
    const repo = await tempDir('typeclaw-git-identity-txn-')
    await git(repo, ['init', '-q'])
    await git(repo, ['config', '--local', 'user.name', 'Before'])
    const config = join(repo, '.git', 'config')
    const original = await readFile(config, 'utf8')

    await expect(
      editLocalConfigAtomically(repo, [
        ['--replace-all', 'user.name', 'After'],
        ['--replace-all', 'not a valid key', 'value'],
      ]),
    ).resolves.toBe(false)

    expect(await readFile(config, 'utf8')).toBe(original)
    expect(await Bun.file(`${config}.lock`).exists()).toBe(false)
  })

  test.skipIf(process.platform === 'win32')('editLocalConfigAtomically keeps a private config private', async () => {
    const repo = await tempDir('typeclaw-git-identity-txn-mode-')
    await git(repo, ['init', '-q'])
    const config = join(repo, '.git', 'config')
    await chmod(config, 0o600)

    await expect(editLocalConfigAtomically(repo, [['--replace-all', 'user.name', 'After']])).resolves.toBe(true)

    expect((await stat(config)).mode & 0o777).toBe(0o600)
    await expect(resolveGitIdentity(repo)).resolves.toBeNull()
    expect(await readFile(config, 'utf8')).toContain('name = After')
  })

  test('editLocalConfigAtomically leaves config to a git writer that holds the lock', async () => {
    const repo = await tempDir('typeclaw-git-identity-txn-locked-')
    await git(repo, ['init', '-q'])
    const config = join(repo, '.git', 'config')
    const original = await readFile(config, 'utf8')
    await writeFile(`${config}.lock`, '')

    await expect(editLocalConfigAtomically(repo, [['--replace-all', 'user.name', 'After']])).resolves.toBe(false)

    expect(await readFile(config, 'utf8')).toBe(original)
    expect(await Bun.file(`${config}.lock`).exists()).toBe(true)
  })

  test('syncConfiguredGitIdentity leaves config untouched when it already matches or git.user is unset', async () => {
    const repo = await tempDir('typeclaw-git-identity-sync-noop-')
    await git(repo, ['init', '-q'])
    await git(repo, ['config', '--local', 'user.name', 'Agent'])
    await git(repo, ['config', '--local', 'user.email', 'agent@example.com'])
    const config = join(repo, '.git', 'config')
    const before = await stat(config)

    await expect(syncConfiguredGitIdentity(repo, { name: 'Agent', email: 'agent@example.com' })).resolves.toBe(true)
    await expect(syncConfiguredGitIdentity(repo, undefined)).resolves.toBe(true)

    expect((await stat(config)).ino).toBe(before.ino)
  })

  test('hasExplicitGitIdentity is false only while the identity is missing or wholly synthesized', async () => {
    const missing = await tempDir('typeclaw-git-identity-explicit-missing-')
    await git(missing, ['init', '-q'])
    const synthesized = await tempDir('typeclaw-git-identity-explicit-fallback-')
    await git(synthesized, ['init', '-q'])
    await ensureGitIdentity(synthesized)
    const configured = await tempDir('typeclaw-git-identity-explicit-configured-')
    await git(configured, ['init', '-q'])
    await git(configured, ['config', '--local', 'user.name', 'Operator Pick'])
    await git(configured, ['config', '--local', 'user.email', 'pick@example.com'])

    await expect(hasExplicitGitIdentity(missing)).resolves.toBe(false)
    await expect(hasExplicitGitIdentity(synthesized)).resolves.toBe(false)
    await expect(hasExplicitGitIdentity(configured)).resolves.toBe(true)

    // ensureGitIdentity fills only the missing key; the operator's half stays
    // explicit, including when its value equals the folder-derived one
    for (const pick of [
      () => ['user.name', 'Operator Name'],
      () => ['user.email', 'operator@example.com'],
      (dir: string) => ['user.name', basename(dir)],
      (dir: string) => ['user.email', `${basename(dir).toLowerCase()}@typeclaw.local`],
    ]) {
      const partial = await tempDir('typeclaw-git-identity-explicit-partial-')
      await git(partial, ['init', '-q'])
      await git(partial, ['config', '--local', ...pick(partial)])
      await ensureGitIdentity(partial)
      await expect(hasExplicitGitIdentity(partial)).resolves.toBe(true)
    }
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

  test('runtime env follows the GitHub account and restores the start seed when it stops', () => {
    // given
    const env: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: 'Typeey',
      GIT_AUTHOR_EMAIL: 'typeey@typeclaw.local',
      GIT_COMMITTER_NAME: 'Operator',
    }
    const track = trackGithubGitIdentityEnv(new Set(['GIT_COMMITTER_NAME']), env)

    // when
    track({ login: 'typeey[bot]', id: 42 })

    // then
    expect(env).toEqual({
      GIT_AUTHOR_NAME: 'typeey[bot]',
      GIT_AUTHOR_EMAIL: '42+typeey[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'Operator',
      GIT_COMMITTER_EMAIL: '42+typeey[bot]@users.noreply.github.com',
    })

    // when
    track(null)

    // then
    expect(env).toEqual({
      GIT_AUTHOR_NAME: 'Typeey',
      GIT_AUTHOR_EMAIL: 'typeey@typeclaw.local',
      GIT_COMMITTER_NAME: 'Operator',
    })
  })

  test('runtime env keeps a configured git.user over the GitHub account, before and after it stops', () => {
    // given: git.user configured and an operator .env name
    const env: NodeJS.ProcessEnv = { GIT_AUTHOR_NAME: 'Typeey', GIT_COMMITTER_NAME: 'Operator' }
    const configured = { name: '현무', email: 'hyeonmu@typeclaw.local' }
    const track = trackGithubGitIdentityEnv(new Set(['GIT_COMMITTER_NAME']), env, () => configured)
    const expected = {
      GIT_AUTHOR_NAME: '현무',
      GIT_AUTHOR_EMAIL: 'hyeonmu@typeclaw.local',
      GIT_COMMITTER_NAME: 'Operator',
      GIT_COMMITTER_EMAIL: 'hyeonmu@typeclaw.local',
    }

    // when / then: the adapter registering does not replace git.user
    track({ login: 'typeey[bot]', id: 42 })
    expect(env).toEqual(expected)

    // when / then: nor does it stopping restore the start-time seed over it
    track(null)
    expect(env).toEqual(expected)
  })

  test('removing a git.user added after start falls back to the GitHub account, then to the start seed', () => {
    // given: git.user added after start, then the GitHub adapter registers
    const env: NodeJS.ProcessEnv = { GIT_AUTHOR_NAME: 'Typeey', GIT_AUTHOR_EMAIL: 'typeey@typeclaw.local' }
    let configured: { name: string; email: string } | undefined
    const track = trackGithubGitIdentityEnv(new Set(), env, () => configured)
    configured = { name: '현무', email: 'hyeonmu@typeclaw.local' }
    track({ login: 'typeey[bot]', id: 42 })
    expect(env['GIT_AUTHOR_NAME']).toBe('현무')

    // when: git.user is removed and the reload refreshes the env
    configured = undefined
    track.refresh()

    // then: the running adapter's account applies at once
    expect(env['GIT_AUTHOR_NAME']).toBe('typeey[bot]')

    // when / then: and once the adapter stops, the start-time seed comes back
    track(null)
    expect(env).toEqual({ GIT_AUTHOR_NAME: 'Typeey', GIT_AUTHOR_EMAIL: 'typeey@typeclaw.local' })
  })

  test('removing a git.user that start exported leaves runtime Git on the repo identity', () => {
    // given: start exported git.user, and .env declares the committer email
    const env: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: '현무',
      GIT_AUTHOR_EMAIL: 'hyeonmu@typeclaw.local',
      GIT_COMMITTER_NAME: '현무',
      GIT_COMMITTER_EMAIL: 'operator@example.com',
    }
    let configured: { name: string; email: string } | undefined = { name: '현무', email: 'hyeonmu@typeclaw.local' }
    const track = trackGithubGitIdentityEnv(new Set(['GIT_COMMITTER_EMAIL']), env, () => configured)

    // when
    configured = undefined
    track.refresh()

    // then: the exported names are cleared so Git reads the repo config
    expect(env).toEqual({ GIT_COMMITTER_EMAIL: 'operator@example.com' })
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
