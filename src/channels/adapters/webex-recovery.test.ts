import { describe, expect, test } from 'bun:test'

import type { WebexPrefetchLimiter } from './webex-prefetch-limiter'
import {
  WEBEX_RECOVERY_MESSAGE_CAP,
  WEBEX_RECOVERY_SPACE_CAP,
  createWebexRecovery,
  createWebexRecoveryState,
  type WebexInboundRecord,
  type WebexRecoveryMessage,
} from './webex-recovery'

const gapStart = Date.parse('2026-01-01T00:00:10.000Z')
const gapEnd = Date.parse('2026-01-01T00:00:20.000Z')

function message(ref: string, created: string, roomRef = 'room-1'): WebexRecoveryMessage {
  return {
    id: `${ref}-id`,
    ref,
    roomId: `${roomRef}-id`,
    roomRef,
    roomType: 'group',
    personId: 'person-id',
    personRef: 'person-ref',
    personEmail: 'person@example.com',
    text: ref,
    created,
    files: [],
  }
}

function liveMessage(ref: string, created: string, roomRef = 'room-1'): WebexInboundRecord {
  return {
    ...message(ref, created, roomRef),
    roomType: undefined,
    text: ref,
    mentionedPeople: [],
    mentionedPeopleRefs: [],
    mentionedGroups: [],
    files: [],
    raw: {},
  }
}

