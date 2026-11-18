import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentSession } from '@/agent'
import { createServer } from '@/server'
import { waitFor } from '@/test-helpers/wait-for'
import type { TunnelManager, TunnelState } from '@/tunnels'

const tunnel = await import('./tunnel')

let server: ReturnType<ReturnType<typeof createServer>['start']> | null = null
let prevNoColor: string | undefined

beforeEach(() => {
  prevNoColor = process.env.NO_COLOR
  process.env.NO_COLOR = '1'
})

afterEach(() => {
  server?.stop(true)
  server = null
  if (prevNoColor === undefined) delete process.env.NO_COLOR
  else process.env.NO_COLOR = prevNoColor
})

describe('tunnel add/remove config flows', () => {
  test('interactive add writes a cloudflare-quick manual tunnel and enables cloudflared', async () => {
    const cwd = await makeAgentDir({})

    const result = await tunnel.runTunnelAddFlow(
      cwd,
      { name: 'demo' },
      {
        selectProvider: async () => 'cloudflare-quick',
        selectOwner: async () => 'manual',
        text: async () => '5173',
      },
    )

    expect(result.ok).toBe(true)
    const config = await readConfig(cwd)
    expect(config.tunnels).toEqual([
      { name: 'demo', provider: 'cloudflare-quick', for: { kind: 'manual' }, upstreamPort: 5173 },
    ])
    expect(config.docker.file.cloudflared).toBe(true)
  })

  test('interactive add writes a cloudflare-named channel tunnel, defaults tokenEnv, prompts for token, writes .env', async () => {
    const cwd = await makeAgentDir({})
    const textPrompts = sequencedPrompts(['https://agent.example.com'])

    const result = await tunnel.runTunnelAddFlow(
      cwd,
      { name: 'github-webhook', forChannel: 'github' },
      {
        selectProvider: async () => 'cloudflare-named',
        selectOwner: async () => 'channel',
        text: textPrompts.text,
        password: async () => 'tunnel-token-from-prompt',
      },
    )

    expect(result.ok).toBe(true)
    const config = await readConfig(cwd)
    expect(config.tunnels).toEqual([
      {
        name: 'github-webhook',
        provider: 'cloudflare-named',
        for: { kind: 'channel', name: 'github' },
        hostname: 'https://agent.example.com',
        tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
      },
    ])
    expect(config.docker.file.cloudflared).toBe(true)
    const env = await Bun.file(join(cwd, '.env')).text()
    expect(env).toBe('CLOUDFLARE_TUNNEL_TOKEN=tunnel-token-from-prompt\n')
  })

  test('interactive add with cloudflare-named does NOT prompt for token when .env already has it', async () => {
    const cwd = await makeAgentDir({})
    await writeFile(join(cwd, '.env'), 'CLOUDFLARE_TUNNEL_TOKEN=preexisting-token\n', 'utf8')
    let passwordCalls = 0

    const result = await tunnel.runTunnelAddFlow(
      cwd,
      { name: 'github-webhook', forChannel: 'github' },
      {
        selectProvider: async () => 'cloudflare-named',
        selectOwner: async () => 'channel',
        text: async () => 'https://agent.example.com',
        password: async () => {
          passwordCalls += 1
          return 'should-not-be-written'
        },
      },
    )

    expect(result.ok).toBe(true)
    expect(passwordCalls).toBe(0)
    const env = await Bun.file(join(cwd, '.env')).text()
    expect(env).toBe('CLOUDFLARE_TUNNEL_TOKEN=preexisting-token\n')
  })

  test('non-interactive add with cloudflare-named defaults tokenEnv and never prompts for the token value', async () => {
    const cwd = await makeAgentDir({})

    const result = await tunnel.runTunnelAddFlow(cwd, {
      name: 'github-webhook',
      provider: 'cloudflare-named',
      forChannel: 'github',
      hostname: 'https://agent.example.com',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.tokenEnv).toBe('CLOUDFLARE_TUNNEL_TOKEN')
    expect(existsSync(join(cwd, '.env'))).toBe(false)
  })

  test('non-interactive add writes a cloudflare-named manual tunnel without upstreamPort', async () => {
    const cwd = await makeAgentDir({})

    const result = await tunnel.runTunnelAddFlow(cwd, {
      name: 'public-demo',
      provider: 'cloudflare-named',
      forManual: true,
      hostname: 'https://demo.example.com',
      tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
    })

    expect(result.ok).toBe(true)
    const config = await readConfig(cwd)
    expect(config.tunnels).toEqual([
      {
        name: 'public-demo',
        provider: 'cloudflare-named',
        for: { kind: 'manual' },
        hostname: 'https://demo.example.com',
        tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
      },
    ])
    expect(config.tunnels[0].upstreamPort).toBeUndefined()
  })

  test('add rejects cloudflare-named with non-https hostname', async () => {
    const cwd = await makeAgentDir({})

    const result = await tunnel.runTunnelAddFlow(cwd, {
      name: 'demo',
      provider: 'cloudflare-named',
      forManual: true,
      hostname: 'http://agent.example.com',
      tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/https:\/\//)
  })

  test('add rejects cloudflare-named with lowercase tokenEnv', async () => {
    const cwd = await makeAgentDir({})

    const result = await tunnel.runTunnelAddFlow(cwd, {
      name: 'demo',
      provider: 'cloudflare-named',
      forManual: true,
      hostname: 'https://agent.example.com',
      tokenEnv: 'my_token',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/env var name/)
  })

  test('interactive add prompts for the name when omitted and writes the new tunnel', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'existing',
          provider: 'external',
          for: { kind: 'manual' },
          upstreamPort: 5173,
          externalUrl: 'https://demo.example.com',
        },
      ],
    })
    const prompts = sequencedPrompts(['fresh', '5174'])

    const result = await tunnel.runTunnelAddFlow(
      cwd,
      {},
      {
        selectProvider: async () => 'cloudflare-quick',
        selectOwner: async () => 'manual',
        text: prompts.text,
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.name).toBe('fresh')
    const config = await readConfig(cwd)
    expect(config.tunnels.map((entry: { name: string }) => entry.name)).toEqual(['existing', 'fresh'])
  })

  test('add rejects a duplicate name surfaced through the interactive prompt', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'existing',
          provider: 'external',
          for: { kind: 'manual' },
          upstreamPort: 5173,
          externalUrl: 'https://demo.example.com',
        },
      ],
    })
    const prompts = sequencedPrompts(['existing'])

    const result = await tunnel.runTunnelAddFlow(
      cwd,
      {},
      {
        selectProvider: async () => 'cloudflare-quick',
        selectOwner: async () => 'manual',
        text: prompts.text,
      },
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/already exists/)
  })

  test('add fails with a conflict when another writer claims the name while it prompts', async () => {
    // given: while this add waits on its prompt, another writer adds a tunnel
    // with the same name
    const cwd = await makeAgentDir({})
    let firstAddBytes = ''
    const prompts = {
      selectProvider: async () => 'cloudflare-quick' as const,
      selectOwner: async () => 'manual' as const,
      text: async () => {
        await writeFile(
          join(cwd, 'typeclaw.json'),
          `${JSON.stringify({ tunnels: [{ name: 'demo', provider: 'cloudflare-quick', for: { kind: 'manual' }, upstreamPort: 3000 }] }, null, 2)}\n`,
        )
        firstAddBytes = await readFile(join(cwd, 'typeclaw.json'), 'utf8')
        return '5173'
      },
    }

    // when: this add reaches its write
    const result = await tunnel.runTunnelAddFlow(cwd, { name: 'demo' }, prompts)

    // then: it reports the conflict and leaves the first add's config intact
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('was added by another typeclaw.json writer')
    expect(await readFile(join(cwd, 'typeclaw.json'), 'utf8')).toBe(firstAddBytes)
  })

  test('non-interactive add rejects a name that violates the schema regex', async () => {
    const cwd = await makeAgentDir({})

    const result = await tunnel.runTunnelAddFlow(cwd, {
      name: 'Bad Name',
      provider: 'external',
      forManual: true,
      upstreamPort: '5173',
      externalUrl: 'https://demo.example.com',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/lowercase, digits/)
    const config = await readConfig(cwd)
    expect(config.tunnels ?? []).toEqual([])
  })

  test('non-interactive add writes an external manual tunnel', async () => {
    const cwd = await makeAgentDir({})

    const result = await tunnel.runTunnelAddFlow(cwd, {
      name: 'manual-demo',
      provider: 'external',
      forManual: true,
      upstreamPort: '5173',
      externalUrl: 'https://demo.example.com',
    })

    expect(result.ok).toBe(true)
    const config = await readConfig(cwd)
    expect(config.tunnels).toEqual([
      {
        name: 'manual-demo',
        provider: 'external',
        for: { kind: 'manual' },
        upstreamPort: 5173,
        externalUrl: 'https://demo.example.com',
      },
    ])
  })

  test('add refuses cleanly with a result-shaped reason when typeclaw.json is malformed JSON', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-tunnel-broken-'))
    await writeFile(join(cwd, 'typeclaw.json'), 'NOT JSON AT ALL {{{', 'utf8')

    const result = await tunnel.runTunnelAddFlow(cwd, {
      name: 'demo',
      provider: 'external',
      forManual: true,
      upstreamPort: '5173',
      externalUrl: 'https://demo.example.com',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/not valid JSON/)
  })

  test('add refuses cleanly with a result-shaped reason when typeclaw.json is schema-invalid', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-tunnel-broken-'))
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: 'not-a-known-model' } }), 'utf8')

    const result = await tunnel.runTunnelAddFlow(cwd, {
      name: 'demo',
      provider: 'external',
      forManual: true,
      upstreamPort: '5173',
      externalUrl: 'https://demo.example.com',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/typeclaw\.json is invalid/)
  })

  test('remove refuses cleanly with a result-shaped reason when typeclaw.json is malformed JSON', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-tunnel-broken-'))
    await writeFile(join(cwd, 'typeclaw.json'), '{ not json', 'utf8')

    const result = tunnel.runTunnelRemoveFlow(cwd, { name: 'demo' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/not valid JSON/)
  })

  test('remove refuses cleanly with a result-shaped reason when typeclaw.json is schema-invalid', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-tunnel-broken-'))
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: 'not-a-known-model' } }), 'utf8')

    const result = tunnel.runTunnelRemoveFlow(cwd, { name: 'demo' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/typeclaw\.json is invalid/)
  })

  test('remove refuses channel-owned tunnels and removes manual tunnels', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'github-webhook',
          provider: 'external',
          for: { kind: 'channel', name: 'github' },
          externalUrl: 'https://hook.example.com',
        },
        {
          name: 'manual-demo',
          provider: 'external',
          for: { kind: 'manual' },
          upstreamPort: 5173,
          externalUrl: 'https://demo.example.com',
        },
      ],
    })

    const refused = tunnel.runTunnelRemoveFlow(cwd, { name: 'github-webhook' })
    const removed = tunnel.runTunnelRemoveFlow(cwd, { name: 'manual-demo' })

    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('unreachable')
    expect(refused.reason).toContain('typeclaw tunnel set github-webhook')
    expect(removed.ok).toBe(true)
    const config = await readConfig(cwd)
    expect(config.tunnels.map((entry: { name: string }) => entry.name)).toEqual(['github-webhook'])
  })
})

