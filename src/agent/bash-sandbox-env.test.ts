import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureGitIdentity } from '@/git/resolve-identity'

import { resolveAgentGitIdentityEnv } from './bash-sandbox-env'

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

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(await proc.exited).toBe(0)
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

  test('leaves identity names the runtime env already exposes to bash', async () => {
    // given
    const agentDir = await agentRepo()
    await ensureGitIdentity(agentDir)

    // when
    const env = await resolveAgentGitIdentityEnv(agentDir, ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL'])

    // then
    expect(Object.keys(env).sort()).toEqual(['GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_NAME'])
  })

  test('adds nothing when the agent repo has no identity', async () => {
    const agentDir = await agentRepo()

    await expect(resolveAgentGitIdentityEnv(agentDir, [])).resolves.toEqual({})
  })
})
