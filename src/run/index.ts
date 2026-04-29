import { SessionManager } from '@mariozechner/pi-coding-agent'

import { createSession } from '@/agent'
import { config, type Config, createConfigReloadable, getConfig } from '@/config'
import {
  type CronConsumer,
  type CronJob,
  type CronFile,
  createCronConsumer,
  createCronReloadable,
  createScheduler,
  type LoadCronResult,
  loadCron as loadCronDefault,
  type Scheduler,
  type SubagentJob,
} from '@/cron'
import { createDreamingSpawner, createMemoryLoggerSpawner, isDreamingPayload, isMemoryLoggerPayload } from '@/memory'
import { loadPlugins, PluginManager } from '@/plugin'
import { ReloadRegistry } from '@/reload'
import { createServer, type Server } from '@/server'
import { createSessionFactory, type SessionFactory } from '@/sessions'
import { createStream, type Stream } from '@/stream'
import { createSubagentConsumer, type SubagentConsumer, type SubagentSpawner } from '@/subagent'
import { createTui as createTuiDefault, type TuiOptions } from '@/tui'

const DREAMING_JOB_ID = '__internal_dreaming'

type BunServer = ReturnType<Server['start']>

export type TuiFactory = (options: TuiOptions) => { run: () => Promise<void> }

export type LoadCronFn = (agentDir: string) => Promise<LoadCronResult>
export type SchedulerFactory = (options: { cwd: string; file: CronFile; onFire: (job: CronJob) => void }) => Scheduler

export type StartAgentOptions = {
  port: number
  attachTui: boolean
  initialPrompt?: string
  cwd?: string
  createTui?: TuiFactory
  loadCron?: LoadCronFn
  createSchedulerFor?: SchedulerFactory
  sessionFactory?: SessionFactory
  stream?: Stream
  pluginManager?: PluginManager
}

export type StartAgentResult = {
  server: BunServer
  tuiPromise: Promise<void> | null
  scheduler: Scheduler | null
  cronConsumer: CronConsumer | null
  subagentConsumer: SubagentConsumer
  reloadRegistry: ReloadRegistry
  stream: Stream
  pluginManager: PluginManager
  stop: () => Promise<void>
}

export async function startAgent({
  port,
  attachTui,
  initialPrompt,
  cwd = process.cwd(),
  createTui = createTuiDefault,
  loadCron = loadCronDefault,
  createSchedulerFor,
  sessionFactory = createSessionFactory({ agentDir: cwd }),
  stream = createStream(),
  pluginManager,
}: StartAgentOptions): Promise<StartAgentResult> {
  const reloadRegistry = new ReloadRegistry()
  reloadRegistry.register(createConfigReloadable({ cwd }))

  const manager = pluginManager ?? new PluginManager({ agentDir: cwd, stream })
  if (pluginManager && config.plugins.length > 0) {
    console.warn(
      `[plugin] startAgent received an explicit pluginManager; the ${config.plugins.length} plugin(s) listed in typeclaw.json are ignored. Pre-load them into the provided manager if you want them.`,
    )
  }
  if (!pluginManager) {
    const entries = config.plugins
    if (entries.length > 0) {
      try {
        const resolved = await loadPlugins(entries, { agentDir: cwd })
        await manager.loadAll(resolved.map((r) => ({ plugin: r.plugin, source: r.ref.source, options: r.ref.options })))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`plugin loading failed: ${message}`)
      }
    }
  }
  manager.markBooted()
  logRegistrationAudit(manager)

  const coreSpawners: Record<string, SubagentSpawner> = {
    'memory-logger': createMemoryLoggerSpawner(),
    dreaming: createDreamingSpawner(),
  }
  const spawners = mergeSpawners(coreSpawners, manager.getSubagentSpawners())

  const cronConsumer = createCronConsumer({
    stream,
    cwd,
    createSessionForCron: async () => {
      const { session, dispose } = await createSession({
        reloadRegistry,
        sessionManager: SessionManager.create(cwd, sessionFactory.sessionDir()),
        stream,
        pluginManager: manager,
      })
      return {
        prompt: async (text) => {
          try {
            await session.prompt(text)
          } finally {
            await dispose()
          }
        },
      }
    },
  })

  const subagentConsumer = createSubagentConsumer({
    stream,
    spawners,
    inFlightKey: (subagent, payload) => {
      if (subagent === 'memory-logger' && isMemoryLoggerPayload(payload)) {
        return `${subagent}:${payload.parentSessionId}`
      }
      if (subagent === 'dreaming' && isDreamingPayload(payload)) {
        return `${subagent}:${payload.agentDir}`
      }
      return subagent
    },
  })
  subagentConsumer.start()

  const internalJobs = () => buildInternalJobs(cwd, getConfig(), manager)
  const factory = createSchedulerFor ?? makeDefaultSchedulerFactory(internalJobs)
  const scheduler = await startScheduler({
    cwd,
    loadCron,
    createSchedulerFor: factory,
    stream,
    hasInternalJobs: internalJobs().length > 0,
  })

  if (scheduler) {
    cronConsumer.start()
    reloadRegistry.register(createCronReloadable({ cwd, scheduler, internalJobs }))
  }

  const server = createServer({
    port,
    reloadAll: () => reloadRegistry.reloadAll(),
    reloadRegistry,
    sessionFactory,
    stream,
    memoryIdleMs: config.memory.idleMs,
    agentDir: cwd,
    pluginManager: manager,
  }).start()

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    scheduler?.stop()
    cronConsumer.stop()
    subagentConsumer.stop()
    server.stop(true)
    await manager.shutdown()
  }

  if (!attachTui) {
    return {
      server,
      tuiPromise: null,
      scheduler,
      cronConsumer: scheduler ? cronConsumer : null,
      subagentConsumer,
      reloadRegistry,
      stream,
      pluginManager: manager,
      stop,
    }
  }

  const url = `ws://localhost:${server.port}`
  const tui = createTui({ url, initialPrompt })
  const tuiPromise = tui.run()
  return {
    server,
    tuiPromise,
    scheduler,
    cronConsumer: scheduler ? cronConsumer : null,
    subagentConsumer,
    reloadRegistry,
    stream,
    pluginManager: manager,
    stop,
  }
}

