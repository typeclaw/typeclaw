import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentSession } from '@/agent'

import { instanceKeyId, type ChannelInstanceConfig } from './instances'
import { createChannelManager } from './manager'
import { defaultHistoryConfig, type ChannelAdapterConfig, type ChannelsConfig } from './schema'
import type { ChannelKey, InboundMessage } from './types'

type FakeAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
  startCalls: number
  stopCalls: number
}

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeFakeAdapter(): FakeAdapter & { connected: boolean } {
  const adapter = {
    connected: true,
    startCalls: 0,
    stopCalls: 0,
    async start() {
      adapter.startCalls++
      adapter.connected = true
    },
    async stop() {
      adapter.stopCalls++
    },
    isConnected() {
      return adapter.connected
    },
  }
  return adapter
}

function makeRecordingAdapter(
  events: string[],
  name: string,
  gates: { start?: Promise<void>; stop?: Promise<void> } = {},
): FakeAdapter {
  const adapter = {
    startCalls: 0,
    stopCalls: 0,
    async start() {
      adapter.startCalls++
      events.push(`${name}:start:begin`)
      await gates.start
      events.push(`${name}:start:end`)
    },
    async stop() {
      adapter.stopCalls++
      events.push(`${name}:stop:begin`)
      await gates.stop
      events.push(`${name}:stop:end`)
    },
    isConnected() {
      return true
    },
  }
  return adapter
}

let agentDir: string
let cfg: ChannelsConfig

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-channels-mgr-'))
  cfg = {}
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

const enabledAdapterCfg = () => ({
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'] as Array<'mention' | 'reply' | 'dm'>,
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
})

const enabledGithubCfg = () => ({
  ...enabledAdapterCfg(),
  webhookPort: 0,
  eventAllowlist: ['issue_comment.created'],
  repos: [],
  review: { on: 'review_requested' as const, approve: true },
})

const writeGithubSecrets = async (dir: string): Promise<void> => {
  await writeFile(
    join(dir, 'secrets.json'),
    JSON.stringify({
      version: 2,
      providers: {},
      channels: {
        github: {
          auth: { type: 'pat', token: { value: 'ghp_test' } },
          webhookSecret: { value: 'wh-secret' },
        },
      },
    }),
  )
}

const writeSlackSecrets = async (dir: string): Promise<void> => {
  await writeFile(
    join(dir, 'secrets.json'),
    JSON.stringify({
      version: 2,
      providers: {},
      channels: {
        slack: {
          currentAccount: 'T0123456789',
          accounts: {
            T0123456789: {
              account_id: 'T0123456789',
              token: 'xoxc-test',
              cookie: 'xoxd-test',
              workspace_id: 'T0123456789',
              workspace_name: 'Acme',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-01T00:00:00.000Z',
            },
          },
        },
      },
    }),
  )
}

function recordingLogger(): {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
  messages: string[]
} {
  const messages: string[] = []
  return {
    info: (msg) => messages.push(`info:${msg}`),
    warn: (msg) => messages.push(`warn:${msg}`),
    error: (msg) => messages.push(`error:${msg}`),
    messages,
  }
}

