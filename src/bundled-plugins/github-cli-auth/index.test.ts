import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TYPECLAW_INTERNAL_BASH_ENV } from '@/agent/plugin-tools'
import type { GithubTokenResolveResult } from '@/channels/github-token-bridge'
import { noopPermissionService, type PermissionService } from '@/permissions'
import type { PluginContext, PluginLogger, ToolBeforeEvent } from '@/plugin'

import { resetGitAskPassHelperForTests } from './git-askpass'
import githubCliAuthPlugin from './index'

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} }

// resolveHiddenPaths checks fs.see.private + fs.see.secrets; granting both
// yields empty masks => runsUnsandboxed() true, matching owner/trusted. The
// default noopPermissionService grants nothing => sandboxed (member/guest).
const unsandboxedPermissions: PermissionService = {
  ...noopPermissionService,
  has: (_origin, permission) => permission === 'fs.see.private' || permission === 'fs.see.secrets',
}

const originalToken = process.env.GH_TOKEN
const originalGithubToken = process.env.GITHUB_TOKEN

afterEach(() => {
  if (originalToken === undefined) delete process.env.GH_TOKEN
  else process.env.GH_TOKEN = originalToken
  if (originalGithubToken === undefined) delete process.env.GITHUB_TOKEN
  else process.env.GITHUB_TOKEN = originalGithubToken
})

type HookOpts = { permissions?: PermissionService; logger?: PluginLogger }

function pluginContext(
  resolve: (repoSlug: string) => Promise<GithubTokenResolveResult>,
  hasAppTokenResolver = true,
  opts: HookOpts = {},
): PluginContext<undefined> {
  return {
    name: 'github-cli-auth',
    version: undefined,
    agentDir: '/agent',
    config: undefined,
    logger: opts.logger ?? noopLogger,
    permissions: opts.permissions ?? noopPermissionService,
    github: { resolveTokenForRepo: resolve, hasAppTokenResolver: () => hasAppTokenResolver },
    spawnSubagent: async () => {},
  }
}

async function hookFor(
  resolve: (repoSlug: string) => Promise<GithubTokenResolveResult>,
  hasAppTokenResolver = true,
  opts: HookOpts = {},
) {
  const exports = await githubCliAuthPlugin.plugin(pluginContext(resolve, hasAppTokenResolver, opts))
  const hook = exports.hooks?.['tool.before']
  if (!hook) throw new Error('plugin did not register tool.before')
  return hook
}

function bashEvent(command: string): ToolBeforeEvent {
  return { tool: 'bash', sessionId: 's', callId: 'c', args: { command } }
}

const tokenResolver = (token: string) => async (): Promise<GithubTokenResolveResult> => ({ kind: 'token', token })
const unavailableResolver = async (): Promise<GithubTokenResolveResult> => ({
  kind: 'unavailable',
  reason: 'adapter down',
})

const hookCtx = { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger }

