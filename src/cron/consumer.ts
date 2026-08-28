import type { AgentSession } from '@/agent'
import { applyTurnThinkingLevel } from '@/agent/attention-escalation'
import { promptWithFallback, resolveFallbackChain } from '@/agent/model-fallback'
import type { SessionOrigin } from '@/agent/session-origin'
import { getConfig } from '@/config'
import type { ModelRef } from '@/config/providers'
import type { HookBus } from '@/plugin'
import type { Stream, Unsubscribe } from '@/stream'

import type { CronJob, ExecJob, HandlerJob, PromptJob } from './schema'

export type CronHandlerInvoker = (job: HandlerJob, signal: AbortSignal) => Promise<void>

// `hooks`, `sessionId`, `agentDir`, and `getTranscriptPath` are optional so
// test fakes can stay one-liners. When present, the consumer fires
// `session.turn.start`/`session.turn.end` around `prompt()`, then
// `session.idle` after, then `session.end` on dispose — mirroring the
// lifecycle signals the TUI server emits in `src/server/index.ts`. Without
// this the bundled memory plugin's debounced `memory-logger` never spawns for
// cron prompt jobs (it only wakes on `session.idle`), and the bundled backup
// plugin's turn counter would miss cron-driven activity.
export type CronSession = {
  prompt: (text: string) => Promise<void>
  abort?: () => Promise<void>
  dispose?: () => void
  hooks?: HookBus
  sessionId?: string
  agentDir?: string
  getTranscriptPath?: () => string | undefined
  origin?: SessionOrigin
  // Underlying agent session, exposed so the consumer can subscribe to
  // `message_end` events and surface soft provider errors (billing, rate
  // limit, network — pi-coding-agent encodes these in the assistant message
  // instead of throwing, so the outer try/catch never sees them). Optional
  // so existing test fakes that only need `prompt` keep working.
  session?: AgentSession
}

export type CronConsumerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type CreateCronConsumerOptions = {
  stream: Stream
  cwd: string
  // The optional `refOverride` argument is consumed by the fallback loop: the
  // consumer calls this factory once per ref in the profile's chain, pinning
  // each attempt to the specified model. Factories that don't honor the
  // override silently lose fallback semantics, so production wiring threads
  // it through to `createSession({ refOverride })`.
  createSessionForCron: (job: PromptJob, refOverride?: ModelRef) => Promise<CronSession>
  // Builds the `CronHandlerContext` for the job and awaits its `handler`.
  // Wired by `src/run/index.ts` to reuse `runPromptForCommand` /
  // `runExecForCommand` from the command runner so plugin cron handlers and
  // container plugin commands share one implementation of `ctx.prompt` /
  // `ctx.exec`. Optional so unit-test fakes that never schedule handler jobs
  // stay one-liners.
  invokeHandler?: CronHandlerInvoker
  // Authoritative count gate. The consumer — not the scheduler — owns
  // accepted-fire accounting: it re-checks the durable count and increments
  // only for runs that pass coalescing, so a coalesced skip never consumes a
  // count. Optional so test fakes that don't exercise counts stay one-liners.
  countStore?: ConsumerCountStore
  now?: () => number
  clock?: CronConsumerClock
  logger?: CronConsumerLogger
}

export type CronConsumerClock = {
  now: () => number
  setTimeout: (callback: () => void, ms: number) => number
  clearTimeout: (handle: number) => void
}

export type ConsumerCountStore = {
  get: (id: string, job: CronJob) => number
  // Resolves true if the fire was accepted/counted, false if the job is no
  // longer live (so the consumer skips dispatching stale config).
  increment: (id: string, job: CronJob, at: number) => Promise<boolean>
}

export type CronConsumer = {
  start: () => void
  stop: () => void
  inFlightCount: () => number
}

const consoleLogger: CronConsumerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

const realClock: CronConsumerClock = {
  now: Date.now,
  setTimeout: (callback, ms) => setTimeout(callback, ms) as unknown as number,
  clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
}

