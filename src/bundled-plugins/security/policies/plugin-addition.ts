import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import { normalizeFileReference } from '@/agent/file-reference'
import { parseConfigJson } from '@/config'
import { readConfigBaseline } from '@/config/config-commits'
import { splitPluginEntrySpec } from '@/plugin'

import type { SecuritySeverity } from '../permissions'
import type { SecurityBlock } from '../policy'

export const GUARD_PLUGIN_ADDITION = 'pluginAddition'
// Classified `medium` (silent-attack axis), same tier and rationale as
// `rolePromotion` and `cronPromotion`. Adding (or version-bumping) a plugin in
// typeclaw.json is a deferred host-code-execution grant: the entry is
// materialized into package.json by `reconcilePluginDeps` and installed by the
// next host `typeclaw start`, at which point npm lifecycle scripts run as the
// operator on the host. `plugins` is restart-required and typeclaw.json is
// force-committed by auto-backup, so the operator sees the change in `git log`
// and backup commits BEFORE any install fires — an operator-reviewable window
// between the privileged write and the privileged execution. Owner and trusted
// bypass without ack; member and guest are blocked.
//
// What counts as a plugin addition (any of):
//   1. A new entry appeared in `plugins[]` (by package name).
//   2. An existing entry's pinned version spec changed (`foo@1` -> `foo@2`):
//      a different package version is a different body of host code, the same
//      shape as cron's body-changed finding.
//
// What does NOT count (allowed without ack):
//   - Removing an entry from `plugins[]` (a privilege REDUCTION; uninstalling
//     runs no untrusted code).
//   - Reordering entries.
//   - Local-path entries (`./`, `../`, absolute): these are never installed
//     from a registry, so there is no lifecycle-script execution to gate. They
//     are confined to the agent dir by the loader.
//
// Failure-open is deliberate, same direction as the sibling guards: an
// unreadable/unparseable existing typeclaw.json makes every proposed entry look
// new and blocks. The only false positive is an operator authoring a fresh
// config with plugins, which they ack in the same call.
export const GUARD_PLUGIN_ADDITION_SEVERITY: SecuritySeverity = 'medium'

export type PluginAdditionFinding =
  | { kind: 'plugin-added'; name: string; versionSpec: string }
  | { kind: 'version-changed'; name: string; from: string; to: string }