describe('tunnel set config flow', () => {
  test('non-interactive set rewrites externalUrl on a channel-owned tunnel', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'github-webhook',
          provider: 'external',
          for: { kind: 'channel', name: 'github' },
          externalUrl: 'https://old.example.com',
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(cwd, {
      name: 'github-webhook',
      externalUrl: 'https://new.example.com',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.externalUrl).toBe('https://new.example.com')
    expect(result.value.for).toEqual({ kind: 'channel', name: 'github' })
    const config = await readConfig(cwd)
    expect(config.tunnels[0].externalUrl).toBe('https://new.example.com')
  })

  test('non-interactive set swaps provider from cloudflare-quick to cloudflare-named and enables cloudflared', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'github-webhook',
          provider: 'cloudflare-quick',
          for: { kind: 'channel', name: 'github' },
          upstreamPort: 8975,
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(cwd, {
      name: 'github-webhook',
      provider: 'cloudflare-named',
      hostname: 'https://agent.example.com',
      tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.provider).toBe('cloudflare-named')
    expect(result.value.hostname).toBe('https://agent.example.com')
    expect(result.value.tokenEnv).toBe('CLOUDFLARE_TUNNEL_TOKEN')
    expect(result.value.upstreamPort).toBeUndefined()
    const config = await readConfig(cwd)
    expect(config.tunnels[0].upstreamPort).toBeUndefined()
    expect(config.docker?.file?.cloudflared).toBe(true)
  })

  test('non-interactive set rejects unknown tunnel name', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'github-webhook',
          provider: 'external',
          for: { kind: 'channel', name: 'github' },
          externalUrl: 'https://hook.example.com',
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(cwd, {
      name: 'does-not-exist',
      externalUrl: 'https://new.example.com',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/unknown tunnel/)
  })

  test('non-interactive set rejects http externalUrl with a clean reason', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'github-webhook',
          provider: 'external',
          for: { kind: 'channel', name: 'github' },
          externalUrl: 'https://hook.example.com',
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(cwd, {
      name: 'github-webhook',
      externalUrl: 'http://insecure.example.com',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/https:\/\//)
    // typeclaw.json must be untouched on failure (the strict-gate semantics
    // documented in runTunnelAddFlow).
    const config = await readConfig(cwd)
    expect(config.tunnels[0].externalUrl).toBe('https://hook.example.com')
  })

  test('non-interactive set provider=external without --external-url fails (no interactive prompt)', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'github-webhook',
          provider: 'cloudflare-quick',
          for: { kind: 'channel', name: 'github' },
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(cwd, {
      name: 'github-webhook',
      provider: 'external',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/--external-url/)
    const config = await readConfig(cwd)
    expect(config.tunnels[0].provider).toBe('cloudflare-quick')
  })

  test('interactive set picks externalUrl field and rewrites it', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'manual-demo',
          provider: 'external',
          for: { kind: 'manual' },
          upstreamPort: 5173,
          externalUrl: 'https://old.example.com',
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(
      cwd,
      { name: 'manual-demo' },
      {
        selectProvider: async () => 'external',
        selectOwner: async () => 'manual',
        selectSetField: async () => 'externalUrl',
        text: async () => 'https://new.example.com',
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.externalUrl).toBe('https://new.example.com')
  })

  test('set fails with a conflict when another writer edits the tunnel while it prompts', async () => {
    // given: while this set waits on its prompt, another writer changes the
    // same tunnel's upstream port
    const original = {
      name: 'manual-demo',
      provider: 'external',
      for: { kind: 'manual' },
      upstreamPort: 5173,
      externalUrl: 'https://old.example.com',
    }
    const cwd = await makeAgentDir({ tunnels: [original] })
    let concurrentBytes = ''

    // when: this set reaches its write
    const result = await tunnel.runTunnelSetFlow(
      cwd,
      { name: 'manual-demo' },
      {
        selectProvider: async () => 'external',
        selectOwner: async () => 'manual',
        selectSetField: async () => 'externalUrl',
        text: async () => {
          await writeFile(
            join(cwd, 'typeclaw.json'),
            `${JSON.stringify({ tunnels: [{ ...original, upstreamPort: 6000 }] }, null, 2)}\n`,
          )
          concurrentBytes = await readFile(join(cwd, 'typeclaw.json'), 'utf8')
          return 'https://new.example.com'
        },
      },
    )

    // then: it reports the conflict instead of overwriting the other edit
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('was changed by another typeclaw.json writer')
    expect(await readFile(join(cwd, 'typeclaw.json'), 'utf8')).toBe(concurrentBytes)
  })

  test('set fails with a conflict when another writer removes the tunnel while it prompts', async () => {
    // given: while this set waits on its prompt, another writer removes the tunnel
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'manual-demo',
          provider: 'external',
          for: { kind: 'manual' },
          upstreamPort: 5173,
          externalUrl: 'https://old.example.com',
        },
      ],
    })
    let concurrentBytes = ''

    // when: this set reaches its write
    const result = await tunnel.runTunnelSetFlow(
      cwd,
      { name: 'manual-demo' },
      {
        selectProvider: async () => 'external',
        selectOwner: async () => 'manual',
        selectSetField: async () => 'externalUrl',
        text: async () => {
          await writeFile(join(cwd, 'typeclaw.json'), '{ "tunnels": [] }\n')
          concurrentBytes = await readFile(join(cwd, 'typeclaw.json'), 'utf8')
          return 'https://new.example.com'
        },
      },
    )

    // then: it reports the conflict rather than succeeding, and writes nothing
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('was removed by another typeclaw.json writer')
    expect(await readFile(join(cwd, 'typeclaw.json'), 'utf8')).toBe(concurrentBytes)
  })

  test('interactive set with no name auto-picks the only configured tunnel', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'manual-demo',
          provider: 'external',
          for: { kind: 'manual' },
          upstreamPort: 5173,
          externalUrl: 'https://old.example.com',
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(
      cwd,
      {},
      {
        selectProvider: async () => 'external',
        selectOwner: async () => 'manual',
        selectSetField: async () => 'externalUrl',
        text: async () => 'https://new.example.com',
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.name).toBe('manual-demo')
    expect(result.value.externalUrl).toBe('https://new.example.com')
  })

  test('interactive set with no name picks from multiple configured tunnels', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'first',
          provider: 'external',
          for: { kind: 'manual' },
          upstreamPort: 5173,
          externalUrl: 'https://first.example.com',
        },
        {
          name: 'second',
          provider: 'external',
          for: { kind: 'manual' },
          upstreamPort: 5174,
          externalUrl: 'https://second-old.example.com',
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(
      cwd,
      {},
      {
        selectProvider: async () => 'external',
        selectOwner: async () => 'manual',
        selectSetField: async () => 'externalUrl',
        selectExistingTunnel: async () => 'second',
        text: async () => 'https://second-new.example.com',
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.name).toBe('second')
    expect(result.value.externalUrl).toBe('https://second-new.example.com')
    const config = await readConfig(cwd)
    expect(config.tunnels[0].externalUrl).toBe('https://first.example.com')
    expect(config.tunnels[1].externalUrl).toBe('https://second-new.example.com')
  })

  test('set refuses cleanly with no name when there are zero tunnels', async () => {
    const cwd = await makeAgentDir({})

    const result = await tunnel.runTunnelSetFlow(cwd, {})

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/no tunnels configured/)
  })

  test('set refuses cleanly when typeclaw.json is schema-invalid', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'typeclaw-tunnel-broken-'))
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({ models: { default: 'not-a-known-model' } }), 'utf8')

    const result = await tunnel.runTunnelSetFlow(cwd, {
      name: 'github-webhook',
      externalUrl: 'https://new.example.com',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toMatch(/typeclaw\.json is invalid/)
  })

  test('interactive set switching TO cloudflare-named prompts for the token and writes .env', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'github-webhook',
          provider: 'cloudflare-quick',
          for: { kind: 'channel', name: 'github' },
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(
      cwd,
      { name: 'github-webhook' },
      {
        selectProvider: async () => 'cloudflare-named',
        selectOwner: async () => 'channel',
        selectSetField: async () => 'provider',
        text: async () => 'https://agent.example.com',
        password: async () => 'rotated-token',
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.provider).toBe('cloudflare-named')
    expect(result.value.tokenEnv).toBe('CLOUDFLARE_TUNNEL_TOKEN')
    const env = await Bun.file(join(cwd, '.env')).text()
    expect(env).toBe('CLOUDFLARE_TUNNEL_TOKEN=rotated-token\n')
  })

  test('non-interactive set switching TO cloudflare-named defaults tokenEnv and never prompts for the token value', async () => {
    const cwd = await makeAgentDir({
      tunnels: [
        {
          name: 'github-webhook',
          provider: 'cloudflare-quick',
          for: { kind: 'channel', name: 'github' },
        },
      ],
    })

    const result = await tunnel.runTunnelSetFlow(cwd, {
      name: 'github-webhook',
      provider: 'cloudflare-named',
      hostname: 'https://agent.example.com',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.value.tokenEnv).toBe('CLOUDFLARE_TUNNEL_TOKEN')
    expect(existsSync(join(cwd, '.env'))).toBe(false)
  })
})

