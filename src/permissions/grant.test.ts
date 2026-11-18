import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withConfigFileLock } from '@/config/config-file-lock'

import { BUILTIN_ROLES } from './builtins'
import { grantRole, grantRolePermission } from './grant'

function freshAgentDir(initialConfig: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'typeclaw-grant-test-'))
  writeFileSync(join(dir, 'typeclaw.json'), `${JSON.stringify(initialConfig, null, 2)}\n`)
  return dir
}

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'typeclaw.json'), 'utf8'))
}

describe('grantRole', () => {
  test('appends to roles.<name>.match, creating the block when missing', () => {
    const dir = freshAgentDir({ model: 'openai/gpt-4o-mini' })
    const result = grantRole({ cwd: dir, roleName: 'owner', matchRule: 'slack:T0123 author:U_ME' })
    expect(result).toEqual({ ok: true, added: true })

    const config = readConfig(dir)
    expect(config.roles).toEqual({
      owner: { match: ['slack:T0123 author:U_ME'] },
    })
    expect(config.model).toBe('openai/gpt-4o-mini')
  })

  test('idempotent: re-granting same rule returns added: false', () => {
    const dir = freshAgentDir({
      roles: { owner: { match: ['slack:T0123 author:U_ME'] } },
    })
    const result = grantRole({ cwd: dir, roleName: 'owner', matchRule: 'slack:T0123 author:U_ME' })
    expect(result).toEqual({ ok: true, added: false })
  })

  test('appends to existing match list without duplicating', () => {
    const dir = freshAgentDir({
      roles: { owner: { match: ['tui'] } },
    })
    const result = grantRole({ cwd: dir, roleName: 'owner', matchRule: 'slack:T0123 author:U_ME' })
    expect(result).toEqual({ ok: true, added: true })

    const config = readConfig(dir) as { roles: { owner: { match: string[] } } }
    expect(config.roles.owner.match).toEqual(['tui', 'slack:T0123 author:U_ME'])
  })

  test('creates new role block when the role is not yet declared', () => {
    const dir = freshAgentDir({})
    const result = grantRole({ cwd: dir, roleName: 'member', matchRule: 'slack:T0123 author:U_BOB' })
    expect(result).toEqual({ ok: true, added: true })

    const config = readConfig(dir) as { roles: { member: { match: string[] } } }
    expect(config.roles.member.match).toEqual(['slack:T0123 author:U_BOB'])
  })

  test('rejects malformed match rules', () => {
    const dir = freshAgentDir({})
    const result = grantRole({ cwd: dir, roleName: 'owner', matchRule: 'team:T0123' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("legacy prefix 'team'")
    }
  })

  test('rejects missing typeclaw.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typeclaw-grant-test-'))
    const result = grantRole({ cwd: dir, roleName: 'owner', matchRule: 'tui' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('not found')
    }
  })

  test('rejects invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typeclaw-grant-test-'))
    writeFileSync(join(dir, 'typeclaw.json'), '{ not valid json')
    const result = grantRole({ cwd: dir, roleName: 'owner', matchRule: 'tui' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('not valid JSON')
    }
  })

  test('preserves unrelated fields and existing roles', () => {
    const dir = freshAgentDir({
      model: 'openai/gpt-4o-mini',
      channels: { 'slack-bot': {} },
      roles: {
        owner: { match: ['tui'] },
        member: { match: ['slack:T0123'] },
      },
    })
    grantRole({ cwd: dir, roleName: 'owner', matchRule: 'slack:T0123 author:U_ME' })

    const config = readConfig(dir) as {
      model: string
      channels: Record<string, unknown>
      roles: Record<string, { match: string[] } | undefined>
    }
    expect(config.model).toBe('openai/gpt-4o-mini')
    expect(config.channels).toEqual({ 'slack-bot': {} })
    expect(config.roles.owner?.match).toEqual(['tui', 'slack:T0123 author:U_ME'])
    expect(config.roles.member?.match).toEqual(['slack:T0123'])
  })
})

describe('grant under a held config lock', () => {
  test('returns a failure result instead of throwing, and leaves typeclaw.json unchanged', async () => {
    // given: another writer in this process holds the typeclaw.json lock
    const dir = freshAgentDir({ roles: {} })
    let release: () => void = () => {}
    const holder = withConfigFileLock(
      join(dir, 'typeclaw.json'),
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    try {
      // when: both grant kinds run while it is held
      const match = grantRole({ cwd: dir, roleName: 'owner', matchRule: 'slack:T0123 author:U_ME' })
      const permission = grantRolePermission({ cwd: dir, roleName: 'member', permission: 'tool.bash' })

      // then: each reports the busy lock as an ordinary grant failure
      for (const result of [match, permission]) {
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.reason).toContain('typeclaw.json.lock')
      }
      expect(readConfig(dir)).toEqual({ roles: {} })
    } finally {
      release()
      await holder
    }
  })
})