// A cron turn can legitimately spend many minutes researching, using tools,
// and retrying providers, so this watchdog deliberately allows a full hour by
// default. The deadline exists to recover from the qualitatively different
// failure mode where session.prompt() never settles: without it, the per-job
// reservation suppresses every later occurrence until container restart.
// Operators with known longer workloads can widen only that job via timeoutMs;
// other job ids remain independent throughout.
export const DEFAULT_CRON_RUN_TIMEOUT_MS = 60 * 60 * 1_000
const EXEC_ABORT_GRACE_MS = 5_000

export function createCronConsumer({
  stream,
  cwd,
  createSessionForCron,
  invokeHandler,
  countStore,
  now = Date.now,
  clock,
  logger = consoleLogger,
}: CreateCronConsumerOptions): CronConsumer {
  const runClock = clock ?? (now === Date.now ? realClock : { ...realClock, now })
  const inFlight = new Map<string, { fireId: string; startedAt: number }>()
  let unsubscribe: Unsubscribe | null = null

  return {
    start() {
      if (unsubscribe !== null) return
      unsubscribe = stream.subscribe({ target: { kind: 'cron' } }, async (msg) => {
        const job = msg.payload as CronJob
        if (!isCronJob(job)) {
          logger.warn(`[cron-consumer] received message ${msg.id} with invalid payload, ignoring`)
          return
        }
        const blocking = inFlight.get(job.id)
        if (blocking !== undefined) {
          logger.warn(
            `[cron] ${job.id}: previous run fire_id=${blocking.fireId} active_for_ms=${Math.max(0, runClock.now() - blocking.startedAt)}, skipping`,
          )
          return
        }
        // Reserve before the count gate so two close occurrences can't both
        // pass the `firedCount < count` check before either increment lands.
        const fireId = msg.id
        const startedAt = runClock.now()
        inFlight.set(job.id, { fireId, startedAt })
        let runStarted = false
        let outcome: 'success' | 'failed' | 'timeout' = 'success'
        try {
          if (job.count !== undefined && countStore !== undefined) {
            if (countStore.get(job.id, job) >= job.count) {
              logger.info(`[cron] ${job.id}: count boundary reached, skipping`)
              return
            }
            // Durably record the accepted fire BEFORE dispatch. A crash here
            // consumes the count without running (at-most-count), which is the
            // correct tradeoff for a reminder versus over-firing on restart.
            // A false result means a reload removed/replaced the job while the
            // write was queued — skip dispatch so we never run stale config.
            const accepted = await countStore.increment(job.id, job, runClock.now())
            if (!accepted) {
              logger.info(`[cron] ${job.id}: job no longer live, skipping dispatch`)
              return
            }
          }
          runStarted = true
          logger.info(`[cron] ${job.id}: run-start fire_id=${fireId}`)
          const control = createRunControl()
          const work = dispatchJob(job, {
            createSessionForCron,
            stream,
            logger,
            cwd,
            invokeHandler,
            control,
            clock: runClock,
          })
          await runWithDeadline(work, job.timeoutMs ?? DEFAULT_CRON_RUN_TIMEOUT_MS, control, runClock)
        } catch (err) {
          outcome = err instanceof CronRunTimeoutError ? 'timeout' : 'failed'
          const message = err instanceof Error ? err.message : String(err)
          if (outcome === 'timeout') logger.error(`[cron] ${job.id}: ${message}`)
          else logger.error(`[cron] ${job.id} failed: ${message}`)
        } finally {
          if (runStarted) {
            logger.info(
              `[cron] ${job.id}: run-end fire_id=${fireId} elapsed_ms=${Math.max(0, runClock.now() - startedAt)} outcome=${outcome}`,
            )
          }
          if (inFlight.get(job.id)?.fireId === fireId) inFlight.delete(job.id)
        }
      })
    },
    stop() {
      unsubscribe?.()
      unsubscribe = null
    },
    inFlightCount() {
      return inFlight.size
    },
  }
}

type RunControl = {
  signal: AbortSignal
  setAbort: (abort: () => void) => () => void
  abort: () => void
}

