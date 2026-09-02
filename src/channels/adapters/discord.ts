import {
  DiscordClient,
  DiscordListener,
  type DiscordGatewayMessageCreateEvent,
  type DiscordMessage,
} from 'agent-messenger/discord'

import {
  enrichHistoricalProvenance,
  type HistoricalProvenanceResolver,
} from '@/bundled-plugins/memory/provenance-index'
import {
  DEFAULT_ATTACHMENT_MAX_BYTES,
  readAttachmentErrorSnippet,
  readAttachmentResponse,
} from '@/channels/fetch-attachment'
import type { MembershipResolver, MembershipResolverResult } from '@/channels/membership'
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
import type { DiscordAccountRecord } from '@/secrets/schema'

import { describeError } from '../describe-error'
import { createDiscordAuthorResolver } from './discord-author-resolver'
import { createDiscordChannelResolver } from './discord-channel-resolver'
import {
  classifyInbound,
  type DiscordAttachmentCarrier,
  type InboundDropReason,
  splitDiscordAttachments,
} from './discord-classify'
import { createDiscordUserEditMessageCallback } from './discord-edit'
import { createDiscordReactionCallback, createDiscordRemoveReactionCallback } from './discord-reactions'
import {
  createInMemoryDiscordRecoveryStore,
  DISCORD_RECOVERY_REQUEST_TIMEOUT_MS,
  fetchDiscordRecovery,
  loadDiscordRecoveryStore,
  settleWithin,
  type DiscordRecoveryCursor,
  type DiscordRecoveryStore,
} from './discord-recovery'

