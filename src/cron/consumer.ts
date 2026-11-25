import type { AgentSession } from '@/agent'
import { applyTurnThinkingLevel } from '@/agent/attention-escalation'
import { promptWithFallback, resolveFallbackChain } from '@/agent/model-fallback'
import { promptWithSameRefRetryOnly } from '@/agent/retry-same-ref'
import type { SessionOrigin } from '@/agent/session-origin'
import {
  beginSubagentDrainWatch,
  DRAIN_MAX_CHILD_WAIT_MS,
  runSubagentDrain,
  type SubagentBackgroundDrain,
  type SubagentDrainWatch,
} from '@/agent/subagent-drain'
import { getConfig } from '@/config'
import type { ModelRef } from '@/config/providers'
import { readOomEvents, toolOomNote } from '@/container/oom-events'
import { withToolOomPriorityArgv } from '@/container/tool-oom-priority'
import type { HookBus } from '@/plugin'
import type { Stream, Unsubscribe } from '@/stream'

import type { CronJob, ExecJob, HandlerJob, PromptJob } from './schema'

export type CronHandlerInvoker = (job: HandlerJob) => Promise<void>

// Extra environment for one exec fire, released after the process exits
// (e.g. a TypeVault grant revoked once the job is done).
export type CronExecEnvLease = { env: Record<string, string>; release: () => Promise<void> }
export type CronExecEnvProvider = (
  origin: Extract<SessionOrigin, { kind: 'cron' }>,
  fireId: string,
) => Promise<CronExecEnvLease | undefined>

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
  // Background subagents the cron turn spawns report back by completion
  // reminder. A cron session has no TUI or channel to receive one, so the
  // consumer drains them into the session before disposing it; without this
  // a turn that delegates its work and ends never sees the results.
  backgroundDrain?: SubagentBackgroundDrain
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
  // Adds per-fire environment to exec jobs. Wired by `src/run/index.ts` to
  // the TypeVault plugin, so an exec job scheduled by a role with `vault.use`
  // gets a grant without an LLM session. Optional for test fakes.
  execEnv?: CronExecEnvProvider
  // Authoritative count gate. The consumer — not the scheduler — owns
  // accepted-fire accounting: it re-checks the durable count and increments
  // only for runs that pass coalescing, so a coalesced skip never consumes a
  // count. Optional so test fakes that don't exercise counts stay one-liners.
  countStore?: ConsumerCountStore
  now?: () => number
  intervalNow?: () => number
  logger?: CronConsumerLogger
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

export function createCronConsumer({
  stream,
  cwd,
  createSessionForCron,
  invokeHandler,
  execEnv,
  countStore,
  now = Date.now,
  intervalNow = () => performance.now(),
  logger = consoleLogger,
}: CreateCronConsumerOptions): CronConsumer {
  const inFlight = new Map<string, { fireId: string; activeSince: number }>()
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
        const blockingFire = inFlight.get(job.id)
        if (blockingFire !== undefined) {
          logger.warn(
            `[cron] ${job.id}: previous run still in progress, skipping blocking_fire_id=${blockingFire.fireId} active_for_ms=${elapsedMs(blockingFire.activeSince, intervalNow())}`,
          )
          return
        }
        // Reserve before the count gate so two close occurrences can't both
        // pass the `firedCount < count` check before either increment lands.
        const fireId = msg.id
        inFlight.set(job.id, { fireId, activeSince: intervalNow() })
        let runStartedAt: number | undefined
        let outcome: 'success' | 'failed' = 'success'
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
            const accepted = await countStore.increment(job.id, job, now())
            if (!accepted) {
              logger.info(`[cron] ${job.id}: job no longer live, skipping dispatch`)
              return
            }
          }
          runStartedAt = intervalNow()
          logger.info(`[cron] ${job.id}: run started fire_id=${fireId}`)
          if (job.kind === 'prompt') {
            if (!(await runPrompt(job, createSessionForCron, stream, logger))) outcome = 'failed'
          } else if (job.kind === 'exec') {
            await runExec(job, cwd, fireId, execEnv, logger)
          } else {
            if (invokeHandler === undefined) {
              throw new Error(
                `handler job dispatched but no invokeHandler wired into the consumer (likely a misconfigured test or boot path)`,
              )
            }
            await invokeHandler(job)
          }
        } catch (err) {
          outcome = 'failed'
          const message = err instanceof Error ? err.message : String(err)
          logger.error(`[cron] ${job.id} failed: ${message}`)
        } finally {
          inFlight.delete(job.id)
          if (runStartedAt !== undefined) {
            logger.info(
              `[cron] ${job.id}: run ended fire_id=${fireId} outcome=${outcome} elapsed_ms=${elapsedMs(runStartedAt, intervalNow())}`,
            )
          }
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

function elapsedMs(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt))
}

