import { existsSync } from 'node:fs'
import { access, constants as fsConstants, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CronExpressionParser } from 'cron-parser'
import { z } from 'zod'

import type { SessionOrigin } from '@/agent/session-origin'
import { definePlugin, type SpawnSubagentOptions } from '@/plugin'
import { formatLocalDate } from '@/shared'

import { createDreamingSubagent, type DreamingPayload } from './dreaming'
import { buildInjectionPlan, DEFAULT_INJECTION_BUDGET_BYTES, MIN_INJECTION_BUDGET_BYTES } from './injection-plan'
import {
  forceIndexForChannel,
  loadMemoryInjectionPlan,
  renderDedupedMemorySection,
  renderMemorySection,
  renderRetrievedMemorySection,
} from './load-memory'
import { loadAllShards } from './load-shards'
import { createMemoryLoggerSubagent, type MemoryLoggerPayload } from './memory-logger'
import { createMemoryRetrievalSubagent, type MemoryRetrievalPayload } from './memory-retrieval'
import { preShardBackupPath, streamFilePath, streamsDir, topicsDir } from './paths'
import { createStoreReferenceTool } from './references/store-reference-tool'
import { createMemorySearchTool } from './search-tool'
import { type InjectedShardState, partitionDirectShards } from './turn-dedup'
import { vectorConfigSchema } from './vector/config'
import { runVectorIndexDoctor } from './vector/doctor'
import { embed } from './vector/embedder'
import { hybridSearch, type EmbedFn } from './vector/hybrid'
import { makeAppendHook } from './vector/index-on-write'
import { makeReferenceStoredHook } from './vector/reference-index-on-write'
import { VectorStore } from './vector/store'

const DEFAULT_IDLE_MS = 60_000
const DEFAULT_BUFFER_BYTES = 500_000
const MIN_BUFFER_BYTES = 10_000
// Minimum JSONL line growth since the last memory-logger run required to spawn
// on a plain `session.idle` tick. The hook fires after every prompt completion,
// so a chatty channel session that goes briefly quiet 4 times in 7 minutes
// would otherwise pay the full per-spawn floor (~50 KB context + 4-11 turns of
// LLM decision-making) on each tick — even when the new transcript content is
// a handful of lines almost certain to contain nothing memorable.
//
// Gate semantics: skip the spawn when (currentLines - linesAtLastRun) < N AND
// the transcript file actually exists with at least one line. A zero-line
// transcript (test dummies, brand-new sessions) is NOT gated — the existing
// "fire and let memory-logger decide" behavior is preserved.
//
// The buffer-trip path (size-based ceiling) is independent and unaffected:
// busy sessions that grow `bufferBytes` of unread transcript still spawn
// regardless of the idle delta.
const DEFAULT_MIN_IDLE_DELTA_LINES = 3
// 30-minute default. Fires short-circuit before any LLM call when nothing
// sits past the watermark (`dreaming.ts` handler returns when
// `snapshots.undreamed.length === 0`), so frequent no-op fires are cheap.
// The scheduler has no catchup for missed fires; a daily default would starve
// sporadic agents entirely. Operators can override via `memory.dreaming.schedule`.
const DEFAULT_DREAMING_SCHEDULE = '*/30 * * * *'

