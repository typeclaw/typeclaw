import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient, type Passkey, parseEntryName } from 'typevault'

import type { FillSecretOptions } from '@/browser/fill-secret'
import type { answerPasskeyPrompt, PasskeyOptions, PasskeyOutcome } from '@/browser/passkey'
import { createFillSecretTool, createPasskeyTool } from '@/bundled-plugins/managed-browser'
import { createPermissionService } from '@/permissions'
import { typevaultCliPath } from '@/typevault/cli-path'
import { reconcileTypevault } from '@/typevault/lifecycle'
import { ensureRoleTiers, grantAccess, typevaultDir, typevaultEnv, vaultAdmin } from '@/typevault/vault'

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

describe.skipIf(process.platform === 'win32')('browser_passkey', () => {
  const p256Key = async (): Promise<string> => {
    const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
    return Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64url')
  }
  const direct = () => createClient({ direct: true, global: true, dir: typevaultDir(dir), env: typevaultEnv(dir) })
  const passkeyOf = async (credentialId: string, signCount: number): Promise<Passkey> => ({
    rp_id: 'example.com',
    credential_id: credentialId,
    private_key: await p256Key(),
    discoverable: true,
    user_handle: 'dXNlcg',
    sign_count: signCount,
  })
  // Stands in for the browser: each call answers the next prompt, after `during` runs (a change made mid-ceremony).
  const browser = (answers: PasskeyOutcome[], during?: () => Promise<void>) => {
    const calls: PasskeyOptions[] = []
    const answer = async (options: PasskeyOptions): Promise<PasskeyOutcome> => {
      calls.push(options)
      await during?.()
      const next = answers.shift()
      if (next === undefined) throw new Error('unexpected passkey prompt')
      return next
    }
    return { answer, calls }
  }
  const run = async (answer: typeof answerPasskeyPrompt, args: Record<string, unknown>): Promise<string> => {
    const tool = createPasskeyTool('ws://127.0.0.1:1/devtools', answer)
    const result = await tool.execute(tool.parameters.parse(args), ctx())
    return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
  }

  test('records the sign count of a passkey the session inherits from a tier below its own', async () => {
    // given a member passkey, and a trusted session, whose tier includes member
    const name = parseEntryName('typevault://member/inherited')
    const key = await passkeyOf('aW5oZXJpdA', 1)
    await (await direct()).set({ name, tier: 'member', fields: { passkey: { type: 'passkey', value: key } } })
    const admin = vaultAdmin(dir)
    activateVaultRuntime({
      agentDir: dir,
      grants: createSessionGrants({
        issue: ({ tier, label }) => admin.grant({ tiers: [tier], ttl: '5m', label }),
        revoke: async (label) => {
          await admin.revoke({ label })
        },
      }),
      roles: new Map([['s1', 'trusted']]),
      permissions: createPermissionService(),
    })
    const { answer } = browser([
      { status: 'signed-in', url: 'https://example.com/login', credential: { ...key, sign_count: 2 } },
    ])

    // when
    const output = await run(answer, { action: 'use', name: 'typevault://member/inherited' })

    // then the count is stored on the member entry, which stays in its tier
    const entry = await (await direct()).get(name)
    expect(output).not.toContain('not recorded')
    expect(entry.tier).toBe('member')
    expect(entry.fields['passkey']).toEqual({ type: 'passkey', value: { ...key, sign_count: 2 } })
  })

  test('registers into an existing entry keeping its fields, env and origin, and a sign-in records the new count', async () => {
    // given
    await (
      await direct()
    ).set({
      name: parseEntryName('typevault://member/site'),
      tier: 'member',
      fields: { $default: { type: 'secret', value: 'site-token-value' } },
      env: 'SITE_TOKEN',
      origin: 'https://example.com',
    })
    const created = await passkeyOf('Y3JlZA', 1)
    const url = 'https://example.com/settings'
    const { answer, calls } = browser([
      { status: 'registered', url, credential: created },
      { status: 'signed-in', url, credential: { ...created, sign_count: 2 } },
    ])

    // when
    const outputs = [
      await run(answer, { action: 'register', name: 'typevault://member/site' }),
      await run(answer, { action: 'use', name: 'typevault://member/site' }),
    ]

    // then
    const entry = await (await direct()).get(parseEntryName('typevault://member/site'))
    expect(entry.fields['$default']).toEqual({ type: 'secret', value: 'site-token-value' })
    expect(entry.fields['passkey']).toEqual({ type: 'passkey', value: { ...created, sign_count: 2 } })
    expect([entry.env, entry.origin]).toEqual(['SITE_TOKEN', 'https://example.com'])
    expect(calls.map((call) => call.credential?.credential_id)).toEqual([undefined, 'Y3JlZA'])
    for (const output of outputs) expect(output).not.toContain(created.private_key)
  })

  test('refuses an unavailable destination before pressing anything', async () => {
    // given
    await (
      await direct()
    ).set({
      name: parseEntryName('typevault://member/mapped'),
      tier: 'member',
      fields: { token: { type: 'secret', value: 'mapped-token-value' } },
      env: 'MAPPED_TOKEN',
    })
    const { answer, calls } = browser([])

    // when
    const outputs = [
      await run(answer, { action: 'register', name: 'typevault://not a name!' }),
      await run(answer, { action: 'register', name: 'typevault://member/login#password' }),
      // owner/login exists in a tier this member session can neither see nor write over.
      await run(answer, { action: 'register', name: 'typevault://owner/login' }),
      await run(answer, { action: 'register', name: 'typevault://member/mapped' }),
      // Its only field, `password`, is what bare references to it resolve to.
      await run(answer, { action: 'register', name: 'typevault://member/login' }),
    ]

    // then
    for (const output of outputs) expect(output).toStartWith('Not registered')
    expect(calls).toEqual([])
    expect((await (await direct()).list()).map((entry) => String(entry.name))).not.toContain('member/probe')
  })

  test('refuses a name held in two unrelated tiers the session cannot see, before pressing anything', async () => {
    // given `dup` in unrelated tiers x and y, neither of which the member session reaches: the owner writes the x
    // copy, and a sealed y grant issued before the name existed writes the y copy blind, so neither replaces the other
    for (const tier of ['x', 'y']) {
      const added = Bun.spawn([process.execPath, typevaultCliPath(), 'tier', 'add', tier], {
        env: typevaultEnv(dir),
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      })
      expect(await added.exited).toBe(0)
    }
    const sealedY = await vaultAdmin(dir).grant({ tiers: ['y'], ttl: '5m', sealed: true })
    const name = parseEntryName('typevault://dup')
    await (await direct()).set({ name, tier: 'x', fields: { a: { type: 'text', value: 'x' } } })
    await (await grantAccess(dir, sealedY)).set({ name, tier: 'y', fields: { a: { type: 'text', value: 'y' } } })
    const { answer, calls } = browser([])

    // when the member session tries to register into that name
    const output = await run(answer, { action: 'register', name: 'typevault://dup' })

    // then it is refused without the browser being asked
    expect(output).toStartWith('Not registered')
    expect(calls).toEqual([])
  })

  test('registers into a free name after the dry run, storing only the passkey', async () => {
    const created = await passkeyOf('ZnJlZQ', 0)
    const { answer } = browser([{ status: 'registered', url: 'https://example.com/settings', credential: created }])

    await run(answer, { action: 'register', name: 'typevault://member/fresh' })

    const entry = await (await direct()).get(parseEntryName('typevault://member/fresh'))
    expect(entry.fields).toEqual({ passkey: { type: 'passkey', value: created } })
  })

  test('writes a sign-in back to the field it read, for a bare ref to a custom field and a ref in another case', async () => {
    // given
    const work = await passkeyOf('d29yaw', 1)
    await (
      await direct()
    ).set({
      name: parseEntryName('typevault://member/custom'),
      tier: 'member',
      fields: { work: { type: 'passkey', value: work } },
    })
    const url = 'https://example.com/login'
    const { answer } = browser([
      { status: 'signed-in', url, credential: { ...work, sign_count: 2 } },
      { status: 'signed-in', url, credential: { ...work, sign_count: 3 } },
    ])

    // when
    await run(answer, { action: 'use', name: 'typevault://member/custom' })
    await run(answer, { action: 'use', name: 'typevault://member/custom#WORK' })

    // then
    const entry = await (await direct()).get(parseEntryName('typevault://member/custom'))
    expect(Object.keys(entry.fields)).toEqual(['work'])
    expect(entry.fields['work']).toEqual({ type: 'passkey', value: { ...work, sign_count: 3 } })
  })

  test('leaves a passkey rotated during the sign-in alone, and never recreates one removed meanwhile', async () => {
    // given
    const name = parseEntryName('typevault://member/rotated')
    const old = await passkeyOf('b2xk', 1)
    const rotated = await passkeyOf('bmV3', 5)
    await (await direct()).set({ name, tier: 'member', fields: { passkey: { type: 'passkey', value: old } } })
    const gone = parseEntryName('typevault://member/gone')
    await (await direct()).set({ name: gone, tier: 'member', fields: { passkey: { type: 'passkey', value: old } } })
    const url = 'https://example.com/login'
    const rotate = browser([{ status: 'signed-in', url, credential: { ...old, sign_count: 2 } }], async () => {
      await (await direct()).set({ name, tier: 'member', fields: { passkey: { type: 'passkey', value: rotated } } })
    })
    const remove = browser([{ status: 'signed-in', url, credential: { ...old, sign_count: 2 } }], async () => {
      await (await direct()).remove(gone)
    })

    // when
    const afterRotation = await run(rotate.answer, { action: 'use', name: 'typevault://member/rotated' })
    const afterRemoval = await run(remove.answer, { action: 'use', name: 'typevault://member/gone' })

    // then
    expect(afterRotation).toContain('not recorded')
    expect((await (await direct()).get(name)).fields['passkey']).toEqual({ type: 'passkey', value: rotated })
    expect(afterRemoval).toContain('not recorded')
    expect((await (await direct()).list()).map((entry) => entry.name)).not.toContain(gone)
  })

  test('keeps an entry flagged for rotation flagged through a sign-in and a registration', async () => {
    // given
    const name = parseEntryName('typevault://member/flagged')
    const key = await passkeyOf('ZmxhZw', 1)
    const password = { type: 'secret' as const, value: 'flagged-password' }
    await (await direct()).set({ name, tier: 'member', fields: { passkey: { type: 'passkey', value: key }, password } })
    // The vault is a --machine one, so this owner command runs without an unlock prompt, like setup's tier includes.
    const rotation = Bun.spawn([process.execPath, typevaultCliPath(), 'key', 'rotate', 'member'], {
      env: typevaultEnv(dir),
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    })
    expect(await rotation.exited).toBe(0)
    const second = await passkeyOf('c2Vjb25k', 0)
    const url = 'https://example.com/login'
    const { answer } = browser([
      { status: 'signed-in', url, credential: { ...key, sign_count: 2 } },
      { status: 'registered', url, credential: second },
    ])

    // when
    await run(answer, { action: 'use', name: 'typevault://member/flagged' })
    await run(answer, { action: 'register', name: 'typevault://member/flagged#second' })

    // then
    const entry = await (await direct()).get(name)
    expect(entry.needsRotation).toBe(true)
    expect(entry.fields).toEqual({
      passkey: { type: 'passkey', value: { ...key, sign_count: 2 } },
      password,
      second: { type: 'passkey', value: second },
    })
  })

  test('leaves an entry deleted and recreated under the same name at the same revision alone', async () => {
    // given
    const name = parseEntryName('typevault://member/reborn')
    const key = await passkeyOf('cmVib3Ju', 1)
    const recreate = async (): Promise<void> => {
      const client = await direct()
      await client.remove(name)
      await client.set({ name, tier: 'member', fields: { passkey: { type: 'passkey', value: key } } })
    }
    await (await direct()).set({ name, tier: 'member', fields: { passkey: { type: 'passkey', value: key } } })
    const url = 'https://example.com/login'
    const signIn = browser([{ status: 'signed-in', url, credential: { ...key, sign_count: 2 } }], recreate)
    const other = parseEntryName('typevault://member/reborn-site')
    await (await direct()).set({ name: other, tier: 'member', fields: { $default: { type: 'secret', value: 'v' } } })
    const register = browser([{ status: 'registered', url, credential: await passkeyOf('bmV3', 0) }], async () => {
      const client = await direct()
      await client.remove(other)
      await client.set({ name: other, tier: 'member', fields: { $default: { type: 'secret', value: 'v' } } })
    })

    // when
    const signedIn = await run(signIn.answer, { action: 'use', name: 'typevault://member/reborn' })
    const registered = await run(register.answer, { action: 'register', name: 'typevault://member/reborn-site' })

    // then
    expect(signedIn).toContain('not recorded')
    expect((await (await direct()).get(name)).fields['passkey']).toEqual({ type: 'passkey', value: key })
    expect(registered).toContain('saving it failed')
    expect(Object.keys((await (await direct()).get(other)).fields)).toEqual(['$default'])
  })

  test('browser_fill_secret never types a bare private_key part of a default passkey field, in either form', async () => {
    // given
    for (const [entry, key] of [
      ['member/dflt', '$default'],
      ['member/sole', 'work'],
    ] as const) {
      await (
        await direct()
      ).set({
        name: parseEntryName(`typevault://${entry}`),
        tier: 'member',
        fields: { [key]: { type: 'passkey', value: await passkeyOf('c29sZQ', 0) } },
      })
    }
    const filled: string[] = []
    const fill = createFillSecretTool('ws://127.0.0.1:1/devtools', async (options) => {
      filled.push(options.value)
      return { status: 'filled', url: 'https://example.com/login', field: 'input' }
    })

    // when
    for (const name of ['typevault://member/dflt#private_key', 'typevault://member/sole#private_key']) {
      await fill.execute(fill.parameters.parse({ name }), ctx())
    }
    await fill.execute(fill.parameters.parse({ name: 'typevault://member/login#password' }), ctx())

    // then
    expect(filled).toEqual(['member-password-value'])
  })

  test("browser_fill_secret's reader refuses a passkey and its private key part, and still reads a password", async () => {
    await (
      await direct()
    ).set({
      name: parseEntryName('typevault://member/mixed'),
      tier: 'member',
      fields: { passkey: { type: 'passkey', value: await passkeyOf('bWl4', 0) } },
    })

    expect((await readVaultValue('s1', 'typevault://member/mixed#passkey', 'test')).ok).toBe(false)
    expect((await readVaultValue('s1', 'typevault://member/mixed#passkey.private_key', 'test')).ok).toBe(false)
    expect((await readVaultValue('s1', 'typevault://member/mixed#PASSKEY.private_key', 'test')).ok).toBe(false)
    expect(await readVaultValue('s1', 'typevault://member/login#password', 'test')).toEqual({
      ok: true,
      value: 'member-password-value',
    })
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
