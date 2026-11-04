import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient, parseEntryName } from 'typevault'

import { TYPECLAW_INTERNAL_BASH_ENV, TYPECLAW_INTERNAL_BASH_REVEAL } from '@/agent/plugin-tools'
import type { SessionOrigin } from '@/agent/session-origin'
import { createPermissionService } from '@/permissions/permissions'
import { rolesConfigSchema } from '@/permissions/schema'
import type { ToolAfterEvent, ToolBeforeEvent } from '@/plugin'
import { typevaultCliPath } from '@/typevault/cli-path'
import { reconcileTypevault } from '@/typevault/lifecycle'
import { vaultSecretValues } from '@/typevault/redaction'
import { ensureRoleTiers, grantAccess, typevaultDir, typevaultEnv, vaultAdmin } from '@/typevault/vault'

import { createSessionGrants, type GrantIssuer } from './grants'
import { REDACTION_UNAVAILABLE, vaultBashHook, vaultRedactHook } from './index'

const silent = { warn: () => {} }

function spawnedBy(role: string): SessionOrigin {
  return { kind: 'subagent', subagent: 'x', parentSessionId: 'p', spawnedByRole: role }
}

function fakeIssuer(options: { failRevokes?: number } = {}) {
  const issued: { tier: string; label: string }[] = []
  const revoked: string[] = []
  let revokeFailures = options.failRevokes ?? 0
  const issuer: GrantIssuer = {
    issue: async (request) => {
      issued.push(request)
      return `tvl1.${issued.length}`
    },
    revoke: async (label) => {
      if (revokeFailures > 0) {
        revokeFailures -= 1
        throw new Error('revoke failed')
      }
      revoked.push(label)
    },
  }
  return { issuer, issued, revoked }
}

function bashEvent(origin: SessionOrigin, args: Record<string, unknown> = { command: 'true' }): ToolBeforeEvent {
  return { tool: 'bash', sessionId: 's1', callId: 'c', args, origin } as ToolBeforeEvent
}

async function redact(readValues: () => Promise<readonly string[]>, text: string): Promise<string> {
  const event = {
    tool: 'read',
    sessionId: 's1',
    callId: 'c',
    result: { content: [{ type: 'text', text }] },
  } as ToolAfterEvent
  await vaultRedactHook(readValues, silent)(event, {} as never)
  const [part] = event.result.content
  return part?.type === 'text' ? part.text : ''
}

describe('createSessionGrants', () => {
  test('reuses one grant per session and tier, and revokes it when the session ends', async () => {
    const { issuer, issued, revoked } = fakeIssuer()
    const grants = createSessionGrants(issuer)

    const [first, second] = await Promise.all([grants.tokenFor('s1', 'member'), grants.tokenFor('s1', 'member')])
    await grants.end('s1')

    expect(first).toBe(second)
    expect(issued).toEqual([{ tier: 'member', label: 'session:s1:1' }])
    expect(revoked).toEqual(['session:s1:1'])
    expect(grants.heldToken('s1')).toBeUndefined()
  })

  test('revokes the superseded grant before issuing the replacement on a role change or near expiry', async () => {
    const { issuer } = fakeIssuer()
    const order: string[] = []
    let now = 0
    const grants = createSessionGrants(
      {
        issue: async (request) => {
          order.push(`issue ${request.label}`)
          return issuer.issue(request)
        },
        revoke: async (label) => {
          order.push(`revoke ${label}`)
          return issuer.revoke(label)
        },
      },
      () => now,
    )

    await grants.tokenFor('s1', 'trusted')
    await grants.tokenFor('s1', 'member')
    now = 12 * 60 * 60 * 1000
    await grants.tokenFor('s1', 'member')

    expect(order).toEqual([
      'issue session:s1:1',
      'revoke session:s1:1',
      'issue session:s1:2',
      'revoke session:s1:2',
      'issue session:s1:3',
    ])
  })

  test('a failed downgrade revocation keeps the old grant held, and the retry revokes it before issuing', async () => {
    const { issuer, issued, revoked } = fakeIssuer({ failRevokes: 1 })
    const grants = createSessionGrants(issuer)
    const trusted = await grants.tokenFor('s1', 'trusted')

    await expect(grants.tokenFor('s1', 'member')).rejects.toThrow('revoke failed')
    expect(grants.heldToken('s1')).toBe(trusted)
    await grants.tokenFor('s1', 'member')

    expect(revoked).toEqual(['session:s1:1'])
    expect(issued.map((request) => request.tier)).toEqual(['trusted', 'member'])
  })

  test('concurrent calls for different tiers each get a token for their own tier', async () => {
    const { issuer } = fakeIssuer()
    const grants = createSessionGrants({
      ...issuer,
      issue: async (request) => `${request.tier}:${await issuer.issue(request)}`,
    })

    const [trusted, member] = await Promise.all([grants.tokenFor('s1', 'trusted'), grants.tokenFor('s1', 'member')])

    expect(trusted).toStartWith('trusted:')
    expect(member).toStartWith('member:')
  })
})

