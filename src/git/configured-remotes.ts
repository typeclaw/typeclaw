import { resolveAgentGit } from './resolve-agent-git'
import { editLocalConfigAtomically, localGitConfigEnv } from './resolve-identity'
import { runGit } from './run'

// Copies typeclaw.json#git.remotes into the agent repo in one transaction:
// missing remotes are added with git's default fetch refspec and changed URLs
// replaced; remotes the config does not name are kept. Host stage only, and only
// while the container is down, for the same reason as syncConfiguredGitIdentity.
// `failed` means the repo still holds the previous remotes, so start must not
// launch a backup that would push there. Operator push overrides (a pushurl,
// pushInsteadOf, or either from an included file) are kept, so each remote's
// effective push destination, and the remote backups actually push to, are
// checked afterwards and reported as warnings. Messages never include a URL,
// since push URLs can carry credentials. The check reads the agent repo's own
// config only (global/system config and GIT_CONFIG_* overrides are off, as for
// the write); Git overrides the operator puts in the container's environment
// through .env are not visible here and can still redirect backups.
export type GitRemotesSync = { failed?: string; warnings: string[] }

export async function syncConfiguredGitRemotes(
  cwd: string,
  remotes: Readonly<Record<string, string>> | undefined,
): Promise<GitRemotesSync> {
  if (remotes === undefined) return { warnings: [] }
  const repo = resolveAgentGit(cwd)
  if (repo === null) return { warnings: [] }
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
    return { failed: 'could not copy typeclaw.json#git.remotes into the agent repo', warnings: [] }
  }

  const problems: string[] = []
  for (const [name, url] of Object.entries(remotes)) {
    const push = await git(['remote', 'get-url', '--push', '--all', name])
    if (push.exitCode === 0 && lines(push.stdout).every((pushUrl) => pushUrl === url)) continue
    problems.push(
      `remote "${name}" pushes somewhere other than git.remotes.${name} because a pushurl or URL rewrite overrides it, so pushes (including backups) do not go to the configured URL`,
    )
  }
  if (Object.hasOwn(remotes, 'origin')) {
    const pushRemote = await backupPushRemote(git)
    if (pushRemote !== null && pushRemote.remote !== 'origin') {
      // A routing value that is not a configured remote is used as a URL, which
      // can carry credentials, so only a verified remote name is printed.
      const known = lines((await git(['remote'])).stdout).includes(pushRemote.remote)
      const target = known ? `remote "${pushRemote.remote}"` : 'a destination that is not a configured remote'
      problems.push(
        `backups on branch "${pushRemote.branch}" push to ${target} (set by ${pushRemote.key}), not to git.remotes.origin`,
      )
    }
  }
  return { warnings: problems }
}

// Mirrors the backup runner: a branch with an upstream (branch.<name>.remote
// and .merge) is pushed with a bare `git push`, which goes to
// branch.<name>.pushRemote, then remote.pushDefault, then the upstream's remote;
// a branch with no upstream is pushed to origin by name, so routing keys do not
// apply to it.
async function backupPushRemote(
  git: (args: string[]) => ReturnType<typeof runGit>,
): Promise<{ branch: string; remote: string; key: string } | null> {
  const head = await git(['symbolic-ref', '--short', '-q', 'HEAD'])
  const branch = head.exitCode === 0 ? head.stdout.trim() : ''
  if (branch.length === 0) return null
  const tracked = await Promise.all(
    ['remote', 'merge'].map(
      async (field) => (await git(['config', '--get', `branch.${branch}.${field}`])).exitCode === 0,
    ),
  )
  if (!tracked.every(Boolean)) return { branch, remote: 'origin', key: 'the default' }
  for (const key of [`branch.${branch}.pushRemote`, 'remote.pushDefault', `branch.${branch}.remote`]) {
    const value = await git(['config', '--get', key])
    if (value.exitCode === 0 && value.stdout.trim().length > 0) return { branch, remote: value.stdout.trim(), key }
  }
  return { branch, remote: 'origin', key: 'the default' }
}
