import { describe, expect, test } from 'bun:test'

import { createChannelRouter, type ChannelRouter } from '@/channels/router'
import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'
import type { ChannelHistoryMessage, FetchHistoryArgs, FetchHistoryResult, HistoryCallback } from '@/channels/types'

import { createChannelHistoryTool, type ChannelHistoryOrigin } from './channel-history'

function emptyAdapterConfig(): ChannelAdapterConfig {
  return {
    engagement: { trigger: ['mention'], stickiness: 'off' },
    enabled: true,
    history: defaultHistoryConfig(),
  }
}

async function makeRouter(): Promise<ChannelRouter> {
  return createChannelRouter({
    agentDir: '/tmp/test-channel-history',
    configForAdapter: () => emptyAdapterConfig(),
  })
}

const slackThreadOrigin: ChannelHistoryOrigin = {
  adapter: 'slack-bot',
  workspace: 'T0',
  chat: 'C0',
  thread: '1700000000.000100',
}

const slackChannelRootOrigin: ChannelHistoryOrigin = {
  adapter: 'slack-bot',
  workspace: 'T0',
  chat: 'C0',
  thread: null,
}

const fakeCtx = {} as Parameters<ReturnType<typeof createChannelHistoryTool>['execute']>[4]

async function runTool(
  tool: ReturnType<typeof createChannelHistoryTool>,
  params: Parameters<ReturnType<typeof createChannelHistoryTool>['execute']>[1],
) {
  return tool.execute('id', params, undefined, undefined, fakeCtx)
}

function userMessage(overrides: Partial<ChannelHistoryMessage> = {}): ChannelHistoryMessage {
  return {
    externalMessageId: 'm1',
    authorId: 'UALICE',
    authorName: 'Alice',
    text: 'hello',
    ts: 1_700_000_000_000,
    isBot: false,
    replyToBotMessageId: null,
    ...overrides,
  }
}

