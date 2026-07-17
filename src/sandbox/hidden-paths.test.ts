import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import { createPermissionService } from '@/permissions/permissions'
import { rolesConfigSchema, type RolesConfig } from '@/permissions/schema'

import { CANONICAL_AGENT_SECRET_DIRS, CANONICAL_AGENT_SECRET_FILES } from './canonical-secrets'
import {
  canWriteAgentRootInSandbox,
  ensureHiddenMaskTargets,
  resolveHiddenPaths,
  verifyHiddenMaskTargets,
} from './hidden-paths'

const AGENT = '/agent'
const hiddenDirs = (agentDir: string) => [
  join(agentDir, 'workspace', '.config', 'gws'),
  join(agentDir, 'workspace', '.agent-messenger'),
  join(agentDir, '.typeclaw', 'home'),
  join(agentDir, 'workspace'),
  join(agentDir, 'memory'),
  join(agentDir, 'sessions'),
]
const canonicalSecretDirs = (agentDir: string) => [
  join(agentDir, 'workspace', '.config', 'gws'),
  join(agentDir, 'workspace', '.agent-messenger'),
  join(agentDir, '.typeclaw', 'home'),
]
const secretFiles = (agentDir: string) => [
  join(agentDir, '.env'),
  join(agentDir, 'secrets.json'),
  join(agentDir, 'auth.json'),
]

function parseRoles(raw: unknown): RolesConfig {
  const result = rolesConfigSchema.safeParse(raw)
  if (!result.success) throw new Error(`roles invalid: ${result.error.message}`)
  return result.data
}

function spawnedBy(role: string): SessionOrigin {
  return { kind: 'subagent', subagent: 'x', parentSessionId: 'p', spawnedByRole: role }
}

const tui: SessionOrigin = { kind: 'tui', sessionId: 's' }

describe('resolveHiddenPaths — builtin tiers', () => {
  test('canonical secret masks have one non-empty source of truth', () => {
    expect(CANONICAL_AGENT_SECRET_DIRS.length).toBeGreaterThan(0)
    expect(CANONICAL_AGENT_SECRET_FILES.length).toBeGreaterThan(0)
    const resolved = resolveHiddenPaths(createPermissionService(), tui, AGENT)
    expect(resolved.dirs).toEqual(CANONICAL_AGENT_SECRET_DIRS.map((entry) => join(AGENT, entry)))
    expect(resolved.files).toEqual(CANONICAL_AGENT_SECRET_FILES.map((entry) => join(AGENT, entry)))
  })

  test('owner (tui) still masks canonical agent secret files', () => {
    const svc = createPermissionService()
    const { dirs, files } = resolveHiddenPaths(svc, tui, AGENT)
    expect(dirs).toEqual(canonicalSecretDirs(AGENT))
    expect(files).toEqual(secretFiles(AGENT))
  })

  test('trusted sees private directories but still masks canonical agent secret files', () => {
    const svc = createPermissionService()
    const { dirs, files } = resolveHiddenPaths(svc, spawnedBy('trusted'), AGENT)
    expect(dirs).toEqual(canonicalSecretDirs(AGENT))
    expect(files).toEqual(secretFiles(AGENT))
  })

  test('system-origin LLM bash still masks canonical agent secret files', () => {
    const svc = createPermissionService()
    const origin: SessionOrigin = {
      kind: 'system',
      component: 'memory-logger',
      triggeredBy: { kind: 'channel', adapter: 'slack-bot', workspace: 'T0', chat: 'C0', thread: null },
    }
    const { dirs, files } = resolveHiddenPaths(svc, origin, AGENT)
    expect(dirs).toEqual(canonicalSecretDirs(AGENT))
    expect(files).toEqual(secretFiles(AGENT))
  })

  test('member sees private surface but hides the secret files', () => {
    const svc = createPermissionService()
    const { dirs, files } = resolveHiddenPaths(svc, spawnedBy('member'), AGENT)
    expect(dirs).toEqual(canonicalSecretDirs(AGENT))
    expect(files).toEqual(secretFiles(AGENT))
  })

  test('guest hides the private surface AND the secret files', () => {
    const svc = createPermissionService()
    const { dirs, files } = resolveHiddenPaths(svc, spawnedBy('guest'), AGENT)
    expect(dirs).toEqual(hiddenDirs(AGENT))
    expect(files).toEqual(secretFiles(AGENT))
  })

  test('guest never hides public/ — it is the guest-visible zone', () => {
    const svc = createPermissionService()
    const { dirs } = resolveHiddenPaths(svc, spawnedBy('guest'), AGENT)
    expect(dirs).not.toContain(join(AGENT, 'public'))
  })
})