describe('github-cli-auth plugin', () => {
  test('App auth: sets the env overlay with the minted token, leaving the command untouched', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('gh pr view -R acme/widgets')

    const result = await hook(event, { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger })

    expect(result).toBeUndefined()
    // The token must NOT be in the command string (no leak surface).
    expect(event.args.command).toBe('gh pr view -R acme/widgets')
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toEqual({ GH_TOKEN: 'ghs_minted' })
  })

  test('App auth: blocks a repo-targeting gh call with no repo', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))

    const result = await hook(bashEvent('gh pr view 12'), {
      agentDir: '/agent',
      pluginName: 'github-cli-auth',
      logger: noopLogger,
    })

    expect(result).toMatchObject({ block: true })
  })

  test('App auth: blocks when the bridge is unavailable', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(unavailableResolver)

    const result = await hook(bashEvent('gh pr view -R acme/widgets'), {
      agentDir: '/agent',
      pluginName: 'github-cli-auth',
      logger: noopLogger,
    })

    expect(result).toEqual({ block: true, reason: 'adapter down' })
  })

  test('multi-owner App auth (GH_TOKEN unseeded, minter live): still injects the minted token', async () => {
    // given: a multi-owner / no-repos App config never seeds GH_TOKEN, but the
    // per-repo minter is registered. App auth must be detected via the minter.
    delete process.env.GH_TOKEN
    const hook = await hookFor(tokenResolver('ghs_minted'), true)
    const event = bashEvent('gh pr view -R acme/widgets')

    const result = await hook(event, { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger })

    expect(result).toBeUndefined()
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toEqual({ GH_TOKEN: 'ghs_minted' })
  })

  test('no managed auth (GH_TOKEN unseeded, no minter): repo-targeting gh passes through and warns once', async () => {
    delete process.env.GH_TOKEN
    let resolverCalled = false
    const warnings: string[] = []
    const logger = {
      info: () => {},
      warn: (m: string): void => {
        warnings.push(m)
      },
      error: () => {},
    }
    const hook = await hookFor(
      async () => {
        resolverCalled = true
        return { kind: 'token', token: 'ghs_minted' }
      },
      false,
      { logger },
    )

    const first = await hook(bashEvent('gh pr view -R acme/widgets'), hookCtx)
    const second = await hook(bashEvent('gh pr view -R acme/other'), hookCtx)

    // The command must still run (we cannot see the user's own ambient auth), but
    // the formerly-silent pass-through now emits one diagnostic warning.
    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    expect(resolverCalled).toBe(false)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('TypeClaw-managed GitHub credentials')
  })

  test('no managed auth: a repo-less gh command passes through silently (no warning)', async () => {
    delete process.env.GH_TOKEN
    const warnings: string[] = []
    const logger = {
      info: () => {},
      warn: (m: string): void => {
        warnings.push(m)
      },
      error: () => {},
    }
    const hook = await hookFor(tokenResolver('ghs_minted'), false, { logger })
    const event = bashEvent('gh auth status')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
    expect(warnings.length).toBe(0)
  })

  test('classic PAT (unsandboxed): injects the PAT for a repo-targeting gh, does not mint', async () => {
    process.env.GH_TOKEN = 'ghp_classic'
    let resolverCalled = false
    const hook = await hookFor(
      async () => {
        resolverCalled = true
        return { kind: 'token', token: 'ghs_minted' }
      },
      true,
      { permissions: unsandboxedPermissions },
    )
    const event = bashEvent('gh pr view -R acme/widgets')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('gh pr view -R acme/widgets')
    // Unsandboxed: the PAT already rides inherited env; we re-assert it in the
    // overlay (no minting) so behavior is explicit and matches the git path.
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toEqual({ GH_TOKEN: 'ghp_classic' })
    expect(resolverCalled).toBe(false)
  })

  test('classic PAT (unsandboxed): non-repo-targeting gh passes through (nothing to inject)', async () => {
    process.env.GH_TOKEN = 'ghp_classic'
    const hook = await hookFor(tokenResolver('ghs_minted'), true, { permissions: unsandboxedPermissions })
    const event = bashEvent('gh pr view 12')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('gh pr view 12')
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
  })

  test('fine-grained PAT (unsandboxed): leaves command as-is, injects the PAT, does not mint', async () => {
    process.env.GH_TOKEN = 'github_pat_xyz'
    let resolverCalled = false
    const hook = await hookFor(
      async () => {
        resolverCalled = true
        return { kind: 'token', token: 'ghs_minted' }
      },
      true,
      { permissions: unsandboxedPermissions },
    )
    const event = bashEvent('gh pr view -R acme/widgets')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('gh pr view -R acme/widgets')
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toEqual({ GH_TOKEN: 'github_pat_xyz' })
    expect(resolverCalled).toBe(false)
  })

  test('App auth: strips a redundant -R on a literal-path gh api call AND injects the minted token', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('gh api repos/acme/widgets/issues -R acme/widgets')

    const result = await hook(event, { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger })

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('gh api repos/acme/widgets/issues')
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toEqual({ GH_TOKEN: 'ghs_minted' })
  })

  test('classic PAT (unsandboxed): strips a redundant -R on gh api, injects the PAT, no mint', async () => {
    process.env.GH_TOKEN = 'ghp_classic'
    let resolverCalled = false
    const hook = await hookFor(
      async () => {
        resolverCalled = true
        return { kind: 'token', token: 'ghs_minted' }
      },
      true,
      { permissions: unsandboxedPermissions },
    )
    const event = bashEvent('gh api repos/acme/widgets/issues -R acme/widgets')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('gh api repos/acme/widgets/issues')
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toEqual({ GH_TOKEN: 'ghp_classic' })
    expect(resolverCalled).toBe(false)
  })

  test('fine-grained PAT (unsandboxed): strips a redundant -R on gh api, injects the PAT, no mint', async () => {
    process.env.GH_TOKEN = 'github_pat_xyz'
    let resolverCalled = false
    const hook = await hookFor(
      async () => {
        resolverCalled = true
        return { kind: 'token', token: 'ghs_minted' }
      },
      true,
      { permissions: unsandboxedPermissions },
    )
    const event = bashEvent('gh api repos/acme/widgets/issues --repo=acme/widgets')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('gh api repos/acme/widgets/issues')
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toEqual({ GH_TOKEN: 'github_pat_xyz' })
    expect(resolverCalled).toBe(false)
  })

  test('App auth: blocks a gh api whose -R repo conflicts with the literal path (no strip)', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('gh api repos/victim/private/issues -R acme/widgets')

    const result = await hook(event, { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger })

    expect(result).toMatchObject({ block: true })
    expect(event.args.command).toBe('gh api repos/victim/private/issues -R acme/widgets')
  })

  test('App auth: blocks gh api /user with a guiding reason and does not call the resolver', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    let resolverCalled = false
    const hook = await hookFor(async () => {
      resolverCalled = true
      return { kind: 'token', token: 'ghs_minted' }
    })

    const result = await hook(bashEvent("gh api /user --jq '.login'"), hookCtx)

    expect(result).toMatchObject({ block: true })
    expect((result as { reason: string }).reason).toContain('/user')
    expect(resolverCalled).toBe(false)
  })

  test('multi-owner App (no seeded token): blocks gh api /user', async () => {
    delete process.env.GH_TOKEN
    const hook = await hookFor(tokenResolver('ghs_minted'))

    const result = await hook(bashEvent('gh api /user'), hookCtx)

    expect(result).toMatchObject({ block: true })
  })

  test('classic PAT: gh api /user passes through (user identity works)', async () => {
    process.env.GH_TOKEN = 'ghp_classic'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('gh api /user')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('gh api /user')
  })

  test('fine-grained PAT: gh api /user passes through (user identity works)', async () => {
    process.env.GH_TOKEN = 'github_pat_xyz'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('gh api /user')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('gh api /user')
  })

  test('App auth: gh api /users/octocat (third-party) is not blocked', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('gh api /users/octocat')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('gh api /users/octocat')
  })

  test('App process token + command-local classic PAT: gh api /user is NOT blocked', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('GH_TOKEN=ghp_classic gh api /user')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('GH_TOKEN=ghp_classic gh api /user')
  })

  test('App process token + command-local fine-grained PAT: gh api /user is NOT blocked', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('GH_TOKEN=github_pat_xyz gh api /user')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
  })

  test('App process token + quoted command-local PAT: gh api /user is NOT blocked', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))

    const result = await hook(bashEvent("GH_TOKEN='ghp_classic' gh api /user"), hookCtx)

    expect(result).toBeUndefined()
  })

  test('command-local App token: gh api /user IS blocked', async () => {
    process.env.GH_TOKEN = 'ghp_classic'
    const hook = await hookFor(tokenResolver('ghs_minted'))

    const result = await hook(bashEvent('GH_TOKEN=ghs_child gh api /user'), hookCtx)

    expect(result).toMatchObject({ block: true })
  })

  test('command-local GITHUB_TOKEN PAT (no GH_TOKEN): gh api /user is NOT blocked', async () => {
    delete process.env.GH_TOKEN
    const hook = await hookFor(tokenResolver('ghs_minted'))

    const result = await hook(bashEvent('GITHUB_TOKEN=ghp_classic gh api /user'), hookCtx)

    expect(result).toBeUndefined()
  })

  test('process GH_TOKEN (App) beats command-local GITHUB_TOKEN PAT: gh api /user IS blocked', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))

    const result = await hook(bashEvent('GITHUB_TOKEN=ghp_classic gh api /user'), hookCtx)

    expect(result).toMatchObject({ block: true })
  })

  test('process GITHUB_TOKEN PAT (no GH_TOKEN): gh api /user is NOT blocked', async () => {
    delete process.env.GH_TOKEN
    process.env.GITHUB_TOKEN = 'ghp_classic'
    const hook = await hookFor(tokenResolver('ghs_minted'))

    const result = await hook(bashEvent('gh api /user'), hookCtx)

    expect(result).toBeUndefined()
  })

  test('non-gh bash command passes through without touching the resolver', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    let resolverCalled = false
    const hook = await hookFor(async () => {
      resolverCalled = true
      return { kind: 'token', token: 'ghs_minted' }
    })
    const event = bashEvent('ls -la')

    const result = await hook(event, { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger })

    expect(result).toBeUndefined()
    expect(event.args.command).toBe('ls -la')
    expect(resolverCalled).toBe(false)
  })

  test('non-bash tool is ignored', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))

    const result = await hook(
      { tool: 'read', sessionId: 's', callId: 'c', args: { path: 'gh.txt' } },
      { agentDir: '/agent', pluginName: 'github-cli-auth', logger: noopLogger },
    )

    expect(result).toBeUndefined()
  })
})