describe('channel manager — connection recovery', () => {
  test('restarts a live adapter that remains disconnected past the grace period', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    let now = 1_000
    let tick: (() => void) | null = null
    const logger = recordingLogger()
    const firstAdapter = makeFakeAdapter()
    const secondAdapter = makeFakeAdapter()
    const adapters = [firstAdapter, secondAdapter]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      logger,
      createDiscordAdapter: () => adapters.shift()!,
      connectionRecovery: {
        checkIntervalMs: 10,
        disconnectedGraceMs: 100,
        now: () => now,
        setInterval: (fn) => {
          tick = fn
          return 'timer'
        },
        clearInterval: () => {},
      },
    })

    await mgr.start()
    expect(firstAdapter.startCalls).toBe(1)
    expect(secondAdapter.startCalls).toBe(0)
    expect(tick).not.toBeNull()
    const runTick = () => {
      if (tick === null) throw new Error('recovery timer was not registered')
      tick()
    }

    firstAdapter.connected = false
    runTick()
    await Promise.resolve()
    expect(firstAdapter.stopCalls).toBe(0)
    expect(secondAdapter.startCalls).toBe(0)
    expect(logger.messages).toContain('warn:[channels] adapter "discord-bot" is disconnected; waiting for SDK recovery')

    now += 101
    runTick()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(firstAdapter.stopCalls).toBe(1)
    expect(secondAdapter.startCalls).toBe(1)
    expect(logger.messages).toContain(
      'warn:[channels] adapter "discord-bot" disconnected for 101ms; restarting adapter',
    )

    await mgr.stop()
  })
  test('does not queue duplicate recovery restarts while the first restart is pending', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    let now = 1_000
    let tick: (() => void) | null = null
    const stopGate = deferred()
    const firstAdapter = makeFakeAdapter()
    firstAdapter.stop = async () => {
      firstAdapter.stopCalls++
      await stopGate.promise
    }
    const secondAdapter = makeFakeAdapter()
    const thirdAdapter = makeFakeAdapter()
    const adapters = [firstAdapter, secondAdapter, thirdAdapter]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { DISCORD_BOT_TOKEN: 'token' },
      createDiscordAdapter: () => adapters.shift()!,
      connectionRecovery: {
        checkIntervalMs: 10,
        disconnectedGraceMs: 100,
        now: () => now,
        setInterval: (fn) => {
          tick = fn
          return 'timer'
        },
        clearInterval: () => {},
      },
    })

    await mgr.start()
    const runTick = () => {
      if (tick === null) throw new Error('recovery timer was not registered')
      tick()
    }

    firstAdapter.connected = false
    runTick()
    now += 101
    runTick()
    await Promise.resolve()

    expect(firstAdapter.stopCalls).toBe(1)
    expect(secondAdapter.startCalls).toBe(0)

    now += 101
    runTick()
    await Promise.resolve()

    expect(firstAdapter.stopCalls).toBe(1)
    expect(secondAdapter.startCalls).toBe(0)
    expect(thirdAdapter.startCalls).toBe(0)

    stopGate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(secondAdapter.startCalls).toBe(1)
    expect(thirdAdapter.startCalls).toBe(0)

    await mgr.stop()
  })
})

