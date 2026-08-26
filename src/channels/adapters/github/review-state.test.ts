import { describe, expect, it } from 'bun:test'

import { createGithubReviewStateResolver } from './review-state'

type ReviewFixture = { id?: number; login: string; state: string; isBot?: boolean }

type Page = { reviews: ReviewFixture[]; hasNextPage: boolean }

function fakeRest(options: { pages: Page[]; seen?: { urls: string[] }; reviewDecision?: string | null }) {
  let pageIndex = 0
  return Object.assign(
    async (url: string | URL | Request): Promise<Response> => {
      const href = String(url)
      if (options.seen) options.seen.urls.push(href)
      if (href.endsWith('/graphql')) {
        return new Response(
          JSON.stringify({
            data: { repository: { pullRequest: { reviewDecision: options.reviewDecision ?? null } } },
          }),
          { status: 200 },
        )
      }
      const page = options.pages[Math.min(pageIndex, options.pages.length - 1)]
      pageIndex += 1
      const headers: Record<string, string> = {}
      if (page!.hasNextPage) {
        headers.Link = `<https://api.github.com/next>; rel="next"`
      }
      const body = page!.reviews.map((r) => ({
        id: r.id,
        state: r.state,
        user: { login: r.login, type: r.isBot === true ? 'Bot' : 'User' },
      }))
      return new Response(JSON.stringify(body), { status: 200, headers })
    },
    { preconnect: () => {} },
  )
}

const resolverFor = (fetchImpl: typeof fetch, opts: { selfLogin?: string | null; approve?: boolean } = {}) =>
  createGithubReviewStateResolver({
    token: async () => 'tok',
    selfLogin: () => (opts.selfLogin === undefined ? 'bot[bot]' : opts.selfLogin),
    approve: () => opts.approve ?? true,
    fetchImpl,
  })

const req = (overrides: Partial<{ workspace: string; chat: string }> = {}) => ({
  adapter: 'github' as const,
  workspace: overrides.workspace ?? 'acme/widgets',
  chat: overrides.chat ?? 'pr:644',
})

