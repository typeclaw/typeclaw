import {
  DiscordClient,
  DiscordListener,
  type DiscordGatewayMessageCreateEvent,
  type DiscordMessage,
} from 'agent-messenger/discord'

import type { MembershipResolver, MembershipResolverResult } from '@/channels/membership'
import { deriveMembershipFromHistory } from '@/channels/membership-from-history'
import { ROUTE_WORKSPACE_ANY, type ChannelRouter } from '@/channels/router'
import type { ChannelAdapterConfig } from '@/channels/schema'
import type {
  ChannelHistoryMessage,
  ChannelSelfIdentityResolver,
  FetchAttachmentCallback,
  FetchHistoryArgs,
  FetchHistoryResult,
  HistoryCallback,
  OutboundCallback,
  OutboundMessage,
  ResolvedChannelNames,
  SendResult,
} from '@/channels/types'
import { chunkMarkdown } from '@/markdown'
import type { DiscordAccountRecord } from '@/secrets/schema'

import { createDiscordAuthorResolver } from './discord-author-resolver'
import { createDiscordChannelResolver } from './discord-channel-resolver'
import { classifyInbound, type InboundDropReason } from './discord-classify'
import { createDiscordReactionCallback, createDiscordRemoveReactionCallback } from './discord-reactions'

export type DiscordAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: DiscordAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type DiscordCredentialStore = {
  getAccount(id?: string): Promise<DiscordAccountRecord | null>
}

export type DiscordAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  logger?: DiscordAdapterLogger
  selfAliasesRef?: () => readonly string[]
  credentialsStore?: DiscordCredentialStore
  createClient?: () => DiscordClient
  createListener?: (client: DiscordClient) => DiscordListener
  fetchImpl?: typeof fetch
}

export type DiscordAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

