import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createAgentSession,
  createCodingTools,
  DefaultResourceLoader,
  defineTool as definePiTool,
  SessionManager,
} from '@mariozechner/pi-coding-agent'
import type { AgentSession, ToolDefinition } from '@mariozechner/pi-coding-agent'

import { loadMemory } from '@/bundled-plugins/memory/load-memory'
import type { ChannelRouter } from '@/channels/router'
import { getConfig, resolveModel, resolveProfile } from '@/config'
import { defaultThinkingLevelForRef, providerForModelRef, type KnownModelRef } from '@/config/providers'
import { renderMcpCatalog } from '@/mcp/catalog'
import type { McpManager } from '@/mcp/manager'
import { createMcpDispatcherTools, MCP_DISPATCHER_TOOL_NAMES } from '@/mcp/tools'
import type { PermissionService, RolesConfig } from '@/permissions'
import type {
  BuiltinToolRef,
  HookBus,
  MaterializedSkills,
  PluginRegistry,
  RegisteredTool as PluginRegisteredTool,
  Tool as PluginTool,
} from '@/plugin'
import { materializeSkills } from '@/plugin'
import type { ReloadRegistry } from '@/reload'
import type { Stream } from '@/stream'

import { getAuthFor } from './auth'
import { createCompactionSettingsManager } from './compaction'
import { renderGitNudge } from './git-nudge'
import type { LiveSubagentRegistry } from './live-subagents'
import { applyModelRuntimeOverrides } from './model-overrides'
import { createChannelLookAtTool, lookAtTool } from './multimodal'
import {
  buildBuiltinPiToolOverrides,
  resolveBuiltinToolRefs,
  wrapPluginTool,
  wrapSystemAgentTool,
  wrapSystemTool,
  zodToToolParameters,
} from './plugin-tools'
import { createReloadTool } from './reload-tool'
import type { RestartHandoffOrigin } from './restart-handoff'
import { loadSelf } from './self'
import { SESSION_META_CUSTOM_TYPE, sessionMetaPayload } from './session-meta'
import { renderSessionOrigin, type SessionOrigin, type SessionRoleContext } from './session-origin'
import type { CreateSessionForSubagent, SubagentRegistry } from './subagents'
import { DEFAULT_SYSTEM_PROMPT, renderRuntimeBlock, SLIM_SYSTEM_PROMPT } from './system-prompt'
import { attachToolNotFoundNudge } from './tool-not-found-nudge'
import {
  createBudgetState,
  type ToolResultBudget,
  wrapAgentToolWithBudget,
  wrapToolDefinitionWithBudget,
} from './tool-result-budget'
import { createChannelFetchAttachmentTool } from './tools/channel-fetch-attachment'
import { createChannelHistoryTool } from './tools/channel-history'
import { createChannelReactTool } from './tools/channel-react'
import { createChannelReplyTool } from './tools/channel-reply'
import { createChannelSendTool } from './tools/channel-send'
import { createGrantRoleTool } from './tools/grant-role'
import { createPostGithubReviewTool } from './tools/post-github-review'
import { createRestartTool } from './tools/restart'
import { createSkipResponseTool } from './tools/skip-response'
import { createSpawnSubagentTool } from './tools/spawn-subagent'
import { createStreamSnapshotTool } from './tools/stream-snapshot'
import { createSubagentCancelTool } from './tools/subagent-cancel'
import { createSubagentOutputTool } from './tools/subagent-output'
import { createTodoTools } from './tools/todo'
import { webfetchTool } from './tools/webfetch'
import { websearchTool } from './tools/websearch'

export type { SessionOrigin } from './session-origin'

export type { AgentSession }

export { renderTurnRoleAnchor, renderTurnTimeAnchor } from './system-prompt'

type AgentSessionTools = NonNullable<Parameters<typeof createAgentSession>[0]>['tools']

// pi's default active built-in tools when a session declares no `tools:` filter
// (pi `createAgentSession` falls back to `defaultActiveToolNames`, which is the
// name set of `codingTools`). Derived from pi's own `createCodingTools()` rather
// than hardcoded so the list can't silently drift if pi adds/removes/renames a
// default builtin; `default-pi-builtins match pi's coding tool set` pins it.
const DEFAULT_PI_BUILTIN_TOOL_NAMES = createCodingTools(process.cwd()).map((t) => t.name)

export type PluginSessionWiring = {
  registry: PluginRegistry
  hooks: HookBus
  sessionId: string
  agentDir: string
}

export type PluginSubagentSelection = {
  pluginName: string
  toolRefs?: BuiltinToolRef[]
  customTools?: PluginTool<any>[]
  toolNamePrefix: string
}

// Mutable holder for the live session origin. Pass this when the origin
// must be updated turn-by-turn after session creation (channel sessions
// whose `lastInboundAuthorId` changes with each inbound message). Tool
// wrappers read `.current` at execute time, not at wrap time, so the
// `tool.before` event carries the per-turn actor identity rather than the
// stale session-creation snapshot. Sessions that never mutate origin
// (TUI, cron, subagent) can omit it and pass `origin` instead.
export type SessionOriginRef = { current: SessionOrigin | undefined }

