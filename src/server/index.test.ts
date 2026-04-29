import { afterEach, describe, expect, test } from 'bun:test'

import { SessionManager } from '@mariozechner/pi-coding-agent'

import type { AgentSession, CreateSessionOptions } from '@/agent'
import type { SessionFactory } from '@/sessions'
import type { ServerMessage } from '@/shared'
import { createStream } from '@/stream'

import { createServer } from './index'

type SessionEvent =
  | { type: 'message_update'; assistantMessageEvent: { type: 'text_delta'; delta: string } }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }

let server: ReturnType<ReturnType<typeof createServer>['start']> | null = null

afterEach(() => {
  server?.stop(true)
  server = null
})

function createFakeSession(): AgentSession & {
  emit: (event: SessionEvent) => void
  abortCalls: number
  promptCalls: string[]
  resolvePrompt: () => void
} {
  const subscribers = new Set<(event: SessionEvent) => void>()
  let pendingPromptResolve: (() => void) | null = null
  const fake = {
    subscribe: (fn: (event: SessionEvent) => void) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    prompt: async (text: string) => {
      fake.promptCalls.push(text)
      await new Promise<void>((resolve) => {
        pendingPromptResolve = resolve
      })
    },
    abort: async () => {
      fake.abortCalls++
      pendingPromptResolve?.()
      pendingPromptResolve = null
    },
    emit: (event: SessionEvent) => {
      for (const fn of subscribers) fn(event)
    },
    resolvePrompt: () => {
      pendingPromptResolve?.()
      pendingPromptResolve = null
    },
    abortCalls: 0,
    promptCalls: [] as string[],
  }
  return fake as unknown as ReturnType<typeof createFakeSession>
}

async function startWithSession(
  session: AgentSession,
  extra: {
    stream?: ReturnType<typeof createStream>
    sessionFactory?: SessionFactory
    memoryIdleMs?: number
    agentDir?: string
    pluginManager?: import('@/plugin').PluginManager
  } = {},
): Promise<{ url: string }> {
  const built = createServer({
    port: 0,
    createSession: async () => ({ session, dispose: async () => {} }),
    ...(extra.stream ? { stream: extra.stream } : {}),
    ...(extra.sessionFactory ? { sessionFactory: extra.sessionFactory } : {}),
    ...(extra.memoryIdleMs !== undefined ? { memoryIdleMs: extra.memoryIdleMs } : {}),
    ...(extra.agentDir !== undefined ? { agentDir: extra.agentDir } : {}),
    ...(extra.pluginManager !== undefined ? { pluginManager: extra.pluginManager } : {}),
  }).start()
  server = built
  return { url: `ws://localhost:${built.port}` }
}

async function connect(url: string): Promise<{
  ws: WebSocket
  received: ServerMessage[]
  waitFor: (predicate: (msg: ServerMessage) => boolean, timeoutMs?: number) => Promise<ServerMessage>
}> {
  const ws = new WebSocket(url)
  const received: ServerMessage[] = []
  ws.addEventListener('message', (e) => {
    received.push(JSON.parse(String(e.data)) as ServerMessage)
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', (err) => reject(err), { once: true })
  })
  const waitFor = async (predicate: (msg: ServerMessage) => boolean, timeoutMs = 1000): Promise<ServerMessage> => {
    const existing = received.find(predicate)
    if (existing) return existing
    return await new Promise<ServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs)
      const onMessage = (e: MessageEvent) => {
        const msg = JSON.parse(String(e.data)) as ServerMessage
        if (predicate(msg)) {
          clearTimeout(timer)
          ws.removeEventListener('message', onMessage)
          resolve(msg)
        }
      }
      ws.addEventListener('message', onMessage)
    })
  }
  return { ws, received, waitFor }
}

