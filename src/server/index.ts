import type { Server as BunServer, ServerWebSocket } from 'bun'

import {
  createSession as defaultCreateSession,
  type AgentSession,
  type CreateSessionOptions,
  type CreateSessionResult,
} from '@/agent'
import { createIdleDetector, type IdleDetector } from '@/memory'
import type { PluginManager } from '@/plugin'
import type { ReloadAllResult, ReloadRegistry } from '@/reload'
import type { SessionFactory } from '@/sessions'
import type { ClientMessage, PromptDelivery, QueueStateItem, ReloadResultPayload, ServerMessage } from '@/shared'
import type { Stream, StreamMessage, StreamMessageId, Unsubscribe } from '@/stream'

export type ReloadAllFn = () => Promise<ReloadAllResult>
export type CreateSessionFn = (options?: CreateSessionOptions) => Promise<CreateSessionResult>

export type ServerOptions = {
  port: number
  reloadAll?: ReloadAllFn
  reloadRegistry?: ReloadRegistry
  createSession?: CreateSessionFn
  sessionFactory?: SessionFactory
  stream?: Stream
  memoryIdleMs?: number
  agentDir?: string
  pluginManager?: PluginManager
}

export type Server = ReturnType<typeof createServer>

type WsData = { sessionId: string }
type Ws = ServerWebSocket<WsData>

type QueuedPrompt = {
  streamMessageId: StreamMessageId
  text: string
  delivery: PromptDelivery
  ts: number
}

type SessionState = {
  session: AgentSession
  sessionFileId: string
  sessionManager: { getSessionFile: () => string | undefined } | undefined
  drainQueue: QueuedPrompt[]
  draining: boolean
  unsubBroadcast: Unsubscribe | null
  unsubPrompts: Unsubscribe | null
  idleDetector: IdleDetector | null
  disposeSession: () => Promise<void>
}

function send(ws: Ws, msg: ServerMessage) {
  ws.send(JSON.stringify(msg))
}

export function createServer({
  port,
  reloadAll,
  reloadRegistry,
  createSession = defaultCreateSession,
  sessionFactory,
  stream,
  memoryIdleMs,
  agentDir,
  pluginManager,
}: ServerOptions) {
  const sessionStates = new WeakMap<Ws, SessionState>()

  function start(): BunServer<WsData> {
    const bunServer = Bun.serve<WsData>({
      port,
      fetch(req, server) {
        const sessionId = crypto.randomUUID()
        if (server.upgrade(req, { data: { sessionId } })) return
        return new Response('typeclaw agent', { status: 200 })
      },
      websocket: {
        async open(ws) {
          const sessionManager = sessionFactory?.createPersisted()
          const sessionFileId = sessionManager?.getSessionId() ?? ws.data.sessionId
          const { session, dispose } = await createSession({
            reloadRegistry,
            sessionManager,
            sessionId: sessionFileId,
            ...(stream ? { stream } : {}),
            ...(pluginManager ? { pluginManager } : {}),
          })

          const state: SessionState = {
            session,
            sessionFileId,
            sessionManager,
            drainQueue: [],
            draining: false,
            unsubBroadcast: null,
            unsubPrompts: null,
            idleDetector: null,
            disposeSession: dispose,
          }
          sessionStates.set(ws, state)

          if (stream && memoryIdleMs !== undefined && agentDir !== undefined) {
            const idleMs = memoryIdleMs
            state.idleDetector = createIdleDetector({
              idleMs,
              onIdle: () => {
                publishMemoryLoggerSpawn(state, stream, agentDir)
                if (pluginManager) {
                  const transcriptPath = state.sessionManager?.getSessionFile()
                  if (transcriptPath !== undefined) {
                    void pluginManager.dispatchEvent('session.idle', {
                      sessionId: state.sessionFileId,
                      parentTranscriptPath: transcriptPath,
                      idleMs,
                    })
                  }
                }
              },
            })
          }

          forwardSessionEvents(ws, session)

          if (stream) {
            state.unsubPrompts = stream.subscribe({ target: { kind: 'session', sessionId: sessionFileId } }, (msg) =>
              enqueuePrompt(ws, state, msg),
            )

            state.unsubBroadcast = stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
              const payload: ServerMessage = {
                type: 'notification',
                payload: msg.payload,
                ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}),
                ...(msg.meta !== undefined ? { meta: msg.meta } : {}),
              }
              send(ws, payload)
            })
          }

          send(ws, { type: 'connected', sessionId: sessionFileId })
          console.log(`session ${sessionFileId}: open`)
        },
        async message(ws, raw) {
          const msg = JSON.parse(String(raw)) as ClientMessage
          const state = sessionStates.get(ws)

          if (msg.type === 'reload') {
            await handleReload(ws, reloadAll)
            return
          }

          if (msg.type === 'abort') {
            if (!state) return
            await state.session.abort()
            return
          }

          if (msg.type === 'queue_cancel') {
            if (!state) return
            const before = state.drainQueue.length
            state.drainQueue = state.drainQueue.filter((q) => q.streamMessageId !== msg.messageId)
            if (state.drainQueue.length !== before) pushQueueState(ws, state)
            return
          }

          if (msg.type === 'prompt') {
            if (!state) return
            if (stream) {
              stream.publish({
                target: { kind: 'session', sessionId: state.sessionFileId },
                payload: { kind: 'prompt', text: msg.text, delivery: msg.delivery ?? 'queue' },
                meta: { source: 'tui' },
              })
              return
            }
            send(ws, { type: 'prompt_started', messageId: `local-${crypto.randomUUID()}`, text: msg.text })
            try {
              await state.session.prompt(msg.text)
              send(ws, { type: 'done' })
            } catch (err) {
              send(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) })
            }
            return
          }
        },
        async close(ws) {
          const state = sessionStates.get(ws)
          state?.unsubBroadcast?.()
          state?.unsubPrompts?.()
          state?.idleDetector?.dispose()
          sessionStates.delete(ws)
          if (state) {
            try {
              await state.disposeSession()
            } catch (err) {
              console.warn(
                `session ${state.sessionFileId}: disposeSession failed: ${err instanceof Error ? err.message : err}`,
              )
            }
          }
          console.log(`session ${ws.data.sessionId}: close`)
        },
      },
    })

    console.log(`typeclaw agent listening on ws://localhost:${bunServer.port}`)
    return bunServer
  }

  return { start }
}

