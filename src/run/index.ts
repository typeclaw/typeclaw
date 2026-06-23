import { SessionManager } from '@mariozechner/pi-coding-agent'

import { createSession, createSessionWithDispose } from '@/agent'
import { LiveSessionRegistry } from '@/agent/live-sessions'
import { LiveSubagentRegistry } from '@/agent/live-subagents'
import { requestContainerRestart } from '@/agent/restart'
import { consumeRestartHandoff } from '@/agent/restart-handoff'
import { sessionMetaPayload } from '@/agent/session-meta'
import type { SessionOrigin } from '@/agent/session-origin'
import {
  awaitWithSubagentTimeout,
  createSubagentConsumer,
  defaultCreateSessionForSubagent,
  invokeSubagent,
  isSubagentTimeoutError,
  resolveSubagentProfile,
  type Subagent as InternalSubagent,
  type SubagentConsumer,
  type SubagentRegistry,
  type SubagentShared,
} from '@/agent/subagents'
import { clearTodosForOrigin } from '@/agent/todo/continuation-wiring'
import { vectorEnabledFromMemoryConfig } from '@/bundled-plugins/memory/vector/config'
import { embed, warmEmbedder } from '@/bundled-plugins/memory/vector/embedder'
import { buildStartupVectorIndex } from '@/bundled-plugins/memory/vector/startup'
import { resolveCapOptionsFromConfig } from '@/bundled-plugins/tool-result-cap'
import {
  createChannelManager,
  createChannelsReloadable,
  createGithubTokenBridge,
  createSubagentCompletionBridge,
  type ChannelManager,
  type SubagentCompletionBridge,
} from '@/channels'
import { createTunnelBridge, type TunnelBridge } from '@/channels/tunnel-bridge'
import {
  createConfigReloadable,
  getConfig,
  loadConfigSync,
  loadPluginConfigsSync,
  reloadConfig,
  withDefaultPlugins,
} from '@/config'
import {
  type CountStore,
  type CronConsumer,
  type CronJob,
  type CronFile,
  createCountStore,
  createCronConsumer,
  createCronReloadable,
  createScheduler,
  type LoadCronResult,
  loadCron as loadCronDefault,
  type Scheduler,
} from '@/cron'
import { CLI_VERSION } from '@/init/cli-version'
import { createMcpManager } from '@/mcp'
import { runStartupMigrations } from '@/migrations'
import { loadPlugins, type LoadPluginsResult, pluginCronJobs, type PluginRegistry, summarizeLoaded } from '@/plugin'
import { createPluginLogger } from '@/plugin/context'
import type { CronHandlerContext } from '@/plugin/types'
import { createContainerBroker, publishForwardResult, subscribeForwardRequest } from '@/portbroker'
import { formatChannelReloadSummary, ReloadRegistry } from '@/reload'
import { createClaimController } from '@/role-claim'
import {
  exportClaudeCredentialsFileForAgent,
  exportCodexAuthFileForAgent,
  hydrateChannelEnvFromSecrets,
} from '@/secrets'
import { createServer, type Server } from '@/server'
import {
  createCommandRunner,
  type CommandRunner,
  type CommandSpawnSubagent,
  runExecForCommand,
  runPromptForCommand,
} from '@/server/command-runner'
import { createSessionFactory, type SessionFactory } from '@/sessions'
import { createStream, type Stream } from '@/stream'
import { createTui as createTuiDefault, type TuiOptions } from '@/tui'
import { createTunnelManager, type TunnelManager, type TunnelManagerOptions } from '@/tunnels'

import { BUNDLED_PLUGINS } from './bundled-plugins'
import { buildChannelSessionFactory } from './channel-session-factory'
import { installCodexFetchObserver } from './codex-fetch-observer'
import { createPluginRuntime, type PluginRuntime, type PluginSubagentEntry } from './plugin-runtime'
import { runStartupVectorBoot } from './startup-vector-boot'

type BunServer = ReturnType<Server['start']>

export type TuiFactory = (options: TuiOptions) => { run: () => Promise<unknown> }

export type LoadCronFn = (agentDir: string, options?: { subagents?: SubagentRegistry }) => Promise<LoadCronResult>
export type SchedulerFactory = (options: {
  cwd: string
  file: CronFile
  onFire: (job: CronJob) => void
  onCountStore?: (store: CountStore) => void
}) => Scheduler | Promise<Scheduler>
export type ChannelManagerFactory = typeof createChannelManager
export type TunnelManagerFactory = (options: TunnelManagerOptions) => TunnelManager

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
  createChannelManager?: ChannelManagerFactory
  createTunnelManager?: TunnelManagerFactory
}

