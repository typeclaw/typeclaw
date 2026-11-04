import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient, parseEntryName } from 'typevault'

import type { FillSecretOptions } from '@/browser/fill-secret'
import { createFillSecretTool } from '@/bundled-plugins/managed-browser'
import { typevaultCliPath } from '@/typevault/cli-path'
import { reconcileTypevault } from '@/typevault/lifecycle'
import { ensureRoleTiers, typevaultDir, typevaultEnv, vaultAdmin } from '@/typevault/vault'

import { createSessionGrants } from './grants'
import { createVaultRequestTool } from './request'
import { activateVaultRuntime, readVaultValue } from './runtime'

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
      name: parseEntryName(`tv://${tier}/login`),
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
  activateVaultRuntime({ agentDir: dir, grants, roles: new Map([['s1', 'member']]) })
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

    const result = await tool.execute(tool.parameters.parse({ name: 'tv://resend', reason: 'send the digest' }), ctx())

    const details = result.details as { status: string; link: string; code: string }
    expect(details.status).toBe('opened')
    expect(details.link).toMatch(/^https:\/\/agent\.example\.com\/r\/[A-Za-z0-9_-]{22}$/)
    expect(details.code.length).toBeGreaterThan(0)
  })

  test('without a tunnel for the prompt port it opens nothing and reports what to configure', async () => {
    const tool = createVaultRequestTool(() => ({ status: 'tunnel-missing' }))

    const result = await tool.execute(tool.parameters.parse({ name: 'tv://resend', reason: 'send the digest' }), ctx())

    expect((result.details as { status: string }).status).toBe('tunnel-missing')
  })
})

describe.skipIf(process.platform === 'win32')('vault references', () => {
  test("a session reads fields in its role's reach and is refused the rest", async () => {
    expect(await readVaultValue('s1', 'tv://member/login#password', 'test')).toEqual({
      ok: true,
      value: 'member-password-value',
    })
    expect((await readVaultValue('s1', 'tv://owner/login#password', 'test')).ok).toBe(false)
    expect((await readVaultValue('unknown-session', 'tv://member/login#password', 'test')).ok).toBe(false)
  })

  test('browser_fill_secret types a vault reference without it entering the result', async () => {
    const calls: FillSecretOptions[] = []
    const tool = createFillSecretTool('ws://127.0.0.1:1/devtools', async (options) => {
      calls.push(options)
      return { status: 'filled', url: 'https://example.com/login', field: 'input[type=password]' }
    })

    const result = await tool.execute(tool.parameters.parse({ name: 'tv://member/login#password' }), ctx())

    expect(calls.map((call) => call.value)).toEqual(['member-password-value'])
    expect(JSON.stringify(result)).not.toContain('member-password-value')
  })
})
