export type GhTokenClass = 'cross-owner' | 'fine-grained-pat' | 'app' | 'none'

// The PAT `gh`/`git` would actually use from the process env, following gh's own
// precedence (`GH_TOKEN` over `GITHUB_TOKEN`). git has no native support for
// either, but the plugin's askpass path injects this value, so both CLIs end up
// honoring the same token. Used everywhere a process-env credential is
// classified or checked for presence so a `GITHUB_TOKEN`-only env is not misread
// as "no auth".
export function effectiveProcessPat(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const ghToken = env.GH_TOKEN
  if (ghToken !== undefined && ghToken !== '') return ghToken
  const githubToken = env.GITHUB_TOKEN
  if (githubToken !== undefined && githubToken !== '') return githubToken
  return undefined
}

export function classifyGhToken(token: string | undefined): GhTokenClass {
  if (token === undefined || token === '') return 'none'
  if (token.startsWith('ghp_')) return 'cross-owner'
  if (token.startsWith('github_pat_')) return 'fine-grained-pat'
  if (token.startsWith('ghs_')) return 'app'
  // Unknown/legacy formats: treat as App so a repo-targeting call still resolves
  // a per-repo token rather than silently using a possibly-wrong global one.
  return 'app'
}

// Whether the per-repo App minter should fire for a repo-targeting command.
// App auth is detected via EITHER a seeded App-class GH_TOKEN OR a live App
// token resolver — the latter is the authority because multi-owner / no-repos
// App configs intentionally leave GH_TOKEN unseeded (the prefix would read
// 'none'), yet the per-repo minter is still registered and able to mint. Classic
// and fine-grained PATs are never re-minted: they pass through with whatever
// GH_TOKEN is seeded, exactly as before.
export function shouldMintAppToken(token: string | undefined, hasAppTokenResolver: boolean): boolean {
  const tokenClass = classifyGhToken(token)
  if (tokenClass === 'cross-owner' || tokenClass === 'fine-grained-pat') return false
  return tokenClass === 'app' || hasAppTokenResolver
}
