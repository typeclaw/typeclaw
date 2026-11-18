import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { syncConfiguredGitRemotes } from './configured-remotes'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function agentRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-git-remotes-'))
  roots.push(dir)
  await git(dir, ['init', '-q'])
  return dir
}

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  expect(await proc.exited).toBe(0)
  return stdout.trim()
}

describe('syncConfiguredGitRemotes', () => {
  test('adds a missing remote with its default fetch refspec', async () => {
    const repo = await agentRepo()

    await expect(syncConfiguredGitRemotes(repo, { origin: 'https://example.com/acme/agent.git' })).resolves.toEqual({
      warnings: [],
    })

    expect(await git(repo, ['remote', 'get-url', 'origin'])).toBe('https://example.com/acme/agent.git')
    expect(await git(repo, ['config', '--get', 'remote.origin.fetch'])).toBe('+refs/heads/*:refs/remotes/origin/*')
  })

  test('replaces a changed URL and keeps remotes the config does not name', async () => {
    const repo = await agentRepo()
    await git(repo, ['remote', 'add', 'origin', 'https://example.com/old.git'])
    await git(repo, ['remote', 'add', 'upstream', 'https://example.com/upstream.git'])

    await expect(syncConfiguredGitRemotes(repo, { origin: 'https://example.com/new.git' })).resolves.toEqual({
      warnings: [],
    })

    expect(await git(repo, ['remote', 'get-url', 'origin'])).toBe('https://example.com/new.git')
    expect(await git(repo, ['remote', 'get-url', 'upstream'])).toBe('https://example.com/upstream.git')
  })

  test('keeps an operator pushurl and warns without printing any URL', async () => {
    const repo = await agentRepo()
    await git(repo, ['remote', 'add', 'origin', 'https://example.com/old.git'])
    await git(repo, ['config', 'remote.origin.pushurl', 'https://alice:s3cr3t-token@example.com/push.git'])

    const { warnings: problems } = await syncConfiguredGitRemotes(repo, { origin: 'https://example.com/new.git' })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('remote "origin"')
    expect(problems.join('\n')).not.toContain('s3cr3t-token')
    expect(problems.join('\n')).not.toContain('example.com')
    expect(await git(repo, ['config', '--get', 'remote.origin.pushurl'])).toBe(
      'https://alice:s3cr3t-token@example.com/push.git',
    )
  })

  test('warns when a later push URL differs even though the first matches', async () => {
    const repo = await agentRepo()
    await git(repo, ['remote', 'add', 'origin', 'https://example.com/new.git'])
    await git(repo, ['config', '--add', 'remote.origin.pushurl', 'https://example.com/new.git'])
    await git(repo, ['config', '--add', 'remote.origin.pushurl', 'https://bob:t0ken@example.com/second.git'])

    const { warnings: problems } = await syncConfiguredGitRemotes(repo, { origin: 'https://example.com/new.git' })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('remote "origin"')
    expect(problems.join('\n')).not.toContain('t0ken')
  })

  test('warns about a push override that comes from an included config file', async () => {
    const repo = await agentRepo()
    const included = join(repo, '.git', 'push-override.inc')
    await writeFile(included, '[remote "origin"]\n\tpushurl = https://example.com/elsewhere.git\n')
    await git(repo, ['config', 'include.path', included])

    const { warnings: problems } = await syncConfiguredGitRemotes(repo, { origin: 'https://example.com/new.git' })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('remote "origin"')
  })

  test('reports a failed retarget so start can stop, and leaves config unchanged', async () => {
    const repo = await agentRepo()
    await git(repo, ['remote', 'add', 'origin', 'https://example.com/old.git'])
    const lock = join(repo, '.git', 'config.lock')
    await writeFile(lock, '')

    const result = await syncConfiguredGitRemotes(repo, { origin: 'https://example.com/new.git' })

    expect(result.failed).toBeDefined()
    expect(await git(repo, ['remote', 'get-url', 'origin'])).toBe('https://example.com/old.git')
  })

  test.each([
    ['branch.main.pushRemote', 'mirror'],
    ['remote.pushDefault', 'mirror'],
    ['branch.main.remote', 'mirror'],
  ])('warns when %s routes backups away from origin', async (key, value) => {
    const repo = await agentRepo()
    await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await git(repo, ['remote', 'add', 'mirror', 'https://example.com/mirror.git'])
    await git(repo, ['config', key, value])

    const { warnings } = await syncConfiguredGitRemotes(repo, { origin: 'https://example.com/new.git' })

    expect(warnings).toEqual([
      `backups on branch "main" push to remote "mirror" (set by ${key}), not to git.remotes.origin`,
    ])
  })

  test('names only the routing key when a push routing value is a URL, never the URL itself', async () => {
    const repo = await agentRepo()
    await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await git(repo, ['config', 'remote.pushDefault', 'https://alice:s3cr3t-token@example.com/elsewhere.git'])

    const { warnings } = await syncConfiguredGitRemotes(repo, { origin: 'https://example.com/new.git' })

    expect(warnings).toEqual([
      'backups on branch "main" push to a destination that is not a configured remote (set by remote.pushDefault), not to git.remotes.origin',
    ])
    expect(warnings.join('\n')).not.toContain('s3cr3t-token')
  })

  test('leaves config untouched when every remote already matches or none are configured', async () => {
    const repo = await agentRepo()
    await git(repo, ['remote', 'add', 'origin', 'https://example.com/acme/agent.git'])
    const config = join(repo, '.git', 'config')
    const before = await stat(config)

    await expect(syncConfiguredGitRemotes(repo, { origin: 'https://example.com/acme/agent.git' })).resolves.toEqual({
      warnings: [],
    })
    await expect(syncConfiguredGitRemotes(repo, undefined)).resolves.toEqual({ warnings: [] })

    expect((await stat(config)).ino).toBe(before.ino)
  })
})
