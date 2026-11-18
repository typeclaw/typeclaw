import { resolveAgentGit } from './resolve-agent-git'
import { editLocalConfigAtomically, localGitConfigEnv } from './resolve-identity'
import { runGit } from './run'

// Copies typeclaw.json#git.remotes into the agent repo in one transaction:
// missing remotes are added with git's default fetch refspec and changed URLs
// replaced; remotes the config does not name are kept. Host stage only, and only
// while the container is down, for the same reason as syncConfiguredGitIdentity.
// Returns the problems to warn about. Operator push overrides (a pushurl,
// pushInsteadOf, or either from an included file) are kept, so each remote's
// effective push destination is checked afterwards. Messages never include a
// URL, since push URLs can carry credentials.
export async function syncConfiguredGitRemotes(
  cwd: string,
  remotes: Readonly<Record<string, string>> | undefined,
): Promise<string[]> {
  if (remotes === undefined) return []
  const repo = resolveAgentGit(cwd)
  if (repo === null) return []
  const git = (args: string[]) => runGit(Bun, cwd, [...repo.gitArgs, ...args], { env: localGitConfigEnv() })
  const lines = (stdout: string) => stdout.split('\n').filter((line) => line.length > 0)

  const edits: string[][] = []
  for (const [name, url] of Object.entries(remotes)) {
    const current = await git(['config', '--local', '--get-all', `remote.${name}.url`])
    const urls = current.exitCode === 0 ? lines(current.stdout) : []
    if (urls.length === 1 && urls[0] === url) continue
    edits.push(['--replace-all', `remote.${name}.url`, url])
    if (urls.length === 0) edits.push(['--replace-all', `remote.${name}.fetch`, `+refs/heads/*:refs/remotes/${name}/*`])
  }
  if (edits.length > 0 && !(await editLocalConfigAtomically(cwd, edits))) {
    return ['could not copy typeclaw.json#git.remotes into the agent repo']
  }

  const problems: string[] = []
  for (const [name, url] of Object.entries(remotes)) {
    const push = await git(['remote', 'get-url', '--push', name])
    if (push.exitCode === 0 && lines(push.stdout).every((pushUrl) => pushUrl === url)) continue
    problems.push(
      `remote "${name}" pushes somewhere other than git.remotes.${name} because a pushurl or URL rewrite overrides it, so pushes (including backups) do not go to the configured URL`,
    )
  }
  return problems
}
