import { describe, expect, test } from 'bun:test'

import { ensureExcluded, type ExclusionList, RETRY_DELAYS_MS, runHelper } from './helper'

const noSleep = async () => {}

function fakeList(initial: string[], { applyAfterSets = 1 } = {}): ExclusionList & { sets: number } {
  const entries = [...initial]
  const api = {
    sets: 0,
    list: () => [...entries],
    set: (path: string) => {
      api.sets++
      if (api.sets >= applyAfterSets && !entries.includes(path)) entries.push(path)
    },
  }
  return api
}

describe('ensureExcluded', () => {
  test('leaves an already-excluded folder alone', async () => {
    const api = fakeList(['/Users/alice/agent'])

    expect(await ensureExcluded('/Users/alice/agent', api, noSleep)).toEqual({ ok: true, state: 'excluded' })
    expect(api.sets).toBe(0)
  })

  test('retries until Spotlight records a dropped request', async () => {
    const api = fakeList([], { applyAfterSets: 3 })

    expect(await ensureExcluded('/Users/alice/agent', api, noSleep)).toEqual({ ok: true, state: 'newly-excluded' })
    expect(api.sets).toBe(3)
  })

  test('reports not-applied once every retry is spent', async () => {
    const api = fakeList([], { applyAfterSets: Number.POSITIVE_INFINITY })

    const result = await ensureExcluded('/Users/alice/agent', api, noSleep)

    expect(result).toEqual({ ok: false, code: 'not-applied', detail: expect.any(String) })
    expect(api.sets).toBe(RETRY_DELAYS_MS.length)
  })
})

describe('runHelper', () => {
  test('rejects a relative or missing directory', async () => {
    expect(await runHelper(['ensure', 'agent'], () => fakeList([]))).toMatchObject({ ok: false, code: 'bad-request' })
    expect(await runHelper(['check'], () => fakeList([]))).toMatchObject({ ok: false, code: 'bad-request' })
    expect(await runHelper(['remove', '/a'], () => fakeList([]))).toMatchObject({ ok: false, code: 'bad-request' })
  })

  test('reports unavailable when the private symbols cannot be bound', async () => {
    const result = await runHelper(['check', '/a'], () => {
      throw new Error('symbol _MDSetExclusion not found')
    })

    expect(result).toEqual({ ok: false, code: 'unavailable', detail: 'symbol _MDSetExclusion not found' })
  })

  test('reports unavailable when the list call returns something unexpected', async () => {
    const result = await runHelper(['check', '/a'], () => ({
      list: () => {
        throw new Error('_MDCopyExclusionList did not return a CFArray')
      },
      set: () => {},
    }))

    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
  })

  test('reports unavailable when setting throws mid-ensure', async () => {
    const result = await runHelper(['ensure', '/a'], () => ({
      list: () => [],
      set: () => {
        throw new Error('could not encode the path as a CFString')
      },
    }))

    expect(result).toMatchObject({ ok: false, code: 'unavailable' })
  })

  test('check reports membership without changing the list', async () => {
    const api = fakeList(['/a'])

    expect(await runHelper(['check', '/a'], () => api)).toEqual({ ok: true, state: 'excluded' })
    expect(await runHelper(['check', '/b'], () => api)).toEqual({ ok: true, state: 'not-excluded' })
    expect(api.sets).toBe(0)
  })
})
