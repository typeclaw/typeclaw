import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  createBashToolDefinition as piCreateBashToolDefinition,
  createEditToolDefinition as piCreateEditToolDefinition,
  createFindToolDefinition as piCreateFindToolDefinition,
  createGrepToolDefinition as piCreateGrepToolDefinition,
  createLsToolDefinition as piCreateLsToolDefinition,
  createReadToolDefinition as piCreateReadToolDefinition,
  createWriteToolDefinition as piCreateWriteToolDefinition,
  defineTool as piDefineTool,
} from '@mariozechner/pi-coding-agent'
import type { BashSpawnContext, ToolDefinition } from '@mariozechner/pi-coding-agent'
import type { Static, TSchema } from 'typebox'
import { Type } from 'typebox'
import { z } from 'zod'

import {
  ACKNOWLEDGE_GUARDS,
  checkManagedConfigGuard,
  checkNonWorkspaceWriteGuard,
  checkSkillAuthoringGuard,
} from '@/bundled-plugins/guard/policy'
import { config, getSandboxWritablePathSpecs } from '@/config/config'
import { assertNoCanonicalSecretsInGit } from '@/git/secret-history'
import { readEnvFile } from '@/init/env-file'
import type { PermissionService } from '@/permissions/permissions'
import type {
  BuiltinToolRef,
  ContentPart,
  HookBus,
  PluginLogger,
  Tool,
  ToolBeforeEvent,
  ToolContext,
  ToolResult,
} from '@/plugin'
import {
  buildSandboxedCommand,
  canWriteAgentRootInSandbox,
  canMountRealProc,
  cleanupPrivilegedSandboxRuntime,
  commandNeedsRealProc,
  DEFAULT_SANDBOX_ENV,
  ensureBwrapAvailable,
  ensureHiddenMaskTargets,
  ensureSessionTmpDir,
  getProcBindSafetyVerdict,
  isGitControlPath,
  mapVirtualTmpPath,
  resolveHiddenPaths,
  resolvePrivilegedSandboxRuntime,
  resolveProcBindSafetyWithRetry,
  resolveProcSelfExe,
  resolveProtectedZones,
  resolveSandboxSymlinks,
  resolveWritableZones,
  SandboxPolicyError,
  SandboxDegradedProcError,
  SandboxProcProbeUnverifiedError,
  subtractMasked,
  verifyHiddenMaskTargets,
  verifyPrivilegedSandboxRuntime,
} from '@/sandbox'
import { isSecretEnvName, resolveExposableEnvNames } from '@/sandbox/env-exposure'
import { collectSecretEnvRefs } from '@/secrets/env-refs'

import { createLoopGuard, type LoopGuard, type LoopGuardDecision } from './loop-guard'
import { checkImageReadRedirect } from './multimodal/read-redirect'
import { enforceSubagentBashPolicy, type SubagentBashPolicy } from './reviewer-bash-policy'
import type { SessionOrigin } from './session-origin'
import { enforceAndPinToolFiles, writeToolOutputNoFollow } from './tool-file-safety'
import { SUBAGENT_OUTPUT_TOOL_NAME, type SubagentOutputToolDetails } from './tools/subagent-output'
import { webFetchTool } from './tools/webfetch'
import { webSearchTool } from './tools/websearch'

// Process-wide loop guard. State is keyed by sessionId so concurrent sessions
// don't interfere; the guard's own LRU bound keeps it from growing without
// limit. Wrappers consult it before invoking the underlying tool so the
// detector covers every tool category — plugin tools, TypeClaw system tools,
// and pi-coding-agent builtins — through one chokepoint.
let sharedLoopGuard: LoopGuard = createLoopGuard()

// Internal, non-model-facing contract: a tool.before hook may set this key on
// a bash call's args to inject env vars into the spawned process WITHOUT
// putting them in the command string (where they would leak through logs and
// later hooks). The wrapper extracts and deletes it before the bash tool runs,
// then threads it to the spawn. Sandboxed secret values stay in bwrap's parent
// environment and are inherited by name rather than rendered into argv. Used
// by github-cli-auth to inject a per-repo GH_TOKEN. The key
// is stripped from client-supplied args before tool.before so only trusted
// hooks can set it.
export const TYPECLAW_INTERNAL_BASH_ENV = '__typeclawBashEnv'

type BashEnvOverlay = Record<string, string>
const SECRET_BASH_ENV_NAMES = new Set(['GH_TOKEN', 'GITHUB_TOKEN'])

type BashSpawnEnvContext = {
  overlay?: BashEnvOverlay
  // Exact env for the outer bwrap process on a sandboxed call. When present, the
  // spawn hook uses it verbatim rather than the live inherited env, so a secret
  // that appears in process.env between policy build and spawn stays out of the
  // sandbox (closes the inherit TOCTOU).
  sandboxSpawnEnv?: Record<string, string>
}

const bashEnvStore = new AsyncLocalStorage<BashSpawnEnvContext | undefined>()

function readBashEnvOverlay(args: Record<string, unknown>): BashEnvOverlay | undefined {
  const raw = args[TYPECLAW_INTERNAL_BASH_ENV]
  if (raw === null || typeof raw !== 'object') return undefined
  const overlay: BashEnvOverlay = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') overlay[key] = value
  }
  return Object.keys(overlay).length > 0 ? overlay : undefined
}

function bashSpawnHookWithOverlay(context: BashSpawnContext): BashSpawnContext {
  const store = bashEnvStore.getStore()
  if (store?.sandboxSpawnEnv !== undefined) return { ...context, env: { ...store.sandboxSpawnEnv } }
  return { ...context, env: sanitizeBashSpawnEnvironment(context.env, store?.overlay) }
}

export function sanitizeBashSpawnEnvironment(
  inherited: NodeJS.ProcessEnv | undefined,
  overlay: BashEnvOverlay | undefined,
): NodeJS.ProcessEnv {
  const env = { ...inherited }
  for (const name of SECRET_BASH_ENV_NAMES) delete env[name]
  if (overlay !== undefined) Object.assign(env, overlay)
  return env
}