async function runPrompt(
  job: PromptJob,
  createSessionForCron: (job: PromptJob, refOverride?: ModelRef) => Promise<CronSession>,
  stream: Stream,
  logger: CronConsumerLogger,
): Promise<boolean> {
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
    return true
  }
  // Resolve the model fallback chain for the cron profile (cron jobs run
  // under the `default` profile today). Single-ref configs produce a length-1
  // chain; multi-ref configs (e.g. `"default": ["openai/...", "fireworks/..."]`)
  // drive the retry-on-failure loop inside `runPromptOnce`.
  const refs = resolveFallbackChain(getConfig().models, undefined)
  return runPromptOnce(job, refs, createSessionForCron, logger)
}

async function runPromptOnce(
  job: PromptJob,
  refs: ModelRef[],
  createSessionForCron: (job: PromptJob, refOverride?: ModelRef) => Promise<CronSession>,
  logger: CronConsumerLogger,
): Promise<boolean> {
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
  let lastDrainWatch: SubagentDrainWatch | undefined
  const result = await promptWithFallback({
    refs,
    text: job.prompt,
    createSessionForRef: async (ref) => {
      const created = await createSessionForCron(job, ref)
      lastSession = created
      // Started before the prompt so a child that completes mid-turn is latched.
      const drainWatch =
        created.backgroundDrain !== undefined ? beginSubagentDrainWatch(created.backgroundDrain) : undefined
      lastDrainWatch = drainWatch
      const turnEvent =
        created.hooks && created.sessionId !== undefined && created.agentDir !== undefined
          ? {
              sessionId: created.sessionId,
              agentDir: created.agentDir,
              ...(created.origin !== undefined ? { origin: created.origin } : {}),
            }
          : undefined
      // Per-turn memory injection for vector agents: the turn-start hook writes
      // the rendered memory block into `retrievalContext.results`, which we
      // append to the prompt text below (vector agents have no system-prompt
      // `# Memory` section). Empty for non-vector agents.
      const retrievalContext = { results: '' }
      if (created.hooks && turnEvent !== undefined) {
        await created.hooks.runSessionTurnStart({ ...turnEvent, userPrompt: job.prompt, retrievalContext })
      }
      // Cron sessions are created fresh per fallback attempt, so the live getter
      // is still the creation-time default here — safe to read without a separate
      // captured field. The test-fake path omits `.session`; skip it then.
      if (created.session !== undefined) {
        applyTurnThinkingLevel(created.session, job.prompt, created.session.thinkingLevel)
      }
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
        dispose: async () => {
          drainWatch?.stop()
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
        },
      }
    },
    onAttemptFailed: (attempt) => {
      logger.warn(
        `[cron] ${job.id}: ${attempt.outcome} failure on ${attempt.ref}: ${attempt.errorMessage ?? 'unknown'}; falling back`,
      )
    },
  })

  if (!result.success) {
    logger.error(
      `[cron] ${job.id}: all ${result.attempts.length} model(s) failed; last error: ${result.lastError?.message ?? 'unknown'}`,
    )
  }

  // session.idle fires once, only on success, and only against the session
  // that handled the turn. Then dispose the successful session (the helper
  // returns the session+dispose so we can run post-prompt hooks against a
  // live session before tearing it down). Failed-chain disposal is already
  // handled by the helper's per-attempt dispose calls.
  let reminderFailed = false
  if (result.success && lastSession !== null) {
    const finalSession: CronSession = lastSession
    // Follow-up turns stay on this session so the original cron prompt is not replayed.
    const promptFinal = async (text: string): Promise<void> => {
      if (finalSession.session === undefined) {
        await finalSession.prompt(text)
        return
      }
      const turn = await promptWithSameRefRetryOnly(finalSession.session, text)
      if (!turn.success) throw turn.lastError ?? new Error('follow-up turn failed')
    }
    // A reminder turn is where the delegated work gets reported, so a provider
    // failure there (thrown, or soft via message_end) fails the run.
    const promptReminder = async (text: string): Promise<void> => {
      try {
        await promptFinal(text)
      } catch (e) {
        reminderFailed = true
        logger.error(`[cron] ${job.id}: background subagent reminder turn failed: ${describe(e)}`)
      }
    }
    // Shared by both drains so the one after the check does not re-deliver a
    // child the first already reported.
    const delivered = new Set<string>()
    const drainBackground = async (watch: SubagentDrainWatch | undefined): Promise<void> => {
      if (finalSession.backgroundDrain === undefined || watch === undefined) return
      await runSubagentDrain(watch, {
        drain: finalSession.backgroundDrain,
        prompt: promptReminder,
        maxChildWaitMs: DRAIN_MAX_CHILD_WAIT_MS,
        delivered,
      })
    }
    await drainBackground(lastDrainWatch)
    if (!reminderFailed) {
      // Started before the check so a child the check turn spawns is drained too.
      const checkWatch =
        finalSession.backgroundDrain !== undefined ? beginSubagentDrainWatch(finalSession.backgroundDrain) : undefined
      // Like the job turn and its reminder turns, the check has no deadline of its
      // own; the job stays in flight until it settles. Its failure is logged and
      // does not fail a run whose own turn succeeded.
      try {
        await promptFinal(CRON_COMPLETION_CHECK_PROMPT)
      } catch (e) {
        logger.warn(`[cron] ${job.id}: completion check turn failed: ${describe(e)}`)
      }
      await drainBackground(checkWatch)
    }
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
  return result.success && !reminderFailed
}

