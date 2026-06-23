import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type AddChannelStepEvent, readConfiguredChannels, runAddChannel, scaffold, writeSecrets } from './index'
import { runKakaotalkBootstrap } from './kakaotalk-auth'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-add-channel-'))
  await scaffold(root)
  await writeSecrets(root, { apiKey: 'fw_existing', model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function readConfig(): Promise<{ channels?: Record<string, Record<string, unknown>>; [k: string]: unknown }> {
  return JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as {
    channels?: Record<string, Record<string, unknown>>
  }
}

async function readSecrets(): Promise<{
  providers?: Record<string, unknown>
  channels?: Record<string, Record<string, unknown>>
}> {
  try {
    const raw = await readFile(join(root, 'secrets.json'), 'utf8')
    return JSON.parse(raw) as {
      providers?: Record<string, unknown>
      channels?: Record<string, Record<string, unknown>>
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
}

async function readSecretsChannels(): Promise<Record<string, Record<string, unknown>>> {
  return (await readSecrets()).channels ?? {}
}

type RecordedCall = { url: string; method: string; body?: string }

type RecordingGithubFetchOptions = {
  onHookList?: (url: string) => Response
  onHookCreate?: (url: string, body: string | undefined, index: number) => Response
}

function recordingGithubFetch(options: RecordingGithubFetchOptions = {}): {
  fn: typeof fetch
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  let createIndex = 0
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    calls.push(body !== undefined ? { url, method, body } : { url, method })

    if (url === 'https://api.github.com/user' && method === 'GET') {
      return Response.json({ login: 'test-bot', id: 1 })
    }
    if (/\/repos\/[^/]+\/[^/]+\/hooks(\?|$)/.test(url) && method === 'GET') {
      return options.onHookList ? options.onHookList(url) : Response.json([])
    }
    if (/\/repos\/[^/]+\/[^/]+\/hooks$/.test(url) && method === 'POST') {
      if (options.onHookCreate) return options.onHookCreate(url, body, createIndex++)
      return Response.json({ id: 100 + createIndex++ }, { status: 201 })
    }
    return new Response('unexpected', { status: 500 })
  }
  return { fn: Object.assign(handler, { preconnect: () => {} }) as typeof fetch, calls }
}

describe('runAddChannel', () => {
  test('adds discord-bot to typeclaw.json as an empty block (no allow field)', async () => {
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-token-x' })

    const cfg = await readConfig()
    expect(cfg.channels?.['discord-bot']).toEqual({})
  })

  test('adds discord user as an empty block and runs QR auth runner before config mutation', async () => {
    const events: AddChannelStepEvent[] = []
    const result = await runAddChannel({
      cwd: root,
      channel: 'discord',
      runDiscordAuth: async () => ({ ok: true }),
      onProgress: (event) => events.push(event),
    })

    expect(result).toBeUndefined()
    const cfg = await readConfig()
    expect(cfg.channels?.discord).toEqual({})
    expect(events.map((event) => `${event.step}:${event.phase}`)).toEqual([
      'discord-auth:start',
      'discord-auth:done',
      'config:start',
      'config:done',
      'secrets:start',
      'secrets:done',
    ])
  })

  test('aborts and leaves typeclaw.json + secrets.json untouched when discord auth fails', async () => {
    await expect(
      runAddChannel({
        cwd: root,
        channel: 'discord',
        runDiscordAuth: async () => ({ ok: false, reason: 'scan expired' }),
      }),
    ).rejects.toThrow('Discord authentication failed: scan expired')

    const cfg = await readConfig()
    expect(cfg.channels?.discord).toBeUndefined()
    expect((await readSecrets()).channels?.discord).toBeUndefined()
  })

  test('saves discord-bot.token to secrets.json#channels without disturbing the Fireworks provider key', async () => {
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-token-x' })

    const secrets = await readSecrets()
    expect(secrets.providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_existing' } })
    expect(secrets.channels?.['discord-bot']).toEqual({ token: { value: 'discord-token-x' } })
  })

  test('adds slack-bot with both bot+app tokens to secrets.json#channels.slack-bot', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'slack-bot',
      slackBotToken: 'xoxb-bot',
      slackAppToken: 'xapp-app',
    })

    const cfg = await readConfig()
    expect(cfg.channels?.['slack-bot']).toEqual({})
    const channels = await readSecretsChannels()
    expect(channels['slack-bot']).toEqual({
      botToken: { value: 'xoxb-bot' },
      appToken: { value: 'xapp-app' },
    })
    expect((await readSecrets()).providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_existing' } })
  })

  test('keeps first slack user add without --id in flat config for back-compat', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'slack',
      slackQrDataUrl: 'data:image/png;base64,abc',
      runSlackAuth: async ({ cwd }) => {
        await writeSlackAccount(cwd, 'acme', 'Acme')
        return { ok: true }
      },
    })

    const cfg = await readConfig()
    expect(cfg.channels?.slack).toEqual({})
  })

  test('migrates flat slack config when adding a second instance with --id', async () => {
    const cfg = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as Record<string, unknown>
    cfg.channels = { slack: { enabled: false, history: { prefetch: { channel: { tail: 2 } } } } }
    await writeFile(join(root, 'typeclaw.json'), `${JSON.stringify(cfg, null, 2)}\n`)
    await writeSlackAccount(root, 'acme', 'Acme')

    await runAddChannel({
      cwd: root,
      channel: 'slack',
      instanceId: 'personal',
      slackQrDataUrl: 'data:image/png;base64,abc',
      runSlackAuth: async ({ cwd }) => {
        await writeSlackAccount(cwd, 'personal', 'Personal')
        return { ok: true }
      },
    })

    const cfgAfter = await readConfig()
    expect(cfgAfter.channels?.slack).toEqual({
      instances: [
        { id: 'default', account: 'acme', enabled: false, history: { prefetch: { channel: { tail: 2 } } } },
        { id: 'personal', account: 'personal' },
      ],
    })
    const slack = (await readSecretsChannels()).slack as { accounts: Record<string, unknown> }
    expect(Object.keys(slack.accounts).sort()).toEqual(['acme', 'personal'])
  })

  test('adds first slack user with --id as an instances config', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'slack',
      instanceId: 'acme',
      slackQrDataUrl: 'data:image/png;base64,abc',
      runSlackAuth: async ({ cwd }) => {
        await writeSlackAccount(cwd, 'acme', 'Acme')
        return { ok: true }
      },
    })

    const cfg = await readConfig()
    expect(cfg.channels?.slack).toEqual({ instances: [{ id: 'acme', account: 'acme' }] })
  })

  test('adds telegram-bot config + secrets.json#channels.telegram-bot', async () => {
    await runAddChannel({ cwd: root, channel: 'telegram-bot', telegramBotToken: '123:tg-secret' })

    const cfg = await readConfig()
    expect(cfg.channels?.['telegram-bot']).toEqual({})
    const channels = await readSecretsChannels()
    expect(channels['telegram-bot']).toEqual({ token: { value: '123:tg-secret' } })
    expect((await readSecrets()).providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_existing' } })
  })

  test('adds webex-bot config + secrets.json#channels.webex-bot', async () => {
    await runAddChannel({ cwd: root, channel: 'webex-bot', webexBotToken: 'webex-secret' })

    const cfg = await readConfig()
    expect(cfg.channels?.['webex-bot']).toEqual({})
    const channels = await readSecretsChannels()
    expect(channels['webex-bot']).toEqual({ token: { value: 'webex-secret' } })
    expect((await readSecrets()).providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_existing' } })
  })

  test('adds webex user as an empty block and runs auth runner before config mutation', async () => {
    const authCalls: string[] = []
    await runAddChannel({
      cwd: root,
      channel: 'webex',
      runWebexAuth: async ({ cwd }) => {
        authCalls.push(cwd)
        return { ok: true }
      },
    })

    expect(authCalls).toEqual([root])
    const cfg = await readConfig()
    expect(cfg.channels?.webex).toEqual({})
    expect((await readSecrets()).providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_existing' } })
  })

  test('aborts and leaves typeclaw.json + secrets.json untouched when webex auth fails', async () => {
    const beforeConfig = await readFile(join(root, 'typeclaw.json'), 'utf8')
    const beforeSecrets = await readFile(join(root, 'secrets.json'), 'utf8')

    await expect(
      runAddChannel({
        cwd: root,
        channel: 'webex',
        runWebexAuth: async () => ({ ok: false, reason: 'bad password' }),
      }),
    ).rejects.toThrow(/bad password/)

    expect(await readFile(join(root, 'typeclaw.json'), 'utf8')).toBe(beforeConfig)
    expect(await readFile(join(root, 'secrets.json'), 'utf8')).toBe(beforeSecrets)
  })

  test('adds kakaotalk as an empty block (no allow field) and runs auth runner', async () => {
    const authCalls: string[] = []
    await runAddChannel({
      cwd: root,
      channel: 'kakaotalk',
      runKakaotalkAuth: async ({ cwd }) => {
        authCalls.push(cwd)
        return { ok: true }
      },
    })

    expect(authCalls).toEqual([root])
    const cfg = await readConfig()
    expect(cfg.channels?.kakaotalk).toEqual({})
    expect((await readSecrets()).providers?.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_existing' } })
  })

  test('adds kakaotalk credentials to secrets.json instead of workspace credential files', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'kakaotalk',
      runKakaotalkAuth: async ({ cwd }) =>
        runKakaotalkBootstrap({
          email: 'user@example.com',
          password: 'secret',
          agentDir: cwd,
          callbacks: { onPasscode: () => {} },
          loginFlow: async () => ({
            authenticated: true,
            credentials: {
              access_token: 'oauth-abc',
              refresh_token: 'refresh-xyz',
              user_id: 'user-1',
              device_uuid: 'uuid-1',
              device_type: 'tablet',
            },
          }),
        }),
    })

    const channels = await readSecretsChannels()
    const kakao = channels.kakaotalk as unknown as {
      currentAccount: string
      accounts: Record<string, { oauth_token: string }>
    }
    expect(kakao.currentAccount).toBe('user-1')
    expect(kakao.accounts['user-1']?.oauth_token).toBe('oauth-abc')
    expect(existsSync(join(root, 'workspace', '.agent-messenger', 'kakaotalk-credentials.json'))).toBe(false)
  })

  test('aborts and leaves typeclaw.json + secrets.json untouched when kakaotalk auth fails', async () => {
    const beforeConfig = await readFile(join(root, 'typeclaw.json'), 'utf8')
    const beforeSecrets = await readFile(join(root, 'secrets.json'), 'utf8')

    await expect(
      runAddChannel({
        cwd: root,
        channel: 'kakaotalk',
        runKakaotalkAuth: async () => ({ ok: false, reason: 'bad password' }),
      }),
    ).rejects.toThrow(/bad password/)

    expect(await readFile(join(root, 'typeclaw.json'), 'utf8')).toBe(beforeConfig)
    expect(await readFile(join(root, 'secrets.json'), 'utf8')).toBe(beforeSecrets)
  })

  test('preserves an existing channel when adding a different one', async () => {
    await runAddChannel({ cwd: root, channel: 'slack-bot', slackBotToken: 'xoxb-x', slackAppToken: 'xapp-x' })
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-x' })

    const cfg = await readConfig()
    expect(cfg.channels?.['slack-bot']).toEqual({})
    expect(cfg.channels?.['discord-bot']).toEqual({})
    const channels = await readSecretsChannels()
    expect(channels['slack-bot']).toEqual({
      botToken: { value: 'xoxb-x' },
      appToken: { value: 'xapp-x' },
    })
    expect(channels['discord-bot']).toEqual({ token: { value: 'discord-x' } })
  })

  test('preserves arbitrary unrelated keys in typeclaw.json (does not strip user fields)', async () => {
    const cfg = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as Record<string, unknown>
    cfg.mounts = [{ source: '~/data', target: '/data' }]
    cfg.idleMs = 60_000
    await writeFile(join(root, 'typeclaw.json'), `${JSON.stringify(cfg, null, 2)}\n`)

    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-x' })

    const after = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as Record<string, unknown>
    expect(after.mounts).toEqual([{ source: '~/data', target: '/data' }])
    expect(after.idleMs).toBe(60_000)
  })

  test('does NOT seed a member match when adding a chat adapter (scoped-by-default; owner claim grants access)', async () => {
    await runAddChannel({ cwd: root, channel: 'slack-bot', slackBotToken: 'xoxb', slackAppToken: 'xapp' })

    const cfg = (await readConfig()) as { roles?: { member?: { match?: string[] } } }
    expect(cfg.roles?.member?.match).toBeUndefined()
  })

  test('does not seed member match across multiple chat adapters', async () => {
    await runAddChannel({ cwd: root, channel: 'slack-bot', slackBotToken: 'xoxb', slackAppToken: 'xapp' })
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-x' })

    const cfg = (await readConfig()) as { roles?: { member?: { match?: string[] } } }
    expect(cfg.roles?.member?.match).toBeUndefined()
  })

  test('leaves an operator-authored member.match untouched (no wildcard appended)', async () => {
    const cfg = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as Record<string, unknown>
    cfg.roles = { member: { match: ['slack:T0123 author:U_EXISTING'] } }
    await writeFile(join(root, 'typeclaw.json'), `${JSON.stringify(cfg, null, 2)}\n`)

    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-x' })

    const after = (await readConfig()) as { roles?: { member?: { match?: string[] } } }
    expect(after.roles?.member?.match).toEqual(['slack:T0123 author:U_EXISTING'])
  })

  test('preserves existing roles.owner block and adds no member wildcard when adding a channel', async () => {
    const cfg = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as Record<string, unknown>
    cfg.roles = { owner: { match: ['slack:@dm author:U_ME'] } }
    await writeFile(join(root, 'typeclaw.json'), `${JSON.stringify(cfg, null, 2)}\n`)

    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-x' })

    const after = (await readConfig()) as {
      roles?: { owner?: { match?: string[] }; member?: { match?: string[] } }
    }
    expect(after.roles?.owner?.match).toEqual(['slack:@dm author:U_ME'])
    expect(after.roles?.member?.match).toBeUndefined()
  })

  test('rejects re-adding an already-configured channel', async () => {
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-first' })

    await expect(
      runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-second' }),
    ).rejects.toThrow(/already configured/i)

    const channels = await readSecretsChannels()
    expect(channels['discord-bot']).toEqual({ token: { value: 'discord-first' } })
  })

  test('rejects when a field the channel needs already exists in secrets.json (does not overwrite user secrets)', async () => {
    await writeFile(
      join(root, 'secrets.json'),
      JSON.stringify({
        version: 2,
        providers: {},
        channels: { 'discord-bot': { token: { value: 'keep-me' } } },
      }),
    )

    await expect(runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'overwrite-me' })).rejects.toThrow(
      /token/,
    )

    const channels = await readSecretsChannels()
    expect(channels['discord-bot']).toEqual({ token: { value: 'keep-me' } })
  })

  test('throws a helpful error when run from a non-initialized directory', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'typeclaw-add-empty-'))
    try {
      await expect(runAddChannel({ cwd: empty, channel: 'discord-bot', discordBotToken: 'x' })).rejects.toThrow(
        /typeclaw\.json not found/,
      )
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  test('emits config + secrets events in order for a non-kakaotalk channel', async () => {
    const events: AddChannelStepEvent[] = []
    await runAddChannel({
      cwd: root,
      channel: 'telegram-bot',
      telegramBotToken: '123:t',
      onProgress: (e) => events.push(e),
    })

    expect(events.map((e) => `${e.step}:${e.phase}`)).toEqual([
      'config:start',
      'config:done',
      'secrets:start',
      'secrets:done',
    ])
  })

  test('adds github channel: writes typeclaw.json (incl. repos[], omitting the defaulted event allowlist), secrets.json, and match rules', async () => {
    const events: AddChannelStepEvent[] = []
    const fetchImpl = recordingGithubFetch()

    await runAddChannel({
      cwd: root,
      channel: 'github',
      auth: { type: 'pat', pat: 'ghp_test' },
      webhookSecret: 'wh-secret',
      tunnelProvider: 'external',
      webhookUrl: 'https://agent.example.com/gh',
      webhookPort: 8975,
      repos: ['acme/widgets'],
      fetchImpl: fetchImpl.fn,
      onProgress: (e) => events.push(e),
    })

    const cfg = (await readConfig()) as {
      channels?: { github?: { webhookUrl?: string; repos?: string[]; eventAllowlist?: string[] } }
      tunnels?: Array<{
        name?: string
        provider?: string
        externalUrl?: string
        for?: { kind?: string; name?: string }
      }>
    }
    expect(cfg.channels?.github?.webhookUrl).toBe('https://agent.example.com/gh')
    expect(cfg.channels?.github?.repos).toEqual(['acme/widgets'])
    // eventAllowlist is intentionally not persisted so the config tracks the
    // shipped default across releases; the schema fills it at parse time.
    expect(cfg.channels?.github?.eventAllowlist).toBeUndefined()
    expect(cfg.tunnels).toEqual([
      {
        name: 'github-webhook',
        provider: 'external',
        externalUrl: 'https://agent.example.com/gh',
        for: { kind: 'channel', name: 'github' },
      },
    ])

    const secrets = await readSecretsChannels()
    expect((secrets.github as { auth: { type: string } }).auth.type).toBe('pat')

    const after = JSON.parse(await readFile(join(root, 'typeclaw.json'), 'utf8')) as {
      roles?: { member?: { match?: string[] } }
    }
    expect(after.roles?.member?.match).toContain('github:acme/widgets')

    expect(events.map((e) => `${e.step}:${e.phase}`)).toEqual([
      'config:start',
      'config:done',
      'secrets:start',
      'secrets:done',
      'github-webhooks:start',
      'github-webhooks:done',
    ])
  })

  test('adds github channel (external): eagerly registers webhook with the github API using the provided URL and secret', async () => {
    const events: AddChannelStepEvent[] = []
    const fetchImpl = recordingGithubFetch()

    await runAddChannel({
      cwd: root,
      channel: 'github',
      auth: { type: 'pat', pat: 'ghp_test' },
      webhookSecret: 'wh-secret-xyz',
      tunnelProvider: 'external',
      webhookUrl: 'https://agent.example.com/gh',
      webhookPort: 8975,
      repos: ['acme/widgets', 'acme/gadgets'],
      fetchImpl: fetchImpl.fn,
      onProgress: (e) => events.push(e),
    })

    const posts = fetchImpl.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/hooks'))
    expect(posts.map((p) => p.url)).toEqual([
      'https://api.github.com/repos/acme/widgets/hooks',
      'https://api.github.com/repos/acme/gadgets/hooks',
    ])
    for (const post of posts) {
      const body = JSON.parse(post.body ?? '{}') as {
        config?: { url?: string; secret?: string; content_type?: string }
        events?: string[]
        active?: boolean
      }
      expect(body.config?.url).toBe('https://agent.example.com/gh')
      expect(body.config?.secret).toBe('wh-secret-xyz')
      expect(body.config?.content_type).toBe('json')
      expect(body.active).toBe(true)
      expect(body.events).toContain('issue_comment')
    }

    const doneEvent = events.find(
      (e): e is Extract<AddChannelStepEvent, { step: 'github-webhooks'; phase: 'done' }> =>
        e.step === 'github-webhooks' && e.phase === 'done',
    )
    expect(doneEvent).toBeDefined()
    expect(doneEvent!.result).toEqual({
      repos: [
        { repo: 'acme/widgets', action: 'created', hookId: 100 },
        { repo: 'acme/gadgets', action: 'created', hookId: 101 },
      ],
    })
  })

  test('adds github channel (cloudflare-quick): does NOT eagerly register webhooks (URL is unknown until cloudflared boots)', async () => {
    const events: AddChannelStepEvent[] = []
    const fetchImpl = recordingGithubFetch()

    await runAddChannel({
      cwd: root,
      channel: 'github',
      auth: { type: 'pat', pat: 'ghp_test' },
      webhookSecret: 'wh-secret',
      tunnelProvider: 'cloudflare-quick',
      webhookPort: 8975,
      repos: ['acme/widgets'],
      fetchImpl: fetchImpl.fn,
      onProgress: (e) => events.push(e),
    })

    expect(fetchImpl.calls).toEqual([])
    expect(events.some((e) => e.step === 'github-webhooks')).toBe(false)
  })

  test('adds github channel (none): does NOT eagerly register webhooks (no URL configured)', async () => {
    const events: AddChannelStepEvent[] = []
    const fetchImpl = recordingGithubFetch()

    await runAddChannel({
      cwd: root,
      channel: 'github',
      auth: { type: 'pat', pat: 'ghp_test' },
      webhookSecret: 'wh-secret',
      tunnelProvider: 'none',
      webhookPort: 8975,
      repos: ['acme/widgets'],
      fetchImpl: fetchImpl.fn,
      onProgress: (e) => events.push(e),
    })

    expect(fetchImpl.calls).toEqual([])
    expect(events.some((e) => e.step === 'github-webhooks')).toBe(false)
  })

  test('github eager webhook install failure surfaces as a structured event but does NOT roll back the config/secrets writes', async () => {
    const events: AddChannelStepEvent[] = []
    const fetchImpl = recordingGithubFetch({
      onHookList: () => new Response('forbidden', { status: 403 }),
    })

    await runAddChannel({
      cwd: root,
      channel: 'github',
      auth: { type: 'pat', pat: 'ghp_test' },
      webhookSecret: 'wh-secret',
      tunnelProvider: 'external',
      webhookUrl: 'https://agent.example.com/gh',
      webhookPort: 8975,
      repos: ['acme/widgets'],
      fetchImpl: fetchImpl.fn,
      onProgress: (e) => events.push(e),
    })

    const cfg = (await readConfig()) as { channels?: { github?: { repos?: string[] } } }
    expect(cfg.channels?.github?.repos).toEqual(['acme/widgets'])
    const secrets = await readSecretsChannels()
    expect((secrets.github as { auth: { type: string } }).auth.type).toBe('pat')

    const doneEvent = events.find(
      (e): e is Extract<AddChannelStepEvent, { step: 'github-webhooks'; phase: 'done' }> =>
        e.step === 'github-webhooks' && e.phase === 'done',
    )
    expect(doneEvent).toBeDefined()
    expect('error' in doneEvent!.result).toBe(false)
    if ('error' in doneEvent!.result) throw new Error('unreachable')
    expect(doneEvent!.result.repos).toEqual([expect.objectContaining({ repo: 'acme/widgets', action: 'failed' })])
  })

  test('adds github channel with a cloudflare-quick tunnel and cloudflared Dockerfile toggle', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'github',
      auth: { type: 'pat', pat: 'ghp_test' },
      webhookSecret: 'wh-secret',
      tunnelProvider: 'cloudflare-quick',
      webhookPort: 8975,
      repos: ['acme/widgets'],
    })

    const cfg = (await readConfig()) as {
      channels?: { github?: { webhookUrl?: string; repos?: string[] } }
      docker?: { file?: { cloudflared?: boolean } }
      tunnels?: Array<{ name?: string; provider?: string; for?: { kind?: string; name?: string } }>
    }

    expect(cfg.channels?.github?.webhookUrl).toBeUndefined()
    expect(cfg.channels?.github?.repos).toEqual(['acme/widgets'])
    expect(cfg.docker?.file?.cloudflared).toBe(true)
    expect(cfg.tunnels).toEqual([
      { name: 'github-webhook', provider: 'cloudflare-quick', for: { kind: 'channel', name: 'github' } },
    ])
  })

  test('adds github channel with a cloudflare-named tunnel and cloudflared Dockerfile toggle', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'github',
      auth: { type: 'pat', pat: 'ghp_test' },
      webhookSecret: 'wh-secret',
      tunnelProvider: 'cloudflare-named',
      hostname: 'https://agent.example.com',
      tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
      webhookPort: 8975,
      repos: ['acme/widgets'],
    })

    const cfg = (await readConfig()) as {
      channels?: { github?: { webhookUrl?: string; repos?: string[] } }
      docker?: { file?: { cloudflared?: boolean } }
      tunnels?: Array<{
        name?: string
        provider?: string
        hostname?: string
        tokenEnv?: string
        for?: { kind?: string; name?: string }
      }>
    }

    expect(cfg.channels?.github?.webhookUrl).toBeUndefined()
    expect(cfg.channels?.github?.repos).toEqual(['acme/widgets'])
    expect(cfg.docker?.file?.cloudflared).toBe(true)
    expect(cfg.tunnels).toEqual([
      {
        name: 'github-webhook',
        provider: 'cloudflare-named',
        for: { kind: 'channel', name: 'github' },
        hostname: 'https://agent.example.com',
        tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
      },
    ])
  })

  test('adds github channel (cloudflare-named): eagerly registers webhook using hostname as the public URL', async () => {
    const fetchImpl = recordingGithubFetch()

    await runAddChannel({
      cwd: root,
      channel: 'github',
      auth: { type: 'pat', pat: 'ghp_test' },
      webhookSecret: 'wh-secret-named',
      tunnelProvider: 'cloudflare-named',
      hostname: 'https://agent.example.com',
      tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
      webhookPort: 8975,
      repos: ['acme/widgets'],
      fetchImpl: fetchImpl.fn,
    })

    const posts = fetchImpl.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/hooks'))
    expect(posts).toHaveLength(1)
    const body = JSON.parse(posts[0]!.body ?? '{}') as {
      config?: { url?: string; secret?: string }
    }
    // Hostname has no path, so applyManagedPath appends the
    // /typeclaw/v1/github/<agentId> marker (same path-marker contract that
    // makes cloudflare-quick hooks recognizable across URL rotations). The
    // user types the bare hostname; typeclaw owns the path.
    expect(body.config?.url).toMatch(/^https:\/\/agent\.example\.com\/typeclaw\/v1\/github\/[a-z0-9_.-]+$/)
    expect(body.config?.secret).toBe('wh-secret-named')
  })

  test('adds github channel (cloudflare-named): rejects missing hostname', async () => {
    await expect(
      runAddChannel({
        cwd: root,
        channel: 'github',
        auth: { type: 'pat', pat: 'ghp_test' },
        webhookSecret: 'wh-secret',
        tunnelProvider: 'cloudflare-named',
        tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN',
        webhookPort: 8975,
        repos: ['acme/widgets'],
      }),
    ).rejects.toThrow(/hostname/)
  })

  test('adds github channel (cloudflare-named): rejects missing tokenEnv', async () => {
    await expect(
      runAddChannel({
        cwd: root,
        channel: 'github',
        auth: { type: 'pat', pat: 'ghp_test' },
        webhookSecret: 'wh-secret',
        tunnelProvider: 'cloudflare-named',
        hostname: 'https://agent.example.com',
        webhookPort: 8975,
        repos: ['acme/widgets'],
      }),
    ).rejects.toThrow(/tokenEnv/)
  })

  test('adds github channel with no tunnel and no webhookUrl', async () => {
    await runAddChannel({
      cwd: root,
      channel: 'github',
      auth: { type: 'pat', pat: 'ghp_test' },
      webhookSecret: 'wh-secret',
      tunnelProvider: 'none',
      webhookPort: 8975,
      repos: ['acme/widgets'],
    })

    const cfg = (await readConfig()) as {
      channels?: { github?: { webhookUrl?: string; repos?: string[] } }
      tunnels?: unknown[]
    }

    expect(cfg.channels?.github?.webhookUrl).toBeUndefined()
    expect(cfg.channels?.github?.repos).toEqual(['acme/widgets'])
    expect(cfg.tunnels).toBeUndefined()
  })

  test('emits kakaotalk-auth before config + secrets when adding kakaotalk', async () => {
    const events: AddChannelStepEvent[] = []
    await runAddChannel({
      cwd: root,
      channel: 'kakaotalk',
      runKakaotalkAuth: async () => ({ ok: true }),
      onProgress: (e) => events.push(e),
    })

    expect(events.map((e) => `${e.step}:${e.phase}`)).toEqual([
      'kakaotalk-auth:start',
      'kakaotalk-auth:done',
      'config:start',
      'config:done',
      'secrets:start',
      'secrets:done',
    ])
  })
})

