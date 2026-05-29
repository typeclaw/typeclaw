import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import type { z } from 'zod'

import type { HookBus } from '@/plugin'
import type { Stream, Unsubscribe } from '@/stream'

import { type AgentSession, createSession } from './index'
import { subscribeProviderErrors } from './provider-error'
import type { SessionOrigin } from './session-origin'
import { renderTurnTimeAnchor } from './system-prompt'
import type { ToolResultBudget } from './tool-result-budget'

type AgentSessionTools = NonNullable<Parameters<typeof createSession>[0]>['tools']

export type SubagentContext<P = unknown> = {
  userPrompt: string
  agentDir: string
  payload: P
}

export type RunSession = (override?: { userPrompt?: string }) => Promise<void>

// Fields shared verbatim between the plugin-author-facing `Subagent` in
// `@/plugin/types` and the runtime-internal `Subagent` below. Every consumer
// that reads from `SubagentRegistry` (the spawn_subagent tool, payload
// validation, default session construction) only touches these fields, so
// keeping them in a single declaration makes the plugin→internal shim a
// rest-spread instead of a hand-maintained property list. Adding a new field
// here surfaces it on both types in one edit, which is the regression class
// the previous shim shape suffered: `visibility` and `requiresSpecificPermission`
// existed on the plugin type but were silently dropped by the shim, so every
// plugin-contributed public subagent appeared internal at the registry layer.
//
// The two fields that intentionally diverge — `tools` and `customTools` —
// live on each concrete `Subagent` type below. The plugin side uses
// `BuiltinToolRef[]` + `Tool<any>[]` (the public plugin API, decoupled from
// pi-coding-agent's internal tool shape); the internal side uses the resolved
// `AgentSessionTools` + `ToolDefinition[]` that pi-coding-agent actually
// consumes. The boundary is real and load-bearing — collapsing it would
// expose pi-coding-agent's internal API as part of the plugin contract.
export type SandboxMount = {
  src: string
  dst: string
  mode: 'ro' | 'rw'
}

// Per-tool bwrap sandbox for `bash` calls originating from this subagent.
// When set, the bash tool wrapper rewrites `args.command` into a `bwrap …
// bash -c <command>` invocation before pi-coding-agent's bash tool executes
// it. The wrapper runs AFTER existing `tool.before` hooks (so guards like
// secret-exfil-bash and git-exfil still see the original command and can
// pattern-match against it). The wrapper runs BEFORE `tool.execute`, so the
// kernel-level isolation applies to the actual process.
//
// Defaults (`sandbox: true` or omitted fields) are strict: no network, no
// /agent visibility, --clearenv, tmpfs /tmp + /proc (the latter avoids the
// OrbStack /proc-leak documented in docs/internals/sandbox.mdx). Widen
// deliberately per-subagent: `mounts` for read-only access to specific
// agent-folder paths, `envPassthrough` to forward named env vars (never
// FIREWORKS_API_KEY or other model credentials), `network: 'inherit'` only
// when the subagent legitimately needs egress AND the threat model accepts
// the broader blast radius (see docs/internals/sandbox.mdx for why this is
// usually wrong for read-only subagents that consume attacker-controlled
// content).
//
// `allowlist` is a defense-in-depth prefix filter that runs before bwrap is
// invoked. Commands containing shell metacharacters (`;`, `&`, `|`, `` ` ``,
// `$`, `(`, `)`, `<`, `>`, `\`, newline) are always rejected; allowlisted
// prefixes must match the normalized command after that check. The
// allowlist is a scoping tool (catches model-being-too-eager); the bwrap
// sandbox itself is the containment tool (catches prompt-injection-succeeded).
// Both layers compose in the wrapper.
export type SandboxOptions = {
  mounts?: SandboxMount[]
  network?: 'none' | 'inherit'
  envPassthrough?: string[]
  allowlist?: string[]
  cwd?: string
}

