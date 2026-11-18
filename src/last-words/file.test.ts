import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closeRun,
  LAST_WORDS_ENTRY_CAP,
  lastWordsPath,
  openRun,
  readLastWords,
  recordWords,
  sealExit,
  DEFAULT_SEAL_IO,
  sealExitForAgent,
  writeLastWords,
  type LastWords,
  type LastWordsFile,
  type LastWordsRun,
  type ObservedExit,
} from './file'

const run = (startedAt: string): LastWordsRun => ({ containerId: 'abc123', startedAt, typeclawVersion: '1.0.0' })
const RUN = run('2026-11-16T14:25:59.313Z')
const EMPTY: LastWordsFile = { version: 1, entries: [] }

const words: LastWords = {
  memory: {
    currentMb: 5980,
    limitMb: 6144,
    oomKills: 0,
    recent: [{ at: '2026-11-18T05:18:30.000Z', currentMb: 5980 }],
  },
  runtime: { rssMb: 2482, heapUsedMb: 1155, externalMb: 809 },
  turns: [{ origin: 'channel', key: 'github:acme:pr:279:', startedAt: '2026-11-18T05:17:06.000Z', tool: 'webfetch' }],
  children: [{ kind: 'readability', rssMb: 314 }],
}

const oomExit: ObservedExit = {
  containerId: `abc123${'0'.repeat(58)}`,
  startedAt: '2026-11-16T14:25:58.9Z',
  finishedAt: '2026-11-18T05:18:30.123456789Z',
  exitCode: 137,
  oomKilled: true,
  reason: 'agent runtime was SIGKILLed (137)',
  log: null,
}

function aliveWithWords(): LastWordsFile {
  return recordWords(openRun(EMPTY, RUN, RUN.startedAt), RUN, words, '2026-11-18T05:18:31.000Z')
}

describe('runtime transitions', () => {
  test('a recorded run keeps its latest words while alive', () => {
    const file = aliveWithWords()

    expect(file.entries).toEqual([{ run: RUN, status: 'alive', writtenAt: '2026-11-18T05:18:31.000Z', words }])
  })

  test('boot marks a run the host never sealed as vanished and keeps its words', () => {
    const next = run('2026-11-18T05:35:29.000Z')

    const file = openRun(aliveWithWords(), next, next.startedAt)

    expect(file.entries.map((entry) => entry.status)).toEqual(['vanished', 'alive'])
    expect(file.entries[0]?.words).toEqual(words)
  })

  test('a clean shutdown drops the words', () => {
    const file = closeRun(aliveWithWords(), RUN, '2026-11-18T06:00:00.000Z')

    expect(file.entries[0]).toMatchObject({ status: 'stopped', words: null })
  })

  test('history is capped to the newest entries', () => {
    let file = EMPTY
    for (let i = 0; i < LAST_WORDS_ENTRY_CAP + 5; i++) {
      const next = run(new Date(Date.UTC(2026, 10, 1, i)).toISOString())
      file = closeRun(openRun(file, next, next.startedAt), next, next.startedAt)
    }

    expect(file.entries).toHaveLength(LAST_WORDS_ENTRY_CAP)
    expect(file.entries.at(-1)?.run.startedAt).toBe(new Date(Date.UTC(2026, 10, 1, 24)).toISOString())
  })
})