describe('resolveHiddenPaths — resolved AGENT_MESSENGER_CONFIG_DIR mask', () => {
  const CONFIG_DIR_ENV = 'AGENT_MESSENGER_CONFIG_DIR'
  // Use a fully-resolved, platform-native agent root so the production
  // `resolve()`/`startsWith(agentDir + sep)` containment check and the test's
  // expectations agree on Windows (where `/agent` resolves to `C:\agent`).
  const ROOT = resolve(AGENT)
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env[CONFIG_DIR_ENV]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[CONFIG_DIR_ENV]
    else process.env[CONFIG_DIR_ENV] = saved
  })

  test('masks a noncanonical cred dir for every role, including tui/owner', () => {
    const expected = join(ROOT, 'workspace', '.config', 'agent-messenger')
    process.env[CONFIG_DIR_ENV] = expected
    const svc = createPermissionService()
    for (const origin of [tui, spawnedBy('trusted'), spawnedBy('member'), spawnedBy('guest')]) {
      const { dirs } = resolveHiddenPaths(svc, origin, ROOT)
      expect(dirs).toContain(expected)
    }
  })

  test('does not double-add when the value is already the canonical path', () => {
    const canonical = join(ROOT, 'workspace', '.agent-messenger')
    process.env[CONFIG_DIR_ENV] = canonical
    const { dirs } = resolveHiddenPaths(createPermissionService(), tui, ROOT)
    expect(dirs.filter((d) => d === canonical)).toHaveLength(1)
  })

  test('ignores a value pointing outside the agent root', () => {
    const outside = resolve(ROOT, '..', 'outside-agent-messenger')
    process.env[CONFIG_DIR_ENV] = outside
    const { dirs } = resolveHiddenPaths(createPermissionService(), tui, ROOT)
    expect(dirs).not.toContain(outside)
  })

  test('ignores a value resolving to the agent root itself (never masks the whole root)', () => {
    process.env[CONFIG_DIR_ENV] = '.'
    const { dirs } = resolveHiddenPaths(createPermissionService(), tui, ROOT)
    expect(dirs).not.toContain(ROOT)
  })

  test('ignores a traversal escape even when it lands back near the root', () => {
    process.env[CONFIG_DIR_ENV] = join('workspace', '..', '..', 'etc', 'x')
    const { dirs } = resolveHiddenPaths(createPermissionService(), tui, ROOT)
    expect(dirs).not.toContain(resolve(ROOT, '..', 'etc', 'x'))
  })

  test('resolves a relative value against the agent root before masking', () => {
    process.env[CONFIG_DIR_ENV] = join('workspace', '.config', 'agent-messenger')
    const { dirs } = resolveHiddenPaths(createPermissionService(), tui, ROOT)
    expect(dirs).toContain(join(ROOT, 'workspace', '.config', 'agent-messenger'))
  })
})

describe('canWriteAgentRootInSandbox', () => {
  test('preserves full agent-root writes for owner and trusted while member remains confined', () => {
    const svc = createPermissionService()
    expect(canWriteAgentRootInSandbox(svc, tui)).toBe(true)
    expect(canWriteAgentRootInSandbox(svc, spawnedBy('trusted'))).toBe(true)
    expect(canWriteAgentRootInSandbox(svc, spawnedBy('member'))).toBe(false)
    expect(canWriteAgentRootInSandbox(svc, spawnedBy('guest'))).toBe(false)
  })
})

describe('resolveHiddenPaths — fail-safe', () => {
  test('undefined origin is treated as guest (everything hidden)', () => {
    const svc = createPermissionService()
    const { dirs, files } = resolveHiddenPaths(svc, undefined, AGENT)
    expect(dirs).toEqual(hiddenDirs(AGENT))
    expect(files).toEqual(secretFiles(AGENT))
  })

  test('unmatched channel author resolves to guest (everything hidden)', () => {
    const svc = createPermissionService()
    const stranger: SessionOrigin = {
      kind: 'channel',
      adapter: 'slack-bot',
      workspace: 'T0',
      chat: 'C0',
      thread: null,
      lastInboundAuthorId: 'U_STRANGER',
    }
    const { dirs, files } = resolveHiddenPaths(svc, stranger, AGENT)
    expect(dirs).toEqual(hiddenDirs(AGENT))
    expect(files).toEqual(secretFiles(AGENT))
  })
})

