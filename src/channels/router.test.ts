import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChannelRouter, type CreateSessionForChannel, type InboundMessage, type OutboundReply } from './router'

type FakeListener = (event: any) => void

function createFakeSession() {
  const listeners: FakeListener[] = []
  const promptCalls: string[] = []
  return {
    session: {
      subscribe(listener: FakeListener) {
        listeners.push(listener)
        return () => {
          const i = listeners.indexOf(listener)
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

function emitTextDelta(fakes: { listeners: FakeListener[] }, delta: string) {
  for (const l of fakes.listeners) {
    l({
      type: 'message_update',
      message: { id: 'm1', role: 'assistant' },
      assistantMessageEvent: { type: 'text_delta', delta },
    })
  }
}

function emitMessageEnd(
  fakes: { listeners: FakeListener[] },
  role: 'assistant' | 'user' = 'assistant',
  responseId = 'm1',
) {
  for (const l of fakes.listeners) {
    l({ type: 'message_end', message: { role, responseId, timestamp: 1 } })
  }
}

const baseEvent: InboundMessage = {
  adapter: 'discord-bot',
  bot: 'main',
  workspace: 'W1',
  chat: 'C1',
  thread: null,
  text: 'hello',
  externalMessageId: 'xm1',
  authorId: 'u1',
}

describe('ChannelRouter', () => {
  test('first inbound creates a session, persists mapping, and prompts the session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channels-router-'))
    const fakes = createFakeSession()
    let createCount = 0
    const createSessionForChannel: CreateSessionForChannel = async () => {
      createCount++
      return { session: fakes.session, sessionId: 'sess-1' }
    }

    const router = createChannelRouter({ agentDir: dir, createSessionForChannel })
    await router.route(baseEvent)

    expect(createCount).toBe(1)
    expect(fakes.promptCalls).toEqual(['hello'])
    expect(router.liveSessionCount()).toBe(1)
    const mappings = router.knownMappings()
    expect(mappings).toHaveLength(1)
    expect(mappings[0]).toMatchObject({
      adapter: 'discord-bot',
      bot: 'main',
      workspace: 'W1',
      chat: 'C1',
      thread: null,
      sessionId: 'sess-1',
    })

    const persisted = JSON.parse(await readFile(join(dir, 'channels/sessions.json'), 'utf8'))
    expect(persisted.version).toBe(1)
    expect(persisted.mappings).toHaveLength(1)
  })

  test('subsequent inbound for same key reuses the session (no second create)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channels-router-'))
    const fakes = createFakeSession()
    let createCount = 0
    const createSessionForChannel: CreateSessionForChannel = async () => {
      createCount++
      return { session: fakes.session, sessionId: 'sess-1' }
    }
    const router = createChannelRouter({ agentDir: dir, createSessionForChannel })

    await router.route(baseEvent)
    await router.route({ ...baseEvent, text: 'second', externalMessageId: 'xm2' })

    expect(createCount).toBe(1)
    expect(fakes.promptCalls).toEqual(['hello', 'second'])
    expect(router.liveSessionCount()).toBe(1)
  })

  test('different (workspace, chat) tuples each get their own session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channels-router-'))
    let n = 0
    const fakesByCall: ReturnType<typeof createFakeSession>[] = []
    const createSessionForChannel: CreateSessionForChannel = async () => {
      n++
      const f = createFakeSession()
      fakesByCall.push(f)
      return { session: f.session, sessionId: `sess-${n}` }
    }
    const router = createChannelRouter({ agentDir: dir, createSessionForChannel })

    await router.route(baseEvent)
    await router.route({ ...baseEvent, workspace: 'W2' })
    await router.route({ ...baseEvent, chat: 'C2' })
    await router.route({ ...baseEvent, thread: 'T1' })

    expect(n).toBe(4)
    expect(router.liveSessionCount()).toBe(4)
    expect(router.knownMappings()).toHaveLength(4)
  })

  test('reload from disk: on construction, an existing sessions.json is loaded', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channels-router-'))
    const fakes1 = createFakeSession()
    const router1 = createChannelRouter({
      agentDir: dir,
      createSessionForChannel: async () => ({ session: fakes1.session, sessionId: 'sess-A' }),
    })
    await router1.route(baseEvent)
    await router1.stop()

    const fakes2 = createFakeSession()
    let createCount = 0
    const router2 = createChannelRouter({
      agentDir: dir,
      createSessionForChannel: async () => {
        createCount++
        return { session: fakes2.session, sessionId: 'sess-B' }
      },
    })
    await router2.load()

    expect(router2.knownMappings()).toHaveLength(1)
    expect(router2.knownMappings()[0]?.sessionId).toBe('sess-A')
    expect(createCount).toBe(0)
  })

  test('outbound: assistant message_end posts accumulated text to the bound callback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channels-router-'))
    const fakes = createFakeSession()
    const router = createChannelRouter({
      agentDir: dir,
      createSessionForChannel: async () => ({ session: fakes.session, sessionId: 'sess-1' }),
    })

    const replies: OutboundReply[] = []
    router.bindOutbound('discord-bot', (r) => {
      replies.push(r)
    })

    await router.route(baseEvent)
    emitTextDelta(fakes, 'hi ')
    emitTextDelta(fakes, 'there')
    emitMessageEnd(fakes, 'assistant')

    await Promise.resolve()

    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({
      adapter: 'discord-bot',
      bot: 'main',
      workspace: 'W1',
      chat: 'C1',
      thread: null,
      text: 'hi there',
    })
    expect(replies[0]?.turnId).toBe('sess-1:m1')
  })

  test('outbound: user message_end does not trigger a reply', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channels-router-'))
    const fakes = createFakeSession()
    const router = createChannelRouter({
      agentDir: dir,
      createSessionForChannel: async () => ({ session: fakes.session, sessionId: 'sess-1' }),
    })

    const replies: OutboundReply[] = []
    router.bindOutbound('discord-bot', (r) => {
      replies.push(r)
    })

    await router.route(baseEvent)
    emitTextDelta(fakes, 'unused')
    emitMessageEnd(fakes, 'user')

    expect(replies).toHaveLength(0)
  })

  test('outbound: assistant message with no accumulated text does not post', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channels-router-'))
    const fakes = createFakeSession()
    const router = createChannelRouter({
      agentDir: dir,
      createSessionForChannel: async () => ({ session: fakes.session, sessionId: 'sess-1' }),
    })
    const replies: OutboundReply[] = []
    router.bindOutbound('discord-bot', (r) => {
      replies.push(r)
    })

    await router.route(baseEvent)
    emitMessageEnd(fakes, 'assistant')

    expect(replies).toHaveLength(0)
  })

  test('bindOutbound returns an unsubscribe that removes the callback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channels-router-'))
    const fakes = createFakeSession()
    const router = createChannelRouter({
      agentDir: dir,
      createSessionForChannel: async () => ({ session: fakes.session, sessionId: 'sess-1' }),
    })
    const replies: OutboundReply[] = []
    const off = router.bindOutbound('discord-bot', (r) => {
      replies.push(r)
    })

    await router.route(baseEvent)
    emitTextDelta(fakes, 'first')
    emitMessageEnd(fakes, 'assistant', 'm1')
    await Promise.resolve()

    off()
    emitTextDelta(fakes, 'second')
    emitMessageEnd(fakes, 'assistant', 'm2')
    await Promise.resolve()

    expect(replies).toHaveLength(1)
    expect(replies[0]?.text).toBe('first')
  })

  test('multiple text_delta accumulate per turn and reset across turns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channels-router-'))
    const fakes = createFakeSession()
    const router = createChannelRouter({
      agentDir: dir,
      createSessionForChannel: async () => ({ session: fakes.session, sessionId: 'sess-1' }),
    })
    const replies: OutboundReply[] = []
    router.bindOutbound('discord-bot', (r) => {
      replies.push(r)
    })

    await router.route(baseEvent)
    emitTextDelta(fakes, 'turn1-')
    emitTextDelta(fakes, 'final')
    emitMessageEnd(fakes, 'assistant', 'm1')
    await Promise.resolve()

    emitTextDelta(fakes, 'turn2')
    emitMessageEnd(fakes, 'assistant', 'm2')
    await Promise.resolve()

    expect(replies.map((r) => r.text)).toEqual(['turn1-final', 'turn2'])
  })

  test('corrupt sessions.json: logs and continues with empty mappings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channels-router-'))
    await Bun.write(join(dir, 'channels/sessions.json'), '{not json')
    const fakes = createFakeSession()
    const errors: string[] = []
    const router = createChannelRouter({
      agentDir: dir,
      createSessionForChannel: async () => ({ session: fakes.session, sessionId: 'sess-1' }),
      logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
    })
    await router.load()

    expect(errors.some((e) => e.includes('not valid JSON'))).toBe(true)
    expect(router.knownMappings()).toEqual([])
  })

  test('unknown adapter outbound is dropped with a warning, no throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channels-router-'))
    const fakes = createFakeSession()
    const warnings: string[] = []
    const router = createChannelRouter({
      agentDir: dir,
      createSessionForChannel: async () => ({ session: fakes.session, sessionId: 'sess-1' }),
      logger: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    })

    await router.route(baseEvent)
    emitTextDelta(fakes, 'orphan')
    emitMessageEnd(fakes, 'assistant')

    await Promise.resolve()

    expect(warnings.some((w) => w.includes('no outbound callback'))).toBe(true)
  })

  test('concurrent route() for the same key creates only one session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channels-router-'))
    const fakes = createFakeSession()
    let createCount = 0
    const createSessionForChannel: CreateSessionForChannel = async () => {
      createCount++
      await new Promise((r) => setTimeout(r, 20))
      return { session: fakes.session, sessionId: 'sess-1' }
    }
    const router = createChannelRouter({ agentDir: dir, createSessionForChannel })

    await Promise.all([
      router.route({ ...baseEvent, text: 'first', externalMessageId: 'x1' }),
      router.route({ ...baseEvent, text: 'second', externalMessageId: 'x2' }),
      router.route({ ...baseEvent, text: 'third', externalMessageId: 'x3' }),
    ])

    expect(createCount).toBe(1)
    expect(router.liveSessionCount()).toBe(1)
    expect(router.knownMappings()).toHaveLength(1)
  })

  test('concurrent route() for the same key serializes session.prompt() FIFO', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channels-router-'))
    const promptOrder: string[] = []
    const inFlight: { current: number } = { current: 0 }
    let maxConcurrent = 0
    const session = {
      subscribe: () => () => {},
      async prompt(text: string) {
        inFlight.current++
        if (inFlight.current > maxConcurrent) maxConcurrent = inFlight.current
        await new Promise((r) => setTimeout(r, 10))
        promptOrder.push(text)
        inFlight.current--
      },
      async abort() {},
    }
    const router = createChannelRouter({
      agentDir: dir,
      createSessionForChannel: async () => ({ session: session as any, sessionId: 'sess-1' }),
    })

    await Promise.all([
      router.route({ ...baseEvent, text: 'a', externalMessageId: 'x1' }),
      router.route({ ...baseEvent, text: 'b', externalMessageId: 'x2' }),
      router.route({ ...baseEvent, text: 'c', externalMessageId: 'x3' }),
    ])

    expect(promptOrder).toEqual(['a', 'b', 'c'])
    expect(maxConcurrent).toBe(1)
  })

  test('mapping is persisted to disk before any prompt runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'channels-router-'))
    const observed: { persisted: boolean | null } = { persisted: null }
    const session = {
      subscribe: () => () => {},
      async prompt() {
        try {
          const raw = await readFile(join(dir, 'channels/sessions.json'), 'utf8')
          const parsed = JSON.parse(raw) as { mappings: { sessionId: string }[] }
          observed.persisted = parsed.mappings.some((m) => m.sessionId === 'sess-1')
        } catch {
          observed.persisted = false
        }
      },
      async abort() {},
    }
    const router = createChannelRouter({
      agentDir: dir,
      createSessionForChannel: async () => ({ session: session as any, sessionId: 'sess-1' }),
    })

    await router.route(baseEvent)

    expect(observed.persisted).toBe(true)
  })
})
