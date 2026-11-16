import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient, parseEntryName } from 'typevault'

import type { FillSecretOptions } from '@/browser/fill-secret'
import { createFillSecretTool } from '@/bundled-plugins/managed-browser'
import { createPermissionService } from '@/permissions'
import { typevaultCliPath } from '@/typevault/cli-path'
import { reconcileTypevault } from '@/typevault/lifecycle'
import { ensureRoleTiers, typevaultDir, typevaultEnv, vaultAdmin } from '@/typevault/vault'

import { createSessionGrants } from './grants'
import { createVaultRequestTool } from './request'
import { activateVaultRuntime, cronExecVaultEnv, readVaultValue } from './runtime'

const logger = { info: () => {}, warn: () => {}, error: () => {} }
let dir: string

// Grants are container-stage (Linux); the typevault daemon these tests start
// does not run on the Windows CI runner.
beforeEach(async () => {
  if (process.platform === 'win32') return
  dir = await mkdtemp(join(tmpdir(), 'typeclaw-typevault-request-'))
  writeFileSync(join(dir, 'secrets.json'), '{"version":2,"providers":{},"channels":{},"mcp":{}}\n')
  await reconcileTypevault(dir, true)
  await ensureRoleTiers(dir, ['owner', 'trusted', 'member', 'guest'])
  const direct = await createClient({ direct: true, global: true, dir: typevaultDir(dir), env: typevaultEnv(dir) })
  for (const tier of ['owner', 'member']) {
    await direct.set({
      name: parseEntryName(`typevault://${tier}/login`),
      tier,
      fields: { password: { type: 'secret', value: `${tier}-password-value` } },
    })
  }
  const admin = vaultAdmin(dir)
  const grants = createSessionGrants({
    issue: ({ tier, label }) => admin.grant({ tiers: [tier], ttl: '5m', label }),
    revoke: async (label) => {
      await admin.revoke({ label })
    },
  })
  activateVaultRuntime({
    agentDir: dir,
    grants,
    roles: new Map([['s1', 'member']]),
    permissions: createPermissionService(),
  })
})

afterEach(async () => {
  activateVaultRuntime(undefined)
  if (process.platform === 'win32') return
  await Bun.spawn([process.execPath, typevaultCliPath(), 'daemon', 'stop'], {
    env: typevaultEnv(dir),
    stdout: 'ignore',
    stderr: 'ignore',
  }).exited
  await rm(dir, { recursive: true, force: true })
})

const ctx = () => ({ signal: undefined, sessionId: 's1', agentDir: dir, logger })

describe.skipIf(process.platform === 'win32')('vault_request', () => {
  test('opens a one-time page and serves its link from the tunnel origin', async () => {
    const tool = createVaultRequestTool(() => ({ status: 'ready', url: 'https://agent.example.com' }))

    const result = await tool.execute(
      tool.parameters.parse({ name: 'typevault://resend', reason: 'send the digest' }),
      ctx(),
    )

    const details = result.details as { status: string; link: string; code: string }
    expect(details.status).toBe('opened')
    expect(details.link).toMatch(/^https:\/\/agent\.example\.com\/r\/[A-Za-z0-9_-]{22}$/)
    expect(details.code.length).toBeGreaterThan(0)
  })

  test('without a tunnel for the prompt port it opens nothing', async () => {
    const tool = createVaultRequestTool(() => ({ status: 'tunnel-missing' }))

    const result = await tool.execute(
      tool.parameters.parse({ name: 'typevault://resend', reason: 'send the digest' }),
      ctx(),
    )

    expect((result.details as { status: string }).status).toBe('tunnel-missing')
  })
})

describe.skipIf(process.platform === 'win32')('vault references', () => {
  test("a session reads fields in its role's reach and is refused the rest", async () => {
    expect(await readVaultValue('s1', 'typevault://member/login#password', 'test')).toEqual({
      ok: true,
      value: 'member-password-value',
    })
    expect((await readVaultValue('s1', 'typevault://owner/login#password', 'test')).ok).toBe(false)
    expect((await readVaultValue('unknown-session', 'typevault://member/login#password', 'test')).ok).toBe(false)
  })

  test('browser_fill_secret types a vault reference without it entering the result', async () => {
    const calls: FillSecretOptions[] = []
    const tool = createFillSecretTool('ws://127.0.0.1:1/devtools', async (options) => {
      calls.push(options)
      return { status: 'filled', url: 'https://example.com/login', field: 'input[type=password]' }
    })

    const result = await tool.execute(tool.parameters.parse({ name: 'typevault://member/login#password' }), ctx())

    expect(calls.map((call) => call.value)).toEqual(['member-password-value'])
    expect(JSON.stringify(result)).not.toContain('member-password-value')
  })
})

describe.skipIf(process.platform === 'win32')('exec cron vault access', () => {
  const cronOrigin = (scheduledByRole: string) => ({
    kind: 'cron' as const,
    jobId: 'monitor',
    jobKind: 'exec' as const,
    scheduledByRole,
  })

  const runTypevault = async (env: Record<string, string>, args: string) => {
    const child = Bun.spawn(['/bin/sh', '-c', `typevault ${args}`], {
      cwd: dir,
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code }
  }

  test("a fire reaches its scheduling role's tier through the typevault command until released", async () => {
    // given
    const lease = await cronExecVaultEnv(cronOrigin('member'), 'fire-1')
    if (lease === undefined) throw new Error('expected a lease for a member-scheduled job')

    // when
    const listed = await runTypevault(lease.env, 'ls')

    // then
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain('member/login')
    expect(listed.stdout).not.toContain('owner/login')

    // when the fire ends
    await lease.release()
    const afterRelease = await runTypevault(lease.env, 'ls')

    // then the grant no longer opens the vault
    expect(afterRelease.code).not.toBe(0)
  })

  test('a job scheduled by a role without vault.use gets no grant', async () => {
    expect(await cronExecVaultEnv(cronOrigin('guest'), 'fire-2')).toBeUndefined()
  })

  test('a fire whose typevault command cannot be prepared is issued no grant', async () => {
    // given a bin path the wrapper directory cannot be created at
    const issued: string[] = []
    activateVaultRuntime({
      agentDir: dir,
      grants: createSessionGrants({
        issue: async ({ label }) => {
          issued.push(label)
          return 'tvl1.unused'
        },
        revoke: async () => {},
      }),
      roles: new Map(),
      permissions: createPermissionService(),
    })
    mkdirSync(join(dir, '.typeclaw', 'typevault'), { recursive: true })
    writeFileSync(join(dir, '.typeclaw', 'typevault', 'bin'), 'not a directory')

    // when / then
    await expect(cronExecVaultEnv(cronOrigin('member'), 'fire-3')).rejects.toThrow()
    expect(issued).toEqual([])
  })
})
