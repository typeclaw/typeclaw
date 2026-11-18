import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureGitIdentity } from '@/git/resolve-identity'

import { buildSandboxEnvPolicy, resolveAgentGitIdentityEnv } from './bash-sandbox-env'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function agentRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-bash-git-identity-'))
  roots.push(dir)
  await git(dir, ['init', '-q'])
  return dir
}

async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    env: { ...process.env, ...env, GIT_MASTER: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await proc.exited).toBe(0)
  return new Response(proc.stdout).text()
}

describe('resolveAgentGitIdentityEnv', () => {
  test('gives model bash the fallback identity start keeps out of the container env', async () => {
    // given
    const agentDir = await agentRepo()
    const identity = await ensureGitIdentity(agentDir)

    // when
    const env = await resolveAgentGitIdentityEnv(agentDir, [])

    // then
    expect(identity).not.toBeNull()
    expect(env).toEqual({
      GIT_AUTHOR_NAME: identity!.name,
      GIT_AUTHOR_EMAIL: identity!.email,
      GIT_COMMITTER_NAME: identity!.name,
      GIT_COMMITTER_EMAIL: identity!.email,
    })
  })

  test('follows an identity set in the agent repo after start', async () => {
    // given
    const agentDir = await agentRepo()
    await ensureGitIdentity(agentDir)
    await git(agentDir, ['config', '--local', 'user.name', 'Agent Smith'])
    await git(agentDir, ['config', '--local', 'user.email', 'agent@example.com'])

    // when
    const env = await resolveAgentGitIdentityEnv(agentDir, [])

    // then
    expect(env['GIT_AUTHOR_EMAIL']).toBe('agent@example.com')
    expect(env['GIT_COMMITTER_NAME']).toBe('Agent Smith')
  })

  test('pins the GitHub identity even if the adapter stops before the command is built', async () => {
    // given: the runtime env carries the identity the tracker set from the adapter
    const agentDir = await agentRepo()
    await ensureGitIdentity(agentDir)
    const names = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'] as const
    const previous = names.map((name) => [name, process.env[name]] as const)
    for (const name of names)
      process.env[name] = name.endsWith('EMAIL') ? '1+octocat@users.noreply.github.com' : 'octocat'
    try {
      const env = await resolveAgentGitIdentityEnv(agentDir, [], { login: 'octocat', id: 1 })

      // when: the adapter unregisters and the tracker clears the runtime env
      for (const name of names) delete process.env[name]
      const policy = buildSandboxEnvPolicy(env, undefined, names)

      // then
      expect(policy.set).toEqual({
        GIT_AUTHOR_NAME: 'octocat',
        GIT_AUTHOR_EMAIL: '1+octocat@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'octocat',
        GIT_COMMITTER_EMAIL: '1+octocat@users.noreply.github.com',
      })
      expect(policy.inherit).toBeUndefined()
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  test('leaves identity names the operator declared in .env', async () => {
    // given
    const agentDir = await agentRepo()
    await ensureGitIdentity(agentDir)

    // when
    const env = await resolveAgentGitIdentityEnv(agentDir, ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL'], {
      login: 'octocat',
      id: 12345,
    })

    // then
    expect(env).toEqual({
      GIT_COMMITTER_NAME: 'octocat',
      GIT_COMMITTER_EMAIL: '12345+octocat@users.noreply.github.com',
    })
  })

  test('adds nothing when the agent repo has no identity', async () => {
    const agentDir = await agentRepo()

    await expect(resolveAgentGitIdentityEnv(agentDir, [])).resolves.toEqual({})
  })

  test.each(['fallback', 'missing', 'operator-set'] as const)(
    'uses GitHub self when the repo identity is %s',
    async (kind) => {
      // given
      const agentDir = await agentRepo()
      if (kind === 'fallback') await ensureGitIdentity(agentDir)
      if (kind === 'operator-set') {
        await git(agentDir, ['config', '--local', 'user.name', 'Agent Smith'])
        await git(agentDir, ['config', '--local', 'user.email', 'agent@example.com'])
      }

      // when
      const env = await resolveAgentGitIdentityEnv(agentDir, [], { login: 'my-app[bot]', id: 12345 })

      await git(
        agentDir,
        ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'test'],
        env,
      )

      // then
      const committedIdentity = await git(agentDir, ['log', '-1', '--format=%an|%ae|%cn|%ce'])
      expect(committedIdentity.trim()).toBe(
        'my-app[bot]|12345+my-app[bot]@users.noreply.github.com|my-app[bot]|12345+my-app[bot]@users.noreply.github.com',
      )
    },
  )

  test('adds nothing when all identity names are exposed', async () => {
    const agentDir = await agentRepo()
    await ensureGitIdentity(agentDir)

    const env = await resolveAgentGitIdentityEnv(
      agentDir,
      ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'],
      { login: 'octocat', id: 12345 },
    )

    expect(env).toEqual({})
  })
})
