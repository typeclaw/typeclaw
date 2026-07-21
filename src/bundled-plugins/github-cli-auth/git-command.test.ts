import { describe, expect, test } from 'bun:test'

import { parseGithubRepoFromGitUrl, resolveGhDefaultRepoFromCwd, type GitResolvers } from './git-command'

describe('parseGithubRepoFromGitUrl', () => {
  test.each([
    ['https://github.com/acme/widgets', 'acme/widgets'],
    ['https://github.com/acme/widgets.git', 'acme/widgets'],
    ['git@github.com:acme/widgets.git', 'acme/widgets'],
    ['ssh://git@github.com/acme/widgets.git', 'acme/widgets'],
  ])('parses %s', (url, expected) => {
    expect(parseGithubRepoFromGitUrl(url)).toBe(expected)
  })

  test.each([
    'ssh://git@github.com:22/acme/widgets.git',
    'git@github.com:acme/widgets.git#main',
    'git@github.com:acme/widgets?x=1',
    'https://gitlab.com/acme/widgets',
    'https://token@github.com/acme/widgets',
    '/srv/repos/widgets.git',
    '../widgets',
    'https://github.com/acme',
  ])('rejects %s', (url) => {
    expect(parseGithubRepoFromGitUrl(url)).toBeNull()
  })
})

describe('resolveGhDefaultRepoFromCwd', () => {
  test('resolves the origin fetch URL for gh fallback', async () => {
    const calls: Array<{ cwd: string; remote: string; forPush: boolean }> = []
    const resolvers: GitResolvers = {
      resolveRemoteUrl: async (cwd, remote, forPush) => {
        calls.push({ cwd, remote, forPush })
        return 'https://github.com/acme/widgets.git'
      },
    }

    await expect(resolveGhDefaultRepoFromCwd('/agent', resolvers)).resolves.toBe('acme/widgets')
    expect(calls).toEqual([{ cwd: '/agent', remote: 'origin', forPush: false }])
  })

  test('returns null for missing and non-GitHub origins', async () => {
    const missing: GitResolvers = { resolveRemoteUrl: async () => null }
    const otherHost: GitResolvers = { resolveRemoteUrl: async () => 'https://gitlab.com/acme/widgets.git' }

    await expect(resolveGhDefaultRepoFromCwd('/agent', missing)).resolves.toBeNull()
    await expect(resolveGhDefaultRepoFromCwd('/agent', otherHost)).resolves.toBeNull()
  })
})
