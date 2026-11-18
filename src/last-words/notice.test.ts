import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { OpenDmArgs, OutboundMessage } from '@/channels/types'

import { openRun, readLastWords, recordWords, sealExit, writeLastWords, type LastWordsRun } from './file'
import { sendLastWordsNotice } from './notice'

const DEAD: LastWordsRun = { containerId: 'aaa', startedAt: '2026-11-16T14:25:59.313Z', typeclawVersion: '1.0.0' }
const NOW: LastWordsRun = { containerId: 'bbb', startedAt: '2026-11-18T05:35:29.000Z', typeclawVersion: '1.0.0' }
const at = () => new Date('2026-11-18T05:35:40.000Z')

function agentWithDeath(): string {
  const agentDir = mkdtempSync(join(tmpdir(), 'last-words-notice-'))
  let file = openRun({ version: 1, entries: [] }, DEAD, DEAD.startedAt)
  file = recordWords(
    file,
    DEAD,
    {
      memory: { currentMb: 5980, limitMb: 6144, oomKills: 0, recent: [] },
      runtime: { rssMb: 2482, heapUsedMb: 1155, externalMb: 809 },
      turns: [{ origin: 'channel', key: 'github:acme:pr:279:', startedAt: DEAD.startedAt, tool: 'webfetch' }],
      children: [{ kind: 'readability', rssMb: 314 }],
    },
    '2026-11-18T05:18:31.000Z',
  )
  file = sealExit(
    file,
    {
      containerId: 'a'.repeat(64),
      startedAt: '2026-11-16T14:25:58Z',
      finishedAt: '2026-11-18T05:18:30.1Z',
      exitCode: 137,
      oomKilled: true,
      reason: 'OOM kill (6144 MiB)',
      log: null,
    },
    'hostd',
  )
  writeLastWords(agentDir, openRun(file, NOW, NOW.startedAt))
  return agentDir
}

function fakeRouter(sendOk = true) {
  const sent: OutboundMessage[] = []
  const options: unknown[] = []
  const opened: OpenDmArgs[] = []
  return {
    sent,
    options,
    opened,
    router: {
      send: async (msg: OutboundMessage, opts?: unknown) => {
        sent.push(msg)
        options.push(opts)
        return sendOk ? { ok: true as const } : { ok: false as const, error: 'channel_not_found' }
      },
      openDm: async (_adapter: string, args: OpenDmArgs) => {
        opened.push(args)
        return { ok: true as const, workspace: '@dm', chat: 'D0DM' }
      },
    },
  }
}

