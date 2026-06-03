import { describe, expect, it } from 'bun:test'

import type { SubmitReviewRequest } from '@/channels/types'

import { createGithubReviewSubmitter } from './review-submitter'

type SeenPost = { event: string; body: string; commit_id: string; comments: unknown[] }

function fakeGithub(options: {
  patch?: string
  postStatus?: number
  reviews?: Array<{ id: number; state: string }>
  seen?: { posts: SeenPost[] }
}) {
  return Object.assign(
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = String(url)
      const method = init?.method ?? 'GET'
      if (method === 'GET' && href.endsWith('/pulls/7')) {
        return json({ head: { sha: 'head-sha' } })
      }
      if (method === 'GET' && href.endsWith('/pulls/7/files?per_page=100')) {
        return json([
          { filename: 'src/app.ts', patch: options.patch ?? '@@ -1,3 +1,4 @@\n const a = 1\n-old()\n+new()\n+added()' },
        ])
      }
      if (method === 'POST' && href.endsWith('/pulls/7/reviews')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as SeenPost
        options.seen?.posts.push(body)
        return json({ id: 123, state: body.event === 'APPROVE' ? 'APPROVED' : 'COMMENTED' }, options.postStatus ?? 200)
      }
      if (method === 'GET' && href.endsWith('/pulls/7/reviews')) {
        return json(options.reviews ?? [{ id: 456, state: 'COMMENTED' }])
      }
      return new Response('missing route', { status: 404 })
    },
    { preconnect: () => {} },
  )
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function req(overrides: Partial<SubmitReviewRequest> = {}): SubmitReviewRequest {
  return {
    adapter: 'github',
    workspace: 'acme/widgets',
    chat: 'pr:7',
    event: 'COMMENT',
    body: 'summary',
    comments: [{ path: 'src/app.ts', line: 3, body: 'inline' }],
    ...overrides,
  }
}

function submitter(fetchImpl: typeof fetch, allowApprove = true) {
  return createGithubReviewSubmitter({ token: async () => 'tok', allowApprove: () => allowApprove, fetchImpl })
}

describe('github review submitter', () => {
  it('passes in-diff comments through as inline review comments', async () => {
    const seen = { posts: [] as SeenPost[] }
    const result = await submitter(fakeGithub({ seen }))(req())

    expect(result.ok).toBe(true)
    expect(seen.posts[0]?.comments).toEqual([{ path: 'src/app.ts', line: 3, side: 'RIGHT', body: 'inline' }])
  })

  it('demotes out-of-diff comments into the body and reports reanchored findings', async () => {
    const seen = { posts: [] as SeenPost[] }
    const bad = { path: 'src/app.ts', line: 99, body: 'not in diff' }
    const result = await submitter(fakeGithub({ seen }))(req({ comments: [bad] }))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.reanchored).toEqual([bad])
    expect(seen.posts[0]?.comments).toEqual([])
    expect(seen.posts[0]?.body).toContain('src/app.ts:99')
    expect(seen.posts[0]?.body).toContain('not in diff')
  })

  it('downgrades APPROVE to COMMENT when approval is disabled', async () => {
    const seen = { posts: [] as SeenPost[] }
    const result = await submitter(fakeGithub({ seen }), false)(req({ event: 'APPROVE' }))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.downgraded).toBe(true)
    expect(seen.posts[0]?.event).toBe('COMMENT')
  })

  it('keeps APPROVE when approval is enabled', async () => {
    const seen = { posts: [] as SeenPost[] }
    const result = await submitter(fakeGithub({ seen }), true)(req({ event: 'APPROVE' }))

    expect(result.ok).toBe(true)
    expect(seen.posts[0]?.event).toBe('APPROVE')
  })

  it('classifies 403 as permission-denied', async () => {
    const result = await submitter(fakeGithub({ postStatus: 403 }))(req())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('permission-denied')
  })

  it('returns the verified last review id and state after write', async () => {
    const result = await submitter(fakeGithub({ reviews: [{ id: 789, state: 'CHANGES_REQUESTED' }] }))(
      req({ event: 'REQUEST_CHANGES' }),
    )

    expect(result).toEqual({ ok: true, reviewId: 789, state: 'CHANGES_REQUESTED' })
  })

  it('rejects bad workspace/chat targets before posting', async () => {
    const seen = { posts: [] as SeenPost[] }
    const submit = submitter(fakeGithub({ seen }))

    for (const bad of [req({ workspace: 'acme' }), req({ chat: 'issue:7' }), req({ chat: 'pr:1e2' })]) {
      const result = await submit(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('transient')
    }
    expect(seen.posts).toEqual([])
  })
})
