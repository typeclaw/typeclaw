import { join } from 'node:path'

import type { CredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

import { createSecretsStoreForAgent } from './storage'

// Outcome for a single provider's proactive-refresh probe. `valid-or-refreshed`
// collapses "token was still good" and "token was expired and we refreshed it"
// on purpose — from the caller's view both mean "this provider can serve a turn
// now", and the SDK doesn't tell us which of the two happened. `refresh-failed`
// is the only actionable state: the token was expired and the refresh POST (or
// the lookup of the OAuth provider) did not yield a usable key.
export type ProviderRefreshOutcome = 'valid-or-refreshed' | 'refresh-failed'

export type ProviderRefreshEntry = {
  providerId: string
  outcome: ProviderRefreshOutcome
  // ModelRuntime returns the refresh rejection directly. This field is the
  // operator-visible reason; there is no process-global error queue.
  error?: string
}

export type RefreshProviderOAuthResult = {
  entries: ProviderRefreshEntry[]
}

export type RefreshProviderOAuthOptions = {
  modelRuntime: ModelRuntime
  credentials: CredentialStore
  log?: (message: string) => void
}

// Container-stage boot probe: ModelRuntime owns signal-aware OAuth refresh and
// runs it inside CredentialStore.modify, so this shares the exact live-request
// lock/persist path without reimplementing provider token exchange.
export async function refreshProviderOAuthCredentials(
  options: RefreshProviderOAuthOptions,
): Promise<RefreshProviderOAuthResult> {
  const entries: ProviderRefreshEntry[] = []
  const credentials = await options.credentials.list()

  for (const credential of credentials) {
    if (credential.type !== 'oauth') continue
    try {
      const auth = await options.modelRuntime.getAuth(credential.providerId)
      if (!auth?.auth.apiKey) throw new Error('refresh returned no API key')
      entries.push({ providerId: credential.providerId, outcome: 'valid-or-refreshed' })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      options.log?.(`refreshProviderOAuth: ${credential.providerId} refresh failed: ${reason}`)
      entries.push({ providerId: credential.providerId, outcome: 'refresh-failed', error: reason })
    }
  }
  return { entries }
}

export type RefreshProviderOAuthForAgentOptions = {
  agentDir: string
  log?: (message: string) => void
}

// Container-stage convenience wrapper. Host CLI never calls this path; it
// reads the bind-mounted v2 envelope and asks ModelRuntime to refresh before
// the first user turn.
export async function refreshProviderOAuthForAgent(
  options: RefreshProviderOAuthForAgentOptions,
): Promise<RefreshProviderOAuthResult> {
  try {
    const credentials = createSecretsStoreForAgent(join(options.agentDir, 'secrets.json'))
    const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false })
    return await refreshProviderOAuthCredentials({
      credentials,
      modelRuntime,
      ...(options.log !== undefined ? { log: options.log } : {}),
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    options.log?.(`refreshProviderOAuth: ${reason}`)
    return { entries: [] }
  }
}
