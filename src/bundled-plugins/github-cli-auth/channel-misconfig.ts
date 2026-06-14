import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { SecretsBackend } from '@/secrets/storage'

// Why this exists: when a repo-targeting git/gh command runs with no TypeClaw-
// managed credential, the *generic* outcome is "warn and pass through" — the
// agent may have its own ambient auth (credential helper, ~/.netrc, `gh auth
// login`, SSH). But there is one HIGH-CONFIDENCE misconfiguration we can name
// exactly: typeclaw.json declares a `channels.github` block (so the operator
// clearly intends TypeClaw-managed GitHub) yet `secrets.json#channels.github`
// carries no usable auth — so the channel adapter was skipped at boot and no
// token resolver is live. A github.com HTTPS write WILL fail. Detecting this
// lets the hook block such a write with the precise root cause instead of
// letting it fail opaquely. Presence/absence only — never reads token values.

export type GithubChannelAuthState =
  | 'configured-without-credentials'
  | 'configured-with-credentials'
  | 'not-configured'
  // secrets.json exists but could not be parsed: we cannot confirm credentials,
  // so we must not claim they are absent (avoids a false misconfig block).
  | 'indeterminate'

// A live secrets block only counts as credentials when its auth.type is one the
// channel manager accepts (pat | app) — the same gate manager.ts uses to decide
// whether to start the adapter. Anything else means no usable auth.
function hasUsableGithubAuth(githubSecrets: unknown): boolean {
  if (typeof githubSecrets !== 'object' || githubSecrets === null || Array.isArray(githubSecrets)) return false
  const auth = (githubSecrets as Record<string, unknown>).auth
  if (typeof auth !== 'object' || auth === null || Array.isArray(auth)) return false
  const authType = (auth as Record<string, unknown>).type
  return authType === 'pat' || authType === 'app'
}

function typeclawJsonHasGithubChannel(agentDir: string): boolean {
  const path = join(agentDir, 'typeclaw.json')
  if (!existsSync(path)) return false
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { channels?: Record<string, unknown> }
    const channels = parsed.channels
    if (typeof channels !== 'object' || channels === null) return false
    return Object.hasOwn(channels, 'github')
  } catch {
    return false
  }
}

export function detectGithubChannelAuthState(agentDir: string): GithubChannelAuthState {
  if (!typeclawJsonHasGithubChannel(agentDir)) return 'not-configured'

  const secretsPath = join(agentDir, 'secrets.json')
  if (!existsSync(secretsPath)) return 'configured-without-credentials'
  try {
    const githubSecrets = new SecretsBackend(secretsPath).tryReadChannelsSync()?.github
    return hasUsableGithubAuth(githubSecrets) ? 'configured-with-credentials' : 'configured-without-credentials'
  } catch {
    return 'indeterminate'
  }
}

// Per-agentDir memo: the on-disk config/secrets do not change within a session
// without a restart (channels/secrets edits are restart-required for the boot
// adapter decision), so one read per agentDir is enough and keeps this off the
// hot path of every git/gh command.
const cache = new Map<string, GithubChannelAuthState>()

export function getGithubChannelAuthState(agentDir: string): GithubChannelAuthState {
  const cached = cache.get(agentDir)
  if (cached !== undefined) return cached
  const state = detectGithubChannelAuthState(agentDir)
  cache.set(agentDir, state)
  return state
}

export function resetGithubChannelAuthStateCacheForTests(): void {
  cache.clear()
}