const ACKNOWLEDGE_GUARDS_SCHEMA = Type.Optional(
  Type.Object(
    {
      nonWorkspaceWrite: Type.Optional(Type.Boolean()),
      rolePromotion: Type.Optional(Type.Boolean()),
      cronPromotion: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
)

// pi-coding-agent 0.73 contract (load-bearing for hook coverage):
//   - `createAgentSession({ tools: string[] })` is a name allowlist: only the
//     listed names stay active, and that allowlist gates BOTH builtins and
//     custom tools (see `allowedToolNames` in pi's `_refreshToolRegistry`).
//   - `noTools: "builtin"` drops pi's read/bash/edit/write from the INITIAL
//     active set; pi still registers its base builtins, so a same-named entry
//     in `customTools` is what overrides the implementation (registry
//     last-write-wins). Passing an explicit `tools:` allowlist plus shipping all
//     seven wrapped builtins is what makes the wrapped versions the only
//     callable ones.
//
// Consequence: every builtin enters as a `ToolDefinition` (pi now exposes
// `create*ToolDefinition` factories), TypeClaw wraps each one with its hook +
// guard + sandbox pipeline, and the call site routes them through `customTools`
// while narrowing via `tools:` names. There is no longer an `AgentTool` vs
// `ToolDefinition` split.
type PiBuiltinToolName = 'read' | 'bash' | 'edit' | 'write' | 'grep' | 'find' | 'ls'
type TypeclawToolName = 'web_search' | 'web_fetch'

const PI_BUILTIN_TOOL_NAMES: readonly PiBuiltinToolName[] = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']

// pi builtins resolve relative paths (and, for trusted/owner bash, the spawn
// cwd) against the cwd baked in at factory time, so the definitions are built
// per session from the session's agentDir rather than the module-load
// process.cwd() — otherwise a session whose agentDir differs from the import-
// time cwd would read/write in the wrong tree. bash keeps the spawnHook that
// threads the internal env overlay to the (non-sandboxed) spawn.
function createPiBuiltinToolDefinition(name: PiBuiltinToolName, cwd: string): ToolDefinition<any, any, any> {
  switch (name) {
    case 'read':
      return piCreateReadToolDefinition(cwd)
    case 'bash':
      return piCreateBashToolDefinition(cwd, { spawnHook: bashSpawnHookWithOverlay })
    case 'edit':
      return piCreateEditToolDefinition(cwd)
    case 'write':
      return piCreateWriteToolDefinition(cwd, {
        operations: {
          mkdir: async (dir) => {
            await mkdir(dir, { recursive: true })
          },
          writeFile: writeToolOutputNoFollow,
        },
      })
    case 'grep':
      return piCreateGrepToolDefinition(cwd)
    case 'find':
      return piCreateFindToolDefinition(cwd)
    case 'ls':
      return piCreateLsToolDefinition(cwd)
  }
}

const TYPECLAW_TOOL_DEFINITION_MAP: Record<TypeclawToolName, ToolDefinition<any, any, any>> = {
  web_search: webSearchTool,
  web_fetch: webFetchTool,
}

function isPiBuiltinToolName(name: string): name is PiBuiltinToolName {
  return (PI_BUILTIN_TOOL_NAMES as readonly string[]).includes(name)
}

export function isPiCodingBuiltinName(name: string): boolean {
  return isPiBuiltinToolName(name)
}

function isTypeclawToolName(name: string): name is TypeclawToolName {
  return name in TYPECLAW_TOOL_DEFINITION_MAP
}

export function resolveBuiltinToolRefs(refs: BuiltinToolRef[], cwd: string): ToolDefinition<any, any, any>[] {
  return refs.map((ref) => {
    const name = ref.__builtinTool
    if (isPiBuiltinToolName(name)) return createPiBuiltinToolDefinition(name, cwd)
    if (isTypeclawToolName(name)) return TYPECLAW_TOOL_DEFINITION_MAP[name]
    throw new Error(`unknown built-in tool ref: ${name}`)
  })
}

export type WrapToolOptions = {
  pluginName: string
  toolName: string
  agentDir: string
  sessionId: string
  logger: PluginLogger
  hooks: HookBus
  // Called at tool-execute time (not at wrap time) so channel sessions whose
  // origin mutates per turn surface the current-turn `lastInboundAuthorId`
  // to `tool.before`. Sessions with a fixed origin can pass `() => origin`.
  getOrigin?: () => SessionOrigin | undefined
  permissions?: PermissionService
  // Resolves the current turn's abort handle. Resolved lazily (not at wrap
  // time) because tools are wrapped BEFORE `createAgentSession` returns the
  // session whose `agent.abort` this points at. See `fireLoopAbort`.
  getAbort?: () => ((reason?: string) => void) | undefined
  getLoopGuardTurn?: () => number | undefined
}

export type BashSandboxBoundary = {
  ensureAvailable: () => Promise<void>
  buildCommand: typeof buildSandboxedCommand
  resolveRuntime?: typeof resolvePrivilegedSandboxRuntime
  verifyRuntime?: typeof verifyPrivilegedSandboxRuntime
  cleanupRuntime?: typeof cleanupPrivilegedSandboxRuntime
}

const DEFAULT_BASH_SANDBOX_BOUNDARY: BashSandboxBoundary = {
  ensureAvailable: ensureBwrapAvailable,
  buildCommand: buildSandboxedCommand,
}

export type WrapSystemToolOptions = {
  agentDir: string
  sessionId: string
  hooks: HookBus
  getOrigin?: () => SessionOrigin | undefined
  getAbort?: () => ((reason?: string) => void) | undefined
  getLoopGuardTurn?: () => number | undefined
  // When present, the bash builtin is rewritten through the per-tool bwrap
  // sandbox. Private-directory masks remain role-derived; canonical agent
  // secret-file masks apply to every role. Only sessions wired without a
  // permission service fail closed before execution. Production session setup
  // always supplies either the live service or the deny-all service.
  permissions?: PermissionService
  // Per-subagent bash capability policy, enforced as a hard pre-check BEFORE
  // the role-derived sandbox. Lets a read-only subagent keep its bash read-only
  // no matter who spawned it. See
  // `src/agent/reviewer-bash-policy.ts`.
  bashPolicy?: SubagentBashPolicy
  bashSandboxBoundary?: BashSandboxBoundary
}

// Zod 4 emits a top-level `"$schema": "https://json-schema.org/draft/2020-12/schema"`
// pointer on every converted schema. Ajv v8 (used by pi-ai's runtime tool-argument
// validator and by ModelRegistry's models.json validator) is configured for
// Draft 7 and rejects unknown `$schema` URIs with:
//
//   no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
//
// That error is raised before the tool's execute is even invoked, so the model
// sees the failure as a tool-call result and reacts by retrying or falling back
// to other tools. In the memory-logger / dreaming subagents this meant the
// `find_entry` tool was permanently broken: the subagent kept falling back to
// `read(offset=1, limit=2000)` and chunked through entire multi-hundred-KB
// transcripts on every channel turn. Stripping `$schema` is the minimal,
// converter-version-independent fix; it leaves the actual JSON-schema body
// untouched and lets Ajv use its default draft.
export function zodToToolParameters(schema: z.ZodType<unknown>): TSchema {
  const json = z.toJSONSchema(schema, { io: 'input', reused: 'inline' }) as Record<string, unknown>
  delete json.$schema
  return json as unknown as TSchema
}

export function wrapPluginTool(tool: Tool<any>, opts: WrapToolOptions): ToolDefinition {
  const parameters = zodToToolParameters(tool.parameters)

  return piDefineTool({
    name: opts.toolName,
    label: opts.toolName,
    description: tool.description,
    parameters,
    async execute(toolCallId, params, signal) {
      const validated = tool.parameters.safeParse(params)
      if (!validated.success) {
        return errorResult(`invalid arguments: ${validated.error.message}`)
      }

      const mutableArgs = validated.data as Record<string, unknown>
      const liveOrigin = opts.getOrigin?.()
      const before: ToolBeforeEvent = {
        tool: opts.toolName,
        sessionId: opts.sessionId,
        callId: toolCallId,
        args: mutableArgs,
        ...(liveOrigin !== undefined ? { origin: liveOrigin } : {}),
        ...(tool.fileOperands !== undefined ? { fileOperands: tool.fileOperands } : {}),
      }
      const blockResult = await opts.hooks.runToolBefore(before)
      if (blockResult !== undefined) {
        return errorResult(`blocked: ${blockResult.reason}`)
      }

      const loopGate = gateLoopGuard(
        opts.sessionId,
        opts.toolName,
        before.args,
        opts.getLoopGuardTurn?.(),
        opts.agentDir,
      )
      if (loopGate.blockNow) {
        fireLoopAbort(opts.getAbort, 'loop_guard:block')
        return errorResult(loopGate.message)
      }

      const toolCtx: ToolContext = {
        signal,
        sessionId: opts.sessionId,
        agentDir: opts.agentDir,
        logger: opts.logger,
      }

      let result: ToolResult | undefined
      let executionError: unknown
      let cleanupError: unknown
      const pinnedFiles = await enforceAndPinToolFiles({
        tool: opts.toolName,
        args: before.args,
        agentDir: opts.agentDir,
        genericInputs: true,
        fileOperands: tool.fileOperands,
        signal,
      })
      try {
        result = await tool.execute(before.args, toolCtx)
      } catch (err) {
        executionError = err
      } finally {
        try {
          await pinnedFiles.cleanup()
        } catch (error) {
          cleanupError = error
        }
      }
      const finalError = executionError ?? cleanupError
      if (finalError !== undefined) {
        const failure = errorResult(finalError instanceof Error ? finalError.message : String(finalError))
        await runToolAfterSafely(opts, opts.toolName, toolCallId, failure)
        if (cleanupError !== undefined) throw finalError
        return failure
      }
      if (result === undefined) throw new Error('plugin tool execution returned no result')
      result = pinnedFiles.restoreResult(result)

      const resolved = loopGate.resolve(result)
      if ('deferredBlock' in resolved) {
        fireLoopAbort(opts.getAbort, 'loop_guard:deferred_block')
        return errorResult(resolved.deferredBlock)
      }
      result = resolved.result

      await opts.hooks.runToolAfter({
        tool: opts.toolName,
        sessionId: opts.sessionId,
        callId: toolCallId,
        result,
      })

      return {
        content: result.content as ContentPart[],
        details: result.details,
      }
    },
  })
}

export function wrapSystemTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  opts: WrapSystemToolOptions,
): ToolDefinition<TParams, TDetails, TState> {
  return piDefineTool({
    ...tool,
    parameters: withGuardAcknowledgements(tool.name, tool.parameters),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const mutableArgs = params as Record<string, unknown>
      normalizeDefaultTreeRoot(tool.name, mutableArgs)
      const liveOrigin = opts.getOrigin?.()
      const blockResult = await opts.hooks.runToolBefore({
        tool: tool.name,
        sessionId: opts.sessionId,
        callId: toolCallId,
        args: mutableArgs,
        ...(liveOrigin !== undefined ? { origin: liveOrigin } : {}),
      })
      if (blockResult !== undefined) {
        throw new Error(`blocked: ${blockResult.reason}`)
      }
      const loopGate = gateLoopGuard(opts.sessionId, tool.name, mutableArgs, opts.getLoopGuardTurn?.(), opts.agentDir)
      if (loopGate.blockNow) {
        fireLoopAbort(opts.getAbort, 'loop_guard:block')
        throw new Error(loopGate.message)
      }
      const guardResult = await runFinalWriteGuards({
        tool: tool.name,
        args: mutableArgs,
        agentDir: opts.agentDir,
      })
      if (guardResult !== undefined) {
        throw new Error(`blocked: ${guardResult.reason}`)
      }
      const readGuardResult = runFinalReadGuards({ tool: tool.name, args: mutableArgs })
      if (readGuardResult !== undefined) {
        throw new Error(`blocked: ${readGuardResult.reason}`)
      }
      stripGuardAcknowledgements(mutableArgs)

      const pinnedFiles = await enforceAndPinToolFiles({
        tool: tool.name,
        args: mutableArgs,
        agentDir: opts.agentDir,
        genericInputs: tool.name !== 'mcp_call',
        ...(opts.permissions !== undefined
          ? { hidden: resolveHiddenPaths(opts.permissions, liveOrigin, opts.agentDir) }
          : {}),
        signal,
      })
      let result: Awaited<ReturnType<typeof tool.execute>> | undefined
      let executionError: unknown
      let cleanupError: unknown
      try {
        result = await tool.execute(toolCallId, mutableArgs as Static<TParams>, signal, onUpdate, ctx)
      } catch (error) {
        executionError = error
      } finally {
        try {
          await pinnedFiles.cleanup()
        } catch (error) {
          cleanupError = error
        }
      }
      const finalError = executionError ?? cleanupError
      if (finalError !== undefined) {
        await runToolAfterSafely(opts, tool.name, toolCallId, toErrorResult(finalError))
        throw finalError
      }
      if (result === undefined) throw new Error('system tool execution returned no result')
      const restoredResult = pinnedFiles.restoreResult({
        content: result.content as ContentPart[],
        details: result.details,
      })
      const resolved = loopGate.resolve(restoredResult)
      if ('deferredBlock' in resolved) {
        fireLoopAbort(opts.getAbort, 'loop_guard:deferred_block')
        throw new Error(resolved.deferredBlock)
      }
      const hookResult = resolved.result
      await opts.hooks.runToolAfter({
        tool: tool.name,
        sessionId: opts.sessionId,
        callId: toolCallId,
        result: hookResult,
      })
      return {
        content: hookResult.content as ContentPart[],
        details: hookResult.details as TDetails,
      }
    },
  })
}

