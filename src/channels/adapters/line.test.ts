import { describe, expect, test } from 'bun:test'

import type { LineChat, LineListenerEventMap, LineMessage, LineProfile, LineSendResult } from 'agent-messenger/line'

import type { ChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage, OutboundMessage } from '@/channels/types'

import {
  createLineAdapter,
  createLineHistoryCallback,
  createOutboundCallback,
  type LineClient,
  type LineListener,
} from './line'

const SILENT = { info: () => {}, warn: () => {}, error: () => {} }

function profile(): LineProfile {
  return { mid: 'U_self', display_name: 'Bot' }
}

class FakeListener implements LineListener {
  handlers: Partial<{ [K in keyof LineListenerEventMap]: (...args: LineListenerEventMap[K]) => void }> = {}
  started = false
  stopped = false
  start = async (): Promise<void> => {
    this.started = true
  }
  stop = (): void => {
    this.stopped = true
  }
  on = <K extends keyof LineListenerEventMap>(event: K, listener: (...args: LineListenerEventMap[K]) => void): this => {
    this.handlers[event] = listener as never
    return this
  }
  off = (): this => this
  emit<K extends keyof LineListenerEventMap>(event: K, ...args: LineListenerEventMap[K]): void {
    this.handlers[event]?.(...(args as never))
  }
}

function fakeClient(overrides: Partial<LineClient> = {}): LineClient {
  return {
    login: async function (this: LineClient) {
      return this
    },
    getProfile: async () => profile(),
    getChats: async () => [{ chat_id: 'C1', type: 'user', display_name: 'Alice' } satisfies LineChat],
    getMessages: async () => [],
    sendMessage: async (chat_id): Promise<LineSendResult> => ({
      success: true,
      chat_id,
      message_id: 'M_sent',
      sent_at: '2025-01-01T00:00:00.000Z',
    }),
    close: () => {},
    ...overrides,
  }
}

describe('createOutboundCallback', () => {
  const tag = async (): Promise<string> => 'tag'

  test('sends markdown-stripped plain text via sendMessage', async () => {
    const sent: Array<{ chat: string; text: string }> = []
    const cb = createOutboundCallback({
      client: {
        sendMessage: async (chat, text) => {
          sent.push({ chat, text })
          return { success: true, chat_id: chat, message_id: 'M', sent_at: '' }
        },
      },
      logger: SILENT,
      formatChannelTag: tag,
    })
    const res = await cb({ adapter: 'line', workspace: '@line-dm', chat: 'C1', text: '**hi**' } as OutboundMessage)
    expect(res).toEqual({ ok: true })
    expect(sent).toEqual([{ chat: 'C1', text: 'hi' }])
  })

  test('rejects an outbound carrying attachments', async () => {
    const cb = createOutboundCallback({
      client: { sendMessage: async () => ({ success: true, chat_id: 'C1', message_id: 'M', sent_at: '' }) },
      logger: SILENT,
      formatChannelTag: tag,
    })
    const res = await cb({
      adapter: 'line',
      workspace: '@line-dm',
      chat: 'C1',
      text: 'hi',
      attachments: [{ path: '/tmp/x.png' }],
    } as OutboundMessage)
    expect(res.ok).toBe(false)
  })

  test('rejects an empty message', async () => {
    const cb = createOutboundCallback({
      client: { sendMessage: async () => ({ success: true, chat_id: 'C1', message_id: 'M', sent_at: '' }) },
      logger: SILENT,
      formatChannelTag: tag,
    })
    const res = await cb({ adapter: 'line', workspace: '@line-dm', chat: 'C1', text: '' } as OutboundMessage)
    expect(res.ok).toBe(false)
  })

  test('rejects a message for a different adapter', async () => {
    const cb = createOutboundCallback({
      client: { sendMessage: async () => ({ success: true, chat_id: 'C1', message_id: 'M', sent_at: '' }) },
      logger: SILENT,
      formatChannelTag: tag,
    })
    const res = await cb({ adapter: 'slack-bot', workspace: 'w', chat: 'C1', text: 'hi' } as OutboundMessage)
    expect(res.ok).toBe(false)
  })
})

