import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChannelManager, type DiscordBotFactory } from './manager'
import { createChannelRouter } from './router'
import type { Channels } from './schema'

const tempDirs: string[] = []

beforeEach(() => {
  tempDirs.length = 0
})

afterEach(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
})

function fakeAdapter() {
  const events: string[] = []
  return {
    adapter: {
      async start() {
        events.push('start')
      },
      async stop() {
        events.push('stop')
      },
      async handleInbound() {},
      outboundCallback: async () => {},
    },
    events,
  }
}

async function makeRouter() {
  const dir = await mkdtemp(join(tmpdir(), 'channels-mgr-'))
  tempDirs.push(dir)
  return createChannelRouter({
    cwd: dir,
    createSessionForChannel: async () => ({
      session: { subscribe: () => () => {}, async prompt() {}, async abort() {} } as any,
      sessionId: 'sess',
    }),
  })
}

const empty: Channels = {}
const enabledStar: Channels = { 'discord-bot': { allow: ['*'], enabled: true } }
const disabled: Channels = { 'discord-bot': { allow: ['*'], enabled: false } }
const narrowed: Channels = { 'discord-bot': { allow: ['guild:G1'], enabled: true } }

describe('ChannelManager', () => {
  test('start: enabled discord-bot is started', async () => {
    const router = await makeRouter()
    let createCount = 0
    const factory: DiscordBotFactory = async () => {
      createCount++
      const f = fakeAdapter()
      return { adapter: f.adapter as any, close: async () => {} }
    }
    const mgr = createChannelManager({
      router,
      channels: enabledStar,
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await mgr.start()

    expect(createCount).toBe(1)
    expect(mgr.activeAdapters()).toEqual(['discord-bot'])
  })

  test('start: missing discord-bot is a no-op', async () => {
    const router = await makeRouter()
    let createCount = 0
    const factory: DiscordBotFactory = async () => {
      createCount++
      const f = fakeAdapter()
      return { adapter: f.adapter as any, close: async () => {} }
    }
    const mgr = createChannelManager({
      router,
      channels: empty,
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await mgr.start()

    expect(createCount).toBe(0)
    expect(mgr.activeAdapters()).toEqual([])
  })

  test('start: disabled discord-bot is not started', async () => {
    const router = await makeRouter()
    let createCount = 0
    const factory: DiscordBotFactory = async () => {
      createCount++
      const f = fakeAdapter()
      return { adapter: f.adapter as any, close: async () => {} }
    }
    const mgr = createChannelManager({
      router,
      channels: disabled,
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await mgr.start()

    expect(createCount).toBe(0)
    expect(mgr.activeAdapters()).toEqual([])
  })

  test('stop: stops active adapters and closes them', async () => {
    const router = await makeRouter()
    const fakes = fakeAdapter()
    let closeCalls = 0
    const factory: DiscordBotFactory = async () => ({
      adapter: fakes.adapter as any,
      close: async () => {
        closeCalls++
      },
    })
    const mgr = createChannelManager({
      router,
      channels: enabledStar,
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await mgr.start()
    await mgr.stop()

    expect(fakes.events).toEqual(['start', 'stop'])
    expect(closeCalls).toBe(1)
    expect(mgr.activeAdapters()).toEqual([])
  })

  test('applyChannels: added when discord-bot appears for the first time', async () => {
    const router = await makeRouter()
    const factory: DiscordBotFactory = async () => {
      const f = fakeAdapter()
      return { adapter: f.adapter as any, close: async () => {} }
    }
    const mgr = createChannelManager({
      router,
      channels: empty,
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await mgr.start()
    expect(mgr.activeAdapters()).toEqual([])

    const diff = await mgr.applyChannels(enabledStar)

    expect(diff.added).toEqual(['discord-bot'])
    expect(mgr.activeAdapters()).toEqual(['discord-bot'])
  })

  test('applyChannels: removed when discord-bot disappears', async () => {
    const router = await makeRouter()
    const fakes = fakeAdapter()
    const factory: DiscordBotFactory = async () => ({ adapter: fakes.adapter as any, close: async () => {} })
    const mgr = createChannelManager({
      router,
      channels: enabledStar,
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await mgr.start()

    const diff = await mgr.applyChannels(empty)

    expect(diff.removed).toEqual(['discord-bot'])
    expect(mgr.activeAdapters()).toEqual([])
    expect(fakes.events).toEqual(['start', 'stop'])
  })

  test('applyChannels: changed allow list is treated as updated (restart)', async () => {
    const router = await makeRouter()
    const startedConfigs: any[] = []
    const stoppedConfigs: any[] = []
    const factory: DiscordBotFactory = async (config) => ({
      adapter: {
        async start() {
          startedConfigs.push(config)
        },
        async stop() {
          stoppedConfigs.push(config)
        },
        async handleInbound() {},
        outboundCallback: async () => {},
      } as any,
      close: async () => {},
    })
    const mgr = createChannelManager({
      router,
      channels: enabledStar,
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await mgr.start()
    expect(startedConfigs).toHaveLength(1)

    const diff = await mgr.applyChannels(narrowed)

    expect(diff.updated).toEqual(['discord-bot'])
    expect(stoppedConfigs).toHaveLength(1)
    expect(startedConfigs).toHaveLength(2)
    expect(startedConfigs[1]?.allow).toEqual(['guild:G1'])
  })

  test('applyChannels: unchanged when fingerprint matches', async () => {
    const router = await makeRouter()
    const fakes = fakeAdapter()
    const factory: DiscordBotFactory = async () => ({ adapter: fakes.adapter as any, close: async () => {} })
    const mgr = createChannelManager({
      router,
      channels: enabledStar,
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await mgr.start()

    const diff = await mgr.applyChannels(enabledStar)

    expect(diff.unchanged).toEqual(['discord-bot'])
    expect(diff.updated).toEqual([])
    expect(fakes.events).toEqual(['start'])
  })

  test('applyChannels: enabled flag flip stops the adapter without restarting', async () => {
    const router = await makeRouter()
    const fakes = fakeAdapter()
    const factory: DiscordBotFactory = async () => ({ adapter: fakes.adapter as any, close: async () => {} })
    const mgr = createChannelManager({
      router,
      channels: enabledStar,
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await mgr.start()
    expect(fakes.events).toEqual(['start'])

    await mgr.applyChannels(disabled)
    expect(mgr.activeAdapters()).toEqual([])
    expect(fakes.events).toEqual(['start', 'stop'])
  })

  test('factory failure: error is logged, manager stays usable', async () => {
    const router = await makeRouter()
    const errors: string[] = []
    const factory: DiscordBotFactory = async () => {
      throw new Error('cannot login')
    }
    const mgr = createChannelManager({
      router,
      channels: enabledStar,
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
    })
    await mgr.start()

    expect(errors.some((e) => e.includes('cannot login'))).toBe(true)
    expect(mgr.activeAdapters()).toEqual([])
  })
})
