import { realpath } from 'node:fs/promises'
import path from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import { RECOVER_MISSING, realIntendedPath } from '@/path-safety/real-intended-path'

import { GUARD_NON_WORKSPACE_WRITE } from '../keys'
import { ACKNOWLEDGE_GUARDS, type GuardBlock, isGuardAcknowledged } from '../policy'
import { isMemoryTopicsWriteAllowed } from './memory-topics-write'
import { isSkillAuthoringAllowed } from './skill-authoring'

export { GUARD_NON_WORKSPACE_WRITE } from '../keys'

const AGENT_ROOT_WRITE_ALLOWLIST = new Set([
  'AGENTS.md',
  'IDENTITY.md',
  'SOUL.md',
  'USER.md',
  'cron.json',
  'typeclaw.json',
])

// All scaffolded write zones outside `workspace/` (see
// src/init/index.ts#DIRECTORIES) that the agent may write into without
// acknowledging the guard. `packages/` holds reusable systems and custom
// typeclaw plugins as standalone packages; `public/` is the guest-visible
// zone for anything intended to be shared out. Both are deliberate write
// targets, same as `workspace/`, so an unacknowledged write is expected, not
// suspicious.
const AGENT_ROOT_DIRECTORY_ALLOWLIST = new Set(['mounts', 'packages', 'public'])

export async function checkNonWorkspaceWriteGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
  origin?: SessionOrigin
}): Promise<GuardBlock | undefined> {
  const { tool, args, agentDir, origin } = options
  if (tool !== 'write' && tool !== 'edit') return undefined

  const rawPath = args.path
  if (typeof rawPath !== 'string') return undefined

  const targetPath = path.resolve(agentDir, rawPath)
  const workspacePath = path.resolve(agentDir, 'workspace')
  const [realTargetPath, realWorkspacePath, realAgentDir, realTmpRoot] = await Promise.all([
    resolveRealIntendedPath(targetPath),
    resolveRealIntendedPath(workspacePath),
    resolveRealIntendedPath(path.resolve(agentDir)),
    resolveRealIntendedPath('/tmp'),
  ])
  if (await isOperatorOwnedPackageManifest(agentDir, targetPath, realTargetPath)) {
    return {
      block: true,
      reason: `Guard \`${GUARD_NON_WORKSPACE_WRITE}\` blocked a model write to operator-owned package manifest ${targetPath}.`,
    }
  }
  if (await isSkillAuthoringAllowed({ tool, args, agentDir })) return undefined
  if (await isMemoryTopicsWriteAllowed({ tool, args, agentDir, origin })) return undefined
  if (await isAllowedAgentRootWrite(agentDir, targetPath, realTargetPath)) return undefined
  if (isInside(realWorkspacePath, realTargetPath)) return undefined
  // /tmp is virtual per-session scratch (see src/sandbox/session-tmp.ts), not a
  // project or secret surface — throwaway, never committed, so an unacknowledged
  // write is expected. Allowed only on LEXICAL intent: the model's raw path must
  // itself be an absolute /tmp/... path. A relative path that merely realpaths
  // into /tmp (e.g. `workspace/link` where `link -> /tmp/x`) is a workspace
  // escape, not scratch, and must stay blocked by the rules above. The physical
  // target must also still resolve under real /tmp (blocks `/tmp/../agent/.env`
  // and a `/tmp/link -> /agent/.env`) and must not land inside the agent dir
  // (a container/test agent dir can itself sit under /tmp).
  if (isTmpScratchWrite(rawPath, realTargetPath, realAgentDir, realTmpRoot)) return undefined
  if (isGuardAcknowledged(args, GUARD_NON_WORKSPACE_WRITE)) return undefined

  return {
    block: true,
    reason: [
      `Guard \`${GUARD_NON_WORKSPACE_WRITE}\` blocked ${tool} outside the workspace: ${targetPath}.`,
      `The free-write zone is ${workspacePath}.`,
      `Retry with \`${ACKNOWLEDGE_GUARDS}.${GUARD_NON_WORKSPACE_WRITE}: true\` only if this write is intentional.`,
    ].join(' '),
  }
}

async function isOperatorOwnedPackageManifest(
  agentDir: string,
  targetPath: string,
  realTargetPath: string,
): Promise<boolean> {
  const rootManifest = path.join(path.resolve(agentDir), 'package.json')
  const realRootManifest = await resolveRealIntendedPath(rootManifest)
  return targetPath === rootManifest || realTargetPath === realRootManifest
}

async function isAllowedAgentRootWrite(agentDir: string, targetPath: string, realTargetPath: string): Promise<boolean> {
  const resolvedAgentDir = path.resolve(agentDir)
  if (path.dirname(targetPath) === resolvedAgentDir && AGENT_ROOT_WRITE_ALLOWLIST.has(path.basename(targetPath))) {
    return true
  }

  for (const dir of AGENT_ROOT_DIRECTORY_ALLOWLIST) {
    const rootDir = path.join(resolvedAgentDir, dir)
    if (isInside(await resolveRealIntendedPath(rootDir), realTargetPath)) return true
  }
  return false
}

// `rawPath`: the model's RAW path normalized; only an absolute /tmp/... path
// counts as scratch intent (a relative workspace path that escapes into /tmp is
// handled by the escape rules above, never here). `realTargetPath`: the
// realpath-resolved physical target — must still land under /tmp (not /agent via
// `..` or a planted symlink) and must not land inside the agent dir.
function isTmpScratchWrite(
  rawPath: string,
  realTargetPath: string,
  realAgentDir: string,
  realTmpRoot: string,
): boolean {
  const normalizedRaw = path.normalize(rawPath)
  const rawIsAbsoluteTmp = normalizedRaw === '/tmp' || isInside('/tmp', normalizedRaw)
  if (!rawIsAbsoluteTmp) return false

  // Compare against the REALPATH of /tmp, not the literal: on macOS /tmp is a
  // symlink to /private/tmp, so realTargetPath resolves there and a literal-/tmp
  // containment check would never match.
  const physicallyUnderTmp = realTargetPath === realTmpRoot || isInside(realTmpRoot, realTargetPath)
  if (!physicallyUnderTmp) return false

  const insideAgent = realTargetPath === realAgentDir || isInside(realAgentDir, realTargetPath)
  return !insideAgent
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

// RECOVER_MISSING only: this policy decides whether a write is ALLOWED, so an
// ancestor that cannot be resolved must never widen the permitted surface.
async function resolveRealIntendedPath(absolutePath: string): Promise<string> {
  return await realIntendedPath(absolutePath, realpath, {
    recoverable: RECOVER_MISSING,
    onExhausted: 'throw',
  })
}
