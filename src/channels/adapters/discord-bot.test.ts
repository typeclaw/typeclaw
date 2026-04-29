import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DiscordGatewayMessageCreateEvent } from 'agent-messenger/discordbot'

import { createChannelRouter, type CreateSessionForChannel } from '../router'
import { createDiscordBotAdapter } from './discord-bot'

type Listener = (...args: any[]) => void

function createFakeListener() {
  const handlers = new Map<string, Listener[]>()
  const startedRef = { value: false }
  return {
    listener: {
      on(event: string, handler: Listener) {
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
        return this
      },
      async start() {
        startedRef.value = true
      },
      stop() {
        startedRef.value = false
      },
    },
    emit(event: string, ...args: any[]) {
      for (const h of handlers.get(event) ?? []) h(...args)
    },
    started: startedRef,
  }
}

function createFakeClient() {
  const sends: { channel: string; content: string; thread?: string }[] = []
  return {
    client: {
      async sendMessage(channelId: string, content: string, options?: { thread_id?: string }) {
        sends.push({ channel: channelId, content, ...(options?.thread_id ? { thread: options.thread_id } : {}) })
        return { id: 'm', channel_id: channelId, content } as any
      },
    },
    sends,
  }
}

function createFakeSession() {
  const listeners: ((event: any) => void)[] = []
  const promptCalls: string[] = []
  return {
    session: {
      subscribe(l: (e: any) => void) {
        listeners.push(l)
        return () => {
          const i = listeners.indexOf(l)
          if (i >= 0) listeners.splice(i, 1)
        }
      },
      async prompt(text: string) {
        promptCalls.push(text)
      },
      async abort() {},
    } as any,
    listeners,
    promptCalls,
  }
}

function makeMessageEvent(over: Partial<DiscordGatewayMessageCreateEvent> = {}): DiscordGatewayMessageCreateEvent {
  return {
    type: 'MESSAGE_CREATE',
    id: 'msg-1',
    channel_id: 'C1',
    guild_id: 'W1',
    author: { id: 'u1', username: 'alice' },
    content: 'hello',
    timestamp: '2026-04-29T00:00:00Z',
    ...over,
  } as DiscordGatewayMessageCreateEvent
}

async function makeRouter(createSession?: CreateSessionForChannel) {
  const dir = await mkdtemp(join(tmpdir(), 'channels-adapter-'))
  const fakes = createFakeSession()
  const router = createChannelRouter({
    agentDir: dir,
    createSessionForChannel: createSession ?? (async () => ({ session: fakes.session, sessionId: 'sess-1' })),
  })
  return { router, fakes, dir }
}

