import { describe, expect, test } from 'bun:test'

import type { TunnelConfig } from '@/tunnels'

import { runtimeTunnels, typevaultPromptTunnel } from './prompt-tunnel'

const PROMPT_PORT = 9100

const webhook: TunnelConfig = {
  name: 'github-webhook',
  provider: 'cloudflare-quick',
  for: { kind: 'channel', name: 'github' },
}

describe('typevault prompt tunnel', () => {
  test('an enabled vault with no tunnel of its own gets a quick tunnel to the prompt port', () => {
    const config = { typevault: { enabled: true, promptPort: PROMPT_PORT }, tunnels: [webhook] }

    expect(runtimeTunnels(config)).toEqual([
      webhook,
      { name: 'typevault', provider: 'cloudflare-quick', for: { kind: 'manual' }, upstreamPort: PROMPT_PORT },
    ])
  })

  test("the operator's own tunnel to the prompt port is used instead of adding one", () => {
    const own: TunnelConfig = {
      name: 'vault',
      provider: 'external',
      for: { kind: 'manual' },
      upstreamPort: PROMPT_PORT,
      externalUrl: 'https://vault.example.com',
    }
    const config = { typevault: { enabled: true, promptPort: PROMPT_PORT }, tunnels: [own] }

    expect(typevaultPromptTunnel(config)).toBe(own)
    expect(runtimeTunnels(config)).toEqual([own])
  })

  test('a named Cloudflare tunnel called typevault serves the page, without an upstreamPort', () => {
    const named: TunnelConfig = {
      name: 'typevault',
      provider: 'cloudflare-named',
      for: { kind: 'manual' },
      hostname: 'https://vault.example.com',
      tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
    }
    const config = { typevault: { enabled: true, promptPort: PROMPT_PORT }, tunnels: [named] }

    expect(typevaultPromptTunnel(config)).toBe(named)
    expect(runtimeTunnels(config)).toEqual([named])
  })

  test("a tunnel on some other port is not taken for the secret page's", () => {
    const other: TunnelConfig = {
      name: 'vault',
      provider: 'cloudflare-quick',
      for: { kind: 'manual' },
      upstreamPort: PROMPT_PORT + 1,
    }
    const config = { typevault: { enabled: true, promptPort: PROMPT_PORT }, tunnels: [other] }

    expect(typevaultPromptTunnel(config)?.upstreamPort).toBe(PROMPT_PORT)
  })

  test('a disabled vault adds no tunnel', () => {
    const config = { typevault: { enabled: false, promptPort: PROMPT_PORT }, tunnels: [webhook] }

    expect(typevaultPromptTunnel(config)).toBeUndefined()
    expect(runtimeTunnels(config)).toEqual([webhook])
  })

  test('the implicit tunnel never takes a name an unrelated tunnel already uses', () => {
    const app: TunnelConfig = {
      name: 'typevault',
      provider: 'cloudflare-quick',
      for: { kind: 'manual' },
      upstreamPort: 3000,
    }
    const docs: TunnelConfig = {
      name: 'typevault-2',
      provider: 'cloudflare-quick',
      for: { kind: 'manual' },
      upstreamPort: 4000,
    }

    const tunnels = runtimeTunnels({ typevault: { enabled: true, promptPort: PROMPT_PORT }, tunnels: [app, docs] })

    expect(tunnels.map((entry) => entry.name)).toEqual(['typevault', 'typevault-2', 'typevault-3'])
    expect(tunnels.slice(0, 2)).toEqual([app, docs])
  })
})