// Sent once at the end of every prompt run. An unattended run has no human to
// say "keep going", and agents report a fixable failure (their own wrong
// command, a step too large for its timeout) as if the job were blocked. This
// is the check a goal loop runs before it lets an agent stop: a run may end as
// done or as a block that survived a different approach, not on a first failure.
export const CRON_COMPLETION_CHECK_PROMPT = [
  '---',
  '**[SYSTEM MESSAGE — not from a human]**',
  '',
  'This scheduled run has not reached a completion check yet. Keep working toward the result the job',
  'asks for. You may end this run only as one of:',
  "- done: the job's result is delivered, or you verified there is nothing to do this time (no change,",
  "  nothing due), and you can point to the evidence. The job's own posting conditions still apply: a",
  '  job that posts only when something changed posts nothing after a verified no-change run;',
  '- blocked: the failing step still fails after you tried a different approach to it in this run (a',
  '  corrected command, a smaller batch, a retry, another source), or only a person can supply what is',
  '  missing (a credential that does not exist, a permission you were denied). One failed attempt is',
  '  not a block.',
  'Post only if you have a new result or new findings since your last message in this run; otherwise',
  'end without posting. A blocked report you already posted stands; do not restate it. Never force past a',
  'permission, credential, or site protection, and never repeat an action that must not run twice (a',
  'send, a purchase, a booking, a deploy). If such an action may already have taken effect, for example',
  'it timed out, check its outcome without repeating it; if you cannot confirm that repeating it is',
  'safe, end as blocked and say what to check.',
  '',
  'Do not acknowledge or reply to this notice.',
  '---',
].join('\n')

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function runExec(
  job: ExecJob,
  cwd: string,
  fireId: string,
  execEnv: CronExecEnvProvider | undefined,
  logger: CronConsumerLogger,
): Promise<void> {
  const [cmd, ...args] = job.command
  if (!cmd) throw new Error(`exec job ${job.id}: empty command`)
  // Inject TYPECLAW_PARENT_ORIGIN_JSON so a child that proxies into the
  // agent (typically a `typeclaw <container-cmd>` invocation through the
  // host CLI's container-command-client) can stamp its session's
  // spawnedByOrigin with the cron job's provenance. Without this the
  // proxy would default to a synthetic owner origin and silently elevate
  // a guest- or member-scheduled cron job to owner.
  const parentOrigin: Extract<SessionOrigin, { kind: 'cron' }> = {
    kind: 'cron',
    jobId: job.id,
    jobKind: 'exec',
    ...(job.scheduledByRole !== undefined ? { scheduledByRole: job.scheduledByRole } : {}),
    ...(job.scheduledByOrigin !== undefined
      ? {
          scheduledByOrigin: job.scheduledByOrigin as NonNullable<
            Extract<SessionOrigin, { kind: 'cron' }>['scheduledByOrigin']
          >,
        }
      : {}),
  }
  // A failed lease still runs the job: without the extra env the command
  // reports what it lacks (e.g. `typevault` names the missing grant) instead
  // of the whole fire disappearing.
  const lease = await execEnv?.(parentOrigin, fireId).catch((err: unknown) => {
    logger.warn(`[cron] ${job.id}: could not prepare exec environment: ${describe(err)}`)
    return undefined
  })
  let code: number
  let stderr: string
  const oomBefore = readOomEvents()
  try {
    const proc = Bun.spawn({
      cmd: withToolOomPriorityArgv([cmd, ...args]),
      cwd,
      stdout: 'ignore',
      stderr: 'pipe',
      env: {
        ...process.env,
        ...lease?.env,
        TYPECLAW_PARENT_ORIGIN_JSON: JSON.stringify(parentOrigin),
      },
    })
    const stderrText = new Response(proc.stderr).text()
    ;[code, stderr] = await Promise.all([proc.exited, stderrText])
  } finally {
    await lease?.release().catch((err: unknown) => {
      logger.warn(`[cron] ${job.id}: could not release exec environment: ${describe(err)}`)
    })
  }
  const note = toolOomNote(oomBefore, code, 'cron exec', { log: logger.warn })
  if (code !== 0) {
    throw new Error(
      `exec job ${job.id} exited with code ${code}: ${stderr.trim() || 'no stderr'}${note === null ? '' : `\n${note}`}`,
    )
  }
}

function isCronJob(value: unknown): value is CronJob {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { id?: unknown; kind?: unknown; handler?: unknown }
  if (typeof v.id !== 'string') return false
  if (v.kind === 'prompt' || v.kind === 'exec') return true
  return v.kind === 'handler' && typeof v.handler === 'function'
}
