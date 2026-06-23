import { join } from 'node:path'

import { loginWithPassword as upstreamLoginWithPassword } from 'agent-messenger/webex'

import { decrypt, EncryptionError } from './encryption'
import { type KeyStore, KeyStoreError } from './keys'
import { type WebexChannelBlock } from './schema'
import { SecretsBackend } from './storage'
import { SecretsWebexCredentialStore } from './webex-store'

// Webex password-login access tokens live ~27h. The daily renewal tick fires
// every 24h, so a token must be refreshed while it still has more than one
// tick-interval of life left — otherwise it expires in the gap between two
// ticks and every REST call (send, history, KMS key fetch) 401s while the
// Mercury listener stays connected on its already-authenticated socket. We
// renew when the token is within 8h of `expires_at`: that clears a full 24h
// tick plus headroom for host sleep / daemon respawn, and a fresh token
// minted on each tick keeps the window comfortably ahead of expiry.
export const RENEWAL_WINDOW_MS = 8 * 60 * 60 * 1000

export type WebexRenewalDecision =
  | { kind: 'skip'; reason: 'no_account' | 'fresh_enough'; expiresInMs?: number }
  | {
      kind: 'reauth_required'
      reason: 'no_password' | 'no_email' | 'key_missing' | 'decrypt_failed'
      message: string
    }
  | { kind: 'should_renew'; account: WebexAccountSnapshot; password: string }

export type WebexAccountSnapshot = {
  account_id: string
  email: string
  created_at: string
  updated_at: string
}

export type WebexRenewalAttempt =
  | { kind: 'ok'; account_id: string; previousExpiresAt: number; nextExpiresAt: number }
  | { kind: 'reauth_required'; account_id: string; reason: string; message: string }
  | { kind: 'transient_failure'; account_id: string; reason: string }

export type WebexRenewalResult =
  | WebexRenewalAttempt
  | { kind: 'skipped'; account_id: string; reason: string; expiresInMs?: number }

export type LoginWithPasswordFn = typeof upstreamLoginWithPassword

export type WebexRenewalContext = {
  containerName: string
  agentDir: string
  keyStore: KeyStore
  now?: () => number
  loginWithPassword?: LoginWithPasswordFn
  idbrokerHost?: string
}

export async function decideRenewal(block: WebexChannelBlock, ctx: WebexRenewalContext): Promise<WebexRenewalDecision> {
  const accountId = block.currentAccount
  if (!accountId) return { kind: 'skip', reason: 'no_account' }
  const account = block.accounts[accountId]
  if (!account) return { kind: 'skip', reason: 'no_account' }

  return decideRenewalForAccount(account, ctx)
}

export async function decideRenewalForAccount(
  account: WebexChannelBlock['accounts'][string],
  ctx: WebexRenewalContext,
): Promise<WebexRenewalDecision> {
  const accountId = account.account_id

  const now = (ctx.now ?? Date.now)()
  const expiresInMs = account.expires_at - now
  if (Number.isFinite(expiresInMs) && expiresInMs > RENEWAL_WINDOW_MS) {
    return { kind: 'skip', reason: 'fresh_enough', expiresInMs }
  }

  if (!account.email) {
    return {
      kind: 'reauth_required',
      reason: 'no_email',
      message: `Webex account ${accountId} has no stored email — run \`typeclaw channel reauth webex\`.`,
    }
  }
  if (!account.encryptedPassword) {
    return {
      kind: 'reauth_required',
      reason: 'no_password',
      message: `Webex account ${accountId} has no stored password — run \`typeclaw channel reauth webex\`.`,
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
      created_at: account.created_at,
      updated_at: account.updated_at,
    },
    password: plaintextPassword,
  }
}

export async function renewCurrentAccount(ctx: WebexRenewalContext): Promise<WebexRenewalResult> {
  const secretsPath = join(ctx.agentDir, 'secrets.json')
  const backend = new SecretsBackend(secretsPath)
  const block = backend.readChannelsSync()?.webex
  const parsed = parseBlockOrEmpty(block)
  const decision = await decideRenewal(parsed, ctx)
  const accountId = parsed.currentAccount ?? ''
  const previousExpiresAt = accountId !== '' ? (parsed.accounts[accountId]?.expires_at ?? 0) : 0

  return await applyRenewalDecision({ ctx, secretsPath, accountId, previousExpiresAt, decision })
}