describe('grantRolePermission', () => {
  test('granting a permission to a built-in role with NO explicit permissions materializes defaults + new perm (does NOT narrow)', () => {
    // given: guest has no explicit permissions[] in the file (uses defaults)
    const dir = freshAgentDir({ roles: { guest: { match: ['discord:*'] } } })

    // when: an operator grants guest channel.respond
    const result = grantRolePermission({ cwd: dir, roleName: 'guest', permission: 'channel.respond' })
    expect(result).toEqual({ ok: true, added: true })

    // then: the written set is guest's built-in defaults (empty) + the new perm,
    // NOT a narrowing to some other shape; match is preserved
    const config = readConfig(dir) as { roles: { guest: { match: string[]; permissions: string[] } } }
    expect(config.roles.guest.permissions).toEqual([...BUILTIN_ROLES.guest.permissions, 'channel.respond'])
    expect(config.roles.guest.match).toEqual(['discord:*'])
  })

  test('granting to a built-in role preserves its FULL default capability set (member is not narrowed to one perm)', () => {
    const dir = freshAgentDir({ roles: { member: { match: ['slack:T0123'] } } })

    grantRolePermission({ cwd: dir, roleName: 'member', permission: 'cron.schedule' })

    const config = readConfig(dir) as { roles: { member: { permissions: string[] } } }
    // every built-in member default must survive the grant
    for (const p of BUILTIN_ROLES.member.permissions) {
      expect(config.roles.member.permissions).toContain(p)
    }
    expect(config.roles.member.permissions).toContain('cron.schedule')
  })

  test('appends to an explicit permissions[] without clobbering it', () => {
    const dir = freshAgentDir({
      roles: { guest: { match: ['discord:*'], permissions: ['channel.respond'] } },
    })
    grantRolePermission({ cwd: dir, roleName: 'guest', permission: 'fs.see.private' })

    const config = readConfig(dir) as { roles: { guest: { permissions: string[] } } }
    expect(config.roles.guest.permissions).toEqual(['channel.respond', 'fs.see.private'])
  })

  test('idempotent: granting a permission the role already effectively holds is a no-op', () => {
    // member's defaults already include channel.respond
    const dir = freshAgentDir({ roles: { member: { match: ['slack:T0123'] } } })
    const result = grantRolePermission({ cwd: dir, roleName: 'member', permission: 'channel.respond' })
    expect(result).toEqual({ ok: true, added: false })

    const config = readConfig(dir) as { roles: { member: { permissions?: string[] } } }
    // no narrowing write happened; the file role still has no explicit permissions[]
    expect(config.roles.member.permissions).toBeUndefined()
  })
})

async function runGit(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
  return (await new Response(proc.stdout).text()).trim()
}

async function gitInit(cwd: string): Promise<void> {
  for (const cmd of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Test User'],
    ['config', 'user.email', 'test@example.com'],
  ]) {
    const proc = Bun.spawn({ cmd: ['git', ...cmd], cwd, stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
  }
}

async function seedGitRepo(dir: string, config: unknown): Promise<void> {
  await gitInit(dir)
  await writeFile(join(dir, 'typeclaw.json'), `${JSON.stringify(config, null, 2)}\n`)
  await runGit(dir, ['add', 'typeclaw.json'])
  await runGit(dir, ['commit', '-m', 'initial'])
}

describe('grantRole git commit', () => {
  test('commits typeclaw.json after a successful grant', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-grant-commit-'))
    try {
      // given: a git repo with an owner role and no match rules
      await seedGitRepo(dir, { roles: { owner: { match: [] } } })

      // when: a claim grants a match rule
      const result = grantRole({ cwd: dir, roleName: 'owner', matchRule: 'slack:* author:U123' })

      // then: the grant succeeded and HEAD is a scoped typeclaw.json commit
      expect(result).toEqual({ ok: true, added: true })
      expect(await runGit(dir, ['log', '-1', '--format=%s'])).toBe('typeclaw.json: grant owner role')
      expect(await runGit(dir, ['show', '--name-only', '--format=', 'HEAD'])).toBe('typeclaw.json')
      const committed = JSON.parse(await runGit(dir, ['show', 'HEAD:typeclaw.json']))
      expect(committed.roles.owner.match).toEqual(['slack:* author:U123'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('uses the role name in the commit subject', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-grant-commit-role-'))
    try {
      await seedGitRepo(dir, { roles: { trusted: { match: [] } } })

      grantRole({ cwd: dir, roleName: 'trusted', matchRule: 'discord:* author:42' })

      expect(await runGit(dir, ['log', '-1', '--format=%s'])).toBe('typeclaw.json: grant trusted role')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('does not commit when the rule already exists (idempotent no-op)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-grant-commit-dedup-'))
    try {
      // given: the match rule is already on file
      await seedGitRepo(dir, { roles: { owner: { match: ['slack:* author:U123'] } } })
      const head = await runGit(dir, ['rev-parse', 'HEAD'])

      // when: the same rule is granted again
      const result = grantRole({ cwd: dir, roleName: 'owner', matchRule: 'slack:* author:U123' })

      // then: no write, no new commit
      expect(result).toEqual({ ok: true, added: false })
      expect(await runGit(dir, ['rev-parse', 'HEAD'])).toBe(head)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('commits only typeclaw.json, leaving other dirty files untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-grant-commit-scope-'))
    try {
      // given: an unrelated tracked file the user is mid-editing
      await gitInit(dir)
      await writeFile(join(dir, 'typeclaw.json'), `${JSON.stringify({ roles: { owner: { match: [] } } }, null, 2)}\n`)
      await writeFile(join(dir, 'AGENTS.md'), 'original\n')
      await runGit(dir, ['add', '.'])
      await runGit(dir, ['commit', '-m', 'initial'])
      await writeFile(join(dir, 'AGENTS.md'), 'user wip\n')

      // when: a grant commits
      grantRole({ cwd: dir, roleName: 'owner', matchRule: 'slack:* author:U123' })

      // then: the commit holds only typeclaw.json; AGENTS.md stays dirty
      expect(await runGit(dir, ['show', '--name-only', '--format=', 'HEAD'])).toBe('typeclaw.json')
      expect(await runGit(dir, ['show', 'HEAD:AGENTS.md'])).toBe('original')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
