import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { TelegramBotError } from 'agent-messenger/telegrambot'
import type { GetUpdatesOptions, TelegramBotUser, TelegramUpdate } from 'agent-messenger/telegrambot'

import {
  createTelegramBotPollingListener,
  telegramBotCursorPath,
  type TelegramBotCursorState,
  type TelegramBotCursorStore,
  type TelegramBotPollingListenerOptions,
} from './telegram-bot-listener'

const BOT_USER: TelegramBotUser = { id: 999, is_bot: true, first_name: 'TypeClaw', username: 'typeclaw_bot' }
const BOT_ID = BOT_USER.id

class FakePollingClient {
  readonly deleteWebhookCalls: Array<{ drop_pending_updates?: boolean } | undefined> = []
  readonly getUpdatesCalls: GetUpdatesOptions[] = []
  deleteWebhookImpl: (options?: { drop_pending_updates?: boolean }) => Promise<boolean> = async () => true
  getUpdatesImpl: (options: GetUpdatesOptions, signal?: AbortSignal) => Promise<TelegramUpdate[]> = (
    _options,
    signal,
  ) => waitForAbort(signal)

  async deleteWebhook(options?: { drop_pending_updates?: boolean }): Promise<boolean> {
    this.deleteWebhookCalls.push(options)
    return this.deleteWebhookImpl(options)
  }