export type StartAgentResult = {
  server: BunServer
  tuiPromise: Promise<unknown> | null
  scheduler: Scheduler | null
  cronConsumer: CronConsumer | null
  subagentConsumer: SubagentConsumer
  reloadRegistry: ReloadRegistry
  stream: Stream
  pluginRuntime: PluginRuntime
  loadedPlugins: LoadPluginsResult['loadedPlugins']
  channelManager: ChannelManager
  stop: () => void | Promise<void>
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
  createChannelManager: createChannelManagerFor = createChannelManager,
  createTunnelManager: createTunnelManagerFor = createTunnelManager,
}: StartAgentOptions): Promise<StartAgentResult> {
  const reloadRegistry = new ReloadRegistry()

  // Wrap globalThis.fetch BEFORE any plugin/session/manager construction so
  // every Codex Responses call from anywhere in the container is observed.
  // Logs one `[codex-fetch]` line per matched request with phase timings;
  // never aborts, never retries — purely passive instrumentation while we
  // investigate the recurring multi-minute Codex stalls (see issue #394).
  // Opt out with TYPECLAW_CODEX_FETCH_OBSERVER=off.
  const uninstallCodexFetchObserver = installCodexFetchObserver()

  // The host CLI sets TYPECLAW_CONTAINER_NAME when it `docker run`s us. When
  // running outside a typeclaw container (tests, ad-hoc `bun run typeclaw run`
  // outside docker), the env var is absent and the `restart` tool is omitted —
  // which is what we want, since there is no host daemon to honor it anyway.
  const containerName = process.env.TYPECLAW_CONTAINER_NAME
  const containerNameOpt = containerName !== undefined ? { containerName } : {}
  const runtimeVersionOpt = { runtimeVersion: CLI_VERSION }
  const tuiToken = process.env.TYPECLAW_TUI_TOKEN
  const tuiTokenOpt = tuiToken !== undefined && tuiToken !== '' ? { tuiToken } : {}

  const pluginConfigsByName = loadPluginConfigsSync(cwd)
  // Vector agents omit the system-prompt `# Memory` section and inject memory
  // per-turn instead. Derived once here: `memory.vector.enabled` is
  // restart-required, so a single boot read is coherent for the process.
  const suppressSystemMemory = vectorEnabledFromMemoryConfig(pluginConfigsByName.memory)
  const cwdConfig = loadConfigSync(cwd)
  const githubTokenBridge = createGithubTokenBridge()
  const mcpManager =
    cwdConfig.mcpServers.length > 0 ? createMcpManager(cwdConfig.mcpServers, { env: process.env }) : null
  if (mcpManager !== null) {
    const results = await mcpManager.connectAll()
    for (const result of results) {
      if (!result.ok) console.warn(`[mcp] ${result.name} failed to connect: ${result.error.message}`)
    }
  }
  const mcpManagerOpt = mcpManager !== null ? { mcpManager } : {}
  const pluginsLoaded = await loadPlugins({
    entries: withDefaultPlugins(cwdConfig.plugins),
    agentDir: cwd,
    configsByName: pluginConfigsByName,
    bundled: BUNDLED_PLUGINS,
    resolveGithubTokenForRepo: githubTokenBridge.resolveTokenForRepo,
    hasGithubAppTokenResolver: githubTokenBridge.hasAppTokenResolver,
    ...(cwdConfig.roles !== undefined ? { roles: cwdConfig.roles } : {}),
  })

  reloadRegistry.register(
    createConfigReloadable({
      cwd,
      permissions: pluginsLoaded.permissions,
      onRolesChanged: () => channelManager.router.tearDownAllLive(),
      skipMountValidation: containerName !== undefined,
    }),
  )
  const pluginRegistry = pluginsLoaded.registry
  const pluginHooks = pluginsLoaded.hooks

  const { registry: subagents, pluginSubagentByShim, pluginSubagentByName } = mergeSubagents(pluginRegistry)

  const hasAnyPluginContent =
    pluginRegistry.tools.length > 0 ||
    pluginRegistry.subagents.length > 0 ||
    pluginRegistry.cronJobs.length > 0 ||
    pluginRegistry.skills.length > 0 ||
    pluginRegistry.skillsDirs.length > 0 ||
    pluginRegistry.commands.length > 0 ||
    pluginsLoaded.loadedPlugins.length > 0

  const pluginRuntime = createPluginRuntime({
    registry: pluginRegistry,
    hooks: pluginHooks,
    subagents,
    pluginSubagentByShim,
    hasAnyPluginContent,
    loadedPlugins: pluginsLoaded.loadedPlugins,
    materializedSkills: null,
  })

  // Graduate any pre-0.20.0 on-disk shapes (v1 secrets.json, legacy auth.json)
  // to the current v2 envelope before anything reads secrets — otherwise the
  // v2-only parser rejects the file and hydrate below sees no channels. Runs
  // exactly once per folder; a folder already at v2 is a no-op.
  runStartupMigrations(cwd)
  if (suppressSystemMemory) {
    await runStartupVectorBoot({ buildIndex: () => buildStartupVectorIndex(cwd, embed), warmEmbedder })
  }

  // Channel adapters read `process.env[TOKEN_ENV]` (see channels/manager.ts).
  // Hydrate fills any unset env var from secrets.json#channels via env-wins:
  // values already in process.env (from `docker --env-file .env`) are kept
  // as-is; missing ones get the resolved Secret value injected. The pre-v2
  // auto-promotion from .env to secrets.json has been removed — env values
  // stay in env, the file stays user-owned. See src/secrets/hydrate.ts.
  hydrateChannelEnvFromSecrets({ agentDir: cwd })

  // When the user has `docker.file.codexCli: true` AND a typeclaw-managed
  // openai-codex OAuth credential in secrets.json, write ~/.codex/auth.json
  // so the Codex CLI in the container can run without a second login. The
  // exporter is failure-tolerant by design: any error (gate miss, fs error,
  // corrupt file) returns a non-fatal result and the agent boot continues.
  // See src/secrets/export-codex-auth-file.ts for the newer-wins compare
  // that prevents clobbering Codex CLI's in-place token refreshes.
  exportCodexAuthFileForAgent({
    agentDir: cwd,
    codexCliEnabled: cwdConfig.docker.file.codexCli,
    log: (message) => console.warn(message),
  })

  // Same shape as the codex exporter above, gated on `docker.file.claudeCode`
  // and `secrets.json#providers.anthropic`. Writes ~/.claude/.credentials.json
  // so the Claude Code CLI in the container can run without the user pasting
  // a CLAUDE_CODE_OAUTH_TOKEN. See src/secrets/export-claude-credentials-
  // file.ts for the newer-wins compare that prevents clobbering Claude
  // Code's in-place token refreshes, and the read-merge-write that preserves
  // any mcpOAuth state in the file.
  exportClaudeCredentialsFileForAgent({
    agentDir: cwd,
    claudeCodeEnabled: cwdConfig.docker.file.claudeCode,
    log: (message) => console.warn(message),
  })

  const claimController = createClaimController({
    cwd,
    permissions: pluginsLoaded.permissions,
    rolesProvider: () => getConfig().roles,
  })

  const tunnelManager: TunnelManager = createTunnelManagerFor({
    tunnels: getConfig().tunnels,
    stream,
    resolveChannelUpstreamPort: (name) => {
      if (name === 'github') return getConfig().channels.github?.webhookPort ?? null
      return null
    },
  })

  const liveSubagentRegistry = new LiveSubagentRegistry()
  const liveSessionRegistry = new LiveSessionRegistry()

  const channelManager = createChannelManagerFor({
    agentDir: cwd,
    channelsConfigRef: () => getConfig().channels,
    aliasesRef: () => getConfig().alias,
    tunnelUrlForChannel: (name) => resolveTunnelUrlForChannel(name, tunnelManager),
    tunnelConfiguredForChannel: (name) => isTunnelConfiguredForChannel(name),
    createSessionForChannel: buildChannelSessionFactory({
      cwd,
      sessionFactory,
      stream,
      reloadRegistry,
      pluginRuntime,
      suppressSystemMemory,
      getChannelRouter: () => channelManager.router,
      rehydrateCapOptions: resolveCapOptionsFromConfig(pluginConfigsByName['tool-result-cap']),
      permissions: pluginsLoaded.permissions,
      reloadRoles: () => reloadRolesFromDisk(cwd),
      liveSubagentRegistry,
      liveSessionRegistry,
      subagentRegistry: pluginRuntime.get().subagents,
      getCreateSessionForSubagent: () => createSessionForSubagent,
      ...containerNameOpt,
      ...runtimeVersionOpt,
      ...mcpManagerOpt,
    }),
    permissions: pluginsLoaded.permissions,
    claimHandler: claimController.claimHandler,
    githubTokenBridge,
    stream,
    newestRunningChildSubagentStartedAt: (sessionId) =>
      liveSubagentRegistry
        .list({ parentSessionId: sessionId })
        .reduce<number | null>(
          (newest, child) =>
            child.status === 'running' && (newest === null || child.startedAt > newest) ? child.startedAt : newest,
          null,
        ),
    onReload: async () => {
      const { results } = await reloadRegistry.reloadAll()
      return formatChannelReloadSummary(results)
    },
    // Always registered so /restart's presence in /help, the Slack manifest,
    // and the Discord declarations is environment-independent. When there is no
    // container to bounce (TYPECLAW_CONTAINER_NAME unset — tests, ad-hoc
    // `typeclaw run` outside Docker), the handler reports that instead of the
    // command resolving as unknown, which would make the advertised contract
    // depend on the runtime environment.
    onRestart: async (ctx): Promise<string> => {
      if (containerName === undefined) {
        return 'Restart is unavailable: this agent is not running inside a typeclaw container.'
      }
      // When the /restart command resolved a live channel session, ctx carries
      // its identity: pass stream + session id/file + channel handoffOrigin so
      // the dying container appends the `typeclaw.restart-self` entry (via the
      // broadcast) and writes a channel-origin handoff. On the next boot the
      // channel resume path reopens that exact conversation. With no live
      // session (cold channel / native slash), ctx is undefined and the
      // container just bounces — the next inbound resumes pending todos.
      const result = await requestContainerRestart({
        containerName,
        ...(ctx !== undefined
          ? {
              stream,
              agentDir: cwd,
              originatingSessionId: ctx.originatingSessionId,
              ...(ctx.originatingSessionFile !== undefined
                ? { originatingSessionFile: ctx.originatingSessionFile }
                : {}),
              handoffOrigin: ctx.handoffOrigin,
              ...(ctx.triggeringAuthorId !== undefined ? { triggeringAuthorId: ctx.triggeringAuthorId } : {}),
            }
          : {}),
      })
      return result.ok ? 'Restart scheduled; the container will bounce shortly.' : `Restart denied: ${result.reason}`
    },
  })

  const createSessionForSubagent: import('@/agent/subagents').CreateSessionForSubagent = async (
    subagent,
    subagentOptions,
  ) => {
    const snap = pluginRuntime.get()
    const entry = snap.pluginSubagentByShim.get(subagent)
    if (entry) {
      const sessionManager = SessionManager.create(cwd, sessionFactory.sessionDir())
      const sessionId = sessionManager.getSessionId()
      const origin: SessionOrigin = {
        kind: 'subagent' as const,
        subagent: subagentOptions?.name ?? entry.subagentName,
        parentSessionId: subagentOptions?.parentSessionId ?? '<unknown>',
        ...(subagentOptions?.spawnedByRole !== undefined ? { spawnedByRole: subagentOptions.spawnedByRole } : {}),
        ...(subagentOptions?.spawnedByOrigin !== undefined ? { spawnedByOrigin: subagentOptions.spawnedByOrigin } : {}),
      }
      const allowBackgroundFromSubagent =
        entry.pluginSubagent.canBackgroundSpawnSubagents === true && entry.pluginSubagent.canSpawnSubagents === true
      const created = await createSessionWithDispose({
        systemPromptOverride: entry.pluginSubagent.systemPrompt,
        sessionManager,
        channelRouter: channelManager.router,
        origin,
        permissions: pluginsLoaded.permissions,
        plugins: {
          registry: snap.registry,
          hooks: snap.hooks,
          sessionId,
          agentDir: cwd,
        },
        pluginSubagent: {
          pluginName: entry.pluginName,
          ...(entry.pluginSubagent.tools ? { toolRefs: entry.pluginSubagent.tools } : {}),
          ...(entry.pluginSubagent.customTools ? { customTools: entry.pluginSubagent.customTools } : {}),
          toolNamePrefix: `__plugin_${entry.pluginName}_${entry.subagentName}`,
        },
        // Orchestration wiring is opt-in per subagent (canSpawnSubagents) so
        // only operator/reviewer can delegate; explorer/scout/etc. stay leaves.
        // The same liveSubagentRegistry instance is shared, but
        // subagent_output/subagent_cancel scope by the caller's session (see
        // authorizeLiveSubagentAccess) and spawn_subagent caps the chain at
        // MAX_SUBAGENT_DEPTH. createSessionForSubagent self-references so a
        // nested spawn re-enters this same factory.
        ...(entry.pluginSubagent.canSpawnSubagents === true
          ? {
              liveSubagentRegistry,
              subagentRegistry: snap.subagents,
              createSessionForSubagent,
              allowBackgroundFromSubagent,
            }
          : {}),
        ...(resolveSubagentProfile(entry.pluginSubagent, subagentOptions) !== undefined
          ? { profile: resolveSubagentProfile(entry.pluginSubagent, subagentOptions) }
          : {}),
        ...(entry.pluginSubagent.toolResultBudget !== undefined
          ? { toolResultBudget: entry.pluginSubagent.toolResultBudget }
          : {}),
        ...(entry.pluginSubagent.bashPolicy !== undefined ? { bashPolicy: entry.pluginSubagent.bashPolicy } : {}),
        ...runtimeVersionOpt,
      })
      liveSessionRegistry.register({
        sessionId,
        session: created.session,
        origin: sessionMetaPayload(origin).origin,
        registeredAtMs: Date.now(),
      })
      const originalDispose = created.dispose
      return {
        ...created,
        dispose: async () => {
          liveSessionRegistry.unregister(sessionId)
          await originalDispose()
        },
        hooks: snap.hooks,
        sessionId,
        agentDir: cwd,
        origin,
        getTranscriptPath: () => sessionManager.getSessionFile(),
        ...(allowBackgroundFromSubagent
          ? { backgroundDrain: { stream, sessionId, liveRegistry: liveSubagentRegistry } }
          : {}),
      }
    }
    // Non-plugin (built-in) subagents — general/explore/scout/memory-logger/
    // dreaming and anything spawned through the generic task path. They used to
    // run with NO plugin tool.before/tool.after coverage, so their bash skipped
    // the security guards AND the github-cli-auth GitHub-token injection — a
    // generic subagent's `git push` got no minted token and died with "could
    // not read Username" even when a GitHub App was configured. Thread the same
    // hook bus the plugin-subagent branch uses, against a freshly allocated
    // subagent session id (never the parent's, so hooks/audit/permission
    // attribution stay per-session).
    const sessionManager = SessionManager.create(cwd, sessionFactory.sessionDir())
    return defaultCreateSessionForSubagent(subagent, {
      ...subagentOptions,
      plugins: {
        registry: snap.registry,
        hooks: snap.hooks,
        sessionId: sessionManager.getSessionId(),
        agentDir: cwd,
      },
      // Pass permissions alongside plugins (same as the plugin-subagent branch
      // at line 384): without it the builtin-bash sandbox (applyBashSandbox /
      // applyTmpPathRedirect) stays off and the subagent would get the injected
      // token but no role-derived sandboxing.
      permissions: pluginsLoaded.permissions,
    })
  }

  const subagentConsumer = createSubagentConsumer({
    stream,
    getRegistry: () => pluginRuntime.get().subagents,
    agentDir: cwd,
    createSessionForSubagent,
    inFlightKey: (name, payload) => {
      const entry = pluginSubagentByName.get(name)
      const fn = entry?.pluginSubagent.inFlightKey
      if (fn !== undefined) {
        try {
          return `${name}:${fn(payload)}`
        } catch {
          return name
        }
      }
      return name
    },
  })
  subagentConsumer.start()

  // Populated by startScheduler's factory (onCountStore). The consumer
  // subscribes before this is set, but only touches the holder at fire time
  // (reading the count via `get` and recording it via `increment`) — and the
  // scheduler (the sole cron publisher) is armed only AFTER the holder is
  // populated, so no count-limited fire can observe an undefined holder. If
  // another cron publisher is ever added, create the store before this point.
  let cronCountStore: CountStore | undefined
  const cronConsumer = createCronConsumer({
    stream,
    cwd,
    countStore: {
      get: (id, job) => cronCountStore?.get(id, job) ?? 0,
      // Holder is always set before any fire (see above); the `false` fallback
      // fails safe — skip dispatch rather than run an uncounted count-job — for
      // the unreachable case where a fire somehow predates the holder.
      increment: (id, job, at) => cronCountStore?.increment(id, job, at) ?? Promise.resolve(false),
    },
    invokeHandler: async (job) => {
      const snap = pluginRuntime.get()
      const registered = snap.registry.cronJobs.find((j) => j.globalId === job.id)
      const pluginName = registered?.pluginName ?? '<unknown>'
      const logger = createPluginLogger(pluginName)
      const abortController = new AbortController()
      const origin: SessionOrigin = {
        kind: 'cron',
        jobId: job.id,
        jobKind: 'handler',
        ...(job.scheduledByRole !== undefined ? { scheduledByRole: job.scheduledByRole } : {}),
        scheduledByOrigin: (job.scheduledByOrigin as SessionOrigin | undefined) ?? { kind: 'config-file' },
      }
      const ctx: CronHandlerContext = {
        jobId: job.id,
        name: pluginName,
        agentDir: cwd,
        logger,
        signal: abortController.signal,
        permissions: pluginsLoaded.permissions,
        origin,
        prompt: (text: string) =>
          runPromptForCommand({
            text,
            origin,
            runtime: pluginRuntime,
            agentDir: cwd,
            permissions: pluginsLoaded.permissions,
            signal: abortController.signal,
            runtimeVersion: runtimeVersionOpt.runtimeVersion,
            containerName: containerNameOpt.containerName,
            sessionFactory,
            channelRouter: channelManager.router,
            suppressSystemMemory,
            ...mcpManagerOpt,
          }),
        subagent: (subName: string, payload?: unknown) =>
          dispatchSpawnSubagent(subName, payload, {
            spawnedByOrigin: origin,
          }),
        exec: (strings: TemplateStringsArray, ...values: unknown[]) =>
          runExecForCommand(strings, values, { cwd, signal: abortController.signal }),
      }
      await job.handler(ctx)
    },
    createSessionForCron: async (job, refOverride) => {
      const snap = pluginRuntime.get()
      const sessionManager = SessionManager.create(cwd, sessionFactory.sessionDir())
      const sessionId = sessionManager.getSessionId()
      const cronOrigin: SessionOrigin = {
        kind: 'cron',
        jobId: job.id,
        jobKind: 'prompt',
        ...(job.scheduledByRole !== undefined ? { scheduledByRole: job.scheduledByRole } : {}),
        // Honor the persisted audit snapshot when present (TUI-authored
        // crons, or jobs scheduled by a future `cron_schedule` tool).
        // Hand-authored entries fall back to the config-file synthetic
        // marker so the audit trail records "user edited cron.json".
        scheduledByOrigin: (job.scheduledByOrigin as SessionOrigin | undefined) ?? { kind: 'config-file' },
      }
      // Cron todos are per-fire ephemeral by default: each scheduled run starts
      // with a clean list so an incomplete item from a prior fire cannot
      // resurrect indefinitely on every tick. (A future opt-in could carry them
      // forward; until then, clearing is the safe default.)
      await clearTodosForOrigin(cwd, cronOrigin).catch((err) =>
        console.error(`[cron] ${job.id}: clear todos failed: ${err instanceof Error ? err.message : String(err)}`),
      )
      const session = await createSession({
        reloadRegistry,
        sessionManager,
        stream,
        channelRouter: channelManager.router,
        origin: cronOrigin,
        permissions: pluginsLoaded.permissions,
        suppressSystemMemory,
        ...(refOverride !== undefined ? { refOverride } : {}),
        ...(snap.hasAnyPluginContent
          ? {
              plugins: {
                registry: snap.registry,
                hooks: snap.hooks,
                sessionId,
                agentDir: cwd,
              },
            }
          : {}),
        liveSubagentRegistry,
        subagentRegistry: pluginRuntime.get().subagents,
        createSessionForSubagent,
        ...containerNameOpt,
        ...runtimeVersionOpt,
        ...mcpManagerOpt,
      })
      liveSessionRegistry.register({
        sessionId,
        session,
        origin: sessionMetaPayload(cronOrigin).origin,
        registeredAtMs: Date.now(),
      })
      return {
        prompt: (text) => session.prompt(text),
        dispose: () => {
          liveSessionRegistry.unregister(sessionId)
          session.dispose()
        },
        sessionId,
        agentDir: cwd,
        origin: cronOrigin,
        session,
        ...(snap.hasAnyPluginContent ? { hooks: snap.hooks } : {}),
        getTranscriptPath: () => sessionManager.getSessionFile(),
      }
    },
  })

  const internalJobs = () => pluginCronJobs(pluginRuntime.get().registry)
  const factory = createSchedulerFor ?? makeDefaultSchedulerFactory(internalJobs)
  // Subscribe the consumer BEFORE the scheduler arms any timers. The stream
  // delivers only to live subscribers (no replay), so a fire published before
  // the subscription exists would be lost. Subscribing to an empty stream is
  // harmless when there are no jobs.
  cronConsumer.start()
  const scheduler = await startScheduler({
    cwd,
    loadCron,
    createSchedulerFor: factory,
    stream,
    hasInternalJobs: internalJobs().length > 0,
    getSubagents: () => pluginRuntime.get().subagents,
    onCountStore: (store) => {
      cronCountStore = store
    },
  })

  if (scheduler) {
    reloadRegistry.register(
      createCronReloadable({ cwd, scheduler, internalJobs, getSubagents: () => pluginRuntime.get().subagents }),
    )
  }

  const tunnelBridge: TunnelBridge = createTunnelBridge({ stream, channelManager })

  // Bridge `subagent.completed` broadcasts into the channel router so a
  // backgrounded subagent finishing wakes up its parent channel session
  // with a `<system-reminder>` — symmetric to the TUI bridge in
  // src/server/index.ts. Must be created BEFORE channelManager.start()
  // so an initial broadcast can never race past the subscription gap.
  const subagentCompletionBridge: SubagentCompletionBridge = createSubagentCompletionBridge({
    stream,
    router: channelManager.router,
  })

  reloadRegistry.register(createChannelsReloadable({ manager: channelManager }))

  // Two-phase channel restart-resume around adapter startup, to close the race
  // where an adapter starts receiving before the resume claims the handoff:
  //   1. Claim the channel handoff and RESERVE the originating key BEFORE
  //      channelManager.start(). The reservation installs a per-key gate, so an
  //      inbound that arrives the instant an adapter connects coalesces onto the
  //      resume instead of stale-rolling the mapping or creating a rival session.
  //   2. start() the adapters (registers outbound callbacks the wake reply needs).
  //   3. resume() the reservation: reopen the exact session and enqueue the wake
  //      — skipped automatically if a real inbound already coalesced in (2)→(3).
  // Claims ONLY channel handoffs; tui handoffs are left on disk (peek-then-delete
  // never removes an unclaimed handoff) for the websocket open handler to claim.
  // Best-effort throughout: any failure leaves the todo to resume on the next inbound.
  let restartReservation: ReturnType<typeof channelManager.router.reserveRestartHandoff> = null
  try {
    const handoff = await consumeRestartHandoff(cwd, { accept: (h) => h.origin.kind === 'channel' })
    if (handoff !== null) restartReservation = channelManager.router.reserveRestartHandoff(handoff)
  } catch (err) {
    console.warn(`[run] channel restart-resume reserve failed: ${err instanceof Error ? err.message : err}`)
  }

  await channelManager.start()

  if (restartReservation !== null) {
    try {
      await restartReservation.resume()
    } catch (err) {
      console.warn(`[run] channel restart-resume failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  // Captured separately from setSpawnSubagent so both the plugin context and
  // the plugin-command runner can dispatch through the same path. The setter
  // returns void, so without this local binding we couldn't reuse the fn.
  //
  // In-flight coalescing for direct ctx.spawnSubagent calls mirrors the
  // SubagentConsumer's stream-path gate (subagents.ts:441). Two queued
  // `new-session` messages for the same (name, inFlightKey) drop the second
  // on the consumer side; without the same gate here, two consecutive
  // session.prompt fires (cold-start prompt N immediately followed by prompt
  // N+1 on the same channel session) could both fire memory-retrieval spawns
  // racing to write `memory/.retrieval-cache/<sessionId>.md`. Awaiting the
  // spawn in the hook used to mask this; now that the hook is fire-and-forget,
  // the race is exposed and the gate is mandatory.
  //
  // Same key shape as the consumer: `${name}:${inFlightKey(payload)}` when the
  // subagent declares one, else just `${name}`. Collisions resolve cleanly
  // (logged + return) instead of rejecting, because callers from
  // session.prompt are detached and a colliding spawn is a noop, not an error.
  const directSpawnInFlight = new Set<string>()
  const dispatchSpawnSubagent: CommandSpawnSubagent = async (name, payload, options) => {
    const entry = pluginSubagentByName.get(name)
    const keyFn = entry?.pluginSubagent.inFlightKey
    let coalesceKey = name
    if (keyFn !== undefined) {
      try {
        coalesceKey = `${name}:${keyFn(payload)}`
      } catch {
        coalesceKey = name
      }
    }
    if (directSpawnInFlight.has(coalesceKey)) {
      console.warn(`[subagent] ${coalesceKey}: previous direct spawn still in progress, skipping`)
      return
    }
    directSpawnInFlight.add(coalesceKey)
    try {
      // Resolve the spawning session's role from its origin so the subagent
      // inherits it. Callers (hooks like session.idle) pass the parent origin
      // verbatim; we look up the role rather than letting the caller forge it,
      // closing the laundering vector the design doc calls out for cron.
      const spawnedByRole =
        options?.spawnedByOrigin !== undefined
          ? pluginsLoaded.permissions.resolveRole(options.spawnedByOrigin)
          : undefined
      const registry = pluginRuntime.get().subagents
      try {
        await awaitWithSubagentTimeout(
          invokeSubagent(name, {
            registry,
            createSessionForSubagent,
            agentDir: cwd,
            userPrompt: '',
            payload,
            onProviderError: (message) => console.error(`[subagent] ${name}: LLM call failed: ${message}`),
            ...(options?.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
            ...(spawnedByRole !== undefined ? { spawnedByRole } : {}),
            ...(options?.spawnedByOrigin !== undefined ? { spawnedByOrigin: options.spawnedByOrigin } : {}),
          }),
          name,
          coalesceKey,
          registry[name]?.timeoutMs,
        )
      } catch (err) {
        if (isSubagentTimeoutError(err)) {
          console.warn(`[subagent] ${coalesceKey} timed out after ${err.timeoutMs}ms; releasing coalesce key`)
          return
        }
        throw err
      }
    } finally {
      directSpawnInFlight.delete(coalesceKey)
    }
  }
  pluginsLoaded.setSpawnSubagent(dispatchSpawnSubagent)
  pluginsLoaded.markBooted()

  if (pluginsLoaded.loadedPlugins.length > 0) {
    console.log(`[plugin] loaded ${summarizeLoaded(pluginsLoaded.loadedPlugins, pluginRegistry)}`)
  }

  for (const f of pluginsLoaded.failedPlugins) {
    console.warn(`[plugin] DEGRADED: "${f.entry}" disabled (${f.phase}): ${f.error}`)
  }

  // Container-side portbroker is instantiated only when the host plumbed a
  // broker token in via env var. Outside the container (tests, ad-hoc dev
  // runs), the env var is absent and the broker stays off — same fence as
  // TYPECLAW_CONTAINER_NAME guards the restart tool.
  const brokerTokenEnv = process.env.TYPECLAW_HOSTD_BROKER_TOKEN
  const containerBroker =
    brokerTokenEnv !== undefined && brokerTokenEnv.length > 0
      ? createContainerBroker({
          expectedToken: brokerTokenEnv,
          onLog: (event) => {
            if (event.kind === 'subscribed') return
            stream.publish({
              target: { kind: 'broadcast' },
              payload: { kind: 'portbroker-log', event },
            })
          },
          // Re-publish to in-process buses so plugin code can talk to the
          // broker without holding a ContainerBroker reference.
          onForwardResult: (event) => publishForwardResult(event),
          onForwardRequestSubscribe: (cb) => subscribeForwardRequest(cb),
        })
      : undefined
  const containerBrokerOpt = containerBroker ? { containerBroker } : {}

  const commandRunnerFactory = (outbound: import('@/server/command-runner').CommandOutbound): CommandRunner =>
    createCommandRunner({
      pluginRuntime,
      permissions: pluginsLoaded.permissions,
      spawnSubagent: dispatchSpawnSubagent,
      agentDir: cwd,
      runtimeVersion: CLI_VERSION,
      containerName,
      outbound,
      sessionFactory,
      channelRouter: channelManager.router,
      suppressSystemMemory,
      ...mcpManagerOpt,
    })

  const server = createServer({
    port,
    reloadAll: () => reloadRegistry.reloadAll(),
    reloadRegistry,
    sessionFactory,
    stream,
    channelRouter: channelManager.router,
    ...mcpManagerOpt,
    agentDir: cwd,
    pluginRuntime,
    getFiredCount: (job) => cronCountStore?.get(job.id, job) ?? 0,
    claimController,
    commandRunnerFactory,
    tunnelManager,
    liveSubagentRegistry,
    createSessionForSubagent,
    liveSessionRegistry,
    ...containerNameOpt,
    ...runtimeVersionOpt,
    ...tuiTokenOpt,
    ...containerBrokerOpt,
  }).start()

  // Tunnel manager starts AFTER the WS server is up so a slow/hanging
  // provider (PR 2's cloudflared first-URL wait) cannot block TUI, reload,
  // or channel adapter availability. External providers resolve URLs
  // synchronously; future managed providers will resolve asynchronously
  // and broadcast URL events when ready.
  await tunnelManager.start()

  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    scheduler?.stop()
    cronConsumer.stop()
    subagentConsumer.stop()
    server.stop(true)
    void disposeMaterializedSkills(pluginRuntime)
    tunnelBridge.stop()
    subagentCompletionBridge.stop()
    await tunnelManager.stop()
    await channelManager.stop()
    await mcpManager?.closeAll()
    uninstallCodexFetchObserver()
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
      pluginRuntime,
      loadedPlugins: pluginsLoaded.loadedPlugins,
      channelManager,
      stop,
    }
  }

  const serverPort = server.port
  if (serverPort === undefined) throw new Error('server did not report a listening port')
  const url = buildLocalTuiUrl(serverPort, tuiTokenOpt.tuiToken ?? null)
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
    pluginRuntime,
    loadedPlugins: pluginsLoaded.loadedPlugins,
    channelManager,
    stop,
  }
}

function buildLocalTuiUrl(port: number, token: string | null): string {
  if (token === null) return `ws://localhost:${port}`
  const url = new URL(`ws://localhost:${port}`)
  url.searchParams.set('token', token)
  return url.toString()
}

function resolveTunnelUrlForChannel(channelName: string, tunnelManager: TunnelManager): string | null {
  const tunnel = getConfig().tunnels.find((entry) => entry.for.kind === 'channel' && entry.for.name === channelName)
  return tunnel ? tunnelManager.urlFor(tunnel.name) : null
}

function isTunnelConfiguredForChannel(channelName: string): boolean {
  return getConfig().tunnels.some((entry) => entry.for.kind === 'channel' && entry.for.name === channelName)
}

async function disposeMaterializedSkills(pluginRuntime: PluginRuntime): Promise<void> {
  const pending = pluginRuntime.drainPendingDisposal()
  const current = pluginRuntime.get().materializedSkills
  const all = current ? [...pending, current] : pending
  await Promise.allSettled(all.map((m) => m.dispose()))
}

// grant_role's hot-reload hook: reload the live config FROM DISK (grantRole
// wrote typeclaw.json directly, bypassing the in-memory snapshot) and return
// the fresh roles for permissions.replaceRoles. Mirrors the config reloadable's
// reload-then-read order. Falls back to the current snapshot if the just-written
// file fails to parse — the on-disk write still stands and the next reload picks
// it up; replaceRoles with stale roles is no worse than not reloading.
function reloadRolesFromDisk(cwd: string): ReturnType<typeof getConfig>['roles'] {
  try {
    reloadConfig(cwd)
  } catch {
    // keep the current pointer; see above
  }
  return getConfig().roles
}

async function startScheduler({
  cwd,
  loadCron,
  createSchedulerFor,
  stream,
  hasInternalJobs,
  getSubagents,
  onCountStore,
}: {
  cwd: string
  loadCron: LoadCronFn
  createSchedulerFor: SchedulerFactory
  stream: Stream
  hasInternalJobs: boolean
  getSubagents?: () => SubagentRegistry
  onCountStore?: (store: CountStore) => void
}): Promise<Scheduler | null> {
  let result: LoadCronResult
  const subagents = getSubagents?.()
  try {
    result = await loadCron(cwd, subagents !== undefined ? { subagents } : {})
  } catch (err) {
    console.error(`[cron] load failed: ${err instanceof Error ? err.message : err}`)
    return null
  }
  if (!result.ok) {
    console.error(`[cron] failed to load cron.json: ${result.reason}`)
    return null
  }
  const file: CronFile = result.file ?? { jobs: [] }
  if (!result.file && !hasInternalJobs) return null

  const onFire = (job: CronJob) => {
    stream.publish({ target: { kind: 'cron', jobId: job.id }, payload: job })
  }
  const scheduler = await createSchedulerFor({ cwd, file, onFire, onCountStore })
  scheduler.start()
  return scheduler
}

function makeDefaultSchedulerFactory(internalJobs: () => CronJob[]): SchedulerFactory {
  return async ({ cwd, file, onFire, onCountStore }) => {
    const jobs = [...file.jobs, ...internalJobs()]
    const countStore = await createCountStore(cwd, jobs)
    // Share the one store instance with the consumer's authoritative count gate.
    onCountStore?.(countStore)
    return createScheduler({ jobs, onFire, countStore })
  }
}

// Exported for the regression test in `merge-subagents.test.ts`. The shim
// layer between the plugin-author-facing `Subagent` (`@/plugin/types`) and
// the runtime-internal `Subagent` (`@/agent/subagents`) is the load-bearing
// translation point for visibility, payload-schema, and permission gating —
// fields that flow through the `SubagentRegistry` without going through the
// `pluginSubagentByShim` recovery path. Previous regressions silently
// dropped fields here, hiding every public bundled subagent (scout,
// explorer, operator) from the `spawn_subagent` tool surface.
export function mergeSubagents(pluginRegistry: PluginRegistry): {
  registry: SubagentRegistry
  pluginSubagentByShim: WeakMap<InternalSubagent<any>, PluginSubagentEntry>
  pluginSubagentByName: Map<string, PluginSubagentEntry>
} {
  const merged: Record<string, InternalSubagent<any>> = {}
  const pluginSubagentByShim = new WeakMap<InternalSubagent<any>, PluginSubagentEntry>()
  const pluginSubagentByName = new Map<string, PluginSubagentEntry>()
  for (const reg of pluginRegistry.subagents) {
    if (merged[reg.subagentName] !== undefined) {
      throw new Error(
        `plugin ${reg.pluginName}: subagent name "${reg.subagentName}" already registered (across plugins)`,
      )
    }
    const shim = pluginSubagentShim(reg.subagent)
    merged[reg.subagentName] = shim
    const entry: PluginSubagentEntry = {
      pluginName: reg.pluginName,
      subagentName: reg.subagentName,
      pluginSubagent: reg.subagent,
    }
    pluginSubagentByShim.set(shim, entry)
    pluginSubagentByName.set(reg.subagentName, entry)
  }
  return { registry: merged, pluginSubagentByShim, pluginSubagentByName }
}

// Compile-time proof that every plugin-only key on `@/plugin`'s `Subagent`
// (i.e. every key NOT inherited from `SubagentShared`) has been classified
// for the shim. When a future maintainer introduces a new field on plugin-side
// `Subagent` that isn't on `SubagentShared`, the `satisfies` clause on
// `PLUGIN_ONLY_KEYS_DROPPED_BY_SHIM` below fails at compile time until the
// new key is listed there — and the destructuring in `pluginSubagentShim`
// is updated to discard it. Without this guard, the shim's rest-spread
// would silently leak future plugin-only fields into the internal registry —
// the opposite-direction drift from the bug this PR fixes for shared fields.
type PluginOnlySubagentKeys = Exclude<keyof import('@/plugin').Subagent<any>, keyof SubagentShared<any>>
const PLUGIN_ONLY_KEYS_DROPPED_BY_SHIM = {
  tools: true,
  customTools: true,
  inFlightKey: true,
} satisfies Record<PluginOnlySubagentKeys, true>
// Reference the table so it's not dead code. The value is a runtime no-op;
// the load-bearing work is the `satisfies` clause above which forces
// exhaustive classification of plugin-only keys at compile time.
void PLUGIN_ONLY_KEYS_DROPPED_BY_SHIM

function pluginSubagentShim(subagent: import('@/plugin').Subagent<any>): InternalSubagent<any> {
  // The two diverging fields (`tools` is `BuiltinToolRef[]` plugin-side vs
  // `AgentSessionTools` internal-side; `customTools` similarly differs) are
  // resolved later in `createSessionForSubagent` via the
  // `pluginSubagentByShim` lookup, which recovers the original plugin
  // reference. `inFlightKey` is consumed only by the SubagentConsumer via
  // `pluginSubagentByName`, not through this shim's registry path. Every
  // other plugin-side field lives on `SubagentShared` and is structurally
  // assignable to the internal `Subagent`, so a rest-spread carries them
  // verbatim — including `visibility` and `requiresSpecificPermission`,
  // whose silent drop in the previous shim made every plugin-contributed
  // public subagent (scout, explorer, operator) invisible to the
  // `spawn_subagent` tool. The list of keys removed here is enforced
  // exhaustive at compile time by `PLUGIN_ONLY_KEYS_DROPPED_BY_SHIM` above.
  const { tools: _tools, customTools: _customTools, inFlightKey: _inFlightKey, ...shared } = subagent
  return shared
}
