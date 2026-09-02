import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DiscordGatewayMessageCreateEvent, DiscordListener } from 'agent-messenger/discord'

import type { ChannelRouter } from '@/channels/router'
import { channelsSchema } from '@/channels/schema'
import type { InboundMessage, OutboundCallback } from '@/channels/types'
import type { DiscordAccountRecord } from '@/secrets/schema'

import { createDiscordAdapter, createDiscordHistoryCallback, type DiscordAdapterLogger } from './discord'
import { createInMemoryDiscordRecoveryStore, loadDiscordRecoveryStore } from './discord-recovery'

const config = channelsSchema.parse({ discord: {} }).discord!

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

function router(routeHook?: (message: InboundMessage) => Promise<void>): ChannelRouter & {
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
      await routeHook?.(msg)
      routed.push(msg)
    },
    registerOutbound: (adapter: string, cb: OutboundCallback) => {
      registered.push(`outbound:${adapter}`)
      r.outbound = cb
    },
    unregisterOutbound: (adapter: string) => unregistered.push(`outbound:${adapter}`),
    setTypingCapability: (adapter: string, supported: boolean) =>
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
    registerEditMessage: (adapter: string) => registered.push(`edit:${adapter}`),
    unregisterEditMessage: (adapter: string) => unregistered.push(`edit:${adapter}`),
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
      'typing-cap:discord=false',
      'names:discord',
      'self:discord',
      'history:discord',
      'fetch:discord',
      'membership:discord',
      'reaction:discord',
      'remove-reaction:discord',
      'edit:discord',
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

  test('does not replay on initial connect or duplicate normal live delivery', async () => {
    const r = router()
    const listener = new FakeListener()
    const historyCalls: unknown[][] = []
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          getMessages: async (...args: unknown[]) => {
            historyCalls.push(args)
            return []
          },
        }),
      createListener: () => listener as unknown as DiscordListener,
    })

    await adapter.start()
    listener.emit('message_create', gatewayMessage('400000000000000010', 'normal'))
    listener.emit('message_create', gatewayMessage('400000000000000010', 'normal'))
    await adapter.stop()

    expect(r.routed.map((message) => message.externalMessageId)).toEqual(['400000000000000010'])
    expect(historyCalls).toEqual([])
  })

  test('replays a reconnect gap oldest-first before overlapping live delivery', async () => {
    const r = router()
    const listener = new FakeListener()
    let history = [
      restMessage('400000000000000003', 'third'),
      restMessage('400000000000000002', 'second'),
      restMessage('400000000000000001', 'first'),
    ]
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient({ getMessages: async () => history }),
      createListener: () => listener as unknown as DiscordListener,
      now: () => Date.parse('2026-01-01T00:05:00.000Z'),
    })

    await adapter.start()
    listener.emit('message_create', gatewayMessage('400000000000000001', 'first'))
    await Bun.sleep(0)
    listener.emit('disconnected', undefined)
    history = [restMessage('400000000000000003', 'third'), restMessage('400000000000000002', 'second')]
    listener.emit('connected', connectedInfo())
    listener.emit('message_create', gatewayMessage('400000000000000003', 'third'))
    await Bun.sleep(10)
    await adapter.stop()

    expect(r.routed.map((message) => message.externalMessageId)).toEqual([
      '400000000000000001',
      '400000000000000002',
      '400000000000000003',
    ])
  })

  test('replays before a gap-time gateway event and deduplicates their overlap', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          getMessages: async () => [
            restMessage('400000000000000003', 'third'),
            restMessage('400000000000000002', 'second'),
          ],
        }),
      createListener: () => listener as unknown as DiscordListener,
      now: () => Date.parse('2026-01-01T00:05:00.000Z'),
    })

    await adapter.start()
    listener.emit('message_create', gatewayMessage('400000000000000001', 'first'))
    await waitFor(() => r.routed.length === 1)
    listener.emit('disconnected', undefined)
    listener.emit('message_create', gatewayMessage('400000000000000003', 'third'))
    listener.emit('connected', connectedInfo())
    await waitFor(() => r.routed.length === 3)
    await adapter.stop()

    expect(r.routed.map((message) => message.externalMessageId)).toEqual([
      '400000000000000001',
      '400000000000000002',
      '400000000000000003',
    ])
  })

  test('retains an unavailable replay anchor for the next reconnect', async () => {
    const recoveryStore = createInMemoryDiscordRecoveryStore()
    await recoveryStore.markProcessed({
      channelId: '300000000000000003',
      workspace: '200000000000000002',
      messageId: '400000000000000001',
      processedAt: 1,
    })
    await recoveryStore.markDisconnected(2)
    let attempts = 0
    const r = router()
    const listener = new FakeListener()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          getMessages: async () => {
            attempts++
            if (attempts === 1) throw new Error('temporary failure')
            return [restMessage('400000000000000002', 'missed')]
          },
        }),
      createListener: () => listener as unknown as DiscordListener,
      recoveryStore,
      now: () => Date.parse('2026-01-01T00:05:00.000Z'),
    })

    await adapter.start()
    await Bun.sleep(10)
    expect(attempts).toBe(1)
    expect(recoveryStore.listReplayCursors()).toHaveLength(1)
    listener.emit('disconnected', undefined)
    listener.emit('connected', connectedInfo())
    await Bun.sleep(10)

    expect(attempts).toBe(2)
    expect(r.routed.map((message) => message.externalMessageId)).toEqual(['400000000000000002'])
    expect(recoveryStore.listReplayCursors()).toEqual([])
    await adapter.stop()
  })

  test('replays a durable pending gap on the recreated adapter first connection', async () => {
    const recoveryStore = createInMemoryDiscordRecoveryStore()
    await recoveryStore.markProcessed({
      channelId: '300000000000000003',
      workspace: '200000000000000002',
      messageId: '400000000000000001',
      processedAt: 1,
    })
    await recoveryStore.markDisconnected(2)
    const r = router()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({ getMessages: async () => [restMessage('400000000000000002', 'missed while stopped')] }),
      createListener: () => new FakeListener() as unknown as DiscordListener,
      recoveryStore,
      now: () => Date.parse('2026-01-01T00:05:00.000Z'),
    })

    await adapter.start()
    await Bun.sleep(10)

    expect(r.routed.map((message) => message.externalMessageId)).toEqual(['400000000000000002'])
    expect(recoveryStore.listReplayCursors()).toEqual([])
    await adapter.stop()
  })

  test('orders a pre-connected live event behind persisted startup replay', async () => {
    const recoveryStore = createInMemoryDiscordRecoveryStore()
    await recoveryStore.markProcessed({
      channelId: '300000000000000003',
      workspace: '200000000000000002',
      messageId: '400000000000000001',
      processedAt: 1,
    })
    await recoveryStore.markDisconnected(2)
    const r = router()
    const listener = new FakeListener()
    listener.start = async () => {
      listener.emit('message_create', gatewayMessage('400000000000000003', 'pre-connected live'))
      listener.emit('connected', connectedInfo())
    }
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          getMessages: async () => [
            restMessage('400000000000000003', 'third'),
            restMessage('400000000000000002', 'second'),
          ],
        }),
      createListener: () => listener as unknown as DiscordListener,
      recoveryStore,
      now: () => Date.parse('2026-01-01T00:05:00.000Z'),
    })

    await adapter.start()
    await waitFor(() => r.routed.length === 2)
    await adapter.stop()

    expect(r.routed.map((message) => message.externalMessageId)).toEqual(['400000000000000002', '400000000000000003'])
  })

  test('a dropped first event establishes recovery coverage for a later gap mention', async () => {
    const recoveryStore = createInMemoryDiscordRecoveryStore()
    const r = router()
    const listener = new FakeListener()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({ getMessages: async () => [restMessage('400000000000000002', '<@100000000000000001> gap')] }),
      createListener: () => listener as unknown as DiscordListener,
      recoveryStore,
      now: () => Date.parse('2026-01-01T00:05:00.000Z'),
    })

    await adapter.start()
    listener.emit('message_create', {
      ...gatewayMessage('400000000000000001', 'self-authored'),
      author: { id: '100000000000000001', username: 'self' },
    })
    await waitFor(() => recoveryStore.listCursors()[0]?.messageId === '400000000000000001')
    expect(r.routed).toEqual([])
    listener.emit('disconnected', undefined)
    listener.emit('connected', connectedInfo())
    await waitFor(() => r.routed.length === 1)
    await adapter.stop()

    expect(r.routed[0]?.externalMessageId).toBe('400000000000000002')
  })

  test('disconnect timeout anchors pending inbound before reconnect replay', async () => {
    const routeStarted = deferred<void>()
    const releaseRoute = deferred<void>()
    const historyRequested = deferred<void>()
    const r = router(async (message) => {
      if (message.externalMessageId !== '400000000000000001') return
      routeStarted.resolve(undefined)
      await releaseRoute.promise
    })
    const listener = new FakeListener()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          getMessages: async () => {
            historyRequested.resolve(undefined)
            return [restMessage('400000000000000002', 'outage'), restMessage('400000000000000001', 'pending')]
          },
        }),
      createListener: () => listener as unknown as DiscordListener,
      disconnectDrainTimeoutMs: 5,
      now: () => Date.parse('2026-01-01T00:05:00.000Z'),
    })

    await adapter.start()
    listener.emit('message_create', gatewayMessage('400000000000000001', 'pending'))
    await routeStarted.promise
    listener.emit('disconnected', undefined)
    listener.emit('connected', connectedInfo())
    await historyRequested.promise
    releaseRoute.resolve(undefined)
    await waitFor(() => r.routed.length === 2)
    await adapter.stop()

    expect(r.routed.map((message) => message.externalMessageId)).toEqual(['400000000000000001', '400000000000000002'])
  })

  test('bounds each reconnect pass by channels and aggregate messages while retaining deferred anchors', async () => {
    const recoveryStore = createInMemoryDiscordRecoveryStore()
    for (let channel = 1; channel <= 21; channel++) {
      await recoveryStore.markProcessed({
        channelId: String(300000000000000000n + BigInt(channel)),
        workspace: '200000000000000002',
        messageId: '400000000000000000',
        processedAt: channel,
      })
    }
    const requestedChannels: string[] = []
    const r = router()
    const listener = new FakeListener()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          getChannel: async (channelId: string) => ({
            id: channelId,
            guild_id: '200000000000000002',
            name: channelId,
            type: 0,
          }),
          getMessages: async (channelId: string) => {
            requestedChannels.push(channelId)
            return Array.from({ length: 40 }, (_, index) => ({
              ...restMessage(String(400000000000000001n + BigInt(index)), `missed-${index}`),
              channel_id: channelId,
            }))
          },
        }),
      createListener: () => listener as unknown as DiscordListener,
      recoveryStore,
      now: () => Date.parse('2026-01-01T00:05:00.000Z'),
    })

    await adapter.start()
    expect(requestedChannels).toEqual([])
    listener.emit('disconnected', undefined)
    listener.emit('connected', connectedInfo())
    await Bun.sleep(30)

    expect(requestedChannels).toHaveLength(3)
    expect(r.routed).toHaveLength(100)
    expect(recoveryStore.listReplayCursors()).toHaveLength(19)
    expect(
      r.routed.filter((message) => message.chat === requestedChannels[2]).map((message) => message.externalMessageId),
    ).toEqual(Array.from({ length: 20 }, (_, index) => String(400000000000000001n + BigInt(index))))
    await adapter.stop()
  })

  test('stops a duration-bounded replay without allowing queued delivery after stop', async () => {
    const recoveryStore = createInMemoryDiscordRecoveryStore()
    await recoveryStore.markProcessed({
      channelId: '300000000000000003',
      workspace: '200000000000000002',
      messageId: '400000000000000001',
      processedAt: 1,
    })
    await recoveryStore.markDisconnected(2)
    const r = router()
    const listener = new FakeListener()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          getChannel: async () => await new Promise<never>(() => undefined),
        }),
      createListener: () => listener as unknown as DiscordListener,
      recoveryStore,
      recoveryMaxDurationMs: 5,
    })

    await adapter.start()
    listener.emit('disconnected', undefined)
    listener.emit('connected', connectedInfo())
    await adapter.stop()
    listener.emit('message_create', gatewayMessage('400000000000000002', 'late'))
    await Bun.sleep(10)

    expect(r.routed).toEqual([])
    expect(recoveryStore.listReplayCursors()).toHaveLength(1)
  })

  test('drains a live inbound accepted before stop while it waits behind recovery', async () => {
    const recoveryStore = createInMemoryDiscordRecoveryStore()
    await recoveryStore.markProcessed({
      channelId: '300000000000000003',
      workspace: '200000000000000002',
      messageId: '400000000000000001',
      processedAt: 1,
    })
    await recoveryStore.markDisconnected(2)
    const channelLookup = deferred<{
      id: string
      guild_id: string
      name: string
      type: number
    }>()
    const lookupStarted = deferred<void>()
    const r = router()
    const listener = new FakeListener()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          getChannel: async () => {
            lookupStarted.resolve(undefined)
            return await channelLookup.promise
          },
          getMessages: async () => [],
        }),
      createListener: () => listener as unknown as DiscordListener,
      recoveryStore,
    })

    await adapter.start()
    await lookupStarted.promise
    listener.emit('message_create', gatewayMessage('400000000000000002', 'queued'))
    const stopping = adapter.stop()
    channelLookup.resolve({
      id: '300000000000000003',
      guild_id: '200000000000000002',
      name: 'general',
      type: 0,
    })
    await stopping

    expect(r.routed.map((message) => message.externalMessageId)).toEqual(['400000000000000002'])
  })

  test('graceful stop drains accepted inbound and leaves a durable restart replay anchor', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-discord-graceful-restart-'))
    try {
      const routeStarted = deferred<void>()
      const releaseRoute = deferred<void>()
      const firstRouter = router(async (message) => {
        if (message.externalMessageId !== '400000000000000001') return
        routeStarted.resolve(undefined)
        await releaseRoute.promise
      })
      const firstListener = new FakeListener()
      const first = createDiscordAdapter({
        agentDir,
        router: firstRouter,
        configRef: () => config,
        logger: logger(),
        credentialsStore: { getAccount: async () => account() },
        createClient: () => fakeClient(),
        createListener: () => firstListener as unknown as DiscordListener,
        enrichHistoricalProvenance: async () => ({
          scanned: 0,
          attempted: 0,
          resolved: 0,
          failed: 0,
          timedOut: 0,
          changed: false,
        }),
        now: () => Date.parse('2026-01-01T00:05:00.000Z'),
      })
      await first.start()
      firstListener.emit('message_create', gatewayMessage('400000000000000001', 'accepted'))
      await routeStarted.promise
      const stopping = first.stop()
      releaseRoute.resolve(undefined)
      await stopping

      expect(firstRouter.routed.map((message) => message.externalMessageId)).toEqual(['400000000000000001'])
      const secondRouter = router()
      const second = createDiscordAdapter({
        agentDir,
        router: secondRouter,
        configRef: () => config,
        logger: logger(),
        credentialsStore: { getAccount: async () => account() },
        createClient: () =>
          fakeClient({ getMessages: async () => [restMessage('400000000000000002', 'restart downtime')] }),
        createListener: () => new FakeListener() as unknown as DiscordListener,
        enrichHistoricalProvenance: async () => ({
          scanned: 0,
          attempted: 0,
          resolved: 0,
          failed: 0,
          timedOut: 0,
          changed: false,
        }),
        now: () => Date.parse('2026-01-01T00:06:00.000Z'),
      })
      await second.start()
      await waitFor(() => secondRouter.routed.length === 1)
      await second.stop()

      expect(secondRouter.routed.map((message) => message.externalMessageId)).toEqual(['400000000000000002'])
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('stop immediately after listener disconnect still preserves the durable replay snapshot', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-discord-disconnect-stop-'))
    try {
      const firstRouter = router()
      const firstListener = new FakeListener()
      const first = createDiscordAdapter({
        agentDir,
        router: firstRouter,
        configRef: () => config,
        logger: logger(),
        credentialsStore: { getAccount: async () => account() },
        createClient: () => fakeClient(),
        createListener: () => firstListener as unknown as DiscordListener,
        enrichHistoricalProvenance: async () => ({
          scanned: 0,
          attempted: 0,
          resolved: 0,
          failed: 0,
          timedOut: 0,
          changed: false,
        }),
      })
      await first.start()
      firstListener.emit('message_create', gatewayMessage('400000000000000001', 'before disconnect'))
      await waitFor(() => firstRouter.routed.length === 1)
      firstListener.emit('disconnected', undefined)
      await first.stop()

      const secondRouter = router()
      const second = createDiscordAdapter({
        agentDir,
        router: secondRouter,
        configRef: () => config,
        logger: logger(),
        credentialsStore: { getAccount: async () => account() },
        createClient: () => fakeClient({ getMessages: async () => [restMessage('400000000000000002', 'gap')] }),
        createListener: () => new FakeListener() as unknown as DiscordListener,
        enrichHistoricalProvenance: async () => ({
          scanned: 0,
          attempted: 0,
          resolved: 0,
          failed: 0,
          timedOut: 0,
          changed: false,
        }),
        now: () => Date.parse('2026-01-01T00:06:00.000Z'),
      })
      await second.start()
      await waitFor(() => secondRouter.routed.length === 1)
      await second.stop()

      expect(secondRouter.routed[0]?.externalMessageId).toBe('400000000000000002')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('replays an earlier route failure after a newer live message succeeds', async () => {
    let failMessage102 = true
    const r = router(async (message) => {
      if (message.externalMessageId === '400000000000000002' && failMessage102) {
        failMessage102 = false
        throw new Error('route failed')
      }
    })
    const listener = new FakeListener()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          getMessages: async () => [
            restMessage('400000000000000003', 'newer success'),
            restMessage('400000000000000002', 'failed earlier'),
          ],
        }),
      createListener: () => listener as unknown as DiscordListener,
      now: () => Date.parse('2026-01-01T00:05:00.000Z'),
    })

    await adapter.start()
    listener.emit('message_create', gatewayMessage('400000000000000001', 'first'))
    listener.emit('message_create', gatewayMessage('400000000000000002', 'fails'))
    listener.emit('message_create', gatewayMessage('400000000000000003', 'succeeds'))
    await waitFor(() => r.routed.length === 2)
    listener.emit('disconnected', undefined)
    listener.emit('connected', connectedInfo())
    await waitFor(() => r.routed.length === 3)
    await adapter.stop()

    expect(r.routed.map((message) => message.externalMessageId)).toEqual([
      '400000000000000001',
      '400000000000000003',
      '400000000000000002',
    ])
  })

  test('resolves initial and reconnect waits after disconnect before first ready', async () => {
    const recoveryStore = createInMemoryDiscordRecoveryStore()
    await recoveryStore.markProcessed({
      channelId: '300000000000000003',
      workspace: '200000000000000002',
      messageId: '400000000000000001',
      processedAt: 1,
    })
    await recoveryStore.markDisconnected(2)
    const r = router()
    const listener = new FakeListener()
    listener.start = async () => {
      listener.emit('disconnected', undefined)
      listener.emit('connected', connectedInfo())
    }
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient({ getMessages: async () => [restMessage('400000000000000002', 'replayed')] }),
      createListener: () => listener as unknown as DiscordListener,
      recoveryStore,
      now: () => Date.parse('2026-01-01T00:05:00.000Z'),
    })

    await adapter.start()
    await waitFor(() => r.routed.length === 1)
    listener.emit('message_create', gatewayMessage('400000000000000003', 'later'))
    await waitFor(() => r.routed.length === 2)
    await adapter.stop()

    expect(r.routed.map((message) => message.externalMessageId)).toEqual(['400000000000000002', '400000000000000003'])
  })

  test('replays a failed first channel message while deduplicating a newer exact success', async () => {
    let failFirst = true
    const r = router(async (message) => {
      if (message.externalMessageId === '400000000000000001' && failFirst) {
        failFirst = false
        throw new Error('first route failed')
      }
    })
    const listener = new FakeListener()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          getMessages: async () => [
            restMessage('400000000000000002', 'newer success'),
            restMessage('400000000000000001', 'failed first'),
          ],
        }),
      createListener: () => listener as unknown as DiscordListener,
      now: () => Date.parse('2026-01-01T00:05:00.000Z'),
    })

    await adapter.start()
    listener.emit('message_create', gatewayMessage('400000000000000001', 'fails'))
    listener.emit('message_create', gatewayMessage('400000000000000002', 'succeeds'))
    await waitFor(() => r.routed.length === 1)
    listener.emit('disconnected', undefined)
    listener.emit('connected', connectedInfo())
    await waitFor(() => r.routed.length === 2)
    await adapter.stop()

    expect(r.routed.map((message) => message.externalMessageId)).toEqual(['400000000000000002', '400000000000000001'])
  })

  test('recreates and replays when the first channel message fails immediately before stop', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-discord-first-failure-'))
    try {
      const firstListener = new FakeListener()
      const first = createDiscordAdapter({
        agentDir,
        router: router(async () => {
          throw new Error('first route failed')
        }),
        configRef: () => config,
        logger: logger(),
        credentialsStore: { getAccount: async () => account() },
        createClient: () => fakeClient(),
        createListener: () => firstListener as unknown as DiscordListener,
        enrichHistoricalProvenance: async () => ({
          scanned: 0,
          attempted: 0,
          resolved: 0,
          failed: 0,
          timedOut: 0,
          changed: false,
        }),
        now: () => Date.parse('2026-01-01T00:05:00.000Z'),
      })
      await first.start()
      firstListener.emit('message_create', gatewayMessage('400000000000000001', 'fails'))
      await first.stop()

      const secondRouter = router()
      const second = createDiscordAdapter({
        agentDir,
        router: secondRouter,
        configRef: () => config,
        logger: logger(),
        credentialsStore: { getAccount: async () => account() },
        createClient: () => fakeClient({ getMessages: async () => [restMessage('400000000000000001', 'retry')] }),
        createListener: () => new FakeListener() as unknown as DiscordListener,
        enrichHistoricalProvenance: async () => ({
          scanned: 0,
          attempted: 0,
          resolved: 0,
          failed: 0,
          timedOut: 0,
          changed: false,
        }),
        now: () => Date.parse('2026-01-01T00:06:00.000Z'),
      })
      await second.start()
      await waitFor(() => secondRouter.routed.length === 1)
      await second.stop()

      expect(secondRouter.routed[0]?.externalMessageId).toBe('400000000000000001')
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('durable cursors survive recreation but remain isolated by authenticated account', async () => {
    const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-discord-adapter-recovery-'))
    try {
      const firstStore = await loadDiscordRecoveryStore(agentDir, '100000000000000001')
      await firstStore.markProcessed({
        channelId: '300000000000000003',
        workspace: '200000000000000002',
        messageId: '400000000000000001',
        processedAt: 1,
      })
      await firstStore.markDisconnected(2)

      const isolated = await loadDiscordRecoveryStore(agentDir, '100000000000000099')
      expect(isolated.listReplayCursors()).toEqual([])
      expect((await loadDiscordRecoveryStore(agentDir, '100000000000000001')).listReplayCursors()).toHaveLength(1)
    } finally {
      await rm(agentDir, { recursive: true, force: true })
    }
  })

  test('captures Discord thread parent id and name before routing', async () => {
    const r = router()
    const listener = new FakeListener()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          getChannel: async (id: string) =>
            id === '300000000000000003'
              ? {
                  id,
                  guild_id: '200000000000000002',
                  name: 'topic-thread',
                  type: 11,
                  parent_id: '300000000000000099',
                }
              : { id, guild_id: '200000000000000002', name: 'development', type: 0 },
        }),
      createListener: () => listener as unknown as DiscordListener,
    })

    await adapter.start()
    listener.emit('message_create', {
      type: 'MESSAGE_CREATE',
      id: '400000000000000004',
      channel_id: '300000000000000003',
      guild_id: '200000000000000002',
      author: { id: '500000000000000005', username: 'alice' },
      content: 'thread message',
      timestamp: '2026-01-01T00:00:00.000Z',
    } satisfies DiscordGatewayMessageCreateEvent)
    await adapter.stop()

    expect(r.routed[0]?.room).toEqual({
      kind: 'thread',
      parentChat: '300000000000000099',
      parentChatName: 'development',
    })
  })

  test('a known DM routes successfully without channel metadata resolution', async () => {
    const r = router()
    const listener = new FakeListener()
    let channelMetadataCalls = 0
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          getChannel: async () => {
            channelMetadataCalls++
            return { id: '300000000000000003', name: 'should-not-resolve', type: 0 }
          },
        }),
      createListener: () => listener as unknown as DiscordListener,
    })

    await adapter.start()
    listener.emit('message_create', {
      type: 'MESSAGE_CREATE',
      id: '400000000000000004',
      channel_id: '300000000000000003',
      author: { id: '500000000000000005', username: 'alice' },
      content: 'private message',
      timestamp: '2026-01-01T00:00:00.000Z',
    } satisfies DiscordGatewayMessageCreateEvent)
    await adapter.stop()

    expect(r.routed[0]?.workspace).toBe('@dm')
    expect(r.routed[0]?.room).toBeUndefined()
    expect(channelMetadataCalls).toBe(0)
  })

  test('adapter start triggers observable resolver-backed historical provenance maintenance', async () => {
    const r = router()
    const listener = new FakeListener()
    const log = logger()
    const calls: string[] = []
    const adapter = createDiscordAdapter({
      agentDir: '/agent',
      router: r,
      configRef: () => config,
      logger: log,
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient(),
      createListener: () => listener as unknown as DiscordListener,
      enrichHistoricalProvenance: async (agentDir, resolve, options) => {
        calls.push(agentDir)
        expect(options.adapter).toBe('discord')
        const resolved = await resolve({
          adapter: 'discord',
          workspace: '200000000000000002',
          chat: '300000000000000003',
          thread: null,
        })
        expect(resolved.where.workspaceName).toBe('Example Guild')
        expect(resolved.parentChecked).toBe(true)
        return { scanned: 1, attempted: 1, resolved: 1, failed: 0, timedOut: 0, changed: true }
      },
    })

    await adapter.start()
    await Bun.sleep(0)

    expect(calls).toEqual(['/agent'])
    expect(log.lines).toContain(
      'info:[discord] historical provenance enrichment scanned=1 attempted=1 resolved=1 failed=0 timed_out=0 changed=true',
    )
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
    expect(sent).toEqual([['300000000000000003', 'hello', undefined]])
  })

  test('outbound forwards replyTo as the reply_to option on the first text chunk (native reply)', async () => {
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
      text: 'on it',
      replyTo: { externalMessageId: '900000000000000009' },
    })

    expect(result).toEqual({ ok: true })
    expect(sent).toEqual([['300000000000000003', 'on it', { reply_to: '900000000000000009' }]])
  })

  test('attachment-only reply forwards reply_to on the first file upload (native reply)', async () => {
    const uploads: unknown[] = []
    const r = router()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient({ uploadFile: async (...args: unknown[]) => void uploads.push(args) }),
      createListener: () => new FakeListener() as unknown as DiscordListener,
    })

    await adapter.start()
    const result = await r.outbound?.({
      adapter: 'discord',
      workspace: '200000000000000002',
      chat: '300000000000000003',
      attachments: [{ path: '/tmp/a.png' }, { path: '/tmp/b.png' }],
      replyTo: { externalMessageId: '900000000000000009' },
    })

    expect(result).toEqual({ ok: true })
    expect(uploads).toEqual([
      ['300000000000000003', '/tmp/a.png', { reply_to: '900000000000000009' }],
      ['300000000000000003', '/tmp/b.png', undefined],
    ])
  })

  test('text+attachment reply keeps reply_to on the text send, files upload bare', async () => {
    const uploads: unknown[] = []
    const sent: unknown[] = []
    const r = router()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          uploadFile: async (...args: unknown[]) => void uploads.push(args),
          sendMessage: async (...args: unknown[]) => void sent.push(args),
        }),
      createListener: () => new FakeListener() as unknown as DiscordListener,
    })

    await adapter.start()
    const result = await r.outbound?.({
      adapter: 'discord',
      workspace: '200000000000000002',
      chat: '300000000000000003',
      text: 'here you go',
      attachments: [{ path: '/tmp/a.png' }],
      replyTo: { externalMessageId: '900000000000000009' },
    })

    expect(result).toEqual({ ok: true })
    expect(uploads).toEqual([['300000000000000003', '/tmp/a.png', undefined]])
    expect(sent).toEqual([['300000000000000003', 'here you go', { reply_to: '900000000000000009' }]])
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

  test('a stale authentication failure cannot clear a newer successful lifecycle', async () => {
    const firstAuthStarted = deferred<void>()
    const releaseFirstAuth = deferred<void>()
    let authCalls = 0
    const r = router()
    const listeners: FakeListener[] = []
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () =>
        fakeClient({
          testAuth: async () => {
            authCalls++
            if (authCalls === 1) {
              firstAuthStarted.resolve(undefined)
              await releaseFirstAuth.promise
              throw new Error('stale auth failed')
            }
            return { id: '100000000000000001', username: 'self', global_name: 'Self' }
          },
        }),
      createListener: () => {
        const created = new FakeListener()
        listeners.push(created)
        return created as unknown as DiscordListener
      },
    })

    const firstResult = adapter.start().then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    )
    await firstAuthStarted.promise
    await adapter.stop()
    await adapter.start()
    const unregisterCount = r.unregistered.length
    releaseFirstAuth.resolve(undefined)

    expect(await firstResult).toBe('rejected')
    expect(adapter.isConnected()).toBe(true)
    expect(listeners).toHaveLength(1)
    expect(listeners[0]?.stopped).toBe(false)
    expect(r.unregistered).toHaveLength(unregisterCount)
  })

  test('a stale listener failure stops only its listener and preserves newer callbacks', async () => {
    const firstListenerStarted = deferred<void>()
    const releaseFirstListener = deferred<void>()
    const firstListener = new FakeListener()
    firstListener.start = async () => {
      firstListenerStarted.resolve(undefined)
      await releaseFirstListener.promise
      throw new Error('stale listener failed')
    }
    const secondListener = new FakeListener()
    const listeners = [firstListener, secondListener]
    const r = router()
    const adapter = createDiscordAdapter({
      router: r,
      configRef: () => config,
      logger: logger(),
      credentialsStore: { getAccount: async () => account() },
      createClient: () => fakeClient(),
      createListener: () => listeners.shift()! as unknown as DiscordListener,
    })

    const firstResult = adapter.start().then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    )
    await firstListenerStarted.promise
    await adapter.stop()
    await adapter.start()
    const unregisterCount = r.unregistered.length
    releaseFirstListener.resolve(undefined)

    expect(await firstResult).toBe('rejected')
    expect(adapter.isConnected()).toBe(true)
    expect(firstListener.stopped).toBe(true)
    expect(secondListener.stopped).toBe(false)
    expect(r.unregistered).toHaveLength(unregisterCount)
    secondListener.emit('message_create', gatewayMessage('400000000000000099', 'still live'))
    await waitFor(() => r.routed.length === 1)
  })
})