export type CreateSessionOptions = {
  reloadRegistry?: ReloadRegistry
  sessionManager?: SessionManager
  stream?: Stream
  channelRouter?: ChannelRouter
  mcpManager?: McpManager
  // Bypass the file-based resource loader (IDENTITY.md, SOUL.md, MEMORY.md,
  // memory/, bundled skills) and use this string verbatim as the system prompt.
  systemPromptOverride?: string
  // Identifies the kind of session and (for channels) its addressing fields.
  // Rendered into the system prompt so the agent knows who's listening, where
  // its output goes, and what to pass to channel_send.
  origin?: SessionOrigin
  // Live origin holder. When provided, the tool wrappers read this at execute
  // time so `tool.before` events see the current-turn origin. Caller is
  // responsible for keeping `.current` up to date. If both `origin` and
  // `originRef` are passed, the ref wins for tool stamping; the static
  // `origin` still drives the initial system-prompt rendering and channel
  // tool addressing (those are only valid at session-creation time).
  originRef?: SessionOriginRef
  tools?: AgentSessionTools
  customTools?: ToolDefinition[]
  plugins?: PluginSessionWiring
  // When set, only the named plugin subagent's own tools are exposed; the
  // wider plugin registry's tools are NOT injected. Used by plugin subagent
  // session creation so subagents see exactly what they declared.
  pluginSubagent?: PluginSubagentSelection
  // Enables the `restart` tool. Set when the agent is running inside a
  // typeclaw-managed container. Read from TYPECLAW_CONTAINER_NAME at the call site.
  containerName?: string
  // The typeclaw runtime version (`package.json#version` of the executing
  // CLI) to surface in the system prompt under `## Runtime`. Threaded from
  // `startAgent` via `CLI_VERSION` so every session — TUI, channel, cron,
  // plugin subagent — sees the same value. Omitted in stand-alone test
  // callers, in which case the runtime block is skipped (no token cost, no
  // misleading "unknown" value).
  runtimeVersion?: string
  // The permission service the runtime resolved at boot. When provided, the
  // resolved role and permission list for `options.origin` are rendered into
  // the system prompt under `## Your role in this session`. The block is
  // emitted for channel/cron/subagent sessions, and for TUI sessions only
  // when the resolved role is not the built-in `owner` (because TUI
  // resolving to `owner` is the common case and we save tokens on every
  // interactive session). Omitting `permissions` falls back to the previous
  // behavior (no role annotation), which is what tests and stand-alone
  // callers want.
  //
  // The role rendered here is a session-creation snapshot. Channel sessions
  // re-resolve per-turn through `originRef` for tool gating, but the system
  // prompt is not regenerated; see `typeclaw-permissions` skill for how the
  // agent should interpret the snapshot on later turns.
  permissions?: PermissionService
  // Re-reads roles from disk for the grant_role tool's hot-reload after a match
  // grant. Production threads a reload-then-read (reloadConfig + getConfig);
  // must not be an in-memory snapshot or the grant reapplies stale roles.
  // Omitted when no grant_role tool is wired (the tool requires permissions).
  reloadRoles?: () => RolesConfig | undefined
  // Model profile name. Resolved against `config.models` to pick the concrete
  // model ref this session binds to. Unknown profile names fall back to
  // `default` with a one-time console warning. Omitted → `default`. Threaded
  // through from the caller (subagent declarations, future per-spawn tool
  // overrides) so different sessions on the same agent can run different
  // models without per-session config edits.
  profile?: string
  // Override the resolved ref directly, bypassing `profile` resolution. Used
  // by the model-fallback helper (`promptWithFallback`) to recreate a session
  // pinned to the next ref in the chain after the previous one failed. When
  // set, `profile` is still recorded for the fallback-warning bookkeeping;
  // the profile→refs resolution is skipped.
  refOverride?: KnownModelRef
  // Defensive ceiling on cumulative bytes of tool-result text per session,
  // applied to the named tools only. See `src/agent/tool-result-budget.ts`
  // for the rationale. Intended for subagents that read large files
  // (memory-logger, dreaming); leaving this undefined disables the budget
  // entirely, which is the right default for TUI / channel / plugin-tool
  // sessions where the human (or hooks) bound tool-result size.
  toolResultBudget?: ToolResultBudget
  // Optional override for the message returned to the agent once
  // `toolResultBudget` is exhausted. Subagents whose recovery path differs
  // from the default ("advance the watermark from a recent id you have
  // already seen") provide their own here. See `ToolResultBudget` for the
  // shared shape.
  toolResultBudgetMessage?: ToolResultBudget['exhaustedMessage']
  // Orchestration wiring. When all three of `liveSubagentRegistry`,
  // `subagentRegistry`, and `createSessionForSubagent` are present (AND
  // `pluginSubagent` is unset), the session exposes the spawn_subagent,
  // subagent_output, and subagent_cancel tools. Subagent-origin sessions
  // get an empty tool set via the `pluginSubagent` branch; the gate here
  // (omitting these for subagent sessions) is what prevents recursive
  // spawning.
  liveSubagentRegistry?: LiveSubagentRegistry
  subagentRegistry?: SubagentRegistry
  createSessionForSubagent?: CreateSessionForSubagent
}

export type CreateSessionResult = {
  session: AgentSession
  dispose: () => Promise<void>
}

export async function createSession(options: CreateSessionOptions = {}): Promise<AgentSession> {
  const { session } = await createSessionWithDispose(options)
  return session
}