describe('vaultRedactHook', () => {
  test('scrubs every vault secret from tool output', async () => {
    expect(await redact(async () => ['first-secret-value', 'second-secret-value'], 'a first-secret-value b')).toBe(
      'a [redacted] b',
    )
  })

  test('withholds the output when the vault cannot be read', async () => {
    const unreadable = async (): Promise<readonly string[]> => {
      throw new Error('vault unavailable')
    }

    expect(await redact(unreadable, 'maybe a secret')).toBe(REDACTION_UNAVAILABLE)
  })
})

describe('vaultBashHook', () => {
  test('a member session gets its grant, the vault and the socket, merged with existing overlays', async () => {
    const { issuer, issued } = fakeIssuer()
    const hook = vaultBashHook('/agent', createPermissionService(), createSessionGrants(issuer), silent)
    const event = bashEvent(spawnedBy('member'), {
      command: 'true',
      [TYPECLAW_INTERNAL_BASH_ENV]: { GH_REPO: 'acme/widgets' },
    })

    await hook(event, {} as never)

    expect(issued).toEqual([{ tier: 'member', label: 'session:s1:1' }])
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toEqual({
      GH_REPO: 'acme/widgets',
      TYPEVAULT_GRANT: 'tvl1.1',
      TYPEVAULT_DIR: join('/agent', '.typevault'),
      TYPEVAULT_GLOBAL: '1',
    })
    const reveal = event.args[TYPECLAW_INTERNAL_BASH_REVEAL] as { type: string; source: string; dest: string }[]
    const runtimeRoot = join('/agent', '.typeclaw', 'typevault', 'config')
    const sandboxRoot = join('/tmp', '.config')
    expect(reveal[0]).toEqual({
      type: 'ro-bind',
      source: join('/agent', '.typevault'),
      dest: join('/agent', '.typevault'),
    })
    expect(reveal[1]?.source).toStartWith(join(runtimeRoot, 'typevault', 'checkouts'))
    expect(reveal[1]?.dest).toStartWith(join(sandboxRoot, 'typevault', 'checkouts'))
    expect(reveal[1]?.dest.slice(sandboxRoot.length)).toBe(reveal[1]?.source.slice(runtimeRoot.length))
  })

  test('a custom role named runtime never receives a grant for the runtime tier', async () => {
    const { issuer, issued } = fakeIssuer()
    const permissions = createPermissionService({
      roles: rolesConfigSchema.parse({ runtime: { match: ['slack:*'], permissions: ['vault.use'] } }),
    })
    const hook = vaultBashHook('/agent', permissions, createSessionGrants(issuer), silent)
    const event = bashEvent(spawnedBy('runtime'))

    await hook(event, {} as never)

    expect(permissions.has(spawnedBy('runtime'), 'vault.use')).toBe(true)
    expect(issued).toEqual([])
    expect(event.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
  })

  test('guest sessions and non-bash tools get nothing', async () => {
    const { issuer, issued } = fakeIssuer()
    const hook = vaultBashHook('/agent', createPermissionService(), createSessionGrants(issuer), silent)
    const guest = bashEvent(spawnedBy('guest'))
    const read = { ...bashEvent(spawnedBy('owner')), tool: 'read' } as ToolBeforeEvent

    await hook(guest, {} as never)
    await hook(read, {} as never)

    expect(issued).toEqual([])
    expect(guest.args[TYPECLAW_INTERNAL_BASH_ENV]).toBeUndefined()
    expect(read.args[TYPECLAW_INTERNAL_BASH_REVEAL]).toBeUndefined()
  })
})

// Grants are container-stage (Linux); the typevault daemon does not start on
// the Windows CI runner, so the daemon-backed path is exercised on POSIX only.
describe.skipIf(process.platform === 'win32')('role tiers against a real vault', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      await Bun.spawn([process.execPath, typevaultCliPath(), 'daemon', 'stop'], {
        env: typevaultEnv(dir),
        stdout: 'ignore',
        stderr: 'ignore',
      }).exited
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a member grant reaches member and guest secrets, never owner or runtime ones, and they are redacted', async () => {
    // given: an enabled vault with the role tower and a secret per tier
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-typevault-roles-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'secrets.json'), '{"version":2,"providers":{},"channels":{},"mcp":{}}\n')
    await reconcileTypevault(dir, true)
    await ensureRoleTiers(dir, ['owner', 'trusted', 'member', 'guest'])
    const direct = await createClient({ direct: true, global: true, dir: typevaultDir(dir), env: typevaultEnv(dir) })
    for (const tier of ['owner', 'member', 'guest']) {
      await direct.set({
        name: parseEntryName(`tv://${tier}-only`),
        tier,
        fields: { $default: { type: 'secret', value: `${tier}-secret-value` } },
      })
    }
    const grants = createSessionGrants({
      issue: ({ tier, label }) => vaultAdmin(dir).grant({ tiers: [tier], ttl: '5m', label }),
      revoke: async (label) => {
        await vaultAdmin(dir).revoke({ label })
      },
    })

    // when
    const token = await grants.tokenFor('s1', 'member')
    const access = await grantAccess(dir, token)
    const names = (await access.list()).map((entry) => String(entry.name)).sort()
    await access.get(parseEntryName('tv://member-only'), 'test')
    const event = {
      tool: 'bash',
      sessionId: 's1',
      callId: 'c',
      result: { content: [{ type: 'text', text: 'got member-secret-value back' }] },
    } as ToolAfterEvent
    await vaultRedactHook(() => vaultSecretValues(dir), silent)(event, {} as never)

    // and when: the session drops to guest, which rotates its grant
    const guestToken = await grants.tokenFor('s1', 'guest')
    const stale = await grantAccess(dir, token)
    const later = {
      tool: 'read',
      sessionId: 's1',
      callId: 'c2',
      result: { content: [{ type: 'text', text: 'old log: member-secret-value' }] },
    } as ToolAfterEvent
    await vaultRedactHook(() => vaultSecretValues(dir), silent)(later, {} as never)

    // then
    expect(names).toEqual(['guest-only', 'member-only'])
    expect(event.result.content[0]).toEqual({ type: 'text', text: 'got [redacted] back' })
    expect(guestToken).not.toBe(token)
    expect(stale.list()).rejects.toThrow()
    expect(later.result.content[0]).toEqual({ type: 'text', text: 'old log: [redacted]' })
    // a value this session never read through its own grant (a derived grant
    // or a still-running command could have) is scrubbed too
    const unread = {
      tool: 'read',
      sessionId: 's1',
      callId: 'c3',
      result: { content: [{ type: 'text', text: 'leaked owner-secret-value' }] },
    } as ToolAfterEvent
    await vaultRedactHook(() => vaultSecretValues(dir), silent)(unread, {} as never)
    expect(unread.result.content[0]).toEqual({ type: 'text', text: 'leaked [redacted]' })
  })
})
