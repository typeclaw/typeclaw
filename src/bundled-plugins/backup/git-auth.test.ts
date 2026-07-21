import { describe, expect, test } from 'bun:test'

import { type BackupPushAuthDeps, resolveBackupPushAuthEnv } from './git-auth'

const baseDeps = (overrides: Partial<BackupPushAuthDeps> = {}): BackupPushAuthDeps => ({
  hasAppTokenResolver: () => true,
  ghToken: undefined,
  resolveTokenForRepo: async () => ({ kind: 'token', token: 'ghs_minted' }),
  resolveOriginPushUrl: async () => 'https://github.com/acme/widgets.git',
  ensureAskPassHelper: async () => '/tmp/typeclaw-git-askpass',
  ...overrides,
})

describe('resolveBackupPushAuthEnv', () => {
  test('App auth + github.com origin: returns askpass env minted for the origin slug', async () => {
    const env = await resolveBackupPushAuthEnv('/agent', baseDeps())
    expect(env).not.toBeNull()
    expect(env).toMatchObject({
      GIT_ASKPASS: '/tmp/typeclaw-git-askpass',
      TYPECLAW_GIT_TOKEN: 'ghs_minted',
      GIT_TERMINAL_PROMPT: '0',
    })
  })

  test('live App resolver takes precedence over an ambient classic PAT', async () => {
    const env = await resolveBackupPushAuthEnv('/agent', {
      ...baseDeps(),
      ghToken: 'ghp_operator',
    })

    expect(env).toMatchObject({
      GIT_ASKPASS: '/tmp/typeclaw-git-askpass',
      TYPECLAW_GIT_TOKEN: 'ghs_minted',
      GIT_TERMINAL_PROMPT: '0',
    })
  })

  test('mints for the slug parsed from the origin push url', async () => {
    let requestedSlug: string | undefined
    const env = await resolveBackupPushAuthEnv('/agent', {
      ...baseDeps(),
      resolveTokenForRepo: async (slug) => {
        requestedSlug = slug
        return { kind: 'token', token: 'ghs_x' }
      },
    })
    expect(requestedSlug).toBe('acme/widgets')
    expect(env).not.toBeNull()
  })

  test('classic PAT (ghp_): no minting, returns null so inherited env is used', async () => {
    const env = await resolveBackupPushAuthEnv('/agent', {
      ...baseDeps(),
      hasAppTokenResolver: () => false,
      ghToken: 'ghp_classic',
    })
    expect(env).toBeNull()
  })

  test('fine-grained PAT (github_pat_): no minting, returns null', async () => {
    const env = await resolveBackupPushAuthEnv('/agent', {
      ...baseDeps(),
      hasAppTokenResolver: () => false,
      ghToken: 'github_pat_xyz',
    })
    expect(env).toBeNull()
  })

  test('no App auth and no token: returns null', async () => {
    const env = await resolveBackupPushAuthEnv('/agent', {
      ...baseDeps(),
      hasAppTokenResolver: () => false,
      ghToken: undefined,
    })
    expect(env).toBeNull()
  })

  test('non-github origin: returns null so non-github remotes use container creds', async () => {
    const env = await resolveBackupPushAuthEnv('/agent', {
      ...baseDeps(),
      resolveOriginPushUrl: async () => 'https://gitlab.com/acme/widgets.git',
    })
    expect(env).toBeNull()
  })

  test('no origin url resolvable: returns null', async () => {
    const env = await resolveBackupPushAuthEnv('/agent', {
      ...baseDeps(),
      resolveOriginPushUrl: async () => null,
    })
    expect(env).toBeNull()
  })

  test('token resolution unavailable: returns null rather than a broken env', async () => {
    const env = await resolveBackupPushAuthEnv('/agent', {
      ...baseDeps(),
      resolveTokenForRepo: async () => ({ kind: 'unavailable', reason: 'no installation' }),
    })
    expect(env).toBeNull()
  })

  test('ssh github origin is recognized and minted (askpass applies after insteadOf rewrite)', async () => {
    const env = await resolveBackupPushAuthEnv('/agent', {
      ...baseDeps(),
      resolveOriginPushUrl: async () => 'git@github.com:acme/widgets.git',
    })
    expect(env).not.toBeNull()
    expect(env?.GIT_CONFIG_COUNT).toBe('2')
  })
})
