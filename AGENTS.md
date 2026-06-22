# Agent Guidelines

> **Audience.** This file is for the AI assistant (or human contributor) working on the typeclaw source tree — the **dev stage** in `## Stages` below. It is **NOT** the runtime prompt for typeclaw agents; that prompt is composed in `src/agent/index.ts` via `composeSystemPrompt` and can be dumped with `bun run debug:prompt`. When sections below describe runtime behavior, they describe what the code in `src/` does — not instructions to the runtime agent.

## Default scope

If the user asks something, it's always about the typeclaw project itself until they specify another scope. Don't drift into upstream/downstream projects (agent-messenger, plugins consumed via npm, etc.) just because the conversation mentions them.

Write only inside this repo and pre-approved temp dirs (`/tmp/`, `$TMPDIR`). Never touch the user's global skills, configs, or agent identities (`~/.claude/`, `~/.agents/`, `~/.config/opencode/`), typeclaw runtime state (`~/.typeclaw/`), credentials (`~/.ssh/`, `~/.aws/`, etc.), shell/OS config, or sibling repos. If you think you need to, stop and ask.

## Pre-commit checks

Before every commit, all three must pass:

```sh
bun run typecheck
bun run lint
bun run format
```

No exceptions. No `--no-verify`. No partial fixes.

## Dependencies

**Never demote a real runtime dependency to `devDependencies` to dodge an install failure.** Consumers do not receive a package's `devDependencies`, so this silently removes the feature for _every_ published install (`bun add -g typeclaw`) — on macOS/Linux too, not just the platform you were trying to unblock. It looks like it "fixes" the install only because the broken dependency is no longer there; it is a UX regression, not a fix. `agent-messenger` is a runtime dependency and stays in `dependencies`.

When a transitive **native** module (e.g. `agent-messenger` → `better-sqlite3`) fails to build on a host without a C++ toolchain (Windows without VS Build Tools), `bun add -g typeclaw` aborts the whole install — bun aborts on any failed lifecycle script. The fix is to make that native module **not need a host compiler at all**, at its source — not to hide its parent:

- The clean fix is **upstream**: the owning package should not force a from-source native build on consumers. Prefer a dependency that ships **ABI-stable (N-API) prebuilds** for all target platforms (like `classic-level`, which never recompiles on a new Node), or read SQLite via the runtime built-ins (`bun:sqlite` / `node:sqlite`) instead of a node-gyp module like `better-sqlite3`. `better-sqlite3` ships no in-package prebuilds and is keyed to the exact Node ABI, so a brand-new Node or bun finds no prebuilt and compiles from source — the actual failure.
- `optionalDependencies` is NOT a real fix: it only lets the install _skip_ a failed build, leaving the feature dead with no recovery path for anyone who needs it. And it does not even apply to a _required_ child of an _optional_ parent — bun still runs and aborts on `better-sqlite3`'s build script under an optional `agent-messenger`. Only the failing package being _itself_ optional is non-fatal.
- `overrides`, `resolutions`, `trustedDependencies`, `patchedDependencies`, and `bunfig.toml install.ignoreScripts` are all **root-project-only** — they are ignored when typeclaw is installed as someone else's dependency, so typeclaw cannot use them to neutralize a transitive native build for its own consumers.
- Container-only native deps may additionally be seeded into the image in `src/init/dockerfile.ts` (the `WORKDIR /` "survives-the-/agent-bind-mount" pattern), but that addresses the container, not the host install.

## Debugging the system prompt

`bun run debug:prompt` dumps the rendered system prompt for each session-origin kind (`tui`, `cron`, `channel`, `subagent`) with placeholder values, plus a per-section token/char/byte breakdown.

```sh
bun run debug:prompt                       # all 4 origins
bun run debug:prompt --origin cron         # just one
bun run debug:prompt --origin channel --no-git-nudge
```

