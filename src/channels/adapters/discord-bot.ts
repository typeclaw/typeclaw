import type {
  DiscordBotClient,
  DiscordBotListenerEventMap,
  DiscordGatewayMessageCreateEvent,
} from 'agent-messenger/discordbot'

import type { ChannelRouter, InboundMessage, OutboundCallback, OutboundReply } from '../router'
import { matchesAnyChatRule, type ChatRule } from '../schema'

export type DiscordBotListenerLike = {
  on<K extends keyof DiscordBotListenerEventMap>(
    event: K,
    handler: (...args: DiscordBotListenerEventMap[K]) => void,
  ): unknown
  start: () => Promise<void>
  stop: () => void
}

const DM_WORKSPACE_SENTINEL = '@dm'

export type DiscordBotAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type DiscordBotAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  handleInbound: (event: DiscordGatewayMessageCreateEvent) => Promise<void>
  outboundCallback: OutboundCallback
}

export type CreateDiscordBotAdapterOptions = {
  bot: string
  chats: ChatRule[]
  router: ChannelRouter
  client: Pick<DiscordBotClient, 'sendMessage'>
  listener: DiscordBotListenerLike
  logger?: DiscordBotAdapterLogger
}

const consoleLogger: DiscordBotAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export function createDiscordBotAdapter({
  bot,
  chats,
  router,
  client,
  listener,
  logger = consoleLogger,
}: CreateDiscordBotAdapterOptions): DiscordBotAdapter {
  let unbindOutbound: (() => void) | null = null

  async function handleInbound(event: DiscordGatewayMessageCreateEvent): Promise<void> {
    if (event.author.bot === true) return

    const workspace = event.guild_id ?? DM_WORKSPACE_SENTINEL
    if (!matchesAnyChatRule(chats, workspace, event.channel_id)) return

    if (event.content.length === 0) return

    const inbound: InboundMessage = {
      adapter: 'discord-bot',
      bot,
      workspace,
      chat: event.channel_id,
      thread: null,
      text: event.content,
      externalMessageId: event.id,
      authorId: event.author.id,
    }

    try {
      await router.route(inbound)
    } catch (err) {
      logger.error(`[discord-bot] route failed: ${errMsg(err)}`)
    }
  }

  async function outboundCallback(reply: OutboundReply): Promise<void> {
    if (reply.bot !== bot) return
    try {
      await client.sendMessage(reply.chat, reply.text, reply.thread !== null ? { thread_id: reply.thread } : undefined)
    } catch (err) {
      logger.error(`[discord-bot] send failed for ${reply.chat}: ${errMsg(err)}`)
    }
  }

  return {
    async start() {
      listener.on('message_create', (event) => {
        void handleInbound(event)
      })
      listener.on('error', (err) => {
        logger.error(`[discord-bot] listener error: ${err.message}`)
      })
      listener.on('disconnected', () => {
        logger.warn(`[discord-bot] disconnected (auto-reconnecting)`)
      })
      listener.on('connected', (info) => {
        logger.info(`[discord-bot] connected as ${info.user.username} (${info.user.id})`)
      })
      unbindOutbound = router.bindOutbound('discord-bot', outboundCallback)
      await listener.start()
    },
    async stop() {
      unbindOutbound?.()
      unbindOutbound = null
      listener.stop()
    },
    handleInbound,
    outboundCallback,
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