export async function checkPluginAdditionGuard(options: {
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

  const editRefusal = refuseRiskyEdit(tool, args, targetPath)
  if (editRefusal) return editRefusal

  const newContent = await intendedContent(tool, args, targetPath)
  if (newContent === undefined) return undefined

  const newPlugins = parsePluginsFromContent(newContent)
  if (newPlugins === undefined) return undefined

  const oldPlugins = await readExistingPlugins(targetPath)
  const findings = diffPlugins(oldPlugins, newPlugins)
  if (findings.length === 0) return undefined

  return {
    block: true,
    reason: buildBlockReason(tool, targetPath, findings),
  }
}

export function diffPlugins(before: readonly string[], after: readonly string[]): PluginAdditionFinding[] {
  const findings: PluginAdditionFinding[] = []
  const beforeByName = new Map<string, string | undefined>()
  for (const entry of before) {
    if (isLocalEntry(entry)) continue
    const { name, versionSpec } = splitPluginEntrySpec(entry)
    beforeByName.set(name, versionSpec)
  }

  for (const entry of after) {
    if (isLocalEntry(entry)) continue
    const { name, versionSpec } = splitPluginEntrySpec(entry)
    if (!beforeByName.has(name)) {
      findings.push({ kind: 'plugin-added', name, versionSpec: versionSpec ?? '<latest>' })
      continue
    }
    const priorSpec = beforeByName.get(name)
    if (priorSpec !== versionSpec) {
      findings.push({
        kind: 'version-changed',
        name,
        from: priorSpec ?? '<latest>',
        to: versionSpec ?? '<latest>',
      })
    }
  }
  return findings
}

function isLocalEntry(entry: string): boolean {
  return entry.startsWith('./') || entry.startsWith('../') || path.isAbsolute(entry)
}

function parsePluginsFromContent(content: string): readonly string[] | undefined {
  const result = parseConfigJson(content, { migrate: false })
  if (!result.ok) return undefined
  return result.config.plugins ?? []
}

async function readExistingPlugins(targetPath: string): Promise<readonly string[]> {
  let raw: string
  try {
    raw = await readConfigBaseline(targetPath)
  } catch {
    return []
  }
  const result = parseConfigJson(raw, { migrate: false })
  if (!result.ok) return []
  return result.config.plugins ?? []
}

// See the parallel rationale block in role-promotion.ts — Oracle PR #305
// findings #5 and #6 (symlinked managed file + case-insensitive FS).
// Resolves a write/edit `path` the way the file tools do before opening it,
// including `file:` URIs, so a managed-config guard decides on the destination
// actually written. An undecodable URI is refused by the tool itself.
export function resolveToolTarget(agentDir: string, rawPath: string): string | undefined {
  try {
    return path.resolve(agentDir, normalizeFileReference(rawPath))
  } catch {
    return undefined
  }
}

export async function pathIsTypeclawJson(agentDir: string, targetPath: string): Promise<boolean> {
  const resolvedAgentDir = path.resolve(agentDir)
  const canonicalManagedPath = path.join(resolvedAgentDir, 'typeclaw.json')
  const resolvedTarget = path.resolve(targetPath)
  if (canonicalManagedPath === resolvedTarget) return true
  const realCanonical = await resolveRealPath(canonicalManagedPath)
  const realTarget = await resolveRealPath(resolvedTarget)
  return realCanonical === realTarget
}

// Symmetric with role/cron-promotion's refuseRiskyEdit. See Oracle PR #305
// finding #4: simulator-vs-real divergence on multi-edit, plus non-unique
// oldText ambiguity. Conservative refusal keeps the guard honest without
// re-implementing the edit-diff semantics inside the security plugin.
export function refuseRiskyEdit(
  tool: string,
  args: Record<string, unknown>,
  targetPath: string,
  guard: string = GUARD_PLUGIN_ADDITION,
): SecurityBlock | undefined {
  if (tool !== 'edit') return undefined
  const edits = args.edits
  if (!Array.isArray(edits)) return undefined
  if (edits.length > 1) {
    return {
      block: true,
      reason: [
        `Guard \`${guard}\` refuses multi-edit on ${targetPath}: the security guard's edit simulator cannot match the pi-coding-agent edit tool's original-content semantics for multi-edit calls.`,
        'Use `write` with the full file content instead — this is the canonical workflow for managed config files.',
      ].join(' '),
    }
  }
  return undefined
}

export async function intendedContent(
  tool: string,
  args: Record<string, unknown>,
  targetPath: string,
): Promise<string | undefined> {
  if (tool === 'write') {
    return typeof args.content === 'string' ? args.content : undefined
  }
  const edits = args.edits
  if (!Array.isArray(edits)) return undefined
  let content: string
  try {
    content = await readFile(targetPath, 'utf8')
  } catch {
    return undefined
  }
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') return undefined
    const { oldText, newText } = edit as Record<string, unknown>
    if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
    if (oldText.length === 0) return undefined
    const firstIdx = content.indexOf(oldText)
    if (firstIdx === -1) return undefined
    if (content.indexOf(oldText, firstIdx + 1) !== -1) return undefined
    content = content.slice(0, firstIdx) + newText + content.slice(firstIdx + oldText.length)
  }
  return content
}

function buildBlockReason(tool: string, targetPath: string, findings: readonly PluginAdditionFinding[]): string {
  const lines: string[] = []
  for (const f of findings) {
    const name = sanitizeForReason(f.name)
    if (f.kind === 'plugin-added') {
      lines.push(`new plugin \`${name}\` (${sanitizeForReason(f.versionSpec)}) would be installed on the host`)
    } else {
      lines.push(
        `plugin \`${name}\` version changes \`${sanitizeForReason(f.from)}\` -> \`${sanitizeForReason(f.to)}\``,
      )
    }
  }
  return [
    `Guard \`${GUARD_PLUGIN_ADDITION}\` blocked ${tool} on ${sanitizeForReason(targetPath)}: this change introduces a deferred host-code-execution grant — ${lines.join('; ')}.`,
    "Plugin entries in typeclaw.json#plugins are materialized into package.json and installed by the next host `typeclaw start`, where npm lifecycle scripts run as the operator on the host. Even an `owner` operating from TUI must not silently add plugins on behalf of a channel message: the canonical attack is a prompt-injected agent writing a malicious package name into plugins[] so the operator's next start runs its postinstall.",
    'This cannot be acknowledged away from an under-privileged session. The operator must make the change from a session that already resolves to `owner`/`trusted` (TUI, or a role granted `security.bypass.medium`), or claim the role out-of-band via `typeclaw role claim`.',
  ].join(' ')
}

const MAX_REASON_TOKEN_LEN = 200

function sanitizeForReason(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/`/g, "'")
  if (cleaned.length <= MAX_REASON_TOKEN_LEN) return cleaned
  return `${cleaned.slice(0, MAX_REASON_TOKEN_LEN)}...`
}

async function resolveRealPath(absolutePath: string): Promise<string> {
  const pending: string[] = []
  let current = absolutePath
  while (true) {
    try {
      const real = await realpath(current)
      return path.join(real, ...pending.reverse())
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    const parent = path.dirname(current)
    if (parent === current) return absolutePath
    pending.push(path.basename(current))
    current = parent
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as { code: unknown }).code === 'ENOENT'
}