describe('sealExit', () => {
  test('an unexpected exit records the death and keeps the last words', () => {
    const file = sealExit(aliveWithWords(), oomExit, 'hostd')

    const { containerId: _id, startedAt: _started, ...death } = oomExit
    expect(file.entries[0]).toMatchObject({ status: 'died', words, death: { ...death, observedBy: 'hostd' } })
  })

  test('an operator stop is a clean stop even after a SIGKILL', () => {
    const file = sealExit(aliveWithWords(), { ...oomExit, oomKilled: false }, 'stop', { operatorStop: true })

    expect(file.entries[0]).toMatchObject({ status: 'stopped', words: null })
    expect(file.entries[0]?.death).toBeUndefined()
  })

  test('a later observer of the same exit fills in the archived log once', () => {
    const sealed = sealExit(aliveWithWords(), oomExit, 'hostd')

    const withLog = sealExit(sealed, { ...oomExit, log: '.typeclaw/logs/a.log' }, 'start')
    const again = sealExit(withLog, { ...oomExit, log: '.typeclaw/logs/b.log' }, 'stop')

    expect(withLog.entries[0]?.death).toMatchObject({ log: '.typeclaw/logs/a.log', observedBy: 'hostd' })
    expect(again).toBe(withLog)
  })

  test('an exit that finished before the newest run started is not that run', () => {
    const file = aliveWithWords()

    expect(sealExit(file, { ...oomExit, finishedAt: '2026-11-01T00:00:00Z' }, 'hostd')).toBe(file)
  })

  test('an unobserved crash is not paired with a later boot of the same container that died before recording', () => {
    // given: run A recorded words, crashed unobserved, and Docker restarted the
    // same container, whose boot B failed before opening its own entry
    const file = aliveWithWords()
    const bootB = { ...oomExit, startedAt: '2026-11-18T06:00:00Z', finishedAt: '2026-11-18T06:00:05Z', log: 'b.log' }

    expect(sealExit(file, bootB, 'hostd')).toBe(file)
  })

  test('a restarted run that opened first does not hide the previous execution from its seal', () => {
    // given: B opened its run under the lock first and marked A vanished
    const restarted = run('2026-11-18T06:00:00.000Z')
    const file = openRun(aliveWithWords(), restarted, restarted.startedAt)

    const sealed = sealExit(file, { ...oomExit, finishedAt: '2026-11-18T05:59:00Z' }, 'hostd')

    expect(sealed.entries.map((entry) => entry.status)).toEqual(['died', 'alive'])
    expect(sealed.entries[0]?.words).toEqual(words)
    expect(sealed.entries[1]).toEqual(file.entries[1])
  })

  test('an exit of a different container is not this run', () => {
    const file = aliveWithWords()

    expect(sealExit(file, { ...oomExit, containerId: 'f'.repeat(64) }, 'hostd')).toBe(file)
  })

  test('already-closed runs are left alone', () => {
    const file = closeRun(aliveWithWords(), RUN, '2026-11-18T06:00:00.000Z')

    expect(sealExit(file, oomExit, 'hostd')).toBe(file)
    expect(sealExit(EMPTY, oomExit, 'hostd')).toBe(EMPTY)
  })
})

describe('file io', () => {
  test('round-trips through disk and seals for an agent dir', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'last-words-'))
    writeLastWords(agentDir, aliveWithWords())

    await sealExitForAgent(agentDir, oomExit, 'start')

    expect(readLastWords(agentDir).entries[0]?.status).toBe('died')
  })

  test('a missing or malformed file reads as empty and sealing does not create one', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'last-words-'))
    await sealExitForAgent(agentDir, oomExit, 'hostd')
    expect(readLastWords(agentDir)).toEqual(EMPTY)

    mkdirSync(join(agentDir, '.typeclaw'), { recursive: true })
    writeFileSync(lastWordsPath(agentDir), '{"version":2}')
    expect(readLastWords(agentDir)).toEqual(EMPTY)
  })

  test('a stale logless seal does not erase a log-bearing seal of the same exit', async () => {
    // given: hostd reads the alive run and stalls before writing, while start
    // seals the same exit with its archived log
    const agentDir = mkdtempSync(join(tmpdir(), 'last-words-'))
    writeLastWords(agentDir, aliveWithWords())
    let resumeHostd!: () => void
    const hostdStalled = new Promise<void>((resolve) => (resumeHostd = resolve))
    let hostdRead!: () => void
    const hostdHasRead = new Promise<void>((resolve) => (hostdRead = resolve))
    const stallingRead = async (dir: string) => {
      const file = readLastWords(dir)
      hostdRead()
      await hostdStalled
      return file
    }

    const hostd = sealExitForAgent(agentDir, oomExit, 'hostd', {}, { ...DEFAULT_SEAL_IO, read: stallingRead })
    await hostdHasRead
    const start = sealExitForAgent(agentDir, { ...oomExit, log: '.typeclaw/logs/a.log' }, 'start')
    resumeHostd()
    await Promise.all([hostd, start])

    expect(readLastWords(agentDir).entries[0]?.death?.log).toBe('.typeclaw/logs/a.log')
  })
})