const DISCORD_RECOVERY_MAX_CHANNELS = 20
const DISCORD_RECOVERY_MAX_TOTAL_MESSAGES = 100
const DISCORD_RECOVERY_MAX_DURATION_MS = 20_000
const DISCORD_DISCONNECT_DRAIN_TIMEOUT_MS = 5_000

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
  agentDir?: string
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  logger?: DiscordAdapterLogger
  selfAliasesRef?: () => readonly string[]
  credentialsStore?: DiscordCredentialStore
  createClient?: () => DiscordClient
  createListener?: (client: DiscordClient) => DiscordListener
  fetchImpl?: typeof fetch
  enrichHistoricalProvenance?: typeof enrichHistoricalProvenance
  recoveryStore?: DiscordRecoveryStore
  now?: () => number
  recoveryMaxDurationMs?: number
  disconnectDrainTimeoutMs?: number
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

    // The native reply reference rides on exactly ONE message so Discord shows a
    // single reply-arrow: the first text chunk when there is text, otherwise the
    // first file upload. Every later chunk/file posts bare.
    const replyTo = msg.replyTo?.externalMessageId
    const replyOnFirstFile = text === '' ? replyTo : undefined
    const replyOption = (reference: string | undefined): { reply_to: string } | undefined =>
      reference !== undefined ? { reply_to: reference } : undefined
    try {
      // Attachments first, then text — Discord's upstream uploadFile takes no
      // content body, so a failed upload must not leave a text-only message
      // already posted (see OutboundMessage.attachments contract).
      for (const [index, attachment] of attachments.entries()) {
        await deps.client.uploadFile(msg.chat, attachment.path, replyOption(index === 0 ? replyOnFirstFile : undefined))
      }
      if (text !== '') {
        const chunks = chunkMarkdown(text, 2_000)
        for (const [index, chunk] of chunks.entries()) {
          await deps.client.sendMessage(msg.chat, chunk, replyOption(index === 0 ? replyTo : undefined))
        }
      }
      // The user-account SDK send APIs return no posted-message id, so no reaction target ref is available.
      return { ok: true }
    } catch (err) {
      const message = describeError(err)
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
      const message = describeError(err)
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
  return async ({ ref, filename, maxBytes = DEFAULT_ATTACHMENT_MAX_BYTES }) => {
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
        const body = await readAttachmentErrorSnippet(res)
        const message = `discord cdn fetch ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`
        deps.logger.error(`[discord] fetchAttachment failed for ${url.toString()}: ${message}`)
        return { ok: false, error: message }
      }
      const buffer = await readAttachmentResponse(res, maxBytes)
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
      const message = describeError(err)
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
  let lifecycleGeneration = 0
  let inflightInbounds = 0
  const inflightOperations = new Set<Promise<void>>()
  const pendingInbounds = new Map<symbol, DiscordRecoveryCursor>()
  let stopWaiters: Array<() => void> = []
  let recoveryStore = options.recoveryStore ?? null
  let recoveryBarrier = Promise.resolve()
  let pendingInitialConnect: { promise: Promise<void>; resolve: () => void } | null = null
  let pendingReconnect: { promise: Promise<void>; resolve: () => void } | null = null
  const channelBarriers = new Map<string, Promise<void>>()
  const now = options.now ?? Date.now
  const recoveryMaxDurationMs = options.recoveryMaxDurationMs ?? DISCORD_RECOVERY_MAX_DURATION_MS
  const disconnectDrainTimeoutMs = options.disconnectDrainTimeoutMs ?? DISCORD_DISCONNECT_DRAIN_TIMEOUT_MS

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
  const editMessageCallback = createDiscordUserEditMessageCallback({ client })

  const processMessage = async (event: DiscordGatewayMessageCreateEvent): Promise<boolean> => {
    const verdict = classifyInbound(event, options.configRef(), {
      selfUserId,
      selfAliases: options.selfAliasesRef?.() ?? [],
    })
    const tag = event.guild_id === undefined ? `channel=${event.channel_id}` : await formatChannelTag(event.channel_id)
    logger.info(
      `[discord] inbound id=${event.id} author=${event.author.id || '(none)'} ${tag} text_len=${event.content.length}`,
    )
    if (verdict.kind === 'drop') {
      logger.info(`[discord] dropped id=${event.id} reason=${verdict.reason}${dropHint(verdict.reason)}`)
      return false
    }
    const attachments = (event.attachments ?? []).map((file, index) => ({
      id: index + 1,
      kind: 'file' as const,
      ref: file.url,
      filename: file.filename,
      mimetype: file.content_type,
    }))
    const room = verdict.payload.isDm ? undefined : await channelResolver.resolveRoom(verdict.payload.chat)
    const payload = {
      ...verdict.payload,
      authorName: await authorResolver.resolve(verdict.payload.authorId),
      ...(room !== undefined ? { room } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    }
    logger.info(`[discord] routed id=${event.id} ${tag} mention=${payload.isBotMention}`)
    await options.router.route(payload)
    return true
  }

  const trackInbound = (operation: Promise<void>): Promise<void> => {
    inflightInbounds++
    inflightOperations.add(operation)
    return operation.finally(() => {
      inflightOperations.delete(operation)
      inflightInbounds--
      if (inflightInbounds === 0 && stopWaiters.length > 0) {
        const waiters = stopWaiters
        stopWaiters = []
        for (const w of waiters) w()
      }
    })
  }

  const enqueueChannelOperation = <T>(channelId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = channelBarriers.get(channelId) ?? Promise.resolve()
    const queued = previous.then(operation)
    const barrier = queued.then(
      () => undefined,
      () => undefined,
    )
    channelBarriers.set(channelId, barrier)
    void barrier.finally(() => {
      if (channelBarriers.get(channelId) === barrier) channelBarriers.delete(channelId)
    })
    return queued
  }

  const enqueueChannelInbound = (channelId: string, operation: () => Promise<void>): Promise<void> => {
    const recoveryGate = recoveryBarrier
    return trackInbound(recoveryGate.then(() => enqueueChannelOperation(channelId, operation)))
  }

  const enqueueRecovery = (operation: () => Promise<void>): Promise<void> => {
    const queued = recoveryBarrier.then(operation)
    recoveryBarrier = queued.catch(() => undefined)
    return trackInbound(queued)
  }

  const handleMessage = (event: DiscordGatewayMessageCreateEvent, acceptedGeneration: number): Promise<void> => {
    if (!started || acceptedGeneration !== lifecycleGeneration) return Promise.resolve()
    const pendingKey = Symbol(event.id)
    pendingInbounds.set(pendingKey, {
      channelId: event.channel_id,
      workspace: event.guild_id ?? '@dm',
      messageId: event.id,
      processedAt: now(),
    })
    const operation = enqueueChannelInbound(event.channel_id, async () => {
      if (recoveryStore?.isProcessed(event.channel_id, event.id) === true) {
        logger.info(`[discord] deduplicated id=${event.id} channel=${event.channel_id}`)
        return
      }
      try {
        await processMessage(event)
        await recoveryStore?.markProcessed({
          channelId: event.channel_id,
          workspace: event.guild_id ?? '@dm',
          messageId: event.id,
          processedAt: now(),
        })
      } catch (err) {
        logger.error(`[discord] handleInbound failed: ${describeError(err)}`)
        try {
          await recoveryStore?.markRouteFailed({
            channelId: event.channel_id,
            workspace: event.guild_id ?? '@dm',
            failedMessageId: event.id,
            failedAt: now(),
          })
        } catch (persistError) {
          logger.error(`[discord] failed to retain route gap: ${describeError(persistError)}`)
        }
      }
    })
    return operation.finally(() => {
      pendingInbounds.delete(pendingKey)
    })
  }

  const replayAfterReconnect = async (): Promise<void> => {
    if (!started || recoveryStore === null) return
    const store = recoveryStore
    const disconnectedAt = store.disconnectedAt()
    if (disconnectedAt === null) return
    const replayEpoch = store.currentEpoch()

    const downtimeMs = Math.max(0, now() - disconnectedAt)
    const deadline = performance.now() + recoveryMaxDurationMs
    const replayCursors = store.listReplayCursors().sort((left, right) => right.processedAt - left.processedAt)
    const selectedCursors = replayCursors.slice(0, DISCORD_RECOVERY_MAX_CHANNELS)
    let remainingMessages = DISCORD_RECOVERY_MAX_TOTAL_MESSAGES
    let replayed = 0
    let skipped = 0
    let cappedChannels = replayCursors.length - selectedCursors.length
    let unavailableChannels = 0
    let deadlineReached = false

    cursorLoop: for (const [cursorIndex, cursor] of selectedCursors.entries()) {
      if (!started) break
      const fetchBudgetMs = deadline - performance.now()
      if (remainingMessages === 0) {
        cappedChannels += selectedCursors.length - cursorIndex
        break
      }
      if (fetchBudgetMs <= 0) {
        deadlineReached = true
        cappedChannels += selectedCursors.length - cursorIndex
        break
      }
      const fetched = await settleWithin(
        fetchDiscordRecovery({
          client,
          channelId: cursor.channelId,
          workspace: cursor.workspace,
          after: cursor.messageId,
          now: now(),
          requestTimeoutMs: Math.min(DISCORD_RECOVERY_REQUEST_TIMEOUT_MS, fetchBudgetMs),
        }),
        fetchBudgetMs,
      )
      if (!started) break
      if (fetched.kind === 'timed-out') {
        deadlineReached = true
        cappedChannels += selectedCursors.length - cursorIndex
        break
      }
      if (fetched.kind === 'failed') {
        unavailableChannels++
        logger.warn(
          `[discord] replay downtime_ms=${downtimeMs} outcome=unavailable channel=${cursor.channelId} error=${describeError(fetched.error)}`,
        )
        continue
      }
      const result = fetched.value
      if (!result.ok) {
        unavailableChannels++
        logger.warn(
          `[discord] replay downtime_ms=${downtimeMs} outcome=unavailable channel=${cursor.channelId} error=${result.error}`,
        )
        continue
      }

      let cursorCompleted = true
      if (result.outcome === 'capped') {
        cappedChannels++
        skipped += result.skipped
        logger.warn(
          `[discord] replay downtime_ms=${downtimeMs} outcome=capped channel=${cursor.channelId} skipped_age=${result.skippedByAge} skipped_count=${result.skippedByCount} more_may_exist=${String(result.moreMayExist)}`,
        )
      }
      const aggregateOverflow = Math.max(0, result.messages.length - remainingMessages)
      if (aggregateOverflow > 0) {
        cursorCompleted = false
        cappedChannels++
        skipped += aggregateOverflow
        logger.warn(
          `[discord] replay downtime_ms=${downtimeMs} outcome=capped channel=${cursor.channelId} skipped_aggregate=${aggregateOverflow}`,
        )
      }
      const messages = result.messages.slice(0, remainingMessages)
      remainingMessages -= messages.length
      for (const [messageIndex, message] of messages.entries()) {
        if (!started) {
          cursorCompleted = false
          break cursorLoop
        }
        if (performance.now() >= deadline) {
          cursorCompleted = false
          deadlineReached = true
          skipped += messages.length - messageIndex
          cappedChannels += selectedCursors.length - cursorIndex - 1
          break cursorLoop
        }
        const delivery = await enqueueChannelOperation(message.channel_id, async () => {
          if (!started) return 'stopped' as const
          if (store.isReplayProcessed(message.channel_id, message.id)) return 'deduplicated' as const
          try {
            await processMessage(toGatewayMessage(message, cursor.workspace))
            await store.markProcessed({
              channelId: message.channel_id,
              workspace: cursor.workspace,
              messageId: message.id,
              processedAt: now(),
            })
            return 'replayed' as const
          } catch (err) {
            logger.error(
              `[discord] replay downtime_ms=${downtimeMs} outcome=route_failed channel=${cursor.channelId} id=${message.id} error=${describeError(err)}`,
            )
            return 'failed' as const
          }
        })
        if (delivery === 'replayed') replayed++
        else if (delivery === 'failed' || delivery === 'stopped') {
          cursorCompleted = false
          if (delivery === 'failed') unavailableChannels++
          break
        }
      }
      if (cursorCompleted && started) await store.completeReplay(cursor.channelId, replayEpoch)
    }

    if (!started) return
    if (deadlineReached) {
      logger.warn(
        `[discord] replay downtime_ms=${downtimeMs} outcome=capped reason=duration duration_limit_ms=${recoveryMaxDurationMs}`,
      )
    }
    if (replayCursors.length > selectedCursors.length) {
      logger.warn(
        `[discord] replay downtime_ms=${downtimeMs} outcome=capped skipped_channels=${replayCursors.length - selectedCursors.length} channel_limit=${DISCORD_RECOVERY_MAX_CHANNELS} message_limit=${DISCORD_RECOVERY_MAX_TOTAL_MESSAGES} duration_limit_ms=${recoveryMaxDurationMs}`,
      )
    }
    const outcome = unavailableChannels > 0 ? 'partial' : cappedChannels > 0 ? 'capped' : 'succeeded'
    const log = unavailableChannels > 0 || cappedChannels > 0 ? logger.warn : logger.info
    log(
      `[discord] replay downtime_ms=${downtimeMs} outcome=${outcome} replayed=${replayed} skipped_observed=${skipped} capped_channels=${cappedChannels} unavailable_channels=${unavailableChannels}`,
    )
  }

  return {
    async start(): Promise<void> {
      if (started) return
      started = true
      const generation = ++lifecycleGeneration
      let startInitialConnectSignal: { promise: Promise<void>; resolve: () => void } | null = null
      try {
        const account = await (options.credentialsStore ?? null)?.getAccount()
        if (account === null || account === undefined) {
          throw new Error('no Discord account in secrets.json#channels.discord (run typeclaw init to authenticate)')
        }
        await client.login({ token: account.token })
        const auth = await client.testAuth()
        const loadedRecoveryStore =
          recoveryStore ??
          (options.agentDir === undefined
            ? createInMemoryDiscordRecoveryStore(auth.id)
            : await loadDiscordRecoveryStore(options.agentDir, auth.id, logger))
        if (!started || generation !== lifecycleGeneration) throw new Error('Discord adapter stopped during start')
        token = account.token
        selfUserId = auth.id
        selfName = auth.global_name ?? auth.username
        recoveryStore = loadedRecoveryStore
        logger.info(`[discord] authenticated as ${selfName} (${selfUserId})`)
        if (recoveryStore.disconnectedAt() !== null) {
          startInitialConnectSignal = createSignal()
          pendingInitialConnect = startInitialConnectSignal
          const signal = startInitialConnectSignal
          void enqueueRecovery(async () => {
            await signal.promise
            if (started && generation === lifecycleGeneration) await replayAfterReconnect()
          }).catch((err) => {
            logger.error(`[discord] replay failed: ${describeError(err)}`)
          })
        }
      } catch (err) {
        if (generation === lifecycleGeneration) {
          started = false
          selfUserId = null
          token = null
        }
        logger.error(`[discord] login failed: ${describeError(err)}`)
        throw err
      }

      const startListener = createListener(client)
      listener = startListener
      let listenerConnected = false
      let listenerStartupError: Error | null = null
      listener.on('connected', (info) => {
        if (!started || generation !== lifecycleGeneration) return
        listenerConnected = true
        connected = true
        selfUserId = info.user.id
        selfName = info.user.username
        const initialConnect = pendingInitialConnect
        const reconnect = pendingReconnect
        if (initialConnect !== null) {
          pendingInitialConnect = null
          initialConnect.resolve()
        }
        if (reconnect !== null) {
          pendingReconnect = null
          reconnect.resolve()
        }
      })
      listener.on('disconnected', () => {
        if (generation !== lifecycleGeneration) return
        connected = false
        if (started && pendingReconnect === null) {
          const reconnect = createSignal()
          pendingReconnect = reconnect
          const disconnectedAt = now()
          const pendingChannels = Array.from(inflightOperations)
          const pendingMetadata = Array.from(pendingInbounds.entries())
          void enqueueRecovery(async () => {
            const drain = await settleWithin(
              Promise.all(pendingChannels).then(() => undefined),
              disconnectDrainTimeoutMs,
            )
            if (drain.kind === 'timed-out') {
              logger.warn(
                `[discord] disconnect drain timed out after ${disconnectDrainTimeoutMs}ms; snapshotting pending anchors`,
              )
              for (const [pendingKey, pending] of pendingMetadata) {
                if (!pendingInbounds.has(pendingKey)) continue
                await recoveryStore?.markRouteFailed({
                  channelId: pending.channelId,
                  workspace: pending.workspace,
                  failedMessageId: pending.messageId,
                  failedAt: pending.processedAt,
                })
              }
            }
            if (started && generation === lifecycleGeneration) {
              await recoveryStore?.markDisconnected(disconnectedAt)
            }
            await reconnect.promise
            if (started && generation === lifecycleGeneration) await replayAfterReconnect()
          }).catch((err) => {
            logger.error(`[discord] failed to persist disconnect: ${describeError(err)}`)
          })
        }
        logger.warn('[discord] disconnected')
      })
      listener.on('error', (err) => {
        if (!listenerConnected && listenerStartupError === null) listenerStartupError = err
        logger.error(`[discord] listener error: ${describeError(err)}`)
      })
      listener.on('message_create', (event) => void handleMessage(event, generation))
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
        startListener.stop()
        startInitialConnectSignal?.resolve()
        if (pendingInitialConnect === startInitialConnectSignal) pendingInitialConnect = null
        if (generation === lifecycleGeneration) {
          unregisterCallbacks(options.router)
          if (listener === startListener) listener = null
          selfUserId = null
          token = null
          connected = false
          started = false
          pendingReconnect?.resolve()
          pendingReconnect = null
          if (options.recoveryStore === undefined) recoveryStore = null
        }
        logger.error(`[discord] ${reason}: ${describeError(cause)}`)
        throw cause
      }

      try {
        await startListener.start()
      } catch (err) {
        rollbackStart('listener start threw', err instanceof Error ? err : new Error(describeError(err)))
      }
      if (!started || generation !== lifecycleGeneration) {
        rollbackStart('listener start superseded', new Error('Discord adapter stopped during listener start'))
      }
      if (!listenerConnected) {
        rollbackStart(
          'listener start failed silently',
          listenerStartupError ?? new Error('listener.start() returned without emitting connected'),
        )
      }

      if (options.agentDir !== undefined) {
        const runEnrichment = options.enrichHistoricalProvenance ?? enrichHistoricalProvenance
        const resolveHistorical: HistoricalProvenanceResolver = async (where) => {
          const key = {
            adapter: 'discord' as const,
            workspace: where.workspace,
            chat: where.chat,
            thread: where.thread ?? null,
          }
          const [names, roomStatus] = await Promise.all([
            channelResolver(key),
            channelResolver.resolveRoomStatus(where.chat),
          ])
          const room = roomStatus.room
          return {
            where: {
              ...where,
              ...names,
              ...(room?.parentChat !== undefined ? { parentChat: room.parentChat } : {}),
              ...(room?.parentChatName !== undefined ? { parentChatName: room.parentChatName } : {}),
            },
            parentChecked: roomStatus.parentChecked,
          }
        }
        void runEnrichment(options.agentDir, resolveHistorical, { adapter: 'discord' }).then(
          (result) => {
            logger.info(
              `[discord] historical provenance enrichment scanned=${result.scanned} attempted=${result.attempted} resolved=${result.resolved} failed=${result.failed} timed_out=${result.timedOut} changed=${String(result.changed)}`,
            )
          },
          (error: unknown) => {
            logger.warn(`[discord] historical provenance enrichment failed: ${describeError(error)}`)
          },
        )
      }
    },

    async stop(): Promise<void> {
      if (!started) return
      const disconnectedAt = now()
      started = false
      lifecycleGeneration++
      pendingInitialConnect?.resolve()
      pendingInitialConnect = null
      pendingReconnect?.resolve()
      pendingReconnect = null
      unregisterCallbacks(options.router)
      listener?.stop()
      listener = null
      connected = false
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      try {
        await recoveryStore?.markDisconnected(disconnectedAt)
      } catch (err) {
        logger.error(`[discord] failed to persist stop recovery snapshot: ${describeError(err)}`)
      }
      selfUserId = null
      token = null
      if (options.recoveryStore === undefined) recoveryStore = null
    },

    isConnected(): boolean {
      return started && selfUserId !== null && connected
    },
  }

  function registerCallbacks(router: ChannelRouter): void {
    router.registerOutbound('discord', outboundCallback)
    router.setTypingCapability('discord', false)
    router.registerChannelNameResolver('discord', channelResolver)
    router.registerSelfIdentity('discord', selfIdentityResolver)
    router.registerHistory('discord', historyCallback)
    router.registerFetchAttachment('discord', fetchAttachmentCallback)
    router.registerMembership('discord', membershipResolver)
    router.registerReaction('discord', reactionCallback)
    router.registerRemoveReaction('discord', removeReactionCallback)
    router.registerEditMessage('discord', editMessageCallback)
  }

  function unregisterCallbacks(router: ChannelRouter): void {
    router.unregisterOutbound('discord', outboundCallback)
    router.setTypingCapability('discord', false)
    router.unregisterChannelNameResolver('discord', channelResolver)
    router.unregisterSelfIdentity('discord', selfIdentityResolver)
    router.unregisterHistory('discord', historyCallback)
    router.unregisterFetchAttachment('discord', fetchAttachmentCallback)
    router.unregisterMembership('discord', membershipResolver)
    router.unregisterReaction('discord', reactionCallback)
    router.unregisterRemoveReaction('discord', removeReactionCallback)
    router.unregisterEditMessage('discord', editMessageCallback)
  }
}

