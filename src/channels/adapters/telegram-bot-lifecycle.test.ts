import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TelegramBotClient, TelegramBotUser, TelegramMessage } from 'agent-messenger/telegrambot'

import { createChannelRouter } from '@/channels/router'
import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'

import { createTelegramBotAdapter, type TelegramBotAdapterLogger } from './telegram-bot'
import type { TelegramBotPollingListenerEventMap } from './telegram-bot-listener'

const BOT_USER: TelegramBotUser = { id: 999, is_bot: true, first_name: 'TypeClaw', username: 'typeclaw_bot' }

const adapterCfg: ChannelAdapterConfig = {
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
}

function silentLogger(): TelegramBotAdapterLogger & { errors: string[]; warns: string[]; infos: string[] } {
  const errors: string[] = []
  const warns: string[] = []
  const infos: string[] = []
  return {
    info: (m) => infos.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    errors,
    warns,
    infos,
  }
}

type ListenerEvent = keyof TelegramBotPollingListenerEventMap

class FakeListener {
  started = false
  stopped = 0
  startCalls = 0
  stopGate: Promise<void> | null = null
  startBehavior: 'emit-connected' | 'silent-fail' | 'error-event' | 'throw' | 'wait-for-connected-call' =
    'emit-connected'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlers = new Map<ListenerEvent, Array<(...args: any[]) => void>>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: ListenerEvent, handler: (...args: any[]) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  async start(): Promise<void> {
    this.startCalls++
    this.started = true
    if (this.startBehavior === 'throw') {
      throw new Error('listener.start threw')
    }
    if (this.startBehavior === 'emit-connected') {
      this.emit('connected', { user: BOT_USER })
      return
    }
    if (this.startBehavior === 'silent-fail') {
      this.emit('error', new Error('deleteWebhook failed'))
      return
    }
    if (this.startBehavior === 'error-event') {
      // A WebSocket 'error' fires with an ErrorEvent-shaped value, not an Error
      this.emit('error', { type: 'error', message: 'invalid_auth' } as unknown as Error)
      return
    }
    // 'wait-for-connected-call' — caller will trigger the event manually
  }

  async stop(): Promise<void> {
    this.stopped++
    this.started = false
    await this.stopGate
  }

  emit<K extends ListenerEvent>(event: K, ...args: TelegramBotPollingListenerEventMap[K]): void {
    const list = this.handlers.get(event) ?? []
    for (const h of list) h(...args)
  }

  async emitAsync<K extends ListenerEvent>(event: K, ...args: TelegramBotPollingListenerEventMap[K]): Promise<void> {
    const list = this.handlers.get(event) ?? []
    for (const h of list) await h(...args)
  }
}

class FakeClient {
  loginCalls = 0
  getMeCalls = 0
  getMeBehavior: 'ok' | 'throw' = 'ok'
  getChatBehavior: 'private' | 'group' | 'throw' = 'group'
  sendMessageCalls = 0

  async login(_credentials?: { token: string }): Promise<this> {
    this.loginCalls++
    return this
  }
  async getMe(): Promise<TelegramBotUser> {
    this.getMeCalls++
    if (this.getMeBehavior === 'throw') throw new Error('Unauthorized')
    return BOT_USER
  }
  async getChat(_chatId: string | number): Promise<{ id: number; type: 'private' | 'supergroup' }> {
    if (this.getChatBehavior === 'throw') throw new Error('chat not found')
    return this.getChatBehavior === 'private' ? { id: 1, type: 'private' } : { id: -100123, type: 'supergroup' }
  }
  async getChatMemberCount(_chatId: string | number): Promise<number> {
    return 5
  }
  async sendMessage(_chatId: string | number, _text: string): Promise<TelegramMessage> {
    this.sendMessageCalls++
    return { message_id: 1, date: 0, chat: { id: -100123, type: 'supergroup' } }
  }
  async sendDocument(_chatId: string | number, _path: string): Promise<TelegramMessage> {
    return { message_id: 2, date: 0, chat: { id: -100123, type: 'supergroup' } }
  }
}

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-tg-lifecycle-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

function makeRouter(): ReturnType<typeof createChannelRouter> {
  return createChannelRouter({
    agentDir,
    configForAdapter: () => adapterCfg,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  })
}

