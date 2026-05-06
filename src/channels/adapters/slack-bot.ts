import {
  MEMBERSHIP_ENUMERATION_CAP,
  type MembershipResolver,
  type MembershipResolverFailure,
  type MembershipResolverResult,
} from '@/channels/membership'
import { deriveMembershipFromHistory } from '@/channels/membership-from-history'
import type { ChannelRouter } from '@/channels/router'
import { isAllowed, type ChannelAdapterConfig } from '@/channels/schema'
import type {
  ChannelHistoryMessage,
  FetchHistoryArgs,
  FetchHistoryResult,
  HistoryCallback,
  OutboundCallback,
  OutboundMessage,
  ResolvedChannelNames,
  SendResult,
  TypingCallback,
  TypingTarget,
} from '@/channels/types'

import {
  SlackBotClient,
  SlackBotListener,
  type SlackSocketAppMentionEvent,
  type SlackSocketMessageEvent,
} from './agent-messenger-slack-shim'
import { createSlackAuthorResolver } from './slack-bot-author-resolver'
import { createSlackChannelResolver } from './slack-bot-channel-resolver'
import { classifyInbound, type InboundDropReason } from './slack-bot-classify'
import { createSlackDedupe } from './slack-bot-dedupe'
import { slackTsToMillis } from './slack-bot-time'

// Resolvers fall back to the raw id on failure, so a name equal to the id
// means resolution failed; we render the bare id rather than `id(id)`. The
// prefix is intentionally only applied to the named form so we never log
// `#C0DEPLOY` when resolution fails.
function formatLabel(name: string | undefined, id: string, prefix = ''): string {
  if (name === undefined || name === '' || name === id) return id
  return `${prefix}${name}(${id})`
}

// app_mention payloads omit channel_type and never carry a subtype, so we
// promote them to a message-shaped event for the shared classifier. The
// promoted event is classified as a regular channel message; the
// `<@BOT_USER_ID>` substring inside `text` is what makes the classifier
// mark it as a mention.
export function promoteAppMentionToMessage(event: SlackSocketAppMentionEvent): SlackSocketMessageEvent {
  return {
    type: 'message',
    channel: event.channel,
    channel_type: 'channel',
    user: event.user,
    text: event.text,
    ts: event.ts,
    ...(event.thread_ts !== undefined ? { thread_ts: event.thread_ts } : {}),
    ...(event.event_ts !== undefined ? { event_ts: event.event_ts } : {}),
    ...(event.client_msg_id !== undefined ? { client_msg_id: event.client_msg_id } : {}),
  }
}

export type SlackBotAdapterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

const consoleLogger: SlackBotAdapterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export type SlackBotAdapterOptions = {
  router: ChannelRouter
  configRef: () => ChannelAdapterConfig
  token: string
  appToken: string
  logger?: SlackBotAdapterLogger
}

export type SlackBotAdapter = {
  start: () => Promise<void>
  stop: () => Promise<void>
  isConnected: () => boolean
}

// Slack's only bot-accessible typing-style signal is `assistant.threads.
// setStatus`, which is scoped to AI Assistant threads and requires a
// `thread_ts`. The classic `user_typing` is RTM-only and rejects bot
// tokens, so there is nothing to send for top-level (non-threaded) chats —
// we log and bail in that case. Slack auto-clears the status when the bot
// posts its reply, so we only set; we never explicitly clear.
//
// The router fires this on a heartbeat (~every few seconds while
// debouncing/generating). Slack rejects calls in non-Assistant channels
// with `channel_not_found` / `not_in_channel`-style errors; we surface
// those as a single warn line per heartbeat (matching the Discord
// adapter's non-2xx handling) rather than escalating to error, because
// the bot may simply be deployed in a regular channel.
export function createTypingCallback(deps: {
  client: Pick<SlackBotClient, 'setAssistantStatus'>
  configRef: () => ChannelAdapterConfig
  logger: SlackBotAdapterLogger
  formatChannelTag?: (workspace: string, chat: string) => Promise<string>
}): TypingCallback {
  const { client, configRef, logger, formatChannelTag } = deps
  return async (target: TypingTarget): Promise<void> => {
    if (target.adapter !== 'slack-bot') return
    const config = configRef()
    if (!isAllowed(config.allow, target.workspace, target.chat)) return
    const tag = formatChannelTag
      ? await formatChannelTag(target.workspace, target.thread ?? target.chat)
      : `channel=${target.thread ?? target.chat}`
    if (target.thread === undefined || target.thread === null || target.thread === '') {
      logger.info(`[slack-bot] typing (no-op, top-level chat) ${tag}`)
      return
    }
    try {
      await client.setAssistantStatus(target.chat, target.thread, 'is typing...')
    } catch (err) {
      logger.warn(`[slack-bot] typing ${tag} failed: ${describe(err)}`)
    }
  }
}