export async function renewAllAccounts(ctx: WebexRenewalContext): Promise<WebexRenewalResult[]> {
  const secretsPath = join(ctx.agentDir, 'secrets.json')
  const backend = new SecretsBackend(secretsPath)
  const block = backend.readChannelsSync()?.webex
  const parsed = parseBlockOrEmpty(block)
  const entries = Object.values(parsed.accounts)
  if (entries.length === 0) return [{ kind: 'skipped', account_id: '', reason: 'no_account' }]

  const results: WebexRenewalResult[] = []
  for (const account of entries) {
    const decision = await decideRenewalForAccount(account, ctx)
    results.push(
      await applyRenewalDecision({
        ctx,
        secretsPath,
        accountId: account.account_id,
        previousExpiresAt: account.expires_at,
        decision,
      }),
    )
  }
  return results
}

async function applyRenewalDecision(input: {
  ctx: WebexRenewalContext
  secretsPath: string
  accountId: string
  previousExpiresAt: number
  decision: WebexRenewalDecision
}): Promise<WebexRenewalResult> {
  const { ctx, secretsPath, accountId, previousExpiresAt, decision } = input
  if (decision.kind === 'skip') {
    return {
      kind: 'skipped',
      account_id: accountId,
      reason: decision.reason,
      ...(decision.expiresInMs !== undefined ? { expiresInMs: decision.expiresInMs } : {}),
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

  const loginWithPassword = ctx.loginWithPassword ?? upstreamLoginWithPassword
  const loginOptions = ctx.idbrokerHost !== undefined ? { idbrokerHost: ctx.idbrokerHost } : undefined

  let result: Awaited<ReturnType<LoginWithPasswordFn>>
  try {
    result = await loginWithPassword(decision.account.email, decision.password, loginOptions)
  } catch (err) {
    return classifyLoginFailure(err, decision.account.account_id)
  }

  // The renewed login resolves to the same Webex user, so reuse the stored
  // account_id rather than `result.userId`: the store keys accounts by id and a
  // drifted id would orphan the record (and its encryptedPassword) instead of
  // updating it. `setAccount` merges and preserves email/encryptedPassword.
  const store = new SecretsWebexCredentialStore({ mode: 'host', secretsPath })
  const nowIso = new Date().toISOString()
  await store.setAccount({
    account_id: decision.account.account_id,
    access_token: result.accessToken,
    refresh_token: result.refreshToken,
    expires_at: result.expiresAt,
    device_url: result.deviceUrl,
    user_id: result.userId,
    created_at: decision.account.created_at,
    updated_at: nowIso,
    email: decision.account.email,
  })

  return {
    kind: 'ok',
    account_id: decision.account.account_id,
    previousExpiresAt,
    nextExpiresAt: result.expiresAt,
  }
}

function parseBlockOrEmpty(value: unknown): WebexChannelBlock {
  if (value === undefined) return { currentAccount: null, accounts: {} }
  return value as WebexChannelBlock
}

function classifyLoginFailure(err: unknown, accountId: string): WebexRenewalAttempt {
  const message = err instanceof Error ? err.message : String(err)
  // agent-messenger's loginWithPassword throws WebexError with a `code` for
  // unrecoverable auth states (SSO/IdP or MFA accounts that headless password
  // login can't satisfy). Those need human reauth; everything else (network,
  // 5xx, transient idbroker hiccup) is retried on the next tick.
  const code = (err as { code?: unknown })?.code
  if (code === 'sso_required' || code === 'mfa_required') {
    return {
      kind: 'reauth_required',
      account_id: accountId,
      reason: String(code),
      message: `${message} — run \`typeclaw channel reauth webex\`.`,
    }
  }
  return { kind: 'transient_failure', account_id: accountId, reason: message }
}

function classifyDecryptFailure(err: unknown, accountId: string): WebexRenewalDecision {
  if (err instanceof KeyStoreError) {
    if (err.code === 'missing') {
      return {
        kind: 'reauth_required',
        reason: 'key_missing',
        message: `Encryption key missing for Webex account ${accountId} — run \`typeclaw channel reauth webex\` to mint a fresh one.`,
      }
    }
    return {
      kind: 'reauth_required',
      reason: 'key_missing',
      message: `Encryption key for Webex account ${accountId} is unusable (${err.code}: ${err.message}). Move it aside and run \`typeclaw channel reauth webex\` to mint a fresh one.`,
    }
  }
  if (err instanceof EncryptionError) {
    return {
      kind: 'reauth_required',
      reason: 'decrypt_failed',
      message: `Could not decrypt stored Webex password (${err.code}) — run \`typeclaw channel reauth webex\`.`,
    }
  }
  return {
    kind: 'reauth_required',
    reason: 'decrypt_failed',
    message: `Could not decrypt stored Webex password (${err instanceof Error ? err.message : String(err)}).`,
  }
}