export type SubagentShared<P = unknown> = {
  systemPrompt: string
  // Model profile this subagent prefers. Resolved against `config.models` at
  // session construction. Unknown profile names fall back to `default` with
  // a warning. See `Subagent` in `@/plugin/types` for the full contract.
  profile?: string
  payloadSchema?: z.ZodType<P>
  handler?: (ctx: SubagentContext<P>, runSession: RunSession) => Promise<void>
  toolResultBudget?: ToolResultBudget
  visibility?: 'public' | 'internal'
  requiresSpecificPermission?: boolean
  // Wall-clock ceiling on a single spawn, enforced at the orchestration
  // layer (both `dispatchSpawnSubagent` and the stream-driven
  // `SubagentConsumer`). When exceeded, the orchestrator's `await` settles
  // with a timeout error and releases the coalescing key for `inFlightKey`,
  // so the next spawn of the same (name, inFlightKey) can proceed instead
  // of being skip-coalesced. The underlying `invokeSubagent` call may keep
  // running — pi-coding-agent's `session.prompt` does not accept an
  // AbortSignal today, so a half-open LLM stream stays alive until the OS
  // reaps it. The trade-off is honest: cancellation is upstream's job;
  // releasing the coalescing key is ours, and that is what unblocks the
  // user-visible "every subsequent turn skipped while the first spawn
  // hangs" symptom. Omit for no ceiling (legacy behavior; the spawn waits
  // as long as the provider takes).
  timeoutMs?: number
  sandbox?: true | SandboxOptions
}

export type Subagent<P = unknown> = SubagentShared<P> & {
  tools?: AgentSessionTools
  customTools?: ToolDefinition[]
}

export type SubagentRegistry = Readonly<Record<string, Subagent<any>>>

// Validate payload against the subagent's schema. Strict: when no schema is
// declared, a non-undefined payload is rejected to prevent silent drops of
// caller intent.
export function validateSubagentPayload(name: string, subagent: Subagent<any>, payload: unknown): unknown {
  if (subagent.payloadSchema) {
    const result = subagent.payloadSchema.safeParse(payload)
    if (!result.success) {
      throw new Error(`subagent ${name}: invalid payload: ${result.error.message}`)
    }
    return result.data
  }
  if (payload !== undefined) {
    throw new Error(`subagent ${name}: does not accept a payload (received ${describePayload(payload)})`)
  }
  return payload
}

function describePayload(payload: unknown): string {
  if (payload === null) return 'null'
  if (Array.isArray(payload)) return 'array'
  return typeof payload
}

export type CreateSessionForSubagentResult = {
  session: AgentSession
  dispose?: () => Promise<void>
  hooks?: HookBus
  sessionId?: string
  agentDir?: string
  origin?: SessionOrigin
  getTranscriptPath?: () => string | undefined
}
export type CreateSessionForSubagentOptions = {
  name?: string
  parentSessionId?: string
  spawnedByRole?: string
  spawnedByOrigin?: SessionOrigin
}
export type CreateSessionForSubagent = (
  subagent: Subagent<any>,
  options?: CreateSessionForSubagentOptions,
) => Promise<AgentSession | CreateSessionForSubagentResult>

export const defaultCreateSessionForSubagent: CreateSessionForSubagent = (subagent, options) =>
  createSession({
    systemPromptOverride: subagent.systemPrompt,
    origin: {
      kind: 'subagent',
      subagent: options?.name ?? '<unknown>',
      parentSessionId: options?.parentSessionId ?? '<unknown>',
      ...(options?.spawnedByRole !== undefined ? { spawnedByRole: options.spawnedByRole } : {}),
      ...(options?.spawnedByOrigin !== undefined ? { spawnedByOrigin: options.spawnedByOrigin } : {}),
    },
    ...(subagent.tools ? { tools: subagent.tools } : {}),
    customTools: subagent.customTools ?? [],
    ...(subagent.profile !== undefined ? { profile: subagent.profile } : {}),
    ...(subagent.toolResultBudget !== undefined ? { toolResultBudget: subagent.toolResultBudget } : {}),
  })

type NormalizedSubagentSession = {
  session: AgentSession
  dispose: () => Promise<void>
  hooks: HookBus | undefined
  sessionId: string | undefined
  agentDir: string | undefined
  origin: SessionOrigin | undefined
  getTranscriptPath: (() => string | undefined) | undefined
}