export const SLACK_HISTORY_LIMIT_MAX = 200

const SLACK_API_BASE = 'https://slack.com/api'

type SlackRawHistoryMessage = {
  ts: string
  type?: string
  subtype?: string
  user?: string
  bot_id?: string
  text?: string
  thread_ts?: string
  parent_user_id?: string
}

type SlackHistoryResponse = {
  ok: boolean
  error?: string
  messages?: SlackRawHistoryMessage[]
  response_metadata?: { next_cursor?: string }
}

type SlackConversationInfoResponse = {
  ok: boolean
  error?: string
  channel?: { num_members?: number }
}

type SlackConversationMembersResponse = {
  ok: boolean
  error?: string
  members?: string[]
}

type SlackUserInfoResponse = {
  ok: boolean
  error?: string
  user?: { is_bot?: boolean; deleted?: boolean }
}

export function createSlackMembershipResolver(deps: {
  token: string
  logger: SlackBotAdapterLogger
  historyCallback: HistoryCallback
  fetchImpl?: typeof fetch
  now?: () => number
}): MembershipResolver {
  const fetchFn = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const userBotCache = new Map<string, boolean>()
  return async (key): Promise<MembershipResolverResult> => {
    if (key.workspace === '@dm') return { humans: 1, bots: 1, fetchedAt: now(), truncated: false }

    const fallback = (): Promise<MembershipResolverResult> =>
      deriveMembershipFromHistory({
        fetchHistory: (limit) => deps.historyCallback({ chat: key.chat, thread: key.thread, limit }),
        now,
      })

    const info = await slackApi<SlackConversationInfoResponse>(fetchFn, deps.token, 'conversations.info', {
      channel: key.chat,
    })
    if (!info.ok) {
      // missing_scope / not_in_channel: the bot cannot see the channel's
      // member list at all, but `conversations.history` (or app_mention
      // delivery) usually still works enough to derive recent speakers.
      // Treat any permanent failure here as a signal to fall back rather
      // than propagate "I don't know" upstream — same shape as Discord's
      // 403 path.
      if (info.failure.kind === 'permanent') {
        deps.logger.warn(
          `[slack-bot] membership info channel=${key.chat} failed permanently: ${info.reason}; deriving from recent message authors`,
        )
        return await fallback()
      }
      deps.logger.warn(`[slack-bot] membership info channel=${key.chat} failed: ${info.reason}`)
      return info.failure
    }

    const total = Math.max(0, Math.floor(info.value.channel?.num_members ?? 0))
    if (total > MEMBERSHIP_ENUMERATION_CAP) {
      // Beyond the enumeration cap, the recent-speakers count is more
      // useful for engagement than a raw channel-wide approximation that
      // double-counts lurkers.
      return await fallback()
    }

    const members = await slackApi<SlackConversationMembersResponse>(fetchFn, deps.token, 'conversations.members', {
      channel: key.chat,
      limit: String(MEMBERSHIP_ENUMERATION_CAP),
    })
    if (!members.ok) {
      if (members.failure.kind === 'permanent') {
        deps.logger.warn(
          `[slack-bot] membership members channel=${key.chat} failed permanently: ${members.reason}; deriving from recent message authors`,
        )
        return await fallback()
      }
      deps.logger.warn(`[slack-bot] membership members channel=${key.chat} failed: ${members.reason}`)
      return members.failure
    }

    let bots = 0
    let humans = 0
    for (const userId of members.value.members ?? []) {
      const cached = userBotCache.get(userId)
      const isBot = cached ?? (await resolveSlackUserIsBot(fetchFn, deps.token, userId, deps.logger, userBotCache))
      if (isBot) bots++
      else humans++
    }
    return { humans, bots, fetchedAt: now(), truncated: false }
  }
}

type SlackApiResult<T> = { ok: true; value: T } | { ok: false; reason: string; failure: MembershipResolverFailure }

