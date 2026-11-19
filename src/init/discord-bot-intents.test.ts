import { describe, expect, test } from 'bun:test'

import { checkDiscordBotIntents } from './discord-bot-intents'

const MESSAGE_CONTENT_LIMITED = 1 << 19
const MESSAGE_CONTENT = 1 << 18
const GUILD_MEMBERS_LIMITED = 1 << 15
const GUILD_MEMBERS = 1 << 14

function fakeFetch(respond: () => Response): { fetchFn: typeof fetch; requests: Request[] } {
  const requests: Request[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init))
    return respond()
  }) as typeof fetch
  return { fetchFn, requests }
}

function applicationWithFlags(flags: number): () => Response {
  return () => Response.json({ id: '123456789012345678', flags })
}

describe('checkDiscordBotIntents', () => {
  test('reads the current application with the bot token', async () => {
    const { fetchFn, requests } = fakeFetch(applicationWithFlags(MESSAGE_CONTENT_LIMITED | GUILD_MEMBERS_LIMITED))

    await checkDiscordBotIntents('bot-token', fetchFn)

    expect(requests.map((r) => r.url)).toEqual(['https://discord.com/api/v10/applications/@me'])
    expect(requests[0]!.headers.get('authorization')).toBe('Bot bot-token')
  })

  test('is ok when the portal toggles (limited bits) are on', async () => {
    const { fetchFn } = fakeFetch(applicationWithFlags(MESSAGE_CONTENT_LIMITED | GUILD_MEMBERS_LIMITED))
    expect(await checkDiscordBotIntents('t', fetchFn)).toEqual({ status: 'ok' })
  })

  test('is ok for a verified app that carries the un-limited bits', async () => {
    const { fetchFn } = fakeFetch(applicationWithFlags(MESSAGE_CONTENT | GUILD_MEMBERS))
    expect(await checkDiscordBotIntents('t', fetchFn)).toEqual({ status: 'ok' })
  })

  test('reports MESSAGE CONTENT missing when only the members intent is on', async () => {
    const { fetchFn } = fakeFetch(applicationWithFlags(GUILD_MEMBERS_LIMITED))
    expect(await checkDiscordBotIntents('t', fetchFn)).toEqual({ status: 'missing', intents: ['MESSAGE CONTENT'] })
  })

  test('reports both intents missing on a fresh application', async () => {
    const { fetchFn } = fakeFetch(applicationWithFlags(0))
    expect(await checkDiscordBotIntents('t', fetchFn)).toEqual({
      status: 'missing',
      intents: ['MESSAGE CONTENT', 'SERVER MEMBERS'],
    })
  })

  test('is unchecked, not missing, when Discord rejects the token', async () => {
    const { fetchFn } = fakeFetch(() => new Response('{"message": "401: Unauthorized"}', { status: 401 }))
    expect(await checkDiscordBotIntents('t', fetchFn)).toEqual({
      status: 'unchecked',
      reason: 'Discord rejected the bot token (401 Unauthorized)',
    })
  })

  test('is unchecked when the request fails', async () => {
    const fetchFn = (async () => {
      throw new Error('getaddrinfo ENOTFOUND discord.com')
    }) as unknown as typeof fetch
    expect(await checkDiscordBotIntents('t', fetchFn)).toEqual({
      status: 'unchecked',
      reason: 'getaddrinfo ENOTFOUND discord.com',
    })
  })

  test('is unchecked when the response has no flags', async () => {
    const { fetchFn } = fakeFetch(() => Response.json({ id: '1' }))
    expect((await checkDiscordBotIntents('t', fetchFn)).status).toBe('unchecked')
  })
})
