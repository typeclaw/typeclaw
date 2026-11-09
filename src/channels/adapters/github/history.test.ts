import { describe, expect, it } from 'bun:test'

import { createChatWorkspaceIndex, createGithubHistoryCallback } from './history'

describe('createGithubHistoryCallback', () => {
  it('fetches issue comments for a remembered workspace', async () => {
    const cb = createGithubHistoryCallback({
      token: async () => 'tok',
      workspaceForChat: () => 'acme/project',
      fetchImpl: Object.assign(
        async () =>
          Response.json([
            { id: 1, body: 'hello', created_at: '2026-01-01T00:00:00Z', user: { id: 2, login: 'alice' } },
          ]),
        { preconnect: () => {} },
      ),
    })

    const result = await cb({ chat: 'issue:5', thread: null, limit: 10 })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.messages[0]?.text).toBe('hello')
  })

  it('reads the requested repo when two repos share a chat id', async () => {
    // given
    const index = createChatWorkspaceIndex()
    index.remember('acme/public', 'pr:12')
    index.remember('acme/private', 'pr:12')
    const urls: string[] = []
    const cb = createGithubHistoryCallback({
      token: async () => 'tok',
      workspaceForChat: index.resolve,
      fetchImpl: Object.assign(
        async (url: string | URL | Request) => {
          urls.push(String(url))
          return Response.json([])
        },
        { preconnect: () => {} },
      ),
    })

    // when
    const result = await cb({ workspace: 'acme/public', chat: 'pr:12', thread: null, limit: 10 })

    // then
    expect(result.ok).toBe(true)
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/repos/acme/public/issues/12/comments')
  })
})

describe('createChatWorkspaceIndex', () => {
  it('resolves a named repo only when it delivered that chat', () => {
    const index = createChatWorkspaceIndex()
    index.remember('acme/public', 'pr:12')
    index.remember('acme/private', 'pr:12')

    expect(index.resolve('pr:12', 'acme/public')).toBe('acme/public')
    expect(index.resolve('pr:12', 'acme/private')).toBe('acme/private')
    expect(index.resolve('pr:12', 'acme/other')).toBeNull()
    expect(index.resolve('pr:13', 'acme/public')).toBeNull()
  })

  it('resolves an unnamed repo only when one repo is known for the chat', () => {
    const index = createChatWorkspaceIndex()
    index.remember('acme/public', 'pr:12')
    expect(index.resolve('pr:12')).toBe('acme/public')

    index.remember('acme/private', 'pr:12')
    expect(index.resolve('pr:12')).toBeNull()
  })
})
