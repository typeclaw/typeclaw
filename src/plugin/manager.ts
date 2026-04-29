import type { ToolDefinition } from '@mariozechner/pi-coding-agent'

import type { CronJob } from '@/cron'
import type { Stream } from '@/stream'
import type { SubagentSpawner } from '@/subagent'

import type {
  InMemorySkill,
  Plugin,
  PluginCtx,
  PluginLogger,
  ShutdownHandler,
  SystemPromptSectionContext,
  SystemPromptSectionLoader,
  TypeClawEventHandler,
  TypeClawEventName,
  TypeClawEvents,
} from './types'

export type PluginManagerOptions = {
  agentDir: string
  stream?: Stream
  logger?: PluginLogger
}

export type RegisteredPlugin = {
  manifest: Plugin['manifest']
  source?: string
}

export type RegistrationAudit = {
  tools: Array<{ name: string; plugin: string }>
  subagents: Array<{ name: string; plugin: string }>
  cronJobs: Array<{ id: string; plugin: string }>
  skillDirs: Array<{ absPath: string; plugin: string }>
  inMemorySkills: Array<{ name: string; plugin: string }>
  systemPromptSections: Array<{ plugin: string }>
  eventHandlers: Array<{ event: TypeClawEventName; plugin: string }>
  shutdownHandlers: Array<{ plugin: string }>
}

type EventHandlerEntry<E extends TypeClawEventName> = {
  plugin: string
  handler: TypeClawEventHandler<E>
}

const consoleLogger: PluginLogger = {
  debug: (msg, fields) => console.debug(formatLog(msg, fields)),
  info: (msg, fields) => console.log(formatLog(msg, fields)),
  warn: (msg, fields) => console.warn(formatLog(msg, fields)),
  error: (msg, fields) => console.error(formatLog(msg, fields)),
}

function formatLog(msg: string, fields?: Record<string, unknown>): string {
  if (!fields || Object.keys(fields).length === 0) return msg
  return `${msg} ${JSON.stringify(fields)}`
}

export class PluginManager {
  private readonly agentDir: string
  private readonly stream: Stream | undefined
  private readonly baseLogger: PluginLogger

  private booted = false
  private readonly tools: ToolDefinition[] = []
  private readonly toolOwners = new Map<string, string>()
  private readonly subagents = new Map<string, { plugin: string; spawner: SubagentSpawner }>()
  private readonly cronJobs = new Map<string, { plugin: string; job: CronJob }>()
  private readonly systemPromptSections: Array<{ plugin: string; loader: SystemPromptSectionLoader }> = []
  private readonly skillsDirs: Array<{ plugin: string; absPath: string }> = []
  private readonly inMemorySkills: Array<{ plugin: string; skill: InMemorySkill }> = []
  private readonly eventHandlers = new Map<TypeClawEventName, Array<EventHandlerEntry<TypeClawEventName>>>()
  private readonly shutdownHandlers: Array<{ plugin: string; handler: ShutdownHandler }> = []
  private readonly registered: RegisteredPlugin[] = []

  constructor(options: PluginManagerOptions) {
    this.agentDir = options.agentDir
    this.stream = options.stream
    this.baseLogger = options.logger ?? consoleLogger
  }

  async loadAll(plugins: ReadonlyArray<{ plugin: Plugin; source?: string; options?: unknown }>): Promise<void> {
    for (const entry of plugins) {
      await this.loadOne(entry.plugin, entry.source, entry.options)
    }
  }

  markBooted(): void {
    this.booted = true
  }

