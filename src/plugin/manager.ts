import { z } from 'zod'

import type { ResolveGithubTokenForRepo } from '@/channels/github-token-bridge'
import type { CronJob } from '@/cron'
import {
  createPermissionService,
  findUnknownPermissions,
  type PermissionService,
  type RolesConfig,
} from '@/permissions'

import { createPluginContext, createPluginLogger, type SpawnSubagentFn } from './context'
import { createHookBus, type HookBus } from './hooks'
import { loadPluginEntry, type LoadPluginEntryFn, PluginSecurityError, type ResolvedPlugin } from './loader'
import { discardRegistrationsBy, emptyRegistry, type PluginRegistry, registerContributions } from './registry'
import type { PluginExports } from './types'

export type FailedPlugin = { entry: string; phase: 'resolve' | 'config' | 'factory' | 'register'; error: string }

// A user (typeclaw.json / local / npm) plugin that fails to load must not brick
// the agent: the agent can edit its own plugins, and a self-introduced bug would
// otherwise leave the container unable to boot and repair itself. Such failures
// are isolated (skip + warn, keep the rest). Bundled plugins are part of the
// trusted runtime, so their failure stays fatal — and PluginSecurityError stays
// fatal for everyone.
function isToleratedUserError(err: unknown): boolean {
  return !(err instanceof PluginSecurityError)
}

export type LoadPluginsOptions = {
  entries: string[]
  agentDir: string
  configsByName: Record<string, unknown>
  loadEntry?: LoadPluginEntryFn
  roles?: RolesConfig
  resolveGithubTokenForRepo?: ResolveGithubTokenForRepo
  hasGithubAppTokenResolver?: () => boolean
  // Bundled plugins resolved by the runtime (not from typeclaw.json). Loaded
  // before user-declared `entries` so a config block named after a bundled
  // plugin (e.g. "memory") is consumed by the bundled plugin, and so plugin-
  // name conflicts with a user-declared entry surface as a clear error.
  bundled?: ResolvedPlugin[]
}

export type LoadPluginsResult = {
  registry: PluginRegistry
  hooks: HookBus
  permissions: PermissionService
  declaredPermissions: readonly string[]
  loadedPlugins: { name: string; version: string | undefined; source: string }[]
  failedPlugins: FailedPlugin[]
  markBooted: () => void
  setSpawnSubagent: (fn: SpawnSubagentFn) => void
  disposePlugins: () => Promise<void>
}

