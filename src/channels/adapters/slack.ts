import { basename } from 'node:path'

import {
  SlackClient,
  SlackListener,
  type SlackMessage,
  type SlackRTMMessageEvent,
  type SlackRTMReactionEvent,
} from 'agent-messenger/slack'

import {
  MEMBERSHIP_ENUMERATION_CAP,
  type MembershipResolver,
  type MembershipResolverFailure,
  type MembershipResolverResult,
} from '@/channels/membership'
import { deriveMembershipFromHistory } from '@/channels/membership-from-history'
import type { ChannelRouter } from '@/channels/router'
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
import type { SlackAccountRecord } from '@/secrets/schema'

import { createSlackAuthorResolver } from './slack-author-resolver'
import { slackTsToMillis } from './slack-bot-time'
import { createSlackChannelResolver } from './slack-channel-resolver'
import { classifyInbound, type InboundDropReason } from './slack-classify'
import { createSlackReactionCallback, createSlackRemoveReactionCallback } from './slack-reactions'

export type SlackAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: SlackAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type SlackCredentialStore = {
  getAccount(id?: string): Promise<SlackAccountRecord | null>
}

export type SlackAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  logger?: SlackAdapterLogger
  selfAliasesRef?: () => readonly string[]
  credentialsStore?: SlackCredentialStore
  accountId?: string
  createClient?: () => SlackClient
  createListener?: (client: SlackClient) => SlackListener
}

export type SlackAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

export type SlackFileReader = (path: string) => Promise<Buffer>