describe('github-cli-auth plugin — .env PAT role gating (gh path)', () => {
  test('PAT (sandboxed) + App minter: mints a per-repo App token instead of the withheld PAT', async () => {
    process.env.GH_TOKEN = 'ghp_classic'
    const mintedSlugs: string[] = []
    const hook = await hookFor(async (slug) => {
      mintedSlugs.push(slug)
      return { kind: 'token', token: 'ghs_minted' }
    }, true)
    const event = bashEvent('gh pr view -R acme/widgets')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toEqual({ GH_TOKEN: 'ghs_minted' })
    expect(mintedSlugs).toEqual(['acme/widgets'])
  })

  test('PAT (sandboxed) + no App minter: blocks with the withheld-PAT guidance and warns once', async () => {
    process.env.GH_TOKEN = 'github_pat_xyz'
    const warnings: string[] = []
    const logger = {
      info: () => {},
      warn: (m: string): void => {
        warnings.push(m)
      },
      error: () => {},
    }
    const hook = await hookFor(tokenResolver('ghs_minted'), false, { logger })

    const first = await hook(bashEvent('gh pr view -R acme/widgets'), hookCtx)
    const second = await hook(bashEvent('gh pr view -R acme/other'), hookCtx)

    expect(first).toMatchObject({ block: true })
    expect((first as { reason: string }).reason).toContain('sandboxed')
    expect(second).toMatchObject({ block: true })
    // warn is deduped to once per process to avoid log spam on every command.
    expect(warnings.length).toBe(1)
  })

  test('PAT (sandboxed) + no minter: a malformed (block-class) gh command keeps its own block reason', async () => {
    process.env.GH_TOKEN = 'ghp_classic'
    const hook = await hookFor(tokenResolver('ghs_minted'), false)

    // -R conflicts with the literal path => analyzer block; that reason wins over
    // the withheld-PAT message because the command is unsafe regardless of auth.
    const result = await hook(bashEvent('gh api repos/victim/private/issues -R acme/widgets'), hookCtx)

    expect(result).toMatchObject({ block: true })
    expect((result as { reason: string }).reason).not.toContain('sandboxed')
  })
})

