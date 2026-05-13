import { existsSync } from 'node:fs'
import { access, constants as fsConstants, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { CronExpressionParser } from 'cron-parser'
import { z } from 'zod'

import type { SessionOrigin } from '@/agent/session-origin'
import { definePlugin } from '@/plugin'

import { createDreamingSubagent, type DreamingPayload } from './dreaming'
import { loadMemory } from './load-memory'
import { createMemoryLoggerSubagent, type MemoryLoggerPayload } from './memory-logger'

const DEFAULT_IDLE_MS = 10_000
const DEFAULT_BUFFER_BYTES = 100_000
const MIN_BUFFER_BYTES = 10_000
// 30-minute default. Fires short-circuit before any LLM call when nothing
// sits past the watermark (`dreaming.ts` handler returns when
// `snapshots.undreamed.length === 0`), so frequent no-op fires are cheap.
// The scheduler has no catchup for missed fires; a daily default would starve
// sporadic agents entirely. Operators can override via `memory.dreaming.schedule`.
const DEFAULT_DREAMING_SCHEDULE = '*/30 * * * *'

// Hard ceiling on a single memory-logger spawn. The chain serializes spawns
// per agent, so a non-settling spawn would otherwise wedge every subsequent
// fire — including the session.end hook path that gates cron consumer's
// inFlight cleanup. Set strictly below END_HANDLER_TIMEOUT_MS so the inner
// spawn rejects first and the memory plugin's logger gets the attribution
// instead of the generic hook ceiling.
//
// The bound detaches the orphaned spawn from the chain; it does not cancel
// the underlying subagent session. ctx.spawnSubagent returns Promise<void>
// with no handle, and pi-coding-agent's session.prompt accepts no
// AbortSignal, so the half-open LLM stream stays alive until the OS reaps
// it. The chain advances and cron resumes; the network defect is upstream.
const SPAWN_TIMEOUT_MS = 50_000

function isValidCronExpression(schedule: string): boolean {
  try {
    CronExpressionParser.parse(schedule).next()
    return true
  } catch {
    return false
  }
}

function hasFiveCronFields(schedule: string): boolean {
  return schedule.trim().split(/\s+/).length === 5
}

const dreamingConfigSchema = z.object({
  schedule: z
    .string()
    .min(1)
    .refine(hasFiveCronFields, { message: 'memory.dreaming.schedule must be a five-field cron expression' })
    .refine(isValidCronExpression, { message: 'memory.dreaming.schedule must be a valid cron expression' })
    .optional(),
})

// `bufferBytes` is a size-based ceiling on top of the `idleMs` debounce. In
// busy channel sessions the agent rarely goes idle long enough to trip the
// timer, so memory-logger needs a second trigger that responds to accumulated
// transcript volume. `0` disables the size trigger (idle-only legacy
// behavior); any non-zero value must be >= 10_000 to avoid thrashing the
// subagent on tiny conversations.
const memoryConfigSchema = z
  .object({
    idleMs: z.number().int().min(1000).default(DEFAULT_IDLE_MS),
    bufferBytes: z
      .number()
      .int()
      .min(0)
      .refine((n) => n === 0 || n >= MIN_BUFFER_BYTES, {
        message: `memory.bufferBytes must be 0 (disabled) or >= ${MIN_BUFFER_BYTES}`,
      })
      .default(DEFAULT_BUFFER_BYTES),
    // Test seam: per-spawn ceiling for memory-logger. Operators have no
    // reason to tune this; it exists so the wedge-recovery test can fire
    // the timeout in milliseconds instead of the production 50s. Kept
    // undocumented for users.
    spawnTimeoutMs: z.number().int().min(1).default(SPAWN_TIMEOUT_MS),
    dreaming: dreamingConfigSchema.optional(),
  })
  .default({ idleMs: DEFAULT_IDLE_MS, bufferBytes: DEFAULT_BUFFER_BYTES, spawnTimeoutMs: SPAWN_TIMEOUT_MS })

export default definePlugin({
  configSchema: memoryConfigSchema,
  plugin: async (ctx) => {
    const idleMs = ctx.config.idleMs
    const bufferBytes = ctx.config.bufferBytes
    const spawnTimeoutMs = ctx.config.spawnTimeoutMs
    const dreamingSchedule = ctx.config.dreaming?.schedule ?? DEFAULT_DREAMING_SCHEDULE

    const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const lastIdleEvent = new Map<string, { parentTranscriptPath: string | undefined; origin?: SessionOrigin }>()
    const bytesAtLastRun = new Map<string, number>()

    // memory-logger is now coalesced per agentDir (not per parentSessionId) so that
    // two concurrent channel sessions for the same agent never write to the same
    // daily stream file at the same time. The subagent consumer would silently drop
    // a colliding fire, so we serialize spawn calls *here* (chaining each onto the
    // previous one's settlement) instead of letting the consumer choose between
    // dropping or queueing. The chain holds at most one in-flight promise plus one
    // queued; older queued fires for the same session are superseded by newer ones
    // through the lastIdleEvent map (each fire reads the latest snapshot).
    let spawnChain: Promise<void> = Promise.resolve()

    const fireMemoryLogger = (sessionId: string, reason: 'idle' | 'buffer-trip' | 'session-end'): Promise<void> => {
      const next = spawnChain
        .catch(() => undefined)
        .then(async () => {
          const last = lastIdleEvent.get(sessionId)
          if (!last || last.parentTranscriptPath === undefined) return
          const payload: MemoryLoggerPayload = {
            parentSessionId: sessionId,
            parentTranscriptPath: last.parentTranscriptPath,
            agentDir: ctx.agentDir,
            ...(last.origin !== undefined ? { origin: last.origin } : {}),
          }
          const currentSize = await readSize(last.parentTranscriptPath)
          bytesAtLastRun.set(sessionId, currentSize)
          ctx.logger.info(`memory-logger spawn ${sessionId} reason=${reason} transcript_bytes=${currentSize}`)
          try {
            await raceSpawn(ctx.spawnSubagent('memory-logger', payload), spawnTimeoutMs)
          } catch (err) {
            ctx.logger.error(`memory-logger spawn failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        })
      spawnChain = next
      return next
    }

    const cancelTimer = (sessionId: string): void => {
      const t = idleTimers.get(sessionId)
      if (t !== undefined) {
        clearTimeout(t)
        idleTimers.delete(sessionId)
      }
    }

    const shouldTripBufferCeiling = async (sessionId: string, transcriptPath: string): Promise<boolean> => {
      if (bufferBytes === 0) return false
      const currentSize = await readSize(transcriptPath)
      const baseline = bytesAtLastRun.get(sessionId)
      if (baseline === undefined) {
        bytesAtLastRun.set(sessionId, currentSize)
        return false
      }
      return currentSize - baseline >= bufferBytes
    }

    // Subagents are constructed at boot here (rather than imported as constants)
    // so their lifecycle logs route through the plugin logger and pick up the
    // `[plugin:memory]` prefix. Without this, they would write directly to
    // console and bypass the plugin namespace.
    const subagentLogger = {
      info: (m: string) => ctx.logger.info(m),
      warn: (m: string) => ctx.logger.warn(m),
      error: (m: string) => ctx.logger.error(m),
    }

    return {
      subagents: {
        'memory-logger': createMemoryLoggerSubagent({ logger: subagentLogger }),
        dreaming: createDreamingSubagent({ logger: subagentLogger }),
      },
      cronJobs: {
        dreaming: {
          schedule: dreamingSchedule,
          kind: 'prompt' as const,
          prompt: '(internal: dreaming consolidation; user prompt is built by the dreaming subagent handler)',
          subagent: 'dreaming',
          payload: { agentDir: ctx.agentDir } satisfies DreamingPayload,
        },
      },
      hooks: {
        'session.prompt': async (event) => {
          const memorySection = await loadMemory(ctx.agentDir, { origin: event.origin })
          event.prompt = `${event.prompt}\n\n${memorySection}`
        },
        // Core fires `session.idle` immediately after every prompt completion;
        // the plugin owns the debounce timer so memory-logger only spawns
        // after the user has been quiet for `idleMs`. Re-arming a still-armed
        // timer cancels it first, matching the previous core IdleDetector.
        // The size-based ceiling fires synchronously when the transcript has
        // grown by `bufferBytes` since the last run, so busy channel sessions
        // (which rarely go idle) still produce memory updates.
        'session.idle': async (event) => {
          lastIdleEvent.set(event.sessionId, {
            parentTranscriptPath: event.parentTranscriptPath,
            ...(event.origin !== undefined ? { origin: event.origin } : {}),
          })
          cancelTimer(event.sessionId)
          const sessionId = event.sessionId
          const timer = setTimeout(() => {
            idleTimers.delete(sessionId)
            void fireMemoryLogger(sessionId, 'idle')
          }, idleMs)
          idleTimers.set(sessionId, timer)
          if (
            event.parentTranscriptPath !== undefined &&
            (await shouldTripBufferCeiling(sessionId, event.parentTranscriptPath))
          ) {
            ctx.logger.info(`buffer-ceiling trip ${sessionId} bufferBytes=${bufferBytes}`)
            cancelTimer(sessionId)
            await fireMemoryLogger(sessionId, 'buffer-trip')
          }
        },
        'session.end': async (event) => {
          cancelTimer(event.sessionId)
          await fireMemoryLogger(event.sessionId, 'session-end')
          lastIdleEvent.delete(event.sessionId)
          bytesAtLastRun.delete(event.sessionId)
        },
      },
      doctorChecks: {
        'dir-writable': {
          description: 'memory/ exists and is writable',
          run: async (dctx) => {
            const dir = join(dctx.agentDir, 'memory')
            try {
              await access(dir, fsConstants.W_OK)
              return { status: 'ok', message: `${dir} writable` }
            } catch {
              return {
                status: 'error',
                message: `${dir} is missing or not writable`,
                fix: { description: 'Create memory/ in the agent folder or fix its permissions on the host.' },
              }
            }
          },
        },
        'daily-stream-current': {
          description: "today's daily stream file exists",
          run: async (dctx) => {
            const today = new Date().toISOString().slice(0, 10)
            const rel = `memory/${today}.md`
            const abs = join(dctx.agentDir, rel)
            if (existsSync(abs)) return { status: 'ok', message: `${rel} present` }
            return {
              status: 'info',
              message: `${rel} missing`,
              details: ['memory-logger creates it on demand; this is informational only.'],
            }
          },
        },
      },
    }
  },
})

async function readSize(path: string): Promise<number> {
  try {
    const s = await stat(path)
    return s.size
  } catch {
    return 0
  }
}

async function raceSpawn(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`memory-logger spawn timed out after ${ms}ms`)), ms)
  })
  try {
    await Promise.race([work, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}