export async function createSessionWithDispose(options: CreateSessionOptions = {}): Promise<CreateSessionResult> {
  const resolved = resolveProfile(getConfig().models, options.profile)
  // Unknown profiles silently fall back to `default`. The fallback is by design
  // (see `resolveProfile`) and surfacing a warning here just creates noise on
  // every memory-logger / dreaming subagent spawn for advanced users who know
  // exactly what they're doing.
  // `refOverride` lets the model-fallback helper pin a specific entry from
  // the chain when it recreates a session after the previous ref failed.
  const activeRef: KnownModelRef = options.refOverride ?? resolved.ref
  const { authStorage, modelRegistry } = getAuthFor(providerForModelRef(activeRef))

  const materializedSkills =
    options.plugins && options.plugins.registry.skills.length > 0
      ? await materializeSkills(
          options.plugins.registry.skills.map((s) => ({
            pluginName: s.pluginName,
            localName: s.localName,
            skill: s.skill,
          })),
        )
      : null

  const resourceLoader =
    options.systemPromptOverride !== undefined
      ? await createOverrideResourceLoader(
          options.systemPromptOverride,
          options.origin,
          options.permissions,
          options.runtimeVersion,
        )
      : await createResourceLoader({
          ...(options.plugins ? { plugins: options.plugins, materializedSkills } : {}),
          ...(options.origin ? { origin: options.origin } : {}),
          ...(options.permissions ? { permissions: options.permissions } : {}),
          ...(options.runtimeVersion !== undefined ? { runtimeVersion: options.runtimeVersion } : {}),
          ...(options.mcpManager !== undefined ? { mcpManager: options.mcpManager } : {}),
        })

  const getOrigin: () => SessionOrigin | undefined =
    options.originRef !== undefined ? () => options.originRef!.current : () => options.origin

  // Holds the session's signal-only abort once `createAgentSession` resolves.
  // Tools are wrapped BEFORE the session exists, so the loop guard reaches the
  // abort through this lazily-resolved getter. See `fireLoopAbort` in
  // plugin-tools.ts for why aborting (not throwing) is what stops the loop.
  const abortHolder: { abort?: () => void } = {}
  const getAbort: () => (() => void) | undefined = () => abortHolder.abort

  // Subagent built-in tool refs are dual-routed (see BUILTIN_TOOL_DEFINITION
  // dual-map in plugin-tools.ts): pi-side coding tools go to `tools:` so they
  // become the strict base set, typeclaw-side web tools go to `customTools:`.
  // The two `tools:` fields below (effective `options.tools` and the resolved
  // subagent pi-side builtins) are mutually exclusive — `options.tools` is only
  // passed by non-subagent callers like multimodal look-at; subagent sessions
  // never set both.
  const resolvedSubagentBuiltins = options.pluginSubagent?.toolRefs
    ? resolveBuiltinToolRefs(options.pluginSubagent.toolRefs)
    : { agentTools: [], toolDefinitions: [] }
  const pluginCustomTools = options.pluginSubagent
    ? wrapSubagentCustomTools(options.pluginSubagent, options.plugins, getOrigin, getAbort)
    : wrapRegistryTools(options.plugins, getOrigin, getAbort)

  // Per-run budget state for the tool-result byte ceiling. Allocated once per
  // session creation and threaded into every wrapped tool so they share the
  // same counter. Only used when the session declares a budget; the wrappers
  // pass non-listed tools through unchanged, so the counter stays at zero for
  // sessions without a budget configured.
  const sessionBudget: ToolResultBudget | undefined = options.toolResultBudget
    ? options.toolResultBudgetMessage !== undefined
      ? { ...options.toolResultBudget, exhaustedMessage: options.toolResultBudgetMessage }
      : options.toolResultBudget
    : undefined
  const sessionBudgetState = sessionBudget ? createBudgetState() : undefined

  const effectiveTools =
    options.tools ?? (options.pluginSubagent ? (resolvedSubagentBuiltins.agentTools as AgentSessionTools) : undefined)
  const hookWrappedTools = wrapSystemAgentTools(effectiveTools, options.plugins, getOrigin, getAbort)
  const tools =
    sessionBudget && sessionBudgetState && hookWrappedTools
      ? (hookWrappedTools.map((t) =>
          wrapAgentToolWithBudget(t, sessionBudget, sessionBudgetState),
        ) as typeof hookWrappedTools)
      : hookWrappedTools

  // Hoisted above tool construction so the restart tool can be wired with the
  // session's stable identity (sessionManager.getSessionId()). Subscribers use
  // that ID to distinguish the originating session from siblings on the
  // container-restarting broadcast.
  const sessionManager = options.sessionManager ?? SessionManager.inMemory()

  // Stamp a one-shot custom entry naming the session's origin kind so
  // `typeclaw usage` can bucket tokens by tui/cron/channel/subagent. Pi's
  // `appendCustomEntry` is the blessed extension point: the entry persists
  // into the session JSONL alongside messages, does NOT participate in LLM
  // context, and pi handles file-creation timing — the entry lands after the
  // session header on first flush, so `SessionManager.open()` keeps reading
  // a canonical session file. Skipped for reopened sessions (a prior stamp
  // is already in `getEntries()`) so usage attribution stays stable across
  // restarts. Also skipped when origin is unknown (inMemory subagents) or
  // when the manager is not persisted.
  if (options.origin !== undefined && sessionManager.getSessionFile() !== undefined) {
    const alreadyStamped = sessionManager
      .getEntries()
      .some((e) => e.type === 'custom' && e.customType === SESSION_META_CUSTOM_TYPE)
    if (!alreadyStamped) {
      sessionManager.appendCustomEntry(SESSION_META_CUSTOM_TYPE, sessionMetaPayload(options.origin))
    }
  }

  const customSystemTools =
    options.customTools !== undefined
      ? options.customTools
      : options.pluginSubagent
        ? resolvedSubagentBuiltins.toolDefinitions
        : [
            websearchTool,
            webfetchTool,
            lookAtTool,
            ...(options.mcpManager ? buildMcpDispatcherToolDefinitions(options.mcpManager) : []),
            ...(options.reloadRegistry ? [createReloadTool({ registry: options.reloadRegistry })] : []),
            ...(options.stream ? [createStreamSnapshotTool({ stream: options.stream })] : []),
            ...buildChannelTools(options.channelRouter, options.origin, sessionManager.getSessionId()),
            ...(options.containerName
              ? [
                  createRestartTool({
                    containerName: options.containerName,
                    originatingSessionId: sessionManager.getSessionId(),
                    ...(options.stream ? { stream: options.stream } : {}),
                    ...buildRestartHandoffWiring(options, sessionManager),
                  }),
                ]
              : []),
            ...buildSubagentOrchestrationTools({
              liveRegistry: options.liveSubagentRegistry,
              registry: options.subagentRegistry,
              createSessionForSubagent: options.createSessionForSubagent,
              agentDir: options.plugins?.agentDir,
              parentSessionId: sessionManager.getSessionId(),
              getOrigin,
              permissions: options.permissions,
              stream: options.stream,
            }),
            ...buildRoleGrantTools({
              agentDir: options.plugins?.agentDir,
              getOrigin,
              permissions: options.permissions,
              reloadRoles: options.reloadRoles,
            }),
            ...buildTodoTools(options.plugins?.agentDir, getOrigin),
          ]
  // Hook coverage for pi's builtin coding tools (read/bash/edit/write/grep/
  // find/ls) — pi 0.67.3 ignores `tools:` for implementation, so the only
  // way to interpose typeclaw guards is to ship same-named ToolDefinition
  // entries through `customTools`. Skipped when there are no tool hooks,
  // since wrapping reduces to a passthrough in that case.
  const builtinPiToolOverrides =
    options.plugins && hasToolHooks(options.plugins)
      ? buildBuiltinPiToolOverrides({
          agentDir: options.plugins.agentDir,
          sessionId: options.plugins.sessionId,
          hooks: options.plugins.hooks,
          getOrigin,
          getAbort,
          ...(options.permissions ? { permissions: options.permissions } : {}),
        })
      : []
  const wrappedCustomSystemTools = wrapSystemTools(customSystemTools, options.plugins, getOrigin, getAbort)
  const customToolsPreBudget = [...wrappedCustomSystemTools, ...pluginCustomTools, ...builtinPiToolOverrides]
  const customTools =
    sessionBudget && sessionBudgetState
      ? customToolsPreBudget.map((t) => wrapToolDefinitionWithBudget(t, sessionBudget, sessionBudgetState))
      : customToolsPreBudget

  const model = applyModelRuntimeOverrides(resolveModel(activeRef), activeRef)
  const thinkingLevel = defaultThinkingLevelForRef(activeRef)
  const { session } = await createAgentSession({
    model,
    sessionManager,
    settingsManager: createCompactionSettingsManager(model),
    authStorage,
    modelRegistry,
    resourceLoader,
    ...(tools ? { tools } : {}),
    customTools,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  })

  abortHolder.abort = () => {
    if (session.agent.signal?.aborted !== true) session.agent.abort()
  }

  // The names the session actually exposes to the model: pi's active base set
  // (the caller's `tools:` filter, or pi's default builtins when unset) union
  // the typeclaw/plugin custom tools. Deliberately EXCLUDES
  // `builtinPiToolOverrides` — those replace builtin implementations by name,
  // they are not additional callable names. This is the single source of truth
  // for both the active-set re-narrowing below and the tool-not-found nudge
  // vocabulary, so the two never drift (a divergence would make the nudge miss
  // real tools or suggest tools the session deliberately did not expose).
  const intendedActiveToolNames = [
    ...new Set([
      ...(tools !== undefined ? tools.map((t) => t.name) : DEFAULT_PI_BUILTIN_TOOL_NAMES),
      ...[...wrappedCustomSystemTools, ...pluginCustomTools].map((t) => t.name),
    ]),
  ]

  // Re-narrow the active tool set after `createAgentSession`. pi 0.67.3's
  // `_refreshToolRegistry` runs with `includeAllExtensionTools: true` and
  // pushes every customTool name into the active set, which would widen
  // a subagent's declared `[edit]` to all 7 builtin overrides plus every
  // typeclaw custom tool.
  if (builtinPiToolOverrides.length > 0) {
    session.setActiveToolsByName(intendedActiveToolNames)
  }

  const unsubRestart = subscribeRestartNotice(options.stream, sessionManager)

  const unsubToolNudge = attachToolNotFoundNudge(session, intendedActiveToolNames)

  const dispose = async () => {
    unsubRestart?.()
    unsubToolNudge()
    if (materializedSkills) await materializedSkills.dispose()
  }
  return { session, dispose }
}

