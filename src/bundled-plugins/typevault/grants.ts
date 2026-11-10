import { join } from 'node:path'

import type { BashSandboxReveal } from '@/agent/bash-sandbox'
import { DEFAULT_SANDBOX_ENV } from '@/sandbox/policy'
import { agentSocketPath, runtimeConfigRoot, typevaultDir } from '@/typevault/vault'

export const GRANT_TTL = '12h'
const GRANT_TTL_MS = 12 * 60 * 60 * 1000
// Reissue a little early so a long bash command never starts on a grant that
// expires mid-run.
const REISSUE_MARGIN_MS = 30 * 60 * 1000

export type GrantIssuer = {
  issue: (request: { tier: string; label: string }) => Promise<string>
  revoke: (label: string) => Promise<void>
}

type Held = { token: string; tier: string; label: string; issuedAt: number }

// Every grant gets its own label (`session:<id>:<n>`), so the audit trail names
// the session and a superseded grant can be revoked alone: typevault keeps one
// record per issuance, and revoking a shared label would also revoke the new
// grant.
export function createSessionGrants(issuer: GrantIssuer, now: () => number = Date.now) {
  const held = new Map<string, Held>()
  const queues = new Map<string, Promise<unknown>>()
  let sequence = 0

  // Grant transitions of one session run one at a time, so a caller never
  // receives a token issued for another tier by a concurrent call.
  const serialize = <T>(sessionId: string, task: () => Promise<T>): Promise<T> => {
    const next = (queues.get(sessionId) ?? Promise.resolve()).then(task, task)
    queues.set(
      sessionId,
      next.catch(() => {}),
    )
    return next
  }

  return {
    tokenFor(sessionId: string, tier: string): Promise<string> {
      return serialize(sessionId, async () => {
        const current = held.get(sessionId)
        if (
          current !== undefined &&
          current.tier === tier &&
          now() - current.issuedAt < GRANT_TTL_MS - REISSUE_MARGIN_MS
        ) {
          return current.token
        }
        // Revoke the old grant before exposing the replacement: after a role downgrade the
        // old, higher-tier token must stop working even if it was copied. It
        // stays held until revocation succeeds, so a retry revokes it again.
        if (current !== undefined) {
          await issuer.revoke(current.label)
          held.delete(sessionId)
        }
        const label = `${sessionLabel(sessionId)}:${++sequence}`
        const token = await issuer.issue({ tier, label })
        held.set(sessionId, { token, tier, label, issuedAt: now() })
        return token
      })
    },
    heldToken(sessionId: string): string | undefined {
      return held.get(sessionId)?.token
    },
    async end(sessionId: string): Promise<void> {
      await serialize(sessionId, async () => {
        const current = held.get(sessionId)
        if (current === undefined) return
        await issuer.revoke(current.label)
        held.delete(sessionId)
      })
      queues.delete(sessionId)
    },
  }
}

export function sessionLabel(sessionId: string): string {
  return `session:${sessionId}`
}

// What model bash needs to reach the vault through a grant: the token, the
// ciphertext-only vault re-exposed read-only over its mask, and the daemon's
// agent socket bound where a client with the sandbox HOME looks for it. The
// admin sockets beside it and the agent's own key stay masked. The token and
// vault go under TypeClaw's names, read only by the `typevault` command
// (src/typevault/bash-cli.ts): a TYPEVAULT_* variable would steer every
// typevault CLI, a project's own included, to the agent's vault.
export function bashVaultAccess(
  agentDir: string,
  token: string,
): { env: Record<string, string>; reveal: BashSandboxReveal } {
  const sandboxConfigRoot = join(DEFAULT_SANDBOX_ENV.HOME ?? '/tmp', '.config')
  return {
    env: { TYPECLAW_VAULT_GRANT: token, TYPECLAW_VAULT_DIR: typevaultDir(agentDir) },
    reveal: [
      { type: 'ro-bind', source: typevaultDir(agentDir), dest: typevaultDir(agentDir) },
      {
        type: 'ro-bind',
        source: agentSocketPath(agentDir, runtimeConfigRoot(agentDir)),
        dest: agentSocketPath(agentDir, sandboxConfigRoot),
      },
    ],
  }
}
