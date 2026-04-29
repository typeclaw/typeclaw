import type { Reloadable, ReloadResult } from '@/reload'

import { createDiscordBotAdapter, type DiscordBotAdapter, type DiscordBotListenerLike } from './adapters/discord-bot'
import type { AdapterId, ChannelRouter } from './router'
import type { Channels, DiscordBotConfig } from './schema'

export type DiscordBotFactory = (config: DiscordBotConfig) => Promise<{
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
  channels: Channels
  discordBotFactory: DiscordBotFactory
  logger?: ChannelManagerLogger
}

export type ChannelManager = {
  start: () => Promise<void>
  stop: () => Promise<void>
  applyChannels: (next: Channels) => Promise<ChannelDiff>
  activeAdapters: () => AdapterId[]
}

export type ChannelDiff = {
  added: AdapterId[]
  removed: AdapterId[]
  updated: AdapterId[]
  unchanged: AdapterId[]
}

const consoleLogger: ChannelManagerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

type ActiveAdapter = {
  config: DiscordBotConfig
  adapter: DiscordBotAdapter
  close: () => Promise<void>
}

export function createChannelManager({
  router,
  channels: initial,
  discordBotFactory,
  logger = consoleLogger,
}: CreateChannelManagerOptions): ChannelManager {
  const active = new Map<AdapterId, ActiveAdapter>()
  let started = false
  let current: Channels = initial

  return {
    async start() {
      if (started) return
      started = true
      await router.load()
      const discord = current['discord-bot']
      if (discord !== undefined && discord.enabled) {
        await startDiscord(discord)
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
      const diff = computeDiff(current, next)
      current = next

      for (const adapterId of diff.removed) {
        const entry = active.get(adapterId)
        if (!entry) continue
        await entry.adapter.stop()
        await entry.close()
        active.delete(adapterId)
      }

      for (const adapterId of diff.updated) {
        const entry = active.get(adapterId)
        if (entry) {
          await entry.adapter.stop()
          await entry.close()
          active.delete(adapterId)
        }
        await startIfEnabled(adapterId, next)
      }

      for (const adapterId of diff.added) {
        await startIfEnabled(adapterId, next)
      }

      return diff
    },
    activeAdapters() {
      return [...active.keys()]
    },
  }

  async function startIfEnabled(adapterId: AdapterId, channels: Channels): Promise<void> {
    if (adapterId === 'discord-bot') {
      const config = channels['discord-bot']
      if (config === undefined || !config.enabled) return
      await startDiscord(config)
    }
  }

  async function startDiscord(config: DiscordBotConfig): Promise<void> {
    try {
      const { adapter, close } = await discordBotFactory(config)
      await adapter.start()
      active.set('discord-bot', { config, adapter, close })
      logger.info(`[channels] started discord-bot`)
    } catch (err) {
      logger.error(`[channels] failed to start discord-bot: ${errMsg(err)}`)
    }
  }
}

export function createDefaultDiscordBotFactory(opts: {
  router: ChannelRouter
  createDiscordBotClientAndListener: (config: DiscordBotConfig) => Promise<{
    client: Parameters<typeof createDiscordBotAdapter>[0]['client']
    listener: DiscordBotListenerLike
    close: () => Promise<void>
  }>
  logger?: ChannelManagerLogger
}): DiscordBotFactory {
  return async (config) => {
    const built = await opts.createDiscordBotClientAndListener(config)
    const adapter = createDiscordBotAdapter({
      allow: config.allow,
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
  loadChannels: () => Channels
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
          summary: `${diff.added.length} added, ${diff.removed.length} removed, ${diff.updated.length} updated, ${diff.unchanged.length} unchanged`,
          details: diff,
        }
      } catch (err) {
        return { scope: 'channels', ok: false, reason: errMsg(err) }
      }
    },
  }
}

function discordFingerprint(config: DiscordBotConfig | undefined): string | null {
  if (config === undefined) return null
  return JSON.stringify({ allow: config.allow, enabled: config.enabled })
}

function computeDiff(before: Channels, next: Channels): ChannelDiff {
  const result: ChannelDiff = { added: [], removed: [], updated: [], unchanged: [] }

  for (const adapterId of ['discord-bot'] as const) {
    const beforeFp = discordFingerprint(before[adapterId])
    const nextFp = discordFingerprint(next[adapterId])
    if (beforeFp === null && nextFp !== null) result.added.push(adapterId)
    else if (beforeFp !== null && nextFp === null) result.removed.push(adapterId)
    else if (beforeFp !== null && nextFp !== null) {
      if (beforeFp === nextFp) result.unchanged.push(adapterId)
      else result.updated.push(adapterId)
    }
  }

  return result
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
