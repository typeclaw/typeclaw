import { resolveAgentGit } from './resolve-agent-git'
import { editLocalConfigAtomically, localGitConfigEnv } from './resolve-identity'
import { runGit } from './run'

// Copies typeclaw.json#git.remotes into the agent repo in one transaction:
// missing remotes are added with git's default fetch refspec and changed URLs
// replaced; remotes the config does not name are kept. Host stage only, and only
// while the container is down, for the same reason as syncConfiguredGitIdentity.
// Returns the problems to warn about; an operator-set pushurl is kept but
// reported, since git pushes there instead of the configured URL.
export async function syncConfiguredGitRemotes(
  cwd: string,
  remotes: Readonly<Record<string, string>> | undefined,
): Promise<string[]> {
  if (remotes === undefined) return []
  const repo = resolveAgentGit(cwd)
  if (repo === null) return []
  const git = (args: string[]) => runGit(Bun, cwd, [...repo.gitArgs, ...args], { env: localGitConfigEnv() })
  const values = async (key: string) => {
    const result = await git(['config', '--local', '--get-all', key])
    return result.exitCode === 0 ? result.stdout.split('\n').filter((line) => line.length > 0) : []
  }

  const problems: string[] = []
  const edits: string[][] = []
  for (const [name, url] of Object.entries(remotes)) {
    const urls = await values(`remote.${name}.url`)
    const pushUrls = (await values(`remote.${name}.pushurl`)).filter((pushUrl) => pushUrl !== url)
    if (pushUrls.length > 0) {
      problems.push(
        `remote "${name}" keeps its pushurl ${pushUrls.join(', ')}, so pushes (including backups) go there instead of git.remotes.${name}`,
      )
    }
    if (urls.length === 1 && urls[0] === url) continue
    edits.push(['--replace-all', `remote.${name}.url`, url])
    if (urls.length === 0) edits.push(['--replace-all', `remote.${name}.fetch`, `+refs/heads/*:refs/remotes/${name}/*`])
  }
  if (edits.length > 0 && !(await editLocalConfigAtomically(cwd, edits))) {
    problems.unshift('could not copy typeclaw.json#git.remotes into the agent repo')
  }
  return problems
}