function normalizeSubagentSession(result: AgentSession | CreateSessionForSubagentResult): NormalizedSubagentSession {
  if ('session' in result) {
    return {
      session: result.session,
      dispose: result.dispose ?? (async () => {}),
      hooks: result.hooks,
      sessionId: result.sessionId,
      agentDir: result.agentDir,
      origin: result.origin,
      getTranscriptPath: result.getTranscriptPath,
    }
  }
  return {
    session: result,
    dispose: async () => {},
    hooks: undefined,
    sessionId: undefined,
    agentDir: undefined,
    origin: undefined,
    getTranscriptPath: undefined,
  }
}

export type InvokeSubagentOptions = {
  registry: SubagentRegistry
  createSessionForSubagent?: CreateSessionForSubagent
  agentDir: string
  userPrompt: string
  payload?: unknown
  parentSessionId?: string
  spawnedByRole?: string
  spawnedByOrigin?: SessionOrigin
  onProviderError?: (errorMessage: string) => void
  // Fires synchronously after the AgentSession is created and before
  // session.prompt() is invoked, with both the live session reference and
  // its allocated sessionId. The only consumer in production is the spawn
  // tool's LiveSubagentRegistry path, which uses it to attach a progress
  // subscriber and register the abort handle while invokeSubagent retains
  // its `Promise<void>` external contract.
  onSessionCreated?: (event: {
    session: AgentSession
    sessionId: string | undefined
    abort: () => Promise<void>
  }) => void
}