// WORKAROUND: the SDK's `DiscordMessage` type omits `author.bot` and
// `attachments`, but the REST API returns both and the client passes the body
// through unchanged, so they are present at runtime. `=== true` fails closed to
// human if absent. That flag feeds history-derived membership
// (deriveMembershipFromHistory), which otherwise miscounts peer bots as humans
// and inflates effectiveHumans.
type RawDiscordMessage = DiscordMessage & DiscordAttachmentCarrier & { author: { bot?: boolean } }

function mapDiscordHistoryMessage(msg: DiscordMessage): ChannelHistoryMessage {
  const raw = msg as RawDiscordMessage
  // The REST history fetch bypasses the inbound classifier, so attachments on
  // already-posted messages must be mapped here too — otherwise they are
  // silently dropped and look_at_channel_attachment can never resolve them,
  // even though its error text tells the agent channel_history is the fix.
  const { text, attachments } = splitDiscordAttachments(msg.content, raw)
  return {
    externalMessageId: msg.id,
    authorId: msg.author.id,
    authorName: msg.author.username,
    text,
    ts: parseDiscordTimestamp(msg.timestamp),
    isBot: raw.author.bot === true,
    replyToBotMessageId: null,
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}

function parseDiscordTimestamp(timestamp: string): number {
  const millis = Date.parse(timestamp)
  return Number.isFinite(millis) ? millis : 0
}

function toGatewayMessage(message: DiscordMessage, workspace: string): DiscordGatewayMessageCreateEvent {
  return {
    ...message,
    type: 'MESSAGE_CREATE',
    guild_id: workspace === '@dm' ? undefined : workspace,
  }
}

function createSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: () => resolvePromise?.() }
}

const DISCORD_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net'])

function clampLimit(requested: number, max: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
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
