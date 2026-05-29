import type { AgentTool } from '@mariozechner/pi-agent-core'
import {
  bashTool as piBashTool,
  defineTool as piDefineTool,
  editTool as piEditTool,
  findTool as piFindTool,
  grepTool as piGrepTool,
  lsTool as piLsTool,
  readTool as piReadTool,
  writeTool as piWriteTool,
} from '@mariozechner/pi-coding-agent'
import type { ToolDefinition } from '@mariozechner/pi-coding-agent'
import type { Static, TSchema } from '@sinclair/typebox'
import { Type } from '@sinclair/typebox'
import { z } from 'zod'

import {
  ACKNOWLEDGE_GUARDS,
  checkManagedConfigGuard,
  checkNonWorkspaceWriteGuard,
  checkSkillAuthoringGuard,
} from '@/bundled-plugins/guard/policy'
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
import { buildSandboxedCommand, type SandboxPolicy } from '@/sandbox'

import { createLoopGuard, type LoopGuard } from './loop-guard'
import { checkImageReadRedirect } from './multimodal/read-redirect'
import type { SessionOrigin } from './session-origin'
import { webfetchTool } from './tools/webfetch'
import { websearchTool } from './tools/websearch'

// Process-wide loop guard. State is keyed by sessionId so concurrent sessions
// don't interfere; the guard's own LRU bound keeps it from growing without
// limit. Wrappers consult it before invoking the underlying tool so the
// detector covers every tool category — plugin tools, TypeClaw system tools,
// and pi-coding-agent builtins — through one chokepoint.
let sharedLoopGuard: LoopGuard = createLoopGuard()

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

// pi-coding-agent 0.67.3 contract (load-bearing for hook coverage):
//   - `createAgentSession({ tools: AgentTool[] })` is ONLY a name filter for
//     `initialActiveToolNames`. It does NOT swap builtin implementations.
//   - `customTools: ToolDefinition[]` entries override builtins by name in
//     `_refreshToolRegistry` (the registry merge writes customTools last).
//
// Consequence: to put a `tool.before` hook around pi's builtin read/bash/edit/
// write, TypeClaw must wrap them as `ToolDefinition`s and pass them via
// `customTools` — not via `tools`. `wrapAgentToolAsCustomToolDefinition`
// produces those wrapped definitions; `setupSession` in `src/agent/index.ts`
// appends them whenever the session has any `tool.before` / `tool.after`
// hooks registered. Subagent narrowing still comes from `tools:` (the
// name-filter path); the wrapped customTools just replace the implementation
// underneath so subagent and channel sessions share the same hook coverage.
type PiAgentToolName = 'read' | 'bash' | 'edit' | 'write' | 'grep' | 'find' | 'ls'
type TypeclawToolName = 'websearch' | 'webfetch'

const PI_AGENT_TOOL_MAP: Record<PiAgentToolName, AgentTool<any, any>> = {
  read: piReadTool,
  bash: piBashTool,
  edit: piEditTool,
  write: piWriteTool,
  grep: piGrepTool,
  find: piFindTool,
  ls: piLsTool,
}

const TYPECLAW_TOOL_DEFINITION_MAP: Record<TypeclawToolName, ToolDefinition<any, any, any>> = {
  websearch: websearchTool,
  webfetch: webfetchTool,
}

function isPiAgentToolName(name: string): name is PiAgentToolName {
  return name in PI_AGENT_TOOL_MAP
}

function isTypeclawToolName(name: string): name is TypeclawToolName {
  return name in TYPECLAW_TOOL_DEFINITION_MAP
}

export type ResolvedBuiltinTools = {
  agentTools: AgentTool<any, any>[]
  toolDefinitions: ToolDefinition<any, any, any>[]
}

export function resolveBuiltinToolRefs(refs: BuiltinToolRef[]): ResolvedBuiltinTools {
  const agentTools: AgentTool<any, any>[] = []
  const toolDefinitions: ToolDefinition<any, any, any>[] = []
  for (const ref of refs) {
    const name = ref.__builtinTool
    if (isPiAgentToolName(name)) {
      agentTools.push(PI_AGENT_TOOL_MAP[name])
    } else if (isTypeclawToolName(name)) {
      toolDefinitions.push(TYPECLAW_TOOL_DEFINITION_MAP[name])
    } else {
      throw new Error(`unknown built-in tool ref: ${name}`)
    }
  }
  return { agentTools, toolDefinitions }
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
}

export type WrapSystemToolOptions = {
  agentDir: string
  sessionId: string
  hooks: HookBus
  getOrigin?: () => SessionOrigin | undefined
  // When set, the `bash` builtin override rewrites its `command` argument into
  // a bwrap-wrapped invocation via `buildSandboxedCommand`. Applied only to
  // the `bash` tool and only after `tool.before` guards have inspected the
  // raw command. Other tools ignore it. See `SubagentShared.sandboxPolicy`.
  sandboxPolicy?: SandboxPolicy
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
      }
      const blockResult = await opts.hooks.runToolBefore(before)
      if (blockResult !== undefined) {
        return errorResult(`blocked: ${blockResult.reason}`)
      }

      const loopDecision = sharedLoopGuard.check(opts.sessionId, opts.toolName, before.args)
      if (loopDecision.kind === 'block') {
        return errorResult(loopDecision.message)
      }

      const toolCtx: ToolContext = {
        signal,
        sessionId: opts.sessionId,
        agentDir: opts.agentDir,
        logger: opts.logger,
      }

      let result: ToolResult
      try {
        result = await tool.execute(before.args, toolCtx)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return errorResult(message)
      }

      if (loopDecision.kind === 'warn') {
        result = appendLoopWarning(result, loopDecision.message)
      }

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
      const loopDecision = sharedLoopGuard.check(opts.sessionId, tool.name, mutableArgs)
      if (loopDecision.kind === 'block') {
        throw new Error(loopDecision.message)
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

      const result = await tool.execute(toolCallId, mutableArgs as Static<TParams>, signal, onUpdate, ctx)
      const hookResult: ToolResult = {
        content: result.content as ContentPart[],
        details: result.details,
      }
      if (loopDecision.kind === 'warn') {
        const warned = appendLoopWarning(hookResult, loopDecision.message)
        hookResult.content = warned.content
        hookResult.details = warned.details
      }
      await opts.hooks.runToolAfter({
        tool: tool.name,
        sessionId: opts.sessionId,
        callId: toolCallId,
        result: hookResult,
      })
      return {
        content: hookResult.content,
        details: hookResult.details as TDetails,
      }
    },
  })
}