// memory-retrieval's ceiling, enforced by the orchestration layer (see
// `awaitWithSubagentTimeout` in @/agent/subagents). 30s is sized for the
// declared workload — up to 3 `memory_search` calls + 1 `write` against a
// `fast`-profile model. The 5+ minute outliers observed in the wild
// (reasoning-model cold-start on the default profile) require either a
// genuinely wedged provider, a misconfigured profile that routes retrieval
// to a reasoning model anyway, or both. In all three cases, releasing the
// coalescing key after 30s lets the next channel turn spawn a fresh
// retrieval instead of staying skip-coalesced behind the stuck one.
const RETRIEVAL_SPAWN_TIMEOUT_MS = 30_000

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
    injectionBudgetBytes: z.number().int().min(MIN_INJECTION_BUDGET_BYTES).default(DEFAULT_INJECTION_BUDGET_BYTES),
    minIdleDeltaLines: z.number().int().min(0).default(DEFAULT_MIN_IDLE_DELTA_LINES),
    // Test seam: per-spawn ceiling for memory-logger. Operators have no
    // reason to tune this; it exists so the wedge-recovery test can fire
    // the timeout in milliseconds instead of the production 50s. Kept
    // undocumented for users.
    spawnTimeoutMs: z.number().int().min(1).default(SPAWN_TIMEOUT_MS),
    // Test seam: per-spawn ceiling for memory-retrieval. Same rationale as
    // `spawnTimeoutMs` — operators have no reason to tune this; it exists
    // so the wedge-recovery test for memory-retrieval can fire the timeout
    // in milliseconds instead of the production 30s.
    retrievalSpawnTimeoutMs: z.number().int().min(1).default(RETRIEVAL_SPAWN_TIMEOUT_MS),
    dreaming: dreamingConfigSchema.optional(),
    vector: vectorConfigSchema,
  })
  .default({
    idleMs: DEFAULT_IDLE_MS,
    bufferBytes: DEFAULT_BUFFER_BYTES,
    injectionBudgetBytes: DEFAULT_INJECTION_BUDGET_BYTES,
    minIdleDeltaLines: DEFAULT_MIN_IDLE_DELTA_LINES,
    spawnTimeoutMs: SPAWN_TIMEOUT_MS,
    retrievalSpawnTimeoutMs: RETRIEVAL_SPAWN_TIMEOUT_MS,
    vector: { enabled: false },
  })

const VECTOR_TURN_TOP_K = 10

// Per-instance collaborators for the vector index-mode retrieval path. Injected
// through the plugin factory (not a module global or PluginContext field) so a
// test can override exactly one — `queryEmbedFn` to drive the real hybridSearch
// without loading the ~279 MB model, or `hybridSearch` to fake retrieval while
// testing hook orchestration — without leaking state across other tests in the
// same worker. Production uses the real `embed` and `hybridSearch`.
type MemoryPluginDeps = {
  hybridSearch: typeof hybridSearch
  queryEmbedFn: EmbedFn
}

const defaultDeps: MemoryPluginDeps = { hybridSearch, queryEmbedFn: embed }

// Builds the per-turn user-prompt memory block for a vector agent. Under budget
// (direct mode) injects shard bodies, but de-duplicates across turns: a shard
// whose body was already injected in full this session is rendered as a compact
// slug reference (see `partitionDirectShards`) so a long conversation stops
// re-sending identical bodies every turn while keeping every topic named and
// recoverable. Over budget falls back to top-K hybrid search.
//
// Channel origins never carry bodies (memory-bleed defense). A channel direct-mode
// turn is force-indexed to a headings/slugs-only section over EVERY shard, not run
// through hybridSearch: hybrid is relevance-filtered top-K, so an off-topic turn or
// stale vector index could silently drop headings that direct mode always had.
async function renderVectorTurnMemory(
  event: { agentDir: string; userPrompt: string; origin?: SessionOrigin },
  injectionBudgetBytes: number,
  injectedState: InjectedShardState,
  deps: MemoryPluginDeps,
  logger?: { info: (msg: string) => void },
): Promise<string> {
  const plan = await loadMemoryInjectionPlan(event.agentDir, { injectionBudgetBytes })
  const isChannel = event.origin?.kind === 'channel'
  if (plan.mode === 'direct' && isChannel) {
    const indexed = forceIndexForChannel(plan, { origin: event.origin, injectionBudgetBytes })
    logger?.info(`[vector-retrieval] mode=index topics=${plan.shards.length} channel=forced`)
    return renderMemorySection(indexed, { origin: event.origin })
  }
  if (plan.mode === 'direct') {
    const { full, unchanged } = partitionDirectShards(plan.shards, injectedState)
    logger?.info(`[vector-retrieval] mode=direct topics=${plan.shards.length} full=${full.length}`)
    return renderDedupedMemorySection(full, unchanged)
  }
  const store = VectorStore.open(join(event.agentDir, 'memory', '.vectors', 'index.db'))
  try {
    const startedAt = Date.now()
    const results = await deps.hybridSearch(
      event.userPrompt,
      store,
      event.agentDir,
      VECTOR_TURN_TOP_K,
      deps.queryEmbedFn,
    )
    const elapsedMs = Date.now() - startedAt
    let topicHits = 0
    let referenceHits = 0
    for (const result of results) {
      if (result.source === 'topic') topicHits += 1
      else if (result.source === 'reference') referenceHits += 1
    }
    const streamHits = results.length - topicHits - referenceHits
    // results.length === 0 on a non-empty query means the relevance gate suppressed
    // every candidate (or nothing matched) — an empty memory block, indistinguishable
    // from "no memory" without this explicit signal.
    const suppressed = results.length === 0 ? ' suppressed=1' : ''
    logger?.info(
      `[vector-retrieval] mode=index topic_results=${topicHits} stream_results=${streamHits} reference_results=${referenceHits} elapsed_ms=${elapsedMs}${suppressed}`,
    )
    return renderRetrievedMemorySection(results, { origin: event.origin })
  } finally {
    store.close()
  }
}