describe('github review-state resolver', () => {
  it('carries GitHub reviewDecision when a formal review is still required', async () => {
    const resolve = resolverFor(
      fakeRest({
        pages: [{ reviews: [], hasNextPage: false }],
        reviewDecision: 'REVIEW_REQUIRED',
      }),
    )
    const result = await resolve(req())
    expect(result).toEqual({
      ok: true,
      selfBlocking: false,
      selfBlockingReviewId: null,
      approve: true,
      reviewDecision: 'REVIEW_REQUIRED',
    })
  })

  it('reports selfBlocking when the bot’s latest formal review is CHANGES_REQUESTED', async () => {
    const resolve = resolverFor(
      fakeRest({
        pages: [{ reviews: [{ id: 1, login: 'bot', state: 'CHANGES_REQUESTED', isBot: true }], hasNextPage: false }],
      }),
    )
    const result = await resolve(req())
    expect(result).toEqual({ ok: true, selfBlocking: true, selfBlockingReviewId: 1, approve: true })
  })

  it('keeps a successful blocking lookup when the decisive review id is absent', async () => {
    const resolve = resolverFor(
      fakeRest({
        pages: [{ reviews: [{ login: 'bot', state: 'CHANGES_REQUESTED', isBot: true }], hasNextPage: false }],
      }),
    )

    expect(await resolve(req())).toEqual({
      ok: true,
      selfBlocking: true,
      selfBlockingReviewId: null,
      approve: true,
    })
  })

  it('does NOT treat a later COMMENTED review as clearing a CHANGES_REQUESTED block', async () => {
    const resolve = resolverFor(
      fakeRest({
        pages: [
          {
            reviews: [
              { id: 1, login: 'bot', state: 'CHANGES_REQUESTED', isBot: true },
              { id: 2, login: 'bot', state: 'COMMENTED', isBot: true },
            ],
            hasNextPage: false,
          },
        ],
      }),
    )
    const result = await resolve(req())
    expect(result).toEqual({ ok: true, selfBlocking: true, selfBlockingReviewId: 1, approve: true })
  })

  it('clears the block when a later APPROVED review follows the CHANGES_REQUESTED', async () => {
    const resolve = resolverFor(
      fakeRest({
        pages: [
          {
            reviews: [
              { id: 1, login: 'bot', state: 'CHANGES_REQUESTED', isBot: true },
              { id: 2, login: 'bot', state: 'APPROVED', isBot: true },
            ],
            hasNextPage: false,
          },
        ],
      }),
    )
    const result = await resolve(req())
    expect(result).toEqual({ ok: true, selfBlocking: false, selfBlockingReviewId: null, approve: true })
  })

  it('clears the block when the bot’s prior review was DISMISSED', async () => {
    const resolve = resolverFor(
      fakeRest({
        pages: [
          {
            reviews: [
              { id: 1, login: 'bot', state: 'CHANGES_REQUESTED', isBot: true },
              { id: 2, login: 'bot', state: 'DISMISSED', isBot: true },
            ],
            hasNextPage: false,
          },
        ],
      }),
    )
    const result = await resolve(req())
    expect(result).toEqual({ ok: true, selfBlocking: false, selfBlockingReviewId: null, approve: true })
  })

  it('ignores another reviewer’s CHANGES_REQUESTED', async () => {
    const resolve = resolverFor(
      fakeRest({
        pages: [{ reviews: [{ id: 1, login: 'human-reviewer', state: 'CHANGES_REQUESTED' }], hasNextPage: false }],
      }),
    )
    const result = await resolve(req())
    expect(result).toEqual({ ok: true, selfBlocking: false, selfBlockingReviewId: null, approve: true })
  })

  it('normalizes the bot login across REST slug[bot] and GraphQL bare-slug forms', async () => {
    const resolve = resolverFor(
      fakeRest({
        pages: [
          { reviews: [{ id: 1, login: 'bot[bot]', state: 'CHANGES_REQUESTED', isBot: true }], hasNextPage: false },
        ],
      }),
      { selfLogin: 'bot[bot]' },
    )
    const result = await resolve(req())
    expect(result.ok && result.selfBlocking).toBe(true)
  })

  it('does NOT strip the [bot] suffix for a human User who owns the bare slug', async () => {
    // given a human User 'bot' (no [bot]) reviewing, while the app is 'bot[bot]'
    const resolve = resolverFor(
      fakeRest({
        pages: [{ reviews: [{ id: 1, login: 'bot', state: 'CHANGES_REQUESTED', isBot: false }], hasNextPage: false }],
      }),
      { selfLogin: 'bot[bot]' },
    )
    const result = await resolve(req())
    expect(result).toEqual({ ok: true, selfBlocking: false, selfBlockingReviewId: null, approve: true })
  })

  it('paginates until the bot’s latest review is found', async () => {
    const seen = { urls: [] as string[] }
    const resolve = resolverFor(
      fakeRest({
        pages: [
          { reviews: [{ id: 1, login: 'bot', state: 'CHANGES_REQUESTED', isBot: true }], hasNextPage: true },
          { reviews: [{ id: 2, login: 'bot', state: 'APPROVED', isBot: true }], hasNextPage: false },
        ],
        seen,
      }),
    )
    const result = await resolve(req())
    expect(result).toEqual({ ok: true, selfBlocking: false, selfBlockingReviewId: null, approve: true })
    expect(seen.urls.some((url) => url.includes('/pulls/644/reviews'))).toBe(true)
    expect(seen.urls).toContain('https://api.github.com/next')
  })

  it('carries the approval policy through to the result', async () => {
    const resolve = resolverFor(
      fakeRest({
        pages: [{ reviews: [{ id: 1, login: 'bot', state: 'CHANGES_REQUESTED', isBot: true }], hasNextPage: false }],
      }),
      { approve: false },
    )
    const result = await resolve(req())
    expect(result).toEqual({ ok: true, selfBlocking: true, selfBlockingReviewId: 1, approve: false })
  })

  it('fails closed (ok:false) when the reviews API errors', async () => {
    const fetchImpl = Object.assign(async () => new Response('boom', { status: 500 }), { preconnect: () => {} })
    const resolve = resolverFor(fetchImpl)
    const result = await resolve(req())
    expect(result.ok).toBe(false)
  })

  it('fails closed when self-identity is unresolved', async () => {
    const resolve = resolverFor(fakeRest({ pages: [{ reviews: [], hasNextPage: false }] }), { selfLogin: null })
    const result = await resolve(req())
    expect(result.ok).toBe(false)
  })

  it('rejects a non-github adapter and an unparseable chat', async () => {
    const resolve = resolverFor(fakeRest({ pages: [{ reviews: [], hasNextPage: false }] }))
    expect((await resolve({ adapter: 'slack-bot' as const, workspace: 'acme/widgets', chat: 'pr:1' })).ok).toBe(false)
    expect((await resolve(req({ chat: 'issue:5' }))).ok).toBe(false)
  })
})
