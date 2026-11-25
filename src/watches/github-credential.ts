import type { SessionOrigin } from '@/agent/session-origin'
import {
  canUseProcessGithubPat,
  declaredGithubEnvToken,
  effectiveGithubEnvToken,
} from '@/bundled-plugins/github-cli-auth/pat-policy'
import { classifyGhToken } from '@/bundled-plugins/github-cli-auth/token-class'
import type { GithubTokenBridge, GithubTokenResolveResult } from '@/channels/github-token-bridge'
import type { PermissionService } from '@/permissions'

export function createWatchGithubCredentialResolver(
  agentDir: string,
  permissions: PermissionService,
  github: GithubTokenBridge,
) {
  return async (origin: SessionOrigin, repo: string): Promise<GithubTokenResolveResult> => {
    if (github.hasAppTokenResolver()) return github.resolveTokenForRepo(repo)

    const entitled = canUseProcessGithubPat(permissions, origin)
    const channelPat = github.hasPatTokenResolver()
    const candidate = declaredGithubEnvToken(agentDir) ?? (entitled ? effectiveGithubEnvToken() : undefined)
    // The adapter seeds GH_TOKEN in process.env. Never lend that value via the
    // environment path, which cannot enforce the adapter's live repo allowlist.
    if (channelPat && (candidate === undefined || candidate.envName === 'GH_TOKEN')) {
      return entitled
        ? github.resolvePatForRepo(repo)
        : { kind: 'unavailable', reason: 'This role is not entitled to the GitHub channel PAT.' }
    }
    const kind = classifyGhToken(candidate?.value)
    if (candidate !== undefined && (kind === 'cross-owner' || kind === 'fine-grained-pat'))
      return { kind: 'token', token: candidate.value }
    return {
      kind: 'unavailable',
      reason:
        'No GitHub polling credential is available to this role for the repository. An imported gh login is CLI-only.',
    }
  }
}

export type ResolveWatchGithubCredential = ReturnType<typeof createWatchGithubCredentialResolver>