  async getUpdates(options: GetUpdatesOptions = {}, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    this.getUpdatesCalls.push(options)
    return this.getUpdatesImpl(options, signal)
  }
}

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-telegram-cursor-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('Telegram bot polling cursor', () => {
  test('cold boot drops pending updates once, then offset 0 is durable initialized state', async () => {
    const firstClient = new FakePollingClient()
    firstClient.deleteWebhookImpl = async () => {
      const state = JSON.parse(await readFile(telegramBotCursorPath(agentDir, BOT_ID), 'utf8')) as unknown
      expect(state).toEqual({ version: 1, status: 'initializing' })
      return true
    }
    const first = createListener(firstClient)

    await first.start()
    await waitUntil(() => firstClient.getUpdatesCalls.length === 1)

    expect(firstClient.deleteWebhookCalls).toEqual([{ drop_pending_updates: true }])
    expect(firstClient.getUpdatesCalls[0]?.offset).toBe(0)
    const cursorPath = telegramBotCursorPath(agentDir, BOT_ID)
    expect(cursorPath).toContain(String(BOT_ID))
    expect(await readFile(cursorPath, 'utf8')).not.toContain('test-token')
    expect(JSON.parse(await readFile(cursorPath, 'utf8'))).toEqual({ version: 1, status: 'ready', offset: 0 })
    await first.stop()

    const restartedClient = new FakePollingClient()
    const restarted = createListener(restartedClient)
    await restarted.start()
    await waitUntil(() => restartedClient.getUpdatesCalls.length === 1)

    expect(restartedClient.deleteWebhookCalls).toEqual([{ drop_pending_updates: false }])
    expect(restartedClient.getUpdatesCalls[0]?.offset).toBe(0)
    await restarted.stop()
  })

  test('an initializing marker recovers without another destructive drop', async () => {
    const path = telegramBotCursorPath(agentDir, BOT_ID)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 1, status: 'initializing' }), 'utf8')
    const client = new FakePollingClient()
    const listener = createListener(client)

    await listener.start()
    await waitUntil(() => client.getUpdatesCalls.length === 1)

    expect(client.deleteWebhookCalls).toEqual([{ drop_pending_updates: false }])
    expect(client.getUpdatesCalls[0]?.offset).toBe(0)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, status: 'ready', offset: 0 })
    await listener.stop()
  })

  test('a failed first destructive drop leaves initializing state so restart will not drop again', async () => {
    const firstClient = new FakePollingClient()
    firstClient.deleteWebhookImpl = async () => {
      throw new Error('network failed')
    }

    await expect(createListener(firstClient).start()).rejects.toThrow('network failed')
    expect(JSON.parse(await readFile(telegramBotCursorPath(agentDir, BOT_ID), 'utf8'))).toEqual({
      version: 1,
      status: 'initializing',
    })

    const restartedClient = new FakePollingClient()
    const restarted = createListener(restartedClient)
    await restarted.start()
    await waitUntil(() => restartedClient.getUpdatesCalls.length === 1)
    expect(restartedClient.deleteWebhookCalls).toEqual([{ drop_pending_updates: false }])
    await restarted.stop()
  })

  test('same authenticated bot id keeps the cursor across adapter token rotation', async () => {
    const store = new MemoryCursorStore({ version: 1, status: 'ready', offset: 73 })
    const firstClient = new FakePollingClient()
    const first = createListener(firstClient, { cursorStore: store })
    await first.start()
    await waitUntil(() => firstClient.getUpdatesCalls.length === 1)
    await first.stop()

    const rotatedClient = new FakePollingClient()
    const rotated = createListener(rotatedClient, {
      cursorStore: store,
      botUser: { ...BOT_USER, username: 'renamed_bot' },
    })
    await rotated.start()
    await waitUntil(() => rotatedClient.getUpdatesCalls.length === 1)

    expect(firstClient.getUpdatesCalls[0]?.offset).toBe(73)
    expect(rotatedClient.getUpdatesCalls[0]?.offset).toBe(73)
    await rotated.stop()
  })

  test('advances the durable cursor only after the supported handler finishes', async () => {
    const client = new FakePollingClient()
    const handlerStarted = deferred<void>()
    const handlerFinished = deferred<void>()
    let poll = 0
    client.getUpdatesImpl = async (_options, signal) => {
      poll++
      if (poll === 1) return [{ update_id: 41, message: telegramMessage(7) }]
      return waitForAbort(signal)
    }
    const listener = createListener(client)
    listener.on('message', async () => {
      handlerStarted.resolve()
      await handlerFinished.promise
    })

    await listener.start()
    await handlerStarted.promise
    expect(client.getUpdatesCalls.map((call) => call.offset)).toEqual([0])

    handlerFinished.resolve()
    await waitUntil(() => client.getUpdatesCalls.length === 2)
    expect(client.getUpdatesCalls.map((call) => call.offset)).toEqual([0, 42])
    await listener.stop()

    const restartedClient = new FakePollingClient()
    const restarted = createListener(restartedClient)
    await restarted.start()
    await waitUntil(() => restartedClient.getUpdatesCalls.length === 1)
    expect(restartedClient.getUpdatesCalls[0]?.offset).toBe(42)
    expect(restartedClient.deleteWebhookCalls).toEqual([{ drop_pending_updates: false }])
    await restarted.stop()
  })

  test('corrupt or unsupported cursor state fails closed without dropping backlog', async () => {
    const path = telegramBotCursorPath(agentDir, BOT_ID)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ version: 99, offset: 123 }), 'utf8')
    const client = new FakePollingClient()
    const listener = createListener(client)

    await expect(listener.start()).rejects.toThrow('unsupported')
    await expect(listener.start()).rejects.toThrow(path)
    await expect(listener.start()).rejects.toThrow('pending updates')
    expect(client.deleteWebhookCalls).toHaveLength(0)
    expect(client.getUpdatesCalls).toHaveLength(0)
  })

  test('malformed cursor state fails closed without contacting Telegram', async () => {
    const path = telegramBotCursorPath(agentDir, BOT_ID)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{not-json', 'utf8')
    const client = new FakePollingClient()

    await expect(createListener(client).start()).rejects.toThrow('corrupt')
    expect(client.deleteWebhookCalls).toHaveLength(0)
    expect(client.getUpdatesCalls).toHaveLength(0)
  })

  test('sends allowed updates only on the first successful poll', async () => {
    const client = new FakePollingClient()
    let poll = 0
    client.getUpdatesImpl = async (_options, signal) => {
      poll++
      if (poll === 1) return []
      return waitForAbort(signal)
    }
    const listener = createListener(client)

    await listener.start()
    await waitUntil(() => client.getUpdatesCalls.length === 2)

    expect(client.getUpdatesCalls[0]).toMatchObject({
      offset: 0,
      limit: 100,
      timeout: 30,
      allowed_updates: ['message', 'channel_post'],
    })
    expect(client.getUpdatesCalls[1]?.allowed_updates).toBeUndefined()
    await listener.stop()
  })

  test('stops polling on fatal Telegram authorization errors', async () => {
    const store = new MemoryCursorStore({ version: 1, status: 'ready', offset: 0 })
    const client = new FakePollingClient()
    client.getUpdatesImpl = async () => {
      throw new TelegramBotError('Unauthorized', 'unauthorized')
    }
    const fatal = deferred<Error>()
    let disconnected = 0
    const listener = createListener(client, { cursorStore: store })
    listener.on('error', (error) => fatal.resolve(error))
    listener.on('disconnected', () => {
      disconnected++
    })

    await listener.start()
    expect(await fatal.promise).toBeInstanceOf(TelegramBotError)
    await Bun.sleep(10)

    expect(client.getUpdatesCalls).toHaveLength(1)
    expect(disconnected).toBe(1)
    await listener.stop()
  })

  test('transient polling failure disconnects, then successful polling reconnects', async () => {
    const store = new MemoryCursorStore({ version: 1, status: 'ready', offset: 0 })
    const client = new FakePollingClient()
    let poll = 0
    client.getUpdatesImpl = async (_options, signal) => {
      poll++
      if (poll === 1) throw new Error('temporary network failure')
      if (poll === 2) return []
      return waitForAbort(signal)
    }
    const events: string[] = []
    const listener = createListener(client, { cursorStore: store, backoff: async () => {} })
    listener.on('connected', () => {
      events.push('connected')
    })
    listener.on('disconnected', () => {
      events.push('disconnected')
    })

    await listener.start()
    await waitUntil(() => client.getUpdatesCalls.length === 3)

    expect(events).toEqual(['connected', 'disconnected', 'connected'])
    await listener.stop()
  })

  test('handler rejection runs siblings, terminates safely, and leaves the cursor unadvanced', async () => {
    const store = new MemoryCursorStore({ version: 1, status: 'ready', offset: 0 })
    const client = new FakePollingClient()
    client.getUpdatesImpl = async () => [{ update_id: 12, message: telegramMessage(12) }]
    const events: string[] = []
    const terminal = deferred<void>()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const listener = createListener(client, { cursorStore: store })
      listener.on('message', async () => {
        events.push('message:first')
        throw new Error('route failed')
      })
      listener.on('message', () => {
        events.push('message:second')
      })
      listener.on('error', async () => {
        events.push('error:first')
        throw new Error('error observer failed')
      })
      listener.on('error', () => {
        events.push('error:second')
      })
      listener.on('disconnected', async () => {
        events.push('disconnected:first')
        throw new Error('disconnect observer failed')
      })
      listener.on('disconnected', () => {
        events.push('disconnected:second')
        terminal.resolve()
      })

      await listener.start()
      await terminal.promise
      await Bun.sleep(10)

      expect(events).toEqual([
        'message:first',
        'message:second',
        'error:first',
        'error:second',
        'disconnected:first',
        'disconnected:second',
      ])
      expect(store.state).toEqual({ version: 1, status: 'ready', offset: 0 })
      expect(client.getUpdatesCalls).toHaveLength(1)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('cursor write failure terminates without polling an uncommitted higher offset', async () => {
    const store = new MemoryCursorStore({ version: 1, status: 'ready', offset: 0 })
    store.failWrites = 1
    const client = new FakePollingClient()
    client.getUpdatesImpl = async (_options, signal) => {
      if (client.getUpdatesCalls.length === 1) return [{ update_id: 41, message: telegramMessage(41) }]
      return waitForAbort(signal)
    }
    let dispatched = 0
    const errors: string[] = []
    const disconnected = deferred<void>()
    const listener = createListener(client, { cursorStore: store })
    listener.on('message', () => {
      dispatched++
    })
    listener.on('error', (error) => {
      errors.push(error.message)
    })
    listener.on('disconnected', () => disconnected.resolve())

    await listener.start()
    await disconnected.promise
    await Bun.sleep(10)

    expect(client.getUpdatesCalls.map((call) => call.offset)).toEqual([0])
    expect(dispatched).toBe(1)
    expect(store.state).toEqual({ version: 1, status: 'ready', offset: 0 })
    expect(
      errors.some((message) => message.includes('checkpoint failed') && message.includes('not acknowledged')),
    ).toBe(true)
    await listener.stop()
  })

  test('stop interrupts dedicated backoff after a polling failure', async () => {
    const store = new MemoryCursorStore({ version: 1, status: 'ready', offset: 0 })
    const client = new FakePollingClient()
    client.getUpdatesImpl = async () => {
      throw new Error('temporary network failure')
    }
    const backoffStarted = deferred<AbortSignal>()
    const backoffStopped = deferred<void>()
    const listener = createListener(client, {
      cursorStore: store,
      backoff: async (_delay, signal) => {
        backoffStarted.resolve(signal)
        if (signal.aborted) return
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        backoffStopped.resolve()
      },
    })

    await listener.start()
    const signal = await backoffStarted.promise
    await listener.stop()
    await backoffStopped.promise

    expect(signal.aborted).toBe(true)
    expect(client.getUpdatesCalls).toHaveLength(1)
  })

  test('stop is bounded when the SDK request ignores abort and late results never dispatch', async () => {
    const client = new FakePollingClient()
    const pollResult = deferred<TelegramUpdate[]>()
    let pollSignal: AbortSignal | undefined
    client.getUpdatesImpl = (_options, signal) => {
      pollSignal = signal
      return pollResult.promise
    }
    const listener = createListener(client)
    let dispatched = 0
    listener.on('message', async () => {
      dispatched++
    })

    await listener.start()
    await waitUntil(() => client.getUpdatesCalls.length === 1)
    const stopPromise = listener.stop()
    expect(pollSignal?.aborted).toBe(true)
    const stoppedWithinBound = await Promise.race([stopPromise.then(() => true), Bun.sleep(50).then(() => false)])
    expect(stoppedWithinBound).toBe(true)

    pollResult.resolve([{ update_id: 88, message: telegramMessage(8) }])
    await Bun.sleep(10)

    expect(dispatched).toBe(0)

    const restartedClient = new FakePollingClient()
    const restarted = createListener(restartedClient)
    await restarted.start()
    await waitUntil(() => restartedClient.getUpdatesCalls.length === 1)
    expect(restartedClient.getUpdatesCalls[0]?.offset).toBe(0)
    expect(restartedClient.deleteWebhookCalls).toEqual([{ drop_pending_updates: false }])
    await restarted.stop()
  })

  test('late SDK rejection after abort is retained without unhandled or listener error leakage', async () => {
    const client = new FakePollingClient()
    const pollResult = deferred<TelegramUpdate[]>()
    client.getUpdatesImpl = () => pollResult.promise
    const listener = createListener(client)
    const unhandled: unknown[] = []
    const listenerErrors: Error[] = []
    let dispatched = 0
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    listener.on('error', (error) => {
      listenerErrors.push(error)
    })
    listener.on('message', () => {
      dispatched++
    })
    try {
      await listener.start()
      await waitUntil(() => client.getUpdatesCalls.length === 1)
      await listener.stop()

      pollResult.reject(new Error('late SDK retry failed'))
      await Bun.sleep(10)

      expect(unhandled).toEqual([])
      expect(listenerErrors).toEqual([])
      expect(dispatched).toBe(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('stop during a handler prevents its later completion from checkpointing', async () => {
    const client = new FakePollingClient()
    const handlerStarted = deferred<void>()
    const handlerFinished = deferred<void>()
    client.getUpdatesImpl = async () => [{ update_id: 55, message: telegramMessage(9) }]
    const listener = createListener(client)
    listener.on('message', async () => {
      handlerStarted.resolve()
      await handlerFinished.promise
    })

    await listener.start()
    await handlerStarted.promise
    const stopPromise = listener.stop()
    handlerFinished.resolve()
    await stopPromise
    await Bun.sleep(10)

    const restartedClient = new FakePollingClient()
    const restarted = createListener(restartedClient)
    await restarted.start()
    await waitUntil(() => restartedClient.getUpdatesCalls.length === 1)
    expect(restartedClient.getUpdatesCalls[0]?.offset).toBe(0)
    await restarted.stop()
  })

  test('reentrant stop lets the carrying dispatch checkpoint before drain completes', async () => {
    const store = new MemoryCursorStore({ version: 1, status: 'ready', offset: 0 })
    const client = new FakePollingClient()
    client.getUpdatesImpl = async () => [{ update_id: 55, message: telegramMessage(55) }]
    const listener = createListener(client, { cursorStore: store })
    let stopPromise: Promise<void> | null = null
    listener.on('message', () => {
      stopPromise = listener.stop({ finishCurrentDispatch: true })
    })

    await listener.start()
    await waitUntil(() => store.readyOffset() === 56)
    await stopPromise

    expect(store.state).toEqual({ version: 1, status: 'ready', offset: 56 })
    expect(client.getUpdatesCalls.map((call) => call.offset)).toEqual([0])
  })

  test('stop drains an old checkpoint write before a replacement listener can start', async () => {
    const store = new BlockingCheckpointStore({ version: 1, status: 'ready', offset: 0 }, 10)
    const oldClient = new FakePollingClient()
    let oldPoll = 0
    oldClient.getUpdatesImpl = async (_options, signal) => {
      oldPoll++
      if (oldPoll === 1) return [{ update_id: 9, message: telegramMessage(9) }]
      return waitForAbort(signal)
    }
    const oldListener = createListener(oldClient, { cursorStore: store })
    oldListener.on('message', () => {})
    await oldListener.start()
    await store.blocked.promise

    const replacementClient = new FakePollingClient()
    let replacementPoll = 0
    replacementClient.getUpdatesImpl = async (_options, signal) => {
      replacementPoll++
      if (replacementPoll === 1) return [{ update_id: 99, message: telegramMessage(99) }]
      return waitForAbort(signal)
    }
    const replacement = createListener(replacementClient, { cursorStore: store })
    replacement.on('message', () => {})
    let stopResolved = false
    const restart = (async () => {
      await oldListener.stop()
      stopResolved = true
      await replacement.start()
    })()

    await Bun.sleep(10)
    expect(stopResolved).toBe(false)
    expect(replacementClient.getUpdatesCalls).toHaveLength(0)

    store.release.resolve()
    await restart
    await waitUntil(() => replacementClient.getUpdatesCalls.length === 2 && store.readyOffset() === 100)

    expect(replacementClient.getUpdatesCalls[0]?.offset).toBe(10)
    expect(store.state).toEqual({ version: 1, status: 'ready', offset: 100 })
    await replacement.stop()
  })
})

function createListener(client: FakePollingClient, overrides: Partial<TelegramBotPollingListenerOptions> = {}) {
  return createTelegramBotPollingListener(client, {
    agentDir,
    botUser: BOT_USER,
    timeoutSeconds: 30,
    limit: 100,
    allowedUpdates: ['message', 'channel_post'],
    ...overrides,
  })
}

function telegramMessage(messageId: number) {
  return {
    message_id: messageId,
    date: 1_700_000_000,
    chat: { id: 123, type: 'private' as const },
    from: { id: 1, is_bot: false, first_name: 'Alice' },
    text: 'hello',
  }
}

function waitForAbort(signal?: AbortSignal): Promise<TelegramUpdate[]> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Bun.sleep(1)
  }
  throw new Error('condition was not met')
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class MemoryCursorStore implements TelegramBotCursorStore {
  writes: TelegramBotCursorState[] = []
  failWrites = 0

  constructor(public state: TelegramBotCursorState | null) {}

  async read(): Promise<TelegramBotCursorState | null> {
    return this.state
  }

  async write(state: TelegramBotCursorState): Promise<void> {
    this.writes.push(state)
    if (this.failWrites > 0) {
      this.failWrites--
      throw new Error('checkpoint failed')
    }
    this.state = state
  }

  readyOffset(): number | null {
    return this.state?.status === 'ready' ? this.state.offset : null
  }
}

class BlockingCheckpointStore extends MemoryCursorStore {
  readonly blocked = deferred<void>()
  readonly release = deferred<void>()
  private didBlock = false

  constructor(
    state: TelegramBotCursorState,
    private readonly blockedOffset: number,
  ) {
    super(state)
  }

  override async write(state: TelegramBotCursorState): Promise<void> {
    if (state.status === 'ready' && state.offset === this.blockedOffset && !this.didBlock) {
      this.didBlock = true
      this.blocked.resolve()
      await this.release.promise
    }
    await super.write(state)
  }
}
