import type { z } from 'zod'

import type { SessionOrigin } from '@/agent/session-origin'

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }

export type ToolResult = {
  content: ContentPart[]
  details?: unknown
}

export type ToolLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type ToolContext = {
  signal: AbortSignal | undefined
  sessionId: string
  agentDir: string
  logger: ToolLogger
}

export type Tool<P = unknown> = {
  description: string
  parameters: z.ZodType<P>
  execute: (args: P, ctx: ToolContext) => Promise<ToolResult>
}

export type BuiltinToolRef = { readonly __builtinTool: string }

export type SubagentContext<P = unknown> = {
  userPrompt: string
  agentDir: string
  payload: P
}

export type RunSession = (override?: { userPrompt?: string }) => Promise<void>

export type Subagent<P = unknown> = {
  systemPrompt: string
  tools?: BuiltinToolRef[]
  customTools?: Tool<any>[]
  payloadSchema?: z.ZodType<P>
  handler?: (ctx: SubagentContext<P>, runSession: RunSession) => Promise<void>
  // Coalescing key for the SubagentConsumer's in-flight set. Default is the
  // subagent name alone (only one instance of the subagent runs at a time).
  // Override to allow per-payload concurrency, e.g. memory-logger keyed by
  // parentSessionId so different parent sessions run in parallel while
  // duplicate runs against the same session deduplicate.
  inFlightKey?: (payload: P) => string
}

// Cron job map keys are local; the runtime prefixes with `__plugin_<plugin-name>_`
// to form the global cron id, guaranteeing no collision with cron.json user
// jobs (no underscore prefix) or across plugins.
export type PluginPromptCronJob = {
  schedule: string
  kind: 'prompt'
  prompt: string
  enabled?: boolean
  timezone?: string
  subagent?: string
  payload?: unknown
}

export type PluginExecCronJob = {
  schedule: string
  kind: 'exec'
  command: string[]
  enabled?: boolean
  timezone?: string
}

export type PluginCronJob = PluginPromptCronJob | PluginExecCronJob

export type PluginSkill = {
  description: string
  content: string
  frontmatter?: Record<string, unknown>
}

export type SessionStartEvent = {
  sessionId: string
  agentDir: string
}

export type SessionEndEvent = {
  sessionId: string
}

export type SessionIdleEvent = {
  sessionId: string
  parentTranscriptPath: string | undefined
  idleMs: number
  origin?: SessionOrigin
}

// Provider prompt caching requires byte-identical prefixes. Mutations near the
// end of `event.prompt` preserve cache hits across sessions; mutations near
// the start invalidate the cache on every LLM call.
export type SessionPromptEvent = {
  prompt: string
  sessionId: string
  agentDir: string
  origin?: SessionOrigin
}

// Fired for plugin-defined tools and TypeClaw-exposed system tools, including
// built-in pi tools (read/bash/edit/write/grep/find/ls) when plugins are wired.
export type ToolBeforeEvent = {
  tool: string
  sessionId: string
  callId: string
  args: Record<string, unknown>
}

export type ToolBeforeResult = void | undefined | { block: true; reason: string }

export type ToolAfterEvent = {
  tool: string
  sessionId: string
  callId: string
  result: ToolResult
}

export type HookContext = {
  agentDir: string
  pluginName: string
  logger: PluginLogger
}

export type Hooks = {
  'session.start'?: (event: SessionStartEvent, ctx: HookContext) => Promise<void> | void
  'session.end'?: (event: SessionEndEvent, ctx: HookContext) => Promise<void> | void
  'session.idle'?: (event: SessionIdleEvent, ctx: HookContext) => Promise<void> | void
  'session.prompt'?: (event: SessionPromptEvent, ctx: HookContext) => Promise<void> | void
  'tool.before'?: (event: ToolBeforeEvent, ctx: HookContext) => Promise<ToolBeforeResult> | ToolBeforeResult
  'tool.after'?: (event: ToolAfterEvent, ctx: HookContext) => Promise<void> | void
}

export type HookName = keyof Hooks

export type PluginLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
}

export type PluginContext<TConfig = never> = {
  readonly name: string
  readonly version: string | undefined
  readonly agentDir: string
  readonly config: TConfig
  readonly logger: PluginLogger
  spawnSubagent: (name: string, payload?: unknown) => Promise<void>
}

export type PluginExports = {
  tools?: Record<string, Tool<any>>
  subagents?: Record<string, Subagent<any>>
  cronJobs?: Record<string, PluginCronJob>
  skills?: Record<string, PluginSkill>
  skillsDirs?: string[]
  hooks?: Hooks
  doctorChecks?: Record<string, PluginDoctorCheck>
}

// `typeclaw doctor` plugin extension surface. Each check is read-only by
// default; declaring `fix.apply` opts the check into `typeclaw doctor --fix`,
// where the host serializes plugin fixes, validates their `changedPaths`
// against the agent folder, and commits the union of all fixes in a single
// commit.
export type PluginDoctorCheck = {
  description: string
  category?: string
  run: (ctx: PluginDoctorContext) => Promise<PluginCheckResult>
}

export type PluginDoctorContext = {
  readonly pluginName: string
  readonly agentDir: string
  readonly config: unknown
  readonly logger: PluginLogger
  readonly signal: AbortSignal
}

export type PluginCheckStatus = 'ok' | 'warning' | 'error' | 'info'

export type PluginCheckResult = {
  status: PluginCheckStatus
  message: string
  details?: string[]
  fix?: PluginFixSuggestion
}

export type PluginFixSuggestion = {
  description: string
  // When omitted, the fix is advisory-only. `typeclaw doctor --fix` only
  // attempts to remediate checks whose suggestion includes an `apply`.
  apply?: (ctx: PluginDoctorContext) => Promise<PluginFixResult>
}

export type PluginFixResult = {
  // One-line description that appears in the commit body as a bullet.
  summary: string
  // POSIX paths relative to agentDir; the host validates each one stays
  // inside agentDir before `git add`ing. Absolute paths and `..` segments
  // are rejected to keep plugin fixes from staging files outside the agent
  // folder. Empty array is valid (e.g. a fix that only logs).
  changedPaths: string[]
}

export type DefinedPlugin<TConfig = never> = {
  readonly configSchema?: z.ZodType<TConfig>
  readonly plugin: (ctx: PluginContext<TConfig>) => Promise<PluginExports>
}