  async loadOne(plugin: Plugin, source?: string, options?: unknown): Promise<void> {
    const { manifest } = plugin
    if (this.registered.some((r) => r.manifest.name === manifest.name)) {
      throw new Error(
        `plugin name conflict: '${manifest.name}' is already registered (sources: ${this.describeRegistration(manifest.name)}, ${source ?? '<inline>'})`,
      )
    }

    const ctx = this.createContext(manifest.name, manifest.version, options)
    try {
      await plugin.factory(ctx)
    } catch (err) {
      this.discardRegistrationsBy(manifest.name)
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`plugin '${manifest.name}' failed to load: ${message}`)
    }
    this.registered.push({ manifest, source })
  }

  private discardRegistrationsBy(pluginName: string): void {
    const filterOut = <T extends { plugin: string }>(arr: T[]): void => {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i]?.plugin === pluginName) arr.splice(i, 1)
      }
    }
    const filterMap = <V extends { plugin: string }>(map: Map<string, V>): void => {
      for (const [k, v] of map) if (v.plugin === pluginName) map.delete(k)
    }

    for (let i = this.tools.length - 1; i >= 0; i--) {
      if (this.toolOwners.get(this.tools[i]?.name ?? '') === pluginName) {
        const removed = this.tools.splice(i, 1)[0]
        if (removed) this.toolOwners.delete(removed.name)
      }
    }
    filterMap(this.subagents)
    filterMap(this.cronJobs)
    filterOut(this.systemPromptSections)
    filterOut(this.skillsDirs)
    filterOut(this.inMemorySkills)
    for (const handlers of this.eventHandlers.values()) filterOut(handlers)
    filterOut(this.shutdownHandlers)
  }

  getTools(): ToolDefinition[] {
    return [...this.tools]
  }

  getSubagentSpawners(): Record<string, SubagentSpawner> {
    const out: Record<string, SubagentSpawner> = {}
    for (const [name, entry] of this.subagents) out[name] = entry.spawner
    return out
  }

  getCronJobs(): CronJob[] {
    return [...this.cronJobs.values()].map((e) => e.job)
  }

  getSkillsDirs(): string[] {
    return this.skillsDirs.map((e) => e.absPath)
  }

  getInMemorySkills(): InMemorySkill[] {
    return this.inMemorySkills.map((e) => e.skill)
  }

  async loadSystemPromptSections(ctx: SystemPromptSectionContext): Promise<string[]> {
    const out: string[] = []
    for (const { plugin, loader } of this.systemPromptSections) {
      try {
        const section = await loader(ctx)
        if (section !== null && section !== undefined && section.length > 0) out.push(section)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.baseLogger.error(`plugin '${plugin}' system prompt section failed: ${message}`)
      }
    }
    return out
  }

  async dispatchEvent<E extends TypeClawEventName>(event: E, payload: TypeClawEvents[E]): Promise<void> {
    const handlers = this.eventHandlers.get(event)
    if (!handlers) return
    for (const { plugin, handler } of handlers) {
      try {
        await (handler as TypeClawEventHandler<E>)(payload)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.baseLogger.error(`plugin '${plugin}' handler for '${event}' failed: ${message}`)
      }
    }
  }

  async shutdown(): Promise<void> {
    while (this.shutdownHandlers.length > 0) {
      const entry = this.shutdownHandlers.pop()
      if (!entry) break
      try {
        await entry.handler()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.baseLogger.error(`plugin '${entry.plugin}' shutdown handler failed: ${message}`)
      }
    }
  }

  registeredPlugins(): RegisteredPlugin[] {
    return [...this.registered]
  }

  describeRegistrations(): RegistrationAudit {
    const tools = this.tools.map((t) => ({ name: t.name, plugin: this.toolOwners.get(t.name) ?? '<unknown>' }))
    const subagents = [...this.subagents].map(([name, e]) => ({ name, plugin: e.plugin }))
    const cronJobs = [...this.cronJobs].map(([id, e]) => ({ id, plugin: e.plugin }))
    const skillDirs = this.skillsDirs.map((e) => ({ absPath: e.absPath, plugin: e.plugin }))
    const inMemorySkills = this.inMemorySkills.map((e) => ({ name: e.skill.name, plugin: e.plugin }))
    const systemPromptSections = this.systemPromptSections.map((e) => ({ plugin: e.plugin }))
    const eventHandlers: Array<{ event: TypeClawEventName; plugin: string }> = []
    for (const [event, handlers] of this.eventHandlers) {
      for (const h of handlers) eventHandlers.push({ event, plugin: h.plugin })
    }
    const shutdownHandlers = this.shutdownHandlers.map((e) => ({ plugin: e.plugin }))
    return {
      tools,
      subagents,
      cronJobs,
      skillDirs,
      inMemorySkills,
      systemPromptSections,
      eventHandlers,
      shutdownHandlers,
    }
  }

  private describeRegistration(name: string): string {
    const existing = this.registered.find((r) => r.manifest.name === name)
    return existing?.source ?? '<inline>'
  }

  private createContext(name: string, version: string | undefined, options: unknown): PluginCtx {
    const logger = this.scopedLogger(name)
    const stream = this.stream

    const ctx: PluginCtx = {
      name,
      version,
      options,
      agentDir: this.agentDir,

      registerTool: (tool) => {
        const owner = this.toolOwners.get(tool.name)
        if (owner !== undefined) {
          throw new Error(
            `plugin '${name}' registered tool '${tool.name}' which is already registered by plugin '${owner}'`,
          )
        }
        this.tools.push(tool)
        this.toolOwners.set(tool.name, name)
      },

      registerSubagent: (subagentName, spawner) => {
        const collision = this.subagents.get(subagentName)
        if (collision) {
          throw new Error(
            `plugin '${name}' registered subagent '${subagentName}' which is already registered by plugin '${collision.plugin}'`,
          )
        }
        this.subagents.set(subagentName, { plugin: name, spawner })
      },

      registerCronJob: (job) => {
        const expectedPrefix = `__plugin_${name}_`
        if (!job.id.startsWith(expectedPrefix)) {
          throw new Error(
            `plugin '${name}' cron job id '${job.id}' must start with '${expectedPrefix}' (convention reserves the __plugin_<name>_ prefix for plugin-owned jobs)`,
          )
        }
        const collision = this.cronJobs.get(job.id)
        if (collision) {
          throw new Error(
            `plugin '${name}' registered cron job id '${job.id}' which is already registered by plugin '${collision.plugin}'`,
          )
        }
        this.cronJobs.set(job.id, { plugin: name, job })
      },

      registerSystemPromptSection: (loader) => {
        this.systemPromptSections.push({ plugin: name, loader })
      },

      registerSkillsDir: (absPath) => {
        this.skillsDirs.push({ plugin: name, absPath })
      },

      registerSkill: (skill) => {
        const collision = this.inMemorySkills.find((s) => s.skill.name === skill.name)
        if (collision) {
          throw new Error(
            `plugin '${name}' registered skill '${skill.name}' which is already registered by plugin '${collision.plugin}'`,
          )
        }
        this.inMemorySkills.push({ plugin: name, skill })
      },

      on: <E extends TypeClawEventName>(event: E, handler: TypeClawEventHandler<E>) => {
        let handlers = this.eventHandlers.get(event)
        if (!handlers) {
          handlers = []
          this.eventHandlers.set(event, handlers)
        }
        handlers.push({ plugin: name, handler } as EventHandlerEntry<TypeClawEventName>)
      },

      spawnSubagent: async (subagentName, payload) => {
        if (!this.booted) {
          throw new Error(
            `plugin '${name}' called spawnSubagent('${subagentName}') during plugin loading; spawnSubagent is only valid after boot completes (use it from event handlers, tools, or subagents)`,
          )
        }
        if (!stream) {
          throw new Error(`plugin '${name}' called spawnSubagent('${subagentName}') but no stream is configured`)
        }
        if (!this.subagents.has(subagentName)) {
          throw new Error(
            `plugin '${name}' called spawnSubagent('${subagentName}') but no spawner is registered for that subagent`,
          )
        }
        stream.publish({
          target: { kind: 'new-session', subagent: subagentName },
          payload,
        })
      },

      onShutdown: (handler) => {
        this.shutdownHandlers.push({ plugin: name, handler })
      },

      logger,
    }

    return ctx
  }

  private scopedLogger(pluginName: string): PluginLogger {
    return {
      debug: (msg, fields) => this.baseLogger.debug(`[plugin:${pluginName}] ${msg}`, fields),
      info: (msg, fields) => this.baseLogger.info(`[plugin:${pluginName}] ${msg}`, fields),
      warn: (msg, fields) => this.baseLogger.warn(`[plugin:${pluginName}] ${msg}`, fields),
      error: (msg, fields) => this.baseLogger.error(`[plugin:${pluginName}] ${msg}`, fields),
    }
  }
}
