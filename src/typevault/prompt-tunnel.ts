import type { TunnelConfig } from '@/tunnels'

// Container-internal port the daemon serves one-time `request` pages on.
export const TYPEVAULT_PROMPT_PORT = 8975

const PROMPT_TUNNEL_NAME = 'typevault'

type PromptTunnelConfig = { typevault: { enabled: boolean }; tunnels: readonly TunnelConfig[] }

// The one-time secret page must be reachable from the user's phone. An
// operator's own manual tunnel wins: one to the prompt port, or one named
// `typevault` with no port (a cloudflare-named tunnel, whose upstream is set in
// Cloudflare). Otherwise an enabled vault gets a free Cloudflare quick tunnel,
// so `vault_request` works with no setup. The page carries only ciphertext
// (the browser encrypts to the tier).
export function typevaultPromptTunnel(config: PromptTunnelConfig): TunnelConfig | undefined {
  const configured = config.tunnels.find(
    (entry) =>
      entry.for.kind === 'manual' &&
      (entry.upstreamPort === TYPEVAULT_PROMPT_PORT ||
        (entry.name === PROMPT_TUNNEL_NAME && entry.upstreamPort === undefined)),
  )
  if (configured !== undefined) return configured
  if (!config.typevault.enabled) return undefined
  // The tunnel manager keys tunnels by name, so a reused name would replace
  // an operator's tunnel instead of adding this one.
  const taken = new Set(config.tunnels.map((entry) => entry.name))
  let name = PROMPT_TUNNEL_NAME
  for (let suffix = 2; taken.has(name); suffix++) name = `${PROMPT_TUNNEL_NAME}-${suffix}`
  return { name, provider: 'cloudflare-quick', for: { kind: 'manual' }, upstreamPort: TYPEVAULT_PROMPT_PORT }
}

export function runtimeTunnels(config: PromptTunnelConfig): TunnelConfig[] {
  const prompt = typevaultPromptTunnel(config)
  return prompt === undefined || config.tunnels.includes(prompt) ? [...config.tunnels] : [...config.tunnels, prompt]
}