// Wraps a pi builtin `ToolDefinition` (read/bash/edit/write/grep/find/ls) with
// TypeClaw's full pipeline — hooks, loop guard, write/read guards, per-subagent
// bash policy, bwrap sandbox, /tmp redirect, and the internal bash env overlay —
// then ships it through `customTools`. `noTools: "builtin"` at the call site
// disables pi's own unwrapped copies, so this wrapped definition is the ONLY
// registered implementation of each builtin name.
export function wrapBuiltinToolDefinition<TParams extends TSchema, TDetails = unknown, TState = any>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  opts: WrapSystemToolOptions,
): ToolDefinition<TParams, TDetails, TState> {
  return piDefineTool({
    ...tool,
    parameters: withGuardAcknowledgements(tool.name, tool.parameters),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const mutableArgs = params as Record<string, unknown>
      normalizeDefaultTreeRoot(tool.name, mutableArgs)
      const liveOrigin = opts.getOrigin?.()
      // Defense-in-depth: strip any pre-existing internal env-overlay key
      // before hooks run so only trusted tool.before hooks can set it.
      delete mutableArgs[TYPECLAW_INTERNAL_BASH_ENV]
      const blockResult = await opts.hooks.runToolBefore({
        tool: tool.name,
        sessionId: opts.sessionId,
        callId: toolCallId,
        args: mutableArgs,
        ...(liveOrigin !== undefined ? { origin: liveOrigin } : {}),
      })
      if (blockResult !== undefined) {
        throw new Error(`blocked: ${blockResult.reason}`)
      }
      // Extract and delete before the loop guard serializes args and before
      // the bash tool destructures them, so the overlay never reaches logs,
      // loop-detection state, or pi's execute.
      const bashEnvOverlay = readBashEnvOverlay(mutableArgs)
      delete mutableArgs[TYPECLAW_INTERNAL_BASH_ENV]
      const loopGate = gateLoopGuard(opts.sessionId, tool.name, mutableArgs, opts.getLoopGuardTurn?.(), opts.agentDir)
      if (loopGate.blockNow) {
        fireLoopAbort(opts.getAbort, 'loop_guard:block')
        throw new Error(loopGate.message)
      }
      const guardResult = await runFinalWriteGuards({
        tool: tool.name,
        args: mutableArgs,
        agentDir: opts.agentDir,
      })
      if (guardResult !== undefined) {
        throw new Error(`blocked: ${guardResult.reason}`)
      }
      const readGuardResult = runFinalReadGuards({ tool: tool.name, args: mutableArgs })
      if (readGuardResult !== undefined) {
        throw new Error(`blocked: ${readGuardResult.reason}`)
      }
      stripGuardAcknowledgements(mutableArgs)

      // Per-subagent capability fence: runs BEFORE the role-derived sandbox so
      // a read-only subagent's bash stays read-only even for a trusted/owner
      // caller whose sandbox otherwise preserves full agent-root writes. Throws
      // SubagentBashPolicyError on a disallowed command, surfaced to the model as
      // a tool error.
      if (tool.name === 'bash' && opts.bashPolicy !== undefined) {
        const command = mutableArgs.command
        if (typeof command === 'string') enforceSubagentBashPolicy(opts.bashPolicy, command)
      }

      let preparedSandboxRuntime: PreparedBashSandbox | undefined
      let pinnedFiles: Awaited<ReturnType<typeof enforceAndPinToolFiles>> | undefined
      let tmpRedirect: TmpRedirect | undefined
      let rawResult: ToolResult | undefined
      let executionError: unknown
      let cleanupError: unknown
      const sandboxBoundary = opts.bashSandboxBoundary ?? DEFAULT_BASH_SANDBOX_BOUNDARY
      try {
        if (tool.name === 'bash') {
          if (opts.permissions === undefined) {
            throw new SandboxPolicyError('model-driven bash has no permission service; refusing unsandboxed execution')
          }
          preparedSandboxRuntime = await applyBashSandbox(
            mutableArgs,
            opts.permissions,
            liveOrigin,
            opts.agentDir,
            opts.sessionId,
            bashEnvOverlay,
            sandboxBoundary,
          )
        }

        tmpRedirect =
          TMP_REDIRECT_TOOLS.has(tool.name) && opts.permissions !== undefined
            ? await applyTmpPathRedirect(mutableArgs, opts.permissions, liveOrigin, opts.agentDir, opts.sessionId)
            : undefined
        pinnedFiles = await enforceAndPinToolFiles({
          tool: tool.name,
          args: mutableArgs,
          agentDir: opts.agentDir,
          ...(opts.permissions !== undefined
            ? { hidden: resolveHiddenPaths(opts.permissions, liveOrigin, opts.agentDir) }
            : {}),
          signal,
        })
        await preparedSandboxRuntime?.verify()
        const spawnEnvContext: BashSpawnEnvContext | undefined =
          bashEnvOverlay !== undefined || preparedSandboxRuntime?.spawnEnv !== undefined
            ? {
                ...(bashEnvOverlay !== undefined ? { overlay: bashEnvOverlay } : {}),
                ...(preparedSandboxRuntime?.spawnEnv !== undefined
                  ? { sandboxSpawnEnv: preparedSandboxRuntime.spawnEnv }
                  : {}),
              }
            : undefined
        rawResult = await bashEnvStore.run(spawnEnvContext, () =>
          tool.execute(toolCallId, mutableArgs as Static<TParams>, signal, onUpdate, ctx),
        )
      } catch (error) {
        executionError = error
      } finally {
        const cleanup = [pinnedFiles?.cleanup(), preparedSandboxRuntime?.cleanup()].filter(
          (task): task is Promise<void> => task !== undefined,
        )
        const outcomes = await Promise.allSettled(cleanup)
        const failed = outcomes.find((outcome) => outcome.status === 'rejected')
        if (failed?.status === 'rejected') cleanupError = failed.reason
      }
      const finalError = executionError ?? cleanupError
      if (finalError !== undefined) {
        await runToolAfterSafely(opts, tool.name, toolCallId, toErrorResult(finalError))
        throw finalError
      }
      if (pinnedFiles === undefined) throw new Error('tool file boundary was not initialized')
      if (rawResult === undefined) throw new Error('tool execution returned no result')
      const pinnedResult = pinnedFiles.restoreResult(rawResult)
      const result = tmpRedirect !== undefined ? restoreTmpPathInResult(pinnedResult, tmpRedirect) : pinnedResult
      const resolved = loopGate.resolve({ content: result.content as ContentPart[], details: result.details })
      if ('deferredBlock' in resolved) {
        fireLoopAbort(opts.getAbort, 'loop_guard:deferred_block')
        throw new Error(resolved.deferredBlock)
      }
      const hookResult = resolved.result
      await opts.hooks.runToolAfter({
        tool: tool.name,
        sessionId: opts.sessionId,
        callId: toolCallId,
        result: hookResult,
      })
      return {
        content: hookResult.content as ContentPart[],
        details: hookResult.details as TDetails,
      }
    },
  })
}

function toErrorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text', text: message }], details: { error: message } }
}

// The original tool error must always propagate, so a failure inside the
// after-hook itself is swallowed rather than masking the real cause.
async function runToolAfterSafely(
  opts: WrapSystemToolOptions,
  tool: string,
  callId: string,
  result: ToolResult,
): Promise<void> {
  try {
    await opts.hooks.runToolAfter({ tool, sessionId: opts.sessionId, callId, result })
  } catch {
    // intentionally ignored: never mask the originating tool error
  }
}

export function defaultBuiltinPiToolDefinitions(cwd: string): ToolDefinition<any, any, any>[] {
  return PI_BUILTIN_TOOL_NAMES.map((name) => createPiBuiltinToolDefinition(name, cwd))
}

export function buildBuiltinPiToolOverrides(opts: WrapSystemToolOptions): ToolDefinition<any, any>[] {
  return defaultBuiltinPiToolDefinitions(opts.agentDir).map((tool) => wrapBuiltinToolDefinition(tool, opts))
}

type BashFilesystemPolicyOptions = {
  agentDir: string
  canWriteAgentRoot: boolean
  masks: { dirs: string[]; files: string[] }
  writable: { dirs: string[]; files: string[] }
  protected: { dirs: string[]; files: string[] }
}

type PreparedBashSandbox = {
  verify: () => Promise<void>
  cleanup: () => Promise<void>
  spawnEnv?: Record<string, string>
}

