import { describe, expect, test } from 'bun:test'

import type { DiscordGatewayMessageCreateEvent, DiscordListener } from 'agent-messenger/discord'

import type { ChannelRouter } from '@/channels/router'
import { defaultChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage, OutboundCallback } from '@/channels/types'
import type { DiscordAccountRecord } from '@/secrets/schema'

import { createDiscordAdapter, type DiscordAdapterLogger } from './discord'

const config = defaultChannelAdapterConfig()

function logger(): DiscordAdapterLogger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (msg) => lines.push(`info:${msg}`),
    warn: (msg) => lines.push(`warn:${msg}`),
    error: (msg) => lines.push(`error:${msg}`),
  }
}

function account(overrides: Partial<DiscordAccountRecord> = {}): DiscordAccountRecord {
  return {
    account_id: '100000000000000001',
    token: 'discord-token-test',
    username: 'self',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

class FakeListener {
  private handlers = new Map<string, Array<(value: unknown) => void>>()
  stopped = false
  failStart = false

  on(event: string, handler: (value: unknown) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
    return this
  }

  async start(): Promise<void> {
    if (this.failStart) throw new Error('boom')
    this.emit('connected', { user: { id: '100000000000000001', username: 'self' }, sessionId: 'session-1' })
  }

  stop(): void {
    this.stopped = true
  }

  emit(event: string, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value)
  }
}

function router(): ChannelRouter & {
  routed: InboundMessage[]
  registered: string[]
  unregistered: string[]
  outbound?: OutboundCallback
} {
  const routed: InboundMessage[] = []
  const registered: string[] = []
  const unregistered: string[] = []
  const r = {
    outbound: undefined as OutboundCallback | undefined,
    routed,
    registered,
    unregistered,
    route: async (msg: InboundMessage) => {
      routed.push(msg)
    },
    registerOutbound: (adapter: string, _workspace: string, cb: OutboundCallback) => {
      registered.push(`outbound:${adapter}`)
      r.outbound = cb
    },
    unregisterOutbound: (adapter: string) => unregistered.push(`outbound:${adapter}`),
    registerConfig: (adapter: string) => registered.push(`config:${adapter}`),
    unregisterConfig: (adapter: string) => unregistered.push(`config:${adapter}`),
    setTypingCapability: (adapter: string, _workspace: string, supported: boolean) =>
      registered.push(`typing-cap:${adapter}=${String(supported)}`),
    registerChannelNameResolver: (adapter: string) => registered.push(`names:${adapter}`),
    unregisterChannelNameResolver: (adapter: string) => unregistered.push(`names:${adapter}`),
    registerSelfIdentity: (adapter: string) => registered.push(`self:${adapter}`),
    unregisterSelfIdentity: (adapter: string) => unregistered.push(`self:${adapter}`),
    registerHistory: (adapter: string) => registered.push(`history:${adapter}`),
    unregisterHistory: (adapter: string) => unregistered.push(`history:${adapter}`),
    registerFetchAttachment: (adapter: string) => registered.push(`fetch:${adapter}`),
    unregisterFetchAttachment: (adapter: string) => unregistered.push(`fetch:${adapter}`),
    registerMembership: (adapter: string) => registered.push(`membership:${adapter}`),
    unregisterMembership: (adapter: string) => unregistered.push(`membership:${adapter}`),
    registerReaction: (adapter: string) => registered.push(`reaction:${adapter}`),
    unregisterReaction: (adapter: string) => unregistered.push(`reaction:${adapter}`),
    registerRemoveReaction: (adapter: string) => registered.push(`remove-reaction:${adapter}`),
    unregisterRemoveReaction: (adapter: string) => unregistered.push(`remove-reaction:${adapter}`),
  }
  return r as unknown as ChannelRouter & {
    routed: InboundMessage[]
    registered: string[]
    unregistered: string[]
    outbound?: OutboundCallback
  }
}

describe('createDiscordAdapter', () => {
  test('start logs in and wires listener/router callbacks with typing disabled', async () => {
    const calls: unknown[] = []
    const r = router()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient({ login: async (opts: unknown) => calls.push(opts) }),
      createListener: () => new FakeListener() as unknown as DiscordListener,
    })

    await adapter.start()

    expect(calls).toEqual([{ token: 'discord-token-test' }])
    expect(adapter.isConnected()).toBe(true)
    expect(r.registered).toEqual([
      'outbound:discord',
      'config:discord',
      'typing-cap:discord=false',
      'names:discord',
      'self:discord',
      'history:discord',
      'fetch:discord',
      'membership:discord',
      'reaction:discord',
      'remove-reaction:discord',
    ])
  })

  test('message routes through classifyInbound and stop unregisters callbacks', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      selfAliasesRef: () => ['typeclaw'],
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient(),
      createListener: () => listener as unknown as DiscordListener,
    })

    await adapter.start()
    listener.emit('message_create', {
      type: 'MESSAGE_CREATE',
      id: '400000000000000004',
      channel_id: '300000000000000003',
      guild_id: '200000000000000002',
      author: { id: '500000000000000005', username: 'alice' },
      content: 'typeclaw hi',
      timestamp: '2026-01-01T00:00:00.000Z',
    } satisfies DiscordGatewayMessageCreateEvent)
    await adapter.stop()

    expect(r.routed).toHaveLength(1)
    expect(r.routed[0]?.adapter).toBe('discord')
    expect(r.routed[0]?.isBotMention).toBe(true)
    expect(listener.stopped).toBe(true)
    expect(r.unregistered).toContain('outbound:discord')
    expect(r.unregistered).toContain('remove-reaction:discord')
  })

  test('outbound sends messages through DiscordClient.sendMessage', async () => {
    const sent: unknown[] = []
    const r = router()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient({ sendMessage: async (...args: unknown[]) => void sent.push(args) }),
      createListener: () => new FakeListener() as unknown as DiscordListener,
    })

    await adapter.start()
    const result = await r.outbound?.({
      adapter: 'discord',
      workspace: '200000000000000002',
      chat: '300000000000000003',
      text: 'hello',
    })

    expect(result).toEqual({ ok: true })
    expect(sent).toEqual([['300000000000000003', 'hello']])
  })

  test('outbound uploads attachments before posting text', async () => {
    // given an outbound with both an attachment and text
    const calls: string[] = []
    const r = router()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          uploadFile: async () => void calls.push('upload'),
          sendMessage: async () => {
            calls.push('send')
            return { id: '1', channel_id: '3', author: { id: '0', username: 'self' }, content: 'ok', timestamp: '' }
          },
        }),
      createListener: () => new FakeListener() as unknown as DiscordListener,
    })

    // when
    await adapter.start()
    const result = await r.outbound?.({
      adapter: 'discord',
      workspace: '200000000000000002',
      chat: '300000000000000003',
      text: 'hello',
      attachments: [{ path: '/tmp/a.txt' }],
    })

    // then the upload happens first so a failed upload never leaves text-only posted
    expect(result).toEqual({ ok: true })
    expect(calls).toEqual(['upload', 'send'])
  })

  test('listener start failure rolls back registrations', async () => {
    const r = router()
    const listener = new FakeListener()
    listener.failStart = true
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient(),
      createListener: () => listener as unknown as DiscordListener,
    })

    await expect(adapter.start()).rejects.toThrow('boom')

    expect(adapter.isConnected()).toBe(false)
    expect(listener.stopped).toBe(true)
    expect(r.unregistered).toContain('outbound:discord')
    expect(r.unregistered).toContain('remove-reaction:discord')
  })
})

function fakeClient(
  overrides: Record<string, unknown> = {},
): ReturnType<NonNullable<Parameters<typeof createDiscordAdapter>[0]['createClient']>> {
  return {
    login: async () => {},
    testAuth: async () => ({ id: '100000000000000001', username: 'self', global_name: 'Self' }),
    getChannel: async () => ({ id: '300000000000000003', guild_id: '200000000000000002', name: 'general', type: 0 }),
    getUser: async () => ({ id: '500000000000000005', username: 'alice', global_name: 'Alice' }),
    getMessages: async () => [],
    sendMessage: async () => ({
      id: '400000000000000004',
      channel_id: '300000000000000003',
      author: { id: '100000000000000001', username: 'self' },
      content: 'ok',
      timestamp: '2026-01-01T00:00:00.000Z',
    }),
    uploadFile: async () => ({
      id: '700000000000000007',
      filename: 'a.txt',
      size: 1,
      url: 'https://cdn.example.invalid/a.txt',
    }),
    addReaction: async () => {},
    removeReaction: async () => {},
    ...overrides,
  } as unknown as ReturnType<NonNullable<Parameters<typeof createDiscordAdapter>[0]['createClient']>>
}
