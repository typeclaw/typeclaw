import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { encrypt, generateKey } from './encryption'
import { KeyStoreError, type KeyStore } from './keys'
import { type WebexEncryptedPassword, type WebexChannelBlock } from './schema'
import {
  type LoginWithPasswordFn,
  decideRenewal,
  RENEWAL_WINDOW_MS,
  renewAllAccounts,
  renewCurrentAccount,
} from './webex-renewal'

const HOUR_MS = 60 * 60 * 1000

function fakeKeyStore(opts: { containerName: string; key: Buffer | null }): KeyStore {
  return {
    keyPath: (name: string) => `/fake/${name}.key`,
    exists: (name: string) => opts.key !== null && name === opts.containerName,
    async read(name: string) {
      if (opts.key === null || name !== opts.containerName) {
        throw new KeyStoreError(`key file missing: ${name}`, 'missing')
      }
      return opts.key
    },
    async ensure(name: string) {
      if (opts.key === null || name !== opts.containerName) {
        throw new KeyStoreError(`key file missing: ${name}`, 'missing')
      }
      return opts.key
    },
    fingerprint: () => 'sha256:test',
  }
}

function buildBlock(opts: {
  accountId: string
  expiresInHours: number
  email?: string
  encryptedPassword?: WebexEncryptedPassword
  createdAt?: string
}): WebexChannelBlock {
  const nowIso = new Date().toISOString()
  return {
    currentAccount: opts.accountId,
    accounts: {
      [opts.accountId]: {
        account_id: opts.accountId,
        access_token: 'stale-access',
        refresh_token: 'stale-refresh',
        expires_at: Date.now() + opts.expiresInHours * HOUR_MS,
        device_url: 'https://wdm-a.wbx2.com/wdm/api/v1/devices/device-1',
        user_id: opts.accountId,
        created_at: opts.createdAt ?? nowIso,
        updated_at: nowIso,
        ...(opts.email !== undefined ? { email: opts.email } : {}),
        ...(opts.encryptedPassword !== undefined ? { encryptedPassword: opts.encryptedPassword } : {}),
      },
    },
  }
}

function freshLoginResult(): Awaited<ReturnType<LoginWithPasswordFn>> {
  return {
    accessToken: 'fresh-access',
    refreshToken: 'fresh-refresh',
    expiresAt: Date.now() + 27 * HOUR_MS,
    deviceUrl: 'https://wdm-a.wbx2.com/wdm/api/v1/devices/device-1',
    userId: 'u-1',
  }
}

describe('decideRenewal', () => {
  test('skips when there is no current account', async () => {
    const block: WebexChannelBlock = { currentAccount: null, accounts: {} }
    const decision = await decideRenewal(block, {
      containerName: 'webex',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'webex', key: null }),
    })
    expect(decision.kind).toBe('skip')
    if (decision.kind === 'skip') expect(decision.reason).toBe('no_account')
  })

  test('skips when the token expires comfortably beyond the renewal window', async () => {
    const block = buildBlock({ accountId: 'u-1', expiresInHours: 20 })
    const decision = await decideRenewal(block, {
      containerName: 'webex',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'webex', key: null }),
    })
    expect(decision.kind).toBe('skip')
    if (decision.kind === 'skip') expect(decision.reason).toBe('fresh_enough')
  })

  test('requires reauth when email is absent within the renewal window', async () => {
    const block = buildBlock({ accountId: 'u-1', expiresInHours: 1 })
    const decision = await decideRenewal(block, {
      containerName: 'webex',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'webex', key: null }),
    })
    expect(decision.kind).toBe('reauth_required')
    if (decision.kind === 'reauth_required') expect(decision.reason).toBe('no_email')
  })

  test('requires reauth when encryptedPassword is absent', async () => {
    const block = buildBlock({ accountId: 'u-1', expiresInHours: 1, email: 'u@e.com' })
    const decision = await decideRenewal(block, {
      containerName: 'webex',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'webex', key: null }),
    })
    expect(decision.kind).toBe('reauth_required')
    if (decision.kind === 'reauth_required') expect(decision.reason).toBe('no_password')
  })

  test('requires reauth when the key file is missing', async () => {
    const key = generateKey()
    const encryptedPassword = encrypt('pw', key, { containerName: 'webex', accountId: 'u-1' })
    const block = buildBlock({ accountId: 'u-1', expiresInHours: 1, email: 'u@e.com', encryptedPassword })
    const decision = await decideRenewal(block, {
      containerName: 'webex',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'webex', key: null }),
    })
    expect(decision.kind).toBe('reauth_required')
    if (decision.kind === 'reauth_required') expect(decision.reason).toBe('key_missing')
  })

  test('requires reauth when the key does not match the ciphertext (wrong key)', async () => {
    const realKey = generateKey()
    const otherKey = generateKey()
    const encryptedPassword = encrypt('pw', realKey, { containerName: 'webex', accountId: 'u-1' })
    const block = buildBlock({ accountId: 'u-1', expiresInHours: 1, email: 'u@e.com', encryptedPassword })
    const decision = await decideRenewal(block, {
      containerName: 'webex',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'webex', key: otherKey }),
    })
    expect(decision.kind).toBe('reauth_required')
    if (decision.kind === 'reauth_required') expect(decision.reason).toBe('decrypt_failed')
  })

  test('returns should_renew with decrypted password when everything aligns', async () => {
    const key = generateKey()
    const encryptedPassword = encrypt('hunter2', key, { containerName: 'webex', accountId: 'u-1' })
    const block = buildBlock({ accountId: 'u-1', expiresInHours: 1, email: 'u@e.com', encryptedPassword })
    const decision = await decideRenewal(block, {
      containerName: 'webex',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'webex', key }),
    })
    expect(decision.kind).toBe('should_renew')
    if (decision.kind === 'should_renew') {
      expect(decision.account.account_id).toBe('u-1')
      expect(decision.account.email).toBe('u@e.com')
      expect(decision.password).toBe('hunter2')
    }
  })

  test('renews an already-expired token (negative expiresInMs is inside the window)', async () => {
    const key = generateKey()
    const encryptedPassword = encrypt('hunter2', key, { containerName: 'webex', accountId: 'u-1' })
    const block = buildBlock({ accountId: 'u-1', expiresInHours: -2, email: 'u@e.com', encryptedPassword })
    const decision = await decideRenewal(block, {
      containerName: 'webex',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'webex', key }),
    })
    expect(decision.kind).toBe('should_renew')
  })

  test('respects the RENEWAL_WINDOW_MS boundary exactly', async () => {
    const block: WebexChannelBlock = {
      currentAccount: 'u-1',
      accounts: {
        'u-1': {
          account_id: 'u-1',
          access_token: 'a',
          refresh_token: 'r',
          expires_at: Date.now() + RENEWAL_WINDOW_MS - 1000,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      },
    }
    const decision = await decideRenewal(block, {
      containerName: 'webex',
      agentDir: '/tmp/x',
      keyStore: fakeKeyStore({ containerName: 'webex', key: null }),
    })
    // Inside the window and lacks email → reauth_required (NOT skip)
    expect(decision.kind).toBe('reauth_required')
  })
})

