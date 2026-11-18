import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { parseConfigJson } from '@/config'

import type { SecurityBlock } from '../policy'
import { intendedContent, pathIsTypeclawJson, refuseRiskyEdit } from './plugin-addition'

export const GUARD_GIT_REMOTES_CONFIG = 'gitRemotesConfig'
// typeclaw.json#git.remotes is copied into the agent repo by the next
// `typeclaw start`, and the backup plugin then pushes the agent's history to
// `origin` as the runtime, not as the session that edited the config. Adding a
// remote or changing its URL is therefore the config form of `git remote
// set-url` followed by a push, so it needs the same authority the bash path
// needs for that push: `security.bypass.gitRemoteTainted` (high tier, owner by
// default). Removing a remote only narrows where history can go and is allowed.
export type GitRemotesFinding =
  | { kind: 'remote-added'; name: string; url: string }
  | { kind: 'url-changed'; name: string; from: string; to: string }

export async function checkGitRemotesConfigGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
}): Promise<SecurityBlock | undefined> {
  const { tool, args, agentDir } = options
  if (tool !== 'write' && tool !== 'edit') return undefined

  const rawPath = args.path
  if (typeof rawPath !== 'string') return undefined

  const targetPath = path.resolve(agentDir, rawPath)
  if (!(await pathIsTypeclawJson(agentDir, targetPath))) return undefined

  const editRefusal = refuseRiskyEdit(tool, args, targetPath, GUARD_GIT_REMOTES_CONFIG)
  if (editRefusal) return editRefusal

  const newContent = await intendedContent(tool, args, targetPath)
  if (newContent === undefined) return undefined
  const after = parseRemotes(newContent)
  if (after === undefined) return undefined

  const before = parseRemotes(await readFile(targetPath, 'utf8').catch(() => '')) ?? {}
  const findings = diffRemotes(before, after)
  if (findings.length === 0) return undefined
  return { block: true, reason: buildBlockReason(tool, findings) }
}

export function diffRemotes(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): GitRemotesFinding[] {
  const findings: GitRemotesFinding[] = []
  for (const [name, url] of Object.entries(after)) {
    const prior = before[name]
    if (prior === undefined) findings.push({ kind: 'remote-added', name, url })
    else if (prior !== url) findings.push({ kind: 'url-changed', name, from: prior, to: url })
  }
  return findings
}

function parseRemotes(content: string): Record<string, string> | undefined {
  const result = parseConfigJson(content, { migrate: false })
  if (!result.ok) return undefined
  return result.config.git.remotes ?? {}
}

function buildBlockReason(tool: string, findings: readonly GitRemotesFinding[]): string {
  const changes = findings.map((f) =>
    f.kind === 'remote-added'
      ? `new remote \`${f.name}\` -> ${JSON.stringify(f.url)}`
      : `remote \`${f.name}\` changes ${JSON.stringify(f.from)} -> ${JSON.stringify(f.to)}`,
  )
  return [
    `Guard \`${GUARD_GIT_REMOTES_CONFIG}\` blocked ${tool} on typeclaw.json: ${changes.join('; ')}.`,
    'The next `typeclaw start` copies git.remotes into the agent repo, and the backup plugin pushes its history to `origin`, so this decides where the repository is sent.',
    'Only a session holding `security.bypass.gitRemoteTainted` (owner by default, e.g. the TUI) may add or re-point a remote; the operator can also edit typeclaw.json on the host. Removing a remote is allowed.',
  ].join(' ')
}
