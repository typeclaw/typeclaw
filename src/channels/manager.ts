import type { Reloadable, ReloadResult } from '@/reload'

import { createDiscordBotAdapter, type DiscordBotAdapter, type DiscordBotListenerLike } from './adapters/discord-bot'
import type { ChannelRouter } from './router'
import type { Channel, DiscordBotChannel } from './schema'

export type DiscordBotFactory = (channel: DiscordBotChannel) => Promise<{
  adapter: DiscordBotAdapter
  close: () => Promise<void>
}>

export type ChannelManagerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type CreateChannelManagerOptions = {
  router: ChannelRouter
  channels: Channel[]
  discordBotFactory: DiscordBotFactory
  logger?: ChannelManagerLogger
}

export type ChannelManager = {
  start: () => Promise<void>
  stop: () => Promise<void>
  applyChannels: (next: Channel[]) => Promise<ChannelDiff>
  activeKeys: () => string[]
}

export type ChannelDiff = {
  added: Channel[]
  removed: Channel[]
  updated: Channel[]
  unchanged: Channel[]
}

const consoleLogger: ChannelManagerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

type ActiveAdapter = {
  channel: Channel
  adapter: DiscordBotAdapter
  close: () => Promise<void>
}

export function createChannelManager({
  router,
  channels: initial,
  discordBotFactory,
  logger = consoleLogger,
}: CreateChannelManagerOptions): ChannelManager {
  const active = new Map<string, ActiveAdapter>()
  let started = false

  return {
    async start() {
      if (started) return
      started = true
      await router.load()
      for (const channel of initial) {
        if (!channel.enabled) continue
        await startOne(channel)
      }
    },
    async stop() {
      started = false
      for (const entry of active.values()) {
        await entry.adapter.stop()
        await entry.close()
      }
      active.clear()
      await router.stop()
    },
    async applyChannels(next) {
      const diff = computeDiff(
        [...active.values()].map((a) => a.channel),
        next,
      )

      for (const removed of diff.removed) {
        const key = channelKey(removed)
        const entry = active.get(key)
        if (!entry) continue
        await entry.adapter.stop()
        await entry.close()
        active.delete(key)
      }

      for (const updated of diff.updated) {
        const key = channelKey(updated)
        const entry = active.get(key)
        if (entry) {
          await entry.adapter.stop()
          await entry.close()
          active.delete(key)
        }
        if (updated.enabled) await startOne(updated)
      }

      for (const added of diff.added) {
        if (added.enabled) await startOne(added)
      }

      return diff
    },
    activeKeys() {
      return [...active.keys()]
    },
  }

  async function startOne(channel: Channel): Promise<void> {
    if (channel.adapter !== 'discord-bot') {
      logger.warn(`[channels] adapter ${channel.adapter} is not supported in v0.1; skipping`)
      return
    }
    try {
      const { adapter, close } = await discordBotFactory(channel)
      await adapter.start()
      active.set(channelKey(channel), { channel, adapter, close })
      logger.info(`[channels] started discord-bot/${channel.bot}`)
    } catch (err) {
      logger.error(`[channels] failed to start discord-bot/${channel.bot}: ${errMsg(err)}`)
    }
  }
}

export function createDefaultDiscordBotFactory(opts: {
  router: ChannelRouter
  createDiscordBotClientAndListener: (channel: DiscordBotChannel) => Promise<{
    client: Parameters<typeof createDiscordBotAdapter>[0]['client']
    listener: DiscordBotListenerLike
    close: () => Promise<void>
  }>
  logger?: ChannelManagerLogger
}): DiscordBotFactory {
  return async (channel) => {
    const built = await opts.createDiscordBotClientAndListener(channel)
    const adapter = createDiscordBotAdapter({
      bot: channel.bot,
      chats: channel.chats,
      router: opts.router,
      client: built.client,
      listener: built.listener,
      ...(opts.logger ? { logger: opts.logger } : {}),
    })
    return { adapter, close: built.close }
  }
}

export type CreateChannelsReloadableOptions = {
  manager: ChannelManager
  loadChannels: () => Channel[]
}

export function createChannelsReloadable({ manager, loadChannels }: CreateChannelsReloadableOptions): Reloadable {
  return {
    scope: 'channels',
    description: 'channels from typeclaw.json',
    reload: async (): Promise<ReloadResult> => {
      try {
        const next = loadChannels()
        const diff = await manager.applyChannels(next)
        return {
          scope: 'channels',
          ok: true,
          summary: `${next.length} channels (added ${diff.added.length}, removed ${diff.removed.length}, updated ${diff.updated.length}, unchanged ${diff.unchanged.length})`,
          details: diff,
        }
      } catch (err) {
        return { scope: 'channels', ok: false, reason: errMsg(err) }
      }
    },
  }
}

function channelKey(channel: Channel): string {
  return `${channel.adapter}|${channel.bot}`
}

function fingerprint(channel: Channel): string {
  return JSON.stringify({ adapter: channel.adapter, bot: channel.bot, chats: channel.chats, enabled: channel.enabled })
}

function computeDiff(before: Channel[], next: Channel[]): ChannelDiff {
  const added: Channel[] = []
  const removed: Channel[] = []
  const updated: Channel[] = []
  const unchanged: Channel[] = []

  const beforeByKey = new Map<string, Channel>()
  for (const c of before) beforeByKey.set(channelKey(c), c)
  const nextByKey = new Map<string, Channel>()
  for (const c of next) nextByKey.set(channelKey(c), c)

  for (const [key, beforeC] of beforeByKey) {
    const nextC = nextByKey.get(key)
    if (!nextC) {
      removed.push(beforeC)
      continue
    }
    if (fingerprint(beforeC) === fingerprint(nextC)) {
      unchanged.push(nextC)
    } else {
      updated.push(nextC)
    }
  }
  for (const [key, nextC] of nextByKey) {
    if (!beforeByKey.has(key)) added.push(nextC)
  }

  return { added, removed, updated, unchanged }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