describe('createServer tool event forwarding', () => {
  test('forwards toolCallId, name, and args from tool_execution_start', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({ type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'Read', args: { path: '/x' } })

    const msg = await waitFor((m) => m.type === 'tool_start')
    expect(msg).toEqual({ type: 'tool_start', toolCallId: 'tc-1', name: 'Read', args: { path: '/x' } })
    ws.close()
  })

  test('forwards toolCallId, name, error, result, and a non-negative durationMs from tool_execution_end', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({ type: 'tool_execution_start', toolCallId: 'tc-2', toolName: 'Bash', args: 'ls' })
    await waitFor((m) => m.type === 'tool_start')
    session.emit({ type: 'tool_execution_end', toolCallId: 'tc-2', toolName: 'Bash', result: 'a\nb', isError: false })

    const msg = await waitFor((m) => m.type === 'tool_end')
    expect(msg.type).toBe('tool_end')
    if (msg.type !== 'tool_end') throw new Error('unreachable')
    expect(msg.toolCallId).toBe('tc-2')
    expect(msg.name).toBe('Bash')
    expect(msg.error).toBe(false)
    expect(msg.result).toBe('a\nb')
    expect(msg.durationMs).toBeGreaterThanOrEqual(0)
    ws.close()
  })

  test('uses durationMs=0 when tool_execution_end arrives without a matching start', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    session.emit({ type: 'tool_execution_end', toolCallId: 'orphan', toolName: 'X', result: null, isError: true })

    const msg = await waitFor((m) => m.type === 'tool_end')
    if (msg.type !== 'tool_end') throw new Error('unreachable')
    expect(msg.durationMs).toBe(0)
    expect(msg.error).toBe(true)
    ws.close()
  })
})

describe('createServer abort handling (no stream — fallback path)', () => {
  test('client { type: "abort" } invokes session.abort()', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'prompt', text: 'do thing' }))
    await new Promise((r) => setTimeout(r, 10))
    expect(session.promptCalls).toEqual(['do thing'])
    expect(session.abortCalls).toBe(0)

    ws.send(JSON.stringify({ type: 'abort' }))
    await waitFor((m) => m.type === 'done')
    expect(session.abortCalls).toBe(1)
    ws.close()
  })

  test('abort with no in-flight prompt is still a safe no-op', async () => {
    const session = createFakeSession()
    const { url } = await startWithSession(session)
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'abort' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(session.abortCalls).toBe(1)
    ws.close()
  })
})

describe('createServer session persistence wiring', () => {
  function makeStubFactory() {
    const created: SessionManager[] = []
    const factory: SessionFactory = {
      createPersisted: () => {
        const mgr = SessionManager.inMemory()
        created.push(mgr)
        return mgr
      },
      sessionDir: () => '/stub/sessions',
    }
    return { factory, created }
  }

  test('invokes sessionFactory.createPersisted() once per ws open and forwards the manager into createSession', async () => {
    // given
    const session = createFakeSession()
    const { factory, created } = makeStubFactory()
    const observed: CreateSessionOptions[] = []
    const built = createServer({
      port: 0,
      sessionFactory: factory,
      createSession: async (options = {}) => {
        observed.push(options)
        return { session, dispose: async () => {} }
      },
    }).start()
    server = built

    // when
    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((m) => m.type === 'connected')

    // then
    expect(created).toHaveLength(1)
    expect(observed).toHaveLength(1)
    expect(observed[0]?.sessionManager).toBe(created[0])

    ws.close()
  })

  test('produces a fresh sessionManager for each ws connection', async () => {
    // given
    const session = createFakeSession()
    const { factory, created } = makeStubFactory()
    const built = createServer({
      port: 0,
      sessionFactory: factory,
      createSession: async () => ({ session, dispose: async () => {} }),
    }).start()
    server = built
    const url = `ws://localhost:${built.port}`

    // when
    const a = await connect(url)
    await a.waitFor((m) => m.type === 'connected')
    const b = await connect(url)
    await b.waitFor((m) => m.type === 'connected')

    // then
    expect(created).toHaveLength(2)
    expect(created[0]).not.toBe(created[1])

    a.ws.close()
    b.ws.close()
  })

  test('omits sessionManager from createSession options when no factory is configured (preserves in-memory default)', async () => {
    // given
    const session = createFakeSession()
    const observed: CreateSessionOptions[] = []
    const built = createServer({
      port: 0,
      createSession: async (options = {}) => {
        observed.push(options)
        return { session, dispose: async () => {} }
      },
    }).start()
    server = built

    // when
    const { ws, waitFor } = await connect(`ws://localhost:${built.port}`)
    await waitFor((m) => m.type === 'connected')

    // then
    expect(observed).toHaveLength(1)
    expect(observed[0]?.sessionManager).toBeUndefined()

    ws.close()
  })

  test('connected message carries the persisted session file id when a factory is configured', async () => {
    // given
    const session = createFakeSession()
    const { factory } = makeStubFactory()
    const { url } = await startWithSession(session, { sessionFactory: factory })

    // when
    const { ws, waitFor } = await connect(url)
    const connected = await waitFor((m) => m.type === 'connected')

    // then
    if (connected.type !== 'connected') throw new Error('unreachable')
    expect(connected.sessionId).toBeDefined()
    expect(connected.sessionId.length).toBeGreaterThan(0)

    ws.close()
  })
})