export async function loadPlugins(opts: LoadPluginsOptions): Promise<LoadPluginsResult> {
  const registry = emptyRegistry()
  const hooks = createHookBus()
  const loaded: { name: string; version: string | undefined; source: string }[] = []
  const loadEntry = opts.loadEntry ?? loadPluginEntry

  let booted = false
  let spawnSubagentImpl: SpawnSubagentFn = async () => {
    throw new Error('plugin: spawnSubagent is not yet wired')
  }

  const failed: FailedPlugin[] = []

  // A user entry that fails to resolve OR throws at import time (typo,
  // uninstalled package, syntax error in a local plugin the agent just edited)
  // is isolated: warn, record, skip — the rest still boot. PluginSecurityError
  // (path escape) is the one exception and stays fatal.
  const resolvedEntries = await Promise.all(
    opts.entries.map(async (entry) => {
      try {
        return { entry, resolved: await loadEntry(entry, opts.agentDir) }
      } catch (err) {
        if (!isToleratedUserError(err)) throw err
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[plugin] failed to load "${entry}", skipping: ${message}`)
        failed.push({ entry, phase: 'resolve', error: message })
        return null
      }
    }),
  )
  const allPlugins: { entry: string; resolved: ResolvedPlugin; isBundled: boolean }[] = [
    ...(opts.bundled?.map((resolved) => ({ entry: `<bundled:${resolved.name}>`, resolved, isBundled: true })) ?? []),
    ...resolvedEntries
      .filter((e): e is { entry: string; resolved: ResolvedPlugin } => e !== null)
      .map((e) => ({ ...e, isBundled: false })),
  ]

  // Seed the permission service from BUNDLED plugins only. A user plugin's
  // declared permissions / owner-wildcard exclusions must not enter the live
  // service until the plugin actually survives registration — otherwise a
  // plugin reported as disabled could still widen the allowed set or (worse)
  // strip an owner-wildcard bypass. Bundled plugins are always survivors:
  // their failure is fatal, so the boot aborts before this service is used.
  const bundledPlugins = allPlugins.filter((p) => p.isBundled)
  const permissions = createPermissionService({
    ...(opts.roles !== undefined ? { roles: opts.roles } : {}),
    pluginPermissions: collectDeclaredPermissions(bundledPlugins),
    ownerWildcardExclusions: collectOwnerWildcardExclusions(bundledPlugins),
  })

  const survivors: { entry: string; resolved: ResolvedPlugin; isBundled: boolean }[] = []

  for (const plugin of allPlugins) {
    const { entry, resolved, isBundled } = plugin
    // Name conflict is a global invariant (two plugins claiming one name make
    // every later name-keyed lookup ambiguous), so it stays fatal regardless of
    // origin — never demoted to a per-plugin skip.
    if (loaded.find((l) => l.name === resolved.name)) {
      throw new Error(`plugin name conflict: ${resolved.name} (entry ${entry}) already loaded`)
    }

    try {
      await registerOnePlugin({
        resolved,
        config: opts.configsByName[resolved.name],
        agentDir: opts.agentDir,
        registry,
        hooks,
        permissions,
        ctxDeps: {
          resolveGithubTokenForRepo: opts.resolveGithubTokenForRepo,
          hasGithubAppTokenResolver: opts.hasGithubAppTokenResolver,
          spawnSubagent: (name, payload, options) => spawnSubagentImpl(name, payload, options),
          isBooted: () => booted,
        },
      })
    } catch (err) {
      const phase = err instanceof PluginPhaseError ? err.phase : 'factory'
      const message = err instanceof PluginPhaseError ? err.detail : err instanceof Error ? err.message : String(err)
      // Bundled/core plugin failures are typeclaw bugs (or a compromised
      // runtime) — fail loud. Only user plugin failures are isolated.
      if (isBundled || !isToleratedUserError(err instanceof PluginPhaseError ? err.original : err)) {
        throw err instanceof PluginPhaseError ? err.original : err
      }
      discardRegistrationsBy(resolved.name, registry, hooks)
      console.warn(`[plugin] failed to load "${entry}", skipping: ${message}`)
      failed.push({ entry, phase, error: message })
      continue
    }

    survivors.push(plugin)
    loaded.push({ name: resolved.name, version: resolved.version, source: resolved.source })
  }

  // Finalize the permission model from the survivor set only. Plugin factories
  // captured `permissions` by reference (their hooks read it at request time),
  // so we mutate that same object in place rather than returning a new one.
  const declaredPermissions = collectDeclaredPermissions(survivors)
  permissions.replacePluginPermissions?.({
    pluginPermissions: declaredPermissions,
    ownerWildcardExclusions: collectOwnerWildcardExclusions(survivors),
  })

  // Non-fatal: surface user-declared `permissions[]` strings that aren't in
  // the known set, so a typo like `security.bypass.secretExfilBach` is
  // visible at boot rather than silently failing to bypass the matching
  // guard. We log instead of throw because the runtime still functions --
  // the unknown string just never matches anything. Run AFTER finalization so
  // a failed plugin's declarations don't make a role's permission look known.
  for (const warning of findUnknownPermissions(opts.roles, declaredPermissions)) {
    console.warn(
      `[permissions] role "${warning.role}" declares unknown permission "${warning.permission}" — ${warning.hint}`,
    )
  }

  return {
    registry,
    hooks,
    permissions,
    declaredPermissions,
    loadedPlugins: loaded,
    failedPlugins: failed,
    markBooted: () => {
      booted = true
    },
    setSpawnSubagent: (fn) => {
      spawnSubagentImpl = fn
    },
    disposePlugins: () => disposePlugins(registry),
  }
}

async function disposePlugins(registry: PluginRegistry): Promise<void> {
  await Promise.all(
    registry.disposers.map(async (disposer) => {
      try {
        await disposer.dispose()
      } catch (err) {
        disposer.logger.warn(`onDispose failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }),
  )
}

// Tags WHICH sub-phase failed (for the failedPlugins report) while preserving
// the ORIGINAL error so the caller can keep PluginSecurityError fatal even when
// it surfaces deep inside registration.
class PluginPhaseError extends Error {
  readonly phase: FailedPlugin['phase']
  readonly detail: string
  readonly original: unknown
  constructor(phase: FailedPlugin['phase'], detail: string, original: unknown) {
    super(detail)
    this.name = 'PluginPhaseError'
    this.phase = phase
    this.detail = detail
    this.original = original
  }
}

type RegisterOnePluginArgs = {
  resolved: ResolvedPlugin
  config: unknown
  agentDir: string
  registry: PluginRegistry
  hooks: HookBus
  permissions: PermissionService
  ctxDeps: {
    resolveGithubTokenForRepo?: ResolveGithubTokenForRepo
    hasGithubAppTokenResolver?: () => boolean
    spawnSubagent: SpawnSubagentFn
    isBooted: () => boolean
  }
}

async function registerOnePlugin(args: RegisterOnePluginArgs): Promise<void> {
  const { resolved, registry, hooks } = args

  let validatedConfig: unknown = undefined
  if (resolved.defined.configSchema) {
    const parsed = (resolved.defined.configSchema as z.ZodType<unknown>).safeParse(args.config ?? {})
    if (!parsed.success) {
      const message = `plugin ${resolved.name}: config invalid: ${formatZodIssues(parsed.error)}`
      throw new PluginPhaseError('config', message, new Error(message))
    }
    validatedConfig = parsed.data
  } else if (args.config !== undefined) {
    const message = `plugin ${resolved.name}: config block "${resolved.name}" present in typeclaw.json but plugin declares no configSchema`
    throw new PluginPhaseError('config', message, new Error(message))
  }

  const logger = createPluginLogger(resolved.name)
  const ctx = createPluginContext({
    name: resolved.name,
    version: resolved.version,
    agentDir: args.agentDir,
    config: validatedConfig as never,
    logger,
    permissions: args.permissions,
    resolveGithubTokenForRepo: args.ctxDeps.resolveGithubTokenForRepo,
    hasGithubAppTokenResolver: args.ctxDeps.hasGithubAppTokenResolver,
    spawnSubagent: args.ctxDeps.spawnSubagent,
    isBooted: args.ctxDeps.isBooted,
  })

  let exports: PluginExports
  try {
    exports = await resolved.defined.plugin(ctx)
  } catch (err) {
    discardRegistrationsBy(resolved.name, registry, hooks)
    const message = `plugin ${resolved.name}: factory threw: ${err instanceof Error ? err.message : String(err)}`
    throw new PluginPhaseError('factory', message, err)
  }

  if (hasContributedMcpServers(exports) && !(resolved.defined.permissions ?? []).includes('mcp')) {
    const message = `plugin ${resolved.name}: exporting mcpServers requires declaring the 'mcp' permission`
    throw new PluginPhaseError('register', message, new Error(message))
  }

  try {
    registerContributions({
      pluginName: resolved.name,
      logger,
      exports,
      ...(resolved.defined.commands !== undefined ? { commands: resolved.defined.commands } : {}),
      registry,
      hooks,
      agentDir: args.agentDir,
      pluginConfig: validatedConfig,
    })
  } catch (err) {
    discardRegistrationsBy(resolved.name, registry, hooks)
    throw new PluginPhaseError('register', err instanceof Error ? err.message : String(err), err)
  }
}

function hasContributedMcpServers(exports: PluginExports): boolean {
  return exports.mcpServers !== undefined && Object.keys(exports.mcpServers).length > 0
}

function collectDeclaredPermissions(
  plugins: readonly { entry: string; resolved: ResolvedPlugin }[],
): readonly string[] {
  const out: string[] = []
  for (const { resolved } of plugins) {
    for (const perm of resolved.defined.permissions ?? []) {
      if (!out.includes(perm)) out.push(perm)
    }
  }
  return out
}

function collectOwnerWildcardExclusions(
  plugins: readonly { entry: string; resolved: ResolvedPlugin }[],
): readonly string[] {
  const out: string[] = []
  for (const { resolved } of plugins) {
    for (const perm of resolved.defined.ownerWildcardExclusions ?? []) {
      if (!out.includes(perm)) out.push(perm)
    }
  }
  return out
}

export function summarizeLoaded(loaded: LoadPluginsResult['loadedPlugins'], registry: PluginRegistry): string {
  const head = loaded.map((p) => (p.version !== undefined ? `${p.name} v${p.version}` : p.name)).join(', ')
  const counts = [
    `${registry.tools.length} tool(s)`,
    `${registry.subagents.length} subagent(s)`,
    `${registry.cronJobs.length} cron job(s)`,
    `${registry.mcpServers.length} mcp server(s)`,
    `${registry.skills.length} skill(s)`,
    `${registry.skillsDirs.length} skills dir(s)`,
    `${registry.doctorChecks.length} doctor check(s)`,
    `${registry.commands.length} command(s)`,
  ].join(', ')
  return `${loaded.length} plugin(s): ${head} [${counts}]`
}

export function pluginCronJobs(registry: PluginRegistry): CronJob[] {
  return registry.cronJobs.map((j) => j.job)
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '<root>'}: ${i.message}`).join('; ')
}
