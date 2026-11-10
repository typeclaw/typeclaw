import { join } from 'node:path'

import { createRedactor } from 'typevault/redact'

import { TYPECLAW_INTERNAL_BASH_ENV, TYPECLAW_INTERNAL_BASH_REVEAL } from '@/agent/plugin-tools'
import { getConfig } from '@/config'
import type { PermissionService } from '@/permissions'
import { BUILTIN_ROLE_NAMES, CORE_PERMISSIONS } from '@/permissions/builtins'
import { definePlugin, type Hooks } from '@/plugin'
import { isTypevaultMarkerFile } from '@/typevault/envelope-store'
import { vaultSecretValues } from '@/typevault/redaction'
import { ensureProjectIdentity, ensureRoleTiers, isRoleTier, projectMemberName, vaultAdmin } from '@/typevault/vault'

import { bashVaultAccess, createSessionGrants, GRANT_TTL } from './grants'
import { createVaultRequestTool, VAULT_REQUEST_TOOL } from './request'
import { activateVaultRuntime } from './runtime'

const SKILLS_ROOT = join(import.meta.dir, 'skills')

type SessionGrants = ReturnType<typeof createSessionGrants>

export default definePlugin({
  plugin: async (ctx) => {
    // Boot snapshot: typevault is restart-required, and start() settles whether
    // secrets.json moved into the vault before the container boots.
    const config = getConfig()
    if (!config.typevault.enabled || !isTypevaultMarkerFile(join(ctx.agentDir, 'secrets.json'))) return {}

    try {
      const skipped = await ensureRoleTiers(ctx.agentDir, [...BUILTIN_ROLE_NAMES, ...Object.keys(config.roles ?? {})])
      for (const role of skipped) {
        ctx.logger.warn(`typevault: role "${role}" gets no vault tier (its name is reserved or not a valid tier name)`)
      }
    } catch (error) {
      ctx.logger.error(`typevault: could not prepare role tiers; bash gets no vault grants: ${String(error)}`)
      return {}
    }

    let projectIdentity = true
    try {
      await ensureProjectIdentity(ctx.agentDir, projectMemberName(process.env.TYPECLAW_CONTAINER_NAME))
    } catch (error) {
      projectIdentity = false
      ctx.logger.warn(`typevault: could not create the identity for joining project vaults: ${String(error)}`)
    }

    const admin = vaultAdmin(ctx.agentDir, { promptPort: config.typevault.promptPort })
    const grants = createSessionGrants({
      issue: ({ tier, label }) => admin.grant({ tiers: [tier], ttl: GRANT_TTL, label }),
      revoke: async (label) => {
        await admin.revoke({ label })
      },
    })
    const roles = new Map<string, string>()
    activateVaultRuntime({ agentDir: ctx.agentDir, grants, roles })
    const bashHook = vaultBashHook(ctx.agentDir, ctx.permissions, grants, ctx.logger, { projectIdentity })

    return {
      skillsDirs: [SKILLS_ROOT],
      tools: { [VAULT_REQUEST_TOOL]: createVaultRequestTool() },
      hooks: {
        'session.prompt': (event) => {
          event.prompt += `\n\n${CREDENTIALS_PROMPT}`
        },
        'tool.before': async (event, hookCtx) => {
          // Tool contexts carry no origin, so remember the role each session
          // last acted as for vault tools that run outside bash.
          roles.set(event.sessionId, ctx.permissions.resolveRole(event.origin))
          return bashHook(event, hookCtx)
        },
        'tool.after': vaultRedactHook(() => vaultSecretValues(ctx.agentDir), ctx.logger),
        'session.end': async (event) => {
          roles.delete(event.sessionId)
          await grants.end(event.sessionId).catch((error: unknown) => {
            ctx.logger.warn(`typevault: could not revoke the grant of session ${event.sessionId}: ${String(error)}`)
          })
        },
      },
    }
  },
})

const CREDENTIALS_PROMPT = `## Credentials

This agent keeps usernames, passwords, API keys, and other credentials in its TypeVault vault (see the \`typevault\` skill).

- Never ask the user to paste a credential into chat, and never put a credential value in a subagent prompt. When one is missing, call \`${VAULT_REQUEST_TOOL}\` and send the user its link and match code.
- For a browser login, give \`browser\` the \`typevault://\` entry name, never the value. When \`browser\` reports a missing entry, request it with \`${VAULT_REQUEST_TOOL}\`, and spawn \`browser\` again once the user says it is stored.`

export function vaultBashHook(
  agentDir: string,
  permissions: PermissionService,
  grants: SessionGrants,
  logger: { warn: (msg: string) => void },
  options: { projectIdentity?: boolean } = {},
): NonNullable<Hooks['tool.before']> {
  return async (event) => {
    if (event.tool !== 'bash' || !permissions.has(event.origin, CORE_PERMISSIONS.vaultUse)) return
    const tier = permissions.resolveRole(event.origin)
    if (!isRoleTier(tier)) return
    let token: string
    try {
      token = await grants.tokenFor(event.sessionId, tier)
    } catch (error) {
      // The command still runs: without a grant `typevault` reports that it
      // has none, which names the cause instead of failing unrelated bash.
      logger.warn(`typevault: could not issue a grant for tier ${tier}: ${String(error)}`)
      return
    }
    const access = bashVaultAccess(agentDir, token, options)
    const existingEnv = event.args[TYPECLAW_INTERNAL_BASH_ENV]
    event.args[TYPECLAW_INTERNAL_BASH_ENV] = {
      ...(existingEnv !== null && typeof existingEnv === 'object' ? (existingEnv as Record<string, string>) : {}),
      ...access.env,
    }
    const existingReveal = event.args[TYPECLAW_INTERNAL_BASH_REVEAL]
    event.args[TYPECLAW_INTERNAL_BASH_REVEAL] = [
      ...(Array.isArray(existingReveal) ? existingReveal : []),
      ...access.reveal,
    ]
  }
}

export const REDACTION_UNAVAILABLE =
  '[typevault: output withheld because the secrets it may contain could not be redacted; retry once the vault is reachable]'

// `typevault run` already redacts its child's output; this second pass scrubs
// every secret the vault holds from every tool result, including a deliberate
// `get --reveal`, before it reaches the transcript. It fails closed: if the
// vault cannot be read, the output is withheld rather than passed through.
export function vaultRedactHook(
  readValues: () => Promise<readonly string[]>,
  logger: { warn: (msg: string) => void },
): NonNullable<Hooks['tool.after']> {
  return async (event) => {
    let values: readonly string[] | undefined
    try {
      values = await readValues()
    } catch (error) {
      logger.warn(
        `typevault: withheld a tool result because vault secrets could not be read for redaction: ${String(error)}`,
      )
      event.result.content = [{ type: 'text', text: REDACTION_UNAVAILABLE }]
      return
    }
    if (values.length === 0) return
    const redactor = createRedactor(values)
    for (const part of event.result.content) {
      if (part.type === 'text') part.text = redactor.redact(part.text)
    }
  }
}