// Decides whether the restart tool should write the cross-restart handoff
// file (`<agentDir>/.typeclaw/restart-pending.json`) and supplies the agentDir
// + session file path + origin metadata it needs to do so. Returns an empty
// object — meaning "no handoff" — for cron/subagent/system origins (no
// attended session the next boot could resume) and for in-memory sessions
// (no file to reopen).
//
// TUI and channel origins both resume: a TUI restart reattaches to the
// reconnecting client (websocket open handler), a channel restart reopens the
// originating chat session on the channel router's boot path. The `origin`
// discriminator in the handoff is what routes the next boot to the correct
// subsystem.
export function buildRestartHandoffWiring(
  options: { origin?: SessionOrigin; plugins?: { agentDir: string } },
  sessionManager: SessionManager,
): { agentDir?: string; originatingSessionFile?: string; handoffOrigin?: RestartHandoffOrigin } {
  const origin = options.origin
  if (origin === undefined) return {}
  const handoffOrigin = restartHandoffOriginFor(origin)
  if (handoffOrigin === null) return {}
  const agentDir = options.plugins?.agentDir
  const sessionFile = sessionManager.getSessionFile()
  if (agentDir === undefined || sessionFile === undefined) return {}
  return { agentDir, originatingSessionFile: sessionFile, handoffOrigin }
}

function restartHandoffOriginFor(origin: SessionOrigin): RestartHandoffOrigin | null {
  if (origin.kind === 'tui') return { kind: 'tui' }
  if (origin.kind === 'channel') {
    return {
      kind: 'channel',
      key: { adapter: origin.adapter, workspace: origin.workspace, chat: origin.chat, thread: origin.thread },
    }
  }
  return null
}

// Subscribes the given session to the in-process broadcast that the `restart`
// tool fires on a successful hostd ACK. The subscriber dispatches by identity:
// the session whose tool execution fired the restart (originator) gets a
// `typeclaw.restart-self` notice instructing the model to proactively confirm
// restart completion in its very next reply. All other sessions (siblings) get
// the `typeclaw.restart` notice instructing them not to mention the restart
// unless directly asked. Two distinct customTypes let downstream consumers
// distinguish the cases unambiguously. display:false keeps either entry out of
// any TUI rendering that might inspect the JSONL later. Exported so unit tests
// can verify the wiring without going through createAgentSession (which needs
// auth and model registry); the composition test at the bottom of this
// module's test file covers originator + siblings end to end.
export function subscribeRestartNotice(
  stream: Stream | undefined,
  sessionManager: SessionManager,
): (() => void) | null {
  if (!stream) return null
  const unsub = stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
    const payload = msg.payload as { kind?: unknown; restartedAt?: unknown; originatingSessionId?: unknown } | null
    if (!payload || payload.kind !== 'container-restarting') return
    if (typeof payload.restartedAt !== 'string') return
    if (typeof payload.originatingSessionId !== 'string') return
    if (payload.originatingSessionId === sessionManager.getSessionId()) {
      sessionManager.appendCustomMessageEntry(
        'typeclaw.restart-self',
        formatRestartNoticeOriginating(payload.restartedAt),
        false,
      )
    } else {
      sessionManager.appendCustomMessageEntry('typeclaw.restart', formatRestartNotice(payload.restartedAt), false)
    }
  })
  return unsub
}

