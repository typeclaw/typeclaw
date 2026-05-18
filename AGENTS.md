# Agent Guidelines

## Default scope

If the user asks something, it's always about the typeclaw project itself until the user specifies another scope. Don't drift into upstream/downstream projects (agent-messenger, plugins consumed via npm, etc.) just because the conversation mentions them — answer in terms of typeclaw, and only switch scope when the user explicitly redirects you.

## Pre-commit checks

Before every commit, run all three of these and ensure they pass:

```sh
bun run typecheck
bun run lint
bun run format
```

No exceptions. If any of them fail, fix the cause before committing — do not `--no-verify`, do not stage partial fixes.

## Debugging the system prompt

`bun run debug:prompt` dumps the fully-rendered system prompt for one or every session-origin kind (`tui`, `cron`, `channel`, `subagent`), with `<PLACEHOLDER: …>` values substituted for every dynamic field (identity, memory, job-id, channel addressing, participants, role/permissions). Use it whenever you need to see what the agent actually sees without spinning up a container, hatching an agent folder, or digging into provider logs.

```sh
bun run debug:prompt                       # all 4 origins
bun run debug:prompt --origin cron         # just one
bun run debug:prompt --origin channel --no-git-nudge  # omit the dirty-files block
```

Each dump is prefixed with a per-section breakdown. Cron sessions render the **slim** base prompt instead of the full operator-facing manual; the subagent dump models the production override path (subagents always declare their own `systemPrompt`):

```
══════════════════════════════════════════════════════════════════════════════
  SYSTEM PROMPT — origin: cron — ~670 tok / 2679 chars / 2693 bytes (tok est. chars/4)
══════════════════════════════════════════════════════════════════════════════
  Section                           Tokens  Chars  Bytes
  ────────────────────────────────  ──────  ─────  ─────
  SLIM_SYSTEM_PROMPT (base)           ~245    972    980
  Identity (IDENTITY.md + SOUL.md)     ~88    352    356
  Runtime block                        ~13     50     50
  Session origin                       ~85    339    341
  Role context                        ~110    441    441
  Memory (MEMORY.md + streams)        ~129    515    517
  ────────────────────────────────  ──────  ─────  ─────
  TOTAL                               ~670   2679   2693
```