export async function invokeSubagent(name: string, options: InvokeSubagentOptions): Promise<void> {
  const subagent = options.registry[name]
  if (!subagent) throw new Error(`unknown subagent: ${name}`)

  const validatedPayload = validateSubagentPayload(name, subagent, options.payload)
  const createSessionForSubagent = options.createSessionForSubagent ?? defaultCreateSessionForSubagent
  const sessionOptions: CreateSessionForSubagentOptions = {
    name,
    ...(options.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
    ...(options.spawnedByRole !== undefined ? { spawnedByRole: options.spawnedByRole } : {}),
    ...(options.spawnedByOrigin !== undefined ? { spawnedByOrigin: options.spawnedByOrigin } : {}),
  }

  const runSession: RunSession = async (override) => {
    const { session, dispose, hooks, sessionId, agentDir, origin, getTranscriptPath } = normalizeSubagentSession(
      await createSessionForSubagent(subagent, sessionOptions),
    )
    if (options.onSessionCreated !== undefined) {
      options.onSessionCreated({
        session,
        sessionId,
        abort: async () => {
          await session.abort()
        },
      })
    }
    const unsubProviderErrors =
      options.onProviderError !== undefined
        ? subscribeProviderErrors(session, (err) => options.onProviderError!(err.message))
        : null
    const turnEvent =
      hooks && sessionId !== undefined && agentDir !== undefined
        ? { sessionId, agentDir, ...(origin !== undefined ? { origin } : {}) }
        : undefined
    const userPromptForTurn = override?.userPrompt ?? options.userPrompt
    try {
      if (hooks && turnEvent !== undefined) {
        await hooks.runSessionTurnStart({ ...turnEvent, userPrompt: userPromptForTurn })
      }
      try {
        await session.prompt(`${renderTurnTimeAnchor()}\n\n${userPromptForTurn}`)
      } finally {
        if (hooks && turnEvent !== undefined) {
          await hooks.runSessionTurnEnd(turnEvent)
        }
      }
      if (hooks && sessionId !== undefined) {
        await hooks.runSessionIdle({
          sessionId,
          parentTranscriptPath: getTranscriptPath?.(),
          idleMs: 0,
          ...(origin !== undefined ? { origin } : {}),
        })
      }
    } finally {
      unsubProviderErrors?.()
      if (hooks && sessionId !== undefined) {
        await hooks.runSessionEnd({ sessionId, ...(origin !== undefined ? { origin } : {}) })
      }
      session.dispose()
      await dispose()
    }
  }

  if (subagent.handler) {
    const ctx = {
      userPrompt: options.userPrompt,
      agentDir: options.agentDir,
      payload: validatedPayload,
    }
    await subagent.handler(ctx, runSession)
  } else {
    await runSession()
  }
}

export class SubagentTimeoutError extends Error {
  override readonly name = 'SubagentTimeoutError'
  constructor(
    readonly subagentName: string,
    readonly coalesceKey: string,
    readonly timeoutMs: number,
  ) {
    super(`subagent ${subagentName} (key=${coalesceKey}) spawn timed out after ${timeoutMs}ms`)
  }
}

export function isSubagentTimeoutError(err: unknown): err is SubagentTimeoutError {
  return err instanceof SubagentTimeoutError
}

export async function awaitWithSubagentTimeout(
  work: Promise<void>,
  subagentName: string,
  coalesceKey: string,
  timeoutMs: number | undefined,
): Promise<void> {
  if (timeoutMs === undefined) {
    await work
    return
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SubagentTimeoutError(subagentName, coalesceKey, timeoutMs)), timeoutMs)
  })
  try {
    await Promise.race([work, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

export type SubagentHandle = {
  taskId: string
  sessionId: string | undefined
  abort: () => Promise<void>
}

export type StartSubagentResult = {
  handle: Promise<SubagentHandle>
  completion: Promise<{ ok: true; finalMessage?: string } | { ok: false; error: string }>
}

export type StartSubagentOptions = InvokeSubagentOptions & {
  taskId: string
  onSession?: (event: { session: AgentSession; sessionId: string | undefined; abort: () => Promise<void> }) => void
}

// Non-blocking alternative to invokeSubagent. Returns immediately with two
// promises:
// - `handle` resolves with { taskId, sessionId, abort } once the AgentSession
//   has been created (typically the first microtask). The taskId is what the
//   caller chose; sessionId is allocated by the session factory.
// - `completion` resolves when the subagent's prompt finishes, ok=true with
//   an optional final message, or ok=false with an error message.
// The two promises share a single underlying invokeSubagent invocation;
// `completion` settles after dispose, so the session reference exposed via
// `handle.abort` becomes a no-op once `completion` resolves.
export function startSubagent(name: string, options: StartSubagentOptions): StartSubagentResult {
  let resolveHandle: (h: SubagentHandle) => void
  let rejectHandle: (err: Error) => void
  const handle = new Promise<SubagentHandle>((resolve, reject) => {
    resolveHandle = resolve
    rejectHandle = reject
  })
  let handleSettled = false
  let finalMessage: string | undefined

  const completion = invokeSubagent(name, {
    ...options,
    onSessionCreated: (event) => {
      handleSettled = true
      resolveHandle({ taskId: options.taskId, sessionId: event.sessionId, abort: event.abort })
      if (options.onSession !== undefined) {
        options.onSession(event)
      }
      attachFinalMessageCapture(event.session, (msg) => {
        finalMessage = msg
      })
    },
  })
    .then(() => ({ ok: true as const, ...(finalMessage !== undefined ? { finalMessage } : {}) }))
    .catch((err: unknown) => {
      const error = err instanceof Error ? err.message : String(err)
      if (!handleSettled) {
        rejectHandle(err instanceof Error ? err : new Error(error))
      }
      return { ok: false as const, error }
    })

  return { handle, completion }
}

function attachFinalMessageCapture(session: AgentSession, onFinalMessage: (msg: string) => void): void {
  try {
    session.subscribe((event: unknown) => {
      const ev = event as { type?: string; message?: { content?: unknown } }
      if (ev?.type !== 'message_end') return
      const text = extractFinalMessageText(ev.message?.content)
      if (text !== null) onFinalMessage(text)
    })
  } catch {
    // session.subscribe is a stable upstream API; defensive try is for test
    // doubles that don't implement it.
  }
}

function extractFinalMessageText(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed ? trimmed : null
  }
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const text = (part as { text?: unknown }).text
        if (typeof text === 'string') parts.push(text)
      }
    }
    const joined = parts.join('').trim()
    return joined ? joined : null
  }
  return null
}

export type SubagentConsumerLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type SubagentInFlightKey = (subagent: string, payload: unknown) => string