describe('resolveHiddenPaths — custom roles via fs.see grants', () => {
  test('custom role with explicit fs.see.private sees the private surface', () => {
    const roles = parseRoles({ contributor: { match: ['slack:T0 author:U_C'], permissions: ['fs.see.private'] } })
    const svc = createPermissionService({ roles })
    const { dirs, files } = resolveHiddenPaths(svc, spawnedBy('contributor'), AGENT)
    expect(dirs).toEqual(canonicalSecretDirs(AGENT))
    expect(files).toEqual(secretFiles(AGENT))
  })

  test('fs.see.secrets does not expose canonical agent secret files to LLM tools', () => {
    const roles = parseRoles({
      steward: { match: ['slack:T0 author:U_S'], permissions: ['fs.see.private', 'fs.see.secrets'] },
    })
    const svc = createPermissionService({ roles })
    const { dirs, files } = resolveHiddenPaths(svc, spawnedBy('steward'), AGENT)
    expect(dirs).toEqual(canonicalSecretDirs(AGENT))
    expect(files).toEqual(secretFiles(AGENT))
  })
})

describe('resolveHiddenPaths — legacy security.bypass fallback', () => {
  test('a role with only bypass.low (no fs.see.*) still sees the private surface', () => {
    const roles = parseRoles({
      legacymember: { match: ['slack:T0 author:U_LM'], permissions: ['security.bypass.low'] },
    })
    const svc = createPermissionService({ roles })
    const { dirs, files } = resolveHiddenPaths(svc, spawnedBy('legacymember'), AGENT)
    expect(dirs).toEqual(canonicalSecretDirs(AGENT))
    expect(files).toEqual(secretFiles(AGENT))
  })

  test('bypass.medium exposes private directories but not canonical agent secret files', () => {
    const roles = parseRoles({
      legacytrusted: { match: ['slack:T0 author:U_LT'], permissions: ['security.bypass.medium'] },
    })
    const svc = createPermissionService({ roles })
    const { dirs, files } = resolveHiddenPaths(svc, spawnedBy('legacytrusted'), AGENT)
    expect(dirs).toEqual(canonicalSecretDirs(AGENT))
    expect(files).toEqual(secretFiles(AGENT))
  })
})

describe('resolveHiddenPaths — agentDir relativity', () => {
  test('masks are rooted at the given agentDir, not a hardcoded /agent', () => {
    const svc = createPermissionService()
    const { dirs, files } = resolveHiddenPaths(svc, undefined, '/srv/app')
    expect(dirs).toEqual(hiddenDirs('/srv/app'))
    expect(files).toEqual(secretFiles('/srv/app'))
  })
})

