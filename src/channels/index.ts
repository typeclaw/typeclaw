export { channelSchema, matchesAnyChatRule, type Channel, type ChatRule, type DiscordBotChannel } from './schema'

export {
  createChannelRouter,
  type AdapterId,
  type ChannelKey,
  type ChannelRouter,
  type ChannelRouterLogger,
  type ChannelSessionMapping,
  type CreateChannelRouterOptions,
  type CreateSessionForChannel,
  type InboundMessage,
  type OutboundCallback,
  type OutboundReply,
} from './router'

export {
  createChannelManager,
  createChannelsReloadable,
  createDefaultDiscordBotFactory,
  type ChannelDiff,
  type ChannelManager,
  type ChannelManagerLogger,
  type CreateChannelManagerOptions,
  type CreateChannelsReloadableOptions,
  type DiscordBotFactory,
} from './manager'

export { createDiscordBotAdapter, type DiscordBotAdapter, type DiscordBotListenerLike } from './adapters/discord-bot'
