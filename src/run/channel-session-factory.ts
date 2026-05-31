import { SessionManager } from '@mariozechner/pi-coding-agent'

import { createSession as defaultCreateSession } from '@/agent'
import type { LiveSessionRegistry } from '@/agent/live-sessions'
import type { LiveSubagentRegistry } from '@/agent/live-subagents'
import type { CreateSessionForSubagent, SubagentRegistry } from '@/agent/subagents'
import { capJsonlFileInPlace } from '@/bundled-plugins/tool-result-cap/cap-jsonl'
import type { CapOptions } from '@/bundled-plugins/tool-result-cap/cap-result'
import type { CreateSessionForChannel, ChannelRouter } from '@/channels'
import type { McpManager } from '@/mcp'
import type { PermissionService, RolesConfig } from '@/permissions'
import type { ReloadRegistry } from '@/reload'
import type { SessionFactory } from '@/sessions'
import type { Stream } from '@/stream'

import type { PluginRuntime } from './plugin-runtime'

export type FactoryLogger = {
  info: (message: string) => void
  warn: (message: string) => void
}

const consoleLogger: FactoryLogger = {
  info: (m) => console.info(m),
  warn: (m) => console.warn(m),
}

export type BuildChannelSessionFactoryDeps = {
  cwd: string
  sessionFactory: SessionFactory
  stream: Stream
  reloadRegistry: ReloadRegistry
  pluginRuntime: PluginRuntime
  // Late-bound: the router is constructed by the channel manager which itself
  // takes this factory. Reading the router lazily breaks the construction
  // cycle while still ensuring the factory's sessions get the same router
  // their inbound messages came from.
  getChannelRouter: () => ChannelRouter
  mcpManager?: McpManager
  containerName?: string
  runtimeVersion?: string
  // When set, rehydrating a session JSONL caps oversized tool results in the
  // file before pi-coding-agent reads it. `null` disables the load-time pass
  // (tool-result-cap.enabled=false in config, or no plugin block at all).
  rehydrateCapOptions: CapOptions | null
  logger?: FactoryLogger
  // Forwarded to createSession so the resolved role / permissions for the
  // session origin get rendered into the agent's system prompt. Optional so
  // the production wiring can plumb in pluginsLoaded.permissions while tests
  // (or stand-alone callers) keep the previous no-annotation behavior.
  permissions?: PermissionService
  // Re-reads roles from disk for the grant_role tool's hot-reload (reload then
  // read, not an in-memory snapshot). Forwarded to createSession; the tool only
  // mounts when permissions is also present.
  reloadRoles?: () => RolesConfig | undefined
  // Test seam: lets a fake stand in for the agent session creator so tests
  // can assert exactly which CreateSessionOptions the factory builds without
  // needing a live LLM, plugin runtime, or session manager on disk.
  createSession?: typeof defaultCreateSession
  // Subagent orchestration plumbing. All three (or none) are forwarded to
  // createSession so the TUI/channel session exposes spawn_subagent,
  // subagent_output, subagent_cancel. Subagent sessions never receive these
  // — that branch is gated by pluginSubagent in createSessionWithDispose.
  //
  // `getCreateSessionForSubagent` is late-bound to break the construction
  // cycle: channelManager owns the channel-session factory, which needs
  // createSessionForSubagent, which needs channelManager.router. Same shape
  // as `getChannelRouter` above.
  liveSubagentRegistry?: LiveSubagentRegistry
  subagentRegistry?: SubagentRegistry
  getCreateSessionForSubagent?: () => CreateSessionForSubagent
  liveSessionRegistry?: LiveSessionRegistry
}

// Tight basename validation so a tampered or corrupt channels/sessions.json
// can't point the load-time rewrite (or SessionManager.open) at a file
// outside `sessionDir`. We never receive sessionFile from a remote source
// during normal operation, but the file is operator-editable, so defense-
// in-depth is cheap. Match pi-coding-agent's filename convention loosely:
// no path separators, no NUL, must end in `.jsonl`.
function isValidSessionFileBasename(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false
  if (name === '.' || name === '..' || name.startsWith('.')) return false
  return name.endsWith('.jsonl')
}

