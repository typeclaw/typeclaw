import { describe, expect, test } from 'bun:test'

import type { SlackListener, SlackRTMMessageEvent } from 'agent-messenger/slack'

import type { ChannelRouter } from '@/channels/router'
import { defaultChannelAdapterConfig } from '@/channels/schema'
import type { InboundMessage, OutboundCallback } from '@/channels/types'
import type { SlackAccountRecord } from '@/secrets/schema'

import { createSlackAdapter, type SlackAdapterLogger } from './slack'

const config = defaultChannelAdapterConfig()

function logger(): SlackAdapterLogger & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (msg) => lines.push(`info:${msg}`),
    warn: (msg) => lines.push(`warn:${msg}`),
    error: (msg) => lines.push(`error:${msg}`),
  }
}

function account(overrides: Partial<SlackAccountRecord> = {}): SlackAccountRecord {
  return {
    account_id: 'T0123456789',
    token: 'xoxc-test',
    cookie: 'xoxd-test',
    workspace_id: 'T0123456789',
    workspace_name: 'Acme',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

class FakeListener {
  private handlers = new Map<string, Array<(value: unknown) => void>>()
  stopped = false
  failStart = false

  on(event: string, handler: (value: unknown) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
  }

  async start(): Promise<void> {
    if (this.failStart) throw new Error('boom')
    this.emit('connected', { self: { id: 'USELF' }, team: { id: 'T0123456789' } })
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

describe('createSlackAdapter', () => {
  test('start logs in and wires listener/router callbacks with typing disabled', async () => {
    const calls: unknown[] = []
    const r = router()
    const adapter = createSlackAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        ({
          login: async (opts: unknown) => calls.push(opts),
          testAuth: async () => ({ user_id: 'USELF', team_id: 'T0123456789', user: 'alice', team: 'Acme' }),
          getChannel: async () => ({ id: 'C0123456789', name: 'general' }),
          getUser: async () => ({ id: 'UUSER', name: 'alice', real_name: 'Alice' }),
          getMessages: async () => [],
          listChannelMembers: async () => [],
          sendMessage: async () => ({ ts: '1', text: 'ok', type: 'message' }),
          uploadFile: async () => ({
            id: 'F1',
            name: 'a.txt',
            title: 'a.txt',
            mimetype: 'text/plain',
            size: 1,
            url_private: '',
            created: 1,
            user: 'USELF',
          }),
          downloadFile: async () => ({
            buffer: Buffer.from('x'),
            file: {
              id: 'F1',
              name: 'a.txt',
              title: 'a.txt',
              mimetype: 'text/plain',
              size: 1,
              url_private: '',
              created: 1,
              user: 'USELF',
            },
          }),
          addReaction: async () => {},
          removeReaction: async () => {},
        }) as unknown as ReturnType<NonNullable<Parameters<typeof createSlackAdapter>[0]['createClient']>>,
      createListener: () => new FakeListener() as unknown as SlackListener,
    })

    await adapter.start()

    expect(calls).toEqual([{ token: 'xoxc-test', cookie: 'xoxd-test' }])
    expect(adapter.isConnected()).toBe(true)
    expect(r.registered).toEqual([
      'outbound:slack',
      'config:slack',
      'typing-cap:slack=false',
      'names:slack',
      'self:slack',
      'history:slack',
      'fetch:slack',
      'membership:slack',
      'reaction:slack',
      'remove-reaction:slack',
    ])
  })

  test('message routes through classifyInbound and stop unregisters callbacks', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = createSlackAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      selfAliasesRef: () => ['typeclaw'],
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient(),
      createListener: () => listener as unknown as SlackListener,
    })

    await adapter.start()
    listener.emit('message', {
      type: 'message',
      channel: 'C0123456789',
      user: 'UUSER',
      text: 'typeclaw hi',
      ts: '1770000000.000100',
    } satisfies SlackRTMMessageEvent)
    await adapter.stop()

    expect(r.routed).toHaveLength(1)
    expect(r.routed[0]?.adapter).toBe('slack')
    expect(r.routed[0]?.isBotMention).toBe(false)
    expect(listener.stopped).toBe(true)
    expect(r.unregistered).toContain('outbound:slack')
    expect(r.unregistered).toContain('remove-reaction:slack')
  })

  test('outbound sends messages through SlackClient.sendMessage', async () => {
    const sent: unknown[] = []
    const r = router()
    const adapter = createSlackAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient({ sendMessage: async (...args: unknown[]) => void sent.push(args) }),
      createListener: () => new FakeListener() as unknown as SlackListener,
    })

    await adapter.start()
    const result = await r.outbound?.({
      adapter: 'slack',
      workspace: 'T0123456789',
      chat: 'C0123456789',
      text: 'hello',
    })

    expect(result).toEqual({ ok: true })
    expect(sent).toEqual([['C0123456789', 'hello', undefined]])
  })

  test('listener start failure rolls back registrations', async () => {
    const r = router()
    const listener = new FakeListener()
    listener.failStart = true
    const adapter = createSlackAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient(),
      createListener: () => listener as unknown as SlackListener,
    })

    await expect(adapter.start()).rejects.toThrow('boom')

    expect(adapter.isConnected()).toBe(false)
    expect(listener.stopped).toBe(true)
    expect(r.unregistered).toContain('outbound:slack')
    expect(r.unregistered).toContain('remove-reaction:slack')
  })
})

function fakeClient(
  overrides: Record<string, unknown> = {},
): ReturnType<NonNullable<Parameters<typeof createSlackAdapter>[0]['createClient']>> {
  return {
    login: async () => {},
    testAuth: async () => ({ user_id: 'USELF', team_id: 'T0123456789', user: 'self', team: 'Acme' }),
    getChannel: async () => ({ id: 'C0123456789', name: 'general' }),
    getUser: async () => ({ id: 'UUSER', name: 'alice', real_name: 'Alice' }),
    getMessages: async () => [],
    listChannelMembers: async () => [],
    sendMessage: async () => ({ ts: '1', text: 'ok', type: 'message' }),
    uploadFile: async () => ({
      id: 'F1',
      name: 'a.txt',
      title: 'a.txt',
      mimetype: 'text/plain',
      size: 1,
      url_private: '',
      created: 1,
      user: 'USELF',
    }),
    downloadFile: async () => ({
      buffer: Buffer.from('x'),
      file: {
        id: 'F1',
        name: 'a.txt',
        title: 'a.txt',
        mimetype: 'text/plain',
        size: 1,
        url_private: '',
        created: 1,
        user: 'USELF',
      },
    }),
    addReaction: async () => {},
    removeReaction: async () => {},
    ...overrides,
  } as unknown as ReturnType<NonNullable<Parameters<typeof createSlackAdapter>[0]['createClient']>>
}
