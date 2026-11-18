import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { configFileLockPath } from '@/config/config-file-lock'
import type { PermissionService, RolesConfig } from '@/permissions'

import { createClaimController, type ClaimResultEvent } from './controller'

function makePermissions(): { service: PermissionService; lastReplacement: RolesConfig | undefined } {
  let lastReplacement: RolesConfig | undefined
  const service: PermissionService = {
    has: () => false,
    resolveRole: () => 'guest',
    compareRoleSeverity: () => undefined,
    permissionsForRole: () => undefined,
    describe: () => ({ role: 'guest', permissions: [] }),
    replaceRoles: (roles) => {
      lastReplacement = roles
    },
  }
  return {
    service,
    get lastReplacement() {
      return lastReplacement
    },
  } as unknown as { service: PermissionService; lastReplacement: RolesConfig | undefined }
}

describe('ClaimController', () => {
  test('full happy path: start → handler matches → grant + replaceRoles + completed event', async () => {
    const grants: { role: string; rule: string }[] = []
    const events: ClaimResultEvent[] = []
    const provided: RolesConfig = { owner: { match: [] } }

    const { service } = makePermissions()
    let replaceArg: RolesConfig | undefined
    service.replaceRoles = (roles) => {
      replaceArg = roles
    }

    const controller = createClaimController({
      cwd: '/nonexistent',
      permissions: service,
      rolesProvider: () => provided,
      grant: (role, rule) => {
        grants.push({ role, rule })
        return { ok: true, added: true }
      },
      now: () => 1_000_000,
    })

    controller.onResult((e) => events.push(e))

    const start = controller.startClaim({ code: 'claim-AAAA-BBBB', role: 'owner', ttlMs: 600_000 })
    expect(start.ok).toBe(true)

    const outcome = await controller.claimHandler({
      adapter: 'slack-bot',
      workspace: 'T0123',
      chat: 'D0',
      isDm: true,
      authorId: 'U_ME',
      text: 'claim-AAAA-BBBB',
    })

    expect(outcome.kind).toBe('consumed')
    expect(grants).toEqual([{ role: 'owner', rule: 'slack:* author:U_ME' }])
    expect(replaceArg).toBe(provided)
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('completed')
    if (events[0]!.kind === 'completed') {
      expect(events[0]!.role).toBe('owner')
      expect(events[0]!.matchRule).toBe('slack:* author:U_ME')
      expect(events[0]!.authorId).toBe('U_ME')
    }
  })

  test('no pending claim → fallthrough, no grant, no event', async () => {
    const grants: { role: string; rule: string }[] = []
    const events: ClaimResultEvent[] = []
    const { service } = makePermissions()
    const controller = createClaimController({
      cwd: '/x',
      permissions: service,
      rolesProvider: () => ({}),
      grant: (role, rule) => {
        grants.push({ role, rule })
        return { ok: true, added: true }
      },
    })
    controller.onResult((e) => events.push(e))

    const outcome = await controller.claimHandler({
      adapter: 'slack-bot',
      workspace: 'T0123',
      chat: 'D0',
      isDm: true,
      authorId: 'U_ME',
      text: 'claim-AAAA-BBBB',
    })

    expect(outcome).toEqual({ kind: 'fallthrough' })
    expect(grants).toEqual([])
    expect(events).toEqual([])
  })

  test('wrong code with active pending → fallthrough (preserves pending)', async () => {
    const events: ClaimResultEvent[] = []
    const { service } = makePermissions()
    const controller = createClaimController({
      cwd: '/x',
      permissions: service,
      rolesProvider: () => ({}),
      grant: () => ({ ok: true, added: true }),
      now: () => 1_000_000,
    })
    controller.onResult((e) => events.push(e))

    controller.startClaim({ code: 'claim-AAAA-BBBB', role: 'owner', ttlMs: 600_000 })

    const outcome = await controller.claimHandler({
      adapter: 'slack-bot',
      workspace: 'T0123',
      chat: 'D0',
      isDm: true,
      authorId: 'U_ME',
      text: 'claim-WRONG-CODE',
    })

    expect(outcome).toEqual({ kind: 'fallthrough' })
    expect(controller.current()?.code).toBe('claim-AAAA-BBBB')
  })

  test('channel-scoped pending rejects inbound from other adapter', async () => {
    const events: ClaimResultEvent[] = []
    const { service } = makePermissions()
    const controller = createClaimController({
      cwd: '/x',
      permissions: service,
      rolesProvider: () => ({}),
      grant: () => ({ ok: true, added: true }),
      now: () => 1_000_000,
    })
    controller.onResult((e) => events.push(e))

    controller.startClaim({
      code: 'claim-AAAA-BBBB',
      role: 'owner',
      channel: 'slack-bot',
      ttlMs: 600_000,
    })

    const outcome = await controller.claimHandler({
      adapter: 'discord-bot',
      workspace: 'g',
      chat: 'c',
      isDm: true,
      authorId: 'U',
      text: 'claim-AAAA-BBBB',
    })

    expect(outcome.kind).toBe('fail')
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('error')
  })

  test('grant failure surfaces an error event and a fail reply', async () => {
    const events: ClaimResultEvent[] = []
    const { service } = makePermissions()
    const controller = createClaimController({
      cwd: '/x',
      permissions: service,
      rolesProvider: () => ({}),
      grant: () => ({ ok: false, reason: 'disk full' }),
      now: () => 1_000_000,
    })
    controller.onResult((e) => events.push(e))
    controller.startClaim({ code: 'claim-AAAA-BBBB', role: 'owner', ttlMs: 600_000 })

    const outcome = await controller.claimHandler({
      adapter: 'slack-bot',
      workspace: 'T0123',
      chat: 'D0',
      isDm: true,
      authorId: 'U_ME',
      text: 'claim-AAAA-BBBB',
    })

    expect(outcome.kind).toBe('fail')
    if (outcome.kind === 'fail') {
      expect(outcome.reply).toContain('disk full')
    }
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ kind: 'error', code: 'claim-AAAA-BBBB', reason: 'disk full' })
  })

  test('a claim completed while another process holds the config lock fails with the recovery step', async () => {
    // given: a pending claim, and another process's lock on typeclaw.json
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-claim-lock-'))
    const config = join(cwd, 'typeclaw.json')
    await writeFile(config, '{}\n')
    await writeFile(configFileLockPath(config), '')
    const events: ClaimResultEvent[] = []
    const { service } = makePermissions()
    const controller = createClaimController({
      cwd,
      permissions: service,
      rolesProvider: () => ({}),
      now: () => 1_000_000,
    })
    controller.onResult((e) => events.push(e))
    controller.startClaim({ code: 'claim-AAAA-BBBB', role: 'owner', ttlMs: 600_000 })

    try {
      // when: the claim code arrives through the real grant
      const outcome = await controller.claimHandler({
        adapter: 'slack-bot',
        workspace: 'T0123',
        chat: 'D0',
        isDm: true,
        authorId: 'U_ME',
        text: 'claim-AAAA-BBBB',
      })

      // then: the claim fails through its error path with the manual recovery,
      // and the role was not written
      expect(outcome.kind).toBe('fail')
      if (outcome.kind === 'fail') expect(outcome.reply).toContain(`rm "${configFileLockPath(config)}"`)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ kind: 'error', code: 'claim-AAAA-BBBB' })
      expect(await readFile(config, 'utf8')).toBe('{}\n')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 15_000)

  test('rejects unknown role names at startClaim', () => {
    const { service } = makePermissions()
    const controller = createClaimController({
      cwd: '/x',
      permissions: service,
      rolesProvider: () => ({}),
      grant: () => ({ ok: true, added: true }),
    })

    const result = controller.startClaim({ code: 'claim-AAAA-BBBB', role: 'guest', ttlMs: 600_000 })
    expect(result.ok).toBe(false)
  })

  test('cancelClaim emits cancelled and clears pending', () => {
    const events: ClaimResultEvent[] = []
    const { service } = makePermissions()
    const controller = createClaimController({
      cwd: '/x',
      permissions: service,
      rolesProvider: () => ({}),
      grant: () => ({ ok: true, added: true }),
      now: () => 1_000_000,
    })
    controller.onResult((e) => events.push(e))

    controller.startClaim({ code: 'claim-AAAA-BBBB', role: 'owner', ttlMs: 600_000 })
    expect(controller.cancelClaim('claim-AAAA-BBBB')).toBe(true)
    expect(controller.current()).toBeNull()
    expect(events).toEqual([{ kind: 'cancelled', code: 'claim-AAAA-BBBB' }])

    expect(controller.cancelClaim('claim-OTHER-CODE')).toBe(false)
  })
})