export function wrapSystemAgentTool<TParams extends TSchema, TDetails = unknown>(
  tool: AgentTool<TParams, TDetails>,
  opts: WrapSystemToolOptions,
): AgentTool<TParams, TDetails> {
  return {
    ...tool,
    parameters: withGuardAcknowledgements(tool.name, tool.parameters),
    async execute(toolCallId, params, signal, onUpdate) {
      const mutableArgs = params as Record<string, unknown>
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
      const loopDecision = sharedLoopGuard.check(opts.sessionId, tool.name, mutableArgs)
      if (loopDecision.kind === 'block') {
        throw new Error(loopDecision.message)
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

      const result = await tool.execute(toolCallId, mutableArgs as Static<TParams>, signal, onUpdate)
      const hookResult: ToolResult = {
        content: result.content as ContentPart[],
        details: result.details,
      }
      if (loopDecision.kind === 'warn') {
        const warned = appendLoopWarning(hookResult, loopDecision.message)
        hookResult.content = warned.content
        hookResult.details = warned.details
      }
      await opts.hooks.runToolAfter({
        tool: tool.name,
        sessionId: opts.sessionId,
        callId: toolCallId,
        result: hookResult,
      })
      return {
        content: hookResult.content,
        details: hookResult.details as TDetails,
      }
    },
  }
}

// Wraps a pi-coding-agent AgentTool into a ToolDefinition so it can ride in
// `customTools` and override pi's same-named builtin (see top-of-file contract
// block). The hook + guard pipeline matches `wrapSystemAgentTool`; only the
// input/output shape differs.
export function wrapAgentToolAsCustomToolDefinition<TParams extends TSchema, TDetails = unknown>(
  tool: AgentTool<TParams, TDetails>,
  opts: WrapSystemToolOptions,
): ToolDefinition<TParams, TDetails> {
  return piDefineTool({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: withGuardAcknowledgements(tool.name, tool.parameters),
    prepareArguments: tool.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate) {
      const mutableArgs = params as Record<string, unknown>
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
      const loopDecision = sharedLoopGuard.check(opts.sessionId, tool.name, mutableArgs)
      if (loopDecision.kind === 'block') {
        throw new Error(loopDecision.message)
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
      applyBashSandbox(tool.name, mutableArgs, opts.sandboxPolicy)

      const result = await tool.execute(toolCallId, mutableArgs as Static<TParams>, signal, onUpdate)
      const hookResult: ToolResult = {
        content: result.content as ContentPart[],
        details: result.details,
      }
      if (loopDecision.kind === 'warn') {
        const warned = appendLoopWarning(hookResult, loopDecision.message)
        hookResult.content = warned.content
        hookResult.details = warned.details
      }
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

// Rewrites the `bash` tool's `command` argument into a bwrap-wrapped shell
// string when a sandbox policy is present. Runs after `tool.before` guards so
// `secret-exfil-bash`/`git-exfil` inspect the operator-authored command, not
// the bwrap argv. pi's bash tool runs `bash -c <command>`, and
// `buildSandboxedCommand` returns an argv ending in `bash -c <orig>`; feeding
// the quoted argv back as the new `command` yields one clean extra wrapping
// layer with no double-execution of the original. No-op for non-bash tools or
// when the command is absent/non-string.
function applyBashSandbox(
  toolName: string,
  args: Record<string, unknown>,
  sandboxPolicy: SandboxPolicy | undefined,
): void {
  if (sandboxPolicy === undefined || toolName !== 'bash') return
  const command = args.command
  if (typeof command !== 'string') return
  args.command = buildSandboxedCommand(command, sandboxPolicy).commandString
}

export function defaultBuiltinPiAgentTools(): AgentTool<any, any>[] {
  return [piReadTool, piBashTool, piEditTool, piWriteTool, piGrepTool, piFindTool, piLsTool]
}

export function buildBuiltinPiToolOverrides(opts: WrapSystemToolOptions): ToolDefinition<any, any>[] {
  return defaultBuiltinPiAgentTools().map((tool) => wrapAgentToolAsCustomToolDefinition(tool, opts))
}

function appendLoopWarning(result: ToolResult, message: string): ToolResult {
  const content: ContentPart[] = [...(result.content as ContentPart[]), { type: 'text', text: message }]
  return { content, details: result.details }
}

// Test-only seam: swaps the shared loop guard for a fresh instance so tests
// that reuse sessionIds across cases don't see cross-test streak counts.
// Production code never calls this; the guard's LRU bound handles
// long-running processes.
export function __resetSharedLoopGuardForTests(): void {
  sharedLoopGuard = createLoopGuard()
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
    (await checkManagedConfigGuard(options)) ??
    (await checkSkillAuthoringGuard(options)) ??
    checkNonWorkspaceWriteGuard(options)
  )
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
