import { expect } from 'bun:test'

import type { BundledProbe, BundledProbeContext } from '../types'

export const params = { repo: 'acme/widgets', number: 12 }
export const startedAt = Date.parse('2026-01-02T00:00:00Z')

export const connection = <T>(...nodes: T[]) => ({ nodes })

export function comment(id: string, day: number, login = 'alice', viewerDidAuthor = false) {
  return { id, createdAt: `2026-01-0${day}T00:00:00Z`, author: { login, __typename: 'User' }, viewerDidAuthor }
}

export function fixtureProbe(
  probe: BundledProbe<typeof params>,
  field: string,
  options: Partial<BundledProbeContext<typeof params>> = {},
) {
  const signal = new AbortController().signal
  let state: unknown
  return async (target: unknown) => {
    let requests = 0
    const fakeFetch: typeof fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        requests++
        expect(String(url)).toBe('https://api.github.com/graphql')
        expect(init?.method).toBe('POST')
        expect(init?.signal).toBe(signal)
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture')
        expect(JSON.parse(String(init?.body))).toMatchObject({
          variables: { owner: 'acme', name: 'widgets', number: 12 },
        })
        return target instanceof Response ? target : Response.json({ data: { repository: { [field]: target } } })
      },
      { preconnect: fetch.preconnect },
    )
    const result = await probe.run({
      params,
      state,
      lastRunAt: undefined,
      startedAt,
      resolveTokenForRepo: async (repo) => {
        expect(repo).toBe('acme/widgets')
        return { kind: 'token', token: 'fixture' }
      },
      signal,
      fetch: fakeFetch,
      ...options,
    })
    expect(requests).toBe(1)
    state = JSON.parse(JSON.stringify(result.state))
    return result
  }
}
