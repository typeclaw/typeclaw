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

    expect(file.entries[0]).toMatchObject({ status: 'died', words, death: { ...oomExit, observedBy: 'hostd' } })
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

  test('already-closed runs are left alone', () => {
    const file = closeRun(aliveWithWords(), RUN, '2026-11-18T06:00:00.000Z')

    expect(sealExit(file, oomExit, 'hostd')).toBe(file)
    expect(sealExit(EMPTY, oomExit, 'hostd')).toBe(EMPTY)
  })
})

describe('file io', () => {
  test('round-trips through disk and seals for an agent dir', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'last-words-'))
    writeLastWords(agentDir, aliveWithWords())

    sealExitForAgent(agentDir, oomExit, 'start')

    expect(readLastWords(agentDir).entries[0]?.status).toBe('died')
  })

  test('a missing or malformed file reads as empty and sealing does not create one', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'last-words-'))
    sealExitForAgent(agentDir, oomExit, 'hostd')
    expect(readLastWords(agentDir)).toEqual(EMPTY)

    mkdirSync(join(agentDir, '.typeclaw'), { recursive: true })
    writeFileSync(lastWordsPath(agentDir), '{"version":2}')
    expect(readLastWords(agentDir)).toEqual(EMPTY)
  })
})