export type CreateSubagentConsumerOptions = {
  stream: Stream
  // Resolved per incoming stream message so plugin reload can swap the merged
  // registry without rebuilding the consumer.
  getRegistry: () => SubagentRegistry
  agentDir: string
  createSessionForSubagent?: CreateSessionForSubagent
  // Coalescing key. Default uses the subagent name alone, so the same subagent
  // cannot run concurrently. Override to allow per-payload concurrency (e.g.
  // memory-logger keyed by parentSessionId so different sessions run in parallel
  // while the same session deduplicates).
  inFlightKey?: SubagentInFlightKey
  logger?: SubagentConsumerLogger
}

export type SubagentConsumer = {
  start: () => void
  stop: () => void
  inFlightCount: () => number
}

const consoleLogger: SubagentConsumerLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

function parseSpawnedByOriginJson(
  raw: string | undefined,
  logger: SubagentConsumerLogger,
  subagentName: string,
): SessionOrigin | undefined {
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn(`[subagent] ${subagentName}: ignoring malformed spawnedByOriginJson on stream target: ${message}`)
    return undefined
  }
  // Shape-validate the decoded value so a malformed sender (or a future
  // bug in cron consumer's encode side) cannot poison the subagent's
  // origin with arbitrary shapes. The check is narrow: object with a
  // `kind` field whose value is one of the SessionOrigin discriminator
  // strings. Permission resolution treats unknown shapes as guest, so
  // failing closed here matches the rest of the system.
  if (!isSessionOriginShape(parsed)) {
    logger.warn(`[subagent] ${subagentName}: ignoring spawnedByOriginJson with unrecognized SessionOrigin shape`)
    return undefined
  }
  return parsed
}

const SESSION_ORIGIN_KINDS = new Set(['tui', 'cron', 'channel', 'subagent'])
function isSessionOriginShape(value: unknown): value is SessionOrigin {
  if (value === null || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return typeof kind === 'string' && SESSION_ORIGIN_KINDS.has(kind)
}

export function createSubagentConsumer({
  stream,
  getRegistry,
  agentDir,
  createSessionForSubagent,
  inFlightKey = (name) => name,
  logger = consoleLogger,
}: CreateSubagentConsumerOptions): SubagentConsumer {
  const inFlight = new Set<string>()
  let unsubscribe: Unsubscribe | null = null

  return {
    start() {
      if (unsubscribe !== null) return
      unsubscribe = stream.subscribe({ target: { kind: 'new-session' } }, async (msg) => {
        const target = msg.target as {
          kind: 'new-session'
          subagent: string
          parentSessionId?: string
          spawnedByRole?: string
          spawnedByOriginJson?: string
        }
        const name = target.subagent
        const registry = getRegistry()
        if (registry[name] === undefined) {
          logger.warn(`[subagent] no registered subagent "${name}", ignoring ${msg.id}`)
          return
        }
        const key = inFlightKey(name, msg.payload)
        if (inFlight.has(key)) {
          logger.warn(`[subagent] ${key}: previous run still in progress, skipping`)
          return
        }
        inFlight.add(key)
        try {
          const spawnedByOrigin = parseSpawnedByOriginJson(target.spawnedByOriginJson, logger, name)
          await awaitWithSubagentTimeout(
            invokeSubagent(name, {
              registry,
              ...(createSessionForSubagent !== undefined ? { createSessionForSubagent } : {}),
              agentDir,
              userPrompt: '',
              payload: msg.payload,
              onProviderError: (message) => logger.error(`[subagent] ${key}: LLM call failed: ${message}`),
              ...(target.parentSessionId !== undefined ? { parentSessionId: target.parentSessionId } : {}),
              ...(target.spawnedByRole !== undefined ? { spawnedByRole: target.spawnedByRole } : {}),
              ...(spawnedByOrigin !== undefined ? { spawnedByOrigin } : {}),
            }),
            name,
            key,
            registry[name]?.timeoutMs,
          )
        } catch (err) {
          if (isSubagentTimeoutError(err)) {
            logger.warn(`[subagent] ${key} timed out after ${err.timeoutMs}ms; releasing coalesce key`)
          } else {
            const message = err instanceof Error ? err.message : String(err)
            logger.error(`[subagent] ${key} failed: ${message}`)
          }
        } finally {
          inFlight.delete(key)
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
