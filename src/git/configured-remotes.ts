import { resolveAgentGit } from './resolve-agent-git'
import { localGitConfigEnv } from './resolve-identity'
import { runGit } from './run'

// Copies typeclaw.json#git.remotes into the agent repo: missing remotes are
// added and changed URLs replaced; remotes the config does not name are kept.
// Host stage only, and only while the container is down, for the same reason as
// syncConfiguredGitIdentity: git renames config.lock over .git/config, which
// would detach the read-only bind of any sandbox still running.
export async function syncConfiguredGitRemotes(
  cwd: string,
  remotes: Readonly<Record<string, string>> | undefined,
): Promise<boolean> {
  if (remotes === undefined) return true
  const repo = resolveAgentGit(cwd)
  if (repo === null) return true
  const git = (args: string[]) => runGit(Bun, cwd, [...repo.gitArgs, ...args], { env: localGitConfigEnv() })

  let synced = true
  for (const [name, url] of Object.entries(remotes)) {
    const current = await git(['config', '--local', '--get-all', `remote.${name}.url`])
    const urls = current.exitCode === 0 ? current.stdout.split('\n').filter((line) => line.length > 0) : []
    if (urls.length === 1 && urls[0] === url) continue
    const result =
      urls.length === 0
        ? await git(['remote', 'add', name, url])
        : await git(['config', '--local', '--replace-all', `remote.${name}.url`, url])
    if (result.exitCode !== 0) synced = false
  }
  return synced
}