describe('sendLastWordsNotice', () => {
  test('direct-messages the previous death once with its cause and last words, then stamps it', async () => {
    const agentDir = agentWithDeath()
    const { router, sent, options, opened } = fakeRouter()
    const target = { adapter: 'slack-bot' as const, user: 'U0OWNER' }

    await sendLastWordsNotice({ agentDir, run: NOW, target: () => target, router, now: at })
    await sendLastWordsNotice({ agentDir, run: NOW, target: () => target, router, now: at })

    expect(opened).toEqual([{ user: 'U0OWNER' }])
    expect(options).toEqual([
      { source: 'system', outputKind: 'meta', transportOnly: true, deliverIf: expect.any(Function) },
    ])
    expect(sent[0]?.text).not.toContain('github:acme')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ adapter: 'slack-bot', workspace: '@dm', chat: 'D0DM' })
    expect(sent[0]?.text).toBe(
      [
        'I stopped unexpectedly at 2026-11-18 05:18 UTC and have restarted.',
        'Cause: OOM kill (6144 MiB)',
        'At the time: memory 5980 of 6144 MB; working on 1 channel turn (running webfetch); largest helper process: readability 314 MB.',
        'Details are in .typeclaw/last-words/last-words.json in the agent folder.',
      ].join('\n'),
    )
    expect(readLastWords(agentDir).entries[0]?.notice).toEqual({
      sentAt: '2026-11-18T05:35:40.000Z',
      target: 'slack-bot user U0OWNER',
    })
  })

  test('posts to a configured conversation and records a failed send without retrying it', async () => {
    const agentDir = agentWithDeath()
    const { router, sent } = fakeRouter(false)
    const logs: string[] = []
    const target = { adapter: 'discord-bot' as const, workspace: 'G1', chat: 'C1', thread: 'T1' }

    await sendLastWordsNotice({ agentDir, run: NOW, target: () => target, router, now: at, log: (l) => logs.push(l) })
    await sendLastWordsNotice({ agentDir, run: NOW, target: () => target, router, now: at, log: (l) => logs.push(l) })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ workspace: 'G1', chat: 'C1', thread: 'T1' })
    expect(readLastWords(agentDir).entries[0]?.notice).toEqual({
      failedAt: '2026-11-18T05:35:40.000Z',
      error: 'channel_not_found',
    })
    expect(logs).toEqual(['[last-words] notice to discord-bot G1/C1/T1 failed: channel_not_found'])
  })

  test('records a send that rejects as a failed notice instead of retrying it next boot', async () => {
    const agentDir = agentWithDeath()
    const router = {
      send: async (): Promise<never> => {
        throw new Error('socket closed')
      },
      openDm: async () => ({ ok: true as const, workspace: '@dm', chat: 'D0DM' }),
    }

    await sendLastWordsNotice({
      agentDir,
      run: NOW,
      target: () => ({ adapter: 'slack-bot', user: 'U0' }),
      router,
      now: at,
      log: () => {},
    })

    expect(readLastWords(agentDir).entries[0]?.notice).toEqual({
      failedAt: '2026-11-18T05:35:40.000Z',
      error: 'socket closed',
    })
  })

  test('waits for the current run to be on disk before looking for the previous death', async () => {
    // given: the current run's boot write has not landed yet
    const agentDir = agentWithDeath()
    const withoutCurrent = readLastWords(agentDir)
    writeLastWords(agentDir, { ...withoutCurrent, entries: withoutCurrent.entries.slice(0, -1) })
    const { router, sent } = fakeRouter()
    const { promise: ready, resolve: landed } = Promise.withResolvers<void>()

    const notice = sendLastWordsNotice({
      agentDir,
      run: NOW,
      target: () => ({ adapter: 'slack-bot', user: 'U0' }),
      router,
      now: at,
      ready,
    })
    writeLastWords(agentDir, openRun(readLastWords(agentDir), NOW, NOW.startedAt))
    landed()
    await notice

    expect(sent).toHaveLength(1)
  })

  test('uses the target configured when the run is ready, not the one at dispatch', async () => {
    // given: the operator retargets and then clears the notice while the boot write is pending
    const agentDir = agentWithDeath()
    const { router, sent, opened } = fakeRouter()
    let target: { adapter: 'slack-bot'; user: string } | undefined = { adapter: 'slack-bot', user: 'U0OLD' }
    const { promise: ready, resolve: landed } = Promise.withResolvers<void>()
    const notice = sendLastWordsNotice({ agentDir, run: NOW, target: () => target, router, now: at, ready })

    target = { adapter: 'slack-bot', user: 'U0NEW' }
    landed()
    await notice

    expect(opened).toEqual([{ user: 'U0NEW' }])
    expect(sent).toHaveLength(1)
  })

  test('cancels a send whose target is replaced while the DM is being opened, and leaves it unstamped', async () => {
    const agentDir = agentWithDeath()
    let target: { adapter: 'slack-bot'; user: string } | undefined = { adapter: 'slack-bot', user: 'U0OLD' }
    const sent: OutboundMessage[] = []
    const router = {
      send: async (msg: OutboundMessage, opts?: { deliverIf?: () => boolean }) => {
        if (opts?.deliverIf?.() === false)
          return { ok: false as const, error: 'delivery cancelled', code: 'cancelled' as const }
        sent.push(msg)
        return { ok: true as const }
      },
      openDm: async () => {
        target = { adapter: 'slack-bot', user: 'U0NEW' }
        return { ok: true as const, workspace: '@dm', chat: 'D0OLD' }
      },
    }

    await sendLastWordsNotice({ agentDir, run: NOW, target: () => target, router, now: at })

    expect(sent).toEqual([])
    expect(readLastWords(agentDir).entries[0]?.notice).toBeUndefined()
  })

  test.each([
    ['fails', async () => ({ ok: false as const, error: 'user_not_found' })],
    [
      'rejects',
      async (): Promise<never> => {
        throw new Error('network down')
      },
    ],
  ])(
    'a DM lookup that %s after a retarget is cancelled, not stamped against the old target',
    async (_label, lookup) => {
      const agentDir = agentWithDeath()
      let target: { adapter: 'slack-bot'; user: string } = { adapter: 'slack-bot', user: 'U0OLD' }
      const router = {
        send: async () => ({ ok: true as const }),
        openDm: async () => {
          target = { adapter: 'slack-bot', user: 'U0NEW' }
          return lookup()
        },
      }

      await sendLastWordsNotice({ agentDir, run: NOW, target: () => target, router, now: at, log: () => {} })

      expect(readLastWords(agentDir).entries[0]?.notice).toBeUndefined()
    },
  )

  test('a DM lookup that fails for an unchanged target is still stamped as failed', async () => {
    const agentDir = agentWithDeath()
    const router = {
      send: async () => ({ ok: true as const }),
      openDm: async () => ({ ok: false as const, error: 'user_not_found' }),
    }

    await sendLastWordsNotice({
      agentDir,
      run: NOW,
      target: () => ({ adapter: 'slack-bot', user: 'U0' }),
      router,
      now: at,
      log: () => {},
    })

    expect(readLastWords(agentDir).entries[0]?.notice).toEqual({
      failedAt: '2026-11-18T05:35:40.000Z',
      error: 'user_not_found',
    })
  })

  test('sends nothing when the target was cleared before the run was ready', async () => {
    const agentDir = agentWithDeath()
    const { router, sent } = fakeRouter()
    let target: { adapter: 'slack-bot'; user: string } | undefined = { adapter: 'slack-bot', user: 'U0OLD' }
    const { promise: ready, resolve: landed } = Promise.withResolvers<void>()
    const notice = sendLastWordsNotice({ agentDir, run: NOW, target: () => target, router, now: at, ready })

    target = undefined
    landed()
    await notice

    expect(sent).toEqual([])
    expect(readLastWords(agentDir).entries[0]?.notice).toBeUndefined()
  })

  test('sends nothing when the previous run ended cleanly', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'last-words-notice-'))
    writeLastWords(agentDir, openRun({ version: 1, entries: [] }, NOW, NOW.startedAt))
    const { router, sent } = fakeRouter()

    await sendLastWordsNotice({
      agentDir,
      run: NOW,
      target: () => ({ adapter: 'slack-bot', user: 'U0' }),
      router,
      now: at,
    })

    expect(sent).toEqual([])
  })
})