The slim base carries the load-bearing guidance that survives without a human watching: `.env` + `secrets.json` redaction, error/result honesty (never suppress, never fabricate), output discipline (don't narrate routine tool calls), and filesystem hygiene (the `workspace/` boundary, MEMORY.md ownership, runtime-managed paths). It deliberately does NOT carry "no human is watching" / "plain prose is invisible" — those are origin-block concerns. The "plain prose is invisible" claim in particular is actively wrong for subagents, whose plain text IS the deliverable to the parent session, so it must not leak into the shared slim base.

TUI and channel sessions get a slim-but-still-operator-facing `DEFAULT_SYSTEM_PROMPT` (~1300 tokens, down from ~2155 after the PR #219 rewrite). Trimming preserved every load-bearing phrase — `workspace/` boundary, MEMORY.md ownership, `.env`/`secrets.json` redaction, commit-before-done, SOUL voice, error honesty, and the "not pi/Claude/ChatGPT" closer — but cut decorative prose (the "your home, your memory, your record of who you are" framing) and redundant restatement (workspace boundary mentioned in three places, etc.). Test: see `src/agent/index.test.ts` "trimmed full prompt still carries every load-bearing phrase" — adding new load-bearing prose without updating that assertion will fail CI. Totals: TUI ~1590 tok, channel ~2341 tok. The git-nudge block is also skipped in slim mode because the operator-facing commit guidance it points back to is itself excluded from the slim base.

**Production subagent paths (memory-logger, dreaming, and every plugin-declared subagent) bypass the slim base entirely.** They are created with `systemPromptOverride: subagent.systemPrompt`, which routes through `createOverrideResourceLoader` and emits only `<override prompt> + runtime block + origin/role` — no DEFAULT/SLIM base, no IDENTITY/SOUL, no git-nudge, no memory. The debug dumper's `subagent` fixture mirrors this shape so the reported breakdown matches what the agent actually receives:

```
══════════════════════════════════════════════════════════════════════════════
  SYSTEM PROMPT — origin: subagent — ~276 tok / 1102 chars / 1104 bytes (tok est. chars/4)
══════════════════════════════════════════════════════════════════════════════
  Section                   Tokens  Chars  Bytes
  ────────────────────────  ──────  ─────  ─────
  Subagent override prompt     ~94    377    379
  Runtime block                ~13     50     50
  Session origin + role       ~168    671    671
  ────────────────────────  ──────  ─────  ─────
  TOTAL                       ~276   1102   1104
```

The slim mode is therefore a **defensive default** for any future subagent declared without a `systemPrompt`. Today's bundled subagents all declare one, so the slim path only fires for cron in production.

Tokens are estimated with a `chars/4` heuristic (industry rule-of-thumb, ~15% off, model-agnostic — explicit because exact tokenization differs across Claude/GPT/Gemini). Bytes are UTF-8 wire bytes and differ from chars on multi-byte content (em-dashes, curly quotes, emoji) — useful when you care about what actually leaves the host.

The script calls the same `composeSystemPrompt` helper (`src/agent/index.ts`) that `createResourceLoader` uses in production, and uses `deriveSystemPromptMode` to pick full vs slim from the origin kind — exactly the same derivation production uses — so the section order, base prompt, and presence/absence of git-nudge it prints all match what the agent actually sees at runtime. The cache-suffix contract (least-volatile first → identity → runtime → origin+role → git → memory) is enforced both by the helper and by a section-order assertion in `scripts/dump-system-prompt.test.ts` — reordering one without the other fails CI. The dumper has a separate `subagent` branch that renders the override path; without it the dump would lie about subagent costs.

`composeSystemPrompt` is the right entry point if you're adding a new section. Land the renderer (`renderXBlock`) in the appropriate `src/agent/*.ts` module, plumb it through `SystemPromptComposition`, decide its volatility tier (rare-change → earlier, per-turn-change → later) and whether it should render in slim mode (most don't), and `dump-system-prompt.ts` will surface it automatically once you add a fixture and a breakdown entry.

**Adding a new origin kind?** `deriveSystemPromptMode` (`src/agent/index.ts`) is an exhaustive `switch` on `origin.kind`, so a TypeScript compile error forces you to make an explicit full-or-slim decision. The two existing slim origins are `cron` and `subagent`; the two existing full origins are `tui` and `channel`. The asymmetry is load-bearing: the slim base drops ~1500 tokens of operator-facing guidance (agent-folder layout, version-control rules, register-matching prose) that is irrelevant when there's no human reading the output, and the origin block already names the unattended context. Restoring the full prompt for a new unattended kind would re-introduce the bloat the slim mode exists to remove.

**Open follow-up (PR #219 review)**: The slim prompt's MEMORY.md prohibition is currently prose-only. The guard plugin at `src/bundled-plugins/guard/policies/non-workspace-write.ts` explicitly permits writes to `MEMORY.md` (it's in `AGENT_ROOT_WRITE_ALLOWLIST`). A future hardening PR should add a `tool.before` guard policy that blocks non-dreaming `write`/`edit` to `MEMORY.md` with an exemption for the dreaming subagent (resolved via `event.origin.subagent === 'dreaming'`). Until that lands, the slim prompt's prose plus the lazy-loaded `typeclaw-memory` skill are the only protection against a cron job clobbering MEMORY.md.

## Release

Use the **Release** GitHub Actions workflow (`workflow_dispatch`, see `.github/workflows/release.yml`). It validates the input version, typechecks, lints, format-checks, runs the full test suite, bumps `package.json`, builds and pushes the multi-arch base image to `ghcr.io/typeclaw/typeclaw-base:X.Y.Z`, verifies the image is anonymously pullable on both `linux/amd64` and `linux/arm64`, publishes to npm with provenance, then commits the bump and creates a git tag + GitHub Release. Tags have no `v` prefix.

The workflow is the only supported release path. Do not `npm publish` from a local machine, do not push GHCR tags by hand, do not create release tags manually — the GHCR-first-then-npm ordering and the cross-platform pullability verification are load-bearing for the version-pin invariant documented in `## Stages` (the per-agent Dockerfile pins `typeclaw-base:X.Y.Z` to the installed typeclaw version, and a user who `npm install`s the version-to-be-published before its base image lands cannot `typeclaw start`).

### Version Decision

- If the user specifies an exact version (e.g., `1.5.0`), use it as-is.
  Otherwise, the agent decides the bump level based on the changes since the last release (never bump major unless the user explicitly asks):
  - **minor** — New features, new CLI subcommands, new plugin contract surface, breaking changes
  - **patch** — Bug fixes, refactors, docs, dependency updates, minor improvements
- Never ask the user which version to bump. Decide and proceed.
- `package.json` is the single source of truth for the version — there is no `.claude-plugin/plugin.json`, no skill `version:` frontmatter, no `README.md` version badge to sync. The workflow's `npm version` step is the only writer.

### Re-running after a partial failure

Every step in `release.yml` is idempotent against re-runs at the same input version:

- GHCR push overwrites the same `:X.Y.Z` tag with identical layers (no immutability policy as of 2026).
- `npm publish` is gated by `npm view typeclaw@X.Y.Z version` — already-published versions are skipped, not retried.
- `git tag -f` + `git push --force origin refs/tags/X.Y.Z` overwrites a local-only tag on a fresh runner without touching branches.
- `gh release create` is gated by `gh release view` — pre-existing releases are skipped.

If a release halts after `npm publish` succeeds (the cardinal irreversible step), re-running the workflow at the same version cleans up whatever didn't finish. If it halts before `npm publish`, the version is still free; pick the same number and re-run.

## Vocabulary

When the user says "channel" — or mentions tools/code with a `channel_` prefix (e.g. `channel_send`, `channel_reply`) — they almost always mean **`src/channels/`**, this repo's channels subsystem (router, manager, persistence, adapters for Slack/Discord, etc.), **not** Channel Talk (the customer-support SaaS), Slack channels in the abstract, or the agent-messenger CLI's `agent-channeltalk*` skills. Default to `src/channels/` and only branch out when the user explicitly names a different platform or product.

## Stages

TypeClaw runs code in three distinct stages. Each stage has a different filesystem, a different process owner, and a different invocation path. Confusing them is the single most common source of bugs in this codebase, so always name the stage explicitly when discussing any command, path, or mount.

### dev stage — this repo

Where you are when you run `bun test` or `bun run typecheck` on the typeclaw source tree. The `typeclaw` CLI is executed directly from `src/cli/index.ts` (no install step). There is no agent folder and no container — only the source code of typeclaw itself. Changes here affect how agents are scaffolded and how the CLI behaves, but never an agent's runtime state.

### host stage — the user's machine

Where an end user lives once they run `typeclaw init`. Their cwd is an agent folder (e.g. `~/coder/`), which holds `typeclaw.json`, `.env`, `package.json` with `typeclaw` as a dependency, markdown files, a truly-ignored `workspace/` (the agent's free-write zone), and `sessions/` + `memory/` — both gitignored at the agent's level but force-committed by TypeClaw itself (auto-backup for sessions, dreaming subagent for memory). Commands that run here are **launchers**, not the agent itself:

- `typeclaw start` — spawn the container (`docker run`) configured in `typeclaw.json`.
- `typeclaw stop` — stop it.
- `typeclaw restart` — `stop` then `start` with the same flags as `start`.
- `typeclaw logs [-f]` — show (or follow) the container's stdout/stderr via `docker logs --timestamps`, with each line reformatted to a local `YYYY-MM-DD HH:MM:SS` prefix for human readability. The same reformatter runs in `typeclaw compose logs` so the multi-agent view stays consistent.
- `typeclaw tui` — attach a TUI client over a websocket to a running agent.
- `typeclaw compose …` — orchestrate multiple agents across multiple agent folders.
- `typeclaw _hostd` — internal foreground process spawned detached by the first host-stage container launch on the host (`typeclaw init` hatching or `typeclaw start`). Long-lived; serves every typeclaw agent on the machine. Underscore-prefixed and hidden from `--help`. See `src/hostd/`. Hosts two capabilities today: the **port broker** (forwards container ports to localhost) and the **supervisor** (honors `restart` RPCs from inside the container).

Nothing in the host stage loads the agent runtime itself. Filesystem access is native (no mounts). Secrets live plainly in `.env` for later injection.

The host stage owns one persistent state directory: `~/.typeclaw/` (override with `TYPECLAW_HOME` for tests). It contains `run/hostd.{pid,sock,lock}` (singleton daemon coordination) and `log/hostd.log` (daemon stdout/stderr, append-only, no rotation). `src/hostd/paths.ts` is the only writer; nothing else in the host stage persists between CLI invocations.

### container stage — inside Docker

Where the actual agent process lives. The host stage bind-mounts the agent folder at `/agent` inside the container and starts a single process that foregrounds the agent loop:

- `typeclaw run` — the foreground process the container is configured to execute. Starts the websocket server (`src/server/`), creates an `AgentSession` (`src/agent/`), and speaks to the TUI or channels.

Inside the container, `FIREWORKS_API_KEY` and friends arrive through `--env-file .env`; the `typeclaw` binary itself is resolved through `node_modules/typeclaw` (which in dev-stage scaffolding is a symlink into the dev-stage repo — the host-stage launcher must mount that source at the same path the symlink expects).

### Rules of thumb

- **CLI command names encode stage.** `init` is host-only (it _creates_ the host stage). `start` / `stop` / `restart` / `log` / `tui` / `compose` are host-only launchers. `run` is container-only. Anything that reads `process.cwd()` implicitly assumes host stage unless it's called from `run`.
- **When writing paths, annotate the stage.** `./typeclaw.json` means the host-stage agent folder; `/agent/typeclaw.json` means the container stage. Never ship a string that silently conflates them.
- **The Dockerfile lives at the boundary.** `typeclaw init` (dev code running in host stage) writes a Dockerfile that `typeclaw start` (host stage) feeds to `docker run`, which then invokes `typeclaw run` (container stage) as the entrypoint.
- **TypeClaw owns the Dockerfile and `.gitignore`, and rewrites them on every `start` — not just on `init`.** The agent folder is treated as a managed workspace, not a one-time scaffold. `start` calls `refreshDockerfile` / `refreshGitignore` unconditionally so version drift between the CLI and the agent folder is corrected automatically. The `.gitignore` is then auto-committed if it changed; the Dockerfile is not (see next bullet). `refreshDockerfile` returns `{ changed: boolean }` by comparing rendered template bytes to disk; when `changed === true`, `start()` ORs that into `needsBuild` so the next `start` / `restart` rebuilds the image without `--build`. **Consequence: to ship a Dockerfile template change, edit `src/init/dockerfile.ts` and run `typeclaw start` (or `restart`) in any agent folder — `--build` is only needed to force a rebuild against an unchanged Dockerfile (e.g. cache-busting a base-image layer). Do not instruct users to delete their Dockerfile or re-run `init`.** The `wx` flag inside `writeDockerAssets` only governs the `init`-time write and is not the system's overwrite policy.
- **The `.gitignore` template (`src/init/gitignore.ts`) splits into two categories that look identical to the gitignore parser but are very different to the system.** _Truly-ignored_ entries (`.env`, `node_modules/`, `workspace/`, `mounts/`, `Dockerfile`, `.DS_Store`) never enter git history. _System-managed_ entries (`sessions/`, `memory/`) are gitignored so the agent doesn't stage them by hand, but TypeClaw force-commits them on its own schedule — `sessions/` via auto-backup, `memory/` via the dreaming subagent. Keep that visual split in `gitignore.ts`'s section comments; any doc that lumps the two categories together is wrong.
- **`Dockerfile` is in the truly-ignored category specifically because `start` regenerates it from the CLI template every run.** Tracking it would only produce noisy `Update Dockerfile` commits whenever `src/init/dockerfile.ts` changes, with zero new information — the source of truth is in this repo, not in the agent folder. Cloning an agent folder onto a fresh machine works because `start` writes the Dockerfile before `docker build` ever reads it. The implication is that an agent folder is only meaningful when paired with the typeclaw CLI; without it, you cannot reproduce the image from the folder alone.
- **The per-agent Dockerfile pins `ghcr.io/typeclaw/typeclaw-base:X.Y.Z` to the agent's installed typeclaw version.** `refreshDockerfile` reads `<agent>/node_modules/typeclaw/package.json#version` (the runtime the container will actually load) and writes that into the FROM line, falling back to the `dependencies.typeclaw` spec on fresh inits before `bun install`. `release.yml` ships the matching GHCR tag in the same job that publishes the npm version (image first, then npm publish), so the pin always resolves. The mapping is enforced by string equality, not heuristics. **Consequence: removing or republishing a `typeclaw-base:X.Y.Z` tag after release breaks every installed copy of `typeclaw@X.Y.Z` on rebuild. GHCR has no immutability flag — don't.**
- **Dev mode (typeclaw declared via `file:` or `link:` in the agent's package.json, or no exact-release spec) falls back to inlining the heavy stack on `oven/bun:1-slim`.** The version in a dev tree is the next-to-be-released one and the matching GHCR tag doesn't exist yet, so a pinned FROM would `docker pull` 404. `src/init/cli-version.ts` owns the install-vs-dev decision; `src/init/dockerfile.ts` owns the versioned vs inline branching. **Consequence: a new heavy-stack layer must land in BOTH `buildBaseDockerfile` (so the next release's base image carries it) AND the inline branch of `buildDockerfile` (so dev and tests see it without GHCR). The drift-guard tests in `dockerfile.test.ts` catch most slippage but aren't exhaustive — run `typeclaw start --build` in a dev agent folder before pushing.**
- **`refreshDockerfile` runs AFTER `ensureDeps` in `start()`.** The order is load-bearing: the version pin reads `node_modules/typeclaw/package.json#version`, which `bun install` populates. Reverting the order silently breaks the version-match invariant on the first start of a freshly-init'd agent (no node_modules → spec-based fallback → pins the spec range floor, not the actually-installed version).
- **`typeclaw.json` has two access patterns, one per stage.** `src/config/config.ts` exports both `config` (a module-import-time snapshot, the eager const consumed by host-stage CLI arg defaults) and `getConfig()` (the live pointer that the container stage updates on `reload`). Host-stage CLI processes are short-lived and use `config` directly. Container-stage runtime code (anything reachable from `typeclaw run` — `createSession`, internal cron job builders) MUST go through `getConfig()` so reloads take effect. Boot-only fields (`port`, `mounts`, `plugins`) are reported as `restart-required` by the reload diff because the values are captured at server start; reload returns success but the change won't apply until the container restarts. The fence is the `FIELD_EFFECTS` table in `src/config/config.ts`, and a guard test in `src/config/reloadable.test.ts` fails if a new schema field lacks a classification — keep both in sync when adding fields. Plugin-owned config blocks (e.g. `memory.*` for the bundled memory plugin) live under `typeclaw.json`'s catchall and are validated by the plugin at boot — `restart-required` since the plugin reads them once.
- **`validateConfig` is the single host-side gate, and it checks more than the schema.** Every host-side path that consumes `typeclaw.json` — `typeclaw start`, `typeclaw restart`, `typeclaw reload`, and hostd's `restart` RPC handler — runs through `validateConfig(cwd)` in `src/config/config.ts` before doing anything destructive (stopping a container, swapping the live config pointer, calling `docker run`). Beyond JSON+Zod parse, it walks `config.mounts` and runs `validateMount` on each: the host path must exist, be a directory, be readable, and (when `readOnly: false`) be writable. First-failure reporting matches the schema-error shape — fix one mount, re-run. Implication: do not auto-create or paper over missing host paths in `loadMounts` or `planStart`; that subverts the gate. If you add a new host-side caller of the config, route it through `validateConfig` rather than `loadConfigSync` directly so mount-accessibility errors surface uniformly. Permission checks no-op under `uid 0` because `accessSync` is vacuous as root — keep that branch when extending the check (e.g. for new mount kinds), or non-root and CI behavior will diverge.
- **`typeclaw.json#port` is the _preferred_ host port, not a guarantee.** `typeclaw start` allocates a free host port on every run: it tries the configured value (default `8973`) first via `net.createServer().listen(...)` and falls back to a kernel-assigned ephemeral port if it's bound. The container's internal port is fixed at `CONTAINER_PORT` (also `8973`, in `src/container/port.ts`), so the docker mapping is asymmetric: `-p ${hostPort}:${CONTAINER_PORT}`. Two consequences: (1) Docker is the runtime authority for "what host port is this agent on?" — `typeclaw tui` / `typeclaw reload` resolve their connect URL via `docker port <container> 8973/tcp`, falling back to `typeclaw.json#port` only when the container isn't running. (2) `typeclaw run` (container stage) MUST default `--port` to `CONTAINER_PORT`, never to `config.port`, otherwise the in-container Bun server would listen on a port the docker mapping doesn't forward. The `findFreePort → docker run → retry-on-bind-failure` flow lives in `src/container/start.ts`; `resolveHostPort` (in `src/container/port.ts`) is the discovery side.
- **Containers run WITHOUT `--rm`. This is load-bearing for debuggability.** The `runArgs` in `planStart` (`src/container/start.ts`) deliberately omit `--rm` so a crashed container's logs survive past exit. The user-visible bug this prevents: `typeclaw start` fails with "container stopped immediately after start" + "Could not read container logs: No such container" because Docker auto-removed the corpse before the verifier could read `docker logs`. Two compensating responsibilities pay for this: (1) `typeclaw stop` runs `docker stop` followed by `docker rm` so a clean stop leaves no trace (see `src/container/stop.ts`); (2) `start()`'s preflight force-removes any non-running container holding the name before `docker run --name <same>`, so the stale corpse from a previous crash or stop doesn't collide. The user-visible consequence on the happy path is zero (`typeclaw stop` still leaves nothing in `docker ps -a`); on the crash path, `typeclaw logs <name>` keeps working until the next `typeclaw start`. Do not "modernize" this back to `--rm`: the auto-removal race is exactly what made the original failure mode unrecoverable without manual `docker run --rm=false` reconstruction.

## Testing Philosophy

### 1. Test behavior, not implementation

A good test survives refactors of its subject's internals and fails only when **observable behavior** changes. Concretely: if you renamed a private helper or split a function in two and tests broke, the tests were coupled to implementation.

**Acceptance bar: the mutation check.**

After writing a test, ask: "If I comment out the line of production code this test is supposed to guard, does the test fail?" If not, the test verifies nothing meaningful.

Applied during review: when adding a new step to a pipeline (e.g. `writeDockerfile`), commenting out the wiring MUST break at least one test. Otherwise the test suite gives false confidence.

### 2. Test at the right layer

Code has layers. Tests must target the layer that owns the behavior being verified.

- **CLI / UI layer** — prompts, spinners, `process.exit`, argument parsing. Hard to test, and rarely worth testing. Keep thin.
- **Domain / pipeline layer** — the actual logic: composition of steps, data transformations, orchestration. **This is the primary test surface.**
- **Primitive layer** — individual file writes, shell invocations, pure functions. Unit-test for edge cases not easily covered by pipeline tests.

When you find yourself mocking `@clack/prompts` or stubbing `process.cwd` to test domain logic, that's a signal: the domain logic is in the wrong place. Extract it into a pure function and test it directly.

**Example in this codebase:** `src/init/index.ts` owns the `runInit` pipeline (scaffold → install → git). `src/cli/init.ts` is a thin shell that collects input via prompts, calls `runInit`, and renders progress via spinners. Pipeline tests target `runInit` directly — no CLI mocking needed.

### 3. Pipeline tests must verify composition, not just steps

For orchestrator functions that compose multiple sub-steps (pipelines, workflows, sagas):

- Unit tests on each sub-step are **necessary but not sufficient**.
- You also need tests that exercise the orchestrator end-to-end and assert on:
  - **Order of execution** (sequence of events / side-effect observable ordering)
  - **Data flow between steps** (step N sees the output of step N-1)
  - **Failure propagation** (fatal vs soft-fail semantics)

If a new step can be added, removed, or reordered without breaking a test, composition is untested.

**How to do it:** make the orchestrator emit observable events (progress callbacks, returned result structures, or async-iterator yields) and assert on the observed sequence.

### 4. One function, one concern

A function that both prompts the user AND runs business logic AND handles `process.exit` has three concerns and three reasons to change. Split them:

- The pure logic becomes testable without mocks.
- The I/O layer becomes small enough that manual review is sufficient.
- New steps get added to the pure layer and are caught by pipeline tests.

### 5. Test doubles sparingly

Every mock is a theory about how a collaborator behaves. Theories rot. Prefer:

1. **Real implementations with controlled inputs** — tmp directories, in-memory state, real subprocess calls when fast enough. This is the default in `src/init/index.test.ts`: real `bun install`, real `git`, real files in `mkdtemp` dirs.
2. **Hand-rolled fakes** when the real thing is genuinely unavailable or too slow.
3. **Mocking libraries** only as a last resort, and only at module boundaries.

If a test requires mocking `@clack/prompts` just to exercise logic, refactor. Don't mock.

### 6. When to skip testing

From the common coding rules: simple data classes, type-only files, auto-generated code, and trivial constants don't need tests. Use judgment — a test that only restates a literal is noise.

### 7. TDD is the default, not a ceremony

Write the failing test first when:

- Behavior is non-trivial
- Edge cases matter
- The API shape is unclear (tests force you to be a consumer)

Skip TDD for throwaway scripts or when the test setup outweighs the logic being tested. This is a tool, not a religion.

## File Layout

Domain logic lives in `src/<domain>/`. Examples: `src/init/`, `src/config/`, `src/server/`, `src/agent/`.

- `src/cli/` is **UI only** — citty commands, clack prompts, spinners, `process.exit`. Delegate to `src/<domain>/` for anything testable.
- Tests live next to code as `<file>.test.ts`.
- Domain entry points are `src/<domain>/index.ts`. Split into multiple files only when a single file gets complex.

## Skills

Skills are markdown files with a `name` + `description` frontmatter that the agent loads on demand via the `skill` tool. The agent's `DefaultResourceLoader` discovers skills from the following sources, each with a different owner and lifecycle:

| Source                 | Path                                                             | Owner             | When to add a skill here                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Bundled**            | `src/skills/<name>/SKILL.md`                                     | TypeClaw repo     | Cross-cutting agent guidance shipped with the CLI. Auto-discovered via `getBundledSkillsDir()` in `src/agent/index.ts`; **no wiring needed**, just create the directory and `SKILL.md`. Use the `typeclaw-` name prefix (it's the reserved namespace, see `src/bundled-plugins/memory/dreaming.ts:320`).                                                                       |
| **User-installed**     | `<agentDir>/.agents/skills/<name>/SKILL.md`                      | End user          | Personal skills the user drops into their agent folder. Existence-gated and wired in explicitly because the upstream loader doesn't auto-discover `.agents/skills/`.                                                                                                                                                                                                           |
| **Muscle memory**      | `<agentDir>/memory/skills/<name>/SKILL.md`                       | Dreaming subagent | Procedures the dreaming subagent distilled from repeated user interactions. Existence-gated; force-committed by the runtime. Don't write here from main-agent code.                                                                                                                                                                                                            |
| **Plugin-contributed** | Plugin package (filesystem dir) or in-memory via `PluginSkill[]` | Plugins           | Skills bundled inside a plugin. Two wirings, one source: filesystem dirs come in via `options.plugins.registry.skillsDirs`; in-memory skills come from `options.plugins.registry.skills` and pass through `materializeSkills` (`src/plugin/skills.ts`) which writes them to a tmpdir at session start. The agent sees both as ordinary skill directories — no API distinction. |

The wiring lives in `setupSession` in `src/agent/index.ts` (around line 366). When in doubt about which path a new skill belongs to, default to **bundled** (`src/skills/typeclaw-<name>/SKILL.md`) — that's where every skill shipped with the CLI lives.

> Footgun: `<agentDir>/skills/` (no `.agents/` prefix) is auto-discovered by the upstream `DefaultResourceLoader`, but TypeClaw does not scaffold it, document it, or advertise it in the system prompt. Treat it as outside the supported surface — don't put new skills there and don't rely on it in tests.

**Skill naming**:

- Bundled skills MUST use the `typeclaw-` prefix. The dreaming subagent treats this prefix as reserved (it refuses to write muscle-memory skills under it to avoid collisions; see `src/bundled-plugins/memory/dreaming.ts:320`).
- One-segment kebab-case: `typeclaw-channel-slack`, not `typeclaw/channel/slack` or `typeclaw-channel/slack`. The `materializeSkills` sanitizer enforces `^[a-z0-9][a-z0-9-_]*$` for plugin-contributed skills, and bundled skills follow the same convention by hand.

**Skill descriptions are triggers, not summaries.** The LLM picks which skill to load based on the description string in the available-skills list. Write descriptions that name the failure modes, the platform names, and the verbs that should activate the skill (e.g., `typeclaw-channel-slack`'s description names `**bold**`/`##`/`| table |` artifacts and the `slack-bot` adapter explicitly). A skill with a vague description is a skill the agent never reaches for — dead weight in the prompt budget.

**Skills are lazy by design.** Adding a skill costs zero tokens until the agent loads it. This is the right home for platform-specific guidance, large procedural runbooks, or knowledge that's only relevant in a subset of sessions. **Do not** copy that same guidance into tool descriptions to "make it more reliable" — tool descriptions reload into every tool-call prefix, which is exactly the cost model skills exist to avoid (production failure: commit `e2b08ab`, reverted in `ccb4669`, where embedded per-platform formatting hints were ignored by the LLM under chat-prose load _and_ paid the token tax on every channel turn).

## Secrets

`src/secrets/` owns TypeClaw's credential storage. Two on-disk files compose the surface:

- **`<agentDir>/.env`** — plain `KEY=value` lines. Loaded by Docker at container start via `--env-file`; injected into `process.env`. First-class source of truth for whatever the operator puts there. Gitignored.
- **`<agentDir>/secrets.json`** — the structured store. `v2` envelope managed by `SecretsBackend` (in `src/secrets/storage.ts`), which wraps `pi-coding-agent`'s `AuthStorage`. Gitignored. Two top-level slices:
  - `providers.<id>` — per-provider credentials. API-key shape: `{ type: 'api_key', key: <Secret> }`. OAuth shape: `{ type: 'oauth', access_token, refresh_token, expires_at, ... }` (catchall-passthrough for upstream-controlled fields).
  - `channels.<adapter>` — per-adapter credentials, keyed by named fields:
    - `discord-bot: { token: <Secret> }`
    - `slack-bot: { botToken: <Secret>, appToken: <Secret> }`
    - `telegram-bot: { token: <Secret> }`
    - `kakaotalk: { currentAccount: string | null, accounts: Record<accountId, KakaoAccountRecord> }` — structured multi-account block because KakaoTalk's auth is per-account (`oauth_token`, `refresh_token`, `device_uuid`, etc.). Two of those per-account fields are typeclaw-only renewal credentials that the SDK doesn't know about: `email` (the account's KakaoTalk login) and `encryptedPassword` (AES-256-GCM envelope produced by `src/secrets/encryption.ts`). They drive the host-side renewal cron — see `## Host daemon` below.

The schema is in `src/secrets/schema.ts` (`secretsFileSchema`). The bridge between TypeClaw's envelope and AuthStorage's flat `Record<provider, AuthCredential>` contract lives in `SecretsBackend.withLock` / `withLockAsync`. Channel adapters never read the envelope directly — `hydrateChannelEnvFromSecrets` (in `hydrate.ts`) injects resolved field values into `process.env[TOKEN_ENV]` at boot so `src/channels/manager.ts` keeps its existing env-based contract.

### The `Secret` shape

Every secret-bearing field is typed as `Secret = string | { value?: string, env?: string }`. The string form is shorthand for `{ value }`. The schema normalises both to the object form at parse time, so consumers only see `{ value?, env? }`.

```jsonc
{
  "version": 2,
  "providers": {
    "fireworks": { "type": "api_key", "key": "fw_xxx" }, // string shorthand
    "openai": { "type": "api_key", "key": { "value": "sk_xxx", "env": "MY_OPENAI" } }, // explicit env binding
  },
  "channels": {
    "slack-bot": {
      "botToken": { "value": "xoxb-..." }, // file-only
      "appToken": { "env": "CI_SLACK_APP_TOKEN" }, // env-only
    },
  },
}
```

The single env-vs-file precedence rule lives in `resolveSecret(secret, defaultEnv, env)` (in `src/secrets/resolve.ts`):

1. `process.env[secret.env]` — explicit binding wins.
2. `process.env[defaultEnv]` — canonical env-var-name fallback. Defaults come from `CHANNEL_FIELD_ENV` for channels and `KNOWN_PROVIDERS[id].apiKeyEnv` for providers (both centralised in `src/secrets/defaults.ts`).
3. `secret.value` — the on-disk value.
4. Otherwise the field is treated as missing.

### Env-wins, file-never-auto-mutated (the policy)

- For api-key providers in `src/agent/auth.ts`: when the canonical env var is set at boot, the value is layered in via `authStorage.setRuntimeApiKey(...)` (in-memory only, never goes through `withLock`). `hasAuth` reports true, `getApiKey` returns the env value, `secrets.json` stays untouched.
- For channel fields in `src/secrets/hydrate.ts`: existing `process.env[TOKEN_ENV]` is kept as-is; only when the env var is unset does hydrate inject the resolved Secret value into `process.env`. `.env` is never stripped, `secrets.json` is never rewritten.
- No auto-promotion. Previous versions ran `promoteChannelEnvIntoSecrets` at boot to copy `.env` channel tokens into `secrets.json#channels` and erase the `.env` lines. **That module is gone.** Env values stay where the user put them; the file stays user-owned.

### Bridge idempotency (the load-bearing invariant)

`SecretsBackend.withLock` diffs AuthStorage's returned flat slice against the prior on-disk envelope:

- **Provider unchanged** — preserve the on-disk Secret bytes verbatim (no flatten, no rewrap). This is the rule that prevents OAuth-refresh writes from accidentally persisting env-resolved api-key values into the file.
- **API-key value changed** — rewrap as Secret, preserving any prior `env` field the user authored.
- **Provider added** — write as string-value Secret.
- **Provider removed** — actually remove (do not resurrect).
- **Unknown `type` value** — pass through verbatim (forward-compat for upstream adding a third credential type).

OAuth credentials always pass through as flat strings — they're not env-injectable (refresh tokens are stateful). This is the single asymmetry between api-key and OAuth in the bridge.

### Versioning and migration

The envelope's `version` field is `2` on writes. Three legacy shapes are accepted on read and upgraded transparently:

1. **v1 envelope** (`{ version: 1, llm, channels: { adapter: { ENV_NAME: value } } }`) — `llm` → `providers`, env-var-keyed channel slots → field-name-keyed via `CHANNEL_ENV_TO_FIELD`.
2. **Pre-envelope flat shape** (`{ openai: { type, key }, ... }` at top level) — wrapped as v2 with the providers slice populated.
3. **Pre-rename file** (`auth.json` instead of `secrets.json`) — renamed by `migrateLegacyAuthJson` in `createSecretsStoreForAgent`.

All three are read-only legacy branches; the next write produces v2. The legacy parsers stay forever as quiet compat seams.

### KakaoTalk renewal fields (encryption-at-rest)

KakaoTalk sub-device tokens have a hard ~7-day TTL on Kakao's servers — both `access_token` AND `refresh_token` expire on the same cycle, so no inactivity keepalive or `renew_token.json` call solves it unattended (verified against OpenKakao's `status=-998` evidence). The renewal cron (in `## Host daemon` below) refreshes tokens by replaying `attemptLogin(email, password, device_uuid)` with the saved device_uuid (which lets KakaoTalk skip phone-passcode confirmation). To do that unattended, the per-account record needs `email` (plain) and `password` (encrypted).

The password is stored at `secrets.json#channels.kakaotalk.accounts.<id>.encryptedPassword` as an AES-256-GCM envelope `{ v: 1, alg: 'AES-256-GCM', kid, iv, ciphertext, authTag, createdAt }`. AAD is `typeclaw:kakaotalk-password:v1:<containerName>:<accountId>`, so a ciphertext copied across accounts or containers fails authentication on decrypt even if the same key happens to unlock both. The 32-byte symmetric key lives at `~/.typeclaw/keys/<containerName>.key` (file mode 0600, dir 0700), **outside** the agent folder so the typical leak scope (`git add` accident, agent-folder backup, shared mount) doesn't capture both ciphertext and key.

**Threat model (honest)**: this is defense-in-depth against agent-folder-only leaks. It does NOT protect against full host compromise (the OAuth tokens stored next to the encrypted blob in `secrets.json` already grant equivalent capability), nor against whole-home backups that capture both `~/.typeclaw/` and the agent folder. If `TYPECLAW_HOME` is overridden to a path inside the agent folder or a shared mount, the separation collapses entirely — set the env var responsibly.

The `getAccount()` accessor in `SecretsKakaoCredentialStore` strips `email`/`encryptedPassword` before returning (so the upstream SDK's `KakaoCredentialManager` never sees fields it doesn't know about). Renewal-aware callers use `getAccountWithRenewalFields()` to see the full record. The `mergeUpstreamAccount` bridge re-attaches these typeclaw-only fields from the prior on-disk record on every write, so SDK-driven token refreshes don't strip them.

### Rules of thumb

- **Adding a new adapter or provider with credentials** requires three coordinated edits, all in `src/secrets/defaults.ts` + `src/secrets/schema.ts`: (a) add the per-adapter field schema (or extend `KNOWN_PROVIDERS` for providers), (b) add the entry to `CHANNEL_FIELD_ENV` so `hydrateChannelEnvFromSecrets` can inject the resolved value, (c) extend `CHANNEL_ENV_TO_FIELD` if the v1 upgrade should rename legacy env-key entries. Forgetting (b) silently breaks injection at boot — `manager.ts` would never see the value in `process.env`.
- **Never write env-resolved values back to disk.** If you find yourself calling `authStorage.set(provider, { type: 'api_key', key: envValue })`, use `setRuntimeApiKey(provider, envValue)` instead. The first persists; the second is in-memory only. The whole env-wins policy depends on this distinction.
- **`pi-coding-agent`'s `AuthStorage.set` always writes through `withLock`.** Our bridge has to be ready for full-slice rewrites that include providers the caller didn't intend to change (OAuth refresh is the canonical example). The diff-and-preserve logic in `mergeProvidersIntoEnvelope` is what makes those writes safe; do not "simplify" it back to a wholesale replace.
- **`.env` and `secrets.json` are peers, not migration source and sink.** `typeclaw doctor` is the right place to surface "this secret resolves from env / file / nothing" — not a boot-time auto-migration.

## Permissions

`src/permissions/` is TypeClaw's per-actor access-control subsystem. Roles bundle permission strings **and** match rules. Actors are derived at runtime from `SessionOrigin`; nothing about an actor is stored on disk. Plugins and any future consumer query the service via `ctx.permissions.has(origin, perm)`. Two consumers are wired today: the security plugin (every guard call) and the channel router (the unconditional `channel.respond` wake-up gate — see wiring step 8).

### Mental model

- **Actor** — derived at runtime from `SessionOrigin`. Not stored.
- **Role** — named bundle of `permissions[]` + `match[]`. Static, declared under `typeclaw.json#roles`.
- **Permission** — namespaced string of the shape `<plugin>.<verb>.<noun>`. Plugins declare them on their `definePlugin({ permissions: [...] })`; consumers check by string.

Resolution walks roles in declaration order. For each role, every rule in `match[]` is tested against the origin. The first role with any matching rule wins. The fallback role is built-in `guest`, which has no permissions.

### Built-in roles (`src/permissions/builtins.ts`)

| Role      | Built-in `match[]` (prepended) | Built-in `permissions[]`                                                                                                           |
| --------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `owner`   | `[{ kind: 'tui' }]`            | `channel.respond`, `cron.schedule`, `cron.modify`, plus the union of all plugin-registered `security.bypass.*` (wildcard sentinel) |
| `trusted` | `[]`                           | `channel.respond`, `cron.schedule`, `security.bypass.secretExfilBash`                                                              |
| `member`  | `[]`                           | `channel.respond`                                                                                                                  |
| `guest`   | `[]`                           | (none)                                                                                                                             |

User-declared `match[]` **appends** to the built-in match list. User-declared `permissions[]` **replaces** the built-in list entirely — there is no merge, so `"permissions": []` means none. Custom (non-built-in) role names must declare both fields.

### Match-rule DSL (`src/permissions/match-rule.ts`)

Compact strings, parsed at boot. Examples:

```
tui
cron
subagent
subagent:memory-logger
*                                    # any channel session, any platform
slack:*                              # any Slack chat, any workspace
slack:T0123                          # one Slack workspace
slack:T0123/C0ABCDE                  # one specific Slack chat
slack:T0123 author:U_ME              # one author in one workspace
slack:dm/*                           # any Slack DM
discord:9999 author:U_MOD            # one Discord author across a guild
kakao:group/*                        # any KakaoTalk group chat
```

Within one rule, tokens are AND'd; across multiple `match[]` entries on the same role they're OR'd. The parser owns three concerns: (1) precise typo errors (`autor:` → "Did you mean 'author:'?"), (2) rejection of redundant or impossible forms (`slack:*/*`, `slack:*/C0ABCDE`, `slack:T0123/*`), (3) rejection-with-remediation for legacy `team:`/`guild:`/`tg:` prefixes from the removed `channels.<adapter>.allow[]` syntax — emits an error pointing at the canonical replacement (e.g. `legacy prefix 'team'; use 'slack' instead`). Strict equality on every field — no regex, no glob beyond the listed `*` shapes. The JSON Schema layer ships a permissive regex pattern (`MATCH_RULE_REGEX_SOURCE`) so editors flag obvious typos, but the zod parser owns the semantic checks. End-user configs never see these prefixes once `migrateLegacyConfigShape` runs — it rewrites them to canonical DSL before the parser fires.

### Cron and subagent provenance

`kind: 'cron'` and `kind: 'subagent'` sessions do **not** resolve via match-rule walking. They carry stamped provenance fields:

- **Cron**: `origin.scheduledByRole` (the role to run as) and `origin.scheduledByOrigin` (full parent `SessionOrigin` snapshot, for audit). The cron session's role is `scheduledByRole` directly.
- **Subagent**: `origin.spawnedByRole` + `origin.spawnedByOrigin`. Snapshot at spawn — the subagent carries its inherited role for its full lifetime; parent cleanup doesn't affect it.

This closes the laundering attack: an attacker session resolving to `guest` who asks the agent to schedule a cron gets `scheduledByRole: 'guest'` stamped into the persisted job. When the job fires, the cron session resolves to `guest` and the security plugin blocks `bash env` again. Hand-authored `cron.json` entries that omit `scheduledByRole` cause **boot failure** with a precise remediation message — there is no implicit-owner fallback.

### Wiring

1. **Config**: top-level `roles?` in `typeclaw.json`, parsed by `rolesConfigSchema`. **`roles` is restart-required** (FIELD_EFFECTS classification).
2. **Plugin registration**: `definePlugin({ permissions: [...] })` lists the permissions the plugin both checks and contributes. The runtime reads every plugin's `permissions[]` at boot, _before_ invoking any plugin factory, and uses the union to (a) expand `owner`'s security wildcard sentinel into concrete permission strings, (b) populate `LoadPluginsResult.declaredPermissions` for diagnostics, (c) drive the boot-time typo warning that flags any user-declared `permissions[]` string not in `CORE_PERMISSIONS ∪ pluginPermissions`.
3. **Plugin context**: `PluginContext.permissions: PermissionService` is constructed once at plugin load and lives for the plugin's lifetime. Reload of `roles` requires a restart.
4. **`ToolBeforeEvent.origin` carries the LIVE origin.** `CreateSessionOptions` accepts a mutable `originRef: { current: SessionOrigin | undefined }`; tool wrappers read it at execute time, not at wrap time. Channel sessions update the holder per-turn in `src/channels/router.ts` (right before `prompt()`) so the `tool.before` event carries the current-turn `lastInboundAuthorId` rather than the cold-start snapshot. Sessions without per-turn origin churn (TUI, cron, subagent) pass `origin` and the wrapper uses it directly. The DefaultResourceLoader still renders the session-creation origin into the system prompt; per-prompt regeneration of the system prompt is a v0.2 follow-up.
5. **Cron stamping**: `createSessionForCron` in `src/run/index.ts` reads `job.scheduledByRole` and `job.scheduledByOrigin` from the persisted `CronJob` record and copies them into the new cron session's origin. `parseCronFile` rejects any cron-job entry without `scheduledByRole` (precise boot-time error); the field is declared `optional()` on the zod schema only so internal plugin-contributed jobs can be constructed without it before being normalized via `toCronJob`, which stamps `scheduledByRole: 'owner'` as the default for plugin cron. Hand-authored `cron.json` entries that omit `scheduledByRole` are **auto-migrated** by `migrateLegacyCronShape` (in `src/cron/schema.ts`) at load time — `loadCron` stamps `scheduledByRole: "owner"` on any job missing the field, rewrites the file on disk, and (when in a git repo) commits the change with subject `cron.json: stamp scheduledByRole: "owner" on N legacy job(s)`. The migration exists specifically to unstick agents that booted into a crash-loop after PR #171 made the field mandatory; on canonical-shape files (post-migration or freshly authored) it is a no-op zero-cost path. `scheduledByOrigin` is persisted as opaque `z.unknown()` (SessionOrigin is recursive) and read back as the literal stored value; if a future writer corrupts it, role resolution falls through to `guest`.
6. **Subagent stamping**: the `new-session` stream target carries `parentSessionId`, `spawnedByRole`, and `spawnedByOriginJson` (a JSON-encoded snapshot of the parent origin, shape-validated on decode). `SubagentConsumer` parses these into `InvokeSubagentOptions.spawnedByRole` / `.spawnedByOrigin`, which flow into both `defaultCreateSessionForSubagent` and the plugin-aware path in `run/index.ts`. The cron consumer publishes the stream target with `spawnedByRole = job.scheduledByRole` so cron-spawned subagents inherit the cron's role (instead of falling to `guest`).
7. **Plugin `ctx.spawnSubagent`**: signature is `spawnSubagent(name, payload?, options?)`. Hook callers pass `options: { parentSessionId, spawnedByOrigin: event.origin }` so the spawn carries provenance. The runtime resolves `spawnedByRole` from `spawnedByOrigin` via the PermissionService rather than letting the caller forge a role string. Bundled plugins that act on the operator's behalf without a specific user session (e.g. backup-runner spawned from `setTimeout`) pass a TUI-shaped origin marker (`{ kind: 'tui', sessionId: 'backup-runner' }`) so they resolve to `owner`.
8. **Channel router (`channel.respond` gate)**: every inbound the router sees is gated by `permissions.has(partialOrigin, 'channel.respond')` BEFORE `ensureLive`. The partial origin is built from `(adapter, workspace, chat, thread, lastInboundAuthorId)` — there is no live session yet, so no `participants` / `membership` are passed. A denial logs `[channels] <key>: denied by permissions (channel.respond) author=<id> id=<msg>` and returns without creating a session, updating participants, or warming the membership cache. `CreateChannelRouterOptions.permissions` is optional at the type level (defaults to a permissive grant-all service for direct-router tests), but the production wiring in `src/run/index.ts` always forwards `pluginsLoaded.permissions` through `src/channels/manager.ts`. The legacy `channels.<adapter>.allow[]` field is gone — `migrateLegacyConfigShape` translates it into `roles.member.match[]` on load (see `## Config migration` rules below).

### Rules of thumb

- **Plugins must declare `permissions: [...]` on `definePlugin(...)`, not on `PluginExports`.** The declaration is read before the factory runs, so the owner-wildcard expansion is deterministic. `PluginExports` deliberately has no `permissions` field — the declaration is at the plugin's definition layer, not in its boot-time exports.
- **Never let users write `*` in their own `permissions[]`.** The owner wildcard is a sentinel (`OWNER_SECURITY_WILDCARD`) that lives inside the built-in `owner` spec only; user-declared `permissions[]` are taken literally. `permissionSchema` rejects strings that don't match the dotted `<plugin>.<verb>.<noun>` shape, which already prevents `*`.
- **A `scheduledByRole` or `spawnedByRole` that names a role nobody defined resolves to `guest`.** The service requires the named role to exist in the resolved role table. This forecloses an attacker forging a role string into a job record.
- **The recorder-vs-checker split inside the security plugin is load-bearing.** `recordGitRemoteTaintIfAny` runs unconditionally (gated only by "would the command actually run", i.e. ack or `bypassGitExfil`), independent of `checkGitExfilGuard`'s block decision. Collapsing them back into a single function silently disables the two-step taint defense for any actor holding `bypassGitExfil`.
- **Plugin-contributed cron jobs default to `scheduledByRole: 'owner'`.** They are part of the bundled (or operator-installed) runtime, not user-channel schedules. Without this default the bundled memory dreaming cron would resolve to `guest` and lose every security bypass it needs to write MEMORY.md, run git, etc. Hand-authored `cron.json` entries that omit `scheduledByRole` get the same `"owner"` default via `migrateLegacyCronShape` at `loadCron` time, with a one-shot rewrite + git commit. The migration only fills the field when **absent** — an explicit `"trusted"` or `"member"` value is preserved as-is, so the schema gate (`parseCronFile`) is the only place that classifies what's valid, and the migration is purely additive. Removing the migration call would re-strand any agent that hasn't yet been touched post-PR-#171.
- **Permissions gate _actions_, not _state_.** Memory (`MEMORY.md`, `memory/yyyy-MM-dd.md`), `workspace/`, and `sessions/` are shared across all origins; this subsystem does not isolate them. If state isolation matters, run separate agent folders.
- **Match-rule consumers operate on `MatchRule[]`, not strings.** The DSL is the file format; the typed union is the internal currency. Adding a new platform or qualifier is additive — extend the parser and the union together, old configs still parse. The JSON Schema emits a permissive regex pattern for editor-time shape validation; the parser owns the precise semantic errors (typo suggestions, redundant-form rejection) at boot.
- **No role coverage = silent agent.** The `channel.respond` gate is unconditional. If a deployed agent has no `roles` block (or the declared roles don't match the speaking authors), every inbound resolves to `guest`, which has no `channel.respond`, which means the router drops every message. The minimum config is to give a non-`owner` role match rule that covers the conversations the agent should answer (e.g. `"member": { "match": ["slack:T0123/C0GENERAL"] }`). TUI keeps working because `owner.match` always includes `{ kind: 'tui' }` with `channel.respond` granted. The denial log line names the author and the channel key, so a silent agent is diagnosable from logs.
- **`migrateLegacyConfigShape` lifts `channels.<adapter>.allow[]` into `roles.member.match[]` on load.** Legacy configs from before Phase 3 are auto-migrated: every legacy allow-rule (`team:T0123`, `guild:9999`, `tg:42`, `kakao:dm/*`, …) is translated to its canonical DSL form (`slack:T0123`, `discord:9999`, `telegram:42`, `kakao:dm/*`) and appended to `roles.member.match[]` (deduplicated, preserving declaration order). The `allow` field is stripped from each adapter block. The one lossy case is `channel:<id>` (workspace-less channel id) — the canonical DSL requires an explicit workspace coordinate, so the migration drops these rules with a warning that names the entry. Operators re-add them as `discord:<guild>/<id>` or `slack:<team>/<id>`. The migration is idempotent (running twice = same shape) and runs on every config load via `loadConfigSync` / `validateConfig`, so a stale on-disk file is auto-rewritten on the next `typeclaw start`.

## Host daemon (hostd)

`src/hostd/` is a **host-stage** subsystem that owns every host-side capability the running container needs — currently the **supervisor** (`src/hostd/supervisor.ts`, restart), the **port broker** (delegated to `src/portbroker/`, glued in via `src/hostd/portbroker-manager.ts`), and the **KakaoTalk renewal cron** (in `src/hostd/kakao-renewal-manager.ts`, host-side because the encryption key lives outside the agent folder per `## Secrets`). Architecturally: a **singleton daemon per host** (not per agent) — the only persistent host-side process in the codebase, and the only persistent host-stage state (`~/.typeclaw/`, including `~/.typeclaw/keys/<containerName>.key` per-agent renewal keys). New host-side capabilities should plug in as additional `src/hostd/<capability>.ts` glue + an `src/<capability>/` module that does the actual work, and an additional optional callback on `DaemonOptions`. **Don't add new daemons.**

### Why it exists

Two distinct cross-stage problems converge on the same shape (a long-lived host process the container talks to), so they share one daemon:

1. **Port forwarding (auto port-forward).** Docker fundamentally cannot publish new ports on a running container — `HostConfig.PortBindings` is create-time-only, and `docker update` does not cover networking. Worse, many dev servers (Vite without `--host`, Next.js dev, Rails, Django runserver, Node's `http.createServer` without an explicit host) bind to `127.0.0.1` _inside the container's netns_, which `docker run -p` cannot reach even if the port had been published up front (the publish path connects to the bridge IP, not loopback). The portbroker solves both: it userland-proxies LISTEN events from the container, with the **upstream side of every proxy connection running inside the container's typeclaw process**, where `Bun.connect('127.0.0.1', port)` reaches loopback-bound servers naturally.

2. **Container self-restart.** The container itself has no Docker access (no docker.sock mount, no `docker` CLI). When the agent updates the typeclaw CLI source or hits a `restart-required` config field, the only path back to a fresh container is through a host-stage process. The supervisor honors `restart` RPCs from inside the container (auth: scope by registered `containerName`) and runs `stop()` + `start()` from the daemon process.

### Process topology

```
host:
  typeclaw start (cwd=~/agentA)  ─┐  short-lived clients of the daemon.
  typeclaw start (cwd=~/agentB)   │  Each calls `ensureDaemon()` then
  typeclaw stop  (cwd=~/agentA)   │  `register`/`deregister` over
                                  ┘  ~/.typeclaw/run/hostd.sock.

  typeclaw _hostd (singleton)  ── reads/writes ~/.typeclaw/run/hostd.{pid,sock}
    ├─ supervisor (in-process)
    ├─ portbroker-manager (in-process)
    │     ├─ Broker(agentA) ── ws ──► ws://127.0.0.1:${hostPortA}/portbroker
    │     │     └─ Bun.listen(127.0.0.1, 5173) [forwarder per LISTEN port]
    │     └─ Broker(agentB) ── ws ──► ws://127.0.0.1:${hostPortB}/portbroker
    │           └─ Bun.listen(127.0.0.1, 3000) [...]
    └─ cwds:  { agentA → cwd, agentB → cwd }   (shared registry)

container (agentA):  typeclaw run
  ├─ TUI WS server on / (existing — TUI talks here)
  ├─ portbroker WS server on /portbroker (createContainerBroker)
  │     ├─ PortWatcher: poll /proc/net/tcp[6] every 500ms
  │     └─ RelayHandler: per relay-open, Bun.connect('127.0.0.1', port)
  │       ── reaches both 0.0.0.0- AND 127.0.0.1-bound dev servers
  └─ agent's `restart` tool ── HTTP host.docker.internal:8974 ──► supervisor
                                 (Bearer: TYPECLAW_HOSTD_TOKEN)
```

The daemon binary is `typeclaw _hostd` — a hidden CLI subcommand that runs the daemon foreground. The first host-stage container launch on the machine — either `typeclaw init`'s hatching step or a standalone `typeclaw start` — spawns it detached via `Bun.spawn` + `proc.unref()`, writes `~/.typeclaw/run/hostd.pid`, then connects and registers. The daemon-spawn path is gated on `cliEntry` being threaded into `start()` (see `src/container/start.ts:294-296`); host-stage CLI commands pass `process.argv[1]` so the daemon spawns, while test fixtures and programmatic callers that omit `cliEntry` get an unmanaged container. Subsequent `typeclaw start` calls connect, **probe the daemon's source-tree fingerprint via the `version` RPC, and only reuse the daemon when its fingerprint matches the CLI's on-disk source**. On mismatch, the CLI sends `shutdown`, waits for the socket file to disappear, and respawns a fresh daemon (the "PID-reuse safe" invariant is preserved because the kill path goes through the socket round-trip, never SIGTERM-by-pidfile). **This is the only place in the codebase that uses detached spawning** — keep it that way.

`typeclaw start` always registers with the daemon. The register payload now carries the `wsHostPort` (the freshly-allocated host port that maps to `CONTAINER_PORT`), the `portForward` policy from `typeclaw.json`, and a freshly-generated `brokerToken`. Hostd uses these to spawn a portbroker for the container in the same call. **Both supervisor and portbroker share the daemon's `cwds` map** — there is no second registry. When a container has `portForward.allow: []` (the off-switch), the broker is still constructed but immediately no-ops without opening any WS connection — see `brokerEnabled()` in `src/portbroker/policy.ts`.

`typeclaw stop` connects to the daemon over the Unix socket and sends `deregister`. The daemon stops the container's broker (closing every host-side `Bun.listen`) and removes the cwds entry. If the daemon isn't reachable, stop is a no-op for the broker side and just runs `docker stop`. **The CLI never sends signals based on PID** — pidfile content is a discovery hint, never a kill target. PID-reuse therefore cannot kill an unrelated user process.

A periodic GC tick in the daemon (every 30s) calls `containerExists()` for each registered container; missing → silently deregister and tear down its broker. Handles `docker stop` from outside typeclaw, host reboot survivors that registered with stale state, etc.

### Container ↔ host channels

Hostd talks to the container over **three channels**, each scoped to a specific use case:

1. **Host-side Unix socket on `~/.typeclaw/run/hostd.sock`** (CLI ↔ daemon, host-only). Newline-delimited JSON RPC — `register`, `deregister`, `list`, `status`, `version`, `shutdown`, and `http-info`. Used by `typeclaw start`, `typeclaw stop`, and `ensureDaemon()`. **Never bind-mounted into containers** — see channel 2 for why.

2. **HTTP control surface on `host.docker.internal:8974`** (container → daemon, container-initiated). Carries `restart` only. The daemon listens on a stable preferred port (`STABLE_HTTP_PORT = 8974`, adjacent to `CONTAINER_PORT = 8973` for mnemonics) so the container's cached `TYPECLAW_HOSTD_URL` env var stays valid across hostd respawns. On `EADDRINUSE` (another local service holds 8974), hostd falls back to an ephemeral port and emits `daemon-http-port-fallback` — fail-hard would brick the dev workflow on every port collision; the fallback degrades gracefully (only containers that started under the preferred port and outlived the respawn lose their URL). Auth: per-container `restartToken` (32 bytes, base64url) generated at `typeclaw start`, persisted to `~/.typeclaw/run/registrations/<name>.json`, and injected into the container as `TYPECLAW_HOSTD_TOKEN`. The token survives hostd respawn because hostd reloads every persisted registration on boot. **Why HTTP and not a bind-mounted Unix socket?** Both Docker Desktop and OrbStack on macOS share files via 9p/virtiofs, which lets you `stat` and read socket files but does NOT pass `connect()` calls through to the host's Unix socket — `connect()` returns ENOENT. The original May 1 design (commit 6d938f7) used a bind-mounted Unix socket and worked on Linux but silently broke on macOS. **Why `host.docker.internal` and not the bridge IP?** Same reason as the portbroker WS — Docker Desktop on macOS doesn't route the bridge subnet from the host.

3. **WebSocket on `ws://127.0.0.1:${hostPort}/portbroker`** (the same TCP port the TUI uses, via Docker's `-p` mapping). Hostd-initiated, long-lived, multiplexed. Carries the portbroker protocol (`port-listen-snapshot`, `port-listen-opened`, `relay-open`, `relay-data`, etc.). Auth: a `brokerToken` plumbed through `TYPECLAW_HOSTD_BROKER_TOKEN` env var; the container rejects any non-`broker-hello` first message and any `broker-hello` whose token doesn't match. The `brokerToken` is regenerated on every register and is therefore reset by hostd respawn — the broker reconnects automatically with the next register cycle.

The agent's container name is plumbed through the `TYPECLAW_CONTAINER_NAME` env var, set by `src/container/start.ts` on `docker run`. Inside the container, cwd is `/agent` and the host folder name is otherwise unrecoverable.

### Control protocol

Newline-delimited JSON over `~/.typeclaw/run/hostd.sock`. Connection-per-request — each client opens, sends one line, reads one line, closes.

```ts
type Request =
  | {
      kind: 'register'
      containerName: string
      cwd: string
      restartToken?: string
      // Portbroker fields — all three required to spawn the broker:
      wsHostPort?: number // Docker-published host port mapping CONTAINER_PORT
      portForward?: PortForward // { allow: '*' | number[]; deny?: number[] }
      brokerToken?: string // shared with the container via env var
    }
  | { kind: 'deregister'; containerName: string }
  | { kind: 'list' } // diagnostic
  | { kind: 'status'; containerName: string } // diagnostic
  | { kind: 'restart'; containerName: string } // container-initiated (Unix socket OR HTTP)
  | { kind: 'http-info' } // returns the daemon's HTTP control port
  | { kind: 'version' } // CLI-initiated drift probe
  | { kind: 'shutdown' } // CLI-initiated graceful exit (drift respawn)
type Response = { ok: true; result?: unknown } | { ok: false; reason: string }
```

`register` is idempotent at the cwds level but **always (re)spawns the broker** — useful on the start-time TOCTOU port-retry path, where the host port may change between register attempts. The full payload (containerName, cwd, restartToken, portbroker fields) is persisted atomically to `~/.typeclaw/run/registrations/<name>.json` (mode 0600) so it survives daemon respawn. On boot, hostd replays every registration file before opening the socket listener — repopulating `cwds`, `restartTokens`, and reviving portbrokers. `deregister` stops the broker, removes the cwds entry, AND unlinks the registration file. `list` is the cheap probe used by `isDaemonReachable()`. `restart` ACKs immediately and runs `stop()` + `start()` asynchronously — the synchronous ACK lets the calling container exit cleanly before the daemon issues `docker stop`. `version` returns the source-tree fingerprint the daemon captured at boot — used only by `ensureDaemon()` to detect drift between the running daemon and the CLI's on-disk source. `shutdown` ACKs first, then asynchronously stops all brokers, unlinks the socket, and exits — the ACK-then-execute pattern (same as `restart`) lets the calling CLI know the request was accepted before the listener disappears.

Adding a new request kind is a deliberate addition: extend both `Request` (in `src/hostd/protocol.ts`) and the switch in `daemon.ts`'s `dispatch`. Don't sneak through the catchall.

### Components and ownership

#### `src/hostd/` — daemon, supervisor, glue

- `src/hostd/daemon.ts` — singleton process. Owns `Map<containerName, cwd>` and `Map<containerName, restartToken>` registries, the Unix socket server, the HTTP control surface (preferred port 8974, falls back to ephemeral on EADDRINUSE), RPC dispatch, and the GC tick. Persists every register payload to `registrations/<name>.json` and replays them on boot before accepting any RPC, so drift-respawn doesn't lose the registry. Replaces stale socket file on startup. SIGTERM/SIGINT triggers an orderly shutdown (stop all brokers via the manager, close socket, unlink socket file, exit 0). Both `restart` and `portbroker.start` are honored only when the corresponding `DaemonOptions` callback is set — unit tests omit them and get clean "capability not enabled" rejections (or no-ops on register).
- `src/hostd/supervisor.ts` — restart capability. ACK-then-execute: `scheduleRestart` returns synchronously so the requesting container can exit before `docker stop` runs against it. Errors surface only via the log channel because there is no connected client to receive them by then. The actual `stop()` + `start()` invocation is plumbed in by `src/cli/hostd.ts` via the `DaemonOptions.restart` callback so the daemon module itself stays free of `@/container` imports.
- `src/hostd/portbroker-manager.ts` — glue between `daemon.ts` and `src/portbroker/`. Owns one `Broker` per registered container. On `start(input)` it creates a fresh `Broker` (stopping any pre-existing one — handles re-register on the start-time TOCTOU retry). The broker's `resolveHostPort` callback uses `resolveHostPort({ cwd })` from `@/container` so reconnect after container restart re-queries Docker for the (possibly new) published port. Same isolation pattern as supervisor: the daemon module never imports `@/container`.
- `src/hostd/kakao-renewal-manager.ts` — glue between `daemon.ts` and `src/secrets/kakao-renewal.ts`. Owns one per-container daily tick (24h `setInterval`). On `start(input)` it gates via `shouldRenew` (defaults to "yes"; the CLI plumbs through a predicate that reads `typeclaw.json` and only returns true when `channels.kakaotalk` is configured, so non-kakao agents don't get daily `no_account` log spam). On a successful renewal it invokes the optional `onRenewalOk` callback so the host can restart the container — without that, fresh tokens land on disk but the live LOCO client keeps the old token in its closure and still 401s at the ~7-day wall. `stop()` and `drain()` await in-flight ticks so daemon shutdown doesn't abandon a mid-flight `attemptLogin`. Same `DaemonOptions.kakaoRenewal` opt-in pattern as portbroker; same isolation (daemon never imports the renewal module).
- `src/hostd/client.ts` — `isDaemonReachable()`, `send(req)` (Unix socket, host-only), and `sendHttp(req, opts)` (HTTP, used by the in-container agent tool to dial `TYPECLAW_HOSTD_URL` with Bearer auth). Each call opens a fresh connection. 3-second default timeout on ACKs.
- `src/hostd/spawn.ts` — `ensureDaemon()` only. Handles the spawn race via `lockfilePath()` — concurrent `typeclaw start`s converge: at most one wins the lock and spawns the daemon, others poll `isDaemonReachable` for up to 5s. Also performs version-drift detection: when the socket is reachable, sends `{ kind: 'version' }` and compares the daemon's reply to the locally-computed source fingerprint; on mismatch, sends `{ kind: 'shutdown' }`, polls until the socket file disappears, then falls into the normal spawn path.
- `src/hostd/version.ts` — `computeSourceVersion({ srcRoot })` produces a deterministic 32-char fingerprint by hashing every `*.ts` file under `src/` (excluding tests). Both peers compute it independently — the daemon at `_hostd` boot, the CLI at every `ensureDaemon()` call. `resolveSrcRoot(brokerEntry)` walks up from `process.argv[1]` to find the project's `src/`; returns `null` for installations that don't have a `src/` ancestor (e.g. a future bundled build), in which case both peers use `UNVERSIONED_SENTINEL` and drift detection is no-op (intentional fallback rather than crash).
- `src/hostd/paths.ts` — single source of truth for `~/.typeclaw/` paths plus the in-container mount target (`containerSocketPath()`, `containerHostRunDir()`). Also exposes `registrationsDir()` and `registrationFilePath(containerName)` (the latter throws on names that could escape the directory), plus `keysDir()` for the KakaoTalk renewal-cron's encryption keys at `~/.typeclaw/keys/<containerName>.key`. Honors `TYPECLAW_HOME` for test isolation.
- `src/hostd/protocol.ts` — request/response types shared by client and daemon.
- `src/cli/hostd.ts` — internal foreground entry (`typeclaw _hostd`). Hidden via citty `meta.hidden`. Wires the daemon's `restart` callback to `@/container#start` and `@/container#stop`, instantiates the `portbroker-manager` to wire to `DaemonOptions.portbroker`, and instantiates the `kakao-renewal-manager` with `onRenewalOk` pointed at the SAME `restart` function (so successful renewal triggers a container restart that propagates fresh tokens into the live LOCO client) plus `shouldRenew` gated on `loadConfigSync(cwd).channels?.kakaotalk`. Also computes the source fingerprint at boot via `computeSourceVersion()` and passes it to `startDaemon` as `version`, plus an `onShutdown: () => process.exit(0)` so the daemon exits cleanly after a `shutdown` RPC drains.
- `src/agent/tools/restart.ts` — container-stage agent tool. Sends `{ kind: 'restart', containerName }` over HTTP to `TYPECLAW_HOSTD_URL` with `Bearer ${TYPECLAW_HOSTD_TOKEN}`, awaits the ACK, then `process.exit(0)` after a short tick so the tool result reaches the model before the process dies.

#### `src/portbroker/` — both halves of the proxy

- `src/portbroker/policy.ts` — pure: `shouldForward({ policy, port })` and `brokerEnabled(policy)`. Always implicitly excludes `CONTAINER_PORT` (8973) — that mapping is owned by `docker run -p` and forwarding it again would fight the published port.
- `src/portbroker/proc-net-tcp.ts` — pure parser for `/proc/net/tcp[6]`. Extracts `(port, bindAddr)` for LISTEN-state rows. Dedupes across IPv4/IPv6 by preferring `127.0.0.1` (loopback is always reachable from inside the netns; the relay routes through it either way). Loose-by-design: never throws on garbage input.
- `src/portbroker/protocol.ts` — message kinds for the `/portbroker` WS channel, plus base64 helpers for binary chunks.
- `src/portbroker/container-server.ts` — container-side. `createContainerBroker({ expectedToken, ... })` returns `open`/`message`/`close` handlers that the agent's WS server (in `src/server/index.ts`) plugs into the `/portbroker` upgrade path. Verifies `broker-hello` token, runs the `PortWatcher` (500ms procfs polling — cheap inside the netns, no `docker exec` overhead), and per `relay-open` opens an upstream `Bun.connect('127.0.0.1', port)` then pumps bytes.
- `src/portbroker/hostd-client.ts` — host-side. `createBroker({ resolveHostPort, brokerToken, policy, ... })` connects to `ws://127.0.0.1:${hostPort}/portbroker`, sends `broker-hello`, subscribes to port events, and per allowed LISTEN port installs a `Bun.listen(127.0.0.1, port)`. Per accepted host connection, allocates a `streamId` and pumps bytes through the multiplex. **Bun's TCP `data` callback reuses its buffer**, so every chunk MUST be copied into a fresh `Uint8Array` before being queued or forwarded — see `handleHostConnection`.
- Reconnect: on WS disconnect, all forwarders tear down (host sockets close, in-flight streams drop), then a backoff loop (1s, 2s, 4s, 10s) calls `resolveHostPort()` again before each reconnect attempt. The host port may change across container restarts — re-resolving handles that without coupling broker to supervisor.

### Rules of thumb

- **`portForward` defaults to `{ allow: '*' }` at the user-facing schema layer (`configSchema`).** The `start()` function default is "no broker" (when called without `cliEntry`, e.g. unit tests). Tests get a deterministic, side-effect-free default; the `'*'` default lives in the user contract and the CLI plumbs it through explicitly. Adding a daemon spawn as an implicit default of a function call breaks unit-test isolation.
- **`cliEntry` has no production default in `start()`.** It must be passed explicitly (the CLI passes `process.argv[1]`). Tests omit it to disable daemon spawn entirely. This is the seam that keeps `bun test` from accidentally launching a real `_hostd` process.
- **The supervisor is on whenever the daemon is on; the broker is on whenever `portForward.allow !== []`.** `typeclaw start` always registers with the daemon, passing the portForward policy. The daemon constructs a Broker either way; if `allow: []`, the broker no-ops without opening a WS. This means `restart` is always available to the agent without separate opt-in, AND the broker doesn't add WS overhead when explicitly disabled.
- **`portForward` is `restart-required` in `FIELD_EFFECTS`.** The broker's allow/deny is captured at register time; reload doesn't re-evaluate. Same fence as `mounts` and `port`.
- **Host port equals container port for forwarded ports.** Always, no exceptions. There is no random-port fallback for forwarded ports because predictable URLs are the whole point. Port collisions log `port-forward-failed` to `~/.typeclaw/log/hostd.log` and emit a TUI broadcast (via the container's stream); the affected port is just not forwarded. **(The CONTAINER_PORT itself does fall back to a random ephemeral port via Docker on bind conflict — that's separate, see `src/container/start.ts`.)**
- **In-container forward results are reported back over the WS as `port-forward-result`.** The host-side broker emits this message after every `installForwarder` attempt (success, host EADDRINUSE, or policy-excluded). Container-side consumers subscribe via `subscribeForwardResult` (re-exported from `@/portbroker`). Used by `bindWithForward` in `src/portbroker/bind-with-forward.ts` to retry across a port range when the first candidate collides on the host. Without this back-channel, in-container code that picks a port (e.g. the agent-browser plugin's dashboard proxy) cannot detect cross-container collisions because each container's netns hides the host-side state. **Wire-protocol invariant**: `port-forward-result` must always be sent for every `port-listen-opened` the broker observes — including the policy-excluded path — so the container's awaiter doesn't hang for the full timeout on every denied port.
- **Container LISTEN→host forward goes through `127.0.0.1`, not the bridge IP.** Two reasons: (1) Docker Desktop on macOS doesn't route the bridge subnet from the host, and (2) many dev servers bind `127.0.0.1` inside the container which the bridge IP couldn't reach anyway. The relay being inside the container's typeclaw process (calling `Bun.connect('127.0.0.1', port)` from the netns) sidesteps both issues.
- **Wire-protocol changes to `/portbroker` require a container restart.** The container's WS server loads its source once at process start (Bun has no hot-reload). Editing `src/portbroker/container-server.ts` and reconnecting hostd is not enough; the container must restart so the in-container relay picks up the new code. Same rule as the TUI protocol.
- **The CLI never SIGTERMs by PID.** `typeclaw stop` deregisters via the socket. The pidfile is a hint to find the daemon, never a kill target. This is what makes PID-reuse safe. The version-drift respawn flow in `ensureDaemon` follows the same rule: it sends `{ kind: 'shutdown' }` over the socket and waits for the socket file to disappear, never falls back to a pidfile-based kill. If the daemon doesn't honor the shutdown within 5s, `ensureDaemon` returns a hard failure rather than escalating to a signal — preserving the invariant at the cost of surfacing the stuck-daemon edge case to the user.
- **Daemon-source drift is detected, not assumed-OK.** `_hostd` reads `src/**/*.ts` once at process start; subsequent edits to disk are invisible to the running daemon. Without drift detection, every bug fix to the daemon's broker/parser logic was silently a no-op until the user manually killed `_hostd` — a structural footgun. `ensureDaemon` exchanges a source-tree fingerprint (sha256 over `src/**/*.ts`, sorted, test files excluded) on every CLI invocation, and respawns transparently when it differs. Adding new daemon source files is automatically covered; adding new daemon-loaded files outside `src/` (rare, but e.g. a future plugin loader) requires extending the fingerprint scope in `src/hostd/version.ts`. **The portbroker source is included in this fingerprint** because hostd loads it.
- **Trust boundaries scale per-channel.** The bind-mounted Unix socket scopes CLI↔daemon RPCs to the user's UID via filesystem perms (0o600). The HTTP control surface scopes `restart` to the registered `containerName` + `restartToken` (Bearer auth) — both pieces are required because the URL is reachable from any container on the bridge subnet, and a compromised container could otherwise enumerate or restart its peers by guessing names. The `/portbroker` WS scopes its multiplexed relay to the `brokerToken` shared at register time — a compromised container cannot make hostd open a port mapping it didn't register for, and a stale token from a prior container life cannot impersonate a new one because each register generates a fresh token. Anything that wants to extend trust (e.g. allow a container to query peer status) must go through new RPC kinds with explicit auth, not a wider mount or token reuse.

- **`Dockerfile` does not need changes for either capability.** The HTTP control surface uses `host.docker.internal` (auto-resolvable in OrbStack and Docker Desktop, requires `--add-host host.docker.internal:host-gateway` on Linux which `start.ts` injects when `hostdControl` is set), and the `/portbroker` WS reuses the existing `-p` mapping for `CONTAINER_PORT`. Container images stay untouched.
- **Persistence is per-container, not per-daemon.** Each registration lives in its own `~/.typeclaw/run/registrations/<name>.json` file (mode 0600), written atomically (temp + rename) and unlinked on deregister/GC. Single-file alternatives like `registry.json` were rejected because they'd require locking for concurrent register/deregister and a single corrupt write could lose every container's restart capability. One bad file → that one container is skipped at boot with a `registration-skipped` log event; every other container's recovery is unaffected. The CLI never writes these files — only hostd does, inside the same `runSerially(name)` chain that protects in-memory state, so register/deregister against the same name are linearizable.

- **The daemon stays alive when its registry becomes empty.** Idle cost is ~10 MB RAM and zero CPU. The next `typeclaw start` reuses it. Killing the idle daemon is `pkill -f 'typeclaw _hostd'` (out of scope for the CLI).

## Message Stream

`src/stream/` is the in-process coordination primitive that the WS server, cron, and the agent's own tool use to talk to each other. It's an in-memory pub/sub keyed by typed targets. **Nothing is persisted**; if the Bun process crashes, all in-flight stream state is lost. Persistence is deliberately out of scope — agentic work is not resumable mid-LLM-call, and the container is the failure unit.

### Targets

A `StreamMessage` carries a `target` discriminating four kinds, each with documented semantics:

- **`broadcast`** — fan-out to every matching subscriber. Used for live notifications (mood, status, presence). The WS server forwards these to connected TUIs as `notification` messages.
- **`session: { sessionId }`** — addressed to a specific live `AgentSession`. Used for TUI input queueing — the WS server publishes here, the per-session drain loop subscribes. Exactly one logical consumer per session.
- **`new-session: { subagent }`** — spawn a fresh subagent session. Published by the cron consumer (when a `prompt` job carries a `subagent` field) and by the WS server (when a session goes idle and the memory-logger should run). Consumed by the `SubagentConsumer` in `src/agent/subagents.ts`, which looks `subagent` up in the in-process registry, validates the payload against the registered `payloadSchema`, and invokes the `Subagent`'s `handler`. Coalescing is per `inFlightKey(name, payload)` — production wiring keys memory-logger by `parentSessionId` (so different parent sessions run in parallel) and dreaming by `agentDir`.
- **`cron: { jobId }`** — emitted by the cron scheduler when a job fires. Consumed by the `CronConsumer` in `src/cron/consumer.ts`, which dispatches to the prompt or exec runner and handles per-jobId coalescing. When a `prompt` job carries a `subagent` field, the consumer republishes to `new-session` instead of running the prompt itself.

Targets are typed unions, not stringly-typed topics. Adding a fifth kind is a deliberate design choice; we do not have a generic `handler` extension point.

### Subagents

`src/agent/subagents.ts` defines the engine-shaped `Subagent` type and the `SubagentConsumer` that subscribes to `new-session` stream messages. Subagents are never called directly from the cron consumer or the server — both go through the stream so any future caller (a tool, a plugin, an event handler) can fire a subagent by publishing to `new-session` without importing the registry. Production wiring in `src/run/index.ts` builds the registry exclusively from plugin contributions: the bundled memory plugin (`src/bundled-plugins/memory/`) is auto-loaded before any user-declared plugins and contributes the `memory-logger` and `dreaming` subagents. Each plugin `Subagent` may declare an `inFlightKey(payload)` function; the consumer reads it at dispatch time and uses `${name}:${key}` as the in-flight set key, allowing per-payload concurrency (e.g. memory-logger keyed by `parentSessionId`). When a `Subagent` declares a `payloadSchema`, the cron loader validates `cron.json`'s `payload` field against it at parse time and at every `reloadAll()` — bad configs fail fast on disk, not 6 hours later when the job fires.

### Bundled plugins

`src/bundled-plugins/memory/` ships with TypeClaw and is auto-loaded by `startAgent` before any user-declared `plugins[]`. The runtime statically imports `src/bundled-plugins/memory/index.ts` and passes it via `LoadPluginsOptions.bundled`. Bundled plugins are not copied into agent folders and are not user-listable. The `memory` config block in `typeclaw.json` (`{ idleMs, dreaming: { schedule } }`) is consumed by this plugin via its `configSchema`; both fields are restart-required because the plugin reads them once at factory time. **`session.idle` is the prompt-end signal** — core fires the hook synchronously after every `session.prompt()` resolves in `src/server/index.ts` `drain()`. Plugins that want delayed reactions (e.g. memory-logger) install their own `setTimeout` and reset it on each event.

### Wire protocol contract

The TUI ↔ WS protocol depends on the stream-driven drain loop in two non-obvious ways. **A wire-protocol change without an in-place container restart will silently break the live UX** because the server runs the source it loaded at process start.

- **Concurrent prompts must not race.** When a `Stream` is wired into the server, `{ type: 'prompt' }` is **not** awaited inline. It's published to `target: { kind: 'session' }` and a per-session drain loop owns all `session.prompt()` calls. The fallback path (no stream) preserves the old direct-prompt behavior so `createServer` is still usable in tests that don't inject a stream. See `src/server/index.ts` `drain()` and `enqueuePrompt()`.
- **Queued user prompts render in execution order, not submission order.** The TUI does not append the `> text` history line at submit time. The server emits `{ type: 'prompt_started', messageId, text }` from the drain loop right after `shift()` and before `await session.prompt()`. The TUI's `prompt_started` handler is what appends the history line. This means an old container running pre-`prompt_started` server code will leave typed messages invisible in the chat — restart the container after any change to the drain or protocol. The `[QUEUED]` panel above the editor still shows pending items in the meantime.
- **`interrupt`-delivery prompts abort on receipt, not in queue order.** `delivery: 'interrupt'` calls `session.abort()` from the publish path so the in-flight `prompt()` resolves immediately, then the drain loop dequeues the new prompt as usual.

### Cron split (celery model)

`src/cron/scheduler.ts` is a **pure clock**. It computes next-fire times and invokes `onFire(job)`. It knows nothing about how a job runs.

`src/cron/consumer.ts` is the **executor**. It subscribes to `target: { kind: 'cron' }`, dispatches by `job.kind` to the prompt or exec runner, and tracks `inFlight` jobIds for per-job coalescing. The scheduler does not coalesce; the consumer does.

This split means a long-running job no longer blocks subsequent ticks at the scheduler layer — the scheduler fires N times for N ticks, and any overlapping fires for the same job are dropped by the consumer with a warning. Same observable behavior as before, cleaner ownership.

### Cron `prompt` job with `exec` (pre-LLM command)

A `prompt`-kind cron job may optionally declare an `exec` array. When present, the consumer runs the command via `Bun.spawn` (cwd = agent dir) **before** firing the LLM, captures stdout / stderr / exitCode, truncates each to `execMaxOutputBytes` (default 64 KiB), and feeds the result into the LLM call:

- **Without `subagent`:** stdout appended to the prompt text as a fenced block. Stderr appended as a second fenced block when non-empty. `exit code: N` line appended when non-zero. The session's default tool set is unchanged — which means `channel_send` works for "exec → reach out to a channel" flows out of the box.
- **With `subagent`:** result merged into the new-session payload as `payload.exec = { stdin, stderr, exitCode }`. The subagent's `payloadSchema` should declare `exec: z.object({ stdin: z.string(), stderr: z.string(), exitCode: z.number() }).optional()` to opt in. Non-object original payloads are wrapped as `{ payload: <original>, exec }` to preserve data.

The LLM runs **regardless of exit code** — the model sees the result (including failures) and decides what to do. For conditional firing, compose in the command itself: `["bash", "-c", "gh run list … | jq -e '.[].conclusion == \"failure\"' && echo failed"]` — empty stdout on success, output on failure, LLM decides what to summarize.

Worked example (no subagent, posts to Slack on CI failure):

```json
{
  "id": "ci-watcher",
  "kind": "prompt",
  "schedule": "*/10 * * * *",
  "scheduledByRole": "owner",
  "exec": ["gh", "run", "list", "--limit", "5", "--json", "conclusion,name,url"],
  "prompt": "If any of the last 5 CI runs below failed, post to Slack workspace T0123 channel C0ENGR: 'CI broke: <name> <url>'. Otherwise stay silent (no tool calls)."
}
```

Subagent-tool gotcha: subagents declared with an explicit `tools` field get only what they declared — channel tools must be opted in via `customTools` or by reusing the default tool set. The bundled `memory-logger` and `dreaming` subagents intentionally don't carry channel tools, which is why a "summarize and post" exec→llm flow should usually go through the no-subagent path unless you're authoring a plugin subagent that takes ownership of the routing.

### `stream_snapshot` agent tool

`src/agent/tools/stream-snapshot.ts` exposes a read-only tool to the agent that reads from the broker's bounded ring buffer (default 1000 events). The agent can ask "what cron jobs fired in the last minute?" or "did any broadcasts arrive while I was thinking?" without any wire round-trip — the tool is in-process. Read-only by design: the agent cannot publish via this tool. Wired into `createSession` only when a `Stream` is injected.

### Rules of thumb

- **The stream is in-memory and ephemeral.** Anything that must survive a restart belongs elsewhere (session JSONL files, `cron.json`, MEMORY.md). Don't try to use the stream as a queue for important work.
- **Wire-protocol changes require a container restart.** The Bun process loads the source once at start. Editing `src/server/` or `src/shared/protocol.ts` and reconnecting the TUI is not enough; the container must restart (`typeclaw restart`) so the server picks up the new code.
- **Each new target kind is a deliberate addition.** When you find yourself wanting to use the stream for a new use case, prefer a typed target (`{ kind: 'whisper', ... }`, `{ kind: 'channel', ... }`) over a generic catch-all. The four current kinds each pay for themselves with a concrete consumer.
- **Drain loops own serialization.** If a target should have one logical consumer (`session`, `cron`), the consumer is responsible for not running things concurrently. The broker fans out; it doesn't gate.

## Web search (`websearch` agent tool)

`src/agent/tools/websearch.ts` exposes general web search to the agent. The `web` source (default) goes through `src/agent/tools/ddg.ts`, which queries DuckDuckGo's `lite.duckduckgo.com/lite/` SERP — the only major engine that serves a parseable, key-free, registration-free SERP. The `wikipedia` source is a separate, narrower path.

**The DDG client shells out to `curl-impersonate`, not Bun's native fetch.** Reading the function and seeing `Bun.spawn(['curl_chrome136', ...])` instead of `fetch(...)` is intentional and load-bearing — do not "modernize" it back. As of 2026, DDG fingerprints incoming requests at the TLS handshake (JA3/JA4) and HTTP/2 SETTINGS-frame layer **before any HTTP header is read**. Bun's native fetch cannot match Chrome's TLS handshake (upstream Bun issue #11368, open with no ETA), so requests from `fetch()` get gated behind 202 anomaly-modal responses on residential IPs, escalating to interactive duck-picker challenges within a small burst window. This was confirmed empirically over a multi-hour debugging session against a single home IP where real Chromium succeeded continuously while every fetch variant — varying request method, headers, body shape, endpoint, and pacing — got 202'd or HTTP-200-with-anomaly. The Python (`primp`/`ddgs`) and JS (`node-curl-impersonate`) DDG-scraping ecosystems converged on the same answer; we adopted it.

The binary is installed as a layer in the agent's Docker image (see `src/init/dockerfile.ts` `CURL_IMPERSONATE_*` constants). Pinned to **lexiforest's actively-maintained fork** (Chrome 136+ profiles in v1.5.6, May 2026) — **not** the original `lwthiker/curl-impersonate` whose last release v0.6.1 (March 2024) carries Chrome ≤116 profiles, two years stale and useless against current DDG fingerprinting. The lexiforest mistake is the kind of thing that costs hours, so the constant block in `dockerfile.ts` calls it out by name.

**Bumping the pinned version.** Edit the four constants in `src/init/dockerfile.ts` (`CURL_IMPERSONATE_VERSION`, `CURL_IMPERSONATE_SHA256_AMD64`, `CURL_IMPERSONATE_SHA256_ARM64`, `CURL_IMPERSONATE_PROFILE`), verify the new release ships the wrapper named in `CURL_IMPERSONATE_PROFILE` (lexiforest regenerates wrappers on Chrome major bumps and occasionally drops older ones — pick a profile from the new release's manifest), then run `typeclaw start` in any agent folder. The Dockerfile is regenerated on every `start` per the existing "owns the Dockerfile" rule, and the resulting content-diff triggers an auto-rebuild without `--build`. The build itself smoke-tests the binary via `curl_${PROFILE} --version` so a missing or broken profile fails the build, not the first websearch call.

**Why no `-H` overrides on the curl invocation.** `curl_chrome136` already sends the full Chrome 136 header set with correct ordering, sec-ch-ua values, etc. Adding our own `-H` flags would corrupt the impersonation — header order matters to DDG's anomaly detection. The previous code's `BROWSER_HEADERS` const was deleted for this reason; do not reintroduce it.

**Testing the spawn path.** `src/agent/tools/ddg.test.ts` exercises `fetchDdgHtml` against a hand-rolled fake binary written to a tmpdir per AGENTS.md §5 ("Real implementations with controlled inputs"). The fake binary is a shell script that the test points at via the `binary` option on `fetchDdgHtml`. No mocks, no `jest.mock`-style trickery — the actual Bun.spawn codepath runs against real exit codes, real stderr, and a real abort signal. When you change the spawn shape (new flags, different argv ordering, etc.), prefer extending the existing test rather than adding a layer of indirection in the production code.

**Failure modes.**

- `curl_chrome136` not on `$PATH` → `Bun.spawn` throws `ENOENT`, surfaces as `Error` from `fetchDdgHtml`, becomes the websearch tool's `errorResult(...)` text. If a user reports this, the container is broken (Dockerfile rewrite failed) — `typeclaw start --build` is the fix, not source changes.
- DDG returned a CAPTCHA page despite TLS impersonation → `DdgCaptchaError`. This is the case where we'd reopen the conversation about cookie warmup, vqd preflight, or request cadence jitter. As of the curl-impersonate landing, the empirical CAPTCHA rate dropped from "throttled within 5 requests" to "essentially zero on residential IPs" — but if it regresses on some future DDG escalation, those Option-3 mitigations are the next move, not switching to a paid fallback engine.
- Network timeout (>30s) → curl-impersonate exits non-zero with timeout in stderr, surfaces as a normal `Error`. The 30-second cap is hardcoded in `REQUEST_TIMEOUT_SECONDS`; tune with care, since it's also the upper bound on how long a stuck websearch can hold up a tool call.