describe('ensureHiddenMaskTargets', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tc-mask-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const isRegularFile = async (target: string) => (await lstat(target)).isFile()
  const isDir = async (target: string) => (await lstat(target)).isDirectory()

  test('materializes an absent secret file so the mask has a real target to bind over', async () => {
    // given: an agent folder whose .env legitimately does not exist (keys in secrets.json)
    const env = join(dir, '.env')
    // when
    const result = await ensureHiddenMaskTargets({ dirs: [], files: [env] })
    // then: the placeholder exists and the mask keeps it
    expect(await isRegularFile(env)).toBe(true)
    expect(result.files).toEqual([env])
  })

  test('materializes an absent private dir so a --tmpfs mask has a real mount point', async () => {
    const workspace = join(dir, 'workspace')
    const result = await ensureHiddenMaskTargets({ dirs: [workspace], files: [] })
    expect(await isDir(workspace)).toBe(true)
    expect(result.dirs).toEqual([workspace])
  })

  test('leaves an existing secret file untouched and keeps it in the mask', async () => {
    const secrets = join(dir, 'secrets.json')
    await writeFile(secrets, '{"real":"content"}')
    const result = await ensureHiddenMaskTargets({ dirs: [], files: [secrets] })
    expect(result.files).toEqual([secrets])
    expect(await Bun.file(secrets).text()).toBe('{"real":"content"}')
  })

  test('fails closed when a canonical mask target is a symlink', async () => {
    const outside = join(dir, 'outside')
    await writeFile(outside, 'secret')
    const env = join(dir, '.env')
    await symlink(outside, env)
    await expect(ensureHiddenMaskTargets({ dirs: [], files: [env] })).rejects.toThrow(/mask target/i)
  })

  test('fails closed when a credential-directory mask target is a symlink', async () => {
    const outside = join(dir, 'outside-dir')
    await mkdir(outside)
    const gws = join(dir, 'gws')
    await symlink(outside, gws)
    await expect(ensureHiddenMaskTargets({ dirs: [gws], files: [] })).rejects.toThrow(/mask target/i)
  })

  test('fails closed when a canonical mask target is non-regular', async () => {
    const env = join(dir, '.env')
    await mkdir(env)
    await expect(ensureHiddenMaskTargets({ dirs: [], files: [env] })).rejects.toThrow(/mask target/i)
  })

  test('fails closed when a canonical mask target has another hardlink', async () => {
    const env = join(dir, '.env')
    await writeFile(env, 'secret')
    await link(env, join(dir, 'env-alias'))
    await expect(ensureHiddenMaskTargets({ dirs: [], files: [env] })).rejects.toThrow(/hardlink|mask target/i)
  })

  test('applies the same fail-closed hardlink rule to historical root auth.json', async () => {
    const auth = join(dir, 'auth.json')
    await writeFile(auth, 'secret')
    await link(auth, join(dir, 'auth-alias'))
    await expect(ensureHiddenMaskTargets({ dirs: [], files: [auth] })).rejects.toThrow(/hardlink|mask target/i)
  })

  test('revalidation catches a hardlink introduced after initial mask validation', async () => {
    const auth = join(dir, 'auth.json')
    await writeFile(auth, 'secret')
    const targets = await ensureHiddenMaskTargets({ dirs: [], files: [auth] })
    await link(auth, join(dir, 'late-alias'))
    await expect(verifyHiddenMaskTargets(targets)).rejects.toThrow(/hardlink|mask target/i)
  })

  test('fails closed when a file under a canonical secret directory has an outside hardlink', async () => {
    const gws = join(dir, 'workspace', '.config', 'gws')
    await mkdir(gws, { recursive: true })
    const credential = join(gws, 'accounts', 'credentials.json')
    await mkdir(join(gws, 'accounts'))
    await writeFile(credential, 'secret')
    await link(credential, join(dir, 'public-alias'))
    await expect(ensureHiddenMaskTargets({ dirs: [gws], files: [], credentialDirs: [gws] })).rejects.toThrow(
      /hardlink|mask target/i,
    )
  })

  test('fails closed when an absent canonical mask target cannot be materialized', async () => {
    const env = join(dir, 'missing-parent', '.env')
    await expect(ensureHiddenMaskTargets({ dirs: [], files: [env] })).rejects.toThrow(/mask target/i)
  })

  test('rejects a credential dir reached through a symlinked ancestor', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'tc-outside-'))
    try {
      await symlink(outside, join(dir, 'workspace'))
      const credDir = join(dir, 'workspace', '.config', 'agent-messenger')
      await expect(
        ensureHiddenMaskTargets({ dirs: [credDir], files: [], credentialDirs: [credDir], agentRoot: dir }),
      ).rejects.toThrow(/symlinked ancestor|mask target/i)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('runs the hardlink scan on a relative-configured (declared) credential dir', async () => {
    const credDir = join(dir, 'workspace', '.config', 'agent-messenger')
    await mkdir(credDir, { recursive: true })
    const token = join(credDir, 'webex-credentials.json')
    await writeFile(token, 'secret')
    await link(token, join(dir, 'public-alias'))
    await expect(
      ensureHiddenMaskTargets({ dirs: [credDir], files: [], credentialDirs: [credDir], agentRoot: dir }),
    ).rejects.toThrow(/hardlink|mask target/i)
  })

  test('rejects a symlinked token file inside a credential dir (escape via link target)', async () => {
    const credDir = join(dir, 'workspace', '.agent-messenger')
    await mkdir(credDir, { recursive: true })
    const visibleTarget = join(dir, 'public', 'leaked-token.json')
    await mkdir(join(dir, 'public'), { recursive: true })
    await writeFile(visibleTarget, 'secret')
    await symlink(visibleTarget, join(credDir, 'webex-credentials.json'))
    await expect(
      ensureHiddenMaskTargets({ dirs: [credDir], files: [], credentialDirs: [credDir], agentRoot: dir }),
    ).rejects.toThrow(/symlink under credential|mask target/i)
  })

  test('rejects a symlinked SUBDIRECTORY inside a credential dir', async () => {
    const credDir = join(dir, 'workspace', '.agent-messenger')
    await mkdir(credDir, { recursive: true })
    const visibleDir = join(dir, 'public', 'accounts')
    await mkdir(visibleDir, { recursive: true })
    await symlink(visibleDir, join(credDir, 'accounts'))
    await expect(
      ensureHiddenMaskTargets({ dirs: [credDir], files: [], credentialDirs: [credDir], agentRoot: dir }),
    ).rejects.toThrow(/symlink under credential|mask target/i)
  })
})