describe('createServer with stream — input queueing bugfix', () => {
  test('a single prompt is published to the stream, drained, and yields a done message', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when
    ws.send(JSON.stringify({ type: 'prompt', text: 'hello' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(session.promptCalls).toEqual(['hello'])

    session.resolvePrompt()
    await waitFor((m) => m.type === 'done')

    // then
    expect(session.promptCalls).toEqual(['hello'])

    ws.close()
  })

  test('emits prompt_started before invoking session.prompt() so the TUI can render execution-order history', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when
    ws.send(JSON.stringify({ type: 'prompt', text: 'hi' }))
    const started = await waitFor((m) => m.type === 'prompt_started')

    // then: prompt_started arrived; session.prompt was called with the same text
    if (started.type !== 'prompt_started') throw new Error('unreachable')
    expect(started.text).toBe('hi')
    expect(started.messageId).toBeDefined()
    expect(session.promptCalls).toEqual(['hi'])

    session.resolvePrompt()
    ws.close()
  })

  test('two concurrent prompts are serialized via the drain loop (no concurrent session.prompt calls)', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when: fire two prompts back-to-back while the first is still in flight
    ws.send(JSON.stringify({ type: 'prompt', text: 'first' }))
    ws.send(JSON.stringify({ type: 'prompt', text: 'second' }))
    await new Promise((r) => setTimeout(r, 30))

    // then: only the first reached session.prompt — the second is queued
    expect(session.promptCalls).toEqual(['first'])

    // when: first completes
    session.resolvePrompt()
    await new Promise((r) => setTimeout(r, 30))

    // then: second now reaches session.prompt
    expect(session.promptCalls).toEqual(['first', 'second'])

    session.resolvePrompt()
    ws.close()
  })

  test('queue_state is pushed to the client when prompts are queued and drained', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor, received } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when: send two prompts; only the first should be in flight, the second should be visible in queue_state
    ws.send(JSON.stringify({ type: 'prompt', text: 'first' }))
    ws.send(JSON.stringify({ type: 'prompt', text: 'second' }))
    await new Promise((r) => setTimeout(r, 30))

    const queueStates = received.filter(
      (m): m is Extract<ServerMessage, { type: 'queue_state' }> => m.type === 'queue_state',
    )
    expect(queueStates.length).toBeGreaterThan(0)
    const last = queueStates[queueStates.length - 1]!
    expect(last.pending.map((p) => p.text)).toEqual(['second'])

    session.resolvePrompt()
    await new Promise((r) => setTimeout(r, 20))
    session.resolvePrompt()
    ws.close()
  })

  test('queue_cancel removes a queued prompt before it drains', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor, received } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.send(JSON.stringify({ type: 'prompt', text: 'first' }))
    ws.send(JSON.stringify({ type: 'prompt', text: 'second' }))
    await new Promise((r) => setTimeout(r, 30))

    const queueStateBefore = received
      .filter((m): m is Extract<ServerMessage, { type: 'queue_state' }> => m.type === 'queue_state')
      .at(-1)
    expect(queueStateBefore?.pending.map((p) => p.text)).toEqual(['second'])
    const queuedId = queueStateBefore!.pending[0]!.id

    // when: cancel the queued one
    ws.send(JSON.stringify({ type: 'queue_cancel', messageId: queuedId }))
    await new Promise((r) => setTimeout(r, 20))

    // then: queue is empty
    const queueStateAfter = received
      .filter((m): m is Extract<ServerMessage, { type: 'queue_state' }> => m.type === 'queue_state')
      .at(-1)
    expect(queueStateAfter?.pending).toEqual([])

    // and: when first completes, second is NOT processed
    session.resolvePrompt()
    await new Promise((r) => setTimeout(r, 30))
    expect(session.promptCalls).toEqual(['first'])

    ws.close()
  })

  test('broadcast stream messages are forwarded to the client as notification', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when
    stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'mood', value: 'happy' } })

    // then
    const msg = await waitFor((m) => m.type === 'notification')
    if (msg.type !== 'notification') throw new Error('unreachable')
    expect(msg.payload).toEqual({ kind: 'mood', value: 'happy' })

    ws.close()
  })

  test('stream messages targeted at a different sessionId are not delivered to this session', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when: publish to a different session id
    stream.publish({
      target: { kind: 'session', sessionId: 'someone-else' },
      payload: { kind: 'prompt', text: 'not for us' },
    })
    await new Promise((r) => setTimeout(r, 20))

    // then: nothing reaches this session.prompt
    expect(session.promptCalls).toEqual([])

    ws.close()
  })

  test('an interrupt-delivery prompt aborts the in-flight prompt before sending the new one', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when: first prompt starts
    ws.send(JSON.stringify({ type: 'prompt', text: 'first' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(session.promptCalls).toEqual(['first'])
    expect(session.abortCalls).toBe(0)

    // when: interrupt-delivery prompt arrives
    ws.send(JSON.stringify({ type: 'prompt', text: 'urgent', delivery: 'interrupt' }))
    await new Promise((r) => setTimeout(r, 30))

    // then: abort was called, then second prompt was sent
    expect(session.abortCalls).toBeGreaterThanOrEqual(1)
    expect(session.promptCalls.includes('urgent')).toBe(true)

    session.resolvePrompt()
    ws.close()
  })

  test('close() unsubscribes from the stream so further publishes do not error', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const { url } = await startWithSession(session, { stream })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    ws.close()
    await new Promise((r) => setTimeout(r, 20))

    // when: publish a broadcast after close
    stream.publish({ target: { kind: 'broadcast' }, payload: { kind: 'noise' } })

    // then: no crash; the test passes if we get here
    expect(true).toBe(true)
  })
})

