import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readLastWords, type LastWordsRun } from './file'
import { IDLE_WRITE_MS, startLastWordsRecorder, TICK_MS, type LastWordsProbes } from './recorder'

const RUN: LastWordsRun = { containerId: 'abc123', startedAt: '2026-11-18T05:00:00.000Z', typeclawVersion: '1.0.0' }

function harness(memoryMb: { current: number }, agentDir = mkdtempSync(join(tmpdir(), 'last-words-recorder-'))) {
  let clock = Date.parse(RUN.startedAt)
  let tick: () => void = () => {}
  let cancelled = false
  const probes: LastWordsProbes = {
    memoryCurrentMb: () => memoryMb.current,
    memoryLimitMb: () => 6144,
    oomKills: () => 0,
    runtime: () => ({ rssMb: 100, heapUsedMb: 50, externalMb: 10 }),
    turns: () => [{ origin: 'tui', key: 'tui', startedAt: RUN.startedAt }],
    children: () => [],
  }
  const logs: string[] = []
  const recorder = startLastWordsRecorder({
    agentDir,
    run: RUN,
    probes,
    now: () => new Date(clock),
    log: (line) => logs.push(line),
    setInterval: (fn) => {
      tick = fn
      return () => {
        cancelled = true
      }
    },
  })
  const advance = (ms: number): void => {
    clock += ms
    tick()
  }
  return { agentDir, recorder, advance, logs, isCancelled: () => cancelled }
}

describe('startLastWordsRecorder', () => {
  test('writes an alive entry with words at boot', () => {
    const { agentDir } = harness({ current: 1000 })

    const [entry] = readLastWords(agentDir).entries

    expect(entry).toMatchObject({ run: RUN, status: 'alive' })
    expect(entry?.words?.memory).toMatchObject({ currentMb: 1000, limitMb: 6144 })
    expect(entry?.words?.turns).toEqual([{ origin: 'tui', key: 'tui', startedAt: RUN.startedAt }])
  })

  test('holds writes between idle intervals but writes every tick under memory pressure', () => {
    const memory = { current: 1000 }
    const { agentDir, advance } = harness(memory)
    const writtenAt = () => readLastWords(agentDir).entries[0]?.writtenAt

    advance(TICK_MS)
    expect(writtenAt()).toBe(RUN.startedAt)

    memory.current = 5900
    advance(TICK_MS)
    expect(writtenAt()).toBe(new Date(Date.parse(RUN.startedAt) + 2 * TICK_MS).toISOString())
    expect(readLastWords(agentDir).entries[0]?.words?.memory.recent.map((s) => s.currentMb)).toEqual([1000, 1000, 5900])

    memory.current = 1000
    advance(IDLE_WRITE_MS)
    expect(writtenAt()).toBe(new Date(Date.parse(RUN.startedAt) + 2 * TICK_MS + IDLE_WRITE_MS).toISOString())
  })

  test('close marks the run stopped; dispose leaves it alive for the host', () => {
    const closed = harness({ current: 1000 })
    closed.recorder.close()
    expect(closed.isCancelled()).toBe(true)
    expect(readLastWords(closed.agentDir).entries[0]).toMatchObject({ status: 'stopped', words: null })

    const disposed = harness({ current: 1000 })
    disposed.recorder.dispose()
    disposed.recorder.close()
    expect(disposed.isCancelled()).toBe(true)
    expect(readLastWords(disposed.agentDir).entries[0]?.status).toBe('alive')
  })

  test('a failed boot write keeps retrying, so words appear once storage recovers', () => {
    // given: `.typeclaw` is a file, so the boot write cannot create the run
    const agentDir = mkdtempSync(join(tmpdir(), 'last-words-recorder-'))
    writeFileSync(join(agentDir, '.typeclaw'), '')
    const { advance, logs } = harness({ current: 1000 }, agentDir)
    expect(logs).toHaveLength(1)

    rmSync(join(agentDir, '.typeclaw'))
    advance(TICK_MS)

    expect(readLastWords(agentDir).entries[0]).toMatchObject({ run: RUN, status: 'alive' })
    expect(readLastWords(agentDir).entries[0]?.words?.memory.currentMb).toBe(1000)
  })

  test('a persistent write failure logs once and never throws', () => {
    // given: the file path is now a non-empty directory, so every rename fails
    const { agentDir, advance, logs } = harness({ current: 6000 })
    const path = join(agentDir, '.typeclaw', 'last-words.json')
    rmSync(path)
    mkdirSync(join(path, 'x'), { recursive: true })

    advance(TICK_MS)
    advance(TICK_MS)

    expect(logs.filter((line) => line.startsWith('[last-words] write failed'))).toHaveLength(1)
  })
})