describe('createLineHistoryCallback', () => {
  test('maps messages and flags the bot author', async () => {
    const messages: LineMessage[] = [
      {
        message_id: 'M1',
        chat_id: 'C1',
        author_id: 'U_self',
        author_name: 'Bot',
        text: 'mine',
        content_type: 'text',
        sent_at: '2025-01-02T00:00:00.000Z',
      },
      {
        message_id: 'M2',
        chat_id: 'C1',
        author_id: 'U_other',
        text: 'theirs',
        content_type: 'text',
        sent_at: '2025-01-02T00:01:00.000Z',
      },
    ]
    const cb = createLineHistoryCallback({
      client: { getMessages: async () => messages },
      logger: SILENT,
      selfUserIdRef: () => 'U_self',
    })
    const result = await cb({ chat: 'C1', thread: null, limit: 50 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.messages[0]!.isBot).toBe(true)
    expect(result.messages[1]!.isBot).toBe(false)
    expect(result.messages[1]!.authorName).toBe('U_other')
    expect(result.messages[0]!.ts).toBe(Date.parse('2025-01-02T00:00:00.000Z'))
  })
})

describe('createLineAdapter lifecycle', () => {
  test('authenticates, registers callbacks, and routes an inbound', async () => {
    const listener = new FakeListener()
    const routed: InboundMessage[] = []
    const router = makeRouterStub((m) => routed.push(m))

    const adapter = createLineAdapter({
      router,
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient(),
      listenerFactory: () => listener,
      credentialsStore: {
        load: async () => ({ current_account: 'U_self', accounts: {} }),
        getAccount: async () => ({
          account_id: 'U_self',
          auth_token: 't',
          device: 'DESKTOPMAC',
          created_at: '',
          updated_at: '',
        }),
      },
    })

    await adapter.start()
    expect(adapter.isConnected()).toBe(false)
    listener.emit('connected', { account_id: 'U_self' })
    expect(adapter.isConnected()).toBe(true)
    expect(router.registered.outbound).toBe(true)
    expect(router.registered.history).toBe(true)
    expect(router.registered.nameResolver).toBe(true)

    const message = {
      type: 'message' as const,
      chat_id: 'C1',
      message_id: 'M1',
      author_id: 'U_other',
      text: 'hello bot',
      content_type: 'text',
      content_metadata: {},
      sent_at: '2025-01-02T00:00:00.000Z',
    }
    listener.emit('message', message)
    await waitFor(() => routed.length > 0)
    expect(routed[0]!.text).toBe('hello bot')
    expect(routed[0]!.workspace).toBe('@line-dm')

    await adapter.stop()
    expect(listener.stopped).toBe(true)
    expect(router.registered.outbound).toBe(false)
  })

  test('routes an undecryptable inbound with a placeholder and logs it instead of dropping as empty', async () => {
    const listener = new FakeListener()
    const routed: InboundMessage[] = []
    const warnings: string[] = []
    const router = makeRouterStub((m) => routed.push(m))

    const adapter = createLineAdapter({
      router,
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
      client: fakeClient(),
      listenerFactory: () => listener,
      credentialsStore: {
        load: async () => ({ current_account: 'U_self', accounts: {} }),
        getAccount: async () => ({
          account_id: 'U_self',
          auth_token: 't',
          device: 'DESKTOPMAC',
          created_at: '',
          updated_at: '',
        }),
      },
    })

    await adapter.start()
    listener.emit('connected', { account_id: 'U_self' })

    listener.emit('message', {
      type: 'message' as const,
      chat_id: 'C1',
      message_id: 'M_enc',
      author_id: 'U_other',
      text: null,
      content_type: 'NONE',
      content_metadata: {},
      decryption_error: { code: 'missing_e2ee_key', message: 'no key' },
      sent_at: '2025-01-02T00:00:00.000Z',
    })
    await waitFor(() => routed.length > 0)

    expect(routed[0]!.text).toBe('[LINE message could not be decrypted: missing E2EE key]')
    expect(warnings.some((w) => w.includes('undecryptable') && w.includes('missing_e2ee_key'))).toBe(true)

    await adapter.stop()
  })

  test('wires the credentials store as the client credential manager so listener re-login resolves it', async () => {
    // given a store-backed client whose no-arg login() (the LineListener reconnect
    // path) resolves credentials only through its injected credential manager
    const store = {
      load: async () => ({ current_account: 'U_self', accounts: {} }),
      getAccount: async () => ({
        account_id: 'U_self',
        auth_token: 't',
        device: 'DESKTOPMAC' as const,
        created_at: '',
        updated_at: '',
      }),
    }
    let factoryCredManager: unknown
    const buildStoreBackedClient = (credManager?: unknown): LineClient => {
      factoryCredManager = credManager
      return fakeClient({
        login: async function (this: LineClient, credentials) {
          if (credentials === undefined) {
            const account = await (credManager as typeof store | undefined)?.getAccount()
            if (!account) throw new Error('No account found. Call loginWithQR() or loginWithEmail() first.')
          }
          return this
        },
      })
    }

    const adapter = createLineAdapter({
      router: makeRouterStub(() => {}),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      clientFactory: buildStoreBackedClient as never,
      listenerFactory: () => new FakeListener(),
      credentialsStore: store,
    })

    // when the adapter starts (no explicit client injected)
    await adapter.start()

    // then the factory received the credentials store as the credential manager,
    // so an argument-less re-login resolves the account instead of throwing
    expect(factoryCredManager).toBe(store)
    const reLoginClient = buildStoreBackedClient(factoryCredManager)
    await expect(reLoginClient.login()).resolves.toBeDefined()
  })

  test('start throws when no account is stored', async () => {
    const adapter = createLineAdapter({
      router: makeRouterStub(() => {}),
      configRef: () => ({}) as ChannelAdapterConfig,
      logger: SILENT,
      client: fakeClient(),
      listenerFactory: () => new FakeListener(),
      credentialsStore: { load: async () => ({ current_account: null, accounts: {} }), getAccount: async () => null },
    })
    await expect(adapter.start()).rejects.toThrow(/no LINE account/)
  })
})

function makeRouterStub(onRoute: (m: InboundMessage) => void) {
  const registered = { outbound: false, history: false, nameResolver: false }
  return {
    registered,
    route: async (m: InboundMessage) => onRoute(m),
    registerOutbound: () => {
      registered.outbound = true
    },
    unregisterOutbound: () => {
      registered.outbound = false
    },
    registerHistory: () => {
      registered.history = true
    },
    unregisterHistory: () => {
      registered.history = false
    },
    registerChannelNameResolver: () => {
      registered.nameResolver = true
    },
    unregisterChannelNameResolver: () => {
      registered.nameResolver = false
    },
  } as unknown as Parameters<typeof createLineAdapter>[0]['router'] & {
    registered: { outbound: boolean; history: boolean; nameResolver: boolean }
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}