function mergeSpawners(
  core: Record<string, SubagentSpawner>,
  plugin: Record<string, SubagentSpawner>,
): Record<string, SubagentSpawner> {
  const merged: Record<string, SubagentSpawner> = { ...core }
  for (const [name, spawner] of Object.entries(plugin)) {
    if (merged[name] !== undefined) {
      throw new Error(`subagent name conflict: '${name}' is registered by both core and a plugin`)
    }
    merged[name] = spawner
  }
  return merged
}

async function startScheduler({
  cwd,
  loadCron,
  createSchedulerFor,
  stream,
  hasInternalJobs,
}: {
  cwd: string
  loadCron: LoadCronFn
  createSchedulerFor: SchedulerFactory
  stream: Stream
  hasInternalJobs: boolean
}): Promise<Scheduler | null> {
  let result: LoadCronResult
  try {
    result = await loadCron(cwd)
  } catch (err) {
    console.error(`[cron] load failed: ${err instanceof Error ? err.message : err}`)
    return null
  }
  if (!result.ok) {
    console.error(`[cron] failed to load cron.json: ${result.reason}`)
    return null
  }
  // Without cron.json, the scheduler still needs to run if internal jobs
  // (like dreaming) are configured. Construct an empty file in that case.
  const file: CronFile = result.file ?? { jobs: [] }
  if (!result.file && !hasInternalJobs) return null

  const onFire = (job: CronJob) => {
    stream.publish({ target: { kind: 'cron', jobId: job.id }, payload: job })
  }
  const scheduler = createSchedulerFor({ cwd, file, onFire })
  scheduler.start()
  return scheduler
}

function makeDefaultSchedulerFactory(internalJobs: () => CronJob[]): SchedulerFactory {
  return ({ file, onFire }) => {
    const jobs = [...file.jobs, ...internalJobs()]
    assertNoDuplicateIds(jobs, file)
    return createScheduler({ jobs, onFire })
  }
}

function assertNoDuplicateIds(jobs: CronJob[], file: CronFile): void {
  const seen = new Map<string, CronJob>()
  const userIds = new Set(file.jobs.map((j) => j.id))
  for (const job of jobs) {
    const prior = seen.get(job.id)
    if (prior) {
      const owner = userIds.has(job.id) ? 'cron.json' : 'plugin or internal job'
      throw new Error(`cron job id '${job.id}' is registered twice (${owner} conflict)`)
    }
    seen.set(job.id, job)
  }
}

function buildInternalJobs(cwd: string, cfg: Config, manager: PluginManager): CronJob[] {
  const jobs: CronJob[] = []
  const dreaming = cfg.memory.dreaming
  if (dreaming) {
    const job: SubagentJob = {
      id: DREAMING_JOB_ID,
      schedule: dreaming.schedule,
      enabled: true,
      kind: 'subagent',
      subagent: 'dreaming',
      payload: { agentDir: cwd },
    }
    jobs.push(job)
  }
  for (const job of manager.getCronJobs()) {
    jobs.push(job)
  }
  return jobs
}

function logRegistrationAudit(manager: PluginManager): void {
  const registered = manager.registeredPlugins()
  if (registered.length === 0) return
  const audit = manager.describeRegistrations()
  const summary = registered.map((r) => {
    const versionPart = r.manifest.version ? ` v${r.manifest.version}` : ''
    return `${r.manifest.name}${versionPart}`
  })
  console.log(`[plugin] loaded ${registered.length} plugin(s): ${summary.join(', ')}`)
  const counts = [
    audit.tools.length > 0 && `tools=${audit.tools.length}`,
    audit.subagents.length > 0 && `subagents=${audit.subagents.length}`,
    audit.cronJobs.length > 0 && `cronJobs=${audit.cronJobs.length}`,
    audit.skillDirs.length > 0 && `skillDirs=${audit.skillDirs.length}`,
    audit.inMemorySkills.length > 0 && `inMemorySkills=${audit.inMemorySkills.length}`,
    audit.systemPromptSections.length > 0 && `systemPromptSections=${audit.systemPromptSections.length}`,
    audit.eventHandlers.length > 0 && `eventHandlers=${audit.eventHandlers.length}`,
    audit.shutdownHandlers.length > 0 && `shutdownHandlers=${audit.shutdownHandlers.length}`,
  ].filter((v): v is string => typeof v === 'string')
  if (counts.length > 0) console.log(`[plugin] registrations: ${counts.join(' ')}`)
}
