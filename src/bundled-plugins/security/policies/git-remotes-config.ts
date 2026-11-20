import { parseConfigJson } from '@/config'
import { readConfigBaseline } from '@/config/config-commits'

import type { SecurityBlock } from '../policy'
import { intendedContent, pathIsTypeclawJson, refuseRiskyEdit, resolveToolTarget } from './plugin-addition'

export const GUARD_GIT_REMOTES_CONFIG = 'gitRemotesConfig'
// typeclaw.json#git.remotes is copied into the agent repo by the next
// `typeclaw start`, and the backup plugin then pushes the agent's history to
// `origin` as the runtime, not as the session that edited the config. Adding a
// remote or changing its URL is therefore the config form of `git remote
// set-url` followed by a push, so it needs the same authority the bash path
// needs for that push: `security.bypass.gitRemoteTainted` (high tier, owner by
// default). Removing a managed remote needs the same authority: start only
// reconciles remotes still listed, so a removal can cancel an owner's pending
// retarget and leave the old destination in place.
export type GitRemotesFinding =
  | { kind: 'remote-added'; name: string; url: string }
  | { kind: 'url-changed'; name: string; from: string; to: string }
  | { kind: 'remote-removed'; name: string }

export async function checkGitRemotesConfigGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
}): Promise<SecurityBlock | undefined> {
  const { tool, args, agentDir } = options
  if (tool !== 'write' && tool !== 'edit') return undefined

  const rawPath = args.path
  if (typeof rawPath !== 'string') return undefined

  const targetPath = resolveToolTarget(agentDir, rawPath)
  if (targetPath === undefined || !(await pathIsTypeclawJson(agentDir, targetPath))) return undefined

  const editRefusal = refuseRiskyEdit(tool, args, targetPath, GUARD_GIT_REMOTES_CONFIG)
  if (editRefusal) return editRefusal

  // Fail closed: the editor can apply an edit this preview cannot reproduce, so
  // an edit of typeclaw.json the guard cannot evaluate is not let through.
  const newContent = await intendedContent(tool, args, targetPath)
  if (newContent === undefined) {
    return {
      block: true,
      reason: `Guard \`${GUARD_GIT_REMOTES_CONFIG}\` cannot preview this ${tool} of typeclaw.json, so it cannot rule out a git.remotes change. Use \`write\` with the full file content instead.`,
    }
  }
  const after = parseRemotes(newContent)
  if (after === undefined) return undefined

  const before = parseRemotes(await readConfigBaseline(targetPath).catch(() => '')) ?? {}
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
    // Own properties only: a remote may be named like an Object.prototype member.
    const prior = Object.hasOwn(before, name) ? before[name] : undefined
    if (prior === undefined) findings.push({ kind: 'remote-added', name, url })
    else if (prior !== url) findings.push({ kind: 'url-changed', name, from: prior, to: url })
  }
  for (const name of Object.keys(before)) {
    if (!Object.hasOwn(after, name)) findings.push({ kind: 'remote-removed', name })
  }
  return findings
}

function parseRemotes(content: string): Record<string, string> | undefined {
  const result = parseConfigJson(content, { migrate: false })
  if (!result.ok) return undefined
  return result.config.git.remotes ?? {}
}

function buildBlockReason(tool: string, findings: readonly GitRemotesFinding[]): string {
  // Names only: remote URLs can carry credentials, and this reason is returned
  // to the session as a tool error.
  const changes = findings.map((f) =>
    f.kind === 'remote-added'
      ? `adds remote \`${f.name}\``
      : f.kind === 'remote-removed'
        ? `removes remote \`${f.name}\``
        : `changes the URL of remote \`${f.name}\``,
  )
  return [
    `Guard \`${GUARD_GIT_REMOTES_CONFIG}\` blocked ${tool} on typeclaw.json: ${changes.join('; ')}.`,
    'The next `typeclaw start` copies git.remotes into the agent repo, and the backup plugin pushes its history to `origin`, so this decides where the repository is sent.',
    'Only a session holding `security.bypass.gitRemoteTainted` (owner by default, e.g. the TUI) may add, re-point, or remove a remote; the operator can also edit typeclaw.json on the host.',
  ].join(' ')
}