export function createDiscordOutboundCallback(deps: {
  client: Pick<DiscordClient, 'sendMessage' | 'uploadFile'>
  logger: DiscordAdapterLogger
  formatChannelTag: (chat: string) => Promise<string>
}): OutboundCallback {
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'discord') return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    const text = msg.text ?? ''
    const attachments = msg.attachments ?? []
    if (text === '' && attachments.length === 0) return { ok: false, error: 'message has neither text nor attachments' }
    const tag = await deps.formatChannelTag(msg.chat)
    deps.logger.info(`[discord] outbound ${tag} text_len=${text.length} attachments=${attachments.length}`)
    try {
      // Attachments first, then text — Discord's upstream uploadFile takes no
      // content body, so a failed upload must not leave a text-only message
      // already posted (see OutboundMessage.attachments contract).
      for (const attachment of attachments) await deps.client.uploadFile(msg.chat, attachment.path)
      if (text !== '') {
        for (const chunk of chunkMarkdown(text, 2_000)) await deps.client.sendMessage(msg.chat, chunk)
      }
      return { ok: true }
    } catch (err) {
      const message = describe(err)
      deps.logger.error(`[discord] outbound failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createDiscordHistoryCallback(deps: {
  client: Pick<DiscordClient, 'getMessages'>
  logger: DiscordAdapterLogger
}): HistoryCallback {
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    try {
      const messages = await deps.client.getMessages(args.chat, clampLimit(args.limit, 100))
      return { ok: true, messages: messages.map(mapDiscordHistoryMessage).reverse() }
    } catch (err) {
      const message = describe(err)
      deps.logger.warn(`[discord] history fetch failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createDiscordMembershipResolver(deps: {
  historyCallback: HistoryCallback
  now?: () => number
}): MembershipResolver {
  const now = deps.now ?? Date.now
  return async (key): Promise<MembershipResolverResult> => {
    if (key.adapter !== 'discord') return { kind: 'permanent' }
    if (key.workspace === '@dm') return { humans: 1, bots: 1, fetchedAt: now(), truncated: false }
    return await deriveMembershipFromHistory({
      fetchHistory: (limit) => deps.historyCallback({ chat: key.chat, thread: key.thread, limit }),
      now,
    })
  }
}

export function createDiscordFetchAttachmentCallback(deps: {
  tokenRef: () => string | null
  fetchImpl?: typeof fetch
  logger: DiscordAdapterLogger
}): FetchAttachmentCallback {
  const fetchFn = deps.fetchImpl ?? fetch
  return async ({ ref, filename }) => {
    let url: URL
    try {
      url = new URL(ref)
    } catch {
      return { ok: false, error: `invalid Discord attachment URL: ${ref}` }
    }
    if (!DISCORD_ATTACHMENT_HOSTS.has(url.hostname)) {
      return { ok: false, error: `not a Discord CDN URL: ${url.hostname}` }
    }
    try {
      const token = deps.tokenRef()
      const headers = token !== null ? { Authorization: token } : undefined
      const res = await fetchFn(url.toString(), headers !== undefined ? { headers } : undefined)
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const message = `discord cdn fetch ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`
        deps.logger.error(`[discord] fetchAttachment failed for ${url.toString()}: ${message}`)
        return { ok: false, error: message }
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      const inferredFilename = filename ?? url.pathname.split('/').pop() ?? 'attachment'
      const contentType = res.headers.get('content-type') ?? undefined
      return {
        ok: true,
        buffer,
        filename: inferredFilename,
        ...(contentType !== undefined ? { mimetype: contentType } : {}),
        size: buffer.length,
      }
    } catch (err) {
      const message = describe(err)
      deps.logger.error(`[discord] fetchAttachment failed for ${url.toString()}: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createDiscordAdapter(options: DiscordAdapterOptions): DiscordAdapter {
  const logger = options.logger ?? consoleLogger
  const createClient = options.createClient ?? (() => new DiscordClient())
  const createListener = options.createListener ?? ((client) => new DiscordListener(client))
  const client = createClient()
  let listener: DiscordListener | null = null
  let selfUserId: string | null = null
  let selfName: string | null = null
  let token: string | null = null
  let connected = false
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  const channelResolver = createDiscordChannelResolver({ client })
  const authorResolver = createDiscordAuthorResolver({ client })
  const selfIdentityResolver: ChannelSelfIdentityResolver = () =>
    selfUserId !== null ? { id: selfUserId, username: selfName ?? selfUserId } : null
  const formatChannelTag = async (chat: string): Promise<string> => {
    const names = await channelResolver({ adapter: 'discord', workspace: '', chat, thread: null }).catch(
      (): ResolvedChannelNames => ({}),
    )
    const label = names.chatName ?? null
    return label === null || label === chat ? `channel=${chat}` : `channel=${label}(${chat})`
  }
  const historyCallback = createDiscordHistoryCallback({ client, logger })
  const membershipResolver = createDiscordMembershipResolver({ historyCallback })
  const outboundCallback = createDiscordOutboundCallback({ client, logger, formatChannelTag })
  const fetchAttachmentCallback = createDiscordFetchAttachmentCallback({
    tokenRef: () => token,
    fetchImpl: options.fetchImpl,
    logger,
  })
  const reactionCallback = createDiscordReactionCallback({ client })
  const removeReactionCallback = createDiscordRemoveReactionCallback({ client })
  function registerCallbacks(router: ChannelRouter): void {
    router.registerOutbound('discord', ROUTE_WORKSPACE_ANY, outboundCallback)
    router.setTypingCapability('discord', ROUTE_WORKSPACE_ANY, false)
    router.registerChannelNameResolver('discord', ROUTE_WORKSPACE_ANY, channelResolver)
    router.registerSelfIdentity('discord', ROUTE_WORKSPACE_ANY, selfIdentityResolver)
    router.registerHistory('discord', ROUTE_WORKSPACE_ANY, historyCallback)
    router.registerFetchAttachment('discord', ROUTE_WORKSPACE_ANY, fetchAttachmentCallback)
    router.registerMembership('discord', ROUTE_WORKSPACE_ANY, membershipResolver)
    router.registerReaction('discord', ROUTE_WORKSPACE_ANY, reactionCallback)
    router.registerRemoveReaction('discord', ROUTE_WORKSPACE_ANY, removeReactionCallback)
  }

  function unregisterCallbacks(router: ChannelRouter): void {
    router.unregisterOutbound('discord', ROUTE_WORKSPACE_ANY, outboundCallback)
    router.setTypingCapability('discord', ROUTE_WORKSPACE_ANY, false)
    router.unregisterChannelNameResolver('discord', ROUTE_WORKSPACE_ANY, channelResolver)
    router.unregisterSelfIdentity('discord', ROUTE_WORKSPACE_ANY, selfIdentityResolver)
    router.unregisterHistory('discord', ROUTE_WORKSPACE_ANY, historyCallback)
    router.unregisterFetchAttachment('discord', ROUTE_WORKSPACE_ANY, fetchAttachmentCallback)
    router.unregisterMembership('discord', ROUTE_WORKSPACE_ANY, membershipResolver)
    router.unregisterReaction('discord', ROUTE_WORKSPACE_ANY, reactionCallback)
    router.unregisterRemoveReaction('discord', ROUTE_WORKSPACE_ANY, removeReactionCallback)
  }

  const handleMessage = async (event: DiscordGatewayMessageCreateEvent): Promise<void> => {
    inflightInbounds++
    try {
      const tag = await formatChannelTag(event.channel_id)
      logger.info(
        `[discord] inbound id=${event.id} author=${event.author.id || '(none)'} ${tag} text_len=${event.content.length}`,
      )
      const verdict = classifyInbound(event, options.configRef(), {
        selfUserId,
        selfAliases: options.selfAliasesRef?.() ?? [],
      })
      if (verdict.kind === 'drop') {
        logger.info(`[discord] dropped id=${event.id} reason=${verdict.reason}${dropHint(verdict.reason)}`)
        return
      }
      const attachments = (event.attachments ?? []).map((file, index) => ({
        id: index + 1,
        kind: 'file' as const,
        ref: file.url,
        filename: file.filename,
        mimetype: file.content_type,
      }))
      const payload = {
        ...verdict.payload,
        authorName: await authorResolver.resolve(verdict.payload.authorId),
        ...(attachments.length > 0 ? { attachments } : {}),
      }
      logger.info(`[discord] routed id=${event.id} ${tag} mention=${payload.isBotMention}`)
      await options.router.route(payload)
    } catch (err) {
      logger.error(`[discord] handleInbound failed: ${describe(err)}`)
    } finally {
      inflightInbounds--
      if (inflightInbounds === 0 && stopWaiters.length > 0) {
        const waiters = stopWaiters
        stopWaiters = []
        for (const w of waiters) w()
      }
    }
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      try {
        const account = await (options.credentialsStore ?? null)?.getAccount()
        if (account === null || account === undefined) {
          throw new Error('no Discord account in secrets.json#channels.discord (run typeclaw init to authenticate)')
        }
        token = account.token
        await client.login({ token: account.token })
        const auth = await client.testAuth()
        selfUserId = auth.id
        selfName = auth.global_name ?? auth.username
        logger.info(`[discord] authenticated as ${selfName} (${selfUserId})`)
      } catch (err) {
        started = false
        selfUserId = null
        token = null
        logger.error(`[discord] login failed: ${describe(err)}`)
        throw err
      }

      listener = createListener(client)
      let listenerConnected = false
      let listenerStartupError: Error | null = null
      listener.on('connected', (info) => {
        listenerConnected = true
        connected = true
        selfUserId = info.user.id
        selfName = info.user.username
      })
      listener.on('disconnected', () => {
        connected = false
        logger.warn('[discord] disconnected')
      })
      listener.on('error', (err) => {
        if (!listenerConnected && listenerStartupError === null) listenerStartupError = err
        logger.error(`[discord] listener error: ${describe(err)}`)
      })
      listener.on('message_create', (event) => void handleMessage(event))
      listener.on('message_reaction_add', (event) =>
        logger.info(
          `[discord] reaction_added channel=${event.channel_id} message=${event.message_id} emoji=${event.emoji.name}`,
        ),
      )
      listener.on('message_reaction_remove', (event) =>
        logger.info(
          `[discord] reaction_removed channel=${event.channel_id} message=${event.message_id} emoji=${event.emoji.name}`,
        ),
      )

      registerCallbacks(options.router)

      const rollbackStart = (reason: string, cause: Error): never => {
        unregisterCallbacks(options.router)
        listener?.stop()
        listener = null
        selfUserId = null
        token = null
        connected = false
        started = false
        logger.error(`[discord] ${reason}: ${describe(cause)}`)
        throw cause
      }

      try {
        await listener.start()
      } catch (err) {
        rollbackStart('listener start threw', err instanceof Error ? err : new Error(String(err)))
      }
      if (!listenerConnected) {
        rollbackStart(
          'listener start failed silently',
          listenerStartupError ?? new Error('listener.start() returned without emitting connected'),
        )
      }
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      unregisterCallbacks(options.router)
      listener?.stop()
      listener = null
      connected = false
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      selfUserId = null
      token = null
    },

    isConnected(): boolean {
      return started && selfUserId !== null && connected
    },
  }
}

function mapDiscordHistoryMessage(msg: DiscordMessage): ChannelHistoryMessage {
  return {
    externalMessageId: msg.id,
    authorId: msg.author.id,
    authorName: msg.author.username,
    text: msg.content,
    ts: parseDiscordTimestamp(msg.timestamp),
    isBot: false,
    replyToBotMessageId: null,
  }
}

function parseDiscordTimestamp(timestamp: string): number {
  const millis = Date.parse(timestamp)
  return Number.isFinite(millis) ? millis : 0
}

const DISCORD_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net'])

function clampLimit(requested: number, max: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function dropHint(reason: InboundDropReason): string {
  switch (reason) {
    case 'empty_content':
      return ' (message had no text)'
    case 'pre_connect':
    case 'self_author':
    case 'no_user':
      return ''
  }
}
