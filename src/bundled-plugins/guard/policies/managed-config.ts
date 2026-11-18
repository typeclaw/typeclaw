import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import { normalizeFileReference } from '@/agent/file-reference'
import { parseConfigJson } from '@/config'
import { validateCronEdit } from '@/cron'
import { RECOVER_MISSING, realIntendedPath } from '@/path-safety/real-intended-path'

import type { GuardBlock } from '../policy'

export const GUARD_MANAGED_CONFIG = 'managedConfig'

type ManagedFile = 'typeclaw.json' | 'cron.json'

const MANAGED_FILES = new Set<ManagedFile>(['typeclaw.json', 'cron.json'])

export async function checkManagedConfigGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
}): Promise<GuardBlock | undefined> {
  const { tool, args, agentDir } = options
  if (tool !== 'write' && tool !== 'edit') return undefined

  const rawPath = args.path
  if (typeof rawPath !== 'string') return undefined

  let targetPath: string
  try {
    targetPath = path.resolve(agentDir, normalizeFileReference(rawPath))
  } catch {
    return undefined
  }
  const managed = await resolveManagedTarget(agentDir, targetPath)
  if (!managed) return undefined

  const contentResult = await intendedContent(tool, args, targetPath)
  if ('block' in contentResult) return contentResult

  const existing = await readExisting(targetPath)
  const validation = validateManagedContent(managed.file, contentResult.content, existing)
  if (validation.ok) return undefined

  return {
    block: true,
    reason: `Guard \`${GUARD_MANAGED_CONFIG}\` blocked ${tool} for ${targetPath}: ${validation.reason}.`,
  }
}

// Oracle PR #305 findings #5 and #6: identity-based managed-file
// detection. The earlier shape compared `basename(realpath(target))` to
// the managed-file list, which missed two attacks: (5) a symlink at
// agent root `typeclaw.json -> workspace/tc.json` realpathed to a name
// outside the managed list, and (6) on case-insensitive filesystems,
// `TYPECLAW.JSON` addresses the same file as `typeclaw.json` but
// basename string-equality missed the casing variant.
//
// New shape: for each managed-file name, compute the canonical agent-
// root path and compare against the target. We accept if EITHER the
// lexical paths match OR they realpath to the same file. Branch (a)
// covers symlinks and case-aliased filesystems; branch (b) keeps the
// canonical lexical name authoritative even before the file exists
// (first-init writes).
async function resolveManagedTarget(agentDir: string, targetPath: string): Promise<{ file: ManagedFile } | undefined> {
  const resolvedAgentDir = path.resolve(agentDir)
  const resolvedTarget = path.resolve(targetPath)
  for (const file of MANAGED_FILES) {
    const canonical = path.join(resolvedAgentDir, file)
    if (canonical === resolvedTarget) return { file }
    const realCanonical = await resolveRealIntendedPath(canonical)
    const realTarget = await resolveRealIntendedPath(resolvedTarget)
    if (realCanonical === realTarget) return { file }
  }
  return undefined
}

function validateManagedContent(
  file: ManagedFile,
  content: string,
  existing: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (file === 'typeclaw.json') {
    const result = parseConfigJson(content, { migrate: false })
    return result.ok ? { ok: true } : { ok: false, reason: result.reason }
  }
  // Delta validation: a stale `at`/`until` on a job carried over unchanged from
  // the existing file must not block the edit (esp. an edit that removes it),
  // but a newly-added or re-timed past job is still rejected. See validateCronEdit.
  const result = validateCronEdit(content, existing)
  return result.ok ? { ok: true } : { ok: false, reason: result.reason }
}

async function readExisting(targetPath: string): Promise<string | undefined> {
  try {
    return await readFile(targetPath, 'utf8')
  } catch {
    return undefined
  }
}

async function intendedContent(
  tool: string,
  args: Record<string, unknown>,
  targetPath: string,
): Promise<{ content: string } | GuardBlock> {
  if (tool === 'write') {
    const content = args.content
    if (typeof content !== 'string') {
      return blockReason(tool, targetPath, 'write content must be a string')
    }
    return { content }
  }

  const edits = args.edits
  if (!Array.isArray(edits)) {
    return blockReason(tool, targetPath, 'edit calls must include an edits array')
  }

  // Oracle PR #305 finding #4: refuse multi-edit on managed files to
  // avoid simulator-vs-pi divergence. The canonical workflow for
  // typeclaw.json / cron.json is read + modify in memory + write the
  // whole file back; multi-edit is not required and the divergence
  // would let an attacker validate a different final file here than
  // the one pi actually writes.
  if (edits.length > 1) {
    return blockReason(
      tool,
      targetPath,
      'multi-edit calls on managed files are refused — use `write` with full content instead',
    )
  }

  let content: string
  try {
    content = await readFile(targetPath, 'utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return blockReason(tool, targetPath, `could not read existing file before edit: ${message}`)
  }

  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') {
      return blockReason(tool, targetPath, 'each edit must be an object')
    }
    const { oldText, newText } = edit as Record<string, unknown>
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      return blockReason(tool, targetPath, 'each edit must include string oldText and newText')
    }
    if (oldText.length === 0) {
      return blockReason(tool, targetPath, 'edit oldText must not be empty')
    }
    const firstIdx = content.indexOf(oldText)
    if (firstIdx === -1) {
      return blockReason(tool, targetPath, 'edit oldText was not found in existing file')
    }
    if (content.indexOf(oldText, firstIdx + 1) !== -1) {
      return blockReason(tool, targetPath, 'edit oldText is not unique in the existing file')
    }
    content = content.slice(0, firstIdx) + newText + content.slice(firstIdx + oldText.length)
  }
  return { content }
}

function blockReason(tool: string, targetPath: string, reason: string): GuardBlock {
  return {
    block: true,
    reason: `Guard \`${GUARD_MANAGED_CONFIG}\` blocked ${tool} for ${targetPath}: ${reason}.`,
  }
}

// RECOVER_MISSING only: this policy decides whether a write is ALLOWED, so an
// ancestor that cannot be resolved must never widen the permitted surface.
async function resolveRealIntendedPath(absolutePath: string): Promise<string> {
  return await realIntendedPath(absolutePath, realpath, {
    recoverable: RECOVER_MISSING,
    onExhausted: 'throw',
  })
}