async function slackApi<T>(
  fetchFn: typeof fetch,
  token: string,
  method: string,
  fields: Record<string, string>,
): Promise<SlackApiResult<T>> {
  const body = new URLSearchParams(fields)
  let raw: { ok?: boolean; error?: string }
  try {
    const response = await fetchFn(`${SLACK_API_BASE}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: body.toString(),
    })
    raw = (await response.json()) as { ok?: boolean; error?: string }
  } catch (err) {
    return { ok: false, reason: describe(err), failure: { kind: 'transient' } }
  }
  if (raw.ok !== true) {
    const reason = raw.error ?? 'unknown slack error'
    return { ok: false, reason, failure: slackFailureForError(reason) }
  }
  return { ok: true, value: raw as T }
}

async function resolveSlackUserIsBot(
  fetchFn: typeof fetch,
  token: string,
  userId: string,
  logger: SlackBotAdapterLogger,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const info = await slackApi<SlackUserInfoResponse>(fetchFn, token, 'users.info', { user: userId })
  if (!info.ok) {
    logger.warn(`[slack-bot] membership users.info user=${userId} failed: ${info.reason}`)
    cache.set(userId, false)
    return false
  }
  const isBot = info.value.user?.is_bot === true
  cache.set(userId, isBot)
  return isBot
}

function slackFailureForError(error: string): MembershipResolverFailure {
  if (['invalid_auth', 'not_authed', 'not_in_channel', 'channel_not_found', 'missing_scope'].includes(error)) {
    return { kind: 'permanent' }
  }
  return { kind: 'transient' }
}

// Direct fetch to Slack's Web API. The shim only exposes postMessage /
// setAssistantStatus / testAuth, so history calls go through fetch using
// the same pattern the Discord adapter uses for /typing. Slack uses
// application/x-www-form-urlencoded for these endpoints; JSON works too
// when paired with the right Content-Type but URL-encoded is what every
// client library defaults to and is the most-tested wire format.
export function createSlackHistoryCallback(deps: {
  token: string
  configRef: () => ChannelAdapterConfig
  logger: SlackBotAdapterLogger
  botUserIdRef: () => string | null
  fetchImpl?: typeof fetch
}): HistoryCallback {
  const { token, configRef, logger, botUserIdRef } = deps
  const fetchFn = deps.fetchImpl ?? fetch
  return async (args: FetchHistoryArgs): Promise<FetchHistoryResult> => {
    const config = configRef()
    if (!isAllowed(config.allow, '@dm', args.chat) && !isAllowedAnyTeam(config.allow, args.chat)) {
      // Same defense-in-depth as outbound: refuse to fetch history for a
      // channel the operator hasn't admitted, even if the agent somehow
      // resolved its id. Returning an error rather than empty so the
      // agent doesn't think the channel is genuinely silent.
      return { ok: false, error: 'denied by allow rules' }
    }

    const limit = clampLimit(args.limit, SLACK_HISTORY_LIMIT_MAX)
    const endpoint = args.thread === null ? 'conversations.history' : 'conversations.replies'
    const body = new URLSearchParams()
    body.set('channel', args.chat)
    body.set('limit', String(limit))
    if (args.thread !== null) body.set('ts', args.thread)
    if (args.cursor !== undefined && args.cursor !== '') body.set('cursor', args.cursor)

    let raw: SlackHistoryResponse
    try {
      const response = await fetchFn(`${SLACK_API_BASE}/${endpoint}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: body.toString(),
      })
      raw = (await response.json()) as SlackHistoryResponse
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`[slack-bot] history fetch failed: ${message}`)
      return { ok: false, error: message }
    }

    if (!raw.ok) {
      return { ok: false, error: raw.error ?? 'unknown slack error' }
    }

    const botUserId = botUserIdRef()
    const rawMessages = raw.messages ?? []
    const mapped = rawMessages.map((m) => mapSlackMessage(m, botUserId))
    // Slack's `conversations.history` returns newest-first; `replies`
    // returns oldest-first. Normalize to oldest-first so the agent always
    // reads chronological order regardless of scope.
    if (args.thread === null) mapped.reverse()

    const nextCursor = raw.response_metadata?.next_cursor
    if (nextCursor !== undefined && nextCursor !== '') {
      return { ok: true, messages: mapped, nextCursor }
    }
    return { ok: true, messages: mapped }
  }
}

