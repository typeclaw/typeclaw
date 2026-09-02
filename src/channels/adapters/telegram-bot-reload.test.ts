import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TelegramBotClient, TelegramBotUser, TelegramMessage } from 'agent-messenger/telegrambot'

import { createChannelManager, type ChannelManager } from '@/channels/manager'
import { defaultHistoryConfig, type ChannelsConfig } from '@/channels/schema'

import { createTelegramBotAdapter } from './telegram-bot'
import type {
  TelegramBotPollingListener,
  TelegramBotPollingListenerEventMap,
  TelegramBotPollingListenerStopOptions,
} from './telegram-bot-listener'

const BOT_USER: TelegramBotUser = { id: 999, is_bot: true, first_name: 'TypeClaw', username: 'typeclaw_bot' }

type ListenerEvent = keyof TelegramBotPollingListenerEventMap
type ListenerHandler<K extends ListenerEvent> = (...args: TelegramBotPollingListenerEventMap[K]) => void | Promise<void>

class ReloadListener implements TelegramBotPollingListener {
  readonly events: string[] = []
  readonly finishCurrentDispatchValues: boolean[] = []
  private readonly handlers = new Map<ListenerEvent, Set<ListenerHandler<ListenerEvent>>>()
  private delivery: Promise<void> | null = null
  private readonly forced = deferred<void>()
  private stopRequested = false
  private finishCurrentDispatch = false

  async start(): Promise<void> {
    await this.emit('connected', { user: BOT_USER })
  }

  async stop(options: TelegramBotPollingListenerStopOptions = {}): Promise<void> {
    this.stopRequested = true
    this.finishCurrentDispatch = options.finishCurrentDispatch === true
    this.finishCurrentDispatchValues.push(this.finishCurrentDispatch)
    this.events.push('stop-requested')
    if (this.finishCurrentDispatch) await (this.delivery ?? Promise.resolve())
    else await this.forced.promise
    this.events.push('stop-drained')
  }

  on<K extends ListenerEvent>(event: K, handler: ListenerHandler<K>): this {
    const handlers = this.handlers.get(event) ?? new Set<ListenerHandler<ListenerEvent>>()
    handlers.add(handler as ListenerHandler<ListenerEvent>)
    this.handlers.set(event, handlers)
    return this
  }

  async deliver(message: TelegramMessage): Promise<void> {
    this.delivery = (async () => {
      await this.emit('message', message)
      if (!this.stopRequested || this.finishCurrentDispatch) this.events.push('checkpoint')
    })()
    await this.delivery
  }

  forceStop(): void {
    this.forced.resolve()
  }

  private async emit<K extends ListenerEvent>(event: K, ...args: TelegramBotPollingListenerEventMap[K]): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(...args)
  }
}

class ReloadClient {
  readonly events: string[] = []
  readonly summarySent = deferred<void>()

  async login(): Promise<this> {
    return this
  }

  async getMe(): Promise<TelegramBotUser> {
    return BOT_USER
  }

  async getChat(): Promise<{ id: number; type: 'private'; first_name: string }> {
    return { id: 123, type: 'private', first_name: 'Alice' }
  }

  async getChatMemberCount(): Promise<number> {
    return 2
  }

  async sendMessage(_chatId: string | number, text: string): Promise<TelegramMessage> {
    this.events.push(`summary:${text}`)
    this.summarySent.resolve()
    return { message_id: 20, date: 0, chat: { id: 123, type: 'private' } }
  }

  async sendDocument(): Promise<TelegramMessage> {
    return { message_id: 21, date: 0, chat: { id: 123, type: 'private' } }
  }
}

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-telegram-reload-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('Telegram /reload teardown', () => {
  test('disabling the carrying adapter replies before teardown and completes without self-deadlock', async () => {
    let cfg: ChannelsConfig = { 'telegram-bot': enabledAdapterCfg() }
    const client = new ReloadClient()
    const listener = new ReloadListener()
    let manager: ChannelManager
    let runReload = async (): Promise<string> => 'not ready'
    manager = createChannelManager({
      agentDir,
      channelsConfigRef: () => cfg,
      env: { TELEGRAM_BOT_TOKEN: 'test-token' },
      onReload: () => runReload(),
      createTelegramAdapter: (options) =>
        createTelegramBotAdapter({
          ...options,
          createClient: () => client as unknown as TelegramBotClient,
          createListener: () => listener,
        }),
    })
    runReload = async () => {
      cfg = { 'telegram-bot': { ...enabledAdapterCfg(), enabled: false } }
      const diff = await manager.reload()
      return `Reloaded: ${diff.stopped.length} stopped`
    }

    await manager.start()
    const delivery = listener.deliver(reloadMessage())
    const replied = await Promise.race([client.summarySent.promise.then(() => true), Bun.sleep(100).then(() => false)])
    if (!replied) listener.forceStop()
    await delivery

    expect(replied).toBe(true)
    expect(listener.finishCurrentDispatchValues).toEqual([true])
    expect(client.events[0]).toContain('Reloaded')
    expect(listener.events.indexOf('checkpoint')).toBeGreaterThan(listener.events.indexOf('stop-requested'))
    expect(client.events).toHaveLength(1)

    await waitUntil(async () => {
      const result = await manager.router.send({
        adapter: 'telegram-bot',
        workspace: 'telegram',
        chat: '123',
        text: 'after teardown',
      })
      return !result.ok
    })
    expect(listener.events).toContain('stop-drained')
    await manager.stop()
  })
})

function enabledAdapterCfg() {
  return {
    enabled: true,
    engagement: {
      trigger: ['mention', 'reply', 'dm'] as Array<'mention' | 'reply' | 'dm'>,
      stickiness: { perReply: { window: 300_000 } },
    },
    history: defaultHistoryConfig(),
  }
}

function reloadMessage(): TelegramMessage {
  return {
    message_id: 10,
    date: 1_700_000_000,
    chat: { id: 123, type: 'private', first_name: 'Alice' },
    from: { id: 1, is_bot: false, first_name: 'Alice' },
    text: '/reload',
  }
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return
    await Bun.sleep(1)
  }
  throw new Error('condition was not met')
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
