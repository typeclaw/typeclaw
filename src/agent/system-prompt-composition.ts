import {
  renderInteractiveSessionContext,
  renderSessionOrigin,
  type SessionOrigin,
  type SessionRoleContext,
} from './session-origin'
import {
  buildSystemPolicy,
  DEFAULT_SUBAGENT_ROSTER,
  renderRuntimeBlock,
  renderRuntimeNondisclosureRule,
} from './system-prompt'

// Origins with a conversation partner waiting on the reply get the full-mode
// session context: the interactive orchestration context with the live public
// roster, the MCP catalog, and the git nudge. Unattended origins (cron fires,
// default subagents, system processes) skip that context and the roster/git/MCP
// work it needs — their origin block already says what is expected. Every
// origin gets the same shared policy either way.
//
// Exhaustive switch (not a boolean expression) so a future origin kind forces
// the author to make an explicit full-or-slim decision at compile time. The
// previous form silently defaulted new origins to slim, which would have
// stripped the interactive context from a new interactive surface by
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
// `mode` selects only the optional session context, never the policy: every
// standard session starts with `buildSystemPolicy(branding)`.
//   - 'full' (default) — TUI, channel, and origin-less sessions: appends the
//     interactive context (`renderInteractiveSessionContext`) with the roster.
//   - 'slim' — cron, default subagents, system processes: no interactive
//     context; the origin block covers per-kind specifics (no human, side
//     effects via tools, narrow scope).
export type SystemPromptMode = 'full' | 'slim'

export type SystemPromptComposition = {
  mode?: SystemPromptMode
  // Whether the prompt discloses that the agent runs on TypeClaw. When false,
  // the policy's opening is phrased generically, the `## Runtime` version
  // block is dropped, and the runtime-disclosure rule is appended. Defaults to
  // true. Mirrors `config.branding`.
  branding?: boolean
  self: string
  // Pre-rendered interactive-context roster (from `renderPublicSubagentRoster`).
  // Kept as a ready string so this composer stays pure and registry-free; the
  // registry-aware caller renders it. Ignored in slim mode (no interactive
  // context). Falls back to `DEFAULT_SUBAGENT_ROSTER` when omitted.
  subagentRoster?: string
  runtimeVersion?: string
  origin?: SessionOrigin
  roleContext?: SessionRoleContext
  mcpCatalog?: string
  gitNudge: string
  proactiveNextStepNudge?: string
  evalHint?: string
}

// Section-order contract for the system prompt. Kept as a pure string→string
// transform so it can be exercised without disk, plugin runtime, or auth.
//
// Cache-suffix ordering: least-volatile sections first, most-volatile last.
// This minimises the number of cached prompt bytes invalidated when a
// section changes (the provider's prompt cache hits up to the first byte
// that differs).
//
// 0. shared policy — identical for every standard session of an agent.
// 1. self — IDENTITY.md + SOUL.md (plus any plugin `session.prompt` append).
// 2. runtime block (or the runtime-disclosure rule when branding is off) —
//    only changes on typeclaw releases.
// 3. interactive context (full mode) — stable per agent registry, so it
//    precedes the per-session origin block.
// 4. origin block + role — stable across sessions of the same kind; channel
//    origins carry per-conversation details.
// 5. MCP catalog — changes when servers connect or disconnect.
// 6. gitNudge — rare changes; agent folders force-commit sessions/ and
//    memory/ after every turn, so the dirty-files list is empty most of
//    the time.
// 7. proactive next-step nudge — deterministic per model family.
//
// The wall-clock anchor that used to live here as `## Now` moved out
// entirely. It is now injected into the user turn at each `session.prompt`
// site via `renderTurnTimeAnchor` (src/agent/system-prompt.ts) so the
// stamp reflects the moment of THIS turn, not session creation. Per-turn
// injection costs zero cached bytes — the user turn is the non-cacheable
// suffix anyway — and removes the staleness failure mode where a session
// opened Friday answered "today is Friday" on Thursday. Retrieved memory and
// the live channel role ride in the user turn for the same reason.
//
// pi appends project context (AGENTS.md), the skill catalog, and the cwd
// after this preamble when it builds the final system message.
export function composeSystemPrompt(parts: SystemPromptComposition): string {
  const branding = parts.branding ?? true
  let prompt = `${buildSystemPolicy(branding)}\n\n${parts.self}`
  if (branding && parts.runtimeVersion !== undefined) {
    prompt = `${prompt}\n\n${renderRuntimeBlock(parts.runtimeVersion)}`
  }
  if (!branding) {
    prompt = `${prompt}\n\n${renderRuntimeNondisclosureRule()}`
  }
  if (parts.mode !== 'slim') {
    prompt = `${prompt}\n\n${renderInteractiveSessionContext(parts.subagentRoster ?? DEFAULT_SUBAGENT_ROSTER)}`
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
  if (parts.proactiveNextStepNudge !== undefined && parts.proactiveNextStepNudge !== '') {
    prompt = `${prompt}\n\n${parts.proactiveNextStepNudge}`
  }
  if (parts.evalHint) prompt = `${prompt}\n\n${parts.evalHint}`
  return prompt
}
