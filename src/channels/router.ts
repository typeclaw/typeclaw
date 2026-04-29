import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { AgentSession } from '@/agent'

export type AdapterId = 'discord-bot'

export type ChannelKey = {
  adapter: AdapterId
  bot: string
  workspace: string
  chat: string
  thread: string | null
}

export type InboundMessage = ChannelKey & {
  text: string
  externalMessageId: string
  authorId: string
}

export type OutboundReply = ChannelKey & {
  text: string
  turnId: string
}

export type OutboundCallback = (reply: OutboundReply) => void | Promise<void>

export type ChannelSessionMapping = ChannelKey & {
  sessionId: string
  createdAt: number
  lastInboundTs: number
}

type SessionsFile = {
  version: 1
  mappings: ChannelSessionMapping[]
}

type LiveSession = {
  session: AgentSession
  sessionId: string
  unsubscribe: () => void
  pendingAssistantText: string
  promptQueue: string[]
  draining: boolean
}

export type CreateSessionForChannelOptions = {
  existingSessionId?: string
}

export type CreateSessionForChannel = (
  key: ChannelKey,
  options?: CreateSessionForChannelOptions,
) => Promise<{ session: AgentSession; sessionId: string }>

export type ChannelRouterLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type CreateChannelRouterOptions = {
  agentDir: string
  createSessionForChannel: CreateSessionForChannel
  logger?: ChannelRouterLogger
}

export type ChannelRouter = {
  load: () => Promise<void>
  route: (event: InboundMessage) => Promise<void>
  bindOutbound: (adapter: AdapterId, callback: OutboundCallback) => () => void
  stop: () => Promise<void>
  knownMappings: () => ChannelSessionMapping[]
  liveSessionCount: () => number
}

const SESSIONS_FILE = 'channels/sessions.json'

