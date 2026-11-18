import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DEFAULT_SEAL_IO,
  lastWordsPath,
  openRun,
  readLastWords,
  sealExitForAgent,
  withLastWordsLock,
  writeLastWords,
  type LastWordsRun,
} from './file'
import { IDLE_WRITE_MS, startLastWordsRecorder, TICK_MS, type LastWordsProbes } from './recorder'

const RUN: LastWordsRun = { containerId: 'abc123', startedAt: '2026-11-18T05:00:00.000Z', typeclawVersion: '1.0.0' }

function harness(
  memoryMb: { current: number },
  agentDir = mkdtempSync(join(tmpdir(), 'last-words-recorder-')),
  run: LastWordsRun = RUN,
) {
  let clock = Date.parse(run.startedAt)
  let tick: () => void = () => {}
  let cancelled = false
  const probes: LastWordsProbes = {
    memoryCurrentMb: () => memoryMb.current,
    memoryLimitMb: () => 6144,
    oomKills: () => 0,
    runtime: () => ({ rssMb: 100, heapUsedMb: 50, externalMb: 10 }),
    turns: () => [{ origin: 'tui', key: 'tui', startedAt: run.startedAt }],
    children: () => [],
  }
  const logs: string[] = []
  const recorder = startLastWordsRecorder({
    agentDir,
    run,
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
  const advance = async (ms: number): Promise<void> => {
    await recorder.settled()
    clock += ms
    tick()
    await recorder.settled()
  }
  return { agentDir, recorder, advance, logs, isCancelled: () => cancelled }
}

describe('startLastWordsRecorder', () => {
  test('writes an alive entry with words at boot', async () => {
    const { agentDir, recorder } = harness({ current: 1000 })
    await recorder.settled()

    const [entry] = readLastWords(agentDir).entries

    expect(entry).toMatchObject({ run: RUN, status: 'alive' })
    expect(entry?.words?.memory).toMatchObject({ currentMb: 1000, limitMb: 6144 })
    expect(entry?.words?.turns).toEqual([{ origin: 'tui', key: 'tui', startedAt: RUN.startedAt }])
  })

  test('holds writes between idle intervals but writes every tick under memory pressure', async () => {
    const memory = { current: 1000 }
    const { agentDir, advance } = harness(memory)
    const writtenAt = () => readLastWords(agentDir).entries[0]?.writtenAt

    await advance(TICK_MS)
    expect(writtenAt()).toBe(RUN.startedAt)

    memory.current = 5900
    await advance(TICK_MS)
    expect(writtenAt()).toBe(new Date(Date.parse(RUN.startedAt) + 2 * TICK_MS).toISOString())
    expect(readLastWords(agentDir).entries[0]?.words?.memory.recent.map((s) => s.currentMb)).toEqual([1000, 1000, 5900])

    memory.current = 1000
    await advance(IDLE_WRITE_MS)
    expect(writtenAt()).toBe(new Date(Date.parse(RUN.startedAt) + 2 * TICK_MS + IDLE_WRITE_MS).toISOString())
  })

  test('close marks the run stopped; dispose leaves it alive for the host', async () => {
    const closed = harness({ current: 1000 })
    await closed.recorder.settled()
    await closed.recorder.close()
    expect(closed.isCancelled()).toBe(true)
    expect(readLastWords(closed.agentDir).entries[0]).toMatchObject({ status: 'stopped', words: null })

    const disposed = harness({ current: 1000 })
    await disposed.recorder.settled()
    disposed.recorder.dispose()
    await disposed.recorder.close()
    expect(disposed.isCancelled()).toBe(true)
    expect(readLastWords(disposed.agentDir).entries[0]?.status).toBe('alive')
  })

  test('a failed boot write keeps retrying, so words appear once storage recovers', async () => {
    // given: `.typeclaw` is a file, so the boot write cannot create the run
    const agentDir = mkdtempSync(join(tmpdir(), 'last-words-recorder-'))
    writeFileSync(join(agentDir, '.typeclaw'), '')
    const { recorder, advance, logs } = harness({ current: 1000 }, agentDir)
    await recorder.settled()
    expect(logs).toHaveLength(1)

    rmSync(join(agentDir, '.typeclaw'))
    await advance(TICK_MS)

    expect(readLastWords(agentDir).entries[0]).toMatchObject({ run: RUN, status: 'alive' })
    expect(readLastWords(agentDir).entries[0]?.words?.memory.currentMb).toBe(1000)
  })

  test('close gives up within its budget when the lock stays busy', async () => {
    const { agentDir, recorder, logs } = harness({ current: 1000 })
    await recorder.settled()
    let releaseHolder!: () => void
    const holderReleased = new Promise<void>((resolve) => (releaseHolder = resolve))
    let held!: () => void
    const lockHeld = new Promise<void>((resolve) => (held = resolve))
    const holder = withLastWordsLock(agentDir, async () => {
      held()
      await holderReleased
    })
    await lockHeld

    await recorder.close()
    releaseHolder()
    await holder

    expect(readLastWords(agentDir).entries[0]?.status).toBe('alive')
    expect(logs.filter((line) => line.startsWith('[last-words] write failed'))).toHaveLength(1)
  })

  test('a persistent write failure logs once and never throws', async () => {
    // given: the file path is now a non-empty directory, so every rename fails
    const { agentDir, recorder, advance, logs } = harness({ current: 6000 })
    await recorder.settled()
    const path = lastWordsPath(agentDir)
    rmSync(path)
    mkdirSync(join(path, 'x'), { recursive: true })

    await advance(TICK_MS)
    await advance(TICK_MS)

    expect(logs.filter((line) => line.startsWith('[last-words] write failed'))).toHaveLength(1)
  })

  test('a restarted runtime is not erased by a seal of the previous execution still in flight', async () => {
    // given: hostd read the previous run while it was alive and stalls before
    // writing its seal, while Docker restarts the same container
    const agentDir = mkdtempSync(join(tmpdir(), 'last-words-recorder-'))
    mkdirSync(dirname(lastWordsPath(agentDir)), { recursive: true })
    writeLastWords(agentDir, openRun({ version: 1, entries: [] }, RUN, RUN.startedAt))
    let resumeHostd!: () => void
    const hostdStalled = new Promise<void>((resolve) => (resumeHostd = resolve))
    let hostdRead!: () => void
    const hostdHasRead = new Promise<void>((resolve) => (hostdRead = resolve))
    const exit = {
      containerId: `abc123${'0'.repeat(58)}`,
      startedAt: '2026-11-18T04:59:59Z',
      finishedAt: '2026-11-18T05:10:00Z',
      exitCode: 137,
      oomKilled: true,
      reason: 'OOM',
      log: null,
    }
    const hostd = sealExitForAgent(
      agentDir,
      exit,
      'hostd',
      {},
      {
        ...DEFAULT_SEAL_IO,
        read: async (dir) => {
          const file = readLastWords(dir)
          hostdRead()
          await hostdStalled
          return file
        },
      },
    )
    await hostdHasRead

    const restarted: LastWordsRun = { ...RUN, startedAt: '2026-11-18T05:10:05.000Z' }
    const { recorder } = harness({ current: 1000 }, agentDir, restarted)
    resumeHostd()
    await hostd
    await recorder.settled()

    expect(readLastWords(agentDir).entries.map((entry) => [entry.run.startedAt, entry.status])).toEqual([
      [RUN.startedAt, 'died'],
      [restarted.startedAt, 'alive'],
    ])
  })
})