describe('channel manager — restartAdapter serialization', () => {
  test('restartAdapter stops a live github adapter before starting it again', async () => {
    cfg.github = enabledGithubCfg()
    await writeGithubSecrets(agentDir)
    const events: string[] = []
    const stopGate = deferred()
    const adapters = [
      makeRecordingAdapter(events, 'github#1', { stop: stopGate.promise }),
      makeRecordingAdapter(events, 'github#2'),
    ]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      createGithubAdapter: () => adapters.shift()!,
    })

    await mgr.start()
    const restart = mgr.restartAdapter('github')
    await Promise.resolve()
    expect(events).toEqual(['github#1:start:begin', 'github#1:start:end', 'github#1:stop:begin'])

    stopGate.resolve()
    await restart

    expect(events).toEqual([
      'github#1:start:begin',
      'github#1:start:end',
      'github#1:stop:begin',
      'github#1:stop:end',
      'github#2:start:begin',
      'github#2:start:end',
    ])
    await mgr.stop()
  })

  test('serializes concurrent restartAdapter calls for the same adapter', async () => {
    cfg.github = enabledGithubCfg()
    await writeGithubSecrets(agentDir)
    const events: string[] = []
    const firstStopGate = deferred()
    const secondStopGate = deferred()
    const adapters = [
      makeRecordingAdapter(events, 'github#1', { stop: firstStopGate.promise }),
      makeRecordingAdapter(events, 'github#2', { stop: secondStopGate.promise }),
      makeRecordingAdapter(events, 'github#3'),
    ]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      createGithubAdapter: () => adapters.shift()!,
    })

    await mgr.start()
    const first = mgr.restartAdapter('github')
    const second = mgr.restartAdapter('github')
    await Promise.resolve()
    expect(events).toEqual(['github#1:start:begin', 'github#1:start:end', 'github#1:stop:begin'])

    firstStopGate.resolve()
    await first
    await Promise.resolve()
    expect(events).toEqual([
      'github#1:start:begin',
      'github#1:start:end',
      'github#1:stop:begin',
      'github#1:stop:end',
      'github#2:start:begin',
      'github#2:start:end',
      'github#2:stop:begin',
    ])

    secondStopGate.resolve()
    await Promise.all([first, second])
    expect(events).toEqual([
      'github#1:start:begin',
      'github#1:start:end',
      'github#1:stop:begin',
      'github#1:stop:end',
      'github#2:start:begin',
      'github#2:start:end',
      'github#2:stop:begin',
      'github#2:stop:end',
      'github#3:start:begin',
      'github#3:start:end',
    ])
    await mgr.stop()
  })

  test('restartAdapter is a no-op when the adapter is not live', async () => {
    const logger = recordingLogger()
    const mgr = createChannelManager({ agentDir, channelsConfigRef: () => cfg, logger })

    await mgr.restartAdapter('github')

    expect(logger.messages).toContain("info:[channels] restartAdapter('github'): adapter not live, skipping")
    await mgr.stop()
  })

  test('restartAdapter serialization is per adapter, not global', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    cfg['telegram-bot'] = enabledAdapterCfg()
    const events: string[] = []
    const slackStopGate = deferred()
    const slackAdapters = [
      makeRecordingAdapter(events, 'slack#1', { stop: slackStopGate.promise }),
      makeRecordingAdapter(events, 'slack#2'),
    ]
    const telegramAdapters = [makeRecordingAdapter(events, 'telegram#1'), makeRecordingAdapter(events, 'telegram#2')]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b', TELEGRAM_BOT_TOKEN: 'tg-a' },
      createSlackAdapter: () => slackAdapters.shift()!,
      createTelegramAdapter: () => telegramAdapters.shift()!,
    })

    await mgr.start()
    const slackRestart = mgr.restartAdapter('slack-bot')
    await Promise.resolve()
    const telegramRestart = mgr.restartAdapter('telegram-bot')
    await telegramRestart

    expect(events).toContain('telegram#2:start:end')
    expect(events).not.toContain('slack#2:start:begin')

    slackStopGate.resolve()
    await slackRestart
    await mgr.stop()
  })

  test('tracks two same-adapter instances with distinct lifecycle keys and independent stop', async () => {
    const slackCfg = enabledAdapterCfg()
    cfg['slack-bot'] = slackCfg
    const a = makeFakeAdapter()
    const b = makeFakeAdapter()
    const adapters = [a, b]
    let instances: ChannelInstanceConfig[] = [
      { adapter: 'slack-bot', instanceId: 'a', config: slackCfg },
      { adapter: 'slack-bot', instanceId: 'b', config: slackCfg },
    ]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' },
      createSlackAdapter: () => adapters.shift()!,
      normalizeChannelsOverride: () => instances,
    })

    await mgr.start()

    expect(mgr.__testing?.liveKeys()).toEqual([instanceKeyId('slack-bot', 'a'), instanceKeyId('slack-bot', 'b')])
    expect(mgr.__testing?.liveCount()).toBe(2)
    expect(a.startCalls).toBe(1)
    expect(b.startCalls).toBe(1)

    instances = [{ adapter: 'slack-bot', instanceId: 'a', config: slackCfg }]
    const result = await mgr.reload()

    expect(result.stopped).toEqual([instanceKeyId('slack-bot', 'b')])
    expect(mgr.__testing?.liveKeys()).toEqual([instanceKeyId('slack-bot', 'a')])
    expect(a.stopCalls).toBe(0)
    expect(b.stopCalls).toBe(1)

    await mgr.stop()
  })

  test('reload starts only a newly added same-adapter instance', async () => {
    const slackCfg = enabledAdapterCfg()
    cfg['slack-bot'] = slackCfg
    const a = makeFakeAdapter()
    const b = makeFakeAdapter()
    const adapters = [a, b]
    let instances: ChannelInstanceConfig[] = [{ adapter: 'slack-bot', instanceId: 'a', config: slackCfg }]
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' },
      createSlackAdapter: () => adapters.shift()!,
      normalizeChannelsOverride: () => instances,
    })

    await mgr.start()
    instances = [
      { adapter: 'slack-bot', instanceId: 'a', config: slackCfg },
      { adapter: 'slack-bot', instanceId: 'b', config: slackCfg },
    ]

    const result = await mgr.reload()

    expect(result.started).toEqual([instanceKeyId('slack-bot', 'b')])
    expect(mgr.__testing?.liveKeys()).toEqual([instanceKeyId('slack-bot', 'a'), instanceKeyId('slack-bot', 'b')])
    expect(a.startCalls).toBe(1)
    expect(b.startCalls).toBe(1)

    await mgr.stop()
  })

  test('starts adapters concurrently rather than serially', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    cfg['telegram-bot'] = enabledAdapterCfg()
    const events: string[] = []
    const slackStartGate = deferred()
    const telegramStartGate = deferred()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b', TELEGRAM_BOT_TOKEN: 'tg-a' },
      createSlackAdapter: () => makeRecordingAdapter(events, 'slack', { start: slackStartGate.promise }),
      createTelegramAdapter: () => makeRecordingAdapter(events, 'telegram', { start: telegramStartGate.promise }),
    })

    const startCall = mgr.start()
    await Promise.resolve()

    // Both adapters have begun starting while neither has finished — impossible
    // under serial start, where slack would block telegram until its gate opens.
    expect(events).toEqual(['slack:start:begin', 'telegram:start:begin'])

    slackStartGate.resolve()
    telegramStartGate.resolve()
    await startCall

    expect(events).toContain('slack:start:end')
    expect(events).toContain('telegram:start:end')
    await mgr.stop()
  })

  test('start() rejects when adapter construction throws outside startAdapter catch', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' },
      createSlackAdapter: () => {
        throw new Error('hostd env missing')
      },
    })

    await expect(mgr.start()).rejects.toThrow('hostd env missing')
    await mgr.stop()
  })

  test('start() failure waits for in-flight siblings so none orphan past stop()', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    cfg['telegram-bot'] = enabledAdapterCfg()
    const events: string[] = []
    const slackStartGate = deferred()
    const slack = makeRecordingAdapter(events, 'slack', { start: slackStartGate.promise })
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b', TELEGRAM_BOT_TOKEN: 'tg-a' },
      createSlackAdapter: () => slack,
      createTelegramAdapter: () => {
        throw new Error('hostd env missing')
      },
    })

    const startCall = mgr.start()
    // Let the telegram factory throw while slack's start() is still gated open.
    await Promise.resolve()
    expect(events).toEqual(['slack:start:begin'])

    // Releasing slack lets it register in `live`; start() must not reject until
    // that settles, otherwise the late registration would orphan slack.
    slackStartGate.resolve()
    await expect(startCall).rejects.toThrow('hostd env missing')
    expect(slack.startCalls).toBe(1)

    await mgr.stop()
    expect(events).toContain('slack:stop:begin')
  })

  test('passes tunnelUrlForChannel through to the github adapter', async () => {
    cfg.github = enabledGithubCfg()
    await writeGithubSecrets(agentDir)
    let captured: { tunnelUrl?: () => string | null } | undefined
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      tunnelUrlForChannel: (name) => (name === 'github' ? 'https://x.trycloudflare.com' : null),
      createGithubAdapter: (opts) => {
        captured = opts
        return makeFakeAdapter()
      },
    })

    await mgr.start()

    expect(captured?.tunnelUrl?.()).toBe('https://x.trycloudflare.com')
    await mgr.stop()
  })

  test('passes tunnelConfiguredForChannel through to the github adapter', async () => {
    cfg.github = enabledGithubCfg()
    await writeGithubSecrets(agentDir)
    let captured: { tunnelConfiguredForChannel?: () => boolean } | undefined
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      tunnelConfiguredForChannel: (name) => name === 'github',
      createGithubAdapter: (opts) => {
        captured = opts
        return makeFakeAdapter()
      },
    })

    await mgr.start()

    expect(captured?.tunnelConfiguredForChannel?.()).toBe(true)
    await mgr.stop()
  })

  test("accepts GitHub App auth in secrets.json (regression: runtime guard previously rejected type: 'app')", async () => {
    cfg.github = enabledGithubCfg()
    await writeFile(
      join(agentDir, 'secrets.json'),
      JSON.stringify({
        version: 2,
        providers: {},
        channels: {
          github: {
            auth: {
              type: 'app',
              appId: 12345,
              privateKey: { value: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----' },
            },
            webhookSecret: { value: 'wh-secret' },
          },
        },
      }),
    )
    let constructed = false
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      createGithubAdapter: () => {
        constructed = true
        return makeFakeAdapter()
      },
    })

    await mgr.start()

    expect(constructed).toBe(true)
    await mgr.stop()
  })
})

