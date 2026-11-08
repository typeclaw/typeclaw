import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildChannelTools } from '@/agent'
import type { SessionOrigin } from '@/agent/session-origin'
import { createChannelRouter } from '@/channels/router'
import { defaultHistoryConfig } from '@/channels/schema'
import type { FetchHistoryArgs } from '@/channels/types'
import { createPermissionService, rolesConfigSchema } from '@/permissions'

const permissions = createPermissionService({
  roles: rolesConfigSchema.parse({ member: { match: ['discord:* author:UMEMBER'] } }),
})

function channelOrigin(author: string, thread: string | null = null): SessionOrigin {
  return {
    kind: 'channel',
    adapter: 'discord-bot',
    workspace: 'G1',
    chat: 'C-HERE',
    thread,
    lastInboundAuthorId: author,
    lastInboundAuthorAdapter: 'discord-bot',
  }
}

function setup(initial: SessionOrigin) {
  const router = createChannelRouter({
    agentDir: mkdtempSync(join(tmpdir(), 'channel-read-permission-')),
    configForAdapter: () => ({
      engagement: { trigger: ['mention'], stickiness: 'off' },
      enabled: true,
      history: defaultHistoryConfig(),
    }),
  })
  const fetched: FetchHistoryArgs[] = []
  const adapterCalls: string[] = []
  router.registerHistory('discord-bot', async (args) => {
    fetched.push(args)
    adapterCalls.push('history')
    return { ok: true, messages: [] }
  })
  router.registerMessageGet('discord-bot', async () => {
    adapterCalls.push('message')
    return { ok: false, error: 'gone', code: 'not-found' }
  })
  router.registerList('discord-bot', async () => {
    adapterCalls.push('list')
    return { ok: true, entries: [{ chat: 'C-OTHER', name: 'general', kind: 'channel' }] }
  })
  const live = { current: initial }
  const tool = buildChannelTools(router, initial, 'session-1', () => live.current, permissions).find(
    (candidate) => candidate.name === 'channel_read',
  )
  if (tool === undefined) throw new Error('channel_read not built')
  const run = (params: Record<string, unknown>) =>
    tool.execute('id', params as never, undefined, undefined, {} as never) as Promise<{
      details: { ok: boolean; error?: string }
    }>
  return { run, fetched, adapterCalls, live }
}

describe('channel_read permission gate', () => {
  test('a guest is denied another conversation and the adapter is never called', async () => {
    // Given
    const { run, fetched } = setup(channelOrigin('UGUEST'))
    // When
    const history = await run({ mode: 'history', adapter: 'discord-bot', workspace: 'G1', chat: 'C-OTHER' })
    const list = await run({ mode: 'list', adapter: 'discord-bot', workspace: 'G1' })
    // Then
    expect(history.details.ok).toBe(false)
    expect(history.details.error).toContain('fs.see.private')
    expect(list.details.ok).toBe(false)
    expect(fetched).toEqual([])
  })

  test('a guest cannot reach another conversation through its own chat id', async () => {
    // Given
    const { run, adapterCalls } = setup(channelOrigin('UGUEST'))
    const own = { adapter: 'discord-bot', workspace: 'G1', chat: 'C-HERE' }
    // When
    const viaThread = await run({ mode: 'history', ...own, thread: 'C-PRIVATE' })
    const messageViaThread = await run({ mode: 'message', ...own, thread: 'C-PRIVATE', message_id: 'M1' })
    const listWithOwnChat = await run({ mode: 'list', ...own })
    // Then
    expect([viaThread, messageViaThread, listWithOwnChat].map((result) => result.details.ok)).toEqual([
      false,
      false,
      false,
    ])
    expect(adapterCalls).toEqual([])
  })

  test('a guest in a thread can read that thread and its parent chat', async () => {
    // Given
    const { run, fetched } = setup(channelOrigin('UGUEST', 'T-HERE'))
    // When
    const thread = await run({
      mode: 'history',
      adapter: 'discord-bot',
      workspace: 'G1',
      chat: 'C-HERE',
      thread: 'T-HERE',
    })
    const parent = await run({ mode: 'history', adapter: 'discord-bot', workspace: 'G1', chat: 'C-HERE' })
    // Then
    expect([thread.details.ok, parent.details.ok]).toEqual([true, true])
    expect(fetched.map((args) => args.thread)).toEqual(['T-HERE', null])
  })

  test('a guest can still read the conversation it is speaking in', async () => {
    // Given
    const { run, fetched } = setup(channelOrigin('UGUEST'))
    // When
    const result = await run({ mode: 'history', adapter: 'discord-bot', workspace: 'G1', chat: 'C-HERE' })
    // Then
    expect(result.details.ok).toBe(true)
    expect(fetched.map((args) => args.chat)).toEqual(['C-HERE'])
  })

  test('a member and the owner can read another conversation', async () => {
    // Given
    const member = setup(channelOrigin('UMEMBER'))
    const owner = setup({ kind: 'tui', sessionId: 'tui-1' })
    // When
    const memberRead = await member.run({ mode: 'history', adapter: 'discord-bot', workspace: 'G1', chat: 'C-OTHER' })
    const ownerList = await owner.run({ mode: 'list', adapter: 'discord-bot', workspace: 'G1' })
    // Then
    expect(memberRead.details.ok).toBe(true)
    expect(member.fetched.map((args) => args.chat)).toEqual(['C-OTHER'])
    expect(ownerList.details.ok).toBe(true)
  })

  test('the gate follows the current speaker, not the speaker who opened the session', async () => {
    // Given
    const { run, live } = setup(channelOrigin('UMEMBER'))
    const params = { mode: 'history', adapter: 'discord-bot', workspace: 'G1', chat: 'C-OTHER' }
    // When
    const asMember = await run(params)
    live.current = channelOrigin('UGUEST')
    const asGuest = await run(params)
    // Then
    expect(asMember.details.ok).toBe(true)
    expect(asGuest.details.ok).toBe(false)
  })

  test('a cron job scheduled by a guest is denied another conversation', async () => {
    // Given
    const { run } = setup({ kind: 'cron', jobId: 'job-1', scheduledByRole: 'guest' } as SessionOrigin)
    // When
    const result = await run({ mode: 'history', adapter: 'discord-bot', workspace: 'G1', chat: 'C-OTHER' })
    // Then
    expect(result.details.ok).toBe(false)
  })
})