function forwardSessionEvents(ws: Ws, session: AgentSession): void {
  const toolStartedAt = new Map<string, number>()

  session.subscribe((event) => {
    switch (event.type) {
      case 'message_update':
        if (event.assistantMessageEvent.type === 'text_delta') {
          send(ws, { type: 'text_delta', delta: event.assistantMessageEvent.delta })
        }
        break
      case 'tool_execution_start':
        toolStartedAt.set(event.toolCallId, Date.now())
        send(ws, {
          type: 'tool_start',
          toolCallId: event.toolCallId,
          name: event.toolName,
          args: event.args,
        })
        break
      case 'tool_execution_end': {
        const startedAt = toolStartedAt.get(event.toolCallId)
        toolStartedAt.delete(event.toolCallId)
        const durationMs = startedAt === undefined ? 0 : Date.now() - startedAt
        send(ws, {
          type: 'tool_end',
          toolCallId: event.toolCallId,
          name: event.toolName,
          error: event.isError,
          result: event.result,
          durationMs,
        })
        break
      }
    }
  })
}

function enqueuePrompt(ws: Ws, state: SessionState, msg: StreamMessage): void {
  const payload = msg.payload as { kind?: string; text?: string; delivery?: PromptDelivery }
  if (payload?.kind !== 'prompt' || typeof payload.text !== 'string') return
  const delivery: PromptDelivery = payload.delivery ?? 'queue'
  if (delivery === 'interrupt') {
    void state.session.abort().catch((err) => {
      send(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) })
    })
  }
  state.drainQueue.push({
    streamMessageId: msg.id,
    text: payload.text,
    delivery,
    ts: msg.ts,
  })
  pushQueueState(ws, state)
  void drain(ws, state)
}

async function drain(ws: Ws, state: SessionState): Promise<void> {
  if (state.draining) return
  state.draining = true
  try {
    while (state.drainQueue.length > 0) {
      const item = state.drainQueue.shift()
      if (!item) break
      pushQueueState(ws, state)
      send(ws, { type: 'prompt_started', messageId: item.streamMessageId, text: item.text })

      state.idleDetector?.cancel()
      try {
        await state.session.prompt(item.text)
        send(ws, { type: 'done' })
      } catch (err) {
        send(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
      state.idleDetector?.arm()
    }
  } finally {
    state.draining = false
  }
}

function publishMemoryLoggerSpawn(state: SessionState, stream: Stream, agentDir: string): void {
  const transcriptPath = state.sessionManager?.getSessionFile()
  if (transcriptPath === undefined) return
  stream.publish({
    target: { kind: 'new-session', subagent: 'memory-logger' },
    payload: {
      parentSessionId: state.sessionFileId,
      parentTranscriptPath: transcriptPath,
      agentDir,
    },
  })
}

function pushQueueState(ws: Ws, state: SessionState): void {
  const pending: QueueStateItem[] = state.drainQueue.map((q) => ({
    id: q.streamMessageId,
    text: q.text,
    ts: q.ts,
  }))
  send(ws, { type: 'queue_state', pending })
}

async function handleReload(ws: Ws, reloadAll: ReloadAllFn | undefined): Promise<void> {
  if (!reloadAll) {
    const empty: ReloadResultPayload[] = []
    send(ws, { type: 'reload_result', results: empty })
    return
  }
  try {
    const { results } = await reloadAll()
    send(ws, { type: 'reload_result', results })
  } catch (err) {
    send(ws, {
      type: 'reload_result',
      results: [{ scope: 'reload', ok: false, reason: err instanceof Error ? err.message : String(err) }],
    })
  }
}