describe('Webex reconnect recovery', () => {
  test('commits an accepted in-flight handle before final shutdown releases leftovers', async () => {
    const state = createWebexRecoveryState()
    const handling = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const first = createWebexRecovery({
      state,
      client: { listSpaces: async () => [], listMessages: async () => [] },
      handleMessage: async () => {
        handling.resolve()
        await release.promise
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
    })

    const accepted = first.routeLive(liveMessage('accepted', '2026-01-01T00:00:15.000Z'))
    await handling.promise
    first.stop()
    const finalized = first.finishStop()
    release.resolve()
    await Promise.all([accepted, finalized])

    let duplicateHandled = false
    const replacement = createWebexRecovery({
      state,
      client: { listSpaces: async () => [], listMessages: async () => [] },
      handleMessage: async () => {
        duplicateHandled = true
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
    })
    await replacement.routeLive(liveMessage('accepted', '2026-01-01T00:00:15.000Z'))

    expect(duplicateHandled).toBe(false)
  })

  test('releases a stale tentative live claim so a replacement can handle the same ref', async () => {
    const state = createWebexRecoveryState()
    const firstHandling = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    let firstCurrent = true
    const routed: string[] = []
    const first = createWebexRecovery({
      state,
      client: { listSpaces: async () => [], listMessages: async () => [] },
      handleMessage: async () => {
        firstHandling.resolve()
        await releaseFirst.promise
        return 'retryable' as const
      },
      isCurrent: () => firstCurrent,
      isConnected: () => true,
      logger: { warn: () => {} },
    })

    const stale = first.routeLive(liveMessage('same-ref', '2026-01-01T00:00:15.000Z'))
    await firstHandling.promise
    firstCurrent = false
    first.stop()
    releaseFirst.resolve()
    await stale

    const replacement = createWebexRecovery({
      state,
      client: { listSpaces: async () => [], listMessages: async () => [] },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
    })
    await replacement.routeLive(liveMessage('same-ref', '2026-01-01T00:00:15.000Z'))

    expect(routed).toEqual(['same-ref'])
  })

  test('keeps successful and intentional-drop outcomes deduped across replacement', async () => {
    const state = createWebexRecoveryState()
    const handled: string[] = []
    const first = createWebexRecovery({
      state,
      client: { listSpaces: async () => [], listMessages: async () => [] },
      handleMessage: async (event) => {
        handled.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
    })
    await first.routeLive(liveMessage('routed', '2026-01-01T00:00:15.000Z'))
    await first.routeLive(liveMessage('dropped', '2026-01-01T00:00:16.000Z'))
    first.stop()

    const replacement = createWebexRecovery({
      state,
      client: { listSpaces: async () => [], listMessages: async () => [] },
      handleMessage: async (event) => {
        handled.push(`duplicate-${event.ref}`)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
    })
    await replacement.routeLive(liveMessage('routed', '2026-01-01T00:00:15.000Z'))
    await replacement.routeLive(liveMessage('dropped', '2026-01-01T00:00:16.000Z'))

    expect(handled).toEqual(['routed', 'dropped'])
  })

  test('shares the uncancellable-read barrier across coordinators while live remains free', async () => {
    const state = createWebexRecoveryState()
    const oldSpaces = Promise.withResolvers<Array<{ id: string; type: 'group'; lastActivity: string }>>()
    let replacementReads = 0
    const old = createWebexRecovery({
      state,
      client: { listSpaces: async () => oldSpaces.promise, listMessages: async () => [] },
      handleMessage: async () => 'committed' as const,
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
      retryDelaysMs: [],
      scheduleTimeout: (_ms, onTimeout) => {
        queueMicrotask(onTimeout)
        return () => {}
      },
    })
    old.markDisconnected(gapStart)
    await old.recover()
    old.stop()

    const routed: string[] = []
    const replacement = createWebexRecovery({
      state,
      client: {
        listSpaces: async () => {
          replacementReads++
          return []
        },
        listMessages: async () => [],
      },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
    })
    const pendingRecovery = replacement.recover()
    await replacement.routeLive(liveMessage('live', '2026-01-01T00:00:19.000Z'))
    expect(replacementReads).toBe(0)
    expect(routed).toEqual(['live'])

    oldSpaces.resolve([])
    await pendingRecovery
    expect(replacementReads).toBe(1)
  })

  test('does not start a second read on rapid reconnect until the interrupted read settles', async () => {
    const oldSpaces = Promise.withResolvers<Array<{ id: string; type: 'group'; lastActivity: string }>>()
    let connected = true
    let reads = 0
    const recovery = createWebexRecovery({
      client: {
        listSpaces: async () => {
          reads++
          if (reads === 1) return oldSpaces.promise
          return []
        },
        listMessages: async () => [],
      },
      handleMessage: async () => 'committed' as const,
      isCurrent: () => true,
      isConnected: () => connected,
      logger: { warn: () => {} },
    })

    recovery.markDisconnected(gapStart)
    const first = recovery.recover()
    connected = false
    recovery.markDisconnected(gapStart - 1_000)
    connected = true
    void recovery.recover()
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toBe(1)

    oldSpaces.resolve([])
    await first
    await recovery.recover()
    expect(reads).toBe(2)
  })

  test('lets recovered data claim a ref before a gated live duplicate', async () => {
    const messages = Promise.withResolvers<WebexRecoveryMessage[]>()
    const readStarted = Promise.withResolvers<void>()
    const handledTexts: string[] = []
    const recovery = createWebexRecovery({
      client: {
        listSpaces: async () => [{ id: 'room-1', type: 'group', lastActivity: '2026-01-01T00:00:19.000Z' }],
        listMessages: async () => {
          readStarted.resolve()
          return messages.promise
        },
      },
      handleMessage: async (event) => {
        handledTexts.push(event.text)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
      now: () => gapEnd,
      overlapMs: 0,
    })

    recovery.markDisconnected(gapStart)
    const recovering = recovery.recover()
    await readStarted.promise
    const live = recovery.routeLive({
      ...liveMessage('same-ref', '2026-01-01T00:00:19.000Z'),
      text: 'live',
    })
    messages.resolve([{ ...message('same-ref', '2026-01-01T00:00:15.000Z'), text: 'backfill' }])
    await Promise.all([recovering, live])

    expect(handledTexts).toEqual(['backfill'])
  })

  test('restores a stale gated live message gap for replacement backfill', async () => {
    const state = createWebexRecoveryState()
    const messages = Promise.withResolvers<WebexRecoveryMessage[]>()
    const readStarted = Promise.withResolvers<void>()
    const liveStarted = Promise.withResolvers<void>()
    const releaseLive = Promise.withResolvers<void>()
    let current = true
    const first = createWebexRecovery({
      state,
      client: {
        listSpaces: async () => [{ id: 'room-1', type: 'group', lastActivity: '2026-01-01T00:00:19.000Z' }],
        listMessages: async () => {
          readStarted.resolve()
          return messages.promise
        },
      },
      handleMessage: async () => {
        liveStarted.resolve()
        await releaseLive.promise
        return 'retryable' as const
      },
      isCurrent: () => current,
      isConnected: () => true,
      logger: { warn: () => {} },
      now: () => gapEnd,
      overlapMs: 1_000,
    })

    first.markDisconnected(gapStart)
    const recovering = first.recover()
    await readStarted.promise
    const live = first.routeLive(liveMessage('stale-live', '2026-01-01T00:00:19.000Z'))
    messages.resolve([])
    await recovering
    await liveStarted.promise
    current = false
    first.stop()
    releaseLive.resolve()
    await live

    const routed: string[] = []
    const replacement = createWebexRecovery({
      state,
      client: {
        listSpaces: async () => [{ id: 'room-1', type: 'group', lastActivity: '2026-01-01T00:00:19.000Z' }],
        listMessages: async () => [message('stale-live', '2026-01-01T00:00:19.000Z')],
      },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
      now: () => gapEnd,
      overlapMs: 1_000,
    })
    await replacement.recover()

    expect(routed).toEqual(['stale-live'])
  })

  test('hands pending gap and bounded dedupe to a replacement coordinator', async () => {
    const state = createWebexRecoveryState({ dedupeCapacity: 2 })
    let firstCurrent = true
    const oldSpaces = Promise.withResolvers<Array<{ id: string; type: 'group'; lastActivity: string }>>()
    const routed: string[] = []
    const first = createWebexRecovery({
      state,
      client: { listSpaces: async () => oldSpaces.promise, listMessages: async () => [] },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => firstCurrent,
      isConnected: () => true,
      logger: { warn: () => {} },
      now: () => gapEnd,
      overlapMs: 0,
    })
    await first.routeLive(liveMessage('already-live', '2026-01-01T00:00:09.000Z'))
    first.markDisconnected(gapStart)
    const oldFlight = first.recover()
    firstCurrent = false
    first.stop()
    await oldFlight

    const second = createWebexRecovery({
      state,
      client: {
        listSpaces: async () => [{ id: 'room-1', type: 'group', lastActivity: '2026-01-01T00:00:19.000Z' }],
        listMessages: async () => [
          message('already-live', '2026-01-01T00:00:12.000Z'),
          message('missed', '2026-01-01T00:00:15.000Z'),
        ],
      },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
      now: () => gapEnd,
      overlapMs: 0,
    })
    const replacementRecovery = second.recover()
    oldSpaces.resolve([])
    await replacementRecovery

    expect(routed).toEqual(['already-live', 'missed'])
  })

  test('reconnecting interrupts a pending pass and immediately releases live traffic', async () => {
    const oldSpaces = Promise.withResolvers<Array<{ id: string; type: 'group'; lastActivity: string }>>()
    const oldReadSettled = Promise.withResolvers<void>()
    const routed: string[] = []
    let connected = true
    let spaceReads = 0
    const recovery = createWebexRecovery({
      client: {
        listSpaces: async () => {
          spaceReads++
          if (spaceReads === 1) {
            const value = await oldSpaces.promise
            oldReadSettled.resolve()
            return value
          }
          return [{ id: 'room-1', type: 'group', lastActivity: '2026-01-01T00:00:19.000Z' }]
        },
        listMessages: async () => [message('missed', '2026-01-01T00:00:09.500Z')],
      },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => connected,
      logger: { warn: () => {} },
      now: () => gapEnd,
      overlapMs: 0,
    })

    recovery.markDisconnected(gapStart)
    const first = recovery.recover()
    const live = recovery.routeLive(liveMessage('live', '2026-01-01T00:00:19.000Z'))
    connected = false
    recovery.markDisconnected(gapStart - 1_000)
    await live
    expect(routed).toEqual(['live'])
    oldSpaces.resolve([])
    await first

    await oldReadSettled.promise
    await Promise.resolve()
    connected = true
    await recovery.recover()
    expect(routed).toEqual(['live', 'missed'])
  })

  test('bounds REST reads, filters the gap, and routes globally oldest-first', async () => {
    const calls: Array<[string, unknown]> = []
    const routed: string[] = []
    const recovery = createWebexRecovery({
      client: {
        listSpaces: async (options) => {
          calls.push(['spaces', options])
          return [
            { id: 'room-1', type: 'group', lastActivity: '2026-01-01T00:00:19.000Z' },
            { id: 'room-2', type: 'group', lastActivity: '2026-01-01T00:00:18.000Z' },
            { id: 'old-room', type: 'group', lastActivity: '2026-01-01T00:00:01.000Z' },
            { id: 'invalid-room', type: 'group', lastActivity: 'not-a-date' },
          ]
        },
        listMessages: async (roomId, options) => {
          calls.push([roomId, options])
          if (roomId === 'room-1') {
            return [
              message('too-new', '2026-01-01T00:00:21.000Z'),
              message('newer', '2026-01-01T00:00:18.000Z'),
              message('too-old', '2026-01-01T00:00:09.999Z'),
            ]
          }
          return [message('older', '2026-01-01T00:00:12.000Z', 'room-2')]
        },
      },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
      now: () => gapEnd,
      overlapMs: 0,
    })

    recovery.markDisconnected(gapStart)
    await recovery.recover()

    expect(calls).toEqual([
      ['spaces', { max: WEBEX_RECOVERY_SPACE_CAP }],
      ['room-1', { max: WEBEX_RECOVERY_MESSAGE_CAP }],
      ['room-2', { max: WEBEX_RECOVERY_MESSAGE_CAP }],
    ])
    expect(routed).toEqual(['older', 'newer'])
  })

  test('enforces space and per-space message caps when the client over-returns', async () => {
    const spaces = Array.from({ length: WEBEX_RECOVERY_SPACE_CAP + 2 }, (_, index) => ({
      id: `room-${index}`,
      type: 'group' as const,
      lastActivity: '2026-01-01T00:00:19.000Z',
    }))
    const roomReads: string[] = []
    const routed: string[] = []
    const recovery = createWebexRecovery({
      client: {
        listSpaces: async () => spaces,
        listMessages: async (roomId) => {
          roomReads.push(roomId)
          return Array.from({ length: WEBEX_RECOVERY_MESSAGE_CAP + 2 }, (_, index) =>
            message(`${roomId}-message-${index}`, '2026-01-01T00:00:15.000Z', roomId),
          )
        },
      },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
      now: () => gapEnd,
      overlapMs: 0,
    })

    recovery.markDisconnected(gapStart)
    await recovery.recover()

    expect(roomReads).toHaveLength(WEBEX_RECOVERY_SPACE_CAP)
    expect(roomReads.at(-1)).toBe(`room-${WEBEX_RECOVERY_SPACE_CAP - 1}`)
    expect(routed).toHaveLength(WEBEX_RECOVERY_SPACE_CAP * WEBEX_RECOVERY_MESSAGE_CAP)
    expect(routed).not.toContain(`room-0-message-${WEBEX_RECOVERY_MESSAGE_CAP}`)
  })

  test('keeps one flight and restores the earliest gap when the socket drops during a pending read', async () => {
    let connected = true
    let spaceCalls = 0
    const firstRead = Promise.withResolvers<Array<{ id: string; type: 'group'; lastActivity: string }>>()
    const routed: string[] = []
    const recovery = createWebexRecovery({
      client: {
        listSpaces: async () => {
          spaceCalls++
          if (spaceCalls === 1) return firstRead.promise
          return [{ id: 'room-1', type: 'group', lastActivity: '2026-01-01T00:00:19.000Z' }]
        },
        listMessages: async () => [message('earliest', '2026-01-01T00:00:09.500Z')],
      },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => connected,
      logger: { warn: () => {} },
      now: () => gapEnd,
      overlapMs: 0,
    })

    recovery.markDisconnected(gapStart)
    const first = recovery.recover()
    const concurrent = recovery.recover()
    await Promise.resolve()
    expect(spaceCalls).toBe(1)

    connected = false
    recovery.markDisconnected(gapStart - 1_000)
    firstRead.resolve([])
    await Promise.all([first, concurrent])

    connected = true
    await recovery.recover()
    expect(spaceCalls).toBe(2)
    expect(routed).toEqual(['earliest'])
  })

  test('retries failures finitely, releases live traffic during backoff, and retains the gap after exhaustion', async () => {
    const delays: number[] = []
    const backoffStarted = Promise.withResolvers<void>()
    const releaseBackoff = Promise.withResolvers<void>()
    const warnings: string[] = []
    const routed: string[] = []
    let fail = true
    let spaceCalls = 0
    const recovery = createWebexRecovery({
      client: {
        listSpaces: async () => {
          spaceCalls++
          if (fail) throw new Error('spaces unavailable')
          return [{ id: 'room-1', type: 'group', lastActivity: '2026-01-01T00:00:19.000Z' }]
        },
        listMessages: async () => [message('recovered-later', '2026-01-01T00:00:15.000Z')],
      },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: (line) => warnings.push(line) },
      now: () => gapEnd,
      overlapMs: 0,
      retryDelaysMs: [10, 20],
      scheduleTimeout: () => () => {},
      delay: async (ms) => {
        delays.push(ms)
        if (delays.length === 1) {
          backoffStarted.resolve()
          await releaseBackoff.promise
        }
      },
    })

    recovery.markDisconnected(gapStart)
    const exhausted = recovery.recover()
    await Promise.race([
      backoffStarted.promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('backoff did not start')), 100)),
    ])
    await recovery.routeLive(liveMessage('live-during-backoff', '2026-01-01T00:00:19.000Z'))
    expect(routed).toEqual(['live-during-backoff'])
    releaseBackoff.resolve()
    await Promise.race([
      exhausted,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('retries did not exhaust')), 100)),
    ])

    expect(spaceCalls).toBe(3)
    expect(delays).toEqual([10, 20])
    expect(warnings.some((line) => line.includes('exhausted'))).toBe(true)

    fail = false
    await recovery.recover()
    expect(spaceCalls).toBe(4)
    expect(routed).toEqual(['live-during-backoff', 'recovered-later'])
  })

  test('treats limiter admission failure as retryable and visible', async () => {
    let admissions = 0
    let messageReads = 0
    const warnings: string[] = []
    const routed: string[] = []
    const limiter: WebexPrefetchLimiter = {
      run: async (_room, work) => {
        admissions++
        if (admissions === 1) return { admitted: false }
        return { admitted: true, value: await work() }
      },
    }
    const recovery = createWebexRecovery({
      client: {
        listSpaces: async () => [{ id: 'room-1', type: 'group', lastActivity: '2026-01-01T00:00:19.000Z' }],
        listMessages: async () => {
          messageReads++
          return [message('after-admission', '2026-01-01T00:00:15.000Z')]
        },
      },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: (line) => warnings.push(line) },
      limiter,
      now: () => gapEnd,
      overlapMs: 0,
      retryDelaysMs: [0],
      delay: async () => {},
    })

    recovery.markDisconnected(gapStart)
    await recovery.recover()

    expect(admissions).toBe(2)
    expect(messageReads).toBe(1)
    expect(routed).toEqual(['after-admission'])
    expect(warnings.some((line) => line.includes('admission'))).toBe(true)
  })

  test('keys recovery admission by the decoded room ref used by history prefetch', async () => {
    const roomId = 'Y2lzY29zcGFyazovL3VzL1JPT00vYWFhYWFhYWEtYmJiYi1jY2NjLWRkZGQtZWVlZWVlZWVlZWVl'
    const limiterKeys: string[] = []
    const limiter: WebexPrefetchLimiter = {
      run: async (key, work) => {
        limiterKeys.push(key)
        return { admitted: true, value: await work() }
      },
    }
    const recovery = createWebexRecovery({
      client: {
        listSpaces: async () => [{ id: roomId, type: 'group', lastActivity: '2026-01-01T00:00:19.000Z' }],
        listMessages: async () => [],
      },
      handleMessage: async () => 'committed' as const,
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
      limiter,
      now: () => gapEnd,
      overlapMs: 0,
    })

    recovery.markDisconnected(gapStart)
    await recovery.recover()

    expect(limiterKeys).toEqual(['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'])
  })

  test('routes recovered messages before live messages received during a successful pass', async () => {
    const messages = Promise.withResolvers<WebexRecoveryMessage[]>()
    const readStarted = Promise.withResolvers<void>()
    const routed: string[] = []
    const recovery = createWebexRecovery({
      client: {
        listSpaces: async () => [{ id: 'room-1', type: 'group', lastActivity: '2026-01-01T00:00:19.000Z' }],
        listMessages: async () => {
          readStarted.resolve()
          return messages.promise
        },
      },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
      now: () => gapEnd,
      overlapMs: 0,
    })

    recovery.markDisconnected(gapStart)
    const recovering = recovery.recover()
    await readStarted.promise
    const live = recovery.routeLive(liveMessage('live-newer', '2026-01-01T00:00:19.000Z'))
    await Promise.resolve()
    expect(routed).toEqual([])

    messages.resolve([message('recovered-older', '2026-01-01T00:00:15.000Z')])
    await Promise.all([recovering, live])
    expect(routed).toEqual(['recovered-older', 'live-newer'])
  })

  test('times out a hung pass, releases live traffic, and ignores the late result', async () => {
    const spaces = Promise.withResolvers<Array<{ id: string; type: 'group'; lastActivity: string }>>()
    const routed: string[] = []
    const recovery = createWebexRecovery({
      client: {
        listSpaces: async () => spaces.promise,
        listMessages: async () => [message('late-recovered', '2026-01-01T00:00:15.000Z')],
      },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
      now: () => gapEnd,
      overlapMs: 0,
      retryDelaysMs: [],
      attemptTimeoutMs: 10,
      scheduleTimeout: (_ms, onTimeout) => {
        queueMicrotask(onTimeout)
        return () => {}
      },
    })

    recovery.markDisconnected(gapStart)
    const recovering = recovery.recover()
    const live = recovery.routeLive(liveMessage('live-after-timeout', '2026-01-01T00:00:19.000Z'))
    const liveResult = await Promise.race([
      live.then(() => 'routed'),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 20)),
    ])

    expect(liveResult).toBe('routed')
    await recovering
    spaces.resolve([{ id: 'room-1', type: 'group', lastActivity: '2026-01-01T00:00:19.000Z' }])
    await Promise.resolve()
    expect(routed).toEqual(['live-after-timeout'])
  })

  test('aborts a pass instead of retaining live traffic beyond the gate cap', async () => {
    const spaces = Promise.withResolvers<Array<{ id: string; type: 'group'; lastActivity: string }>>()
    const routed: string[] = []
    const recovery = createWebexRecovery({
      client: {
        listSpaces: async () => spaces.promise,
        listMessages: async () => [],
      },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
      now: () => gapEnd,
      overlapMs: 0,
      retryDelaysMs: [],
      scheduleTimeout: () => () => {},
      liveGateCapacity: 1,
    })

    recovery.markDisconnected(gapStart)
    const recovering = recovery.recover()
    const first = recovery.routeLive(liveMessage('live-one', '2026-01-01T00:00:18.000Z'))
    const second = recovery.routeLive(liveMessage('live-two', '2026-01-01T00:00:19.000Z'))
    await Promise.all([recovering, first, second])

    expect(routed).toEqual(['live-one', 'live-two'])
    spaces.resolve([])
  })

  test('protects pre-episode refs with a tiny ledger when recovery over-returns', async () => {
    const routed: string[] = []
    const recovered = [
      ...Array.from({ length: WEBEX_RECOVERY_MESSAGE_CAP - 1 }, (_, index) =>
        message(`new-${index}`, '2026-01-01T00:00:12.000Z'),
      ),
      message('pre-seen', '2026-01-01T00:00:14.000Z'),
      message('over-cap-a', '2026-01-01T00:00:15.000Z'),
      message('over-cap-b', '2026-01-01T00:00:16.000Z'),
    ]
    const recovery = createWebexRecovery({
      client: {
        listSpaces: async () => [{ id: 'room-1', type: 'group', lastActivity: '2026-01-01T00:00:19.000Z' }],
        listMessages: async () => recovered,
      },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: () => {} },
      now: () => gapEnd,
      overlapMs: 0,
      dedupeCapacity: 1,
    })

    await recovery.routeLive(liveMessage('pre-seen', '2026-01-01T00:00:09.000Z'))
    recovery.markDisconnected(gapStart)
    await recovery.recover()

    expect(routed).toHaveLength(WEBEX_RECOVERY_MESSAGE_CAP)
    expect(routed[0]).toBe('pre-seen')
    expect(routed).not.toContain('over-cap-a')
    expect(routed.filter((ref) => ref === 'pre-seen')).toHaveLength(1)
  })

  test('warns when spaces or messages reach their API caps', async () => {
    const warnings: string[] = []
    const spaces = Array.from({ length: WEBEX_RECOVERY_SPACE_CAP }, (_, index) => ({
      id: `room-${index}`,
      type: 'group' as const,
      lastActivity: index === 0 ? '2026-01-01T00:00:19.000Z' : '2026-01-01T00:00:01.000Z',
    }))
    const recovery = createWebexRecovery({
      client: {
        listSpaces: async () => spaces,
        listMessages: async () =>
          Array.from({ length: WEBEX_RECOVERY_MESSAGE_CAP }, (_, index) =>
            message(`message-${index}`, '2026-01-01T00:00:15.000Z'),
          ),
      },
      handleMessage: async () => 'committed' as const,
      isCurrent: () => true,
      isConnected: () => true,
      logger: { warn: (line) => warnings.push(line) },
      now: () => gapEnd,
      overlapMs: 0,
    })

    recovery.markDisconnected(gapStart)
    await recovery.recover()

    expect(warnings.some((line) => line.includes('spaces') && line.includes('truncated'))).toBe(true)
    expect(warnings.some((line) => line.includes('room=room-0') && line.includes('truncated'))).toBe(true)
  })

  test('suppresses stale recovery after an async boundary', async () => {
    let current = true
    const spaces = Promise.withResolvers<Array<{ id: string; type: 'group'; lastActivity: string }>>()
    const routed: string[] = []
    const recovery = createWebexRecovery({
      client: {
        listSpaces: async () => spaces.promise,
        listMessages: async () => [],
      },
      handleMessage: async (event) => {
        routed.push(event.ref)
        return 'committed' as const
      },
      isCurrent: () => current,
      isConnected: () => true,
      logger: { warn: () => {} },
      now: () => gapEnd,
      overlapMs: 0,
    })

    recovery.markDisconnected(gapStart)
    const stale = recovery.recover()
    current = false
    spaces.resolve([{ id: 'room-1', type: 'group', lastActivity: '2026-01-01T00:00:15.000Z' }])
    await stale

    expect(routed).toEqual([])
  })
})
