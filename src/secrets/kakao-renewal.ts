import { join } from 'node:path'

import { attemptLogin as upstreamAttemptLogin, type KakaoDeviceType } from 'agent-messenger/kakaotalk'

import { decrypt, EncryptionError } from './encryption'
import { SecretsKakaoCredentialStore } from './kakao-store'
import { type KeyStore, KeyStoreError } from './keys'
import { type KakaoChannelBlock } from './schema'
import { SecretsBackend } from './storage'

export const RENEWAL_THRESHOLD_MS = 5 * 24 * 60 * 60 * 1000

// Hard ~7-day TTL on KakaoTalk sub-device tokens means renewal must happen
// before that wall. We refresh at >5 days old to leave a 2-day safety margin
// for cron skips (host asleep, daemon respawning, etc.) and to absorb any
// downward drift in KakaoTalk's actual TTL.

export type RenewalDecision =
  | { kind: 'skip'; reason: 'no_account' | 'fresh_enough'; ageMs?: number }
  | { kind: 'reauth_required'; reason: 'no_password' | 'no_email' | 'key_missing' | 'decrypt_failed'; message: string }
  | { kind: 'should_renew'; account: AccountSnapshot; password: string }

export type AccountSnapshot = {
  account_id: string
  email: string
  device_uuid: string
  device_type: KakaoDeviceType
  created_at: string
  updated_at: string
}

export type RenewalAttempt =
  | { kind: 'ok'; account_id: string; previousUpdatedAt: string; nextUpdatedAt: string }
  | { kind: 'reauth_required'; account_id: string; reason: string; message: string }
  | { kind: 'transient_failure'; account_id: string; reason: string }

export type RenewalResult = RenewalAttempt | { kind: 'skipped'; account_id: string; reason: string; ageMs?: number }

export type AttemptLoginFn = typeof upstreamAttemptLogin

export type RenewalContext = {
  containerName: string
  agentDir: string
  keyStore: KeyStore
  now?: () => number
  attemptLogin?: AttemptLoginFn
}

export async function decideRenewal(block: KakaoChannelBlock, ctx: RenewalContext): Promise<RenewalDecision> {
  const accountId = block.currentAccount
  if (!accountId) return { kind: 'skip', reason: 'no_account' }
  const account = block.accounts[accountId]
  if (!account) return { kind: 'skip', reason: 'no_account' }

  return decideRenewalForAccount(account, ctx)
}

export async function decideRenewalForAccount(
  account: KakaoChannelBlock['accounts'][string],
  ctx: RenewalContext,
): Promise<RenewalDecision> {
  const accountId = account.account_id

  const now = (ctx.now ?? Date.now)()
  const ageMs = now - Date.parse(account.updated_at)
  if (Number.isFinite(ageMs) && ageMs < RENEWAL_THRESHOLD_MS) {
    return { kind: 'skip', reason: 'fresh_enough', ageMs }
  }

  if (!account.email) {
    return {
      kind: 'reauth_required',
      reason: 'no_email',
      message: `KakaoTalk account ${accountId} has no stored email — run \`typeclaw channel reauth kakaotalk\`.`,
    }
  }
  if (!account.encryptedPassword) {
    return {
      kind: 'reauth_required',
      reason: 'no_password',
      message: `KakaoTalk account ${accountId} has no stored password — run \`typeclaw channel reauth kakaotalk\`.`,
    }
  }

  let plaintextPassword: string
  try {
    const key = await ctx.keyStore.read(ctx.containerName)
    plaintextPassword = decrypt(account.encryptedPassword, key, {
      containerName: ctx.containerName,
      accountId: account.account_id,
    })
  } catch (err) {
    return classifyDecryptFailure(err, accountId)
  }

  return {
    kind: 'should_renew',
    account: {
      account_id: account.account_id,
      email: account.email,
      device_uuid: account.device_uuid,
      device_type: account.device_type,
      created_at: account.created_at,
      updated_at: account.updated_at,
    },
    password: plaintextPassword,
  }
}

export async function renewCurrentAccount(ctx: RenewalContext): Promise<RenewalResult> {
  const secretsPath = join(ctx.agentDir, 'secrets.json')
  const backend = new SecretsBackend(secretsPath)
  const block = backend.readChannelsSync()?.kakaotalk
  const parsed = parseBlockOrEmpty(block)
  const decision = await decideRenewal(parsed, ctx)
  const accountId = parsed.currentAccount ?? ''

  return await applyRenewalDecision({ ctx, secretsPath, accountId, decision })
}

