// Local ambient declarations for `agent-messenger/discordbot`.
//
// The agent-messenger package is installed from its GitHub source (no shipped
// `dist/` declarations) and its `src/` has strict-mode type errors that
// surface when TypeScript walks our `import type` references into the package
// source. Bun runs the source fine at runtime — only the typecheck breaks.
//
// This shim mirrors the public API surface we actually consume from the
// package's `src/platforms/discordbot/index.ts`. Keep it minimal: when we
// start using new exports, add them here. When agent-messenger ships a
// release with `dist/` declarations and a clean source, delete this file.
declare module 'agent-messenger/discordbot' {
  export interface DiscordBotListenerEventMap {
    message_create: [event: DiscordGatewayMessageCreateEvent]
    message_update: [event: DiscordGatewayMessageUpdateEvent]
    message_delete: [event: DiscordGatewayMessageDeleteEvent]
    message_reaction_add: [event: DiscordGatewayReactionEvent]
    message_reaction_remove: [event: DiscordGatewayReactionEvent]
    guild_member_add: [event: DiscordGatewayMemberEvent]
    guild_member_remove: [event: DiscordGatewayMemberEvent]
    typing_start: [event: DiscordGatewayTypingEvent]
    channel_create: [event: DiscordGatewayChannelEvent]
    channel_update: [event: DiscordGatewayChannelEvent]
    channel_delete: [event: DiscordGatewayChannelEvent]
    guild_create: [event: DiscordGatewayGuildEvent]
    guild_update: [event: DiscordGatewayGuildEvent]
    guild_delete: [event: DiscordGatewayGuildEvent]
    interaction_create: [event: DiscordGatewayInteractionEvent]
    discord_event: [event: DiscordGatewayGenericEvent]
    connected: [info: { user: { id: string; username: string }; sessionId: string }]
    disconnected: []
    error: [error: Error]
  }

  export interface DiscordGatewayMessageCreateEvent {
    type: 'MESSAGE_CREATE'
    id: string
    channel_id: string
    guild_id?: string
    author: { id: string; username: string; bot?: boolean }
    content: string
    timestamp: string
    edited_timestamp?: string
    mentions?: { id: string; username: string }[]
    attachments?: { id: string; filename: string; url: string; size?: number }[]
  }

  export interface DiscordGatewayMessageUpdateEvent {
    type: 'MESSAGE_UPDATE'
    id: string
    channel_id: string
    guild_id?: string
    content?: string
    edited_timestamp?: string
  }

  export interface DiscordGatewayMessageDeleteEvent {
    type: 'MESSAGE_DELETE'
    id: string
    channel_id: string
    guild_id?: string
  }

  export interface DiscordGatewayReactionEvent {
    type: 'MESSAGE_REACTION_ADD' | 'MESSAGE_REACTION_REMOVE'
    user_id: string
    channel_id: string
    message_id: string
    guild_id?: string
    emoji: { id?: string; name: string }
  }

  export interface DiscordGatewayMemberEvent {
    type: 'GUILD_MEMBER_ADD' | 'GUILD_MEMBER_REMOVE'
    guild_id: string
    user: { id: string; username: string }
  }

  export interface DiscordGatewayTypingEvent {
    type: 'TYPING_START'
    user_id: string
    channel_id: string
    guild_id?: string
    timestamp: number
  }

  export interface DiscordGatewayChannelEvent {
    type: 'CHANNEL_CREATE' | 'CHANNEL_UPDATE' | 'CHANNEL_DELETE'
    id: string
    guild_id?: string
    name?: string
  }

  export interface DiscordGatewayGuildEvent {
    type: 'GUILD_CREATE' | 'GUILD_UPDATE' | 'GUILD_DELETE'
    id: string
    name?: string
    unavailable?: boolean
  }

  export interface DiscordGatewayInteractionEvent {
    type: 'INTERACTION_CREATE'
    id: string
    application_id: string
    token: string
    data?: Record<string, unknown>
    channel_id?: string
    guild_id?: string
    member?: Record<string, unknown>
    user?: { id: string; username: string }
  }

  export interface DiscordGatewayGenericEvent {
    type: string
    [key: string]: unknown
  }

  export const DiscordIntent: {
    readonly Guilds: number
    readonly GuildMembers: number
    readonly GuildModeration: number
    readonly GuildEmojisAndStickers: number
    readonly GuildIntegrations: number
    readonly GuildWebhooks: number
    readonly GuildInvites: number
    readonly GuildVoiceStates: number
    readonly GuildPresences: number
    readonly GuildMessages: number
    readonly GuildMessageReactions: number
    readonly GuildMessageTyping: number
    readonly DirectMessages: number
    readonly DirectMessageReactions: number
    readonly DirectMessageTyping: number
    readonly MessageContent: number
    readonly GuildScheduledEvents: number
    readonly AutoModerationConfiguration: number
    readonly AutoModerationExecution: number
  }

  export class DiscordBotClient {
    login(credentials?: { token: string }): Promise<this>
    sendMessage(
      channelId: string,
      content: string,
      options?: { thread_id?: string },
    ): Promise<{ id: string; channel_id: string; content: string }>
    gatewayConnect(): Promise<{ token: string }>
  }

  export class DiscordBotListener {
    constructor(client: DiscordBotClient, options?: { intents?: number })
    start(): Promise<void>
    stop(): void
    on<K extends keyof DiscordBotListenerEventMap>(
      event: K,
      listener: (...args: DiscordBotListenerEventMap[K]) => void,
    ): this
    off<K extends keyof DiscordBotListenerEventMap>(
      event: K,
      listener: (...args: DiscordBotListenerEventMap[K]) => void,
    ): this
    once<K extends keyof DiscordBotListenerEventMap>(
      event: K,
      listener: (...args: DiscordBotListenerEventMap[K]) => void,
    ): this
  }
}
