export type GitRemoteResolver = (cwd: string, remote: string, forPush: boolean) => Promise<string | null>

export type GitResolvers = {
  resolveRemoteUrl: GitRemoteResolver
}

async function runGit(cwd: string, args: string[]): Promise<string | null> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) return null
  try {
    const proc = bun.spawn({
      cmd: ['git', '-C', cwd, ...args],
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
    const exitCode = await proc.exited
    if (exitCode !== 0) return null
    const out = (await new Response(proc.stdout).text()).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

export const defaultGitResolvers: GitResolvers = {
  resolveRemoteUrl: (cwd, remote, forPush) =>
    runGit(cwd, forPush ? ['remote', 'get-url', '--push', remote] : ['remote', 'get-url', remote]),
}

export async function resolveGhDefaultRepoFromCwd(cwd: string, resolvers: GitResolvers): Promise<string | null> {
  const url = await resolvers.resolveRemoteUrl(cwd, 'origin', false)
  if (url === null) return null
  return parseGithubRepoFromGitUrl(url)
}

const HTTPS_GITHUB_RE = /^https:\/\/github\.com\/([^/\s:@]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i
const SCP_GITHUB_RE = /^git@github\.com:([^/\s:?#]+)\/([^/\s?#]+?)(?:\.git)?$/i
const SSH_GITHUB_RE = /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i

export function parseGithubRepoFromGitUrl(raw: string): string | null {
  const url = raw.trim()
  for (const re of [HTTPS_GITHUB_RE, SCP_GITHUB_RE, SSH_GITHUB_RE]) {
    const match = url.match(re)
    if (match === null) continue
    const owner = match[1]
    const name = match[2]
    if (owner === undefined || name === undefined || owner === '' || name === '') return null
    return `${owner}/${name}`
  }
  return null
}
