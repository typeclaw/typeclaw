import type { AgentSession } from '@/agent'
import { subscribeProviderErrors } from '@/agent/provider-error'
import type { SessionOrigin } from '@/agent/session-origin'
import type { HookBus } from '@/plugin'
import type { Stream, Unsubscribe } from '@/stream'

import { DEFAULT_EXEC_MAX_OUTPUT_BYTES, type CronJob, type ExecJob, type PromptJob } from './schema'

export type ExecResult = { stdin: string; stderr: string; exitCode: number }

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
}

export type CronConsumerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type CreateCronConsumerOptions = {
  stream: Stream
  cwd: string
  createSessionForCron: (job: PromptJob) => Promise<CronSession>
  logger?: CronConsumerLogger
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
  logger = consoleLogger,
}: CreateCronConsumerOptions): CronConsumer {
  const inFlight = new Set<string>()
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
        if (inFlight.has(job.id)) {
          logger.warn(`[cron] ${job.id}: previous run still in progress, skipping`)
          return
        }
        inFlight.add(job.id)
        try {
          if (job.kind === 'prompt') {
            await runPrompt(job, cwd, createSessionForCron, stream, logger)
          } else {
            await runExec(job, cwd)
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.error(`[cron] ${job.id} failed: ${message}`)
        } finally {
          inFlight.delete(job.id)
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

async function runPrompt(
  job: PromptJob,
  cwd: string,
  createSessionForCron: (job: PromptJob) => Promise<CronSession>,
  stream: Stream,
  logger: CronConsumerLogger,
): Promise<void> {
  const exec = job.exec !== undefined ? await runExecForPrompt(job, cwd) : undefined
  const effectivePrompt = exec !== undefined ? appendExecToPrompt(job.prompt, exec) : job.prompt
  const effectivePayload = exec !== undefined ? mergeExecIntoPayload(job.payload, exec) : job.payload

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
      payload: effectivePayload,
    })
    return
  }
  const session = await createSessionForCron(job)
  const unsubProviderErrors =
    session.session !== undefined
      ? subscribeProviderErrors(session.session, (err) => {
          logger.error(`[cron] ${job.id}: LLM call failed: ${err.message}`)
        })
      : null
  const turnEvent =
    session.hooks && session.sessionId !== undefined && session.agentDir !== undefined
      ? {
          sessionId: session.sessionId,
          agentDir: session.agentDir,
          ...(session.origin !== undefined ? { origin: session.origin } : {}),
        }
      : undefined
  try {
    if (session.hooks && turnEvent !== undefined) {
      await session.hooks.runSessionTurnStart(turnEvent)
    }
    try {
      await session.prompt(effectivePrompt)
    } finally {
      if (session.hooks && turnEvent !== undefined) {
        await session.hooks.runSessionTurnEnd(turnEvent)
      }
    }
    if (session.hooks && session.sessionId !== undefined) {
      await session.hooks.runSessionIdle({
        sessionId: session.sessionId,
        parentTranscriptPath: session.getTranscriptPath?.(),
        idleMs: 0,
        ...(session.origin !== undefined ? { origin: session.origin } : {}),
      })
    }
  } finally {
    unsubProviderErrors?.()
    if (session.hooks && session.sessionId !== undefined) {
      await session.hooks.runSessionEnd({
        sessionId: session.sessionId,
        ...(session.origin !== undefined ? { origin: session.origin } : {}),
      })
    }
    session.dispose?.()
  }
}

async function runExec(job: ExecJob, cwd: string): Promise<void> {
  const [cmd, ...args] = job.command
  if (!cmd) throw new Error(`exec job ${job.id}: empty command`)
  const proc = Bun.spawn({ cmd: [cmd, ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`exec job ${job.id} exited with code ${code}: ${stderr.trim() || 'no stderr'}`)
  }
}

function isCronJob(value: unknown): value is CronJob {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { id?: unknown; kind?: unknown }
  if (typeof v.id !== 'string') return false
  return v.kind === 'prompt' || v.kind === 'exec'
}

export async function runExecForPrompt(job: PromptJob, cwd: string): Promise<ExecResult> {
  if (job.exec === undefined || job.exec.length === 0) {
    throw new Error(`prompt job ${job.id}: exec is required for runExecForPrompt`)
  }
  const [cmd, ...args] = job.exec
  if (!cmd) throw new Error(`prompt job ${job.id}: empty exec command`)
  const cap = job.execMaxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT_BYTES
  const proc = Bun.spawn({ cmd: [cmd, ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdoutRaw, stderrRaw, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return {
    stdin: truncateUtf8(stdoutRaw, cap),
    stderr: truncateUtf8(stderrRaw, cap),
    exitCode,
  }
}

export function appendExecToPrompt(prompt: string, exec: ExecResult): string {
  const parts = [prompt, '', '```', exec.stdin, '```']
  if (exec.stderr.length > 0) {
    parts.push('', 'stderr:', '```', exec.stderr, '```')
  }
  if (exec.exitCode !== 0) {
    parts.push('', `exit code: ${exec.exitCode}`)
  }
  return parts.join('\n')
}

export function mergeExecIntoPayload(originalPayload: unknown, exec: ExecResult): unknown {
  if (originalPayload === undefined) return { exec }
  if (typeof originalPayload === 'object' && originalPayload !== null && !Array.isArray(originalPayload)) {
    return { ...(originalPayload as Record<string, unknown>), exec }
  }
  // Non-object payload (string, array, number, etc.): wrap so the original
  // value is preserved as `payload.payload` and exec sits alongside it. This
  // is the conservative shape — subagents that declare object payloadSchemas
  // never see this branch in practice.
  return { payload: originalPayload, exec }
}

function truncateUtf8(s: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(s)
  if (bytes.length <= maxBytes) return s
  // Decode the first `maxBytes` bytes with the streaming `fatal: false`
  // decoder so a multi-byte boundary in the middle of a character degrades
  // to U+FFFD instead of throwing.
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const head = decoder.decode(bytes.subarray(0, maxBytes))
  return `${head}\n[truncated ${bytes.length - maxBytes} bytes]`
}
