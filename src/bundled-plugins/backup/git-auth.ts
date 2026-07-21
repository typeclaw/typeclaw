import type { GithubTokenResolveResult } from '@/channels/github-token-bridge'

import { ensureGitAskPassHelper } from '../github-cli-auth/git-askpass'
import { parseGithubRepoFromGitUrl } from '../github-cli-auth/git-command'
import { shouldMintAppToken } from '../github-cli-auth/token-class'

export type BackupGitAuthEnv = Record<string, string>

export type BackupPushAuthDeps = {
  hasAppTokenResolver: () => boolean
  ghToken: string | undefined
  resolveTokenForRepo: (repoSlug: string) => Promise<GithubTokenResolveResult>
  resolveOriginPushUrl: (cwd: string) => Promise<string | null>
  ensureAskPassHelper: () => Promise<string>
}

// The backup runner owns an independent per-repo App-auth path for its direct
// git process. A live App resolver is authoritative even when the process also
// carries an operator PAT, and the minted token is scoped to the github.com
// origin's repo slug. Without a resolver, PAT/SSH/credential-helper setups keep
// using the runner's inherited process env.
export async function resolveBackupPushAuthEnv(
  cwd: string,
  deps: BackupPushAuthDeps,
): Promise<BackupGitAuthEnv | null> {
  const hasAppTokenResolver = deps.hasAppTokenResolver()
  if (!hasAppTokenResolver && !shouldMintAppToken(deps.ghToken, false)) return null

  const originUrl = await deps.resolveOriginPushUrl(cwd)
  if (originUrl === null) return null

  const slug = parseGithubRepoFromGitUrl(originUrl)
  if (slug === null) return null

  const token = await deps.resolveTokenForRepo(slug)
  if (token.kind !== 'token') return null

  const askpass = await deps.ensureAskPassHelper()

  // Token rides in TYPECLAW_GIT_TOKEN (read by the askpass helper), never in
  // argv/config. The insteadOf rewrites map ssh/scp github remotes to https so
  // the askpass credential applies; GIT_TERMINAL_PROMPT=0 fails fast instead of
  // hanging on a prompt.
  return {
    GIT_ASKPASS: askpass,
    TYPECLAW_GIT_TOKEN: token.token,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_0: 'git@github.com:',
    GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_1: 'ssh://git@github.com/',
  }
}

export function makeDefaultAskPassEnsurer(): () => Promise<string> {
  return () => ensureGitAskPassHelper()
}