function createRunControl(): RunControl {
  const controller = new AbortController()
  let abortCurrent: (() => void) | null = null
  return {
    signal: controller.signal,
    setAbort(abort) {
      abortCurrent = abort
      if (controller.signal.aborted) abort()
      return () => {
        if (abortCurrent === abort) abortCurrent = null
      }
    },
    abort() {
      controller.abort()
      abortCurrent?.()
    },
  }
}

class CronRunTimeoutError extends Error {}

async function runWithDeadline(
  work: Promise<void>,
  timeoutMs: number,
  control: RunControl,
  clock: CronConsumerClock,
): Promise<void> {
  const timedOut = Symbol('timed-out')
  let handle: number | null = null
  const deadline = new Promise<typeof timedOut>((resolve) => {
    handle = clock.setTimeout(() => resolve(timedOut), timeoutMs)
  })
  try {
    const result = await Promise.race([work.then(() => undefined), deadline])
    if (result !== timedOut) return
    control.abort()
    throw new CronRunTimeoutError(`run timed out after ${timeoutMs}ms`)
  } finally {
    if (handle !== null) clock.clearTimeout(handle)
  }
}

async function dispatchJob(
  job: CronJob,
  options: {
    createSessionForCron: (job: PromptJob, refOverride?: ModelRef) => Promise<CronSession>
    stream: Stream
    logger: CronConsumerLogger
    cwd: string
    invokeHandler?: CronHandlerInvoker
    control: RunControl
    clock: CronConsumerClock
  },
): Promise<void> {
  if (job.kind === 'prompt') {
    await runPrompt(job, options.createSessionForCron, options.stream, options.logger, options.control)
    return
  }
  if (job.kind === 'exec') {
    await runExec(job, options.cwd, options.control, options.clock)
    return
  }
  if (options.invokeHandler === undefined) {
    throw new Error(
      `handler job dispatched but no invokeHandler wired into the consumer (likely a misconfigured test or boot path)`,
    )
  }
  await options.invokeHandler(job, options.control.signal)
}

async function runPrompt(
  job: PromptJob,
  createSessionForCron: (job: PromptJob, refOverride?: ModelRef) => Promise<CronSession>,
  stream: Stream,
  logger: CronConsumerLogger,
  control: RunControl,
): Promise<void> {
  if (job.subagent !== undefined) {
    // Propagate the cron job's role and origin into the spawned subagent.
    // Without this, every cron-triggered subagent (e.g. memory dreaming)
    // resolves to `guest` because the new-session consumer reads provenance
    // off the stream target rather than rebuilding it. Encode the parent
    // origin as JSON since StreamTarget is a flat-string shape.
    const parentOrigin: SessionOrigin = {
      kind: 'cron',
      jobId: job.id,
      jobKind: 'prompt',
      ...(job.scheduledByRole !== undefined ? { scheduledByRole: job.scheduledByRole } : {}),
    }
    stream.publish({
      target: {
        kind: 'new-session',
        subagent: job.subagent,
        ...(job.scheduledByRole !== undefined ? { spawnedByRole: job.scheduledByRole } : {}),
        spawnedByOriginJson: JSON.stringify(parentOrigin),
      },
      payload: job.payload,
    })
    return
  }
  // Resolve the model fallback chain for the cron profile (cron jobs run
  // under the `default` profile today). Single-ref configs produce a length-1
  // chain; multi-ref configs (e.g. `"default": ["openai/...", "fireworks/..."]`)
  // drive the retry-on-failure loop inside `runPromptOnce`.
  const refs = resolveFallbackChain(getConfig().models, undefined)
  await runPromptOnce(job, refs, createSessionForCron, logger, control)
}