describe('channel manager — slack adapter lifecycle', () => {
  test('starts slack user adapter from secrets using the createSlackUserAdapter seam', async () => {
    cfg.slack = enabledAdapterCfg()
    await writeSlackSecrets(agentDir)
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = {
      TYPECLAW_HOSTD_URL: 'http://hostd.test',
      TYPECLAW_HOSTD_TOKEN: 'restart-token',
      TYPECLAW_CONTAINER_NAME: 'agent',
    }
    let constructed = false
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackUserAdapter: () => {
        constructed = true
        return fake
      },
    })

    await mgr.start()

    expect(constructed).toBe(true)
    expect(fake.startCalls).toBe(1)
    await mgr.stop()
  })

  test('starts slack adapter when both SLACK_BOT_TOKEN and SLACK_APP_TOKEN are set', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(1)

    await mgr.stop()
  })

  test('does not start slack adapter when SLACK_APP_TOKEN is missing', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-a' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(0)

    await mgr.stop()
  })
})

describe('channel manager — reload detects missing tokens and stops adapter', () => {
  test('stops slack adapter when SLACK_BOT_TOKEN is removed from env on reload', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(1)

    delete env.SLACK_BOT_TOKEN

    const result = await mgr.reload()
    expect(result.stopped).toContain('slack-bot')
    expect(result.restartRequired).not.toContain('slack-bot (token rotation)')
    expect(fake.stopCalls).toBe(1)
  })

  test('stops slack adapter when SLACK_APP_TOKEN is removed from env on reload', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackAdapter: () => fake,
    })

    await mgr.start()

    delete env.SLACK_APP_TOKEN

    const result = await mgr.reload()
    expect(result.stopped).toContain('slack-bot')
    expect(fake.stopCalls).toBe(1)
  })

  test('reports token rotation (not stop) when token value changes but is still present', async () => {
    cfg['slack-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createSlackAdapter: () => fake,
    })

    await mgr.start()

    env.SLACK_BOT_TOKEN = 'xoxb-rotated'

    const result = await mgr.reload()
    expect(result.stopped).not.toContain('slack-bot')
    expect(result.restartRequired).toContain('slack-bot (token rotation)')
    expect(fake.stopCalls).toBe(0)
  })

  test('forwards aliasesRef to the router so configured aliases trigger engagement', async () => {
    // given: a manager wired with `aliasesRef` returning ["모모", "momo"], a
    //   slack-bot config with strict-mention trigger and stickiness off
    //   (so the ONLY remaining engagement paths are alias-substring match
    //   at engagement.ts:102 or the solo-human fallback at :174), and a
    //   participant cache primed with two distinct humans so the
    //   solo-human fallback is disabled and the alias path is the only
    //   engagement gate that can fire
    const slackCfg: ChannelAdapterConfig = {
      enabled: true,
      engagement: { trigger: ['mention'], stickiness: 'off' },
      history: defaultHistoryConfig(),
    }
    cfg['slack-bot'] = slackCfg
    const prompts: string[] = []
    const fakeSession = {
      prompt: async (text: string) => {
        prompts.push(text)
      },
      abort: async () => {},
      agent: { streamFn: () => undefined, abort: () => {} },
      sessionManager: { getLeafEntry: () => undefined },
      subscribe: () => () => {},
    } as unknown as AgentSession
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      aliasesRef: () => ['모모', 'momo'],
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' },
      createSlackAdapter: () => makeFakeAdapter(),
      createSessionForChannel: async () => ({
        session: fakeSession,
        sessionId: 'ses_test_alias',
        dispose: async () => {},
      }),
    })

    const key: ChannelKey = { adapter: 'slack-bot', workspace: 'TXXX', chat: 'C111', thread: '1.0' }
    const baseInbound = (over: Partial<InboundMessage>): InboundMessage => ({
      ...key,
      text: '',
      externalMessageId: 'm0',
      authorId: 'U?',
      authorName: '?',
      authorIsBot: false,
      isBotMention: false,
      replyToBotMessageId: null,
      mentionsOthers: false,
      replyToOtherMessageId: null,
      isDm: false,
      ts: Date.parse('2026-05-01T00:00:00.000Z'),
      ...over,
    })

    // when: a first @-mention inbound from human A primes the channel (so
    //   the session exists), then a non-alias inbound from human B brings
    //   the participant count to two (defeating the solo-human fallback),
    //   and finally a NON-mention inbound from A whose text contains only
    //   the configured alias "모모" arrives — every structural trigger
    //   (mention, reply, dm, sticky) is off, leaving alias-match as the
    //   sole gate
    await mgr.router.route(
      baseInbound({ externalMessageId: 'm1', text: 'hello bot', authorId: 'U_A', authorName: 'A', isBotMention: true }),
    )
    await mgr.router.__testing!.flushDebounce(key)
    await mgr.router.route(
      baseInbound({ externalMessageId: 'm2', text: 'side comment', authorId: 'U_B', authorName: 'B' }),
    )
    await mgr.router.__testing!.flushDebounce(key)
    const promptsBeforeAlias = prompts.length
    await mgr.router.route(baseInbound({ externalMessageId: 'm3', text: '모모야', authorId: 'U_A', authorName: 'A' }))
    await mgr.router.__testing!.flushDebounce(key)

    // then: the alias-only inbound produces exactly one new prompt; if the
    //   manager dropped `aliasesRef` on the floor (the bug this fix
    //   addresses), `selfAliases` would fall back to `[basename(agentDir)]`
    //   only, "모모야" would not match any alias, and with the solo-human
    //   fallback disabled by U_B's prior inbound the message would be
    //   silently observed — promptsAfterAlias would equal promptsBeforeAlias
    const promptsAfterAlias = prompts.length
    expect(promptsAfterAlias - promptsBeforeAlias).toBe(1)
    expect(prompts[prompts.length - 1]).toContain('모모야')

    await mgr.stop()
  })

  test('forwards selfAliasesRef to the webex adapter so alias-only inbounds engage like mentions', async () => {
    cfg['webex-bot'] = enabledAdapterCfg()
    let captured: { selfAliasesRef?: () => readonly string[] } | undefined
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      aliasesRef: () => ['타이피', 'typeey'],
      env: { WEBEX_BOT_TOKEN: 'webex-token' },
      createWebexBotAdapter: (opts) => {
        captured = opts
        return makeFakeAdapter()
      },
    })

    await mgr.start()

    expect(captured?.selfAliasesRef).toBeDefined()
    const aliases = captured!.selfAliasesRef!()
    expect(aliases).toContain('타이피')
    expect(aliases).toContain('typeey')

    await mgr.stop()
  })

  test('forwards selfAliasesRef to the slack adapter so the classifier can anchor threads on alias-only inbounds', async () => {
    // given: a manager wired with `aliasesRef` returning ["모모", "momo"]
    //   AND a `createSlackAdapter` test seam that captures the options the
    //   manager passes. The point of this test is the wiring itself: if a
    //   future refactor drops `selfAliasesRef` from manager.ts, every
    //   adapter-side and router-side test still passes (the seams keep
    //   their own fake aliases), but the production thread-anchoring path
    //   silently regresses. This test fails the moment that wiring
    //   disappears, so it's the only mutation guard between manager.ts
    //   and slack-bot-classify.ts.
    cfg['slack-bot'] = enabledAdapterCfg()
    let captured: { selfAliasesRef?: () => readonly string[] } | undefined
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      aliasesRef: () => ['모모', 'momo'],
      env: { SLACK_BOT_TOKEN: 'xoxb-a', SLACK_APP_TOKEN: 'xapp-b' },
      createSlackAdapter: (opts) => {
        captured = opts
        return makeFakeAdapter()
      },
    })

    // when: the adapter is constructed at start
    await mgr.start()

    // then: the captured options carry a live selfAliasesRef whose result
    //   includes both the configured aliases AND the implicit dir-name
    //   alias the router seeds at construction (basename(agentDir))
    expect(captured?.selfAliasesRef).toBeDefined()
    const aliases = captured!.selfAliasesRef!()
    expect(aliases).toContain('모모')
    expect(aliases).toContain('momo')

    await mgr.stop()
  })

  test('routes two slack instances by resolved workspace and forwards per-instance account ids', async () => {
    const slackCfg = enabledAdapterCfg()
    const instances: ChannelInstanceConfig[] = [
      { adapter: 'slack', instanceId: 'team-a', account: 'acct-a', config: slackCfg },
      { adapter: 'slack', instanceId: 'team-b', account: 'acct-b', config: slackCfg },
    ]
    cfg.slack = {
      instances: [
        { ...slackCfg, id: 'team-a', account: 'acct-a' },
        { ...slackCfg, id: 'team-b', account: 'acct-b' },
      ],
    }
    const capturedAccounts: Array<string | undefined> = []
    const outboundByWorkspace: Record<string, string[]> = { WS_A: [], WS_B: [] }
    const sessionKeys: string[] = []
    const prompts: string[] = []
    const fakeSession = {
      prompt: async (text: string) => {
        prompts.push(text)
      },
      abort: async () => {},
      agent: { streamFn: () => undefined, abort: () => {} },
      sessionManager: { getLeafEntry: () => undefined },
      subscribe: () => () => {},
    } as unknown as AgentSession
    const workspaces = ['WS_A', 'WS_B']
    await writeFile(
      join(agentDir, 'secrets.json'),
      JSON.stringify({
        version: 2,
        providers: {},
        channels: {
          slack: {
            currentAccount: 'acct-a',
            accounts: {
              'acct-a': {
                account_id: 'acct-a',
                token: 'xoxc-a',
                cookie: 'xoxd-a',
                workspace_id: 'WS_A',
                workspace_name: 'Team A',
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z',
              },
              'acct-b': {
                account_id: 'acct-b',
                token: 'xoxc-b',
                cookie: 'xoxd-b',
                workspace_id: 'WS_B',
                workspace_name: 'Team B',
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z',
              },
            },
          },
        },
      }),
    )
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      normalizeChannelsOverride: () => instances,
      env: {
        TYPECLAW_HOSTD_URL: 'http://host.docker.internal:8974',
        TYPECLAW_HOSTD_TOKEN: 'restart-token',
        TYPECLAW_CONTAINER_NAME: 'typeclaw-test',
      },
      createSessionForChannel: async (key) => {
        sessionKeys.push(`${key.key.workspace}:${key.key.chat}`)
        return { session: fakeSession, sessionId: `ses_${key.key.workspace}`, dispose: async () => {} }
      },
      createSlackUserAdapter: (opts) => {
        const workspace = workspaces.shift()
        if (workspace === undefined) throw new Error('unexpected slack adapter')
        capturedAccounts.push(opts.accountId)
        return {
          start: async () => {
            opts.router.registerOutbound('slack', workspace, async (msg) => {
              outboundByWorkspace[workspace]!.push(msg.text ?? '')
              return { ok: true }
            })
          },
          stop: async () => {},
          isConnected: () => true,
        }
      },
    })

    await mgr.start()
    await mgr.router.route({
      adapter: 'slack',
      workspace: 'WS_A',
      chat: 'C_A',
      thread: '1.0',
      externalMessageId: 'm-a',
      authorId: 'U_A',
      authorName: 'Alice',
      authorIsBot: false,
      text: 'hello bot',
      isBotMention: true,
      replyToBotMessageId: null,
      mentionsOthers: false,
      replyToOtherMessageId: null,
      isDm: false,
      ts: Date.parse('2026-06-01T00:00:00.000Z'),
    })
    await mgr.router.__testing!.flushDebounce({ adapter: 'slack', workspace: 'WS_A', chat: 'C_A', thread: '1.0' })
    await mgr.router.route({
      adapter: 'slack',
      workspace: 'WS_B',
      chat: 'C_B',
      thread: '2.0',
      externalMessageId: 'm-b',
      authorId: 'U_B',
      authorName: 'Bob',
      authorIsBot: false,
      text: '안녕하세요 봇',
      isBotMention: true,
      replyToBotMessageId: null,
      mentionsOthers: false,
      replyToOtherMessageId: null,
      isDm: false,
      ts: Date.parse('2026-06-01T00:01:00.000Z'),
    })
    await mgr.router.__testing!.flushDebounce({ adapter: 'slack', workspace: 'WS_B', chat: 'C_B', thread: '2.0' })

    const sendA = await mgr.router.send({ adapter: 'slack', workspace: 'WS_A', chat: 'C_A', text: 'reply A' })
    const sendB = await mgr.router.send({ adapter: 'slack', workspace: 'WS_B', chat: 'C_B', text: 'reply B' })

    expect(capturedAccounts).toEqual(['acct-a', 'acct-b'])
    expect(sessionKeys).toEqual(['WS_A:C_A', 'WS_B:C_B'])
    expect(prompts[prompts.length - 1]).toContain('안녕하세요 봇')
    expect(sendA.ok).toBe(true)
    expect(sendB.ok).toBe(true)
    expect(outboundByWorkspace).toEqual({ WS_A: ['reply A'], WS_B: ['reply B'] })

    await mgr.stop()
  })

  test('stops discord adapter when DISCORD_BOT_TOKEN disappears (parity with slack)', async () => {
    cfg['discord-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'd-tok' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createDiscordAdapter: () => fake,
    })

    await mgr.start()
    delete env.DISCORD_BOT_TOKEN

    const result = await mgr.reload()
    expect(result.stopped).toContain('discord-bot')
    expect(fake.stopCalls).toBe(1)
  })
})