describe('tunnel live commands', () => {
  test('list against a websocket server prints expected rows', async () => {
    const built = createServer({
      port: 0,
      createSession: async () => fakeSession(),
      tunnelManager: makeTunnelManager(),
    }).start()
    server = built

    const result = await tunnel.fetchTunnelList({ cwd: process.cwd(), url: `ws://localhost:${built.port}` })

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    const out = tunnel.formatTunnelList(result.value)
    expect(out).toContain('github-webhook')
    expect(out).toContain('cloudflare-quick')
    expect(out).toContain('https://example.trycloudflare.com')
  })

  test('logs without follow receives snapshot and exits', async () => {
    const built = createServer({
      port: 0,
      createSession: async () => fakeSession(),
      tunnelManager: makeTunnelManager(),
    }).start()
    server = built

    const result = await tunnel.fetchTunnelLogs({
      cwd: process.cwd(),
      url: `ws://localhost:${built.port}`,
      name: 'github-webhook',
    })

    expect(result).toEqual({ ok: true, value: ['first', 'second'] })
  })

  test('logs -f streams live lines and SIGINT closes cleanly', async () => {
    const manager = makeTunnelManager()
    const built = createServer({ port: 0, createSession: async () => fakeSession(), tunnelManager: manager }).start()
    server = built
    const lines: string[] = []

    const pending = tunnel.streamTunnelLogs(
      { cwd: process.cwd(), url: `ws://localhost:${built.port}`, name: 'github-webhook', follow: true },
      (line) => lines.push(line),
    )
    await waitFor(() => lines.length === 2)
    manager.appendLog('github-webhook', 'live')
    await waitFor(() => lines.includes('live'))
    process.emit('SIGINT')

    await expect(pending).resolves.toEqual({ ok: true, value: undefined })
  })

  test('a rejected handshake surfaces a readable reason, never [object ErrorEvent]', async () => {
    const built = createServer({
      port: 0,
      createSession: async () => fakeSession(),
      tunnelManager: makeTunnelManager(),
      tuiToken: 'correct-token',
    }).start()
    server = built

    // given a URL whose token is wrong, the server rejects the WS upgrade (401),
    // which the client sees as an 'error' ErrorEvent — the regression source
    const result = await tunnel.fetchTunnelList({
      cwd: process.cwd(),
      url: `ws://localhost:${built.port}/?token=wrong-token`,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected the rejected handshake to fail')
    expect(result.reason).not.toContain('[object ErrorEvent]')
    expect(result.reason.length).toBeGreaterThan(0)
  })
})

describe('resolveInContainerWsUrl', () => {
  test('returns null on the host stage (no TYPECLAW_CONTAINER_NAME)', () => {
    expect(tunnel.resolveInContainerWsUrl({})).toBeNull()
    expect(tunnel.resolveInContainerWsUrl({ TYPECLAW_TUI_TOKEN: 'tok' })).toBeNull()
  })

  test('dials CONTAINER_PORT with the token and pathname from env', () => {
    const url = tunnel.resolveInContainerWsUrl(
      { TYPECLAW_CONTAINER_NAME: 'agent', TYPECLAW_TUI_TOKEN: 'tok' },
      '/tunnel-logs',
    )
    expect(url).toBe('ws://127.0.0.1:8973/tunnel-logs?token=tok')
  })

  test('omits the token query when TYPECLAW_TUI_TOKEN is unset or empty', () => {
    expect(tunnel.resolveInContainerWsUrl({ TYPECLAW_CONTAINER_NAME: 'agent' })).toBe('ws://127.0.0.1:8973/')
    expect(tunnel.resolveInContainerWsUrl({ TYPECLAW_CONTAINER_NAME: 'agent', TYPECLAW_TUI_TOKEN: '' })).toBe(
      'ws://127.0.0.1:8973/',
    )
  })
})

async function makeAgentDir(config: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-tunnel-cli-'))
  await writeFile(join(dir, 'typeclaw.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return dir
}

async function readConfig(cwd: string): Promise<any> {
  return JSON.parse(await Bun.file(join(cwd, 'typeclaw.json')).text())
}

function fakeSession(): AgentSession {
  return {
    subscribe: () => () => {},
    prompt: async () => {},
    abort: async () => {},
    dispose: () => {},
  } as unknown as AgentSession
}

function makeTunnelManager(): TunnelManager & { appendLog: (name: string, line: string) => void } {
  const state: TunnelState = {
    name: 'github-webhook',
    provider: 'cloudflare-quick',
    for: { kind: 'channel', name: 'github' },
    url: 'https://example.trycloudflare.com',
    status: 'healthy',
    lastUrlAt: 123,
    detail: 'connected',
  }
  const logs = ['first', 'second']
  const subscribers = new Set<(line: string) => void>()
  return {
    start: async () => {},
    stop: async () => {},
    snapshot: () => [state],
    urlFor: () => state.url,
    tail: () => logs,
    subscribeToLogs: (_name, cb) => {
      subscribers.add(cb)
      return () => subscribers.delete(cb)
    },
    appendLog: (_name, line) => {
      logs.push(line)
      for (const cb of subscribers) cb(line)
    },
  }
}

function sequencedPrompts(answers: string[]): { text: (message: string) => Promise<string> } {
  let idx = 0
  return {
    text: async () => {
      if (idx >= answers.length) throw new Error(`sequencedPrompts: no answer at index ${idx}`)
      return answers[idx++]!
    },
  }
}