describe('createTelegramBotAdapter — startup correctness', () => {
  test('throws and unregisters callbacks when listener.start() returns without emitting connected (silent failure)', async () => {
    const fakeClient = new FakeClient()
    const fakeListener = new FakeListener()
    fakeListener.startBehavior = 'silent-fail'
    const router = makeRouter()
    const logger = silentLogger()

    const adapter = createTelegramBotAdapter({
      router,
      agentDir,
      configRef: () => adapterCfg,
      token: 'tok',
      logger,
      createClient: () => fakeClient as unknown as TelegramBotClient,
      createListener: () => fakeListener,
    })

    let thrown: unknown = null
    try {
      await adapter.start()
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(adapter.isConnected()).toBe(false)
    expect(fakeListener.stopped).toBe(1)
    // Critical: callbacks were unregistered. If the adapter "started"
    // with a dead poller, subsequent send attempts would silently no-op
    // and the manager would keep the entry in `live` until restart.
    const sendResult = await router.send({ adapter: 'telegram-bot', workspace: 'telegram', chat: '-100123', text: 'x' })
    expect(sendResult.ok).toBe(false)
    if (sendResult.ok) throw new Error('expected error')
    expect(sendResult.error).toContain('no adapter registered')
  })

  test('surfaces the real reason from an ErrorEvent-shaped listener failure, not [object ErrorEvent]', async () => {
    const fakeClient = new FakeClient()
    const fakeListener = new FakeListener()
    fakeListener.startBehavior = 'error-event'
    const logger = silentLogger()

    const adapter = createTelegramBotAdapter({
      router: makeRouter(),
      agentDir,
      configRef: () => adapterCfg,
      token: 'tok',
      logger,
      createClient: () => fakeClient as unknown as TelegramBotClient,
      createListener: () => fakeListener,
    })

    let thrown: unknown = null
    try {
      await adapter.start()
    } catch (err) {
      thrown = err
    }

    expect((thrown as Error).message).toContain('invalid_auth')
    expect(logger.errors.some((line) => line.includes('invalid_auth'))).toBe(true)
    expect(logger.errors.some((line) => line.includes('[object'))).toBe(false)
  })

  test('throws and unregisters when listener.start() rejects synchronously', async () => {
    const fakeClient = new FakeClient()
    const fakeListener = new FakeListener()
    fakeListener.startBehavior = 'throw'
    const router = makeRouter()

    const adapter = createTelegramBotAdapter({
      router,
      agentDir,
      configRef: () => adapterCfg,
      token: 'tok',
      logger: silentLogger(),
      createClient: () => fakeClient as unknown as TelegramBotClient,
      createListener: () => fakeListener,
    })

    await expect(adapter.start()).rejects.toThrow('listener.start threw')
    expect(adapter.isConnected()).toBe(false)
    const sendResult = await router.send({ adapter: 'telegram-bot', workspace: 'telegram', chat: '-100123', text: 'x' })
    expect(sendResult.ok).toBe(false)
  })

  test('startup rollback waits for listener shutdown to drain', async () => {
    const fakeClient = new FakeClient()
    const fakeListener = new FakeListener()
    fakeListener.startBehavior = 'throw'
    const stopGate = deferred<void>()
    fakeListener.stopGate = stopGate.promise
    const adapter = createTelegramBotAdapter({
      router: makeRouter(),
      agentDir,
      configRef: () => adapterCfg,
      token: 'tok',
      logger: silentLogger(),
      createClient: () => fakeClient as unknown as TelegramBotClient,
      createListener: () => fakeListener,
    })
    let settled = false
    const startPromise = adapter.start().then(
      () => null,
      (error: unknown) => error,
    )
    void startPromise.finally(() => {
      settled = true
    })

    await Bun.sleep(10)
    expect(fakeListener.stopped).toBe(1)
    expect(settled).toBe(false)

    stopGate.resolve()
    expect(await startPromise).toEqual(new Error('listener.start threw'))
  })

  test('throws on getMe() failure WITHOUT constructing the listener (preflight bails early)', async () => {
    const fakeClient = new FakeClient()
    fakeClient.getMeBehavior = 'throw'
    const fakeListener = new FakeListener()
    let listenerConstructed = false

    const adapter = createTelegramBotAdapter({
      router: makeRouter(),
      agentDir,
      configRef: () => adapterCfg,
      token: 'tok',
      logger: silentLogger(),
      createClient: () => fakeClient as unknown as TelegramBotClient,
      createListener: () => {
        listenerConstructed = true
        return fakeListener
      },
    })

    await expect(adapter.start()).rejects.toThrow('Unauthorized')
    expect(listenerConstructed).toBe(false)
    expect(adapter.isConnected()).toBe(false)
  })

  test('happy path: getMe + listener.start emits connected → adapter is started and connected', async () => {
    const fakeClient = new FakeClient()
    const fakeListener = new FakeListener()
    const router = makeRouter()

    const adapter = createTelegramBotAdapter({
      router,
      agentDir,
      configRef: () => adapterCfg,
      token: 'tok',
      logger: silentLogger(),
      createClient: () => fakeClient as unknown as TelegramBotClient,
      createListener: () => fakeListener,
    })

    await adapter.start()

    expect(adapter.isConnected()).toBe(true)
    expect(fakeClient.getMeCalls).toBe(1)
    expect(fakeListener.startCalls).toBe(1)
  })

  test('reflects transient listener disconnect and recovery in adapter liveness', async () => {
    const fakeClient = new FakeClient()
    const fakeListener = new FakeListener()
    const adapter = createTelegramBotAdapter({
      router: makeRouter(),
      agentDir,
      configRef: () => adapterCfg,
      token: 'tok',
      logger: silentLogger(),
      createClient: () => fakeClient as unknown as TelegramBotClient,
      createListener: () => fakeListener,
    })

    await adapter.start()
    fakeListener.emit('disconnected')
    expect(adapter.isConnected()).toBe(false)

    fakeListener.emit('connected', { user: BOT_USER })
    expect(adapter.isConnected()).toBe(true)
    await adapter.stop()
  })

  test('post-connect terminal listener failure makes adapter liveness false', async () => {
    const fakeClient = new FakeClient()
    const fakeListener = new FakeListener()
    const adapter = createTelegramBotAdapter({
      router: makeRouter(),
      agentDir,
      configRef: () => adapterCfg,
      token: 'tok',
      logger: silentLogger(),
      createClient: () => fakeClient as unknown as TelegramBotClient,
      createListener: () => fakeListener,
    })

    await adapter.start()
    fakeListener.emit('error', new Error('route handler failed'))
    fakeListener.emit('disconnected')

    expect(adapter.isConnected()).toBe(false)
    await adapter.stop()
  })

  test('router rejection propagates while intentional classification drops resolve', async () => {
    const fakeClient = new FakeClient()
    const fakeListener = new FakeListener()
    const router = makeRouter()
    router.route = async () => {
      throw new Error('route failed')
    }
    const adapter = createTelegramBotAdapter({
      router,
      agentDir,
      configRef: () => adapterCfg,
      token: 'tok',
      logger: silentLogger(),
      createClient: () => fakeClient as unknown as TelegramBotClient,
      createListener: () => fakeListener,
    })
    await adapter.start()

    await expect(
      fakeListener.emitAsync('message', inboundMessage({ id: 1, is_bot: false, first_name: 'Alice' })),
    ).rejects.toThrow('route failed')
    await expect(fakeListener.emitAsync('message', inboundMessage(BOT_USER))).resolves.toBeUndefined()
    await adapter.stop()
  })
})

describe('createTelegramBotAdapter — shutdown race', () => {
  test('inflight handler that started before stop() still routes (snapshot prevents pre_connect drop after botUser=null)', async () => {
    const fakeClient = new FakeClient()
    const fakeListener = new FakeListener()
    const router = makeRouter()

    // Gate `getChat` (which `formatChannelTag` awaits BEFORE
    // classifyInbound runs). This places the handler's pause point
    // exactly between `inflightInbounds++` and the `classifyInbound(...,
    // botUser)` read — the precise window where the bug fired.
    let resolveGetChatGate: () => void = () => {}
    const getChatGate = new Promise<void>((resolve) => {
      resolveGetChatGate = resolve
    })
    fakeClient.getChat = async (_chatId: string | number) => {
      await getChatGate
      return { id: -100123, type: 'supergroup' as const }
    }

    const routedPayloads: Array<{ chat: string; text: string }> = []
    const originalRoute = router.route.bind(router)
    router.route = async (payload) => {
      routedPayloads.push({ chat: payload.chat, text: payload.text })
      return originalRoute(payload)
    }

    const adapter = createTelegramBotAdapter({
      router,
      agentDir,
      configRef: () => adapterCfg,
      token: 'tok',
      logger: silentLogger(),
      createClient: () => fakeClient as unknown as TelegramBotClient,
      createListener: () => fakeListener,
    })

    await adapter.start()

    const message: TelegramMessage = {
      message_id: 7,
      date: 1_700_000_000,
      chat: { id: -100123, type: 'supergroup', title: 'Eng' },
      from: { id: 1, is_bot: false, first_name: 'Alice', username: 'alice' },
      text: 'hello',
    }
    fakeListener.emit('message', message)

    // Yield the event loop so handleMessage starts and reaches the
    // `await formatChannelTag(...)` → `await getChat(...)` await point,
    // blocked at the gate. inflightInbounds is now 1 and we have NOT
    // yet called classifyInbound.
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(routedPayloads).toHaveLength(0)

    // Begin stop. Without the snapshot fix, this nulls module-level
    // `botUser`. The handler will resume from getChat and then call
    // classifyInbound(..., botUser=null) → drop as pre_connect.
    const stopPromise = adapter.stop()

    // Release the gate so the handler resumes past formatChannelTag,
    // hits classifyInbound, and either routes (snapshot) or drops
    // (no snapshot).
    resolveGetChatGate()

    await stopPromise

    // Critical mutation guard for the snapshot-vs-live `botUser` read:
    // any code path where classifyInbound is called with the live
    // module-level `botUser` (rather than the snapshot taken at handler
    // entry) will see `null` here and drop as pre_connect, leaving
    // `routedPayloads` empty.
    expect(routedPayloads).toEqual([{ chat: '-100123', text: 'hello' }])
    expect(adapter.isConnected()).toBe(false)
    expect(fakeListener.stopped).toBe(1)
  })

  test('after stop() completes, isConnected() returns false and no further routing happens', async () => {
    const fakeClient = new FakeClient()
    const fakeListener = new FakeListener()
    const router = makeRouter()

    const adapter = createTelegramBotAdapter({
      router,
      agentDir,
      configRef: () => adapterCfg,
      token: 'tok',
      logger: silentLogger(),
      createClient: () => fakeClient as unknown as TelegramBotClient,
      createListener: () => fakeListener,
    })

    await adapter.start()
    expect(adapter.isConnected()).toBe(true)
    await adapter.stop()
    expect(adapter.isConnected()).toBe(false)
  })

  test('stop() is idempotent (calling twice does not throw)', async () => {
    const fakeClient = new FakeClient()
    const fakeListener = new FakeListener()

    const adapter = createTelegramBotAdapter({
      router: makeRouter(),
      agentDir,
      configRef: () => adapterCfg,
      token: 'tok',
      logger: silentLogger(),
      createClient: () => fakeClient as unknown as TelegramBotClient,
      createListener: () => fakeListener,
    })

    await adapter.start()
    await adapter.stop()
    await adapter.stop()
    expect(fakeListener.stopped).toBe(1)
  })

  test('adapter stop waits for listener drain before resolving', async () => {
    const fakeClient = new FakeClient()
    const fakeListener = new FakeListener()
    const stopGate = deferred<void>()
    fakeListener.stopGate = stopGate.promise
    const adapter = createTelegramBotAdapter({
      router: makeRouter(),
      agentDir,
      configRef: () => adapterCfg,
      token: 'tok',
      logger: silentLogger(),
      createClient: () => fakeClient as unknown as TelegramBotClient,
      createListener: () => fakeListener,
    })
    await adapter.start()
    let settled = false
    const stopPromise = adapter.stop().then(() => {
      settled = true
    })

    await Bun.sleep(10)
    expect(fakeListener.stopped).toBe(1)
    expect(settled).toBe(false)

    stopGate.resolve()
    await stopPromise
    expect(settled).toBe(true)
  })
})

function inboundMessage(from: TelegramBotUser): TelegramMessage {
  return {
    message_id: 17,
    date: 1_700_000_000,
    chat: { id: -100123, type: 'supergroup', title: 'Eng' },
    from,
    text: 'hello @typeclaw_bot',
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