describe('channel manager — telegram adapter lifecycle', () => {
  test('starts telegram adapter and forwards TELEGRAM_BOT_TOKEN to it', async () => {
    cfg['telegram-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    let captured: { token?: string; configRef?: () => unknown } | undefined
    const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: 'tg-tok-abc' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createTelegramAdapter: (opts) => {
        captured = opts
        return fake
      },
    })

    await mgr.start()
    expect(fake.startCalls).toBe(1)
    // Mutation guard: a refactor that swapped TELEGRAM_BOT_TOKEN for the
    // wrong env var (or hardcoded a string) would still pass any test
    // that didn't capture the actual token passed to the adapter.
    expect(captured?.token).toBe('tg-tok-abc')
    expect(typeof captured?.configRef).toBe('function')

    await mgr.stop()
    expect(fake.stopCalls).toBe(1)
  })

  test('does not start telegram adapter when TELEGRAM_BOT_TOKEN is missing', async () => {
    cfg['telegram-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = {}
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createTelegramAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(0)

    await mgr.stop()
  })

  test('stops telegram adapter when TELEGRAM_BOT_TOKEN is removed from env on reload', async () => {
    cfg['telegram-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: 'tg-tok' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createTelegramAdapter: () => fake,
    })

    await mgr.start()
    delete env.TELEGRAM_BOT_TOKEN

    const result = await mgr.reload()
    expect(result.stopped).toContain('telegram-bot')
    expect(fake.stopCalls).toBe(1)
  })

  test('reports token rotation (not stop) when TELEGRAM_BOT_TOKEN value changes but is still present', async () => {
    cfg['telegram-bot'] = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: 'tg-tok-1' }
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env,
      createTelegramAdapter: () => fake,
    })

    await mgr.start()

    env.TELEGRAM_BOT_TOKEN = 'tg-tok-2'

    const result = await mgr.reload()
    expect(result.stopped).not.toContain('telegram-bot')
    expect(result.restartRequired).toContain('telegram-bot (token rotation)')
    expect(fake.stopCalls).toBe(0)
  })
})

