import { basename } from 'node:path'

import { resolveAgentGit } from './resolve-agent-git'
import { runGit } from './run'

export type GitIdentity = { name: string; email: string }

const GIT_CONFIG_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
} as const

// Records the identity ensureGitIdentity synthesized, so only that exact
// identity is treated as a fallback; a configured one that happens to match the
// folder name is not.
const FALLBACK_MARKER_KEY = 'typeclaw.fallbackidentity'

const GIT_REPOSITORY_ENV_NAMES = new Set([
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
])

export async function resolveGitIdentity(cwd: string): Promise<GitIdentity | null> {
  const repo = resolveAgentGit(cwd)
  if (repo === null) return null

  const values = await readRepositoryIdentity(cwd, repo.gitArgs)
  const name = values.get('user.name')?.at(-1)?.trim() || null
  const email = values.get('user.email')?.at(-1)?.trim() || null
  return name !== null && email !== null ? { name, email } : null
}

// Commits by the runtime (backup, dreaming, system files) need an identity, and
// repository-local config is lost on clone or by hand edits. Fill only the
// missing keys from the agent folder name; an identity the user set is kept.
export async function ensureGitIdentity(cwd: string): Promise<GitIdentity | null> {
  const repo = resolveAgentGit(cwd)
  if (repo === null) return null

  const values = await readRepositoryIdentity(cwd, repo.gitArgs)
  const fallback = fallbackGitIdentity(cwd)
  const name = values.get('user.name')?.at(-1)?.trim() || null
  const email = values.get('user.email')?.at(-1)?.trim() || null
  if (name !== null && email !== null) return { name, email }

  const identity = { name: name ?? fallback.name, email: email ?? fallback.email }
  if (name === null && !(await writeLocalConfig(cwd, repo.gitArgs, 'user.name', identity.name))) return null
  if (email === null && !(await writeLocalConfig(cwd, repo.gitArgs, 'user.email', identity.email))) return null
  await writeLocalConfig(cwd, repo.gitArgs, FALLBACK_MARKER_KEY, formatIdentity(identity))
  return identity
}

// GitHub credits a commit to an account, App bots included, by its noreply email.
export function githubGitIdentity(self: { login: string; id: number }): GitIdentity {
  return { name: self.login, email: `${self.id}+${self.login}@users.noreply.github.com` }
}

const GIT_IDENTITY_ENV = [
  ['GIT_AUTHOR_NAME', 'name'],
  ['GIT_AUTHOR_EMAIL', 'email'],
  ['GIT_COMMITTER_NAME', 'name'],
  ['GIT_COMMITTER_EMAIL', 'email'],
] as const

// Runtime commits (backup, dreaming, system files) inherit the runtime env, which
// `typeclaw start` seeds with the repo identity. While the GitHub adapter runs,
// its account replaces that seed; when it stops, the seed comes back. Names the
// operator declared in .env are left alone, matching model bash.
export function trackGithubGitIdentityEnv(
  operatorNames: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): (self: { login: string; id: number } | null) => void {
  const seed = Object.fromEntries(GIT_IDENTITY_ENV.map(([name]) => [name, env[name]]))
  return (self) => {
    const identity = self === null ? null : githubGitIdentity(self)
    for (const [name, field] of GIT_IDENTITY_ENV) {
      if (operatorNames.has(name)) continue
      const value = identity === null ? seed[name] : identity[field]
      if (value === undefined) delete env[name]
      else env[name] = value
    }
  }
}

// GIT_* env overrides repo config, so forwarding the fallback would freeze it
// over an identity the operator sets while the container runs.
export async function isFallbackGitIdentity(cwd: string, identity: GitIdentity): Promise<boolean> {
  const repo = resolveAgentGit(cwd)
  if (repo === null) return false
  const marker = (await readRepositoryIdentity(cwd, repo.gitArgs)).get(FALLBACK_MARKER_KEY)?.at(-1)
  return marker === formatIdentity(identity)
}

function formatIdentity(identity: GitIdentity): string {
  return `${identity.name} <${identity.email}>`
}

function fallbackGitIdentity(cwd: string): GitIdentity {
  const folder = basename(cwd).trim()
  const slug = folder
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return { name: folder || 'agent', email: `${slug || 'agent'}@typeclaw.local` }
}

async function writeLocalConfig(cwd: string, gitArgs: readonly string[], key: string, value: string): Promise<boolean> {
  try {
    const result = await runGit(Bun, cwd, [...gitArgs, 'config', '--local', key, value], {
      env: { ...withoutGitOverrides(process.env), ...GIT_CONFIG_ENV },
    })
    return result.exitCode === 0
  } catch {
    return false
  }
}

async function readRepositoryIdentity(cwd: string, gitArgs: readonly string[]): Promise<Map<string, string[]>> {
  try {
    const result = await runGit(
      Bun,
      cwd,
      [...gitArgs, 'config', '--null', '--get-regexp', '^(user\\.(name|email)|typeclaw\\.fallbackidentity)$'],
      {
        env: { ...withoutGitOverrides(process.env), ...GIT_CONFIG_ENV },
      },
    )
    if (result.exitCode !== 0) return new Map()
    return parseNullConfigEntries(result.stdout)
  } catch {
    return new Map()
  }
}

function parseNullConfigEntries(output: string): Map<string, string[]> {
  const values = new Map<string, string[]>()
  for (const entry of output.split('\0')) {
    if (entry.length === 0) continue
    const separator = entry.indexOf('\n')
    if (separator < 0) continue
    const key = entry.slice(0, separator)
    const value = entry.slice(separator + 1)
    const existing = values.get(key)
    if (existing === undefined) values.set(key, [value])
    else existing.push(value)
  }
  return values
}

function withoutGitOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => {
      const normalized = name.toUpperCase()
      return !normalized.startsWith('GIT_CONFIG') && !GIT_REPOSITORY_ENV_NAMES.has(normalized)
    }),
  )
}

export const _internal = { withoutGitOverrides }