describe('createChannelHistoryTool', () => {
  test('defaults to thread scope when origin has a thread', async () => {
    // given
    const seen: FetchHistoryArgs[] = []
    const cb: HistoryCallback = async (args) => {
      seen.push(args)
      return { ok: true, messages: [userMessage()] }
    }
    const router = await makeRouter()
    router.registerHistory('slack-bot', 'T0', cb)
    const tool = createChannelHistoryTool({ router, origin: slackThreadOrigin })

    // when
    await runTool(tool, {})

    // then
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ chat: 'C0', thread: '1700000000.000100', limit: 20 })
  })

  test('defaults to channel scope when origin has no thread', async () => {
    // given
    const seen: FetchHistoryArgs[] = []
    const cb: HistoryCallback = async (args) => {
      seen.push(args)
      return { ok: true, messages: [] }
    }
    const router = await makeRouter()
    router.registerHistory('slack-bot', 'T0', cb)
    const tool = createChannelHistoryTool({ router, origin: slackChannelRootOrigin })

    // when
    await runTool(tool, {})

    // then
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({ chat: 'C0', thread: null, limit: 20 })
  })

  test('rejects scope:thread on a channel-root session without calling the adapter', async () => {
    // given
    let called = 0
    const cb: HistoryCallback = async () => {
      called++
      return { ok: true, messages: [] }
    }
    const router = await makeRouter()
    router.registerHistory('slack-bot', 'T0', cb)
    const tool = createChannelHistoryTool({ router, origin: slackChannelRootOrigin })

    // when
    const result = await runTool(tool, { scope: 'thread' })

    // then
    expect(called).toBe(0)
    expect(result.details).toEqual({ ok: false, error: 'thread-scope-requires-thread-session' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('thread-scope-requires-thread-session')
  })

  test('forwards explicit scope:channel even when origin is in a thread', async () => {
    // given
    const seen: FetchHistoryArgs[] = []
    const cb: HistoryCallback = async (args) => {
      seen.push(args)
      return { ok: true, messages: [] }
    }
    const router = await makeRouter()
    router.registerHistory('slack-bot', 'T0', cb)
    const tool = createChannelHistoryTool({ router, origin: slackThreadOrigin })

    // when
    await runTool(tool, { scope: 'channel' })

    // then
    expect(seen[0]!.thread).toBeNull()
  })

  test('reports history-not-supported verbatim when adapter has no callback registered', async () => {
    // given (router with no history callback for slack-bot)
    const router = await makeRouter()
    const tool = createChannelHistoryTool({ router, origin: slackThreadOrigin })

    // when
    const result = await runTool(tool, {})

    // then
    expect(result.details).toEqual({ ok: false, error: 'history-not-supported' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('history-not-supported')
  })

  test('forwards cursor through to the adapter unchanged on a follow-up call', async () => {
    // given
    const seen: FetchHistoryArgs[] = []
    const cb: HistoryCallback = async (args) => {
      seen.push(args)
      return { ok: true, messages: [], nextCursor: 'next-page' }
    }
    const router = await makeRouter()
    router.registerHistory('slack-bot', 'T0', cb)
    const tool = createChannelHistoryTool({ router, origin: slackThreadOrigin })

    // when
    await runTool(tool, { cursor: 'first-page' })

    // then
    expect(seen[0]!.cursor).toBe('first-page')
  })

  test('exposes nextCursor in the tool result so the agent can page', async () => {
    // given
    const cb: HistoryCallback = async (): Promise<FetchHistoryResult> => ({
      ok: true,
      messages: [userMessage()],
      nextCursor: 'cur-2',
    })
    const router = await makeRouter()
    router.registerHistory('slack-bot', 'T0', cb)
    const tool = createChannelHistoryTool({ router, origin: slackThreadOrigin })

    // when
    const result = await runTool(tool, {})

    // then
    expect(result.details).toEqual({ ok: true, count: 1, nextCursor: 'cur-2' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('cur-2')
  })

  test('omits nextCursor in the result when the adapter does not return one', async () => {
    // given
    const cb: HistoryCallback = async () => ({ ok: true, messages: [userMessage()] })
    const router = await makeRouter()
    router.registerHistory('slack-bot', 'T0', cb)
    const tool = createChannelHistoryTool({ router, origin: slackThreadOrigin })

    // when
    const result = await runTool(tool, {})

    // then
    expect(result.details).toEqual({ ok: true, count: 1 })
    const text = (result.content[0] as { text: string }).text
    expect(text).not.toContain('more older messages available')
  })

  test('renders messages in adapter-supplied order (already chronological)', async () => {
    // given
    const cb: HistoryCallback = async () => ({
      ok: true,
      messages: [
        userMessage({ externalMessageId: 'a', text: 'first', ts: 1_000_000_000_000 }),
        userMessage({ externalMessageId: 'b', text: 'second', ts: 1_000_000_001_000 }),
        userMessage({ externalMessageId: 'c', text: 'third', ts: 1_000_000_002_000 }),
      ],
    })
    const router = await makeRouter()
    router.registerHistory('slack-bot', 'T0', cb)
    const tool = createChannelHistoryTool({ router, origin: slackThreadOrigin })

    // when
    const result = await runTool(tool, {})

    // then
    const text = (result.content[0] as { text: string }).text
    const idxFirst = text.indexOf('first')
    const idxSecond = text.indexOf('second')
    const idxThird = text.indexOf('third')
    expect(idxFirst).toBeGreaterThan(-1)
    expect(idxSecond).toBeGreaterThan(idxFirst)
    expect(idxThird).toBeGreaterThan(idxSecond)
  })

  test('renders bot entries with a BOT marker and user entries with @mention', async () => {
    // given
    const cb: HistoryCallback = async () => ({
      ok: true,
      messages: [
        userMessage({ authorId: 'UALICE', authorName: 'Alice', isBot: false, text: 'hi' }),
        userMessage({ authorId: 'UBOT', authorName: 'typeclaw', isBot: true, text: 'auto-reply' }),
      ],
    })
    const router = await makeRouter()
    router.registerHistory('slack-bot', 'T0', cb)
    const tool = createChannelHistoryTool({ router, origin: slackThreadOrigin })

    // when
    const result = await runTool(tool, {})

    // then
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('Alice (<@UALICE>): hi')
    expect(text).toContain('BOT (typeclaw): auto-reply')
  })

  test('renders an empty history with the (no messages) marker', async () => {
    // given
    const cb: HistoryCallback = async () => ({ ok: true, messages: [] })
    const router = await makeRouter()
    router.registerHistory('slack-bot', 'T0', cb)
    const tool = createChannelHistoryTool({ router, origin: slackThreadOrigin })

    // when
    const result = await runTool(tool, {})

    // then
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('(no messages)')
  })

  test('passes limit through verbatim and clamps via the adapter (tool itself does not clamp)', async () => {
    // given
    const seen: FetchHistoryArgs[] = []
    const cb: HistoryCallback = async (args) => {
      seen.push(args)
      return { ok: true, messages: [] }
    }
    const router = await makeRouter()
    router.registerHistory('slack-bot', 'T0', cb)
    const tool = createChannelHistoryTool({ router, origin: slackThreadOrigin })

    // when
    await runTool(tool, { limit: 50 })

    // then
    expect(seen[0]!.limit).toBe(50)
  })

  test('surfaces adapter ok:false errors to the agent', async () => {
    // given
    const cb: HistoryCallback = async () => ({ ok: false, error: 'channel_not_found' })
    const router = await makeRouter()
    router.registerHistory('slack-bot', 'T0', cb)
    const tool = createChannelHistoryTool({ router, origin: slackThreadOrigin })

    // when
    const result = await runTool(tool, {})

    // then
    expect(result.details).toEqual({ ok: false, error: 'channel_not_found' })
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('channel_history error: channel_not_found')
  })

  test('schema metadata names the tool channel_history', () => {
    // given/when
    const router = createChannelRouter({ agentDir: '/tmp/test-name', configForAdapter: () => emptyAdapterConfig() })
    const tool = createChannelHistoryTool({ router, origin: slackThreadOrigin })

    // then
    expect(tool.name).toBe('channel_history')
    expect(tool.label).toBe('Channel History')
  })
})
