import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareBashSandbox } from '@/agent/bash-sandbox'
import type { SessionOrigin } from '@/agent/session-origin'
import type { PermissionService } from '@/permissions/permissions'
import { shellQuote } from '@/sandbox/quote'

import { EvalKernel } from './kernel'

// Retained bindings survive while the principal and audience are unchanged.
// A channel origin also carries conversational state (participant counters,
// timestamps, the reaction target, the review round, display names) that
// changes on every inbound message without changing authority, so it must not
// reset the kernel.
export function authorityOrigin(origin: SessionOrigin | undefined): unknown {
  if (origin === undefined) return undefined
  switch (origin.kind) {
    case 'channel': {
      const {
        participants: _participants,
        membership: _membership,
        reactionRef: _reactionRef,
        githubReviewRound: _githubReviewRound,
        workspaceName: _workspaceName,
        chatName: _chatName,
        parentChatName: _parentChatName,
        ...authority
      } = origin
      return authority
    }
    case 'subagent':
      return { ...origin, spawnedByOrigin: authorityOrigin(origin.spawnedByOrigin) }
    default:
      return origin
  }
}

export function createSandboxedEvalKernel(options: {
  readonly agentDir: string
  readonly sessionId: string
  readonly permissions: PermissionService
  readonly getOrigin: () => SessionOrigin | undefined
}): EvalKernel {
  return new EvalKernel(async () => {
    const origin = options.getOrigin()
    const entry = fileURLToPath(new URL('./entry.ts', import.meta.url))
    const prepared = await prepareBashSandbox({
      command: `exec ${shellQuote(process.execPath)} --no-install ${shellQuote(entry)}`,
      agentDir: options.agentDir,
      sessionId: options.sessionId,
      permissions: options.permissions,
      origin,
      // The bridge uses stdio, never a reachable loopback server. Network work
      // goes through tool.bash/web_fetch with their normal guards.
      network: 'none',
    })
    try {
      await prepared.verify()
      const policy = prepared.policy
      const paths = new Set([
        ...prepared.withheld.paths.dirs,
        ...prepared.withheld.paths.files,
        ...(policy.protected?.dirs ?? []),
        ...(policy.protected?.files ?? []),
        ...(policy.writable?.dirs ?? []),
        ...(policy.writable?.files ?? []),
        ...(policy.mounts ?? []).flatMap((mount) => ('source' in mount ? [mount.source] : [])),
      ])
      // File bind mounts pin identities, not names. An atomic replacement can
      // leave a persistent process with a detached mask or protection. Include
      // ancestors too: moving a directory can retain its children's inodes.
      for (const path of paths) {
        let parent = dirname(path)
        while (!paths.has(parent)) {
          paths.add(parent)
          const next = dirname(parent)
          if (next === parent) break
          parent = next
        }
      }
      const identities = await Promise.all(
        [...paths].sort().map(async (path) => {
          const identity = await stat(path, { bigint: true })
          return [path, String(identity.dev), String(identity.ino)]
        }),
      )
      return {
        command: prepared.commandString,
        cwd: options.agentDir,
        env: prepared.spawnEnv,
        // Includes the live principal, even when two principals have the same
        // role. Never share retained values across a channel author change.
        fingerprint: createHash('sha256')
          .update(
            JSON.stringify({
              origin: authorityOrigin(origin),
              role: options.permissions.describe(origin),
              command: prepared.commandString,
              env: prepared.spawnEnv,
              identities,
            }),
          )
          .digest('hex'),
        cleanup: prepared.cleanup,
      }
    } catch (error) {
      await prepared.cleanup()
      throw error
    }
  })
}