// The production wiring for channel-routed sessions. Channel inbounds arrive
// at the router, the router calls this factory to get an AgentSession, and
// the agent uses `channel_send` to reply. If `channelRouter` is missing here
// the agent has no `channel_send` tool and cannot reply — silently. That was
// the bug this factory exists to prevent. The shape of these options must
// stay aligned with createSessionForCron in src/run/index.ts; both are
// "channel-aware" sessions that need the same full plumbing.
export function buildChannelSessionFactory(deps: BuildChannelSessionFactoryDeps): CreateSessionForChannel {
  const createSession = deps.createSession ?? defaultCreateSession
  const logger = deps.logger ?? consoleLogger
  return async ({ existingSessionId, existingSessionFile, origin, originRef }) => {
    const sessionDir = deps.sessionFactory.sessionDir()
    const sessionManager =
      existingSessionId !== undefined
        ? tryReopenOrCreate(
            deps.cwd,
            sessionDir,
            existingSessionId,
            existingSessionFile,
            deps.rehydrateCapOptions,
            logger,
          )
        : SessionManager.create(deps.cwd, sessionDir)

    const snap = deps.pluginRuntime.get()
    const session = await createSession({
      reloadRegistry: deps.reloadRegistry,
      sessionManager,
      stream: deps.stream,
      channelRouter: deps.getChannelRouter(),
      ...(deps.mcpManager !== undefined ? { mcpManager: deps.mcpManager } : {}),
      origin,
      originRef,
      ...(snap.hasAnyPluginContent
        ? {
            plugins: {
              registry: snap.registry,
              hooks: snap.hooks,
              sessionId: sessionManager.getSessionId(),
              agentDir: deps.cwd,
            },
          }
        : {}),
      ...(deps.containerName !== undefined ? { containerName: deps.containerName } : {}),
      ...(deps.runtimeVersion !== undefined ? { runtimeVersion: deps.runtimeVersion } : {}),
      ...(deps.permissions !== undefined ? { permissions: deps.permissions } : {}),
      ...(deps.reloadRoles !== undefined ? { reloadRoles: deps.reloadRoles } : {}),
      ...(deps.liveSubagentRegistry !== undefined ? { liveSubagentRegistry: deps.liveSubagentRegistry } : {}),
      ...(deps.subagentRegistry !== undefined ? { subagentRegistry: deps.subagentRegistry } : {}),
      ...(deps.getCreateSessionForSubagent !== undefined
        ? { createSessionForSubagent: deps.getCreateSessionForSubagent() }
        : {}),
    })

    const sessionId = sessionManager.getSessionId()
    deps.liveSessionRegistry?.register({ sessionId, session })

    return {
      session,
      sessionId,
      dispose: async () => {
        deps.liveSessionRegistry?.unregister(sessionId)
        session.dispose()
      },
      ...(snap.hasAnyPluginContent ? { hooks: snap.hooks } : {}),
      getTranscriptPath: () => sessionManager.getSessionFile(),
    }
  }
}

// Reopen the persisted session manager when possible so the agent picks up
// where it left off. We use the persisted basename (sessionFile) directly
// because pi-coding-agent prefixes filenames with an ISO timestamp at write
// time that is not derivable from sessionId alone. Failure to reopen
// (corruption, missing file, schema drift, or v2 mapping with no sessionFile)
// falls back to a fresh session — matching the router's existing best-effort
// durability for channel sessions.
function tryReopenOrCreate(
  cwd: string,
  sessionDir: string,
  existingSessionId: string,
  existingSessionFile: string | undefined,
  capOptions: CapOptions | null,
  logger: FactoryLogger,
): SessionManager {
  if (existingSessionFile === undefined) {
    logger.warn(
      `[channels] session ${existingSessionId} has no sessionFile (v2 mapping not yet migrated); creating new`,
    )
    return SessionManager.create(cwd, sessionDir)
  }
  if (!isValidSessionFileBasename(existingSessionFile)) {
    logger.warn(
      `[channels] session ${existingSessionId} has invalid sessionFile (${JSON.stringify(existingSessionFile)}); creating new`,
    )
    return SessionManager.create(cwd, sessionDir)
  }
  const path = `${sessionDir}/${existingSessionFile}`
  if (capOptions !== null) {
    try {
      const stats = capJsonlFileInPlace(path, capOptions)
      if (stats.entriesMutated > 0) {
        logger.info(
          `[channels] rehydrate-cap ${existingSessionFile}: entriesMutated=${stats.entriesMutated} imagesReplaced=${stats.imagesReplaced} textsTruncated=${stats.textsTruncated} bytesElided=${stats.bytesElided}`,
        )
      }
    } catch (err) {
      // Capping is best-effort: if the rewrite fails, fall through to the
      // regular open path so the session still rehydrates uncapped rather
      // than being killed by a transient FS error.
      const reason = err instanceof Error ? err.message : String(err)
      logger.warn(`[channels] rehydrate-cap failed for ${existingSessionFile}: ${reason}; continuing with open`)
    }
  }
  try {
    return SessionManager.open(path)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logger.warn(
      `[channels] could not rehydrate session ${existingSessionId} from ${existingSessionFile}: ${reason}; creating new`,
    )
    return SessionManager.create(cwd, sessionDir)
  }
}
