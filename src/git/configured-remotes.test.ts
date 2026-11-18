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

    await expect(syncConfiguredGitRemotes(repo, { origin: 'https://example.com/acme/agent.git' })).resolves.toEqual([])

    expect(await git(repo, ['remote', 'get-url', 'origin'])).toBe('https://example.com/acme/agent.git')
    expect(await git(repo, ['config', '--get', 'remote.origin.fetch'])).toBe('+refs/heads/*:refs/remotes/origin/*')
  })

  test('replaces a changed URL and keeps remotes the config does not name', async () => {
    const repo = await agentRepo()
    await git(repo, ['remote', 'add', 'origin', 'https://example.com/old.git'])
    await git(repo, ['remote', 'add', 'upstream', 'https://example.com/upstream.git'])

    await expect(syncConfiguredGitRemotes(repo, { origin: 'https://example.com/new.git' })).resolves.toEqual([])

    expect(await git(repo, ['remote', 'get-url', 'origin'])).toBe('https://example.com/new.git')
    expect(await git(repo, ['remote', 'get-url', 'upstream'])).toBe('https://example.com/upstream.git')
  })

  test('keeps an operator pushurl and warns without printing any URL', async () => {
    const repo = await agentRepo()
    await git(repo, ['remote', 'add', 'origin', 'https://example.com/old.git'])
    await git(repo, ['config', 'remote.origin.pushurl', 'https://alice:s3cr3t-token@example.com/push.git'])

    const problems = await syncConfiguredGitRemotes(repo, { origin: 'https://example.com/new.git' })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('remote "origin"')
    expect(problems.join('\n')).not.toContain('s3cr3t-token')
    expect(problems.join('\n')).not.toContain('example.com')
    expect(await git(repo, ['config', '--get', 'remote.origin.pushurl'])).toBe(
      'https://alice:s3cr3t-token@example.com/push.git',
    )
  })

  test('warns about a push override that comes from an included config file', async () => {
    const repo = await agentRepo()
    const included = join(repo, '.git', 'push-override.inc')
    await writeFile(included, '[remote "origin"]\n\tpushurl = https://example.com/elsewhere.git\n')
    await git(repo, ['config', 'include.path', included])

    const problems = await syncConfiguredGitRemotes(repo, { origin: 'https://example.com/new.git' })

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('remote "origin"')
  })

  test('leaves config untouched when every remote already matches or none are configured', async () => {
    const repo = await agentRepo()
    await git(repo, ['remote', 'add', 'origin', 'https://example.com/acme/agent.git'])
    const config = join(repo, '.git', 'config')
    const before = await stat(config)

    await expect(syncConfiguredGitRemotes(repo, { origin: 'https://example.com/acme/agent.git' })).resolves.toEqual([])
    await expect(syncConfiguredGitRemotes(repo, undefined)).resolves.toEqual([])

    expect((await stat(config)).ino).toBe(before.ino)
  })
})