`composeSystemPrompt` (`src/agent/index.ts`) is the right entry point if you're adding a new section. The cache-suffix contract (least-volatile first → identity → runtime → origin+role → git → memory → now) is enforced by both the helper and `scripts/dump-system-prompt.test.ts`. Reorder one without the other and CI fails. The trailing `## Now` block is pinned last to keep the cache prefix stable across sessions — don't move it.

When `memory.vector.enabled` is true the `# Memory` section is omitted from the system prompt entirely (`createSession`'s `suppressSystemMemory`, derived once at boot from the restart-required vector flag in `src/run/index.ts`). Vector agents inject long-term memory **per-turn into the user prompt** instead — the memory plugin's `session.turn.start` hook renders all shards (under budget) or top-K hybrid-search results (over budget) into `event.retrievalContext.results`, which the four turn-drivers (server TUI, channel router, cron consumer, subagent runner) append to the user text. The invariant `suppressSystemMemory === memory.vector.enabled` is what prevents double-injection; a session must never carry memory in both places.

The other half of the memory loop is **consolidation**: the `dreaming` subagent (`src/bundled-plugins/memory/dreaming.ts`, cron `memory.dreaming.schedule`, default `*/30 * * * *`) reads undreamed daily-stream fragments and rebalances them into `memory/topics/<slug>.md` shards. Three load-bearing invariants make a bad LLM run non-destructive: the **citation-superset check** (every previously-cited fragment id must still be cited after the run, in `fragments:` or `superseded:`, else the whole run reverts via `restoreShardSnapshot`), **runtime-owned frontmatter** (`cites`/`days`/`lastReinforced` are recomputed from citations every run — the subagent never sets them), and **fragment-GC gating** (`compactDailyStreams` drops dreamed-and-uncited fragments only when shards were actually rewritten this run, never on stale citations). Dreamed-ids advance even on a citation-superset revert — the conscious anti-loop tradeoff. See [/docs/internals/memory](https://typeclaw.dev/docs/internals/memory).

Slim vs full mode is decided by `deriveSystemPromptMode` (exhaustive `switch` on `origin.kind`). `tui` and `channel` get the full operator-facing prompt; `cron` and `subagent` get the slim base (~245 tok). Production subagents bypass the slim base entirely via `systemPromptOverride`; the slim path only fires for cron today.

## Release

Use the **Release** GitHub Actions workflow (`workflow_dispatch`, see `.github/workflows/release.yml`). It validates the version, runs checks, bumps `package.json`, builds and pushes multi-arch base to `ghcr.io/typeclaw/typeclaw-base:X.Y.Z`, verifies cross-platform pullability, publishes to npm with provenance, then tags + releases. Tags have no `v` prefix.

The workflow is the only supported release path. The GHCR-first-then-npm ordering is load-bearing for the version-pin invariant: a user who `npm install`s before the base image lands cannot `typeclaw start`.

**Version decision.** Specified version → use as-is. Otherwise **default to patch** and only escalate to minor when one of the explicit minor triggers below is clearly met. When in doubt, it's a patch.

**Judge the change, not the commit message.** The bump is decided by what the commits since the last release _actually do_ to the public surface — read the diffs, not the Conventional Commits prefix. A `feat(...)` subject is NOT evidence of a minor bump, and a `fix(...)` subject is NOT proof of a patch; both are author conventions that say nothing about whether the public surface changed. Do not count `feat` commits. For each non-trivial commit, ask: "Does this diff add or break one of the minor triggers below?" If none do, it's a patch no matter how many `feat`s there are. Inspect with `git log <last-tag>..HEAD` plus `git show <sha>` on anything that might touch CLI args, plugin contracts, or config schema — internal helpers, behavior tweaks, i18n, and guards that don't expand the surface stay patches even when titled `feat`.

- **patch** (the default) — bug fixes, refactors, docs, deps, internal-only changes, performance work, test changes, and any user-facing improvement that doesn't add a new public surface or break an existing one. Most releases are patches.
- **minor** — reserve for a genuinely new _public_ surface or a breaking change. Specifically, at least one of: (a) a new CLI subcommand or flag, (b) a new plugin contract surface (tool/skill/subagent/channel/command hook or config field plugins can rely on), (c) a backwards-incompatible change to any of the above. A "new feature" alone is NOT enough — if it doesn't expand or break the public surface in one of those ways, it's a patch.
- Never bump major unless asked. Never ask the user which to bump.

`package.json` is the single source of truth for the version.

**Re-running after partial failure.** Every step is idempotent at the same version (GHCR overwrites, `npm publish` is gated by `npm view`, `git tag -f`, `gh release` is gated by `gh release view`). Re-run the workflow at the same version and it cleans up whatever didn't finish.

## Vocabulary

"channel" — or `channel_*` tool/code references — means **`src/channels/`**, this repo's channels subsystem (router, manager, persistence, Slack/Discord adapters). NOT Channel Talk, NOT abstract Slack channels, NOT the agent-messenger `agent-channeltalk*` skills. Only branch out when the user explicitly names a different platform.

## Multi-language

TypeClaw is a **multi-language project**: the agent lives in users' chats and reads messages in Korean, Japanese, Chinese, Arabic, Russian, every Latin-script language, and more — not just English. Any code that does **natural-language pattern matching over user/agent text** MUST work across languages, not just hardcoded English words or ASCII-only regex. This applies whenever you add or audit keyword detection, mention/alias matching, intent or engagement heuristics, suppressors, trigger-word lists, or verdict/sentiment classifiers.

Rules when writing or auditing NLP-style matching:

- **Never ship an English-only keyword list for user-facing heuristics.** If you match "I'll check", you must also cover "확인해볼게요", "voy a revisar", "je vais vérifier", etc. The existing model is `src/channels/continuation-willingness.ts` — a 15-language phrase table (EN/KO/ES/FR/IT/PT/DE/RU/ZH/JA/AR/HI/TR/VI/ID) matched case-insensitively. Extend that table; don't fork a new English-only one.
- **`\b` word boundaries in JS regex are ASCII-only.** A `\b` will not fire after accented Latin (`é`), and the concept doesn't apply to CJK/Arabic/Hindi where there are no spaces between words. `src/channels/github-review-claim.ts` is the worked example: it documents the `\b` trap, drops boundaries for non-Latin scripts, and uses Unicode-escape patterns per language. Follow that pattern instead of assuming Latin tokenization.
- **Normalize before matching.** Lowercase with `toLocaleLowerCase()` and match with `includes()` for substring heuristics (see `matchesAnyAlias()` / `textTargetsAnyPeerBot()` in `src/channels/engagement.ts`), which is script-agnostic — rather than reaching for ASCII-biased regex.
- **Protocol tokens are the one exception.** Fixed control signals that the agent emits to itself stay English by design — e.g. `NO_REPLY` detection in `src/channels/router.ts` (`isNoReplySignal` / `endsWithNoReplySignal`), and platform-constrained identifiers like GitHub `@login` matching (ASCII by GitHub's own rules) in `src/channels/adapters/github/inbound.ts`. These are not natural language; don't "multilingualize" them. The line is: matching _what a human typed_ → multi-language; matching _a token the system defined_ → English literal is fine.
- **Tests must cover non-English input.** A pattern-matching change isn't done until at least one non-Latin-script case (Korean or CJK is the cheapest) is asserted alongside the English case.

## Stages

TypeClaw runs code in three stages with different filesystems, process owners, and invocation paths. Confusing them is the most common bug source. Name the stage explicitly when discussing any command, path, or mount.

### dev stage — this repo

Running `bun run test` / `bun run typecheck` on the typeclaw source tree. CLI executes directly from `src/cli/index.ts`. No agent folder, no container.

### host stage — the user's machine

The user's cwd after `typeclaw init`. Holds `typeclaw.json`, `.env`, `package.json`, markdown files, `workspace/` (free-write zone), `sessions/` + `memory/` (gitignored but force-committed by typeclaw). Host commands are **launchers**:

- `typeclaw start` — `docker run` the configured container.
- `typeclaw stop` — `docker stop` + `docker rm`.
- `typeclaw restart` — `stop` then `start`.
- `typeclaw logs [-f]` — container logs with local-time prefix reformatting.
- `typeclaw tui` — attach a TUI over websocket.
- `typeclaw compose` — orchestrate multiple agents.
- `typeclaw _hostd` — hidden singleton daemon. See [Host daemon (hostd)](https://typeclaw.dev/docs/internals/hostd).

Persistent host state lives in `~/.typeclaw/` (override with `TYPECLAW_HOME` for tests). `src/hostd/paths.ts` is the only writer.

### container stage — inside Docker

The agent folder is bind-mounted at `/agent`. The container's entrypoint is:

- `typeclaw run` — starts the websocket server (`src/server/`), creates an `AgentSession` (`src/agent/`), speaks to TUI/channels.

`FIREWORKS_API_KEY` and friends arrive via `--env-file .env`. The `typeclaw` binary resolves through `node_modules/typeclaw` (in dev, a symlink into this repo).

### Rules of thumb

- **CLI command names encode stage.** `init`/`start`/`stop`/`restart`/`logs`/`tui`/`compose` are host-only. `run` is container-only. Anything that reads `process.cwd()` implicitly assumes host stage unless called from `run`.
- **Annotate stages on paths.** `./typeclaw.json` = host stage; `/agent/typeclaw.json` = container stage.
- **TypeClaw owns Dockerfile + .gitignore and rewrites both on every `start`.** Not just on `init`. `refreshDockerfile` returns `{ changed }`; on change, `start()` ORs into `needsBuild`, so the next start rebuilds without `--build`. To ship a Dockerfile template change, edit `src/init/dockerfile.ts` and run `typeclaw start`. Do not tell users to re-run `init`.
- **`.gitignore` has two categories.** _Truly-ignored_ (`.env`, `node_modules/`, `workspace/`, `mounts/`, `Dockerfile`, `.DS_Store`) — never in git. _System-managed_ (`sessions/`, `memory/`) — gitignored so the agent doesn't stage by hand, but force-committed by typeclaw on its own schedule. Keep that split in `gitignore.ts` section comments.
- **Per-agent Dockerfile pins `typeclaw-base:X.Y.Z` to the installed typeclaw version.** `refreshDockerfile` reads `<agent>/node_modules/typeclaw/package.json#version`. Removing or republishing a `typeclaw-base:X.Y.Z` tag after release breaks every installed copy on rebuild. GHCR has no immutability flag — don't.
- **Dev mode (`file:`/`link:` typeclaw deps) falls back to inlining the heavy stack on `oven/bun:1-slim`** because the matching GHCR tag doesn't exist yet. New heavy-stack layers must land in BOTH `buildBaseDockerfile` (next release's base) AND the inline branch of `buildDockerfile` (dev/tests). `typeclaw start --build` detects locally-linked deps and threads `force: true` so `bun install --force` runs.
- **`refreshDockerfile` runs AFTER `ensureDeps` in `start()`.** Order is load-bearing: the version pin reads `node_modules/typeclaw/package.json#version`, which `bun install` populates.
- **`typeclaw.json` has two access patterns.** Host-stage CLI uses the `config` snapshot. Container-stage runtime code (anything reachable from `typeclaw run`) MUST go through `getConfig()` so reloads take effect. Boot-only fields are `restart-required`; the `FIELD_EFFECTS` table in `src/config/config.ts` is the fence, and a guard test in `src/config/reloadable.test.ts` fails if a new schema field lacks a classification.
- **`validateConfig` is the single host-side gate.** Every host path that consumes `typeclaw.json` goes through it before doing anything destructive. It also walks `config.mounts` and runs `validateMount` (existence, readability, writability). New host-side callers route through `validateConfig`, not `loadConfigSync`.
- **`typeclaw.json#port` is preferred, not guaranteed.** `start` allocates a free port via `net.createServer().listen(...)` and falls back to ephemeral. The container's internal port is fixed (`CONTAINER_PORT`, `src/container/port.ts`). Mapping is asymmetric: `-p ${hostPort}:${CONTAINER_PORT}`. Docker is the runtime authority — `typeclaw tui`/`reload` use `docker port <container> 8973/tcp`. `typeclaw run` MUST default `--port` to `CONTAINER_PORT`, never to `config.port`.
- **Containers run WITHOUT `--rm`.** Load-bearing for debuggability: a crashed container's logs must survive past exit. `typeclaw stop` does `docker stop` + `docker rm`; `start`'s preflight force-removes stale corpses. Do not "modernize" this back.
- **Containers run with `--security-opt seccomp=unconfined`.** Required so `bwrap` (in baseline apt) can create user/pid/mount namespaces from inside Docker — the per-tool sandbox for subagent bash calls depends on it. The outer container is a single-tenant trust boundary, so seccomp's multi-tenant protections are not load-bearing for typeclaw's threat model; the inner bwrap sandbox is what matters for subagent isolation. See [/docs/internals/sandbox](https://typeclaw.dev/docs/internals/sandbox). Do not "harden" this back without first replacing the inner sandbox path with an equivalent boundary.
- **The per-tool sandbox `/proc` strategy is `proc-bind` by default, so containers get NO `--cap-add=SYS_ADMIN`.** Load-bearing for the core subagent workflow: sandboxed external-package CLIs (`bunx agent-*`, `bun add <pkg>`, `bun run <pkg-bin>`) need a real `/proc/self/{fd,maps}`, which the `--tmpfs /proc` profile can't provide — every such call aborts with Bun's opaque `NotDir`. `proc-bind` (`bwrap --unshare-all … --ro-bind /proc /proc`) binds the container's already-real procfs with NO `unshare --mount-proc` and NO `CAP_SYS_ADMIN`, so it works on OrbStack (which rejects the proc mount even with the cap — the reason the prior `real-proc`-default fix never actually fired there). The agent runtime's `/proc/<agent>/environ` (`FIREWORKS_API_KEY`) is NOT leaked: `--unshare-all` puts the sandbox in a CHILD user namespace, so the kernel's `PTRACE_MODE_READ_FSCREDS` check blocks the cross-userns `environ` read (and `kill`/`ptrace` fail `EPERM`). The leftover residual is non-secret PID metadata (other pids' `cmdline`/`status` visible), accepted on the single-tenant boundary. The no-leak property is PROBED at runtime (`canBindProcSafely`, `src/sandbox/availability.ts`) — a sentinel sibling with a planted secret must be unreadable from the sandbox — and fails CLOSED to `--tmpfs /proc` if not. `sandbox.realProc: true` is an opt-in that adds full PID isolation via the `real-proc` strategy (`unshare --pid --fork --mount --mount-proc -- bwrap …`), at the cost of the `CAP_SYS_ADMIN` grant; the resolver still falls back to `proc-bind` where the mount is a no-op (OrbStack). The strategy is read from the BOOT-TIME `config` snapshot in `applyBashSandbox` (`src/agent/plugin-tools.ts`), NOT live `getConfig()`, so it stays coherent with the boot-time capability decision — `sandbox` is `restart-required` for exactly this reason.

## Testing Philosophy

### 1. Test behavior, not implementation

Tests must survive refactors and fail only when **observable behavior** changes. After writing a test, ask: "If I comment out the production line this test guards, does it fail?" If not, the test verifies nothing.

### 2. Test at the right layer

- **CLI / UI layer** — prompts, spinners, `process.exit`, argv. Keep thin, rarely test.
- **Domain / pipeline layer** — composition, transformations, orchestration. **Primary test surface.**
- **Primitive layer** — file writes, shell calls, pure functions. Unit-test for edge cases.

If you're mocking `@clack/prompts` or stubbing `process.cwd` to test domain logic, the domain logic is in the wrong place. Extract a pure function and test it directly. Example: `src/init/index.ts` owns the `runInit` pipeline; `src/cli/init.ts` is a thin shell.

### 3. Pipeline tests must verify composition

Unit tests on sub-steps are necessary but not sufficient. You also need orchestrator tests asserting on order of execution, data flow between steps, and failure propagation. If a step can be added/removed/reordered without breaking a test, composition is untested. Make orchestrators emit observable events (callbacks, returned structures, async-iterator yields) and assert on the sequence.

### 4. One function, one concern

A function that prompts AND runs logic AND handles `process.exit` has three reasons to change. Split them: pure logic is testable, I/O is small enough to review, new steps get caught by pipeline tests.

### 5. Test doubles sparingly

Every mock is a theory about a collaborator. Theories rot. Prefer:

1. Real implementations with controlled inputs (tmp dirs, real `bun install`, real `git`).
2. Hand-rolled fakes when the real thing is unavailable or too slow.
3. Mocking libraries only as a last resort, at module boundaries.

### 6. When to skip

Simple data classes, type-only files, auto-generated code, trivial constants. A test that restates a literal is noise.

### 7. TDD is the default, not a ceremony

Write the failing test first for non-trivial behavior, edge cases, or unclear APIs. Skip TDD when setup outweighs the logic. This is a tool, not a religion.

## File Layout

Domain logic lives in `src/<domain>/`. Examples: `src/init/`, `src/config/`, `src/server/`, `src/agent/`.

- `src/cli/` is **UI only** — citty, clack, spinners, `process.exit`. Delegate to `src/<domain>/`.
- Tests live next to code as `<file>.test.ts`.
- Domain entry points are `src/<domain>/index.ts`. Split files only when one gets complex.

## Architecture

The architecture reference lives in the published docs under [Internals](https://typeclaw.dev/docs/internals). It's terse, file-path-heavy, and aimed at the same audience as this file — someone about to edit `src/`.

| Subsystem                                                                                     | Where                                                                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Skills loading sources, naming, lazy semantics                                                | [/docs/internals/skills](https://typeclaw.dev/docs/internals/skills)                       |
| `src/bundled-plugins/memory/` observe/dream/apply loop, strength model, citation-superset     | [/docs/internals/memory](https://typeclaw.dev/docs/internals/memory)                       |
| `.env` / `secrets.json`, the `Secret` shape, bridge idempotency, KakaoTalk encryption-at-rest | [/docs/internals/secrets](https://typeclaw.dev/docs/internals/secrets)                     |
| Roles, match-rule DSL, cron/subagent provenance, security guard tiers                         | [/docs/internals/permissions](https://typeclaw.dev/docs/internals/permissions)             |
| `src/hostd/`, three trust channels, control protocol, portbroker                              | [/docs/internals/hostd](https://typeclaw.dev/docs/internals/hostd)                         |
| `src/tunnels/`, providers, channel-adapter integration                                        | [/docs/internals/tunnels](https://typeclaw.dev/docs/internals/tunnels)                     |
| `src/stream/` targets, subagent dispatch, cron split, TUI wire-protocol                       | [/docs/internals/message-stream](https://typeclaw.dev/docs/internals/message-stream)       |
| `src/channels/` engage/observe decision, context buffer, suppressors, peer-bot loop guard     | [/docs/internals/engagement](https://typeclaw.dev/docs/internals/engagement)               |
| `src/agent/todo/` tools, durable scope resolution, fail-closed auto-continuation budgets      | [/docs/internals/todo-continuation](https://typeclaw.dev/docs/internals/todo-continuation) |
| `web_search` tool, `curl-impersonate` pin, DDG failure modes                                  | [/docs/internals/web-search](https://typeclaw.dev/docs/internals/web-search)               |
| Xvfb, NET_ADMIN drop, persistent-`$HOME` overlay, agent-browser headed-mode wrapper           | [/docs/internals/xvfb](https://typeclaw.dev/docs/internals/xvfb)                           |
| `bwrap` per-tool sandbox, `seccomp=unconfined` rationale, OrbStack `/proc` workaround         | [/docs/internals/sandbox](https://typeclaw.dev/docs/internals/sandbox)                     |

The source for these pages is `docs/content/docs/internals/*.mdx` in this repo. Edit there when subsystem behavior changes — the published site rebuilds from the same files.
