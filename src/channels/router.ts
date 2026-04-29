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
}

export type CreateSessionForChannel = (key: ChannelKey) => Promise<{ session: AgentSession; sessionId: string }>

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
  const outboundCallbacks = new Map<AdapterId, Set<OutboundCallback>>()
  const path = join(agentDir, SESSIONS_FILE)
  let loaded = false

  async function load(): Promise<void> {
    if (loaded) return
    loaded = true
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

    const created = await createSessionForChannel(event)
    const live: LiveSession = {
      session: created.session,
      sessionId: created.sessionId,
      pendingAssistantText: '',
      unsubscribe: () => {},
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

    liveSessions.set(keyStr, live)

    const existingMapping = mappings.get(keyStr)
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
      await persist()
    }
    return live
  }

  async function deliverOutbound(reply: OutboundReply): Promise<void> {
    const callbacks = outboundCallbacks.get(reply.adapter)
    if (!callbacks || callbacks.size === 0) {
      logger.warn(`[channels] no outbound callback for adapter=${reply.adapter}; dropping reply`)
      return
    }
    for (const cb of callbacks) {
      try {
        await cb(reply)
      } catch (err) {
        logger.error(`[channels] outbound callback failed: ${errMsg(err)}`)
      }
    }
  }

  return {
    load,
    async route(event) {
      if (!loaded) await load()
      const live = await ensureLive(event)
      const keyStr = serializeKey(event)
      const mapping = mappings.get(keyStr)
      if (mapping !== undefined) {
        mapping.lastInboundTs = Date.now()
      }
      try {
        await live.session.prompt(event.text)
      } catch (err) {
        logger.error(`[channels] session ${live.sessionId} prompt failed: ${errMsg(err)}`)
      }
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
