import agentBrowserPlugin from '@/bundled-plugins/agent-browser'
import backupPlugin from '@/bundled-plugins/backup'
import bunHygienePlugin from '@/bundled-plugins/bun-hygiene'
import deepPlugin from '@/bundled-plugins/deep'
import docRenderPlugin from '@/bundled-plugins/doc-render'
import explorerPlugin from '@/bundled-plugins/explorer'
import githubCliAuthPlugin from '@/bundled-plugins/github-cli-auth'
import guardPlugin from '@/bundled-plugins/guard'
import memoryPlugin from '@/bundled-plugins/memory'
import operatorPlugin from '@/bundled-plugins/operator'
import plannerPlugin from '@/bundled-plugins/planner'
import researcherPlugin from '@/bundled-plugins/researcher'
import reviewerPlugin from '@/bundled-plugins/reviewer'
import scoutPlugin from '@/bundled-plugins/scout'
import securityPlugin from '@/bundled-plugins/security'
import toolResultCapPlugin from '@/bundled-plugins/tool-result-cap'
import type { ResolvedPlugin } from '@/plugin'

// Consumed by both `startAgent` (auto-loaded before user plugins) AND
// `scripts/generate-schema.ts` (each entry's `defined.configSchema` is merged
// into `typeclaw.schema.json` keyed by plugin name). Adding a bundled plugin
// here automatically extends the JSON schema; core `configSchema` does not
// need to know about plugin-owned blocks.
//
// Order matters: `security` is listed first because its `tool.before` hook
// must get first refusal on every tool call (HookBus runs hooks in
// registration order and short-circuits on the first `{ block: true }`).
// Letting `guard` run first would still work today since the two plugins
// guard disjoint surfaces, but seeding the order now means future overlap
// (e.g. a security policy on writes) blocks before guard's softer advice.
//
// `tool-result-cap` is registered before `guard` so guard's `tool.after`
// advice (uncommitted-changes warning) appends to already-capped content.
// Reversing this order would make guard advise on the full oversized payload
// and then tool-result-cap would clobber the advice text along with the rest.
//
// `bun-hygiene` is registered after `guard` and guards a disjoint surface
// (package-manager bash commands: global installs and non-bun managers), so its
// position relative to security/guard only matters for precedence — keeping it
// after the two general guards means a security/guard block always wins first.
//
// `github-cli-auth` is registered AFTER `security` so security's `tool.before`
// runs its exfil/secret scanners on the bash command first. github-cli-auth
// injects the minted token via an env overlay (TYPECLAW_INTERNAL_BASH_ENV), not
// by rewriting the command string, so the token never enters argv or logs — but
// ordering security first still matters so a blocked command never reaches the
// mint path at all.
//
// `memory` is registered before `backup` so memory's dreaming commits always
// land in the same git index window before backup's commit-and-push cycle.
// They commit disjoint paths today (memory/ vs sessions/ + agent changes),
// but if either ever holds .git/index.lock the deterministic order makes the
// contention easier to reason about.
export const BUNDLED_PLUGINS: ResolvedPlugin[] = [
  { name: 'security', version: undefined, source: '<bundled>', defined: securityPlugin },
  { name: 'tool-result-cap', version: undefined, source: '<bundled>', defined: toolResultCapPlugin },
  { name: 'guard', version: undefined, source: '<bundled>', defined: guardPlugin },
  { name: 'bun-hygiene', version: undefined, source: '<bundled>', defined: bunHygienePlugin },
  { name: 'github-cli-auth', version: undefined, source: '<bundled>', defined: githubCliAuthPlugin },
  { name: 'memory', version: undefined, source: '<bundled>', defined: memoryPlugin },
  { name: 'backup', version: undefined, source: '<bundled>', defined: backupPlugin },
  { name: 'agent-browser', version: undefined, source: '<bundled>', defined: agentBrowserPlugin },
  { name: 'doc-render', version: undefined, source: '<bundled>', defined: docRenderPlugin },
  { name: 'explorer', version: undefined, source: '<bundled>', defined: explorerPlugin },
  { name: 'scout', version: undefined, source: '<bundled>', defined: scoutPlugin },
  { name: 'reviewer', version: undefined, source: '<bundled>', defined: reviewerPlugin },
  { name: 'researcher', version: undefined, source: '<bundled>', defined: researcherPlugin },
  { name: 'planner', version: undefined, source: '<bundled>', defined: plannerPlugin },
  { name: 'operator', version: undefined, source: '<bundled>', defined: operatorPlugin },
  { name: 'deep', version: undefined, source: '<bundled>', defined: deepPlugin },
]
