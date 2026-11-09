import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { typevaultCliPath } from './cli-path'
import { reconcileTypevault } from './lifecycle'
import {
  agentSocketPath,
  ensureRoleTiers,
  readSecretsEntry,
  runtimeConfigRoot,
  TYPEVAULT_HOST_ID,
  typevaultEnv,
  vaultAdmin,
} from './vault'

const SECRETS = '{"version":2,"providers":{},"channels":{},"mcp":{}}\n'

// The daemon is container-stage (Linux); it does not start on the Windows CI runner.
describe.skipIf(process.platform === 'win32')('daemon claims across container recreation', () => {
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

  async function enabledVault(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'typeclaw-typevault-holder-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'secrets.json'), SECRETS)
    await reconcileTypevault(dir, true)
    await ensureRoleTiers(dir, ['member'])
    return dir
  }

  function leaveClaim(dir: string, host: string): string {
    const holder = join(dirname(agentSocketPath(dir, runtimeConfigRoot(dir))), 'daemon.holder')
    mkdirSync(dirname(holder), { recursive: true })
    writeFileSync(
      holder,
      JSON.stringify({ host, name: 'gone-host', pid: 2_147_483_646, token: 'stale', at: new Date(0).toISOString() }),
    )
    return holder
  }

  function leaveLegacyClaim(dir: string, host: string): string {
    const holder = leaveClaim(dir, host)
    writeFileSync(holder, JSON.stringify({ host, pid: 2_147_483_646, token: 'stale', at: new Date(0).toISOString() }))
    return holder
  }

  test('a 0.3 claim left by a stopped container does not lock the upgraded agent out', async () => {
    // given: the 0.3 daemon of a stopped container left a claim with no name
    const dir = await enabledVault()
    leaveLegacyClaim(dir, TYPEVAULT_HOST_ID)

    // when: the upgraded CLI starts the agent
    const result = await reconcileTypevault(dir, true)

    // then: the credentials are still readable
    expect(result).toEqual({ action: 'unchanged' })
    expect(await readSecretsEntry(dir)).toBe(SECRETS)
  }, 30_000)

  test('a 0.3 claim under the container checkout is cleared from the host path', async () => {
    // given: the stopped container's claim, keyed by /agent/.typevault rather than the host path
    const dir = await enabledVault()
    const holder = join(dirname(agentSocketPath('/agent', runtimeConfigRoot(dir))), 'daemon.holder')
    mkdirSync(dirname(holder), { recursive: true })
    writeFileSync(
      holder,
      JSON.stringify({ host: TYPEVAULT_HOST_ID, pid: 2_147_483_646, token: 'stale', at: new Date(0).toISOString() }),
    )

    // when: the host-stage CLI reconciles through the host path
    await reconcileTypevault(dir, true)

    // then: the claim that would refuse the upgraded container is gone
    expect(existsSync(holder)).toBe(false)
  }, 30_000)

  test('a 0.3 claim from another machine is kept and still refuses the vault', async () => {
    const dir = await enabledVault()
    const holder = leaveLegacyClaim(dir, 'another-machine')

    const result = await reconcileTypevault(dir, true)

    expect(result.action).toBe('skipped')
    expect(existsSync(holder)).toBe(true)
  }, 30_000)

  test('a claim left by a previous container of this agent does not lock the next one out', async () => {
    // given: the daemon of a container that is gone left its claim behind
    const dir = await enabledVault()
    const holder = leaveClaim(dir, TYPEVAULT_HOST_ID)

    // when: the recreated container reads its credentials and issues a grant
    const secrets = await readSecretsEntry(dir)
    const grant = await vaultAdmin(dir).grant({ tiers: ['member'], ttl: '5m', label: 'session:s1:1' })

    // then: both work, and the new daemon holds the claim under the same identity
    expect(secrets).toBe(SECRETS)
    expect(grant).toStartWith('tvl1.')
    const claim = JSON.parse(readFileSync(holder, 'utf8')) as { host: string; token: string }
    expect(claim).toMatchObject({ host: TYPEVAULT_HOST_ID })
    expect(claim.token).not.toBe('stale')
  }, 30_000)

  test('a claim from another machine still refuses the vault', async () => {
    const dir = await enabledVault()
    leaveClaim(dir, 'another-machine')

    await expect(readSecretsEntry(dir)).rejects.toThrow('another machine')
  }, 30_000)
})