function createMemoryPlugin(deps: MemoryPluginDeps = defaultDeps) {
  return definePlugin({
    configSchema: memoryConfigSchema,
    plugin: async (ctx) => {
      const idleMs = ctx.config.idleMs
      const bufferBytes = ctx.config.bufferBytes
      const minIdleDeltaLines = ctx.config.minIdleDeltaLines
      const spawnTimeoutMs = ctx.config.spawnTimeoutMs
      const retrievalSpawnTimeoutMs = ctx.config.retrievalSpawnTimeoutMs
      const dreamingSchedule = ctx.config.dreaming?.schedule ?? DEFAULT_DREAMING_SCHEDULE

      const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
      const lastIdleEvent = new Map<string, { parentTranscriptPath: string | undefined; origin?: SessionOrigin }>()
      const bytesAtLastRun = new Map<string, number>()
      const linesAtLastRun = new Map<string, number>()
      // Per-session stream-file cursor: the JSONL line count of the daily
      // stream file at the END of this session's most recent memory-logger
      // spawn. Keyed by sessionId, valued by `{ date, lineCount }`. Honored
      // only when `date` matches today's date — yesterday's cursor points
      // into yesterday's file and the spawn's payload omits it.
      const streamCursorAtLastRun = new Map<string, { date: string; lineCount: number }>()
      // Per-session record of shard bodies already injected in full this session,
      // so direct-mode vector turns can de-duplicate unchanged bodies across turns.
      // Cleared on session.end alongside the other per-session bookkeeping below.
      const injectedShards = new Map<string, InjectedShardState>()

      // memory-logger is coalesced per agentDir (not per parentSessionId) so that
      // two concurrent channel sessions for the same agent never write to the same
      // daily stream file at the same time. The subagent consumer would silently drop
      // a colliding fire, so we serialize spawn calls *here* (chaining each onto the
      // previous one's settlement) instead of letting the consumer choose between
      // dropping or queueing. The chain holds at most one in-flight promise plus one
      // queued.
      //
      // The `lastIdleEvent` lookup happens SYNCHRONOUSLY at call time and the
      // snapshot is captured in `payload` before any await. This is load-bearing
      // for `session.end`'s fire-and-forget path (see hook below): the hook
      // synchronously cleans up `lastIdleEvent.delete(sessionId)` immediately
      // after calling fireMemoryLogger, so if the snapshot were read lazily
      // inside the chained `.then`, it would race with cleanup and the spawn
      // would silently no-op. Capturing the payload up front decouples the
      // session-end snapshot from the cleanup that follows.
      let spawnChain: Promise<void> = Promise.resolve()

      const fireMemoryLogger = (sessionId: string, reason: 'idle' | 'buffer-trip' | 'session-end'): Promise<void> => {
        const last = lastIdleEvent.get(sessionId)
        if (!last || last.parentTranscriptPath === undefined) return Promise.resolve()
        const parentTranscriptPath = last.parentTranscriptPath
        const today = formatLocalDate()
        const priorCursor = streamCursorAtLastRun.get(sessionId)
        const streamLineCursor =
          priorCursor !== undefined && priorCursor.date === today ? priorCursor.lineCount : undefined
        const payload: MemoryLoggerPayload = {
          parentSessionId: sessionId,
          parentTranscriptPath,
          agentDir: ctx.agentDir,
          ...(last.origin !== undefined ? { origin: last.origin } : {}),
          ...(streamLineCursor !== undefined ? { streamLineCursor } : {}),
        }
        // Execution authority is `system` (resolves to owner), NOT the
        // triggering turn's role: memory-logging is TypeClaw infrastructure over
        // operator-owned sessions//memory/, so a guest channel turn that triggers
        // it must not demote the logger to guest and get its transcript read
        // blocked by privateSurfaceRead. The triggering origin is preserved two
        // ways: `triggeredBy` for audit provenance, and `payload.origin` for
        // content provenance (memory extraction/retrieval channel-safety).
        const spawnOptions: SpawnSubagentOptions = {
          parentSessionId: sessionId,
          spawnedByOrigin: {
            kind: 'system',
            component: 'memory-logger',
            ...(last.origin !== undefined ? { triggeredBy: last.origin } : {}),
          },
        }
        const next = spawnChain
          .catch(() => undefined)
          .then(async () => {
            const currentSize = await readSize(parentTranscriptPath)
            const currentLines = await readLineCount(parentTranscriptPath)
            bytesAtLastRun.set(sessionId, currentSize)
            linesAtLastRun.set(sessionId, currentLines)
            ctx.logger.info(`memory-logger spawn ${sessionId} reason=${reason} transcript_bytes=${currentSize}`)
            try {
              await raceSpawn(ctx.spawnSubagent('memory-logger', payload, spawnOptions), spawnTimeoutMs)
            } catch (err) {
              ctx.logger.error(`memory-logger spawn failed: ${err instanceof Error ? err.message : String(err)}`)
            }
            // Capture the daily-stream line count POST-spawn so the next spawn
            // (in the same session, on the same day) can resume past anything
            // this spawn appended. Tied to today's date — `fireMemoryLogger`
            // checks the date before honoring the cursor.
            const todayAfterSpawn = formatLocalDate()
            const streamPath = streamFilePath(ctx.agentDir, todayAfterSpawn)
            const streamLineCount = await readLineCount(streamPath)
            streamCursorAtLastRun.set(sessionId, { date: todayAfterSpawn, lineCount: streamLineCount })
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

      const shouldSkipIdleSpawn = async (sessionId: string, transcriptPath: string): Promise<boolean> => {
        if (minIdleDeltaLines === 0) return false
        const currentLines = await readLineCount(transcriptPath)
        if (currentLines === 0) return false
        const baseline = linesAtLastRun.get(sessionId) ?? 0
        return currentLines - baseline < minIdleDeltaLines
      }

      const runMemoryRetrieval = async (event: {
        sessionId: string
        agentDir: string
        userPrompt: string
        origin?: SessionOrigin
      }): Promise<void> => {
        const shards = await loadAllShards(event.agentDir)
        const plan = buildInjectionPlan(shards, { budgetBytes: ctx.config.injectionBudgetBytes })
        if (plan.mode === 'direct') return

        const cacheFilePath = join(event.agentDir, 'memory', '.retrieval-cache', `${event.sessionId}.md`)
        const payload: MemoryRetrievalPayload = {
          parentSessionId: event.sessionId,
          agentDir: event.agentDir,
          recentPrompt: event.userPrompt,
          cacheFilePath,
          ...(event.origin !== undefined ? { origin: event.origin } : {}),
        }
        // System authority, not the triggering turn's role — see the
        // memory-logger spawn above. memory-retrieval writes
        // memory/.retrieval-cache/, which a guest-demoted role cannot.
        const retrievalSpawnOptions: SpawnSubagentOptions = {
          parentSessionId: event.sessionId,
          spawnedByOrigin: {
            kind: 'system',
            component: 'memory-retrieval',
            ...(event.origin !== undefined ? { triggeredBy: event.origin } : {}),
          },
        }
        await ctx.spawnSubagent('memory-retrieval', payload, retrievalSpawnOptions)
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

      // Open a long-lived VectorStore for append-time indexing when vector is enabled.
      const appendVectorStore = ctx.config.vector.enabled
        ? VectorStore.open(join(ctx.agentDir, 'memory', '.vectors', 'index.db'))
        : undefined

      return {
        subagents: {
          'memory-logger': createMemoryLoggerSubagent({
            logger: subagentLogger,
            ...(appendVectorStore !== undefined
              ? {
                  onFragmentsAppended: makeAppendHook(appendVectorStore),
                  onReferenceStored: makeReferenceStoredHook(appendVectorStore),
                }
              : {}),
          }),
          'memory-retrieval': createMemoryRetrievalSubagent({
            logger: subagentLogger,
            timeoutMs: retrievalSpawnTimeoutMs,
          }),
          dreaming: createDreamingSubagent({
            logger: subagentLogger,
          }),
        },
        tools: {
          memory_search: createMemorySearchTool(),
          // Inline reference storage for the main agent. Without it, "remember this
          // verbatim" only persists after the memory-logger idle cycle (idleMs + a
          // fast-model spawn), so a follow-up in the same turn could not find the
          // artifact. The on-write hook (when vector is enabled) indexes it
          // immediately, matching the memory-logger path.
          store_reference: createStoreReferenceTool(
            appendVectorStore !== undefined ? makeReferenceStoredHook(appendVectorStore) : undefined,
          ),
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
          // Memory injection lives in core (`createResourceLoader` calls `loadMemory`
          // directly, appended LAST in the system prompt). It does not run from a
          // plugin hook because positioning matters for cache-prefix stability:
          // the daily-stream file grows after every channel turn (memory-logger
          // appends a fragment + watermark) and memory/topics/ changes on every dream.
          // A volatile region in the middle of the system prompt invalidates the
          // entire cacheable suffix below it on every session resurrection
          // (channel sessions evicted by idle GC, container restarts). Pinning
          // memory to the bottom of the system prompt keeps everything above it
          // cacheable across resurrections, at the cost of re-billing only the
          // memory section itself when it grows.
          //
          // Core fires `session.idle` immediately after every prompt completion;
          // the plugin owns the debounce timer so memory-logger only spawns
          // after the user has been quiet for `idleMs`. Re-arming a still-armed
          // timer cancels it first, matching the previous core IdleDetector.
          // The size-based ceiling fires synchronously when the transcript has
          // grown by `bufferBytes` since the last run, so busy channel sessions
          // (which rarely go idle) still produce memory updates.
          'session.idle': async (event) => {
            if (event.origin?.kind === 'subagent') return
            lastIdleEvent.set(event.sessionId, {
              parentTranscriptPath: event.parentTranscriptPath,
              ...(event.origin !== undefined ? { origin: event.origin } : {}),
            })
            cancelTimer(event.sessionId)
            const sessionId = event.sessionId
            const transcriptPath = event.parentTranscriptPath
            const timer = setTimeout(() => {
              idleTimers.delete(sessionId)
              void (async () => {
                if (transcriptPath !== undefined && (await shouldSkipIdleSpawn(sessionId, transcriptPath))) {
                  ctx.logger.info(
                    `memory-logger idle skip ${sessionId} (delta below minIdleDeltaLines=${minIdleDeltaLines})`,
                  )
                  return
                }
                void fireMemoryLogger(sessionId, 'idle')
              })()
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
          // memory-retrieval used to run from `session.prompt`, which fires
          // during system-prompt assembly (createResourceLoader) and carries
          // the ASSEMBLING SYSTEM PROMPT as `event.prompt` — not the user's
          // message. The plugin was feeding that string into the subagent as
          // `recentPrompt`, so the LLM keyword-mined TypeClaw's framing prose
          // (`TypeClaw`, `subagent`, `AGENTS.md`, `systemPromptLeak`, etc.)
          // and burned 15+ memory_search calls per session on terms the user
          // never said. `session.turn.start` is the correct trigger: it fires
          // before each `session.prompt(text)` call with the actual text the
          // session is about to receive.
          //
          'session.turn.start': async (event) => {
            if (ctx.config.vector.enabled) {
              // Vector agents inject long-term memory PER-TURN into the user
              // prompt (the system-prompt `# Memory` section is suppressed at
              // session creation). This runs for every origin that supplies a
              // retrievalContext bag — including subagents, which no longer get
              // memory via the system prompt either.
              if (event.retrievalContext === undefined) return
              try {
                let injectedState = injectedShards.get(event.sessionId)
                if (injectedState === undefined) {
                  injectedState = new Map()
                  injectedShards.set(event.sessionId, injectedState)
                }
                event.retrievalContext.results = await renderVectorTurnMemory(
                  event,
                  ctx.config.injectionBudgetBytes,
                  injectedState,
                  deps,
                  ctx.logger,
                )
              } catch (err) {
                ctx.logger.error(`vector-retrieval failed: ${err instanceof Error ? err.message : String(err)}`)
              }
              return
            }
            // Non-vector agents keep memory in the system prompt. The index-mode
            // retrieval subagent must NOT fire for subagent-origin turns (it would
            // recurse: the subagent it spawns triggers another turn.start).
            if (event.origin?.kind === 'subagent') return
            void runMemoryRetrieval(event).catch((err) => {
              ctx.logger.error(`memory-retrieval spawn failed: ${err instanceof Error ? err.message : String(err)}`)
            })
          },
          // The memory-logger spawn is intentionally detached (`void`) instead
          // of awaited. The channel router calls `tearDownLive` synchronously
          // inside `ensureLive`'s stale-rollover path (router.ts:718), and
          // `tearDownLive` awaits `fireSessionEnd` which awaits this hook. An
          // awaited memory-logger spawn here would block new-session creation
          // for the full subagent runtime — observed as 22+ seconds of channel
          // silence on a 22 KB transcript before the new session even starts
          // its cold-start chain.
          //
          // Safety: `fireMemoryLogger` captures the payload synchronously from
          // `lastIdleEvent` (see comment above), so the `delete` calls below
          // cannot race with the chained spawn. `spawnChain` still serializes
          // memory-logger fires per agentDir — the detached promise is queued
          // onto the chain before this hook returns, so a subsequent fire from
          // the new session (idle, buffer-trip, or session-end) waits for the
          // session-end spawn to settle before running.
          //
          // The only durability tradeoff: if the agent process dies between
          // this hook returning and `spawnChain` settling, the session-end
          // memory-logger fire is lost (its transcript fragments don't make
          // it into today's daily stream). This is already true for the idle
          // and buffer-trip paths, which are timer-driven and fire-and-forget
          // by design. Session JSONLs are force-committed elsewhere, so no
          // user-visible transcript is lost — only the LLM-distilled stream
          // fragments for the final batch.
          'session.end': (event) => {
            // Dedup state is populated for every vector turn (subagents included),
            // so it must be cleared before the subagent-origin early-return below.
            injectedShards.delete(event.sessionId)
            if (event.origin?.kind === 'subagent') return
            cancelTimer(event.sessionId)
            const sessionId = event.sessionId
            // The skip path detaches via `void (async () => …)()` because
            // readSize requires an await. fireMemoryLogger itself captures its
            // payload synchronously from `lastIdleEvent` (see fireMemoryLogger
            // comment block), so the `lastIdleEvent.delete` that follows can
            // never race with the chained spawn. The cache-cleanup and
            // bookkeeping deletes are dispatched alongside (not blocking the
            // hook return) to preserve the "session.end returns synchronously"
            // contract that the channel router's tearDownLive path depends on
            // (see the comment block above this hook).
            void (async () => {
              const last = lastIdleEvent.get(sessionId)
              let skip = false
              if (last?.parentTranscriptPath !== undefined) {
                const baseline = bytesAtLastRun.get(sessionId)
                if (baseline !== undefined && baseline > 0) {
                  const currentSize = await readSize(last.parentTranscriptPath)
                  if (currentSize === baseline) {
                    ctx.logger.info(
                      `memory-logger session-end skip ${sessionId} (no new bytes since last spawn at ${baseline})`,
                    )
                    skip = true
                  }
                }
              }
              if (!skip) void fireMemoryLogger(sessionId, 'session-end')
              lastIdleEvent.delete(sessionId)
              bytesAtLastRun.delete(sessionId)
              linesAtLastRun.delete(sessionId)
              streamCursorAtLastRun.delete(sessionId)
            })()
            const cacheFilePath = join(ctx.agentDir, 'memory', '.retrieval-cache', `${sessionId}.md`)
            unlink(cacheFilePath).catch((err) => {
              if (!isEnoent(err)) ctx.logger.warn(`[memory] failed to clean retrieval cache: ${err}`)
            })
          },
        },
        doctorChecks: {
          'dir-writable': {
            description: 'memory/topics/ exists and is writable',
            run: async (dctx) => {
              const dir = topicsDir(dctx.agentDir)
              try {
                await access(dir, fsConstants.W_OK)
                return { status: 'ok', message: `${dir} writable` }
              } catch {
                try {
                  await mkdir(dir, { recursive: true })
                  return { status: 'ok', message: `created ${dir}` }
                } catch {
                  return {
                    status: 'error',
                    message: `${dir} is missing and could not be created`,
                    fix: {
                      description: 'Create memory/topics/ in the agent folder or fix its permissions on the host.',
                    },
                  }
                }
              }
            },
          },
          'daily-stream-current': {
            description: "today's daily stream file exists",
            run: async (dctx) => {
              const today = new Date().toISOString().slice(0, 10)
              const rel = join('memory', 'streams', `${today}.jsonl`)
              const abs = streamFilePath(dctx.agentDir, today)
              if (existsSync(abs)) return { status: 'ok', message: `${rel} present` }
              return {
                status: 'warning',
                message: `${rel} missing`,
                fix: {
                  description: `Create empty ${rel} so memory-logger has a target.`,
                  apply: async () => {
                    await mkdir(streamsDir(dctx.agentDir), { recursive: true })
                    await writeFile(abs, '', 'utf8')
                    return { summary: `created ${rel}`, changedPaths: [rel] }
                  },
                },
              }
            },
          },
          'pre-shard-backup-age': {
            description: 'Warn when pre-shard backup is older than 30 days',
            run: async (dctx) => {
              const backupPath = preShardBackupPath(dctx.agentDir)
              let s
              try {
                s = await stat(backupPath)
              } catch {
                return { status: 'ok', message: 'no pre-shard backup present' }
              }
              const ageDays = (Date.now() - s.mtimeMs) / 86_400_000
              if (ageDays > 30) {
                return {
                  status: 'warning',
                  message: `pre-shard backup is ${Math.round(ageDays)} days old; safe to delete if migration is verified`,
                  fix: {
                    description: 'Delete the pre-shard backup file',
                    apply: async () => {
                      await unlink(backupPath)
                      return {
                        summary: 'deleted pre-shard backup',
                        changedPaths: [join('memory', 'MEMORY.md.pre-shard.bak')],
                      }
                    },
                  },
                }
              }
              return {
                status: 'ok',
                message: `pre-shard backup is ${Math.round(ageDays)} days old (under 30-day threshold)`,
              }
            },
          },
          'vector-index': {
            description: 'vector index is consistent with memory (only when memory.vector is enabled)',
            run: async (dctx) => {
              const config = dctx.config as typeof ctx.config
              if (!vectorEnabled(config)) {
                return { status: 'ok', message: 'vector memory not enabled; skipping index health check' }
              }
              return runVectorIndexDoctor(dctx.agentDir)
            },
          },
        },
      }
    },
  })
}

export default createMemoryPlugin()

export function createMemoryPluginForTests(overrides: Partial<MemoryPluginDeps> = {}) {
  return createMemoryPlugin({ ...defaultDeps, ...overrides })
}

function vectorEnabled(config: unknown): boolean {
  if (typeof config !== 'object' || config === null) return false
  const parsed = vectorConfigSchema.safeParse((config as Record<string, unknown>).vector)
  return parsed.success && parsed.data.enabled
}

async function readSize(path: string): Promise<number> {
  try {
    const s = await stat(path)
    return s.size
  } catch {
    return 0
  }
}

async function readLineCount(path: string): Promise<number> {
  try {
    const buf = await readFile(path)
    if (buf.length === 0) return 0
    let count = 0
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) count++
    }
    if (buf[buf.length - 1] !== 0x0a) count++
    return count
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

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}