export async function renewAllAccounts(ctx: RenewalContext): Promise<RenewalResult[]> {
  const secretsPath = join(ctx.agentDir, 'secrets.json')
  const backend = new SecretsBackend(secretsPath)
  const block = backend.readChannelsSync()?.kakaotalk
  const parsed = parseBlockOrEmpty(block)
  const entries = Object.values(parsed.accounts)
  if (entries.length === 0) return [{ kind: 'skipped', account_id: '', reason: 'no_account' }]

  const results: RenewalResult[] = []
  for (const account of entries) {
    const decision = await decideRenewalForAccount(account, ctx)
    results.push(await applyRenewalDecision({ ctx, secretsPath, accountId: account.account_id, decision }))
  }
  return results
}

async function applyRenewalDecision(input: {
  ctx: RenewalContext
  secretsPath: string
  accountId: string
  decision: RenewalDecision
}): Promise<RenewalResult> {
  const { ctx, secretsPath, accountId, decision } = input
  if (decision.kind === 'skip') {
    return {
      kind: 'skipped',
      account_id: accountId,
      reason: decision.reason,
      ...(decision.ageMs !== undefined ? { ageMs: decision.ageMs } : {}),
    }
  }
  if (decision.kind === 'reauth_required') {
    return {
      kind: 'reauth_required',
      account_id: accountId,
      reason: decision.reason,
      message: decision.message,
    }
  }

  const attemptLogin = ctx.attemptLogin ?? upstreamAttemptLogin
  const result = await attemptLogin(
    decision.account.email,
    decision.password,
    decision.account.device_uuid,
    decision.account.device_type,
    false,
  )

  if (!result.authenticated || !result.credentials) {
    const message = result.message ?? result.error ?? 'login did not authenticate'
    if (result.error === 'bad_credentials' || result.next_action === 'provide_passcode') {
      return {
        kind: 'reauth_required',
        account_id: decision.account.account_id,
        reason: result.error ?? result.next_action ?? 'login_failed',
        message,
      }
    }
    return {
      kind: 'transient_failure',
      account_id: decision.account.account_id,
      reason: message,
    }
  }

  const store = new SecretsKakaoCredentialStore({ mode: 'host', secretsPath })
  const nowIso = new Date().toISOString()
  await store.setAccount({
    account_id: decision.account.account_id,
    oauth_token: result.credentials.access_token,
    user_id: result.credentials.user_id,
    refresh_token: result.credentials.refresh_token,
    device_uuid: result.credentials.device_uuid,
    device_type: result.credentials.device_type,
    auth_method: 'login',
    created_at: decision.account.created_at,
    updated_at: nowIso,
  })

  return {
    kind: 'ok',
    account_id: decision.account.account_id,
    previousUpdatedAt: decision.account.updated_at,
    nextUpdatedAt: nowIso,
  }
}

function parseBlockOrEmpty(value: unknown): KakaoChannelBlock {
  if (value === undefined) return { currentAccount: null, accounts: {} }
  return value as KakaoChannelBlock
}

function classifyDecryptFailure(err: unknown, accountId: string): RenewalDecision {
  if (err instanceof KeyStoreError) {
    if (err.code === 'missing') {
      return {
        kind: 'reauth_required',
        reason: 'key_missing',
        message: `Encryption key missing for KakaoTalk account ${accountId} — run \`typeclaw channel reauth kakaotalk\` to mint a fresh one.`,
      }
    }
    return {
      kind: 'reauth_required',
      reason: 'key_missing',
      message: `Encryption key for KakaoTalk account ${accountId} is unusable (${err.code}: ${err.message}). Move it aside and run \`typeclaw channel reauth kakaotalk\` to mint a fresh one.`,
    }
  }
  if (err instanceof EncryptionError) {
    return {
      kind: 'reauth_required',
      reason: 'decrypt_failed',
      message: `Could not decrypt stored KakaoTalk password (${err.code}) — run \`typeclaw channel reauth kakaotalk\`.`,
    }
  }
  return {
    kind: 'reauth_required',
    reason: 'decrypt_failed',
    message: `Could not decrypt stored KakaoTalk password (${err instanceof Error ? err.message : String(err)}).`,
  }
}