const consoleLogger: ChannelRouterLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export function createChannelRouter({
  agentDir,
  createSessionForChannel,
  logger = consoleLogger,
}: CreateChannelRouterOptions): ChannelRouter {
  const mappings = new Map<string, ChannelSessionMapping>()
  const liveSessions = new Map<string, LiveSession>()
  // Concurrent route() calls for the same key share one creation promise so
  // createSessionForChannel runs at most once per key. Without this, two
  // inbounds racing on a cold channel each spawn a full AgentSession.
  const creating = new Map<string, Promise<LiveSession>>()
  const outboundCallbacks = new Map<AdapterId, Set<OutboundCallback>>()
  const path = join(agentDir, SESSIONS_FILE)
  // load() may be invoked concurrently from many route() calls. Cache the
  // first invocation's promise so all callers share it; this also pins
  // before/after relationships in the microtask queue so route() resumption
  // order tracks call order rather than load() arrival order.
  let loadPromise: Promise<void> | null = null

  function load(): Promise<void> {
    if (loadPromise) return loadPromise
    loadPromise = doLoad()
    return loadPromise
  }

  async function doLoad(): Promise<void> {
    if (!existsSync(path)) return
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (err) {
      logger.warn(`[channels] failed to read ${SESSIONS_FILE}: ${errMsg(err)}`)
      return
    }
    let parsed: SessionsFile
    try {
      parsed = JSON.parse(raw) as SessionsFile
    } catch (err) {
      logger.error(`[channels] ${SESSIONS_FILE} is not valid JSON: ${errMsg(err)}`)
      return
    }
    if (parsed.version !== 1 || !Array.isArray(parsed.mappings)) {
      logger.error(`[channels] ${SESSIONS_FILE} has unsupported version or shape; ignoring`)
      return
    }
    for (const m of parsed.mappings) {
      mappings.set(serializeKey(m), m)
    }
  }

  async function persist(): Promise<void> {
    const file: SessionsFile = { version: 1, mappings: [...mappings.values()] }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(file, null, 2), 'utf8')
  }

  async function ensureLive(event: InboundMessage): Promise<LiveSession> {
    const keyStr = serializeKey(event)
    const existingLive = liveSessions.get(keyStr)
    if (existingLive) return existingLive

    const inFlight = creating.get(keyStr)
    if (inFlight) return inFlight

    const promise = doCreate(event, keyStr).finally(() => {
      creating.delete(keyStr)
    })
    creating.set(keyStr, promise)
    return promise
  }

  async function doCreate(event: InboundMessage, keyStr: string): Promise<LiveSession> {
    const existingMapping = mappings.get(keyStr)
    const created = await createSessionForChannel(
      event,
      existingMapping !== undefined ? { existingSessionId: existingMapping.sessionId } : undefined,
    )
    const live: LiveSession = {
      session: created.session,
      sessionId: created.sessionId,
      pendingAssistantText: '',
      unsubscribe: () => {},
      promptQueue: [],
      draining: false,
    }
    live.unsubscribe = created.session.subscribe((sessionEvent) => {
      if (sessionEvent.type === 'message_update' && sessionEvent.assistantMessageEvent.type === 'text_delta') {
        live.pendingAssistantText += sessionEvent.assistantMessageEvent.delta
        return
      }
      if (sessionEvent.type === 'message_end' && sessionEvent.message.role === 'assistant') {
        const text = live.pendingAssistantText
        live.pendingAssistantText = ''
        if (text.length === 0) return
        const turnSuffix = sessionEvent.message.responseId ?? `t${sessionEvent.message.timestamp ?? Date.now()}`
        const reply: OutboundReply = {
          adapter: event.adapter,
          bot: event.bot,
          workspace: event.workspace,
          chat: event.chat,
          thread: event.thread,
          text,
          turnId: `${live.sessionId}:${turnSuffix}`,
        }
        void deliverOutbound(reply)
      }
    })

    if (existingMapping === undefined || existingMapping.sessionId !== created.sessionId) {
      mappings.set(keyStr, {
        adapter: event.adapter,
        bot: event.bot,
        workspace: event.workspace,
        chat: event.chat,
        thread: event.thread,
        sessionId: created.sessionId,
        createdAt: existingMapping?.createdAt ?? Date.now(),
        lastInboundTs: Date.now(),
      })
      // Best-effort persistence. A disk failure must not drop the user's
      // message — the session is functional in memory; the only cost is a
      // duplicate session on next process restart.
      try {
        await persist()
      } catch (err) {
        logger.error(`[channels] persist failed for ${keyStr}: ${errMsg(err)}`)
      }
    }

    // Expose the live session only after the mapping is durable (or has
    // best-effort failed). A second concurrent route() that finds this in
    // liveSessions can safely call session.prompt() — the mapping is on disk.
    liveSessions.set(keyStr, live)
    return live
  }

  async function deliverOutbound(reply: OutboundReply): Promise<void> {
    const callbacks = outboundCallbacks.get(reply.adapter)
    if (!callbacks || callbacks.size === 0) {
      logger.warn(`[channels] no outbound callback for adapter=${reply.adapter}; dropping reply`)
      return
    }
    // Snapshot to avoid surprising skip/add behavior if a callback mutates the
    // set while iterating.
    const snapshot = [...callbacks]
    for (const cb of snapshot) {
      try {
        await cb(reply)
      } catch (err) {
        logger.error(`[channels] outbound callback failed: ${errMsg(err)}`)
      }
    }
  }

  async function drainPromptQueue(live: LiveSession): Promise<void> {
    if (live.draining) return
    live.draining = true
    try {
      while (live.promptQueue.length > 0) {
        const text = live.promptQueue.shift()
        if (text === undefined) break
        try {
          await live.session.prompt(text)
        } catch (err) {
          logger.error(`[channels] session ${live.sessionId} prompt failed: ${errMsg(err)}`)
        }
      }
    } finally {
      live.draining = false
    }
  }

  return {
    load,
    async route(event) {
      await load()
      const live = await ensureLive(event)
      const keyStr = serializeKey(event)
      const mapping = mappings.get(keyStr)
      if (mapping !== undefined) {
        mapping.lastInboundTs = Date.now()
      }
      live.promptQueue.push(event.text)
      await drainPromptQueue(live)
    },
    bindOutbound(adapter, callback) {
      let set = outboundCallbacks.get(adapter)
      if (!set) {
        set = new Set()
        outboundCallbacks.set(adapter, set)
      }
      set.add(callback)
      return () => {
        set?.delete(callback)
      }
    },
    async stop() {
      for (const live of liveSessions.values()) {
        live.unsubscribe()
      }
      liveSessions.clear()
    },
    knownMappings() {
      return [...mappings.values()]
    },
    liveSessionCount() {
      return liveSessions.size
    },
  }
}

function serializeKey(key: ChannelKey): string {
  return `${key.adapter}|${key.bot}|${key.workspace}|${key.chat}|${key.thread ?? ''}`
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