function mapSlackMessage(msg: SlackRawHistoryMessage, botUserId: string | null): ChannelHistoryMessage {
  const isBot =
    msg.subtype === 'bot_message' ||
    (msg.user !== undefined && botUserId !== null && msg.user === botUserId) ||
    (msg.bot_id !== undefined && (msg.user === undefined || msg.user === ''))
  // Slack's parent_user_id is set on thread replies and points at the
  // author of the parent message. When that parent author is our bot, we
  // expose this as `replyToBotMessageId = thread_ts` so the agent can
  // recognize threads it started — same convention as the inbound
  // classifier uses for live messages.
  const replyToBotMessageId =
    msg.thread_ts !== undefined &&
    msg.parent_user_id !== undefined &&
    botUserId !== null &&
    msg.parent_user_id === botUserId
      ? msg.thread_ts
      : null
  return {
    externalMessageId: msg.ts,
    authorId: msg.user ?? msg.bot_id ?? 'unknown',
    authorName: msg.user ?? msg.bot_id ?? 'unknown',
    text: msg.text ?? '',
    ts: slackTsToMillis(msg.ts),
    isBot,
    replyToBotMessageId,
  }
}

function clampLimit(requested: number, max: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return max
  return Math.min(Math.floor(requested), max)
}

// Slack channel ids are globally unique on Slack's side, so a `channel:C…`
// or `team:T/C` rule for any team admits this chat. We use this for the
// history allow check because at fetch time we only know the channel id,
// not the workspace (the tool resolves the chat from session origin and
// the workspace doesn't always round-trip through cursor pagination).
function isAllowedAnyTeam(rules: readonly string[], chat: string): boolean {
  for (const rule of rules) {
    if (rule === '*') return true
    if (rule === 'team:*' || rule === 'guild:*') return true
    if (rule.startsWith('channel:') && rule.slice(8) === chat) return true
    if (rule.startsWith('team:')) {
      const body = rule.slice(5)
      const slash = body.indexOf('/')
      if (slash !== -1 && body.slice(slash + 1) === chat) return true
    }
  }
  return false
}

// Slack supports text+file in a single API call via `initial_comment`, and
// honors `thread_ts` on every upload — both luxuries Discord lacks. So we
// fold `text` into the FIRST attachment's `initial_comment` rather than
// posting it separately, which preserves the "single message" appearance
// in the Slack UI (one notification, one anchored thread reply, one event
// in the bot's own channel history).
//
// Multi-attachment behavior: each attachment is uploaded sequentially. The
// first carries the comment; the rest are uploaded bare. Sequential not
// parallel because (a) order matters for users' visual scan and (b) Slack
// rate-limits aggressive parallel uploads on the bot's behalf.
//
// Failure semantics mirror the Discord adapter: any upload failure aborts
// and returns ok:false. The text-only fallback (no attachments) keeps the
// original `postMessage` path so message routing and rate limits behave
// exactly as before for the common case.
async function readAttachmentBuffer(path: string): Promise<Buffer> {
  const { readFile } = await import('node:fs/promises')
  return await readFile(path)
}

