import type { GithubSelfUser } from './adapters/github/auth'
import { describeError } from './describe-error'
// Decoupled from ChannelRouter on purpose: minting a token for an arbitrary
// bash `gh` command is adjacent to channels but is not routing, and a global
// singleton would leak resolver state across tests. One instance is created in
// run/index.ts and threaded to both the plugin loader and the channel manager.

export type GithubTokenCredential = { token: string; accountIdentity?: string }
export type GithubTokenResolveResult =
  | ({ kind: 'token' } & GithubTokenCredential)
  | { kind: 'unavailable'; reason: string }

export type ResolveGithubTokenForRepo = (repoSlug: string) => Promise<GithubTokenResolveResult>
export type GetGithubSelf = () => GithubSelfUser | null

export type GithubTokenBridge = {
  getSelf: GetGithubSelf
  registerSelf: (self: GithubSelfUser) => () => void
  resolveTokenForRepo: ResolveGithubTokenForRepo
  // True when a per-repo App-token minter is registered (only the GitHub App
  // adapter registers one). This is the non-secret "App auth with per-repo
  // minting is available" signal. App credentials are never seeded into the
  // process-wide GH_TOKEN, so brokered gh paths cannot rely on its prefix.
  hasAppTokenResolver: () => boolean
  getAppSelfLogin: () => string | null
  // PAT-mode channel auth: the adapter lends its stored PAT for git push to a
  // configured repo. Kept apart from the App minter so PAT presence never flips
  // hasAppTokenResolver() and the App-only paths (sandboxed minting, push grants).
  resolvePatForRepo: ResolveGithubTokenForRepo
  registerPatResolver: (resolver: (repoSlug: string) => Promise<GithubTokenCredential>) => () => void
  registerResolver: (
    resolver: (repoSlug: string) => Promise<GithubTokenCredential>,
    selfLogin?: () => string | null,
  ) => () => void
}

const NO_RESOLVER_REASON =
  'GitHub App token unavailable; the GitHub channel adapter is not running or failed to start. ' +
  'Check `typeclaw logs` and `secrets.json#channels.github`.'

const NO_PAT_RESOLVER_REASON =
  'No GitHub channel PAT is available; the GitHub channel is not configured with PAT auth, or its adapter is not running.'

export function createGithubTokenBridge(): GithubTokenBridge {
  let currentSelf: { readonly user: GithubSelfUser } | null = null
  let current: ((repoSlug: string) => Promise<GithubTokenCredential>) | null = null
  let currentSelfLogin: (() => string | null) | null = null
  let currentPat: ((repoSlug: string) => Promise<GithubTokenCredential>) | null = null

  return {
    getSelf: () => currentSelf?.user ?? null,
    registerSelf: (self) => {
      const registration = { user: self }
      currentSelf = registration
      return () => {
        if (currentSelf === registration) currentSelf = null
      }
    },
    resolvePatForRepo: async (repoSlug) => {
      const resolver = currentPat
      if (resolver === null) return { kind: 'unavailable', reason: NO_PAT_RESOLVER_REASON }
      try {
        return { kind: 'token', ...(await resolver(repoSlug)) }
      } catch (err) {
        return { kind: 'unavailable', reason: describeError(err) }
      }
    },
    registerPatResolver: (resolver) => {
      currentPat = resolver
      return () => {
        if (currentPat === resolver) currentPat = null
      }
    },
    resolveTokenForRepo: async (repoSlug) => {
      const resolver = current
      if (resolver === null) return { kind: 'unavailable', reason: NO_RESOLVER_REASON }
      try {
        const credential = await resolver(repoSlug)
        return { kind: 'token', ...credential }
      } catch (err) {
        return { kind: 'unavailable', reason: describeError(err) }
      }
    },
    hasAppTokenResolver: () => current !== null,
    getAppSelfLogin: () => currentSelfLogin?.() ?? null,
    registerResolver: (resolver, selfLogin) => {
      current = resolver
      currentSelfLogin = selfLogin ?? null
      return () => {
        // Only clear if still the active resolver: a stop() racing a newer
        // start() must not wipe the newer registration.
        if (current === resolver) {
          current = null
          currentSelfLogin = null
        }
      }
    },
  }
}