// Convention documented in src/channels/router.ts:996-1013: runtime-injected
// content in the user turn must use the `**[SYSTEM MESSAGE — not from a human]**`
// framing fenced by `---`, plus an explicit "do not acknowledge or reply"
// line. Without it, persona-rich models read the heading as a human-authored
// instruction and reply to it on the next unrelated message.
export function formatRestartNotice(restartedAt: string): string {
  return [
    '---',
    '**[SYSTEM MESSAGE — not from a human]**',
    '',
    `The TypeClaw container was restarted at ${restartedAt}. The previous session`,
    'state was preserved on disk and you have been resumed inside a new container',
    'process. **Do not acknowledge or reply to this notice unless a human directly',
    'asks whether the restart happened.**',
    '',
    'Guidance:',
    '- If a human asks whether you actually restarted, you may confirm: yes, you',
    `  did restart at ${restartedAt}.`,
    '- Otherwise, continue the conversation normally.',
    '',
    '---',
    '',
  ].join('\n')
}

// Variant for the session that called the `restart` tool. The user explicitly
// asked this conversation to restart; staying silent after the reboot is the
// reported bug ("뭐야 너네 재시작 한 것도 모르냐"). This notice instructs the
// model to acknowledge restart completion in its very next reply — once — then
// stop mentioning it. Same SYSTEM MESSAGE framing as the sibling notice so
// persona-rich models don't reply to the framing itself.
export function formatRestartNoticeOriginating(restartedAt: string): string {
  return [
    '---',
    '**[SYSTEM MESSAGE — not from a human]**',
    '',
    `The TypeClaw container was restarted at ${restartedAt} at the user's explicit`,
    'request via the `restart` tool. The restart completed successfully and you',
    'have been resumed inside a new container process with your previous',
    'conversation memory intact.',
    '',
    '**Your very next reply must briefly confirm the restart completed** (e.g.',
    '"restart finished, I\'m back" — or in whatever voice fits your persona),',
    "even if the user's next message is about something unrelated. After that",
    "single confirmation, address whatever the user's next message says, and do",
    'not mention the restart again unless the user explicitly asks about it.',
    '',
    '---',
    '',
  ].join('\n')
}

// Builds the channel tool subset: channel_send (always when a router is
// available), plus channel_reply + channel_history + skip_response (only
// when the session origin is a channel — those rely on origin-bound
// addressing or per-session turn state). Extracted from
// createSessionWithDispose so composition can be unit-tested without
// going through createAgentSession / auth.
//
// `sessionId` is required for `skip_response` (the tool addresses the
// LiveSession by id when stamping the skip flag) and optional otherwise.
// Callers that don't have it (e.g. early composition tests) get the
// pre-skip-response tool set, which is forward-compatible — the prompt
// guidance still mentions the NO_REPLY fallback for those cases.
export function buildChannelTools(
  channelRouter: ChannelRouter | undefined,
  origin: SessionOrigin | undefined,
  sessionId?: string,
): ToolDefinition[] {
  if (!channelRouter) return []
  const tools: ToolDefinition[] = []
  if (origin?.kind === 'channel') {
    const channelOrigin = {
      adapter: origin.adapter,
      workspace: origin.workspace,
      chat: origin.chat,
      thread: origin.thread,
    }
    tools.push(createChannelReplyTool({ router: channelRouter, origin: channelOrigin }))
    if (origin.adapter === 'github') {
      tools.push(createPostGithubReviewTool({ router: channelRouter, origin: channelOrigin }))
    }
    tools.push(createChannelHistoryTool({ router: channelRouter, origin: channelOrigin }))
    tools.push(createChannelSendTool({ router: channelRouter, origin: channelOrigin }))
    tools.push(
      createChannelReactTool({
        router: channelRouter,
        origin: { ...channelOrigin, ...(origin.reactionRef !== undefined ? { reactionRef: origin.reactionRef } : {}) },
      }),
    )
    tools.push(
      createChannelFetchAttachmentTool({
        router: channelRouter,
        origin: channelOrigin,
      }),
    )
    tools.push(createChannelLookAtTool(channelRouter, channelOrigin))
    if (sessionId !== undefined) {
      tools.push(createSkipResponseTool({ router: channelRouter, sessionId }))
    }
  } else {
    tools.push(createChannelSendTool({ router: channelRouter }))
  }
  return tools
}

export function buildMcpDispatcherToolDefinitions(manager: McpManager): ToolDefinition[] {
  const tools = createMcpDispatcherTools(manager)
  return [
    defineMcpDispatcherTool(MCP_DISPATCHER_TOOL_NAMES[0], tools[0]),
    defineMcpDispatcherTool(MCP_DISPATCHER_TOOL_NAMES[1], tools[1]),
    defineMcpDispatcherTool(MCP_DISPATCHER_TOOL_NAMES[2], tools[2]),
  ]
}

function defineMcpDispatcherTool<P>(name: string, tool: PluginTool<P>): ToolDefinition {
  return definePiTool({
    name,
    label: name,
    description: tool.description,
    parameters: zodToToolParameters(tool.parameters),
    async execute(_toolCallId, params, signal) {
      const validated = tool.parameters.safeParse(params)
      if (!validated.success) {
        return {
          content: [{ type: 'text' as const, text: `invalid arguments: ${validated.error.message}` }],
          details: null,
        }
      }
      const result = await tool.execute(validated.data, {
        signal,
        sessionId: 'mcp-dispatcher',
        agentDir: process.cwd(),
        logger: { info() {}, warn() {}, error() {} },
      })
      return { content: result.content, details: result.details ?? null }
    },
  })
}

