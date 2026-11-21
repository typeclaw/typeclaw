import { describe, expect, test } from 'bun:test'

import { CodemodeCell } from './cell'
import { CODEMODE_LIMITS, CodemodeError } from './protocol'

describe('codemode cell request leases', () => {
  test('an old cell identifier cannot dispatch a tool', () => {
    let calls = 0
    const cell = new CodemodeCell(async () => {
      calls += 1
    }, new AbortController().signal)
    expect(() =>
      cell.receive(
        {
          type: 'tool-call',
          cellId: 'stale',
          id: 'one',
          name: 'read',
          args: {},
        },
        () => {},
      ),
    ).toThrow(CodemodeError)
    expect(calls).toBe(0)
  })

  test('duplicate call identifiers cannot execute twice', async () => {
    let calls = 0
    const sent = Promise.withResolvers<void>()
    const cell = new CodemodeCell(async () => {
      calls += 1
      return 'value'
    }, new AbortController().signal)
    const request = { type: 'tool-call', cellId: cell.id, id: 'one', name: 'read', args: {} } as const
    cell.receive(request, () => sent.resolve())
    await sent.promise
    expect(() => cell.receive(request, () => {})).toThrow(CodemodeError)
    expect(calls).toBe(1)
  })

  test('concurrency is bounded independently of the child parallel helper', async () => {
    let calls = 0
    const release = Promise.withResolvers<void>()
    const cell = new CodemodeCell(async () => {
      calls += 1
      await release.promise
      return null
    }, new AbortController().signal)
    for (let id = 0; id < CODEMODE_LIMITS.concurrency; id++) {
      cell.receive({ type: 'tool-call', cellId: cell.id, id: String(id), name: 'read', args: {} }, () => {})
    }
    expect(() =>
      cell.receive(
        {
          type: 'tool-call',
          cellId: cell.id,
          id: 'extra',
          name: 'read',
          args: {},
        },
        () => {},
      ),
    ).toThrow(CodemodeError)
    expect(calls).toBe(CODEMODE_LIMITS.concurrency)
    release.resolve()
    cell.receive({ type: 'done', cellId: cell.id }, () => {})
    await cell.completed.promise
  })

  test('a completed cell cannot start another tool', async () => {
    const cell = new CodemodeCell(async () => null, new AbortController().signal)
    cell.receive({ type: 'done', cellId: cell.id }, () => {})
    await cell.completed.promise
    expect(() =>
      cell.receive(
        {
          type: 'tool-call',
          cellId: cell.id,
          id: 'late',
          name: 'read',
          args: {},
        },
        () => {},
      ),
    ).toThrow(CodemodeError)
  })
})
