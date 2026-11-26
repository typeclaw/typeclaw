import { describe, expect, test } from 'bun:test'

import { fetchSlackAgentMode, setSlackAgentSessionStatus, setSlackAssistantStatus } from './slack-bot-agent-session'

type Captured = { url: string; init: RequestInit | undefined }

// Never answers; settles only when the caller's abort signal fires.
const stalledFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
  })) as typeof fetch

function fakeFetch(response: () => Response): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return response()
  }) as typeof fetch
  return { fetchImpl, calls }
}

describe('fetchSlackAgentMode', () => {
  test('is on when the token was granted assistant:write', async () => {
    const { fetchImpl, calls } = fakeFetch(
      () =>
        new Response('{"ok":true}', { headers: { 'x-oauth-scopes': 'app_mentions:read,assistant:write,chat:write' } }),
    )

    expect(await fetchSlackAgentMode('xoxb-test', fetchImpl)).toBe(true)
    expect(calls[0]!.url).toBe('https://slack.com/api/auth.test')
  })

  test('is off for a plain app token', async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response('{"ok":true}', { headers: { 'x-oauth-scopes': 'app_mentions:read,chat:write' } }),
    )

    expect(await fetchSlackAgentMode('xoxb-test', fetchImpl)).toBe(false)
  })

  test('a stalled probe rejects at its deadline instead of holding start', async () => {
    await expect(fetchSlackAgentMode('xoxb-test', stalledFetch, 10)).rejects.toThrow()
  })
})

describe('setSlackAgentSessionStatus', () => {
  test('posts the session status for the thread', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('{"ok":true}'))

    await setSlackAgentSessionStatus('xoxb-test', fetchImpl, {
      chat: 'D0DM',
      threadTs: '1.000100',
      status: 'processing',
    })

    expect(calls[0]!.url).toBe('https://slack.com/api/agents.sessions.setStatus')
    const body = new URLSearchParams(calls[0]!.init!.body as string)
    expect(Object.fromEntries(body)).toEqual({ channel_id: 'D0DM', thread_ts: '1.000100', status: 'processing' })
  })

  test('throws the Slack error so the caller can fall back', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('{"ok":false,"error":"not_allowed_token_type"}'))

    await expect(
      setSlackAgentSessionStatus('xoxb-test', fetchImpl, { chat: 'D0DM', threadTs: '1.000100', status: 'active' }),
    ).rejects.toThrow('not_allowed_token_type')
  })

  test('a stalled status call rejects at its deadline so the typing queue moves on', async () => {
    await expect(
      setSlackAgentSessionStatus(
        'xoxb-test',
        stalledFetch,
        { chat: 'D0DM', threadTs: '1.000100', status: 'active' },
        10,
      ),
    ).rejects.toThrow()
  })
})

describe('setSlackAssistantStatus', () => {
  test('posts the legacy status for the thread', async () => {
    const { fetchImpl, calls } = fakeFetch(() => new Response('{"ok":true}'))

    await setSlackAssistantStatus('xoxb-test', fetchImpl, {
      chat: 'D0DM',
      threadTs: '1.000100',
      status: 'is typing...',
    })

    expect(calls[0]!.url).toBe('https://slack.com/api/assistant.threads.setStatus')
    const body = new URLSearchParams(calls[0]!.init!.body as string)
    expect(Object.fromEntries(body)).toEqual({ channel_id: 'D0DM', thread_ts: '1.000100', status: 'is typing...' })
  })

  test('a stalled fallback rejects at its deadline', async () => {
    await expect(
      setSlackAssistantStatus('xoxb-test', stalledFetch, { chat: 'D0DM', threadTs: '1.000100', status: '' }, 10),
    ).rejects.toThrow()
  })
})
