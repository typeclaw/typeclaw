import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, readdirSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { AgentSession } from '@/agent'
import { storeEnvKeyUnlessPresent } from '@/init'
import { ensureHiddenMaskTargets } from '@/sandbox/hidden-paths'
import { createServer } from '@/server'
import { failingConfigPublish, INJECTED_CONFIG_PUBLISH_FAILURE } from '@/test-helpers/config-publish-seams'
import { waitFor } from '@/test-helpers/wait-for'
import type { TunnelManager, TunnelState } from '@/tunnels'

const tunnel = await import('./tunnel')

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

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

  test('add fails with a conflict when another writer claims the name while it prompts, leaving its token', async () => {
    // given: while this add waits on its token prompt, another writer adds a
    // named tunnel with the same name and stores that tunnel's token
    const cwd = await makeAgentDir({})
    const config = join(cwd, 'typeclaw.json')
    const env = join(cwd, '.env')
    const winner = {
      name: 'demo',
      provider: 'cloudflare-named',
      for: { kind: 'channel', name: 'github' },
      hostname: 'https://winner.example.com',
      tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
    }
    let winnerConfig = ''
    let winnerEnv = ''

    // when: this add reaches its write
    const result = await tunnel.runTunnelAddFlow(
      cwd,
      { name: 'demo', forChannel: 'github' },
      {
        selectProvider: async () => 'cloudflare-named',
        selectOwner: async () => 'channel',
        text: async () => 'https://loser.example.com',
        password: async () => {
          await writeFile(config, `${JSON.stringify({ tunnels: [winner] }, null, 2)}\n`)
          await writeFile(env, 'CLOUDFLARE_TUNNEL_TOKEN=winner-token\n')
          winnerConfig = await readFile(config, 'utf8')
          winnerEnv = await readFile(env, 'utf8')
          return 'loser-token'
        },
      },
    )

    // then: it reports the conflict and leaves the winner's config and token intact
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('was added by another typeclaw.json writer')
    expect(await readFile(config, 'utf8')).toBe(winnerConfig)
    expect(await readFile(env, 'utf8')).toBe(winnerEnv)
  })

  test('add fails with a conflict when channel setup stores the same token while it prompts', async () => {
    // given: while this add waits on its token prompt, `typeclaw channel add
    // github` (or the init wizard) stores the default tunnel token
    const cwd = await makeAgentDir({})
    const config = join(cwd, 'typeclaw.json')
    const env = join(cwd, '.env')
    const configBefore = await readFile(config, 'utf8')
    let channelEnv = ''

    // when: this add reaches its write
    const result = await tunnel.runTunnelAddFlow(
      cwd,
      { name: 'demo', forChannel: 'github' },
      {
        ...namedTunnelPrompts,
        password: async () => {
          expect(storeEnvKeyUnlessPresent(cwd, 'CLOUDFLARE_TUNNEL_TOKEN', 'channel-token')).toEqual({ ok: true })
          channelEnv = await readFile(env, 'utf8')
          return 'tunnel-token'
        },
      },
    )

    // then: the tunnel's publish is rejected and the channel's token survives
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('CLOUDFLARE_TUNNEL_TOKEN was stored in .env by another typeclaw command')
    expect(await readFile(env, 'utf8')).toBe(channelEnv)
    expect(channelEnv).toBe('CLOUDFLARE_TUNNEL_TOKEN=channel-token\n')
    expect(await readFile(config, 'utf8')).toBe(configBefore)
  })

  test('add fails with a conflict when another command stores the same token key while it prompts', async () => {
    // given: while this add waits on its token prompt, another command stores
    // the same token key in .env
    const cwd = await makeAgentDir({})
    const config = join(cwd, 'typeclaw.json')
    const env = join(cwd, '.env')
    const configBefore = await readFile(config, 'utf8')
    let otherEnv = ''

    // when: this add reaches its write
    const result = await tunnel.runTunnelAddFlow(
      cwd,
      { name: 'demo', forChannel: 'github' },
      {
        ...namedTunnelPrompts,
        password: async () => {
          await writeFile(env, 'CLOUDFLARE_TUNNEL_TOKEN=other-token\n')
          otherEnv = await readFile(env, 'utf8')
          return 'this-token'
        },
      },
    )

    // then: it reports the conflict and writes neither file
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('CLOUDFLARE_TUNNEL_TOKEN was stored in .env by another typeclaw command')
    expect(await readFile(config, 'utf8')).toBe(configBefore)
    expect(await readFile(env, 'utf8')).toBe(otherEnv)
  })

  test.skipIf(isRoot || process.platform === 'win32')(
    'add changes neither file when its token cannot be stored in .env',
    async () => {
      // given: .env becomes read-only while this add waits on its token prompt
      const cwd = await makeAgentDir({})
      const config = join(cwd, 'typeclaw.json')
      const env = join(cwd, '.env')
      await writeFile(env, 'OTHER=1\n')
      const configBefore = await readFile(config, 'utf8')
      try {
        // when: this add reaches its write
        const result = await tunnel.runTunnelAddFlow(
          cwd,
          { name: 'demo', forChannel: 'github' },
          {
            ...namedTunnelPrompts,
            password: async () => {
              await chmod(env, 0o444)
              return 'this-token'
            },
          },
        )

        // then: it fails without publishing the tunnel
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.reason).toContain('Neither .env nor typeclaw.json was changed')
        expect(await readFile(config, 'utf8')).toBe(configBefore)
        expect(await readFile(env, 'utf8')).toBe('OTHER=1\n')
      } finally {
        await chmod(env, 0o644)
      }
    },
  )

  test.skipIf(isRoot || process.platform === 'win32')(
    'add creates no .env when typeclaw.json is read-only',
    async () => {
      // given: no .env yet, and typeclaw.json becomes read-only while this add
      // waits on its token prompt
      const cwd = await makeAgentDir({})
      const config = join(cwd, 'typeclaw.json')
      const configBefore = await readFile(config, 'utf8')
      try {
        // when: this add reaches its write
        const result = await tunnel.runTunnelAddFlow(
          cwd,
          { name: 'demo', forChannel: 'github' },
          {
            ...namedTunnelPrompts,
            password: async () => {
              await chmod(config, 0o444)
              return 'this-token'
            },
          },
        )

        // then: it fails before publishing either file
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.reason).toContain('Neither .env nor typeclaw.json was changed')
        expect(await readFile(config, 'utf8')).toBe(configBefore)
        expect(existsSync(join(cwd, '.env'))).toBe(false)
      } finally {
        await chmod(config, 0o644)
      }
    },
  )

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

  test('set fails with a conflict when another writer edits the tunnel while it prompts, leaving its token', async () => {
    // given: while this set (switching to a named tunnel) waits on its token
    // prompt, another writer edits the same tunnel and stores its own token
    const original = { name: 'github-webhook', provider: 'cloudflare-quick', for: { kind: 'channel', name: 'github' } }
    const cwd = await makeAgentDir({ tunnels: [original] })
    const config = join(cwd, 'typeclaw.json')
    const env = join(cwd, '.env')
    let winnerConfig = ''
    let winnerEnv = ''

    // when: this set reaches its write
    const result = await tunnel.runTunnelSetFlow(
      cwd,
      { name: 'github-webhook' },
      {
        selectProvider: async () => 'cloudflare-named',
        selectOwner: async () => 'channel',
        selectSetField: async () => 'provider',
        text: async () => 'https://loser.example.com',
        password: async () => {
          const edited = {
            ...original,
            provider: 'cloudflare-named',
            hostname: 'https://winner.example.com',
            tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
          }
          await writeFile(config, `${JSON.stringify({ tunnels: [edited] }, null, 2)}\n`)
          await writeFile(env, 'CLOUDFLARE_TUNNEL_TOKEN=winner-token\n')
          winnerConfig = await readFile(config, 'utf8')
          winnerEnv = await readFile(env, 'utf8')
          return 'loser-token'
        },
      },
    )

    // then: it reports the conflict instead of overwriting the other edit or its token
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('was changed by another typeclaw.json writer')
    expect(await readFile(config, 'utf8')).toBe(winnerConfig)
    expect(await readFile(env, 'utf8')).toBe(winnerEnv)
  })

  test('set fails with a conflict when another writer removes the tunnel while it prompts, leaving .env alone', async () => {
    // given: while this set (switching to a named tunnel) waits on its token
    // prompt, another writer removes the tunnel
    const cwd = await makeAgentDir({
      tunnels: [{ name: 'github-webhook', provider: 'cloudflare-quick', for: { kind: 'channel', name: 'github' } }],
    })
    const config = join(cwd, 'typeclaw.json')
    const env = join(cwd, '.env')
    await writeFile(env, 'OTHER=1\n')
    let winnerConfig = ''

    // when: this set reaches its write
    const result = await tunnel.runTunnelSetFlow(
      cwd,
      { name: 'github-webhook' },
      {
        selectProvider: async () => 'cloudflare-named',
        selectOwner: async () => 'channel',
        selectSetField: async () => 'provider',
        text: async () => 'https://loser.example.com',
        password: async () => {
          await writeFile(config, '{ "tunnels": [] }\n')
          winnerConfig = await readFile(config, 'utf8')
          return 'loser-token'
        },
      },
    )

    // then: it reports the conflict rather than succeeding, and writes nothing
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('was removed by another typeclaw.json writer')
    expect(await readFile(config, 'utf8')).toBe(winnerConfig)
    expect(await readFile(env, 'utf8')).toBe('OTHER=1\n')
  })

  test.skipIf(isRoot || process.platform === 'win32')(
    'set changes neither file when typeclaw.json is read-only',
    async () => {
      // given: an existing .env, and typeclaw.json becomes read-only while this
      // set (switching to a named tunnel) waits on its token prompt
      const cwd = await makeAgentDir({
        tunnels: [{ name: 'github-webhook', provider: 'cloudflare-quick', for: { kind: 'channel', name: 'github' } }],
      })
      const config = join(cwd, 'typeclaw.json')
      const env = join(cwd, '.env')
      await writeFile(env, '# operator notes\nOTHER=1')
      const configBefore = await readFile(config, 'utf8')
      try {
        // when: this set reaches its write
        const result = await tunnel.runTunnelSetFlow(
          cwd,
          { name: 'github-webhook' },
          {
            ...namedTunnelPrompts,
            selectSetField: async () => 'provider',
            password: async () => {
              await chmod(config, 0o444)
              return 'this-token'
            },
          },
        )

        // then: it fails before publishing either file
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.reason).toContain('Neither .env nor typeclaw.json was changed')
        expect(await readFile(config, 'utf8')).toBe(configBefore)
        expect(await readFile(env, 'utf8')).toBe('# operator notes\nOTHER=1')
      } finally {
        await chmod(config, 0o644)
      }
    },
  )

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