export function buildSubagentOrchestrationTools(opts: {
  liveRegistry: LiveSubagentRegistry | undefined
  registry: SubagentRegistry | undefined
  createSessionForSubagent: CreateSessionForSubagent | undefined
  agentDir: string | undefined
  parentSessionId: string
  getOrigin: () => SessionOrigin | undefined
  permissions: PermissionService | undefined
  stream: Stream | undefined
}): ToolDefinition[] {
  if (
    opts.liveRegistry === undefined ||
    opts.registry === undefined ||
    opts.createSessionForSubagent === undefined ||
    opts.agentDir === undefined
  ) {
    return []
  }
  return [
    createSpawnSubagentTool({
      registry: opts.registry,
      liveRegistry: opts.liveRegistry,
      createSessionForSubagent: opts.createSessionForSubagent,
      agentDir: opts.agentDir,
      parentSessionId: opts.parentSessionId,
      getOrigin: opts.getOrigin,
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
      ...(opts.stream ? { stream: opts.stream } : {}),
    }),
    createSubagentOutputTool({
      liveRegistry: opts.liveRegistry,
      getOrigin: opts.getOrigin,
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    }),
    createSubagentCancelTool({
      liveRegistry: opts.liveRegistry,
      getOrigin: opts.getOrigin,
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    }),
  ]
}

export function buildRoleGrantTools(opts: {
  agentDir: string | undefined
  getOrigin: () => SessionOrigin | undefined
  permissions: PermissionService | undefined
  reloadRoles: (() => RolesConfig | undefined) | undefined
}): ToolDefinition[] {
  if (opts.agentDir === undefined || opts.permissions === undefined || opts.reloadRoles === undefined) {
    return []
  }
  return [
    createGrantRoleTool({
      agentDir: opts.agentDir,
      getOrigin: opts.getOrigin,
      permissions: opts.permissions,
      reloadRoles: opts.reloadRoles,
    }),
  ]
}

export function buildTodoTools(
  agentDir: string | undefined,
  getOrigin: () => SessionOrigin | undefined,
): ToolDefinition[] {
  if (agentDir === undefined) return []
  return createTodoTools({ agentDir, getOrigin })
}

function wrapRegistryTools(
  plugins: PluginSessionWiring | undefined,
  getOrigin: () => SessionOrigin | undefined,
  getAbort: () => (() => void) | undefined,
): ToolDefinition[] {
  if (!plugins) return []
  return plugins.registry.tools.map((t: PluginRegisteredTool) =>
    wrapPluginTool(t.tool, {
      pluginName: t.pluginName,
      toolName: t.toolName,
      agentDir: plugins.agentDir,
      sessionId: plugins.sessionId,
      logger: t.logger,
      hooks: plugins.hooks,
      getOrigin,
      getAbort,
    }),
  )
}

function wrapSystemAgentTools(
  tools: AgentSessionTools | undefined,
  plugins: PluginSessionWiring | undefined,
  getOrigin: () => SessionOrigin | undefined,
  getAbort: () => (() => void) | undefined,
): AgentSessionTools | undefined {
  if (!tools || !hasToolHooks(plugins)) return tools
  return tools.map((tool) =>
    wrapSystemAgentTool(tool, {
      agentDir: plugins.agentDir,
      sessionId: plugins.sessionId,
      hooks: plugins.hooks,
      getOrigin,
      getAbort,
    }),
  )
}

function wrapSystemTools(
  tools: ToolDefinition[],
  plugins: PluginSessionWiring | undefined,
  getOrigin: () => SessionOrigin | undefined,
  getAbort: () => (() => void) | undefined,
): ToolDefinition[] {
  if (!hasToolHooks(plugins)) return tools
  return tools.map((tool) =>
    wrapSystemTool(tool, {
      agentDir: plugins.agentDir,
      sessionId: plugins.sessionId,
      hooks: plugins.hooks,
      getOrigin,
      getAbort,
    }),
  )
}

function hasToolHooks(plugins: PluginSessionWiring | undefined): plugins is PluginSessionWiring {
  if (!plugins) return false
  return plugins.hooks.count('tool.before') > 0 || plugins.hooks.count('tool.after') > 0
}

function wrapSubagentCustomTools(
  selection: PluginSubagentSelection,
  plugins: PluginSessionWiring | undefined,
  getOrigin: () => SessionOrigin | undefined,
  getAbort: () => (() => void) | undefined,
): ToolDefinition[] {
  if (!selection.customTools || !plugins) return []
  const logger = makePluginLogger(selection.pluginName)
  return selection.customTools.map((tool, i) =>
    wrapPluginTool(tool, {
      pluginName: selection.pluginName,
      toolName: `${selection.toolNamePrefix}_${i}`,
      agentDir: plugins.agentDir,
      sessionId: plugins.sessionId,
      logger,
      hooks: plugins.hooks,
      getOrigin,
      getAbort,
    }),
  )
}

function makePluginLogger(pluginName: string) {
  const prefix = `[plugin:${pluginName}]`
  return {
    info: (m: string) => console.log(`${prefix} ${m}`),
    warn: (m: string) => console.warn(`${prefix} ${m}`),
    error: (m: string) => console.error(`${prefix} ${m}`),
  }
}

export async function createOverrideResourceLoader(
  systemPrompt: string,
  origin?: SessionOrigin,
  permissions?: PermissionService,
  runtimeVersion?: string,
): Promise<DefaultResourceLoader> {
  const withRuntime =
    runtimeVersion !== undefined ? `${systemPrompt}\n\n${renderRuntimeBlock(runtimeVersion)}` : systemPrompt
  const finalPrompt = withOrigin(withRuntime, origin, permissions)
  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => finalPrompt,
    appendSystemPromptOverride: () => [],
  })
  await loader.reload()
  return loader
}

export type CreateResourceLoaderOptions = {
  agentDir?: string
  plugins?: PluginSessionWiring
  materializedSkills?: MaterializedSkills | null
  origin?: SessionOrigin
  mcpManager?: McpManager
  permissions?: PermissionService
  runtimeVersion?: string
  // Explicit override for the prompt mode. When omitted, the mode is derived
  // from `origin.kind`: cron + subagent → slim, tui + channel → full. Pass
  // 'full' to force the heavy prompt even on an unattended origin (rarely
  // useful; mostly an escape hatch for ad-hoc debugging).
  mode?: SystemPromptMode
}