describe('createServer memory idle detector', () => {
  function stubSessionFactory(opts: { transcriptPath?: string }): SessionFactory {
    return {
      sessionDir: () => '/tmp/test-sessions',
      createPersisted: () =>
        ({
          getSessionId: () => 'ses_fake',
          getSessionFile: () => opts.transcriptPath,
        }) as unknown as SessionManager,
    }
  }

  test('publishes a new-session memory-logger message after idle window when transcript exists', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const newSessionMessages: Array<{ subagent?: string; payload: unknown }> = []
    stream.subscribe({ target: { kind: 'new-session' } }, (msg) => {
      const target = msg.target as { kind: 'new-session'; subagent?: string }
      newSessionMessages.push({ subagent: target.subagent, payload: msg.payload })
    })

    const { url } = await startWithSession(session, {
      stream,
      sessionFactory: stubSessionFactory({ transcriptPath: '/tmp/test-sessions/ses_fake.jsonl' }),
      memoryIdleMs: 30,
      agentDir: '/tmp/agent-dir',
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when: send a prompt and let it complete
    stream.publish({
      target: { kind: 'session', sessionId: 'ses_fake' },
      payload: { kind: 'prompt', text: 'hi', delivery: 'queue' },
    })
    await new Promise((r) => setTimeout(r, 10))
    session.resolvePrompt()
    await waitFor((m) => m.type === 'done')

    // then: after the idle window, the memory-logger publish fires
    await new Promise((r) => setTimeout(r, 60))

    expect(newSessionMessages).toHaveLength(1)
    expect(newSessionMessages[0]?.subagent).toBe('memory-logger')
    expect(newSessionMessages[0]?.payload).toEqual({
      parentSessionId: 'ses_fake',
      parentTranscriptPath: '/tmp/test-sessions/ses_fake.jsonl',
      agentDir: '/tmp/agent-dir',
    })
    ws.close()
  })

  test('skips publishing when the session has no persisted transcript yet', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const newSessionMessages: unknown[] = []
    stream.subscribe({ target: { kind: 'new-session' } }, (msg) => newSessionMessages.push(msg))

    const { url } = await startWithSession(session, {
      stream,
      sessionFactory: stubSessionFactory({ transcriptPath: undefined }),
      memoryIdleMs: 30,
      agentDir: '/tmp/agent-dir',
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // when: prompt completes but no transcript is persisted
    stream.publish({
      target: { kind: 'session', sessionId: 'ses_fake' },
      payload: { kind: 'prompt', text: 'hi', delivery: 'queue' },
    })
    await new Promise((r) => setTimeout(r, 10))
    session.resolvePrompt()
    await waitFor((m) => m.type === 'done')

    // then: idle fires but publish is suppressed
    await new Promise((r) => setTimeout(r, 60))

    expect(newSessionMessages).toHaveLength(0)
    ws.close()
  })

  test('dispatches session.idle to plugin handlers after the idle window', async () => {
    const { definePlugin, PluginManager } = await import('@/plugin')

    const pm = new PluginManager({ agentDir: '/tmp/agent-dir' })
    const captured: Array<{ sessionId: string; parentTranscriptPath: string; idleMs: number }> = []
    await pm.loadOne(
      definePlugin({ name: 'p' }, (ctx) =>
        ctx.on('session.idle', (event) => {
          captured.push({
            sessionId: event.sessionId,
            parentTranscriptPath: event.parentTranscriptPath,
            idleMs: event.idleMs,
          })
        }),
      ),
    )
    pm.markBooted()

    const session = createFakeSession()
    const stream = createStream()

    const { url } = await startWithSession(session, {
      stream,
      sessionFactory: stubSessionFactory({ transcriptPath: '/tmp/test-sessions/ses_fake.jsonl' }),
      memoryIdleMs: 30,
      agentDir: '/tmp/agent-dir',
      pluginManager: pm,
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    stream.publish({
      target: { kind: 'session', sessionId: 'ses_fake' },
      payload: { kind: 'prompt', text: 'hi', delivery: 'queue' },
    })
    await new Promise((r) => setTimeout(r, 10))
    session.resolvePrompt()
    await waitFor((m) => m.type === 'done')

    await new Promise((r) => setTimeout(r, 60))

    expect(captured).toEqual([
      {
        sessionId: 'ses_fake',
        parentTranscriptPath: '/tmp/test-sessions/ses_fake.jsonl',
        idleMs: 30,
      },
    ])
    ws.close()
  })

  test('does not install an idle detector when memoryIdleMs is omitted', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const newSessionMessages: unknown[] = []
    stream.subscribe({ target: { kind: 'new-session' } }, (msg) => newSessionMessages.push(msg))

    const { url } = await startWithSession(session, {
      stream,
      sessionFactory: stubSessionFactory({ transcriptPath: '/tmp/x.jsonl' }),
      // memoryIdleMs intentionally omitted
      agentDir: '/tmp/agent-dir',
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    stream.publish({
      target: { kind: 'session', sessionId: 'ses_fake' },
      payload: { kind: 'prompt', text: 'hi', delivery: 'queue' },
    })
    await new Promise((r) => setTimeout(r, 10))
    session.resolvePrompt()
    await waitFor((m) => m.type === 'done')

    await new Promise((r) => setTimeout(r, 60))

    expect(newSessionMessages).toHaveLength(0)
    ws.close()
  })

  test('a new prompt arriving during the idle window cancels the pending publish', async () => {
    // given
    const session = createFakeSession()
    const stream = createStream()
    const newSessionMessages: unknown[] = []
    stream.subscribe({ target: { kind: 'new-session' } }, (msg) => newSessionMessages.push(msg))

    const { url } = await startWithSession(session, {
      stream,
      sessionFactory: stubSessionFactory({ transcriptPath: '/tmp/x.jsonl' }),
      memoryIdleMs: 50,
      agentDir: '/tmp/agent-dir',
    })
    const { ws, waitFor } = await connect(url)
    await waitFor((m) => m.type === 'connected')

    // first prompt completes
    stream.publish({
      target: { kind: 'session', sessionId: 'ses_fake' },
      payload: { kind: 'prompt', text: 'first', delivery: 'queue' },
    })
    await new Promise((r) => setTimeout(r, 10))
    session.resolvePrompt()
    await waitFor((m) => m.type === 'done')

    // second prompt arrives within the idle window (20ms < 50ms)
    await new Promise((r) => setTimeout(r, 20))
    expect(newSessionMessages).toHaveLength(0)
    stream.publish({
      target: { kind: 'session', sessionId: 'ses_fake' },
      payload: { kind: 'prompt', text: 'second', delivery: 'queue' },
    })
    await new Promise((r) => setTimeout(r, 10))
    session.resolvePrompt()
    await new Promise((r) => setTimeout(r, 5))

    // the original 50ms idle window from the first prompt would now have elapsed.
    // if cancel() worked, no publish has fired yet.
    await new Promise((r) => setTimeout(r, 30))
    expect(newSessionMessages).toHaveLength(0)

    // after the second idle window also elapses, exactly one publish has fired
    await new Promise((r) => setTimeout(r, 50))
    expect(newSessionMessages).toHaveLength(1)
    ws.close()
  })
})
