import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChannelManager, type DiscordBotFactory } from './manager'
import { createChannelRouter } from './router'
import type { Channel } from './schema'

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

const ch1: Channel = { adapter: 'discord-bot', bot: 'main', chats: ['*'], enabled: true }
const ch2: Channel = { adapter: 'discord-bot', bot: 'alert', chats: ['*'], enabled: true }
const ch1Disabled: Channel = { ...ch1, enabled: false }
const ch1NewChats: Channel = { ...ch1, chats: ['W1/C1'] }

describe('ChannelManager', () => {
  test('start: enabled channels are started, disabled are skipped', async () => {
    const router = await makeRouter()
    const created: { fakes: ReturnType<typeof fakeAdapter>; channel: Channel }[] = []
    const factory: DiscordBotFactory = async (channel) => {
      const f = fakeAdapter()
      created.push({ fakes: f, channel })
      return { adapter: f.adapter as any, close: async () => {} }
    }
    const mgr = createChannelManager({
      router,
      channels: [ch1, ch1Disabled],
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await mgr.start()

    expect(created).toHaveLength(1)
    expect(created[0]?.channel.bot).toBe('main')
    expect(mgr.activeKeys()).toEqual(['discord-bot|main'])
  })

  test('stop: stops all active adapters and closes them', async () => {
    const router = await makeRouter()
    const created: ReturnType<typeof fakeAdapter>[] = []
    let closeCalls = 0
    const factory: DiscordBotFactory = async () => {
      const f = fakeAdapter()
      created.push(f)
      return {
        adapter: f.adapter as any,
        close: async () => {
          closeCalls++
        },
      }
    }
    const mgr = createChannelManager({
      router,
      channels: [ch1, ch2],
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await mgr.start()
    await mgr.stop()

    expect(created.every((c) => c.events.includes('stop'))).toBe(true)
    expect(closeCalls).toBe(2)
    expect(mgr.activeKeys()).toEqual([])
  })

  test('applyChannels diff: added, removed, updated, unchanged', async () => {
    const router = await makeRouter()
    const factory: DiscordBotFactory = async () => {
      const f = fakeAdapter()
      return { adapter: f.adapter as any, close: async () => {} }
    }
    const mgr = createChannelManager({
      router,
      channels: [ch1, ch2],
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await mgr.start()
    expect(mgr.activeKeys().sort()).toEqual(['discord-bot|alert', 'discord-bot|main'])

    const ch3: Channel = { adapter: 'discord-bot', bot: 'extra', chats: ['*'], enabled: true }
    const diff = await mgr.applyChannels([ch1NewChats, ch3])

    expect(diff.removed.map((c) => c.bot)).toEqual(['alert'])
    expect(diff.updated.map((c) => c.bot)).toEqual(['main'])
    expect(diff.added.map((c) => c.bot)).toEqual(['extra'])
    expect(mgr.activeKeys().sort()).toEqual(['discord-bot|extra', 'discord-bot|main'])
  })

  test('applyChannels: changed chats list is treated as updated (restart)', async () => {
    const router = await makeRouter()
    const startedBots: string[] = []
    const stoppedBots: string[] = []
    const factory: DiscordBotFactory = async (channel) => ({
      adapter: {
        async start() {
          startedBots.push(channel.bot)
        },
        async stop() {
          stoppedBots.push(channel.bot)
        },
        async handleInbound() {},
        outboundCallback: async () => {},
      } as any,
      close: async () => {},
    })
    const mgr = createChannelManager({
      router,
      channels: [ch1],
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await mgr.start()
    expect(startedBots).toEqual(['main'])

    const diff = await mgr.applyChannels([ch1NewChats])

    expect(diff.updated.map((c) => c.bot)).toEqual(['main'])
    expect(stoppedBots).toEqual(['main'])
    expect(startedBots).toEqual(['main', 'main'])
  })

  test('applyChannels: enabled flag flip stops the adapter without restarting', async () => {
    const router = await makeRouter()
    const fakes = fakeAdapter()
    const factory: DiscordBotFactory = async () => ({ adapter: fakes.adapter as any, close: async () => {} })
    const mgr = createChannelManager({
      router,
      channels: [ch1],
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    await mgr.start()
    expect(fakes.events).toEqual(['start'])

    await mgr.applyChannels([ch1Disabled])
    expect(mgr.activeKeys()).toEqual([])
    expect(fakes.events).toEqual(['start', 'stop'])
  })

  test('factory failure: error is logged, manager stays usable for other channels', async () => {
    const router = await makeRouter()
    const errors: string[] = []
    const factory: DiscordBotFactory = async (channel) => {
      if (channel.bot === 'main') throw new Error('cannot login as main')
      const f = fakeAdapter()
      return { adapter: f.adapter as any, close: async () => {} }
    }
    const mgr = createChannelManager({
      router,
      channels: [ch1, ch2],
      discordBotFactory: factory,
      logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
    })
    await mgr.start()

    expect(errors.some((e) => e.includes('cannot login as main'))).toBe(true)
    expect(mgr.activeKeys()).toEqual(['discord-bot|alert'])
  })
})