describe('github-cli-auth plugin — git path', () => {
  const askpassDir = mkdtempSync(join(tmpdir(), 'typeclaw-askpass-it-'))
  process.env.TYPECLAW_GIT_ASKPASS_PATH = join(askpassDir, 'typeclaw-git-askpass')
  afterEach(() => {
    resetGitAskPassHelperForTests()
  })

  test('App auth: injects GIT_ASKPASS + token env for an explicit-URL git clone', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('git clone https://github.com/acme/widgets.git')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    const overlay = event.args[TYPECLAW_INTERNAL_BASH_ENV] as Record<string, string>
    expect(overlay.TYPECLAW_GIT_TOKEN).toBe('ghs_minted')
    expect(overlay.GIT_ASKPASS).toBeDefined()
    expect(overlay.GIT_TERMINAL_PROMPT).toBe('0')
    // The token must never reach the command string.
    expect(event.args.command).toBe('git clone https://github.com/acme/widgets.git')
    expect(JSON.stringify(event.args.command)).not.toContain('ghs_minted')
  })

  test('resolver receives the parsed owner/name slug', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const seen: string[] = []
    const hook = await hookFor(async (slug) => {
      seen.push(slug)
      return { kind: 'token', token: 'ghs_minted' }
    })

    await hook(bashEvent('git clone https://github.com/acme/widgets.git'), hookCtx)

    expect(seen).toEqual(['acme/widgets'])
  })

  test('multi-owner App auth (GH_TOKEN unseeded, minter live): injects GIT_ASKPASS for git push', async () => {
    // given: the reported #733 failure — a push under a multi-owner App where
    // GH_TOKEN is never seeded, so the old `classifyGhToken(GH_TOKEN) === app`
    // gate dropped the credential and git died with "could not read Username".
    delete process.env.GH_TOKEN
    const hook = await hookFor(tokenResolver('ghs_minted'), true)
    const event = bashEvent('git push https://github.com/acme/widgets.git main')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    const overlay = event.args[TYPECLAW_INTERNAL_BASH_ENV] as Record<string, string>
    expect(overlay.TYPECLAW_GIT_TOKEN).toBe('ghs_minted')
    expect(overlay.GIT_ASKPASS).toBeDefined()
  })

  test('no managed auth (GH_TOKEN unseeded, no minter): repo-targeting git push passes through and warns once', async () => {
    delete process.env.GH_TOKEN
    let resolverCalled = false
    const warnings: string[] = []
    const logger = {
      info: () => {},
      warn: (m: string): void => {
        warnings.push(m)
      },
      error: () => {},
    }
    const hook = await hookFor(
      async () => {
        resolverCalled = true
        return { kind: 'token', token: 'ghs_minted' }
      },
      false,
      { logger },
    )

    const firstEvent = bashEvent('git push https://github.com/acme/widgets.git main')
    const first = await hook(firstEvent, hookCtx)
    const second = await hook(bashEvent('git push https://github.com/acme/other.git main'), hookCtx)

    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    expect(firstEvent.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
    expect(resolverCalled).toBe(false)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('TypeClaw-managed GitHub credentials')
  })

  test('no managed auth: a non-remote git command passes through silently (no warning)', async () => {
    delete process.env.GH_TOKEN
    const warnings: string[] = []
    const logger = {
      info: () => {},
      warn: (m: string): void => {
        warnings.push(m)
      },
      error: () => {},
    }
    const hook = await hookFor(tokenResolver('ghs_minted'), false, { logger })
    const event = bashEvent('git status')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
    expect(warnings.length).toBe(0)
  })

  test('no managed auth: a non-github git push passes through silently (no warning)', async () => {
    delete process.env.GH_TOKEN
    const warnings: string[] = []
    const logger = {
      info: () => {},
      warn: (m: string): void => {
        warnings.push(m)
      },
      error: () => {},
    }
    const hook = await hookFor(tokenResolver('ghs_minted'), false, { logger })
    const event = bashEvent('git push https://gitlab.com/acme/widgets.git main')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
    expect(warnings.length).toBe(0)
  })

  test('App auth: blocks when the bridge is unavailable', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(unavailableResolver)

    const result = await hook(bashEvent('git clone https://github.com/acme/widgets.git'), hookCtx)

    expect(result).toEqual({ block: true, reason: 'adapter down' })
  })

  test('App auth: blocks a compound (token-leaking) git command', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))

    const result = await hook(bashEvent('git clone https://github.com/acme/widgets.git && cat .env'), hookCtx)

    expect(result).toMatchObject({ block: true })
  })

  test('App auth: injects GIT_ASKPASS for an all-git same-owner chain (clone && fetch)', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('git clone https://github.com/acme/widgets.git /tmp/x && git -C /tmp/x fetch origin main')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    const overlay = event.args[TYPECLAW_INTERNAL_BASH_ENV] as Record<string, string>
    expect(overlay.TYPECLAW_GIT_TOKEN).toBe('ghs_minted')
    expect(overlay.GIT_ASKPASS).toBeDefined()
    // The whole chain runs unchanged; the token rides only in the env overlay.
    expect(event.args.command).toBe(
      'git clone https://github.com/acme/widgets.git /tmp/x && git -C /tmp/x fetch origin main',
    )
    expect(JSON.stringify(event.args.command)).not.toContain('ghs_minted')
  })

  test('classic PAT (unsandboxed): injects GIT_ASKPASS with the PAT, does not mint', async () => {
    process.env.GH_TOKEN = 'ghp_classic'
    let resolverCalled = false
    const hook = await hookFor(
      async () => {
        resolverCalled = true
        return { kind: 'token', token: 'ghs_minted' }
      },
      true,
      { permissions: unsandboxedPermissions },
    )
    const event = bashEvent('git clone https://github.com/acme/widgets.git')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    const overlay = event.args[TYPECLAW_INTERNAL_BASH_ENV] as Record<string, string>
    expect(overlay.TYPECLAW_GIT_TOKEN).toBe('ghp_classic')
    expect(overlay.GIT_ASKPASS).toBeDefined()
    expect(JSON.stringify(event.args.command)).not.toContain('ghp_classic')
    expect(resolverCalled).toBe(false)
  })

  test('fine-grained PAT (unsandboxed): injects GIT_ASKPASS with the PAT, does not mint', async () => {
    process.env.GH_TOKEN = 'github_pat_xyz'
    let resolverCalled = false
    const hook = await hookFor(
      async () => {
        resolverCalled = true
        return { kind: 'token', token: 'ghs_minted' }
      },
      true,
      { permissions: unsandboxedPermissions },
    )
    const event = bashEvent('git clone https://github.com/acme/widgets.git')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    const overlay = event.args[TYPECLAW_INTERNAL_BASH_ENV] as Record<string, string>
    expect(overlay.TYPECLAW_GIT_TOKEN).toBe('github_pat_xyz')
    expect(overlay.GIT_ASKPASS).toBeDefined()
    expect(resolverCalled).toBe(false)
  })

  test('PAT (sandboxed) + App minter: mints a per-repo App token for git instead of the withheld PAT', async () => {
    process.env.GH_TOKEN = 'ghp_classic'
    const hook = await hookFor(tokenResolver('ghs_minted'), true)
    const event = bashEvent('git clone https://github.com/acme/widgets.git')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    const overlay = event.args[TYPECLAW_INTERNAL_BASH_ENV] as Record<string, string>
    expect(overlay.TYPECLAW_GIT_TOKEN).toBe('ghs_minted')
    expect(overlay.GIT_ASKPASS).toBeDefined()
  })

  test('PAT (sandboxed) + no App minter: blocks git with the withheld-PAT guidance', async () => {
    process.env.GH_TOKEN = 'ghp_classic'
    const hook = await hookFor(tokenResolver('ghs_minted'), false)
    const event = bashEvent('git clone https://github.com/acme/widgets.git')

    const result = await hook(event, hookCtx)

    expect(result).toMatchObject({ block: true })
    expect((result as { reason: string }).reason).toContain('sandboxed')
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
  })

  test('non-github explicit-URL git command passes through without minting', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    let resolverCalled = false
    const hook = await hookFor(async () => {
      resolverCalled = true
      return { kind: 'token', token: 'ghs_minted' }
    })
    const event = bashEvent('git clone https://gitlab.com/acme/widgets.git')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
    expect(resolverCalled).toBe(false)
  })

  test('plain non-git/gh bash command passes through', async () => {
    process.env.GH_TOKEN = 'ghs_seeded'
    const hook = await hookFor(tokenResolver('ghs_minted'))
    const event = bashEvent('ls -la')

    const result = await hook(event, hookCtx)

    expect(result).toBeUndefined()
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
  })
})