describe('renewCurrentAccount', () => {
  async function withAgentDir<T>(fn: (agentDir: string) => Promise<T>): Promise<T> {
    return fn(await mkdtemp(join(tmpdir(), 'typeclaw-webex-renewal-')))
  }

  async function seedSecrets(agentDir: string, block: WebexChannelBlock): Promise<void> {
    const envelope = { version: 2, providers: {}, channels: { webex: block } }
    await writeFile(join(agentDir, 'secrets.json'), JSON.stringify(envelope))
  }

  test('skips when current account is fresh', async () => {
    await withAgentDir(async (agentDir) => {
      const block = buildBlock({ accountId: 'u-1', expiresInHours: 20 })
      await seedSecrets(agentDir, block)

      const result = await renewCurrentAccount({
        containerName: 'webex',
        agentDir,
        keyStore: fakeKeyStore({ containerName: 'webex', key: null }),
        loginWithPassword: async () => {
          throw new Error('loginWithPassword must not be called for a fresh account')
        },
      })
      expect(result.kind).toBe('skipped')
    })
  })

  test('writes fresh tokens through the store, preserving email + encryptedPassword', async () => {
    await withAgentDir(async (agentDir) => {
      const key = generateKey()
      const encryptedPassword = encrypt('hunter2', key, { containerName: 'webex', accountId: 'u-1' })
      const block = buildBlock({ accountId: 'u-1', expiresInHours: 1, email: 'u@e.com', encryptedPassword })
      await seedSecrets(agentDir, block)

      const calls: Array<{ email: string; password: string }> = []
      const fakeLogin: LoginWithPasswordFn = async (email, password) => {
        calls.push({ email, password })
        return freshLoginResult()
      }

      const result = await renewCurrentAccount({
        containerName: 'webex',
        agentDir,
        keyStore: fakeKeyStore({ containerName: 'webex', key }),
        loginWithPassword: fakeLogin,
      })

      expect(result.kind).toBe('ok')
      expect(calls).toEqual([{ email: 'u@e.com', password: 'hunter2' }])

      const raw = JSON.parse(await readFile(join(agentDir, 'secrets.json'), 'utf8'))
      const persisted = raw.channels.webex.accounts['u-1']
      expect(persisted.access_token).toBe('fresh-access')
      expect(persisted.refresh_token).toBe('fresh-refresh')
      expect(persisted.email).toBe('u@e.com')
      expect(persisted.encryptedPassword?.kid).toBe(encryptedPassword.kid)
      expect(persisted.expires_at).toBeGreaterThan(block.accounts['u-1']!.expires_at)
    })
  })

  test('renews every stale account in the block, not only currentAccount', async () => {
    await withAgentDir(async (agentDir) => {
      const key = generateKey()
      const encryptedA = encrypt('pw-a', key, { containerName: 'webex', accountId: 'u-a' })
      const encryptedB = encrypt('pw-b', key, { containerName: 'webex', accountId: 'u-b' })
      const blockA = buildBlock({
        accountId: 'u-a',
        expiresInHours: 1,
        email: 'a@example.com',
        encryptedPassword: encryptedA,
      })
      const blockB = buildBlock({
        accountId: 'u-b',
        expiresInHours: 1,
        email: 'b@example.com',
        encryptedPassword: encryptedB,
      })
      const block: WebexChannelBlock = {
        currentAccount: 'u-a',
        accounts: { ...blockA.accounts, ...blockB.accounts },
      }
      await seedSecrets(agentDir, block)
      const calls: Array<{ email: string; password: string }> = []

      const results = await renewAllAccounts({
        containerName: 'webex',
        agentDir,
        keyStore: fakeKeyStore({ containerName: 'webex', key }),
        loginWithPassword: async (email, password) => {
          calls.push({ email, password })
          const suffix = email.startsWith('a') ? 'a' : 'b'
          return { ...freshLoginResult(), accessToken: `fresh-${suffix}`, refreshToken: `refresh-${suffix}` }
        },
      })

      expect(results.map((result) => result.kind)).toEqual(['ok', 'ok'])
      expect(calls).toEqual([
        { email: 'a@example.com', password: 'pw-a' },
        { email: 'b@example.com', password: 'pw-b' },
      ])
      const raw = JSON.parse(await readFile(join(agentDir, 'secrets.json'), 'utf8'))
      expect(raw.channels.webex.accounts['u-a'].access_token).toBe('fresh-a')
      expect(raw.channels.webex.accounts['u-b'].access_token).toBe('fresh-b')
    })
  })

  test('preserves created_at across renewals (only updated_at advances)', async () => {
    await withAgentDir(async (agentDir) => {
      const key = generateKey()
      const encryptedPassword = encrypt('hunter2', key, { containerName: 'webex', accountId: 'u-1' })
      const originalCreatedAt = '2026-01-01T00:00:00.000Z'
      const block = buildBlock({
        accountId: 'u-1',
        expiresInHours: 1,
        email: 'u@e.com',
        encryptedPassword,
        createdAt: originalCreatedAt,
      })
      await seedSecrets(agentDir, block)

      const result = await renewCurrentAccount({
        containerName: 'webex',
        agentDir,
        keyStore: fakeKeyStore({ containerName: 'webex', key }),
        loginWithPassword: async () => freshLoginResult(),
      })

      expect(result.kind).toBe('ok')
      const raw = JSON.parse(await readFile(join(agentDir, 'secrets.json'), 'utf8'))
      const persisted = raw.channels.webex.accounts['u-1']
      expect(persisted.created_at).toBe(originalCreatedAt)
    })
  })

  test('reports reauth_required (not transient) on an SSO/MFA WebexError', async () => {
    await withAgentDir(async (agentDir) => {
      const key = generateKey()
      const encryptedPassword = encrypt('hunter2', key, { containerName: 'webex', accountId: 'u-1' })
      const block = buildBlock({ accountId: 'u-1', expiresInHours: 1, email: 'u@e.com', encryptedPassword })
      await seedSecrets(agentDir, block)

      const result = await renewCurrentAccount({
        containerName: 'webex',
        agentDir,
        keyStore: fakeKeyStore({ containerName: 'webex', key }),
        loginWithPassword: async () => {
          throw Object.assign(new Error('Account requires MFA'), { code: 'mfa_required' })
        },
      })

      expect(result.kind).toBe('reauth_required')
      if (result.kind === 'reauth_required') expect(result.reason).toBe('mfa_required')
    })
  })

  test('reports transient_failure when login throws for a non-auth reason', async () => {
    await withAgentDir(async (agentDir) => {
      const key = generateKey()
      const encryptedPassword = encrypt('hunter2', key, { containerName: 'webex', accountId: 'u-1' })
      const block = buildBlock({ accountId: 'u-1', expiresInHours: 1, email: 'u@e.com', encryptedPassword })
      await seedSecrets(agentDir, block)

      const result = await renewCurrentAccount({
        containerName: 'webex',
        agentDir,
        keyStore: fakeKeyStore({ containerName: 'webex', key }),
        loginWithPassword: async () => {
          throw new Error('HTTP 503 from idbroker')
        },
      })

      expect(result.kind).toBe('transient_failure')
    })
  })

  test('returns reauth_required when email is missing, without calling loginWithPassword', async () => {
    await withAgentDir(async (agentDir) => {
      const block = buildBlock({ accountId: 'u-1', expiresInHours: 1 })
      await seedSecrets(agentDir, block)

      const result = await renewCurrentAccount({
        containerName: 'webex',
        agentDir,
        keyStore: fakeKeyStore({ containerName: 'webex', key: null }),
        loginWithPassword: async () => {
          throw new Error('loginWithPassword must not be called when reauth is required')
        },
      })

      expect(result.kind).toBe('reauth_required')
    })
  })
})