// Origins where the operator-facing DEFAULT_SYSTEM_PROMPT, git-nudge, and the
// agent-folder commit guidance carry their weight: there is a human reading
// the output, the agent is expected to maintain its folder over time, and
// conversational register matters. For everything else (cron fires, default
// subagents), the slim prompt is the right default — the origin block already
// names the unattended context and tells the agent what's expected of it.
//
// Exhaustive switch (not a boolean expression) so a future origin kind forces
// the author to make an explicit full-or-slim decision at compile time. The
// previous form silently defaulted new origins to slim, which would have
// stripped the operator-facing prompt from a new interactive surface by
// accident.
export function deriveSystemPromptMode(origin: SessionOrigin | undefined): SystemPromptMode {
  if (origin === undefined) return 'full'
  switch (origin.kind) {
    case 'tui':
    case 'channel':
      return 'full'
    case 'cron':
    case 'subagent':
    case 'system':
      return 'slim'
    default: {
      const _exhaustive: never = origin
      void _exhaustive
      return 'full'
    }
  }
}

// Pure inputs for `composeSystemPrompt`. Each field maps 1:1 to a rendered
// section of the prompt; callers that don't want a section pass `undefined`
// (or `''` for `gitNudge`). Extracted so the debug dumper in
// `scripts/dump-system-prompt.ts` can reuse the exact same composition
// pipeline `createResourceLoader` uses, with no risk of drift if the
// section order changes.
//
// `mode` selects the base prompt:
//   - 'full' (default) — DEFAULT_SYSTEM_PROMPT (~2155 tok of operator-facing
//     guidance: agent folder layout, version-control rules, register matching,
//     workspace boundary). Right choice for TUI and channel sessions where a
//     human is reading the output and the agent maintains its folder.
//   - 'slim' — SLIM_SYSTEM_PROMPT (~80 tok). Right choice for cron jobs and
//     default subagents — unattended sessions where most of the operator
//     guidance is irrelevant and the origin block already covers per-kind
//     specifics (no human, side effects via tools, narrow scope).
export type SystemPromptMode = 'full' | 'slim'

export type SystemPromptComposition = {
  mode?: SystemPromptMode
  self: string
  runtimeVersion?: string
  origin?: SessionOrigin
  roleContext?: SessionRoleContext
  mcpCatalog?: string
  gitNudge: string
  memorySection: string
}

// Section-order contract for the system prompt. Kept as a pure string→string
// transform so it can be exercised without disk, plugin runtime, or auth.
//
// Cache-suffix ordering: least-volatile sections first, most-volatile last.
// This minimises the number of cached prompt bytes invalidated when a
// section changes (the provider's prompt cache hits up to the first byte
// that differs).
//
// 0. runtime block — most stable: only changes on typeclaw releases (rare).
// 1. origin block — stable across all sessions of the same kind.
// 2. gitNudge — rare changes; agent folders force-commit sessions/ and
//    memory/ after every turn, so the dirty-files list is empty most of
//    the time.
// 3. memorySection — volatile: MEMORY.md grows on every dream cycle and
//    memory/yyyy-MM-dd.md grows after every channel turn that triggers
//    memory-logger.
//
// The wall-clock anchor that used to live here as `## Now` moved out
// entirely. It is now injected into the user turn at each `session.prompt`
// site via `renderTurnTimeAnchor` (src/agent/system-prompt.ts) so the
// stamp reflects the moment of THIS turn, not session creation. Per-turn
// injection costs zero cached bytes — the user turn is the non-cacheable
// suffix anyway — and removes the staleness failure mode where a session
// opened Friday answered "today is Friday" on Thursday.
export function composeSystemPrompt(parts: SystemPromptComposition): string {
  const base = parts.mode === 'slim' ? SLIM_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT
  let prompt = `${base}\n\n${parts.self}`
  if (parts.runtimeVersion !== undefined) {
    prompt = `${prompt}\n\n${renderRuntimeBlock(parts.runtimeVersion)}`
  }
  if (parts.origin !== undefined) {
    prompt = `${prompt}\n\n${renderSessionOrigin(parts.origin, Date.now(), parts.roleContext)}`
  }
  if (parts.mcpCatalog !== undefined && parts.mcpCatalog !== '') {
    prompt = `${prompt}\n\n${parts.mcpCatalog}`
  }
  if (parts.gitNudge !== '') {
    prompt = `${prompt}\n\n${parts.gitNudge}`
  }
  if (parts.memorySection !== '') {
    prompt = `${prompt}\n\n${parts.memorySection}`
  }
  return prompt
}

