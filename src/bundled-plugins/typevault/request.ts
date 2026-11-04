import { z } from 'zod'

import { getConfig } from '@/config'
import { defineTool } from '@/plugin'
import { activeTunnelUrl } from '@/tunnels/active'
import { agentSocketPath, isRoleTier, runtimeConfigRoot } from '@/typevault/vault'

import { vaultRuntime } from './runtime'

export const VAULT_REQUEST_TOOL = 'vault_request'

// Container-internal port the daemon serves one-time `request` pages on. A
// manual tunnel to it is what makes the page reachable from a user's phone.
export const TYPEVAULT_PROMPT_PORT = 8975

const TUNNEL_SNIPPET = `{ "name": "typevault", "provider": "cloudflare-quick", "for": { "kind": "manual" }, "upstreamPort": ${TYPEVAULT_PROMPT_PORT} }`

const OpenedSchema = z.object({ id: z.string(), url: z.string(), code: z.string() })
const ErrorSchema = z.object({ error: z.object({ message: z.string() }) })

export type RequestStatus = 'opened' | 'tunnel-missing' | 'tunnel-starting' | 'failed'

export function promptTunnelUrl(): { status: 'ready'; url: string } | { status: 'tunnel-missing' | 'tunnel-starting' } {
  const tunnel = getConfig().tunnels.find(
    (entry) => entry.for.kind === 'manual' && entry.upstreamPort === TYPEVAULT_PROMPT_PORT,
  )
  if (tunnel === undefined) return { status: 'tunnel-missing' }
  const url = activeTunnelUrl(tunnel.name)
  return url === null ? { status: 'tunnel-starting' } : { status: 'ready', url }
}

export function createVaultRequestTool(tunnelUrl: typeof promptTunnelUrl = promptTunnelUrl) {
  return defineTool({
    description: [
      "Ask the user to store a secret (API key, password, token) in this agent's vault through a one-time web page, so the value never passes through chat or your context.",
      'Returns a link and a match code: send both to the user and tell them to check the code on the page before submitting.',
      "The value is stored under `name` in your role's tier when they submit; nothing comes back to you. Check later with `typevault ls`.",
    ].join(' '),
    parameters: z.object({
      name: z.string().describe('Entry name, e.g. tv://github/bot or tv://openai'),
      preset: z
        .enum(['password', 'api_key', 'oauth', 'ssh', 'totp', 'note'])
        .optional()
        .describe('Fields the page asks for; default is a single secret value'),
      reason: z.string().min(1).max(500).describe('Shown to the user on the page: what the secret is for'),
    }),
    fileOperands: { nonFile: ['name', 'preset', 'reason'] },
    execute: async (args, ctx) => {
      const runtime = vaultRuntime()
      if (runtime === undefined) return result('failed', 'TypeVault is not enabled for this agent.')
      const tunnel = tunnelUrl()
      if (tunnel.status !== 'ready') {
        return tunnel.status === 'tunnel-missing'
          ? result(
              'tunnel-missing',
              `The secret page needs a public URL and no tunnel is configured for it. Ask the user to add this entry to "tunnels" in typeclaw.json, set docker.file.cloudflared to true, and restart the agent (no account needed): ${TUNNEL_SNIPPET}`,
            )
          : result('tunnel-starting', 'The tunnel for the secret page has no public URL yet; try again in a moment.')
      }
      const role = runtime.roles.get(ctx.sessionId)
      if (role === undefined || !isRoleTier(role)) return result('failed', 'This session has no vault tier.')

      const token = await runtime.grants.tokenFor(ctx.sessionId, role)
      const response = await fetch('http://typevault/v1/request', {
        unix: agentSocketPath(runtime.agentDir, runtimeConfigRoot(runtime.agentDir)),
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: args.name, preset: args.preset, reason: args.reason }),
      })
      const body: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const error = ErrorSchema.safeParse(body)
        return result(
          'failed',
          `Could not open the request: ${error.success ? error.data.error.message : response.status}`,
        )
      }
      const opened = OpenedSchema.parse(body)
      // The daemon only knows its loopback address; the page's path and token
      // are what matter, so serve them from the tunnel's current origin.
      const local = new URL(opened.url)
      const link = new URL(`${local.pathname}${local.search}`, tunnel.url).toString()
      return result(
        'opened',
        `Send the user this link and match code. It is stored as ${args.name} in tier "${role}" once they submit.\nLink: ${link}\nMatch code: ${opened.code}`,
        { link, code: opened.code },
      )
    },
  })
}

function result(status: RequestStatus, text: string, extra: Record<string, string> = {}) {
  return { content: [{ type: 'text' as const, text }], details: { status, ...extra } }
}