describe('writeConfigAndToken', () => {
  const token = { env: 'CLOUDFLARE_TUNNEL_TOKEN', value: 'new-token' }
  const nextConfig = { tunnels: [{ name: 'demo', provider: 'cloudflare-named' }] }

  // Writes .env in place (same inode), failing on the listed calls (1-based);
  // a failing call truncates first, like a write that dies part-way.
  function inPlaceWriter(failCalls: number[] = [], onWrite?: () => void) {
    let calls = 0
    return (path: string, content: string | Buffer) => {
      onWrite?.()
      calls += 1
      const fails = failCalls.includes(calls)
      writeFileSync(path, fails ? '' : content, { flag: 'w' })
      if (fails) throw new Error(`injected in-place write failure ${calls}`)
    }
  }

  function stagingDir(cwd: string): string {
    return join(cwd, '.typeclaw', 'credential-staging')
  }

  function leftoverTemps(cwd: string): string[] {
    const staging = stagingDir(cwd)
    return [...readdirSync(cwd), ...(existsSync(staging) ? readdirSync(staging) : [])].filter((name) =>
      name.endsWith('.typeclaw-tmp'),
    )
  }

  test('restores .env when its in-place write fails part-way, and changes neither file', async () => {
    // given: an existing .env and typeclaw.json
    const cwd = await makeAgentDir({ tunnels: [] })
    const env = join(cwd, '.env')
    await writeFile(env, 'OTHER=1\n')
    const configBefore = await readFile(join(cwd, 'typeclaw.json'), 'utf8')

    // when: the in-place write truncates .env and then fails
    const result = tunnel.writeConfigAndToken(cwd, nextConfig, token, 'typeclaw tunnel add', {
      writeInPlace: inPlaceWriter([1]),
    })

    // then: the prior content is back and typeclaw.json was never published
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('Neither .env nor typeclaw.json was changed')
    expect(await readFile(env, 'utf8')).toBe('OTHER=1\n')
    expect(await readFile(join(cwd, 'typeclaw.json'), 'utf8')).toBe(configBefore)
    expect(leftoverTemps(cwd)).toEqual([])
  })

  test.skipIf(process.platform === 'win32')(
    'updates .env in place on its inode, after staging both copies owner-only in a mask-created dir',
    async () => {
      // given: the sandbox mask setup created the staging dir, and .env is 0644
      const cwd = await makeAgentDir({ tunnels: [] })
      const env = join(cwd, '.env')
      await writeFile(env, 'OTHER=1\n')
      await chmod(env, 0o644)
      const inode = statSync(env).ino
      await ensureHiddenMaskTargets({ dirs: [stagingDir(cwd)], files: [] })
      let beforePublish: { dir: number; files: number[] } | undefined

      // when: the token and config are published
      const result = tunnel.writeConfigAndToken(cwd, nextConfig, token, 'typeclaw tunnel add', {
        writeInPlace: inPlaceWriter([], () => {
          beforePublish = {
            dir: statSync(stagingDir(cwd)).mode & 0o777,
            files: readdirSync(stagingDir(cwd)).map((name) => statSync(join(stagingDir(cwd), name)).mode & 0o777),
          }
        }),
      })

      // then: the new and prior copies were 0600 in a 0700 dir, and .env kept
      // its inode (the sandbox mask's anchor) and its mode
      expect(result.ok).toBe(true)
      expect(beforePublish).toEqual({ dir: 0o700, files: [0o600, 0o600] })
      expect(await readFile(env, 'utf8')).toBe('OTHER=1\nCLOUDFLARE_TUNNEL_TOKEN=new-token\n')
      expect(statSync(env).ino).toBe(inode)
      expect(statSync(env).mode & 0o777).toBe(0o644)
      expect(leftoverTemps(cwd)).toEqual([])
    },
  )

  test.skipIf(process.platform === 'win32')('creates a missing .env owner-only', async () => {
    const cwd = await makeAgentDir({ tunnels: [] })

    const result = tunnel.writeConfigAndToken(cwd, nextConfig, token, 'typeclaw tunnel add')

    expect(result.ok).toBe(true)
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe('CLOUDFLARE_TUNNEL_TOKEN=new-token\n')
    expect(statSync(join(cwd, '.env')).mode & 0o777).toBe(0o600)
    expect(leftoverTemps(cwd)).toEqual([])
  })

  // typeclaw.json as a symlink to a file in another directory (the managed-config
  // guard covers a link into the workspace).
  async function linkConfigElsewhere(cwd: string): Promise<{ link: string; target: string }> {
    const elsewhere = await mkdtemp(join(tmpdir(), 'typeclaw-tunnel-config-target-'))
    const link = join(cwd, 'typeclaw.json')
    const target = join(elsewhere, 'typeclaw.json')
    await writeFile(target, `${JSON.stringify({ tunnels: [] }, null, 2)}\n`)
    await rm(link)
    await symlink(target, link)
    return { link, target }
  }

  test.skipIf(process.platform === 'win32')(
    'a tunnel add through a symlinked typeclaw.json updates the target and keeps the link',
    async () => {
      // given: typeclaw.json links to a file in another directory
      const cwd = await makeAgentDir({})
      const { link, target } = await linkConfigElsewhere(cwd)

      // when
      const result = await tunnel.runTunnelAddFlow(
        cwd,
        { name: 'demo' },
        { selectProvider: async () => 'cloudflare-quick', selectOwner: async () => 'manual', text: async () => '5173' },
      )

      // then: the target holds the tunnel and typeclaw.json is still the same link
      expect(result.ok).toBe(true)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(target)
      expect((JSON.parse(await readFile(target, 'utf8')) as { tunnels: unknown[] }).tunnels).toEqual([
        { name: 'demo', provider: 'cloudflare-quick', for: { kind: 'manual' }, upstreamPort: 5173 },
      ])
    },
  )

  describe('when publishing typeclaw.json fails', () => {
    test('restores .env in place when typeclaw.json fails to publish after .env was written', async () => {
      // given: an existing .env and typeclaw.json
      const cwd = await makeAgentDir({ tunnels: [] })
      const config = join(cwd, 'typeclaw.json')
      const env = join(cwd, '.env')
      await writeFile(env, '# operator notes\nOTHER=1')
      const inode = statSync(env).ino
      const configBefore = await readFile(config, 'utf8')

      // when: the config publication fails after .env was written
      const result = tunnel.writeConfigAndToken(cwd, nextConfig, token, 'typeclaw tunnel add', failingConfigPublish())

      // then: it failed there, and both files are exactly as before, .env on
      // the same inode, nothing staged left
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason).toContain(
        `${INJECTED_CONFIG_PUBLISH_FAILURE}. typeclaw.json was not changed; .env was restored.`,
      )
      expect(await readFile(env, 'utf8')).toBe('# operator notes\nOTHER=1')
      expect(statSync(env).ino).toBe(inode)
      expect(await readFile(config, 'utf8')).toBe(configBefore)
      expect(leftoverTemps(cwd)).toEqual([])
    })

    test('empties, never removes, the .env it created when typeclaw.json fails to publish', async () => {
      // given: no .env yet; record the inode the publish creates it with
      const cwd = await makeAgentDir({ tunnels: [] })
      const env = join(cwd, '.env')
      const configBefore = await readFile(join(cwd, 'typeclaw.json'), 'utf8')
      let createdInode: number | undefined

      // when: the config publication fails after .env was created
      const result = tunnel.writeConfigAndToken(
        cwd,
        nextConfig,
        token,
        'typeclaw tunnel add',
        failingConfigPublish({ onConfigPublish: () => (createdInode = statSync(env).ino) }),
      )

      // then: .env is kept on that inode (a sandbox may have masked it) but empty
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason).toContain(
        `${INJECTED_CONFIG_PUBLISH_FAILURE}. typeclaw.json was not changed; .env was left empty.`,
      )
      expect(await readFile(env, 'utf8')).toBe('')
      expect(statSync(env).ino).toBe(createdInode!)
      expect(await readFile(join(cwd, 'typeclaw.json'), 'utf8')).toBe(configBefore)
      expect(leftoverTemps(cwd)).toEqual([])
    })

    for (const platform of ['linux', 'win32'] as const) {
      test(`names .env and how to recover it when restoring it fails too (${platform === 'win32' ? 'Windows' : 'POSIX'} .env path)`, async () => {
        // given: an existing .env and typeclaw.json
        const cwd = await makeAgentDir({ tunnels: [] })
        const env = join(cwd, '.env')
        await writeFile(env, 'OTHER=1\n')
        const configBefore = await readFile(join(cwd, 'typeclaw.json'), 'utf8')

        // when: the config publication fails, and so does the in-place restore of .env
        const result = tunnel.writeConfigAndToken(
          cwd,
          nextConfig,
          token,
          'typeclaw tunnel add',
          failingConfigPublish({ platform, envFailCalls: [2] }),
        )

        // then: the failure names .env and how to recover: from the kept staged
        // copy of its prior content, or on Windows (which keeps no copy on disk)
        // by re-entering the token
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.reason).toContain(INJECTED_CONFIG_PUBLISH_FAILURE)
        expect(result.reason).toContain(`${env} could not be restored (injected in-place write failure 2)`)
        if (platform === 'win32') {
          expect(result.reason).toContain(`must be re-entered in ${env}`)
          expect(existsSync(stagingDir(cwd))).toBe(false)
        } else {
          const kept = readdirSync(stagingDir(cwd))
          expect(kept).toHaveLength(1)
          const priorCopy = join(stagingDir(cwd), kept[0]!)
          expect(result.reason).toContain(`its previous content is saved at ${priorCopy}`)
          expect(await readFile(priorCopy, 'utf8')).toBe('OTHER=1\n')
          if (process.platform !== 'win32') expect(statSync(priorCopy).mode & 0o777).toBe(0o600)
        }
        expect(await readFile(join(cwd, 'typeclaw.json'), 'utf8')).toBe(configBefore)
      })
    }

    test('keeps a token another command stored before it when its rollback runs', async () => {
      // given: channel setup stored the default tunnel token under the lock
      // before this tunnel's transaction, which stores a different key
      const cwd = await makeAgentDir({ tunnels: [] })
      const env = join(cwd, '.env')
      expect(storeEnvKeyUnlessPresent(cwd, 'CLOUDFLARE_TUNNEL_TOKEN', 'channel-token')).toEqual({ ok: true })
      const envBefore = await readFile(env, 'utf8')

      // when: the tunnel's config publication fails after its .env was written
      const result = tunnel.writeConfigAndToken(
        cwd,
        nextConfig,
        { env: 'TUNNEL_B_TOKEN', value: 'tunnel-token' },
        'typeclaw tunnel add',
        failingConfigPublish(),
      )

      // then: the rollback restores .env with the channel's token intact
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.reason).toContain(`${INJECTED_CONFIG_PUBLISH_FAILURE}. typeclaw.json was not changed`)
      expect(await readFile(env, 'utf8')).toBe(envBefore)
      expect(envBefore).toBe('CLOUDFLARE_TUNNEL_TOKEN=channel-token\n')
    })

    test.skipIf(process.platform === 'win32')(
      'a failed publish through a symlinked typeclaw.json leaves the link, its target and .env unchanged',
      async () => {
        // given: typeclaw.json links elsewhere, and .env exists
        const cwd = await makeAgentDir({})
        const { link, target } = await linkConfigElsewhere(cwd)
        const env = join(cwd, '.env')
        await writeFile(env, 'OTHER=1\n')
        const targetBefore = await readFile(target, 'utf8')

        // when: publishing the config onto the target fails after .env was written
        const result = tunnel.writeConfigAndToken(cwd, nextConfig, token, 'typeclaw tunnel add', failingConfigPublish())

        // then: it failed there, nothing changed, and the link still points at
        // the untouched target
        expect(result.ok).toBe(false)
        if (result.ok) throw new Error('unreachable')
        expect(result.reason).toContain(`${INJECTED_CONFIG_PUBLISH_FAILURE}. typeclaw.json was not changed`)
        expect(lstatSync(link).isSymbolicLink()).toBe(true)
        expect(readlinkSync(link)).toBe(target)
        expect(await readFile(target, 'utf8')).toBe(targetBefore)
        expect(await readFile(env, 'utf8')).toBe('OTHER=1\n')
        expect(readdirSync(dirname(target))).toEqual(['typeclaw.json'])
      },
    )
  })

  test.skipIf(process.platform === 'win32')('keeps each file mode when it publishes both', async () => {
    const cwd = await makeAgentDir({ tunnels: [] })
    const config = join(cwd, 'typeclaw.json')
    const env = join(cwd, '.env')
    await writeFile(env, 'OTHER=1\n')
    await chmod(env, 0o600)
    await chmod(config, 0o640)

    const result = tunnel.writeConfigAndToken(cwd, nextConfig, token, 'typeclaw tunnel add')

    expect(result.ok).toBe(true)
    expect(await readFile(env, 'utf8')).toBe('OTHER=1\nCLOUDFLARE_TUNNEL_TOKEN=new-token\n')
    expect(JSON.parse(await readFile(config, 'utf8'))).toEqual(nextConfig)
    expect(statSync(env).mode & 0o777).toBe(0o600)
    expect(statSync(config).mode & 0o777).toBe(0o640)
    expect(leftoverTemps(cwd)).toEqual([])
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

// Interactive answers for a named-tunnel add or provider switch; tests override
// `password` to act as a concurrent command while the flow waits on the token.
const namedTunnelPrompts = {
  selectProvider: async () => 'cloudflare-named' as const,
  selectOwner: async () => 'channel' as const,
  text: async () => 'https://agent.example.com',
}

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
