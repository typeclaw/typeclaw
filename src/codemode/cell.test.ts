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

  test('calls past the concurrency cap wait for a free slot instead of failing', async () => {
    // given more calls than the cap, each held until released
    const total = CODEMODE_LIMITS.concurrency + 2
    const started = Array.from({ length: total }, () => Promise.withResolvers<void>())
    const releases = Array.from({ length: total }, () => Promise.withResolvers<void>())
    let calls = 0
    const results: string[] = []
    const cell = new CodemodeCell(async () => {
      const index = calls++
      started[index]!.resolve()
      await releases[index]!.promise
      return index
    }, new AbortController().signal)

    // when every call arrives at once
    for (let id = 0; id < total; id++) {
      cell.receive({ type: 'tool-call', cellId: cell.id, id: String(id), name: 'read', args: {} }, (frame) => {
        if (frame.type === 'tool-result') results.push(frame.id)
      })
    }
    await Promise.all(started.slice(0, CODEMODE_LIMITS.concurrency).map((turn) => turn.promise))

    // then only the cap dispatches until a slot frees, and every call still completes
    expect(calls).toBe(CODEMODE_LIMITS.concurrency)
    releases[0]!.resolve()
    await started[CODEMODE_LIMITS.concurrency]!.promise
    expect(calls).toBe(CODEMODE_LIMITS.concurrency + 1)
    for (const release of releases) release.resolve()
    cell.receive({ type: 'done', cellId: cell.id }, () => {})
    await cell.completed.promise
    expect(results).toHaveLength(total)
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