describe('createDiscordHistoryCallback', () => {
  function historyMessage(overrides: Record<string, unknown> = {}) {
    return {
      id: '400000000000000004',
      channel_id: '300000000000000003',
      author: { id: '500000000000000005', username: 'alice' },
      content: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }
  }

  async function fetchHistory(messages: unknown[]) {
    const callback = createDiscordHistoryCallback({
      client: { getMessages: async () => messages } as unknown as Parameters<
        typeof createDiscordHistoryCallback
      >[0]['client'],
      logger: logger(),
    })
    return await callback({ chat: '300000000000000003', thread: null, limit: 10 })
  }

  test('a captionless image in history is addressable and carries its CDN ref', async () => {
    const result = await fetchHistory([
      historyMessage({
        content: '',
        attachments: [
          {
            id: '1',
            filename: 'image.png',
            size: 1024,
            url: 'https://cdn.discordapp.com/attachments/1/2/image.png',
            content_type: 'image/webp',
          },
        ],
      }),
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const [message] = result.messages
    expect(message?.text).toBe('[Discord attachment #1: file image/webp name=image.png]')
    expect(message?.attachments).toEqual([
      {
        id: 1,
        kind: 'file',
        ref: 'https://cdn.discordapp.com/attachments/1/2/image.png',
        filename: 'image.png',
        mimetype: 'image/webp',
      },
    ])
  })

  test('placeholder ids line up one-to-one with the structured refs', async () => {
    const result = await fetchHistory([
      historyMessage({
        content: 'two files',
        attachments: [
          { id: '1', filename: 'a.png', size: 1, url: 'https://cdn.discordapp.com/attachments/1/2/a.png' },
          {
            id: '2',
            filename: 'b.pdf',
            size: 1,
            url: 'https://cdn.discordapp.com/attachments/1/3/b.pdf',
            content_type: 'application/pdf',
          },
        ],
      }),
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const message = result.messages[0]
    expect(message?.text).toBe(
      'two files\n[Discord attachment #1: file name=a.png]\n[Discord attachment #2: file application/pdf name=b.pdf]',
    )
    expect(message?.attachments?.map((a) => [a.id, a.ref])).toEqual([
      [1, 'https://cdn.discordapp.com/attachments/1/2/a.png'],
      [2, 'https://cdn.discordapp.com/attachments/1/3/b.pdf'],
    ])
  })

  test('text-only history messages are untouched and carry no attachments key', async () => {
    const result = await fetchHistory([historyMessage()])

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.messages[0]?.text).toBe('hello')
    expect(result.messages[0]?.attachments).toBeUndefined()
  })
})

function fakeClient(
  overrides: Record<string, unknown> = {},
): ReturnType<NonNullable<Parameters<typeof createDiscordAdapter>[0]['createClient']>> {
  return {
    login: async () => {},
    testAuth: async () => ({ id: '100000000000000001', username: 'self', global_name: 'Self' }),
    getChannel: async () => ({ id: '300000000000000003', guild_id: '200000000000000002', name: 'general', type: 0 }),
    getServer: async () => ({ id: '200000000000000002', name: 'Example Guild' }),
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

function connectedInfo() {
  return { user: { id: '100000000000000001', username: 'self' }, sessionId: 'session-reconnect' }
}

function gatewayMessage(id: string, content: string): DiscordGatewayMessageCreateEvent {
  return {
    type: 'MESSAGE_CREATE',
    id,
    channel_id: '300000000000000003',
    guild_id: '200000000000000002',
    author: { id: '500000000000000005', username: 'alice' },
    content,
    timestamp: '2026-01-01T00:00:00.000Z',
  }
}

function restMessage(id: string, content: string) {
  const { type: _type, guild_id: _guildId, ...message } = gatewayMessage(id, content)
  return message
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value) => {
      resolvePromise?.(value)
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('timed out waiting for condition')
    await Bun.sleep(1)
  }
}