export async function createResourceLoader(options: CreateResourceLoaderOptions = {}): Promise<DefaultResourceLoader> {
  const agentDir = options.agentDir ?? process.cwd()
  const mode: SystemPromptMode = options.mode ?? deriveSystemPromptMode(options.origin)
  const basePrompt = mode === 'slim' ? SLIM_SYSTEM_PROMPT : DEFAULT_SYSTEM_PROMPT

  // Kick off the three independent I/O paths concurrently. Sequential awaits
  // here used to be the dominant cold-start cost amplifier: loadSelf is 2
  // file reads, renderGitNudge spawns a subprocess, loadMemory reads N topic
  // shards. None of them depend on each other, so we run them in parallel.
  // The plugin hook (runSessionPrompt) only needs `self`, so it can overlap
  // with the gitNudge subprocess and the shard reads while `self` is in
  // flight too.
  //
  // Plugin-hook contract: `runSessionPrompt` runs AFTER gitNudge/memory I/O
  // has been kicked off. A hook that mutates `memory/topics/` or git-tracked
  // files during its body races those in-flight reads -- mutations may or
  // may not be reflected in the resulting prompt. The bundled hooks only
  // mutate the prompt string itself; third-party plugins that need to mutate
  // disk before the suffix sections see it must do so before/outside the
  // session-prompt hook.
  //
  // We wrap gitNudge and memory promises in `settled` shells so any
  // rejection from them cannot surface as an unhandled rejection during the
  // window where we're awaiting selfPromise + runSessionPrompt. Production
  // callers don't reject (renderGitNudge swallows internally, loadMemory
  // catches ENOENT) but a non-ENOENT fs error (EACCES/EIO) on the agent
  // folder would otherwise terminate the process before we reach the
  // gather point.
  const selfPromise = loadSelf(agentDir)
  const gitNudgeSettled = mode === 'slim' ? Promise.resolve(ok('')) : settle(renderGitNudge(agentDir))
  const memorySettled = settle(
    loadMemory(agentDir, {
      ...(options.origin !== undefined ? { origin: options.origin } : {}),
      ...(options.plugins?.sessionId !== undefined ? { currentSessionId: options.plugins.sessionId } : {}),
    }),
  )

  let self = await selfPromise

  if (options.plugins) {
    // The plugin hook receives the partially-assembled prompt (base + identity)
    // so plugins can rewrite either section before the cache-suffix blocks are
    // appended. The base reflects the resolved mode, so a slim cron session's
    // plugin hook sees the slim base — plugins that read the base text get
    // the same shape the agent will see.
    const preHook = `${basePrompt}\n\n${self}`
    const event = { prompt: preHook, sessionId: options.plugins.sessionId, agentDir, origin: options.origin }
    await options.plugins.hooks.runSessionPrompt(event)
    // Recover `self` by stripping the leading base so the rest of the
    // composition stays section-shaped. If a plugin rewrote the base prompt as
    // well, the recovered `self` carries the full mutated remainder.
    self = event.prompt.startsWith(`${basePrompt}\n\n`) ? event.prompt.slice(basePrompt.length + 2) : event.prompt
  }

  const roleContext = options.origin !== undefined ? resolveRoleContext(options.origin, options.permissions) : undefined
  // Slim mode skips git-nudge entirely: cron + subagent sessions are not the
  // right actor to drive interactive commit decisions, and the operator-facing
  // commit guidance the nudge points back to is itself excluded from the slim
  // base prompt. Memory is still included so cron jobs that depend on MEMORY.md
  // context (e.g. "send today's standup summary") keep working.
  const [gitNudgeResult, memoryResult] = await Promise.all([gitNudgeSettled, memorySettled])
  const gitNudge = unwrapSettled(gitNudgeResult)
  const memorySection = unwrapSettled(memoryResult)

  const systemPrompt = composeSystemPrompt({
    mode,
    self,
    ...(options.runtimeVersion !== undefined ? { runtimeVersion: options.runtimeVersion } : {}),
    ...(options.origin !== undefined ? { origin: options.origin } : {}),
    ...(roleContext !== undefined ? { roleContext } : {}),
    ...(mode === 'full' && options.mcpManager !== undefined
      ? { mcpCatalog: renderMcpCatalog(options.mcpManager.listServers()) }
      : {}),
    gitNudge,
    memorySection,
  })

  const additionalSkillPaths = [getBundledSkillsDir()]
  // pi-coding-agent's DefaultResourceLoader auto-discovers <agentDir>/skills/
  // but not <agentDir>/.agents/skills/. We do not scaffold <agentDir>/skills/
  // and the system prompt no longer advertises it — the only skill directories
  // a TypeClaw agent owns are .agents/skills/ (user-installed) and
  // memory/skills/ (dreaming-owned). Both are wired in explicitly below;
  // anything the upstream loader auto-discovers under <agentDir>/skills/ is
  // outside our supported surface.
  const userInstalledSkillsDir = join(agentDir, '.agents', 'skills')
  if (existsSync(userInstalledSkillsDir)) {
    additionalSkillPaths.push(userInstalledSkillsDir)
  }
  // Muscle-memory skills written by the dreaming subagent. Same auto-discover
  // story as `.agents/skills/` — the loader doesn't walk arbitrary subtrees of
  // the agent dir, so we wire this in explicitly. Existence-gated so a session
  // that has never dreamed doesn't pay for an empty path.
  const muscleMemorySkillsDir = join(agentDir, 'memory', 'skills')
  if (existsSync(muscleMemorySkillsDir)) {
    additionalSkillPaths.push(muscleMemorySkillsDir)
  }
  if (options.plugins) {
    for (const dir of options.plugins.registry.skillsDirs) {
      additionalSkillPaths.push(dir.path)
    }
  }
  if (options.materializedSkills) {
    additionalSkillPaths.push(options.materializedSkills.dir)
  }

  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    additionalSkillPaths,
  })
  await loader.reload()
  return loader
}

function withOrigin(
  systemPrompt: string,
  origin: SessionOrigin | undefined,
  permissions: PermissionService | undefined,
): string {
  if (!origin) return systemPrompt
  const roleContext = resolveRoleContext(origin, permissions)
  return `${systemPrompt}\n\n${renderSessionOrigin(origin, Date.now(), roleContext)}`
}

function resolveRoleContext(
  origin: SessionOrigin,
  permissions: PermissionService | undefined,
): SessionRoleContext | undefined {
  if (permissions === undefined) return undefined
  const described = permissions.describe(origin)
  // TUI resolves to `owner` because the built-in `owner.match = [tui]` is
  // walked first under severity-then-declaration ordering AND is always
  // appended (not replaced) by user-declared `roles.owner.match[]`. We skip
  // the role block in that case to save tokens on every interactive
  // session. The guard remains here as defense-in-depth in case a future
  // change ever makes TUI resolve to something other than owner.
  if (origin.kind === 'tui' && described.role === 'owner') return undefined
  return described
}

export function getBundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

function ok<T>(value: T): Settled<T> {
  return { ok: true, value }
}

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value): Settled<T> => ({ ok: true, value }),
    (error: unknown): Settled<T> => ({ ok: false, error }),
  )
}

function unwrapSettled<T>(result: Settled<T>): T {
  if (result.ok) return result.value
  throw result.error
}