export function createOutboundCallback(deps: {
  client: Pick<SlackBotClient, 'postMessage' | 'uploadFile'>
  configRef: () => ChannelAdapterConfig
  logger: SlackBotAdapterLogger
  formatChannelTag: (workspace: string, chat: string) => Promise<string>
  readFile?: (path: string) => Promise<Buffer>
}): OutboundCallback {
  const { client, configRef, logger, formatChannelTag } = deps
  const readFile = deps.readFile ?? readAttachmentBuffer
  return async (msg: OutboundMessage): Promise<SendResult> => {
    if (msg.adapter !== 'slack-bot') {
      return { ok: false, error: `unknown adapter: ${msg.adapter}` }
    }
    const config = configRef()
    if (!isAllowed(config.allow, msg.workspace, msg.chat)) {
      logger.warn(`[slack-bot] outbound denied by allow rules: ${msg.workspace}/${msg.chat}`)
      return { ok: false, error: 'denied by allow rules' }
    }
    const text = msg.text ?? ''
    const attachments = msg.attachments ?? []
    if (text === '' && attachments.length === 0) {
      return { ok: false, error: 'message has neither text nor attachments' }
    }
    const tag = await formatChannelTag(msg.workspace, msg.chat)
    logger.info(
      `[slack-bot] outbound ${tag} text_len=${text.length} attachments=${attachments.length}${msg.thread ? ` thread=${msg.thread}` : ''}`,
    )

    if (attachments.length === 0) {
      try {
        const sent = await client.postMessage(
          msg.chat,
          text,
          msg.thread !== undefined && msg.thread !== null ? { thread_ts: msg.thread } : undefined,
        )
        logger.info(`[slack-bot] sent ts=${sent.ts} ${tag}`)
        return { ok: true }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`[slack-bot] postMessage failed: ${message}`)
        return { ok: false, error: message }
      }
    }

    const threadTs = msg.thread !== undefined && msg.thread !== null ? msg.thread : undefined
    for (const [index, attachment] of attachments.entries()) {
      const filename = attachment.filename ?? attachment.path.split('/').pop() ?? 'file'
      let buffer: Buffer
      try {
        buffer = await readFile(attachment.path)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`[slack-bot] readFile failed for ${attachment.path}: ${message}`)
        return { ok: false, error: `readFile failed: ${message}` }
      }
      const isFirst = index === 0
      const uploadOptions: { thread_ts?: string; initial_comment?: string } = {}
      if (threadTs !== undefined) uploadOptions.thread_ts = threadTs
      if (isFirst && text !== '') uploadOptions.initial_comment = text
      try {
        const file = await client.uploadFile(msg.chat, buffer, filename, uploadOptions)
        logger.info(`[slack-bot] uploaded id=${file.id} filename=${file.name} size=${file.size} ${tag}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error(`[slack-bot] uploadFile failed for ${attachment.path}: ${message}`)
        return { ok: false, error: `uploadFile failed: ${message}` }
      }
    }
    return { ok: true }
  }
}

export function createSlackBotAdapter(options: SlackBotAdapterOptions): SlackBotAdapter {
  const logger = options.logger ?? consoleLogger
  const client = new SlackBotClient()
  let listener: SlackBotListener | null = null
  let botUserId: string | null = null
  let teamId: string | null = null
  let started = false
  let inflightInbounds = 0
  let stopWaiters: Array<() => void> = []

  const authorResolver = createSlackAuthorResolver({ token: options.token })
  const channelResolver = createSlackChannelResolver({ token: options.token })

  const formatChannelTag = async (workspace: string, chat: string): Promise<string> => {
    const names = await channelResolver({ adapter: 'slack-bot', workspace, chat, thread: null }).catch(
      () => ({}) as ResolvedChannelNames,
    )
    const workspacePart = workspace === '@dm' ? 'dm' : `team=${formatLabel(names.workspaceName, workspace)}`
    const chatPart = `channel=${formatLabel(names.chatName, chat, '#')}`
    return `${workspacePart} ${chatPart}`
  }

  const typingCallback = createTypingCallback({ client, configRef: options.configRef, logger, formatChannelTag })

  const historyCallback = createSlackHistoryCallback({
    token: options.token,
    configRef: options.configRef,
    logger,
    botUserIdRef: () => botUserId,
  })

  const membershipResolver = createSlackMembershipResolver({
    token: options.token,
    logger,
    historyCallback,
  })

  const outboundCallback = createOutboundCallback({
    client,
    configRef: options.configRef,
    logger,
    formatChannelTag,
  })

  const dedupe = createSlackDedupe()

  const handleMessageEvent = async (
    event: SlackSocketMessageEvent,
    source: 'message' | 'app_mention',
  ): Promise<void> => {
    inflightInbounds++
    try {
      const text = event.text ?? ''
      const userId = event.user ?? 'unknown'
      const inboundWorkspace = event.channel_type === 'im' ? '@dm' : (teamId ?? 'unknown')
      const [resolvedUserName, inboundTag] = await Promise.all([
        event.user !== undefined && event.user !== '' ? authorResolver.resolve(event.user) : Promise.resolve(userId),
        formatChannelTag(inboundWorkspace, event.channel),
      ])
      logger.info(
        `[slack-bot] inbound source=${source} ts=${event.ts} user=${formatLabel(resolvedUserName, userId)} ${inboundTag} text_len=${text.length}`,
      )

      if (teamId === null) {
        logger.warn(`[slack-bot] dropped ts=${event.ts} reason=pre_connected (team_id unknown)`)
        return
      }

      const dedupeMatch = dedupe.check(event)
      if (dedupeMatch !== null) {
        logger.info(
          `[slack-bot] dropped ts=${event.ts} reason=duplicate_delivery (source=${source}, matched=${dedupeMatch})`,
        )
        return
      }

      const verdict = classifyInbound(event, options.configRef(), { teamId, botUserId })
      if (verdict.kind === 'drop') {
        logger.info(`[slack-bot] dropped ts=${event.ts} reason=${verdict.reason}${dropHint(verdict.reason)}`)
        return
      }

      dedupe.mark(event)
      const enriched = { ...verdict.payload, authorName: resolvedUserName }
      const routedTag = await formatChannelTag(enriched.workspace, enriched.chat)
      logger.info(
        `[slack-bot] routed ts=${event.ts} ${routedTag} mention=${enriched.isBotMention} reply=${enriched.replyToBotMessageId !== null}`,
      )
      await options.router.route(enriched)
    } catch (err) {
      logger.error(`[slack-bot] handleInbound failed: ${describe(err)}`)
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
        await client.login({ token: options.token })
      } catch (err) {
        started = false
        logger.error(`[slack-bot] login failed: ${describe(err)}`)
        throw err
      }

      // auth.test resolves the bot's identity and team. We need both: teamId
      // becomes the `workspace` field on every inbound, and botUserId is how
      // we recognize self-authored messages and mentions. Failure here is
      // fatal — without these we can't classify anything correctly.
      try {
        const auth = await client.testAuth()
        botUserId = auth.user_id
        teamId = auth.team_id
        logger.info(`[slack-bot] authenticated as ${auth.user ?? auth.user_id} in team ${auth.team ?? auth.team_id}`)
      } catch (err) {
        started = false
        logger.error(`[slack-bot] auth.test failed: ${describe(err)}`)
        throw err
      }

      listener = new SlackBotListener(client, { appToken: options.appToken })
      listener.on('connected', (info) => {
        logger.info(`[slack-bot] connected (app_id=${info.app_id ?? 'unknown'})`)
      })
      listener.on('disconnected', () => {
        logger.warn('[slack-bot] disconnected; SDK will reconnect with backoff')
      })
      listener.on('error', (err) => {
        logger.error(`[slack-bot] socket-mode error: ${describe(err)}`)
      })
      listener.on('message', ({ ack, event }) => {
        // Ack first so Slack stops retrying; failure to ack causes duplicate
        // deliveries within seconds. Then process asynchronously.
        ack()
        void handleMessageEvent(event, 'message')
      })
      // app_mention is required for mentions in channels where the bot is
      // NOT a member: in that case Slack does not fire a `message` event
      // (it requires `*:history` scope + membership), only `app_mention`
      // (which only requires `app_mentions:read`). The dedupe ring buffer
      // collapses the in-channel double-delivery when both events fire.
      listener.on('app_mention', ({ ack, event }) => {
        ack()
        void handleMessageEvent(promoteAppMentionToMessage(event), 'app_mention')
      })

      options.router.registerOutbound('slack-bot', outboundCallback)
      options.router.registerTyping('slack-bot', typingCallback)
      options.router.registerChannelNameResolver('slack-bot', channelResolver)
      options.router.registerHistory('slack-bot', historyCallback)
      options.router.registerMembership('slack-bot', membershipResolver)

      try {
        await listener.start()
      } catch (err) {
        started = false
        logger.error(`[slack-bot] listener start failed: ${describe(err)}`)
        throw err
      }
    },

    async stop(): Promise<void> {
      if (!started) return
      started = false
      options.router.unregisterOutbound('slack-bot', outboundCallback)
      options.router.unregisterTyping('slack-bot', typingCallback)
      options.router.unregisterChannelNameResolver('slack-bot', channelResolver)
      options.router.unregisterHistory('slack-bot', historyCallback)
      options.router.unregisterMembership('slack-bot', membershipResolver)
      if (inflightInbounds > 0) {
        await new Promise<void>((resolve) => {
          stopWaiters.push(resolve)
        })
      }
      listener?.stop()
      listener = null
      botUserId = null
      teamId = null
    },

    isConnected(): boolean {
      return botUserId !== null && teamId !== null
    },
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Operator hints appended to drop logs. Kept short — full guidance lives in
// docs. The not_in_allow_list hint is the highest-leverage one because that
// failure mode is invisible from Slack's side (bot stays online).
function dropHint(reason: InboundDropReason): string {
  switch (reason) {
    case 'not_in_allow_list':
      return ' (extend channels.slack-bot.allow in typeclaw.json to admit this team/channel)'
    case 'empty_text':
    case 'no_user':
    case 'self_author':
      return ''
  }
}