describe('channel manager — kakaotalk credential preflight', () => {
  const kakaoEnv: NodeJS.ProcessEnv = {
    TYPECLAW_HOSTD_URL: 'http://host.docker.internal:8974',
    TYPECLAW_HOSTD_TOKEN: 'restart-token',
    TYPECLAW_CONTAINER_NAME: 'typeclaw-test',
  }

  const writeKakaoSecrets = async (dir: string, accountId = 'a1'): Promise<string> => {
    const path = join(dir, 'secrets.json')
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        providers: {},
        channels: {
          kakaotalk: {
            currentAccount: accountId,
            accounts: {
              [accountId]: {
                account_id: accountId,
                oauth_token: `oauth-${accountId}`,
                user_id: accountId,
                device_uuid: `device-${accountId}`,
                device_type: 'tablet',
                created_at: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z',
              },
            },
          },
        },
      }),
    )
    return path
  }

  test('starts kakaotalk adapter when credentials exist in secrets.json', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(1)

    await mgr.stop()
  })

  test('does not start kakaotalk adapter when secrets.json lacks kakaotalk credentials', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: {},
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(0)

    await mgr.stop()
  })

  test('missing kakaotalk credentials preflight does not create secrets.json', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    const secretsPath = join(agentDir, 'secrets.json')
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: {},
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()

    expect(fake.startCalls).toBe(0)
    expect(existsSync(secretsPath)).toBe(false)

    await mgr.stop()
  })

  test('reload stops kakaotalk adapter when credentials are removed from secrets.json', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    const path = await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    expect(fake.startCalls).toBe(1)

    await writeFile(path, JSON.stringify({ version: 2, providers: {}, channels: {} }))

    const result = await mgr.reload()
    expect(result.stopped).toContain('kakaotalk')
    expect(fake.stopCalls).toBe(1)
  })

  test('reload reports credential rotation (not stop) when secrets kakaotalk block changes', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    await writeKakaoSecrets(agentDir, 'a2')

    const result = await mgr.reload()
    expect(result.stopped).not.toContain('kakaotalk')
    expect(result.restartRequired).toContain('kakaotalk (credential rotation)')

    await mgr.stop()
  })

  test('reload does not report rotation when secrets kakaotalk block is unchanged', async () => {
    cfg.kakaotalk = enabledAdapterCfg()
    await writeKakaoSecrets(agentDir)
    const fake = makeFakeAdapter()
    const mgr = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: kakaoEnv,
      createKakaotalkAdapter: () => fake,
    })

    await mgr.start()
    await writeKakaoSecrets(agentDir)

    const result = await mgr.reload()
    expect(result.restartRequired).not.toContain('kakaotalk (credential rotation)')

    await mgr.stop()
  })
})
