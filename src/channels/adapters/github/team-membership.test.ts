import { describe, expect, it } from 'bun:test'

import { createTeamMembershipChecker } from './team-membership'

describe('createTeamMembershipChecker', () => {
  it.each([403, 404])('current membership treats %s as no qualifying membership', async (status) => {
    // #given
    let response = () => Response.json({ state: 'active' })
    const check = createTeamMembershipChecker({ token: async () => 'tok', fetchImpl: fakeFetch(() => response()) })
    const team = { org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' }
    expect(await check(team)).toBe(true)

    // #when
    response = () => new Response(null, { status })

    // #then
    expect(await check({ ...team, requireCurrent: true })).toBe(false)
    response = () => Response.json({ state: 'active' })
    expect(await check({ ...team, requireCurrent: true })).toBe(true)
  })

  it('current membership reads bypass cached absence and retry failures', async () => {
    // #given
    let response = () => new Response(null, { status: 404 })
    const check = createTeamMembershipChecker({
      token: async () => 'tok',
      fetchImpl: fakeFetch(() => response()),
    })
    const team = { org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' }
    expect(await check(team)).toBe(false)

    // #when
    response = () => new Response('unavailable', { status: 503 })

    // #then
    await expect(check({ ...team, requireCurrent: true })).rejects.toThrow('503')
    response = () => Response.json({ state: 'active' })
    expect(await check({ ...team, requireCurrent: true })).toBe(true)
  })

  it.each([
    () => {
      throw new Error('network unavailable')
    },
    () => new Response('{'),
    () => Response.json({}),
    () => Response.json({ state: 'unknown' }),
  ])('current membership read failures remain retryable', async (response) => {
    // #given
    const check = createTeamMembershipChecker({ token: async () => 'tok', fetchImpl: fakeFetch(response) })

    // #when
    const result = check({ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot', requireCurrent: true })

    // #then
    await expect(result).rejects.toThrow()
  })

  it('returns true for an active membership', async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ state: 'active' }), { status: 200 }))
    const check = createTeamMembershipChecker({ token: async () => 'tok', fetchImpl })
    expect(await check({ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' })).toBe(true)
  })

  it('returns false for a pending (non-active) membership', async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ state: 'pending' }), { status: 200 }))
    const check = createTeamMembershipChecker({ token: async () => 'tok', fetchImpl })
    expect(await check({ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' })).toBe(false)
  })

  it('returns false on 404 (not a member)', async () => {
    const fetchImpl = fakeFetch(() => new Response('', { status: 404 }))
    const check = createTeamMembershipChecker({ token: async () => 'tok', fetchImpl })
    expect(await check({ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' })).toBe(false)
  })

  it('returns false on network error (fail-closed)', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error('boom')
    })
    const check = createTeamMembershipChecker({ token: async () => 'tok', fetchImpl })
    expect(await check({ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' })).toBe(false)
  })

  it('caches results across calls', async () => {
    let calls = 0
    const fetchImpl = fakeFetch(() => {
      calls++
      return new Response(JSON.stringify({ state: 'active' }), { status: 200 })
    })
    const check = createTeamMembershipChecker({ token: async () => 'tok', fetchImpl })
    await check({ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' })
    await check({ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' })
    expect(calls).toBe(1)
  })

  it('caches per (org, slug, login) tuple', async () => {
    let calls = 0
    const fetchImpl = fakeFetch(() => {
      calls++
      return new Response(JSON.stringify({ state: 'active' }), { status: 200 })
    })
    const check = createTeamMembershipChecker({ token: async () => 'tok', fetchImpl })
    await check({ org: 'acme', slug: 'reviewers', login: 'typeclaw-bot' })
    await check({ org: 'acme', slug: 'maintainers', login: 'typeclaw-bot' })
    expect(calls).toBe(2)
  })
})

function fakeFetch(impl: () => Response | Promise<Response>): typeof fetch {
  const fn = async (): Promise<Response> => impl()
  return fn as unknown as typeof fetch
}