describe('DiscordBotAdapter', () => {
  test('start() wires listener events and binds outbound; stop() unbinds and stops the listener', async () => {
    const { router } = await makeRouter()
    const listenerFakes = createFakeListener()
    const clientFakes = createFakeClient()
    const adapter = createDiscordBotAdapter({
      bot: 'main',
      chats: ['*'],
      router,
      client: clientFakes.client,
      listener: listenerFakes.listener,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await adapter.start()
    expect(listenerFakes.started.value).toBe(true)

    await adapter.stop()
    expect(listenerFakes.started.value).toBe(false)
  })

  test('inbound: matching message routes through and prompts the session', async () => {
    const { router, fakes } = await makeRouter()
    const adapter = createDiscordBotAdapter({
      bot: 'main',
      chats: ['*'],
      router,
      client: createFakeClient().client,
      listener: createFakeListener().listener,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await adapter.handleInbound(makeMessageEvent({ content: 'hi from user' }))

    expect(fakes.promptCalls).toEqual(['hi from user'])
    expect(router.knownMappings()).toHaveLength(1)
    expect(router.knownMappings()[0]).toMatchObject({
      adapter: 'discord-bot',
      bot: 'main',
      workspace: 'W1',
      chat: 'C1',
      thread: null,
    })
  })

  test('inbound: bot-authored messages are dropped (no echo loop)', async () => {
    const { router, fakes } = await makeRouter()
    const adapter = createDiscordBotAdapter({
      bot: 'main',
      chats: ['*'],
      router,
      client: createFakeClient().client,
      listener: createFakeListener().listener,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await adapter.handleInbound(
      makeMessageEvent({ author: { id: 'bot', username: 'self', bot: true }, content: 'echo' }),
    )

    expect(fakes.promptCalls).toEqual([])
    expect(router.knownMappings()).toHaveLength(0)
  })

  test('inbound: empty-content messages are dropped (privileged-intent fallback)', async () => {
    const { router, fakes } = await makeRouter()
    const adapter = createDiscordBotAdapter({
      bot: 'main',
      chats: ['*'],
      router,
      client: createFakeClient().client,
      listener: createFakeListener().listener,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await adapter.handleInbound(makeMessageEvent({ content: '' }))

    expect(fakes.promptCalls).toEqual([])
  })

  test('inbound: missing guild_id maps to the @dm sentinel', async () => {
    const { router, fakes } = await makeRouter()
    const adapter = createDiscordBotAdapter({
      bot: 'main',
      chats: ['*'],
      router,
      client: createFakeClient().client,
      listener: createFakeListener().listener,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await adapter.handleInbound(makeMessageEvent({ guild_id: undefined, content: 'dm hi' }))

    expect(fakes.promptCalls).toEqual(['dm hi'])
    expect(router.knownMappings()[0]?.workspace).toBe('@dm')
  })

  test('inbound: chats allowlist with bare chat id admits any workspace', async () => {
    const { router, fakes } = await makeRouter()
    const adapter = createDiscordBotAdapter({
      bot: 'main',
      chats: ['C1'],
      router,
      client: createFakeClient().client,
      listener: createFakeListener().listener,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await adapter.handleInbound(makeMessageEvent({ guild_id: 'W1', channel_id: 'C1' }))
    await adapter.handleInbound(makeMessageEvent({ guild_id: 'W2', channel_id: 'C1' }))
    await adapter.handleInbound(makeMessageEvent({ guild_id: 'W1', channel_id: 'OTHER' }))

    expect(fakes.promptCalls).toHaveLength(2)
  })

  test('inbound: workspace-qualified rule restricts to (workspace, chat)', async () => {
    const { router, fakes } = await makeRouter()
    const adapter = createDiscordBotAdapter({
      bot: 'main',
      chats: ['W1/C1'],
      router,
      client: createFakeClient().client,
      listener: createFakeListener().listener,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await adapter.handleInbound(makeMessageEvent({ guild_id: 'W1', channel_id: 'C1' }))
    await adapter.handleInbound(makeMessageEvent({ guild_id: 'W2', channel_id: 'C1' }))

    expect(fakes.promptCalls).toHaveLength(1)
  })

  test('outbound: callback for the same bot sends via client', async () => {
    const { router } = await makeRouter()
    const clientFakes = createFakeClient()
    const adapter = createDiscordBotAdapter({
      bot: 'main',
      chats: ['*'],
      router,
      client: clientFakes.client,
      listener: createFakeListener().listener,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await adapter.outboundCallback({
      adapter: 'discord-bot',
      bot: 'main',
      workspace: 'W1',
      chat: 'C1',
      thread: null,
      text: 'hello back',
      turnId: 't1',
    })

    expect(clientFakes.sends).toEqual([{ channel: 'C1', content: 'hello back' }])
  })

  test('outbound: callback drops replies whose (workspace, chat) is not in the chats allowlist', async () => {
    const { router } = await makeRouter()
    const clientFakes = createFakeClient()
    const adapter = createDiscordBotAdapter({
      bot: 'main',
      chats: ['W1/C1'],
      router,
      client: clientFakes.client,
      listener: createFakeListener().listener,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await adapter.outboundCallback({
      adapter: 'discord-bot',
      bot: 'main',
      workspace: 'W1',
      chat: 'C1',
      thread: null,
      text: 'allowed',
      turnId: 't1',
    })

    await adapter.outboundCallback({
      adapter: 'discord-bot',
      bot: 'main',
      workspace: 'W2',
      chat: 'C1',
      thread: null,
      text: 'denied',
      turnId: 't2',
    })

    expect(clientFakes.sends).toEqual([{ channel: 'C1', content: 'allowed' }])
  })

  test('outbound: callback for a different bot is ignored (multi-bot deployments)', async () => {
    const { router } = await makeRouter()
    const clientFakes = createFakeClient()
    const adapter = createDiscordBotAdapter({
      bot: 'main',
      chats: ['*'],
      router,
      client: clientFakes.client,
      listener: createFakeListener().listener,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await adapter.outboundCallback({
      adapter: 'discord-bot',
      bot: 'alert',
      workspace: 'W1',
      chat: 'C1',
      thread: null,
      text: 'wrong bot',
      turnId: 't1',
    })

    expect(clientFakes.sends).toEqual([])
  })

  test('outbound: thread is forwarded as thread_id', async () => {
    const { router } = await makeRouter()
    const clientFakes = createFakeClient()
    const adapter = createDiscordBotAdapter({
      bot: 'main',
      chats: ['*'],
      router,
      client: clientFakes.client,
      listener: createFakeListener().listener,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await adapter.outboundCallback({
      adapter: 'discord-bot',
      bot: 'main',
      workspace: 'W1',
      chat: 'C1',
      thread: 'T9',
      text: 'in thread',
      turnId: 't1',
    })

    expect(clientFakes.sends).toEqual([{ channel: 'C1', content: 'in thread', thread: 'T9' }])
  })

  test('outbound: send error is caught and logged, not thrown', async () => {
    const { router } = await makeRouter()
    const errors: string[] = []
    const adapter = createDiscordBotAdapter({
      bot: 'main',
      chats: ['*'],
      router,
      client: {
        async sendMessage() {
          throw new Error('rate limit')
        },
      },
      listener: createFakeListener().listener,
      logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
    })

    await adapter.outboundCallback({
      adapter: 'discord-bot',
      bot: 'main',
      workspace: 'W1',
      chat: 'C1',
      thread: null,
      text: 'fail',
      turnId: 't1',
    })

    expect(errors.some((e) => e.includes('rate limit'))).toBe(true)
  })

  test('stop() awaits in-flight handleInbound before returning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channels-adapter-'))
    const fakes = createFakeSession()
    let releaseRouter: () => void = () => {}
    const slowRouter = createChannelRouter({
      agentDir: dir,
      createSessionForChannel: async () => {
        await new Promise<void>((r) => {
          releaseRouter = r
        })
        return { session: fakes.session, sessionId: 'sess-1' }
      },
    })
    const adapter = createDiscordBotAdapter({
      bot: 'main',
      chats: ['*'],
      router: slowRouter,
      client: createFakeClient().client,
      listener: createFakeListener().listener,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    const inboundPromise = adapter.handleInbound(makeMessageEvent({ content: 'hi' }))
    let stopResolved = false
    const stopPromise = adapter.stop().then(() => {
      stopResolved = true
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(stopResolved).toBe(false)

    releaseRouter()
    await inboundPromise
    await stopPromise

    expect(stopResolved).toBe(true)
  })

  test('end-to-end: inbound → session.prompt → text_delta → message_end → outbound send', async () => {
    const { router, fakes } = await makeRouter()
    const clientFakes = createFakeClient()
    const adapter = createDiscordBotAdapter({
      bot: 'main',
      chats: ['*'],
      router,
      client: clientFakes.client,
      listener: createFakeListener().listener,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })

    await adapter.start()
    await adapter.handleInbound(makeMessageEvent({ content: 'ping' }))
    expect(fakes.promptCalls).toEqual(['ping'])

    for (const l of fakes.listeners) {
      l({
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: { type: 'text_delta', delta: 'pong' },
      })
      l({ type: 'message_end', message: { role: 'assistant', responseId: 'r1', timestamp: 1 } })
    }
    await Promise.resolve()

    expect(clientFakes.sends).toEqual([{ channel: 'C1', content: 'pong' }])
  })
})
