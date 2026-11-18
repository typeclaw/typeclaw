import { readMemoryLimitMiB, readOomEvents } from '@/container/oom-events'

import { listActiveTurns } from './activity'
import {
  closeRun,
  openRun,
  readLastWords,
  recordWords,
  withLastWordsLock,
  writeLastWords,
  type LastWords,
  type LastWordsRun,
} from './file'
import { collectChildren, readMemoryCurrentMb } from './probe'

const BYTES_PER_MB = 1024 * 1024

export const TICK_MS = 2_000
export const IDLE_WRITE_MS = 30_000
export const PRESSURE_RATIO = 0.85
export const RECENT_SAMPLES = 30
export const CLOSE_LOCK_WAIT_MS = 1_000

export type LastWordsProbes = {
  memoryCurrentMb: () => number | null
  memoryLimitMb: () => number | null
  oomKills: () => number | null
  runtime: () => LastWords['runtime']
  turns: () => LastWords['turns']
  children: () => LastWords['children']
}

export type LastWordsRecorderOptions = {
  agentDir: string
  run: LastWordsRun
  probes?: Partial<LastWordsProbes>
  now?: () => Date
  log?: (line: string) => void
  setInterval?: (tick: () => void, ms: number) => () => void
}

export type LastWordsRecorder = {
  // Graceful shutdown: the run ended cleanly, so its words are dropped.
  close: () => Promise<void>
  // Boot failure: stop recording but leave the run alive for the host to seal,
  // because a runtime that failed to boot did die.
  dispose: () => void
  // Resolves once the write in flight, if any, has landed.
  settled: () => Promise<void>
  // Resolves once this run's entry is on disk; never resolves if it never lands.
  opened: Promise<void>
}

// Memory is sampled every tick so the trend is dense, but the file is only
// rewritten every IDLE_WRITE_MS until the container nears its limit; from then
// on every tick writes, because an OOM kill gives no warning and the last write
// before it is the one the host keeps.
export function startLastWordsRecorder(options: LastWordsRecorderOptions): LastWordsRecorder {
  const probes: LastWordsProbes = { ...DEFAULT_PROBES, ...options.probes }
  const now = options.now ?? (() => new Date())
  const log = options.log ?? ((line: string) => console.warn(line))
  const schedule = options.setInterval ?? defaultSetInterval
  const { agentDir, run } = options
  const recent: LastWords['memory']['recent'] = []
  let lastWriteAt = Number.NEGATIVE_INFINITY
  let opened = false
  let failing = false
  let inFlight: Promise<void> | null = null
  const { promise: openedSignal, resolve: markOpened } = Promise.withResolvers<void>()

  // A recorder must never take the agent down, and a persistent failure
  // (read-only mount, full disk) must not log every two seconds.
  const guarded = async (
    update: (file: ReturnType<typeof readLastWords>) => typeof file,
    lock: { maxWaitMs?: number } = {},
  ): Promise<boolean> => {
    try {
      await withLastWordsLock(agentDir, async () => writeLastWords(agentDir, update(readLastWords(agentDir))), lock)
      failing = false
      return true
    } catch (error) {
      if (!failing) log(`[last-words] write failed: ${error instanceof Error ? error.message : String(error)}`)
      failing = true
      return false
    }
  }

  // Opening the run rides on the first write and is retried by every tick until
  // it lands: without its entry, later words have nothing to attach to, so one
  // failed boot write would otherwise silence the whole run.
  const step = async (): Promise<void> => {
    const at = now()
    const currentMb = probes.memoryCurrentMb()
    const limitMb = probes.memoryLimitMb()
    if (currentMb !== null) {
      recent.push({ at: at.toISOString(), currentMb })
      if (recent.length > RECENT_SAMPLES) recent.shift()
    }
    const underPressure = currentMb !== null && limitMb !== null && currentMb >= limitMb * PRESSURE_RATIO
    if (opened && !underPressure && at.getTime() - lastWriteAt < IDLE_WRITE_MS) return
    const words: LastWords = {
      memory: { currentMb, limitMb, oomKills: probes.oomKills(), recent: [...recent] },
      runtime: probes.runtime(),
      turns: probes.turns(),
      children: probes.children(),
    }
    const iso = at.toISOString()
    const wrote = await guarded((file) => recordWords(opened ? file : openRun(file, run, iso), run, words, iso))
    if (!wrote) return
    opened = true
    markOpened()
    lastWriteAt = at.getTime()
  }

  const tick = (): Promise<void> => {
    inFlight ??= step().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  void tick()
  const cancel = schedule(() => void tick(), TICK_MS)

  let stopped = false
  const dispose = (): void => {
    if (stopped) return
    stopped = true
    cancel()
  }
  const settled = async (): Promise<void> => {
    await inFlight
  }
  return {
    dispose,
    settled,
    opened: openedSignal,
    // Shutdown has a hard deadline shared with every other teardown step, so
    // the clean-stop mark gets a short lock budget and is skipped if the lock
    // stays busy: `typeclaw stop` seals the run as stopped either way. An
    // in-flight tick is not awaited; its words only apply while the run is alive.
    close: async () => {
      if (stopped) return
      dispose()
      if (opened) await guarded((file) => closeRun(file, run, now().toISOString()), { maxWaitMs: CLOSE_LOCK_WAIT_MS })
    },
  }
}

const DEFAULT_PROBES: LastWordsProbes = {
  memoryCurrentMb: () => readMemoryCurrentMb(),
  memoryLimitMb: () => readMemoryLimitMiB(),
  oomKills: () => readOomEvents()?.oomKill ?? null,
  runtime: () => {
    const usage = process.memoryUsage()
    return {
      rssMb: Math.round(usage.rss / BYTES_PER_MB),
      heapUsedMb: Math.round(usage.heapUsed / BYTES_PER_MB),
      externalMb: Math.round(usage.external / BYTES_PER_MB),
    }
  },
  turns: () => listActiveTurns(),
  children: () => collectChildren(),
}

function defaultSetInterval(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}
