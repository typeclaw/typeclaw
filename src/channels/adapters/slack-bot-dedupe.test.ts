import { describe, expect, test } from 'bun:test'

import { createSlackDedupe, SLACK_DEDUPE_CAPACITY } from './slack-bot-dedupe'

describe('createSlackDedupe', () => {
  test('first sighting of a (channel, ts) is not a duplicate', () => {
    const dedupe = createSlackDedupe()
    expect(dedupe.check({ channel: 'C0CHANNEL', ts: '1700000000.000100' })).toBeNull()
  })

  test('redelivery with the same (channel, ts) is detected as channel_ts duplicate', () => {
    const dedupe = createSlackDedupe()
    const event = { channel: 'C0CHANNEL', ts: '1700000000.000100' }
    dedupe.mark(event)
    expect(dedupe.check(event)).toBe('channel_ts')
  })

  test('different ts in the same channel is not a duplicate when no client_msg_id is involved', () => {
    const dedupe = createSlackDedupe()
    dedupe.mark({ channel: 'C0CHANNEL', ts: '1700000000.000100' })
    expect(dedupe.check({ channel: 'C0CHANNEL', ts: '1700000000.000200' })).toBeNull()
  })

  test('same ts in different channels is not a duplicate', () => {
    const dedupe = createSlackDedupe()
    dedupe.mark({ channel: 'C0CHANNEL', ts: '1700000000.000100' })
    expect(dedupe.check({ channel: 'C0OTHER', ts: '1700000000.000100' })).toBeNull()
  })

  test('redelivery with the same client_msg_id but different ts is detected as client_msg_id duplicate', () => {
    // given: the production Winky incident — one user gesture surfaced as
    // two `message` events with different `ts` values but the same
    // client_msg_id. This is exactly the case the channel_ts ring cannot
    // catch and the client_msg_id ring exists for.
    const dedupe = createSlackDedupe()
    dedupe.mark({ channel: 'C0CHANNEL', ts: '1778050049.237279', client_msg_id: 'cmid-abc' })
    expect(dedupe.check({ channel: 'C0CHANNEL', ts: '1778050028.175299', client_msg_id: 'cmid-abc' })).toBe(
      'client_msg_id',
    )
  })

  test('client_msg_id takes precedence over channel_ts when both rings would match', () => {
    const dedupe = createSlackDedupe()
    const event = { channel: 'C0CHANNEL', ts: '1700000000.000100', client_msg_id: 'cmid-abc' }
    dedupe.mark(event)
    expect(dedupe.check(event)).toBe('client_msg_id')
  })

  test('empty client_msg_id is treated as absent (falls through to channel_ts)', () => {
    const dedupe = createSlackDedupe()
    dedupe.mark({ channel: 'C0CHANNEL', ts: '1700000000.000100', client_msg_id: '' })
    expect(dedupe.check({ channel: 'C0CHANNEL', ts: '1700000000.000100', client_msg_id: '' })).toBe('channel_ts')
    expect(dedupe.check({ channel: 'C0CHANNEL', ts: '1700000000.000200', client_msg_id: '' })).toBeNull()
  })

  test('mark is idempotent — re-marking the same event does not displace older entries', () => {
    const dedupe = createSlackDedupe(2)
    const e1 = { channel: 'C0', ts: 't1', client_msg_id: 'cmid-1' }
    const e2 = { channel: 'C0', ts: 't2', client_msg_id: 'cmid-2' }
    dedupe.mark(e1)
    dedupe.mark(e1)
    dedupe.mark(e2)
    expect(dedupe.check(e1)).toBe('client_msg_id')
    expect(dedupe.check(e2)).toBe('client_msg_id')
  })

  test('ring evicts oldest entries past capacity, on each ring independently', () => {
    // given: capacity 2 on each ring
    const dedupe = createSlackDedupe(2)
    dedupe.mark({ channel: 'C0', ts: 't1', client_msg_id: 'cmid-1' })
    dedupe.mark({ channel: 'C0', ts: 't2', client_msg_id: 'cmid-2' })
    // when: a third unique event evicts t1/cmid-1
    dedupe.mark({ channel: 'C0', ts: 't3', client_msg_id: 'cmid-3' })
    // then: the evicted entry is no longer detected as a duplicate
    expect(dedupe.check({ channel: 'C0', ts: 't1', client_msg_id: 'cmid-1' })).toBeNull()
    expect(dedupe.check({ channel: 'C0', ts: 't2', client_msg_id: 'cmid-2' })).toBe('client_msg_id')
    expect(dedupe.check({ channel: 'C0', ts: 't3', client_msg_id: 'cmid-3' })).toBe('client_msg_id')
  })

  test('default capacity matches the published constant', () => {
    expect(SLACK_DEDUPE_CAPACITY).toBe(256)
  })
})
