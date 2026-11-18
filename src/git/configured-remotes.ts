import { resolveAgentGit } from './resolve-agent-git'
import { editLocalConfigAtomically, localGitConfigEnv } from './resolve-identity'
import { runGit } from './run'

// Copies typeclaw.json#git.remotes into the agent repo in one transaction:
// missing remotes are added with git's default fetch refspec and changed URLs
// replaced; remotes the config does not name are kept. Host stage only, and only
// while the container is down, for the same reason as syncConfiguredGitIdentity.
export async function syncConfiguredGitRemotes(
  cwd: string,
  remotes: Readonly<Record<string, string>> | undefined,
): Promise<boolean> {
  if (remotes === undefined) return true
  const repo = resolveAgentGit(cwd)
  if (repo === null) return true
  const git = (args: string[]) => runGit(Bun, cwd, [...repo.gitArgs, ...args], { env: localGitConfigEnv() })

  const edits: string[][] = []
  for (const [name, url] of Object.entries(remotes)) {
    const current = await git(['config', '--local', '--get-all', `remote.${name}.url`])
    const urls = current.exitCode === 0 ? current.stdout.split('\n').filter((line) => line.length > 0) : []
    if (urls.length === 1 && urls[0] === url) continue
    edits.push(['--replace-all', `remote.${name}.url`, url])
    if (urls.length === 0) edits.push(['--replace-all', `remote.${name}.fetch`, `+refs/heads/*:refs/remotes/${name}/*`])
  }
  return edits.length === 0 || (await editLocalConfigAtomically(cwd, edits))
}