export function buildBashFilesystemPolicy(options: BashFilesystemPolicyOptions) {
  const { agentDir, canWriteAgentRoot, masks, writable, protected: protectedZones } = options
  if (canWriteAgentRoot) {
    return { writableRoot: { dir: agentDir }, masks, protected: protectedZones }
  }
  return { masks, writable, protected: protectedZones }
}

// Rewrites mutableArgs.command in place so the bash builtin runs inside bwrap
// with role-derived private-directory masks and unconditional canonical-secret
// file masks. When masks are needed but bwrap is unavailable
// we throw rather than run unsandboxed — fail closed, never leak the masked
// surface. Runs after the tool.before guards have inspected the raw command.
async function applyBashSandbox(
  mutableArgs: Record<string, unknown>,
  permissions: PermissionService,
  origin: SessionOrigin | undefined,
  agentDir: string,
  sessionId: string,
  envOverlay: BashEnvOverlay | undefined,
  boundary: BashSandboxBoundary,
): Promise<PreparedBashSandbox> {
  const command = mutableArgs.command
  if (typeof command !== 'string') return { verify: async () => {}, cleanup: async () => {} }

  await assertNoCanonicalSecretsInGit(agentDir)

  const { dirs, files, credentialDirs, agentRoot } = resolveHiddenPaths(permissions, origin, agentDir)
  const sandboxEnvOverlay = buildRoleScopedConfigEnv(agentDir, dirs, envOverlay)
  const maskTargets = await ensureHiddenMaskTargets({ dirs, files, credentialDirs, agentRoot })
  await boundary.ensureAvailable()
  const sessionTmp = await ensureSessionTmpDir(sessionId)
  const writable = subtractMasked(await resolveWritableZones(agentDir, getSandboxWritablePathSpecs(config)), {
    dirs,
    files,
  })
  const writableRoot = canWriteAgentRootInSandbox(permissions, origin)
  const protectedZones =
    writableRoot || writable.dirs.includes(join(agentDir, '.git'))
      ? subtractMasked(await resolveProtectedZones(agentDir), { dirs, files })
      : { dirs: [], files: [] }
  const writableDirSet = new Set(writable.dirs)
  const sandboxHome = DEFAULT_SANDBOX_ENV.HOME ?? '/tmp'
  const symlinks = resolveSandboxSymlinks(agentDir, config.sandbox.symlinks, sandboxHome).filter((op) =>
    writableDirSet.has(op.target),
  )
  const { strategy: proc, degradeReason } = await resolveProcStrategy()
  if (proc === 'tmpfs' && commandNeedsRealProc(command)) {
    throw degradeReason === 'unverified' ? new SandboxProcProbeUnverifiedError() : new SandboxDegradedProcError()
  }
  const privilegedRuntime = await (boundary.resolveRuntime ?? resolvePrivilegedSandboxRuntime)({
    agentDir,
    command,
    env: sandboxEnvOverlay,
  })
  const cleanup = async (): Promise<void> =>
    (boundary.cleanupRuntime ?? cleanupPrivilegedSandboxRuntime)(privilegedRuntime)
  try {
    await verifyHiddenMaskTargets(maskTargets)
    const { commandString, spawnEnv } = boundary.buildCommand(command, {
      mounts: [
        { type: 'ro-bind', source: agentDir, dest: agentDir },
        { type: 'bind', source: sessionTmp, dest: '/tmp' },
        ...(privilegedRuntime?.mounts ?? []),
      ],
      ...(writableRoot
        ? { writableRoot: { dir: agentDir }, masks: maskTargets, protected: protectedZones }
        : { masks: maskTargets, writable, protected: protectedZones }),
      symlinks,
      network: 'inherit',
      cwd: agentDir,
      proc,
      procSelfExe: resolveProcSelfExe(),
      ...spreadSandboxEnv(
        buildSandboxEnvPolicy(
          sandboxEnvOverlay,
          privilegedRuntime?.env,
          resolveExposableBashEnvNames(agentDir, maskTargets.credentialDirs ?? []),
        ),
      ),
    })
    mutableArgs.command = commandString
    // The overlay carries command-scoped secret VALUES (e.g. a per-repo GH_TOKEN)
    // that live in neither process.env nor argv; resolveSpawnEnv snapshots
    // inherited names from process.env only, so merge the overlay values in here
    // to complete the exact bwrap-parent env.
    const mergedSpawnEnv =
      spawnEnv !== undefined && sandboxEnvOverlay !== undefined ? { ...spawnEnv, ...sandboxEnvOverlay } : spawnEnv
    return {
      verify: async () => (boundary.verifyRuntime ?? verifyPrivilegedSandboxRuntime)(privilegedRuntime),
      cleanup,
      spawnEnv: mergedSpawnEnv,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export function buildSandboxEnvPolicy(
  overlay: BashEnvOverlay | undefined,
  runtimeEnv: Record<string, string> | undefined,
  exposableEnvNames: readonly string[] = [],
): { inherit?: string[]; set?: Record<string, string> } {
  const set = { ...runtimeEnv }
  const inherit: string[] = []
  const inheritSeen = new Set<string>()
  const pushInherit = (key: string): void => {
    if (Object.hasOwn(set, key) || inheritSeen.has(key)) return
    inheritSeen.add(key)
    inherit.push(key)
  }
  for (const [key, value] of Object.entries(overlay ?? {})) {
    if (Object.hasOwn(set, key)) continue
    if (isSecretEnvName(key)) pushInherit(key)
    else set[key] = value
  }
  // Operator-declared .env vars pass through by NAME (inherit), keeping values
  // out of the rendered bwrap argv. Withholding of secret/hijack names already
  // happened in resolveExposableEnvNames — these are the vetted survivors.
  for (const key of exposableEnvNames) pushInherit(key)
  return {
    ...(inherit.length > 0 ? { inherit } : {}),
    ...(Object.keys(set).length > 0 ? { set } : {}),
  }
}

function spreadSandboxEnv(policy: ReturnType<typeof buildSandboxEnvPolicy>): {
  env?: ReturnType<typeof buildSandboxEnvPolicy>
} {
  return Object.keys(policy).length > 0 ? { env: policy } : {}
}

// Env var NAMES an operator wired as configured secret sources (MCP server env
// bindings + their Secret `env` overrides, tunnel tokenEnv). These carry
// credential values by intent, so they are withheld from bash even when their
// name looks innocuous and is declared in .env.
function configuredSecretEnvNames(agentDir: string): string[] {
  const names: string[] = [...collectSecretEnvRefs(agentDir)]
  for (const server of config.mcpServers) {
    for (const [key, secret] of Object.entries(server.env)) {
      names.push(key)
      const envRef = (secret as { env?: unknown }).env
      if (typeof envRef === 'string' && envRef.length > 0) names.push(envRef)
    }
  }
  for (const tunnel of config.tunnels) {
    const tokenEnv = (tunnel as { tokenEnv?: unknown }).tokenEnv
    if (typeof tokenEnv === 'string' && tokenEnv.length > 0) names.push(tokenEnv)
  }
  return names
}

// Couple AGENT_MESSENGER_CONFIG_DIR exposure to masking: the pointer may reach
// bash ONLY when its resolved target is one of the credential dirs we actually
// masked. If it resolves outside the agent root or to the root itself, no mask
// is applied (resolvedMessengerCredentialDir returns nothing), yet /etc and the
// agent root are mounted into the sandbox — so exposing the pointer would let the
// model read credentials at the unmasked target. Withhold it in that case.
function withheldUnmaskedPointers(agentDir: string, maskedCredentialDirs: readonly string[]): string[] {
  const configured = process.env.AGENT_MESSENGER_CONFIG_DIR
  if (configured === undefined || configured.length === 0) return []
  const resolved = resolve(agentDir, configured)
  return maskedCredentialDirs.includes(resolved) ? [] : ['AGENT_MESSENGER_CONFIG_DIR']
}

function resolveExposableBashEnvNames(agentDir: string, maskedCredentialDirs: readonly string[]): string[] {
  const declared = readEnvFile(agentDir).keys()
  return resolveExposableEnvNames(declared, process.env, config.sandbox.env?.allow ?? [], [
    ...configuredSecretEnvNames(agentDir),
    ...withheldUnmaskedPointers(agentDir, maskedCredentialDirs),
  ])
}

function buildRoleScopedConfigEnv(
  agentDir: string,
  hiddenDirs: string[],
  envOverlay: BashEnvOverlay | undefined,
): BashEnvOverlay | undefined {
  // Low-trust roles have workspace/ masked. Do not let container-global config
  // env vars point CLIs back at that private surface: apps that honor XDG should
  // still run, but their config must land in the sandbox's per-session /tmp.
  // Trusted/owner have only the unconditional credential-dir masks, not the
  // workspace root mask, so their command broker decides whether to set GWS.
  const workspaceHidden = hiddenDirs.includes(join(agentDir, 'workspace'))
  if (!workspaceHidden) return envOverlay

  return {
    ...envOverlay,
    XDG_CONFIG_HOME: '/tmp/.config',
    GWS_CONFIG_HOME: '/tmp/.config/gws',
  }
}

// Picks the /proc strategy for a sandboxed bash call. The branch order is:
// 'real-proc' ONLY when the operator explicitly opted in (sandbox.realProc) AND
// the kernel permits the mount (canMountRealProc) — it adds PID isolation but
// needs CAP_SYS_ADMIN (unshare --mount-proc), so it is a deliberate, narrow
// opt-in; else 'proc-bind' (--ro-bind /proc, NO CAP_SYS_ADMIN) when its userns
// leak-block is verified safe; else 'tmpfs'. Because sandbox.realProc DEFAULTS
// FALSE, the first branch is normally skipped and proc-bind is the de-facto
// default — which is the point: the common path needs no broad outer capability.
// 'tmpfs' is the last-resort degraded mode where external packages can't run;
// reached only when proc-bind is DEFINITIVELY unavailable (a real cross-userns
// environ leak → fail closed) or its safety stays unverifiable after retries.
//
// Read from the boot-time `config` snapshot, NOT live getConfig(): sandbox is
// restart-required, and the strategy MUST track the boot-time CAP_SYS_ADMIN
// grant. A `typeclaw reload` flipping realProc would otherwise emit `unshare
// --mount-proc` in a container booted WITHOUT the cap (or vice versa). Both
// probes are cached process-globally, so this resolves to one spawn per
// container lifetime regardless of how many bash calls hit it.
// A tmpfs degrade carries WHY it happened so the caller can pick a permanent vs
// retryable error. 'definitive': the probe returned a real cross-userns leak
// ('unsafe') — the ONLY verdict proven permanent, so it fails closed for good.
// 'unverified': the safety probe never reached a definitive verdict within its
// retry budget. That covers BOTH a transient load spike AND a durable
// incapability (no usable namespaces, a bwrap that starts but cannot set up its
// sandbox): the probe cannot prove a NEGATIVE capability — only a leak is
// definitive — so a genuinely incapable host also lands here and simply keeps
// re-degrading on each call. Since 'inconclusive' is never cached, that costs a
// re-probe but is correct: the only false case is "capable but briefly
// saturated", which recovers; an incapable host stays degraded either way.
// Absent when the strategy is not tmpfs.
type ProcStrategyResolution =
  | { strategy: 'real-proc' | 'proc-bind'; degradeReason?: undefined }
  | { strategy: 'tmpfs'; degradeReason: 'definitive' | 'unverified' }

async function resolveProcStrategy(): Promise<ProcStrategyResolution> {
  if (config.sandbox.realProc && (await canMountRealProc())) return { strategy: 'real-proc' }
  // Retry an 'inconclusive' proc-bind probe (transient under load) before
  // degrading — a single such hiccup must not break external-package runs on a
  // capable host. 'unsafe' still fails closed with no retry.
  const verdict = await resolveProcBindSafetyWithRetry(
    () => getProcBindSafetyVerdict(),
    (ms) => Bun.sleep(ms),
  )
  if (verdict === 'safe') return { strategy: 'proc-bind' }
  // Degraded last resort: no working /proc strategy. External package runners
  // (bunx/bun run <pkg-bin>) will fail with Bun's opaque "NotDir" because
  // /proc/self/{fd,maps} are absent. Only a proven 'unsafe' (a real cross-userns
  // leak) is DEFINITIVE — warn once (a real operator-facing limit). An
  // 'inconclusive' is reported as retryable upstream and NOT warned (it would cry
  // wolf every boot storm); a durably-incapable host re-degrades quietly here,
  // since the probe cannot distinguish it from transient load.
  if (verdict === 'unsafe') {
    warnTmpfsProcFallbackOnce()
    return { strategy: 'tmpfs', degradeReason: 'definitive' }
  }
  return { strategy: 'tmpfs', degradeReason: 'unverified' }
}

let tmpfsProcFallbackWarned = false
function warnTmpfsProcFallbackOnce(): void {
  if (tmpfsProcFallbackWarned) return
  tmpfsProcFallbackWarned = true
  console.warn(
    '[sandbox] degraded /proc mode: neither real-proc nor proc-bind is available on this host, ' +
      'so sandboxed external package runners (bunx / bun run <pkg-bin>) will fail. ' +
      'This needs a runtime with working user namespaces.',
  )
}

// The builtin file tools that take a single filesystem `path` arg. They run in
// the main process rather than bwrap, so each must apply the same
// /tmp -> session-dir mapping that
// applyBashSandbox binds for bash — otherwise a `read` of /tmp/foo hits the
// real container /tmp while sandboxed bash wrote the session backing dir.
const TMP_REDIRECT_TOOLS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls'])

// Model-driven bash reads /tmp through bwrap's per-session bind
// (applyBashSandbox), but the path-based file tools run in the main process
// against the real container /tmp.
// Without this redirect a guest/member that touches /tmp/foo through bash (bound
// to the session dir) and through a file tool (real /tmp) would see two
// different files. Rewriting the file tool's on-disk path to the same session
// backing dir makes every layer resolve /tmp/foo to one file. Bare harnesses
// without the production permission wiring are left untouched.
type TmpRedirect = { original: string; backing: string }

async function applyTmpPathRedirect(
  mutableArgs: Record<string, unknown>,
  permissions: PermissionService,
  origin: SessionOrigin | undefined,
  agentDir: string,
  sessionId: string,
): Promise<TmpRedirect | undefined> {
  const rawPath = mutableArgs.path
  if (typeof rawPath !== 'string') return undefined

  const { dirs, files } = resolveHiddenPaths(permissions, origin, agentDir)
  if (dirs.length === 0 && files.length === 0) return undefined

  const backing = mapVirtualTmpPath(agentDir, sessionId, rawPath)
  if (backing === undefined || backing === rawPath) return undefined

  await ensureSessionTmpDir(sessionId)
  mutableArgs.path = backing
  return { original: rawPath, backing }
}

// The redirect swaps the model-facing /tmp path for its session backing dir
// before execution; the file tool then echoes that backing path in its receipt
// text and details. Reverse it on the way out so the model only ever sees the
// path it asked for — a leaked backing path is unreachable inside the bwrap
// bash sandbox, so reusing it in `gh api --input` fails (the PR #672 strand).
function restoreTmpPathInResult(result: ToolResult, redirect: TmpRedirect): ToolResult {
  const content = (result.content as ContentPart[]).map((part) =>
    part.type === 'text' ? { ...part, text: part.text.split(redirect.backing).join(redirect.original) } : part,
  )
  const details =
    isRecord(result.details) && result.details.path === redirect.backing
      ? { ...result.details, path: redirect.original }
      : result.details
  return { content, details }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeDefaultTreeRoot(toolName: string, args: Record<string, unknown>): void {
  if ((toolName === 'grep' || toolName === 'find' || toolName === 'ls') && typeof args.path !== 'string') {
    args.path = '.'
  }
}

function appendLoopWarning(result: ToolResult, message: string): ToolResult {
  const content: ContentPart[] = [...(result.content as ContentPart[]), { type: 'text', text: message }]
  return { content, details: result.details }
}

// `subagent_output` is a read-only poll whose loop/no-loop classification only
// becomes knowable AFTER execution: a result of `status: 'running'` is a
// still-pending wait (legitimate), while a repeated terminal result is a real
// loop. The loop guard's `check` is result-blind and pre-execution, so for this
// one tool we DEFER enforcing a block until the status is known — otherwise the
// exact poll that would reveal 'running' gets blocked before it can run (the
// boundary-call hazard for round-robin fan-out polling). Every other tool
// enforces its block immediately, as before.
// A block is deferred only for a `subagent_output` poll the guard still marks
// `deferable` — i.e. whose signature has not yet proven terminal. Once a poll of
// that signature returns completed/failed, `deferable` is false and the block is
// enforced pre-execute, so a finished task is not re-polled forever.
function shouldDeferLoopBlock(toolName: string, decision: LoopGuardDecision): boolean {
  return toolName === SUBAGENT_OUTPUT_TOOL_NAME && decision.kind === 'block' && decision.deferable
}

function subagentPollStatus(toolName: string, result: ToolResult): 'running' | 'terminal' | undefined {
  if (toolName !== SUBAGENT_OUTPUT_TOOL_NAME) return undefined
  const details = result.details as SubagentOutputToolDetails | undefined
  if (details?.ok !== true) return undefined
  return details.status === 'running' ? 'running' : 'terminal'
}

function observedReadResult(
  toolName: string,
  result: ToolResult,
): { nonEmpty: boolean; outputLines?: number; textual: boolean } | undefined {
  if (toolName !== 'read') return undefined
  const details = result.details as { truncation?: { outputLines?: unknown } } | undefined
  const outputLines = details?.truncation?.outputLines
  const hasImage = result.content.some((part) => part.type === 'image')
  const hasText = result.content.some(
    (part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0,
  )
  const imageFallback =
    !hasImage &&
    result.content.some(
      (part) => part.type === 'text' && typeof part.text === 'string' && /^Read image file \[[^\]]+\]/.test(part.text),
    )
  const observedOutputLines =
    typeof outputLines === 'number' && Number.isFinite(outputLines)
      ? outputLines
      : !hasImage && !imageFallback
        ? countReadOutputLines(result.content)
        : undefined
  return {
    nonEmpty: hasImage || hasText,
    textual: !hasImage && !imageFallback,
    ...(observedOutputLines !== undefined ? { outputLines: observedOutputLines } : {}),
  }
}

function countReadOutputLines(content: ContentPart[]): number | undefined {
  const textParts = content.filter(
    (part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text' && typeof part.text === 'string',
  )
  if (textParts.length !== 1) return undefined
  const fileText = textParts[0]!.text.replace(/\n\n\[\d+ more lines in file\. Use offset=\d+ to continue\.\]$/, '')
  return fileText.length === 0 ? 0 : fileText.split('\n').length
}

type LoopGuardGate = {
  // True when the guard wants to block AND the block is enforced now (every tool
  // except a deferable `subagent_output` poll). The caller aborts + errors.
  blockNow: boolean
  message: string
  // Resolves the guard against the tool's result. Returns the result to surface
  // (possibly warn-annotated), or `{ deferredBlock: message }` when a deferred
  // `subagent_output` block must now be enforced because the poll did not return
  // a still-running status.
  resolve: (result: ToolResult) => { result: ToolResult } | { deferredBlock: string }
}

// Single chokepoint for the loop-guard pre-check + post-execute resolution so
// all four tool wrappers share identical deferred-block / pending-retract
// semantics. `check` runs here (recording the observation); the returned
// `resolve` is called after execute with the tool's result, feeding the poll's
// running/terminal status back to the guard so future blocks stop deferring.
function gateLoopGuard(
  sessionId: string,
  toolName: string,
  args: unknown,
  turnId?: number,
  cwd?: string,
): LoopGuardGate {
  const decision = sharedLoopGuard.check(sessionId, toolName, args, { turnId, cwd })
  const defer = shouldDeferLoopBlock(toolName, decision)
  return {
    blockNow: decision.kind === 'block' && !defer,
    message: decision.kind === 'ok' ? '' : decision.message,
    resolve(result) {
      const readResult = observedReadResult(toolName, result)
      if (readResult !== undefined) sharedLoopGuard.noteReadResult(decision.receipt, readResult)
      const pollStatus = subagentPollStatus(toolName, result)
      if (pollStatus !== undefined) {
        sharedLoopGuard.noteResult(decision.receipt, pollStatus)
      }
      if (pollStatus === 'running') {
        sharedLoopGuard.retract(decision.receipt)
        return { result }
      }
      if (defer && decision.kind === 'block') {
        return { deferredBlock: decision.message }
      }
      if (decision.kind === 'warn') {
        return { result: appendLoopWarning(result, decision.message) }
      }
      return { result }
    },
  }
}

// Clears one tool's loop-guard residue for a session on the process-wide shared
// guard. The completion-reminder bridges (channel router + TUI server) call this
// for `subagent_output` when a backgrounded subagent finishes, so the next fetch
// the reminder asks for isn't blocked by the window the agent's premature polling
// poisoned. Exposed as a narrow function rather than the guard itself so callers
// can't reach `check`/`forget` and widen the blast radius.
export function forgetSharedLoopGuardTool(sessionId: string, tool: string): void {
  sharedLoopGuard.forgetTool(sessionId, tool)
}

// Test-only seam: swaps the shared loop guard for a fresh instance so tests
// that reuse sessionIds across cases don't see cross-test streak counts.
// Production code never calls this; the guard's LRU bound handles
// long-running processes.
export function __resetSharedLoopGuardForTests(): void {
  sharedLoopGuard = createLoopGuard()
}

// A loop-guard `block` verdict returned/thrown from a tool's execute() is
// caught by pi-agent-core and surfaced to the model as an `isError` result,
// which the model simply retries — the loop never ends. Aborting the run's
// AbortSignal is the only thing that actually stops the in-flight turn (the
// next assistant stream sees the aborted signal and ends with stopReason
// 'aborted'). We use the signal-only `agent.abort`, never `session.abort`,
// which would deadlock awaiting the very run this tool call belongs to. See
// the matching pattern in src/channels/router.ts (policy-denied send cap).
function fireLoopAbort(getAbort: (() => ((reason?: string) => void) | undefined) | undefined, reason: string): void {
  getAbort?.()?.(reason)
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    details: { error: true, message },
    isError: true,
  }
}

async function runFinalWriteGuards(options: { tool: string; args: Record<string, unknown>; agentDir: string }) {
  return (
    (await checkGitControlWriteGuard(options)) ??
    (await checkManagedConfigGuard(options)) ??
    (await checkSkillAuthoringGuard(options)) ??
    checkNonWorkspaceWriteGuard(options)
  )
}

async function checkGitControlWriteGuard(options: {
  tool: string
  args: Record<string, unknown>
  agentDir: string
}): Promise<{ block: true; reason: string } | undefined> {
  if (options.tool !== 'write' && options.tool !== 'edit') return undefined
  const candidate = options.args.path
  if (typeof candidate !== 'string') return undefined
  if (!(await isGitControlPath(options.agentDir, candidate))) return undefined
  return {
    block: true,
    reason: `Git control path is runtime-protected and cannot be modified with ${options.tool}: ${candidate}`,
  }
}

function runFinalReadGuards(options: { tool: string; args: Record<string, unknown> }) {
  return checkImageReadRedirect(options)
}

function withGuardAcknowledgements<TParams extends TSchema>(toolName: string, parameters: TParams): TParams {
  if (toolName !== 'write' && toolName !== 'edit') return parameters

  const schema = parameters as Record<string, unknown>
  const properties = schema.properties
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return parameters

  return {
    ...schema,
    properties: {
      ...(properties as Record<string, unknown>),
      [ACKNOWLEDGE_GUARDS]: ACKNOWLEDGE_GUARDS_SCHEMA,
    },
  } as unknown as TParams
}

function stripGuardAcknowledgements(args: Record<string, unknown>): void {
  delete args[ACKNOWLEDGE_GUARDS]
}