async function writeSlackAccount(cwd: string, accountId: string, workspaceName: string): Promise<void> {
  const raw = JSON.parse(await readFile(join(cwd, 'secrets.json'), 'utf8')) as {
    channels?: Record<string, unknown>
    [key: string]: unknown
  }
  const channels = raw.channels ?? {}
  const block = isRecord(channels.slack) ? channels.slack : {}
  const accounts = isRecord(block.accounts) ? block.accounts : {}
  raw.channels = {
    ...channels,
    slack: {
      ...block,
      currentAccount: accountId,
      accounts: {
        ...accounts,
        [accountId]: {
          account_id: accountId,
          token: `token-${accountId}`,
          cookie: `cookie-${accountId}`,
          workspace_id: accountId,
          workspace_name: workspaceName,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }
  await writeFile(join(cwd, 'secrets.json'), `${JSON.stringify(raw, null, 2)}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('auto-commit on success', () => {
  async function runGit(cwd: string, args: string[]): Promise<string> {
    const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
    return (await new Response(proc.stdout).text()).trim()
  }

  async function initGit(cwd: string): Promise<void> {
    for (const cmd of [
      ['init', '-b', 'main'],
      ['config', 'user.name', 'Test User'],
      ['config', 'user.email', 'test@example.com'],
      ['add', '.'],
      ['commit', '-m', 'initial'],
    ]) {
      const proc = Bun.spawn({ cmd: ['git', ...cmd], cwd, stdout: 'pipe', stderr: 'pipe' })
      await proc.exited
    }
  }

  test('commits typeclaw.json with a "channel: add <kind>" subject', async () => {
    await initGit(root)
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'discord-x' })

    expect(await runGit(root, ['log', '-1', '--format=%s'])).toBe('channel: add discord-bot')
    expect(await runGit(root, ['show', '--name-only', '--format=', 'HEAD'])).toBe('typeclaw.json')
  })

  test('failed channel add (kakaotalk auth rejects) does NOT produce a commit', async () => {
    await initGit(root)
    const head = await runGit(root, ['rev-parse', 'HEAD'])

    await expect(
      runAddChannel({
        cwd: root,
        channel: 'kakaotalk',
        runKakaotalkAuth: async () => ({ ok: false, reason: 'nope' }),
      }),
    ).rejects.toThrow(/nope/)

    expect(await runGit(root, ['rev-parse', 'HEAD'])).toBe(head)
  })
})

describe('readConfiguredChannels', () => {
  test('returns empty set when no channels are configured', async () => {
    const present = await readConfiguredChannels(root)
    expect(present.size).toBe(0)
  })

  test('returns the set of configured channel keys', async () => {
    await runAddChannel({ cwd: root, channel: 'discord-bot', discordBotToken: 'd' })
    await runAddChannel({ cwd: root, channel: 'telegram-bot', telegramBotToken: '1:t' })

    const present = await readConfiguredChannels(root)
    expect([...present].sort()).toEqual(['discord-bot', 'telegram-bot'])
  })

  test('returns empty set when typeclaw.json is missing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'typeclaw-add-noconfig-'))
    try {
      const present = await readConfiguredChannels(empty)
      expect(present.size).toBe(0)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