async function runPromptOnce(
  job: PromptJob,
  refs: ModelRef[],
  createSessionForCron: (job: PromptJob, refOverride?: ModelRef) => Promise<CronSession>,
  logger: CronConsumerLogger,
  control: RunControl,
): Promise<void> {
  // Per-attempt lifecycle: every session we create gets full
  // turn-start → turn-end → session-end → dispose bracketing, regardless of
  // whether the helper chose it as the final session or disposed it as a
  // failed earlier attempt. Without per-attempt session.end, plugin state
  // keyed by sessionId (security plugin's remote-taint map, memory plugin's
  // debounce timer) would orphan for every failed attempt. We track the
  // last session separately so we can fire session.idle exactly once on
  // success (matching pre-fallback cron behavior — see the pre-fallback
  // try/finally structure: idle inside the prompt try-block, end in the
  // outer finally).
  let lastSession: CronSession | null = null
  const result = await promptWithFallback({
    refs,
    text: job.prompt,
    createSessionForRef: async (ref) => {
      const created = await createSessionForCron(job, ref)
      lastSession = created
      const turnEvent =
        created.hooks && created.sessionId !== undefined && created.agentDir !== undefined
          ? {
              sessionId: created.sessionId,
              agentDir: created.agentDir,
              ...(created.origin !== undefined ? { origin: created.origin } : {}),
            }
          : undefined
      let disposal: Promise<void> | null = null
      let unregisterAbort = () => {}
      const dispose = async (): Promise<void> => {
        if (disposal !== null) return disposal
        unregisterAbort()
        disposal = (async () => {
          if (created.hooks && turnEvent !== undefined) {
            try {
              await created.hooks.runSessionTurnEnd(turnEvent)
            } catch (e) {
              logger.warn(`[cron] ${job.id}: turn-end hook threw: ${describe(e)}`)
            }
          }
          if (created.hooks && created.sessionId !== undefined) {
            try {
              await created.hooks.runSessionEnd({
                sessionId: created.sessionId,
                ...(created.origin !== undefined ? { origin: created.origin } : {}),
              })
            } catch (e) {
              logger.warn(`[cron] ${job.id}: session-end hook threw: ${describe(e)}`)
            }
          }
          created.dispose?.()
        })()
        return disposal
      }
      const abort = (): void => {
        try {
          const abortPromise = created.abort?.() ?? created.session?.abort()
          void abortPromise?.catch((error) => logger.warn(`[cron] ${job.id}: session abort threw: ${describe(error)}`))
        } catch (error) {
          logger.warn(`[cron] ${job.id}: session abort threw: ${describe(error)}`)
        }
        void dispose()
      }
      unregisterAbort = control.setAbort(abort)
      const throwIfAborted = async (): Promise<void> => {
        if (!control.signal.aborted) return
        unregisterAbort()
        await dispose()
        throw new Error('cron occurrence ended before prompting')
      }
      await throwIfAborted()
      // Per-turn memory injection for vector agents: the turn-start hook writes
      // the rendered memory block into `retrievalContext.results`, which we
      // append to the prompt text below (vector agents have no system-prompt
      // `# Memory` section). Empty for non-vector agents.
      const retrievalContext = { results: '' }
      if (created.hooks && turnEvent !== undefined) {
        await created.hooks.runSessionTurnStart({ ...turnEvent, userPrompt: job.prompt, retrievalContext })
        await throwIfAborted()
      }
      // Cron sessions are created fresh per fallback attempt, so the live getter
      // is still the creation-time default here — safe to read without a separate
      // captured field. The test-fake path omits `.session`; skip it then.
      if (created.session !== undefined) {
        applyTurnThinkingLevel(created.session, job.prompt, created.session.thinkingLevel)
      }
      await throwIfAborted()
      // Bridge the CronSession wrapper into the AgentSession surface the
      // fallback helper expects:
      //   prompt    → CronSession.prompt (wrapper that calls AgentSession.prompt
      //               in production, or a hand-rolled test fake)
      //   subscribe → CronSession.session.subscribe when an underlying agent
      //               session is supplied, else a no-op (soft-error detection
      //               degrades to "off" in that mode; only hard throws drive
      //               fallback). Test fakes that omit `.session` lose
      //               soft-error fallback — production code always provides it.
      // .bind(created.session) is load-bearing: AgentSession.subscribe is a
      // regular method that reads `this._eventListeners`. Destructuring drops
      // the receiver.
      const sessionForHelper: AgentSession = {
        prompt: (text: string) =>
          created.prompt(retrievalContext.results.length > 0 ? `${text}\n\n${retrievalContext.results}` : text),
        subscribe: created.session?.subscribe.bind(created.session) ?? (() => () => {}),
      } as unknown as AgentSession
      return {
        session: sessionForHelper,
        // Per-attempt teardown. Fires turn.end and session.end for every
        // session created (success or failure), then disposes the underlying
        // resources. Hooks that throw are logged but don't prevent disposal.
        dispose,
      }
    },
    onAttemptFailed: (attempt) => {
      logger.warn(
        `[cron] ${job.id}: ${attempt.outcome} failure on ${attempt.ref}: ${attempt.errorMessage ?? 'unknown'}; falling back`,
      )
    },
    shouldFailover: () => !control.signal.aborted,
  })

  if (!result.success) {
    logger.error(
      `[cron] ${job.id}: all ${result.attempts.length} model(s) failed; last error: ${result.lastError?.message ?? 'unknown'}`,
    )
    throw result.lastError ?? new Error('all model attempts failed')
  }

  // session.idle fires once, only on success, and only against the session
  // that handled the turn. Then dispose the successful session (the helper
  // returns the session+dispose so we can run post-prompt hooks against a
  // live session before tearing it down). Failed-chain disposal is already
  // handled by the helper's per-attempt dispose calls.
  if (result.success && lastSession !== null) {
    const finalSession: CronSession = lastSession
    if (finalSession.hooks && finalSession.sessionId !== undefined) {
      try {
        await finalSession.hooks.runSessionIdle({
          sessionId: finalSession.sessionId,
          parentTranscriptPath: finalSession.getTranscriptPath?.(),
          idleMs: 0,
          ...(finalSession.origin !== undefined ? { origin: finalSession.origin } : {}),
        })
      } catch (e) {
        logger.warn(`[cron] ${job.id}: session-idle hook threw: ${describe(e)}`)
      }
    }
    await result.dispose()
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function runExec(job: ExecJob, cwd: string, control: RunControl, clock: CronConsumerClock): Promise<void> {
  const [cmd, ...args] = job.command
  if (!cmd) throw new Error(`exec job ${job.id}: empty command`)
  // Inject TYPECLAW_PARENT_ORIGIN_JSON so a child that proxies into the
  // agent (typically a `typeclaw <container-cmd>` invocation through the
  // host CLI's container-command-client) can stamp its session's
  // spawnedByOrigin with the cron job's provenance. Without this the
  // proxy would default to a synthetic owner origin and silently elevate
  // a guest- or member-scheduled cron job to owner.
  const parentOrigin = {
    kind: 'cron',
    jobId: job.id,
    jobKind: 'exec',
    ...(job.scheduledByRole !== undefined ? { scheduledByRole: job.scheduledByRole } : {}),
    ...(job.scheduledByOrigin !== undefined ? { scheduledByOrigin: job.scheduledByOrigin } : {}),
  }
  const proc = Bun.spawn({
    cmd: [cmd, ...args],
    cwd,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      ...process.env,
      TYPECLAW_PARENT_ORIGIN_JSON: JSON.stringify(parentOrigin),
    },
    detached: true,
  })
  const stderrText = new Response(proc.stderr).text()
  let escalationTimer: number | null = null
  let abortRequested = false
  const unregisterAbort = control.setAbort(() => {
    abortRequested = true
    killProcessGroup(proc.pid, 'SIGTERM')
    escalationTimer = clock.setTimeout(() => {
      escalationTimer = null
      killProcessGroup(proc.pid, 'SIGKILL')
    }, EXEC_ABORT_GRACE_MS)
  })
  const [code, stderr] = await Promise.all([proc.exited, stderrText]).finally(() => {
    unregisterAbort()
    if (!abortRequested && escalationTimer !== null) clock.clearTimeout(escalationTimer)
  })
  if (code !== 0) {
    throw new Error(`exec job ${job.id} exited with code ${code}: ${stderr.trim() || 'no stderr'}`)
  }
}

function killProcessGroup(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // The process already exited.
    }
  }
}

function isCronJob(value: unknown): value is CronJob {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { id?: unknown; kind?: unknown; handler?: unknown }
  if (typeof v.id !== 'string') return false
  if (v.kind === 'prompt' || v.kind === 'exec') return true
  return v.kind === 'handler' && typeof v.handler === 'function'
}
