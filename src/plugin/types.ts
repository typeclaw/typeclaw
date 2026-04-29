import type { ToolDefinition } from '@mariozechner/pi-coding-agent'

import type { PluginEntry } from '@/config'
import type { CronJob } from '@/cron'
import type { SubagentSpawner } from '@/subagent'

export type { PluginEntry }

export type PluginRef = {
  source: string
  options: unknown
}

export type PluginManifest = {
  name: string
  version?: string
  surfaces?: ReadonlyArray<'host' | 'agent' | 'cli'>
}

export type Plugin = {
  manifest: PluginManifest
  factory: PluginFactory
}

export type PluginFactory = (ctx: PluginCtx) => Promise<void> | void

export type PluginLogger = {
  debug: (msg: string, fields?: Record<string, unknown>) => void
  info: (msg: string, fields?: Record<string, unknown>) => void
  warn: (msg: string, fields?: Record<string, unknown>) => void
  error: (msg: string, fields?: Record<string, unknown>) => void
}

export type InMemorySkill = {
  name: string
  description: string
  content: string
  frontmatter?: Record<string, unknown>
}

export type SystemPromptSectionContext = {
  sessionId: string
  agentDir: string
}

// Returning null skips this section for the current session, matching how
// memory drops out when MEMORY.md is missing (rather than emitting an empty
// heading).
export type SystemPromptSectionLoader = (ctx: SystemPromptSectionContext) => Promise<string | null> | string | null

export type SessionIdleEvent = {
  sessionId: string
  parentTranscriptPath: string
  idleMs: number
}

export type TypeClawEvents = {
  'session.idle': SessionIdleEvent
}

export type TypeClawEventName = keyof TypeClawEvents

export type TypeClawEventHandler<E extends TypeClawEventName> = (event: TypeClawEvents[E]) => void | Promise<void>

export type ShutdownHandler = () => void | Promise<void>

export type SpawnSubagent = (name: string, payload: unknown) => Promise<void>

export type PluginCtx = {
  readonly name: string
  readonly version: string | undefined
  readonly options: unknown
  readonly agentDir: string

  registerTool(tool: ToolDefinition): void
  registerSubagent(name: string, spawner: SubagentSpawner): void
  registerCronJob(job: CronJob): void
  registerSystemPromptSection(loader: SystemPromptSectionLoader): void
  registerSkillsDir(absPath: string): void
  registerSkill(skill: InMemorySkill): void

  on<E extends TypeClawEventName>(event: E, handler: TypeClawEventHandler<E>): void

  spawnSubagent: SpawnSubagent

  onShutdown(handler: ShutdownHandler): void

  readonly logger: PluginLogger
}