export function createSlackOutboundCallback(deps: {
  client: Pick<SlackClient, 'sendMessage' | 'uploadFile'>
  logger: SlackAdapterLogger
  formatChannelTag: (chat: string) => Promise<string>
  readFile?: SlackFileReader
  resolvePath?: (path: string) => string
}): OutboundCallback {
  const readFile = deps.readFile ?? defaultReadFile
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'slack') return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    const text = msg.text ?? ''
    const attachments = msg.attachments ?? []
    if (text === '' && attachments.length === 0) return { ok: false, error: 'message has neither text nor attachments' }
    const tag = await deps.formatChannelTag(msg.chat)
    const threadTs = msg.replyTo?.externalMessageId ?? msg.thread ?? undefined
    deps.logger.info(
      `[slack] outbound ${tag} text_len=${text.length} attachments=${attachments.length}${threadTs !== undefined ? ` thread=${threadTs}` : ''}`,
    )
    try {
      if (text !== '') {
        for (const chunk of chunkMarkdown(text, 11_500)) await deps.client.sendMessage(msg.chat, chunk, threadTs)
      }
      for (const attachment of attachments) {
        const path = deps.resolvePath ? deps.resolvePath(attachment.path) : attachment.path
        const buffer = await readFile(path)
        const filename = attachment.filename ?? basename(path)
        await deps.client.uploadFile([msg.chat], buffer, filename)
      }
      return { ok: true }
    } catch (err) {
      const message = describe(err)
      deps.logger.error(`[slack] outbound failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createSlackHistoryCallback(deps: {
  client: Pick<SlackClient, 'getMessages'>
  logger: SlackAdapterLogger
}): HistoryCallback {
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    try {
      const messages = await deps.client.getMessages(args.chat, { limit: clampLimit(args.limit, 100) })
      return { ok: true, messages: messages.map(mapSlackHistoryMessage).reverse() }
    } catch (err) {
      const message = describe(err)
      deps.logger.warn(`[slack] history fetch failed: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createSlackMembershipResolver(deps: {
  client: Pick<SlackClient, 'listChannelMembers'>
  logger: SlackAdapterLogger
  historyCallback: HistoryCallback
  selfUserIdRef: () => string | null
  now?: () => number
}): MembershipResolver {
  const now = deps.now ?? Date.now
  return async (key): Promise<MembershipResolverResult> => {
    if (key.adapter !== 'slack') return { kind: 'permanent' } satisfies MembershipResolverFailure
    if (key.workspace === '@dm') return { humans: 1, bots: 1, fetchedAt: now(), truncated: false }
    try {
      const members = await deps.client.listChannelMembers(key.chat)
      const capped = members.slice(0, MEMBERSHIP_ENUMERATION_CAP)
      const selfUserId = deps.selfUserIdRef()
      let bots = 0
      const humanMemberIds: string[] = []
      for (const member of capped) {
        if (selfUserId !== null && member === selfUserId) bots++
        else humanMemberIds.push(member)
      }
      const truncated = members.length >= MEMBERSHIP_ENUMERATION_CAP
      if (truncated) return { humans: humanMemberIds.length, bots, fetchedAt: now(), truncated }
      return { humans: humanMemberIds.length, bots, fetchedAt: now(), truncated, humanMemberIds }
    } catch (err) {
      deps.logger.warn(`[slack] membership channel=${key.chat} failed: ${describe(err)}; deriving from recent history`)
      return await deriveMembershipFromHistory({
        fetchHistory: (limit) => deps.historyCallback({ chat: key.chat, thread: key.thread, limit }),
        now,
      })
    }
  }
}

export function createSlackFetchAttachmentCallback(deps: {
  client: Pick<SlackClient, 'downloadFile'>
  logger: SlackAdapterLogger
}): FetchAttachmentCallback {
  return async ({ ref, filename }) => {
    try {
      const { buffer, file } = await deps.client.downloadFile(ref)
      return {
        ok: true,
        buffer,
        filename: filename ?? file.name ?? 'attachment',
        mimetype: file.mimetype,
        size: buffer.length,
      }
    } catch (err) {
      const message = describe(err)
      deps.logger.error(`[slack] fetchAttachment failed for ${ref}: ${message}`)
      return { ok: false, error: message }
    }
  }
}

export function createSlackAdapter(options: SlackAdapterOptions): SlackAdapter {
  const logger = options.logger ?? consoleLogger
  const createClient = options.createClient ?? (() => new SlackClient())
  const createListener = options.createListener ?? ((client) => new SlackListener(client))
  const client = createClient()
  let listener: SlackListener | null = null
  let selfUserId: string | null = null
  let selfName: string | null = null
  let teamId = ''
  let teamName: string | null = null
  let connected = false
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  const channelResolver = createSlackChannelResolver({ client, teamNameRef: () => teamName })
  const authorResolver = createSlackAuthorResolver({ client })
  const selfIdentityResolver: ChannelSelfIdentityResolver = () =>
    selfUserId !== null ? { id: selfUserId, username: selfName ?? selfUserId } : null
  const formatChannelTag = async (chat: string): Promise<string> => {
    const names = await channelResolver({ adapter: 'slack', workspace: teamId, chat, thread: null }).catch(
      (): ResolvedChannelNames => ({}),
    )
    const label = names.chatName ?? null
    return label === null || label === chat ? `channel=${chat}` : `channel=${label}(${chat})`
  }
  const historyCallback = createSlackHistoryCallback({ client, logger })
  const membershipResolver = createSlackMembershipResolver({
    client,
    logger,
    historyCallback,
    selfUserIdRef: () => selfUserId,
  })
  const outboundCallback = createSlackOutboundCallback({ client, logger, formatChannelTag })
  const fetchAttachmentCallback = createSlackFetchAttachmentCallback({ client, logger })
  const reactionCallback = createSlackReactionCallback({ client })
  const removeReactionCallback = createSlackRemoveReactionCallback({ client })

  const handleMessage = async (event: SlackRTMMessageEvent): Promise<void> => {
    inflightInbounds++
    try {
      const tag = await formatChannelTag(event.channel)
      logger.info(
        `[slack] inbound id=${event.ts} author=${event.user ?? '(none)'} ${tag} text_len=${(event.text ?? '').length}`,
      )
      const verdict = classifyInbound(event, options.configRef(), {
        teamId,
        selfUserId,
        selfAliases: options.selfAliasesRef?.() ?? [],
      })
      if (verdict.kind === 'drop') {
        logger.info(`[slack] dropped id=${event.ts} reason=${verdict.reason}${dropHint(verdict.reason)}`)
        return
      }
      const payload = { ...verdict.payload, authorName: await authorResolver.resolve(verdict.payload.authorId) }
      logger.info(`[slack] routed id=${event.ts} ${tag} mention=${payload.isBotMention}`)
      await options.router.route(payload)
    } catch (err) {
      logger.error(`[slack] handleInbound failed: ${describe(err)}`)
    } finally {
      inflightInbounds--
      if (inflightInbounds === 0 && stopWaiters.length > 0) {
        const waiters = stopWaiters
        stopWaiters = []
        for (const w of waiters) w()
      }
    }
  }

  const handleReaction = (kind: 'added' | 'removed', event: SlackRTMReactionEvent): void => {
    logger.info(`[slack] reaction_${kind} channel=${event.item.channel} ts=${event.item.ts} emoji=${event.reaction}`)
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      try {
        const account = await (options.credentialsStore ?? null)?.getAccount(options.accountId)
        if (account === null || account === undefined) {
          throw new Error('no Slack account in secrets.json#channels.slack (run typeclaw init to authenticate)')
        }
        await client.login({ token: account.token, cookie: account.cookie })
        const auth = await client.testAuth()
        selfUserId = auth.user_id
        selfName = auth.user ?? auth.user_id
        teamId = auth.team_id
        teamName = auth.team ?? account.workspace_name ?? null
        logger.info(`[slack] authenticated as ${selfName} (${selfUserId}) team=${teamName ?? teamId}`)
      } catch (err) {
        started = false
        selfUserId = null
        teamId = ''
        logger.error(`[slack] login failed: ${describe(err)}`)
        throw err
      }

      listener = createListener(client)
      let listenerConnected = false
      let listenerStartupError: Error | null = null
      listener.on('connected', (info) => {
        listenerConnected = true
        connected = true
        selfUserId = info.self.id
        teamId = info.team.id
      })
      listener.on('disconnected', () => {
        connected = false
        logger.warn('[slack] disconnected')
      })
      listener.on('error', (err) => {
        if (!listenerConnected && listenerStartupError === null) listenerStartupError = err
        logger.error(`[slack] listener error: ${describe(err)}`)
      })
      listener.on('message', (event) => void handleMessage(event))
      listener.on('reaction_added', (event) => handleReaction('added', event))
      listener.on('reaction_removed', (event) => handleReaction('removed', event))

      options.router.registerOutbound('slack', teamId, outboundCallback)
      options.router.registerConfig('slack', teamId, options.configRef)
      options.router.setTypingCapability('slack', teamId, false)
      options.router.registerChannelNameResolver('slack', teamId, channelResolver)
      options.router.registerSelfIdentity('slack', teamId, selfIdentityResolver)
      options.router.registerHistory('slack', teamId, historyCallback)
      options.router.registerFetchAttachment('slack', teamId, fetchAttachmentCallback)
      options.router.registerMembership('slack', teamId, membershipResolver)
      options.router.registerReaction('slack', teamId, reactionCallback)
      options.router.registerRemoveReaction('slack', teamId, removeReactionCallback)

      const rollbackStart = (reason: string, cause: Error): never => {
        options.router.unregisterOutbound('slack', teamId, outboundCallback)
        options.router.unregisterConfig('slack', teamId, options.configRef)
        options.router.setTypingCapability('slack', teamId, false)
        options.router.unregisterChannelNameResolver('slack', teamId, channelResolver)
        options.router.unregisterSelfIdentity('slack', teamId, selfIdentityResolver)
        options.router.unregisterHistory('slack', teamId, historyCallback)
        options.router.unregisterFetchAttachment('slack', teamId, fetchAttachmentCallback)
        options.router.unregisterMembership('slack', teamId, membershipResolver)
        options.router.unregisterReaction('slack', teamId, reactionCallback)
        options.router.unregisterRemoveReaction('slack', teamId, removeReactionCallback)
        listener?.stop()
        listener = null
        selfUserId = null
        connected = false
        started = false
        logger.error(`[slack] ${reason}: ${describe(cause)}`)
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
      options.router.unregisterOutbound('slack', teamId, outboundCallback)
      options.router.unregisterConfig('slack', teamId, options.configRef)
      options.router.setTypingCapability('slack', teamId, false)
      options.router.unregisterChannelNameResolver('slack', teamId, channelResolver)
      options.router.unregisterSelfIdentity('slack', teamId, selfIdentityResolver)
      options.router.unregisterHistory('slack', teamId, historyCallback)
      options.router.unregisterFetchAttachment('slack', teamId, fetchAttachmentCallback)
      options.router.unregisterMembership('slack', teamId, membershipResolver)
      options.router.unregisterReaction('slack', teamId, reactionCallback)
      options.router.unregisterRemoveReaction('slack', teamId, removeReactionCallback)
      listener?.stop()
      listener = null
      connected = false
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      selfUserId = null
    },

    isConnected(): boolean {
      return started && selfUserId !== null && connected
    },
  }
}

async function defaultReadFile(path: string): Promise<Buffer> {
  return Buffer.from(await Bun.file(path).arrayBuffer())
}

function mapSlackHistoryMessage(msg: SlackMessage): ChannelHistoryMessage {
  const attachments = (msg.files ?? []).map((file, index) => ({
    id: index + 1,
    kind: 'file' as const,
    ref: file.id,
    filename: file.name,
    mimetype: file.mimetype,
  }))
  return {
    externalMessageId: msg.ts,
    authorId: msg.user ?? msg.username ?? 'unknown',
    authorName: msg.username ?? msg.user ?? 'unknown',
    text: msg.text,
    ts: slackTsToMillis(msg.ts),
    isBot: false,
    replyToBotMessageId: null,
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}

function clampLimit(requested: number, max: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function dropHint(reason: InboundDropReason): string {
  switch (reason) {
    case 'empty_text':
      return ' (message had no text)'
    case 'pre_connect':
    case 'self_author':
    case 'no_user':
    case 'slack_system_message':
      return ''
  }
}
