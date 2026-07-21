---
name: typeclaw-config
description: "Read or edit typeclaw.json — the host-stage runtime config: model, port, mounts, plugins, alias, channels, modelTools limits, portForward, docker.file (container package toggles + append), git.ignore.append, plus provider credentials (secrets.json/.env) and the allowed-models registry. Strict schema with a mix of live-reloadable and restart-required fields — load before touching the file or you risk corrupting it or promising a behavior the runtime won't deliver. Also the authority on what a field defaults to and whether a behavior is already on out of the box (port forwarding, container packages, model choice) — load before saying you don't know what X defaults to, or before proposing to add a field whose default the user is asking about; most fields already default to the expected behavior, so the answer is usually 'no edit needed'. Owns the GitHub channel config — which repos it watches (channels.github.repos), the code-review trigger (channels.github.review.on/approve), webhook auto-registration via a tunnel — load on 'github channel', 'github webhook', 'review these repos', 'watch repo X', 'set up code review', 'stop reviewing repo Y'; GitHub events are an inbound channel the agent engages directly, there is NO 'forward webhooks to a Slack channel' flow, do not invent destinations. Covers recommended host paths to mount for common use cases (references/recommended-mounts.md). For messenger-channel engagement BEHAVIOR (when the agent replies vs. observes, triggers, stickiness, alias matching, suppressors) load typeclaw-channels; for who is admitted to a channel load typeclaw-permissions."
---

# typeclaw-config

You have a runtime config file at `./typeclaw.json` in your agent folder. It tells the typeclaw runtime which model powers you, which port the websocket server listens on, which host directories are bind-mounted into your container, which plugins to load, and which external messenger channels you can read from and post to. This skill exists so you do not corrupt the file, do not promise behavior the runtime cannot deliver, and do not surprise the user.

This file is **not** about who you are — that is `IDENTITY.md`, `SOUL.md`, etc. This file is about the machine you run on.

## What `typeclaw.json` actually controls

The runtime reads `typeclaw.json` at container startup. Some fields are picked up live on `reload`; others require a restart. It controls:

- `port` — the TCP port the websocket server binds to inside the container. The TUI on the host stage connects to this. Default `8973`. **Restart-required.**
- `model` — a fully-qualified `<provider>/<model-id>` string. The runtime resolves this against the built-in provider registry to decide which API to call for every turn. **Live-reloadable.**
- `models.<profile>` fallback chain — a profile may be an array of refs. The chain advances on failure: cron/batch turns advance on **any** error; interactive turns (TUI, channels, subagents) advance only when the active ref is **throttled/overloaded** (`server_is_overloaded`/`429`/`503`/rate-limit), never mid-turn after output or a tool call, and a repeatedly-throttled ref is skipped for a short cooldown. A single-ref profile fails fast with a provider notice instead of stalling. To make an agent resilient to per-account provider throttling, declare a fallback ref (ideally a different provider/account). **Live-reloadable** (rides `models`).
- `thinkingLevel` (per-profile) — reasoning effort lives **inside `models`**, not as a top-level field. A profile value may be an object like `{ "model": "<ref>", "thinkingLevel": "high" }` (or `{ "models": ["<ref>", …], "thinkingLevel": … }` for a chain). A session resolves its effort as **the profile's own level → the `default` profile's level → the SDK default (`medium`)** — so the `default` profile's `thinkingLevel` is the de-facto global default, mirroring how `models.default` is the default model. Levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Clamped to each model's capabilities (`xhigh` is OpenAI-family-only). An attention-escalation cue in a turn still bumps that single turn to maximum effort regardless. Bare string/array profile values keep working; a profile becomes an object only when a level is attached. **Live-reloadable** (rides `models`).
- `mounts` — additional host directories the user has chosen to expose to you. Each entry produces a `docker run -v <hostPath>:/agent/mounts/<name>` flag at `typeclaw start` time, so the directory shows up at `mounts/<name>` inside your agent folder. **The launcher reads this; the running container does not.** Editing `mounts` only takes effect on the next `typeclaw start`. **Restart-required.**
- `plugins` — array of plugin module specifiers loaded at server boot: npm package names for published plugins, or relative paths for local plugins you are authoring. **Restart-required.**
- `alias` — additional names the agent answers to when a channel message contains its name in plain text (no `<@id>` mention). The agent folder's directory name (`basename(agentDir)`) is always implicit; `alias` adds further forms (Latin transliteration, nicknames, Korean particles, etc.). Used by the channel engagement layer alongside the structural mention/reply/dm triggers. **Live-reloadable.**
- `channels` — per-adapter engagement triggers and history-prefetch knobs for external messengers (Discord, Slack, Telegram, LINE, KakaoTalk), plus the GitHub channel (a webhook-driven adapter that watches repos and reviews PRs — see **GitHub channel** below). Access control lives in `roles`, not here. **Live-reloadable** — edits take effect on the next `reload` without a container restart.
- `modelTools.limits` — bounded file-read snapshot, `look_at`, `web_fetch`, and channel-attachment budgets. Operators may lower any limit and may raise only those whose immutable hard ceiling exceeds the default. All buffered payloads also share a process-wide 256 MiB memory admission ceiling. **Restart-required.**
- `branding` — whether your system prompt discloses that you run on TypeClaw. Default `true`: the prompt says you run "inside TypeClaw" and stamps a `## Runtime` TypeClaw-version block. Set `false` and both are stripped — the prompt opens generically and the runtime-version block is omitted (also on the subagent prompt path). Read fresh per session, so it applies on the next `reload`. The `typeclaw.json` filename and the `typeclaw-render-pdf` / `typeclaw-troubleshooting` skill names stay regardless — they are tokens you need to operate, not disclosure. **Live-reloadable.**
- `docker.file` — controls what ships in the autogenerated container image. Two layers: (1) **toggles** for opinionated package installs — `tmux`, `gh`, `python`, `xvfb` default on (`true`); `cjkFonts` defaults to `"auto"` (resolved from host locale at start); `ffmpeg`, `cloudflared`, `claudeCode`, `codexCli` default off (`false`) — set a toggle to `false` to omit, or to a version string like `"2.40.0"` to apt-pin (`python`, `cjkFonts`, `cloudflared`, `xvfb`, `claudeCode`, and `codexCli` are boolean-only). Most toggles install apt packages with BuildKit cache mounts; `cloudflared`, `claudeCode`, and `codexCli` are exceptions — `cloudflared` downloads the pinned GitHub release, `claudeCode` runs Anthropic's official `curl | bash` installer, `codexCli` `bun install`s the `@openai/codex` npm package. (2) **`append`** — extra Dockerfile lines spliced in right before `ENTRYPOINT` for anything the toggles don't cover. The whole Dockerfile is rewritten on every `start` from the typeclaw template. Lives under the `docker` namespace alongside future Docker-related blocks (e.g. `docker.compose`). **Restart-required** (next `typeclaw start` rebuilds the image).
- `git.ignore.append` — extra `.gitignore` patterns `typeclaw start` splices into the TypeClaw-owned `.gitignore` before the protected TypeClaw rules. The whole `.gitignore` is rewritten and auto-committed on every `start` when it changes; `append` is the supported escape hatch for local ignore patterns without editing the managed file by hand. Lives under the `git` namespace. **Restart-required** (next `typeclaw start` refreshes and commits `.gitignore`).
- `portForward` — allow/deny policy for the auto port-forwarder (the host-stage `_hostd` daemon's portbroker). When the agent runs a server inside the container that LISTENs on a TCP port, the broker proxies it to the same port number on `127.0.0.1` of the host so the user can hit it directly. `portForward` decides which ports are allowed through. **Restart-required** — the broker captures the policy at register time on `typeclaw start`.

### Reload vs. restart

There is no file watcher, but there is a `reload` mechanism. When `typeclaw.json` changes:

- **Live-reloadable fields** (`models` — including per-profile `thinkingLevel`, `alias`, `channels`, `branding`) take effect on the next `reload` — no container restart.
- **Restart-required fields** (`port`, `mounts`, `plugins`, `modelTools`, `portForward`, `docker.file`, `git.ignore`) are reported as "reload landed but change won't apply until restart". The diff returns success; the runtime still has the old value in memory. Tell the user explicitly which one they're hitting. `docker.file` additionally requires an image rebuild — that happens automatically on the next `typeclaw start`, no extra flag needed. `git.ignore` refreshes the managed `.gitignore` and auto-commits it on the next `typeclaw start` if content changed.
- **`$schema`** changes are ignored.

When you edit `typeclaw.json`, name the effect: "Edited `channels` — live-reloadable, takes effect on the next `reload`." vs. "Edited `port` — restart-required, run `typeclaw restart` (host stage) to pick up the change." Conflating the two misleads the user into restarting unnecessarily, or worse, into believing a restart-required edit took effect when it did not.

You yourself cannot run `typeclaw restart` — that is a host-stage command and you live inside the container. Only the user can restart you. Do not try.

## The schema (this is the whole thing today)

`typeclaw.json` is a single JSON object with these fields:

| Field                            | Required | Type             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `$schema`                        | no       | string           | Path to `typeclaw.schema.json` for editor autocompletion. Scaffolded as `./node_modules/typeclaw/typeclaw.schema.json`. Leave it alone unless the user moves it.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `port`                           | no       | integer          | 1–65535. Defaults to `8973` (T9 spelling of "TYPE"). Change only if the default collides with something on the user's host. **Restart-required.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `model`                          | no       | string           | Must be one of the values listed in the **Allowed models** section below. Defaults to `openai/gpt-5.4-nano`. **Live-reloadable.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `models.<profile>.thinkingLevel` | no       | string           | Per-profile reasoning effort (NOT a top-level field): `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh`. Lives in a profile object `{ "model": "<ref>", "thinkingLevel": … }`. Resolves as profile's own → `default` profile's → SDK default (`medium`). Set with `typeclaw model set <profile> <ref> --thinking <level>` or `typeclaw model thinking <level>` (for `default`). **Live-reloadable.**                                                                                                                                                                                                          |
| `mounts`                         | no       | array of objects | Host directories bind-mounted into your container. Defaults to `[]` (no host paths exposed). Omitted from scaffolded `typeclaw.json` — add it only when the user wants host paths exposed. See **Mounts** section below. **Restart-required.**                                                                                                                                                                                                                                                                                                                                                                           |
| `plugins`                        | no       | array of strings | Plugin module specifiers loaded at server boot: use npm package names for published plugins (for example, `typeclaw-gws-multi-account`) and relative paths only for local plugins you are authoring (for example, `./packages/my-plugin`). Defaults to `[]`. **Restart-required.** Plugin-owned config blocks live alongside as additional top-level keys; see **Plugin config blocks**.                                                                                                                                                                                                                                 |
| `alias`                          | no       | array of strings | Additional names the agent answers to in channel engagement, on top of the implicit `basename(agentDir)`. Each entry is a non-empty trimmed string matched case-insensitively as a substring of the inbound text. Defaults to `[]`. Hatching populates this with the agent's chosen name. See **Channels and Alias** below for schema/edit mechanics; the matching behavior lives in the `typeclaw-channels` skill. **Live-reloadable.**                                                                                                                                                                                 |
| `channels`                       | no       | object           | Per-adapter engagement triggers and history-prefetch knobs for external messengers (plus the `github` webhook channel — see **GitHub channel** below). Defaults to `{}` (no adapters configured). `typeclaw init` scaffolds an empty block per requested adapter (e.g. `"discord-bot": {}`) and the schema fills in defaults. Channel access control lives in `roles` — see the `typeclaw-permissions` skill; engagement behavior lives in `typeclaw-channels`. **Live-reloadable.** See **Channels and Alias** below.                                                                                                   |
| `modelTools`                     | no       | object           | Model-tool input/transport budgets under `modelTools.limits`. Defaults preserve the built-in limits. Values are positive integers bounded by immutable hard ceilings and the shared process-wide 256 MiB admission ceiling. **Restart-required.** See **Model-tool limits** below.                                                                                                                                                                                                                                                                                                                                       |
| `portForward`                    | no       | object           | Allow/deny policy for the host-stage portbroker that auto-forwards container LISTEN ports to `127.0.0.1` on the host. Defaults to `{ "allow": "*" }` (forward everything). Omitted from scaffolded `typeclaw.json`. **Restart-required.** See **portForward** section below.                                                                                                                                                                                                                                                                                                                                             |
| `docker`                         | no       | object           | Namespace for Docker-related blocks. Today the only child is `docker.file` — toggles (`tmux`, `gh`, `python`, `ffmpeg`, `cjkFonts`, `cloudflared`, `xvfb`, `claudeCode`, `codexCli`) gate opinionated package installs; `append` adds custom Dockerfile lines just before `ENTRYPOINT`. `docker.file` defaults to `{ ffmpeg: false, gh: true, python: true, tmux: true, cjkFonts: 'auto', cloudflared: false, xvfb: true, claudeCode: false, codexCli: false, append: [] }`. Omitted from scaffolded `typeclaw.json`. **Restart-required** (next `typeclaw start` rebuilds the image). See **Dockerfile** section below. |
| `git`                            | no       | object           | Namespace for git-related blocks. Today the only child is `git.ignore` — extra patterns spliced into the autogenerated `.gitignore` before TypeClaw's protected rules. `git.ignore` defaults to `{ "append": [] }`. Omitted from scaffolded `typeclaw.json`. **Restart-required** (next `typeclaw start` refreshes `.gitignore`). See **Gitignore** section below.                                                                                                                                                                                                                                                       |
| `branding`                       | no       | boolean          | Whether the system prompt discloses that you run on TypeClaw. Defaults to `true`. Set `false` to strip every TypeClaw clue from the prompt: the base prompt opens generically (no "inside TypeClaw") and the `## Runtime` version block is omitted, on both the main and subagent prompt paths. Read fresh per session. Functional identifiers (`typeclaw.json`, the `typeclaw-render-pdf` / `typeclaw-troubleshooting` skill names) are unaffected. **Live-reloadable.**                                                                                                                                                |

> **Top-level keys not in this table are not "ignored unknowns" anymore** — they are reserved for **plugin config blocks**. The schema's `catchall(z.unknown())` preserves them, and the plugin loader hands each block to its owning plugin's `configSchema` for validation. The bundled memory plugin owns `memory` at the top level — see the `typeclaw-memory` skill for that block's semantics. Do not write a top-level key unless you know which plugin owns it.

Within the well-known core keys (including `$schema`, `port`, `models`, `mounts`, `plugins`, `alias`, `channels`, `modelTools`, `portForward`, `docker`, and `git`), **fields the schema doesn't predeclare are silently dropped**. Legacy top-level `dockerfile` and `gitignore` keys are no longer migrated — use `docker.file` and `git.ignore` directly (the legacy keys are silently ignored). Do not invent runtime fields like `provider`, `apiKey`, `temperature`, `maxTokens`, `systemPrompt`, `tools`, `timeout`, etc. — those are not plugin blocks, they are imaginary. If the user asks for one, say it is not yet supported and (if it makes sense) suggest they file a request.

A scaffolded `typeclaw.json` looks like:

```json
{
  "$schema": "./node_modules/typeclaw/typeclaw.schema.json",
  "model": "openai/gpt-5.4-nano"
}
```

The runtime fills in defaults for any omitted field: `port` → `8973`, `mounts` → `[]` (no host paths exposed), `plugins` → `[]`, `channels` → `{}` (no adapters configured), `modelTools.limits` → the limits in **Model-tool limits** below, `portForward` → `{ "allow": "*" }` (forward every container LISTEN port), `docker` → `{ "file": { "ffmpeg": false, "gh": true, "python": true, "tmux": true, "cjkFonts": "auto", "cloudflared": false, "xvfb": true, "claudeCode": false, "codexCli": false, "append": [] } }` (tmux/gh/python/xvfb pre-installed; cjkFonts auto-detected from host locale; ffmpeg, cloudflared, claudeCode, and codexCli off; no custom build steps), `git` → `{ "ignore": { "append": [] } }` (no custom ignore patterns). `typeclaw init` deliberately omits any field whose default is owned elsewhere — `mounts`, `modelTools`, `portForward`, `docker`, and `git` default via `configSchema`, and the bundled memory plugin owns its own `memory` defaults — so the scaffolded file stays minimal and the user sees only fields they actually need to think about. Add a `memory` block (a **plugin config block** owned by the bundled memory plugin) only when overriding its defaults; see the `typeclaw-memory` skill for the schema.

If the user said yes to "Wire a Discord bot?" during `typeclaw init`, the scaffold also includes:

```json
"channels": {
  "discord-bot": {}
}
```

The empty block declares the adapter to the runtime — the schema fills in `enabled: true`, default engagement triggers, and history prefetch. **Access control is separate**: by default an adapter with no `roles` block matching the speaker resolves to `guest` and the router drops every inbound. To let conversations through, declare a `roles` block (see the `typeclaw-permissions` skill). For example, `"roles": { "member": { "match": ["discord:<guild>"] } }` lets every member of that guild reach the agent on the `channel.respond` permission.

## Model-tool limits

`modelTools.limits` controls bounded payloads accepted or buffered by model-facing tools. Byte values are literal positive integer bytes. Operators can lower every limit; they can raise a limit only when its immutable hard maximum is above its default.

| Field                       | Default | Hard maximum | Applies to                                                                  |
| --------------------------- | ------- | ------------ | --------------------------------------------------------------------------- |
| `readSnapshotMaxBytes`      | 64 MiB  | 256 MiB      | Immutable file/directory snapshot before a file-reading model tool executes |
| `lookAtImageMaxBytes`       | 20 MiB  | 64 MiB       | Each local, base64, URL, or channel image passed to `look_at`               |
| `lookAtTotalMaxBytes`       | 20 MiB  | 64 MiB       | All images in one `look_at` call; must be at least `lookAtImageMaxBytes`    |
| `lookAtMaxImages`           | 16      | 64           | Image count in one `look_at` call                                           |
| `webFetchTransportMaxBytes` | 5 MiB   | 5 MiB        | HTTP response bytes buffered before `web_fetch` compaction                  |
| `channelAttachmentMaxBytes` | 100 MiB | 100 MiB      | Channel attachment download and local channel-upload snapshot               |

The web-fetch and channel-attachment hard maxima intentionally remain equal to their historical defaults because downstream HTML parsing and third-party adapter allocation cannot be bounded precisely enough to raise them safely; those two fields can only be lowered. Independent of the per-operation limits, one boot-time process-wide weighted admission budget covers buffered web responses, image raw/base64/provider-payload amplification, channel attachment buffers, and pinned snapshots. Its immutable memory ceiling is **256 MiB**, so concurrent work can still be rejected even when each operation is individually within its configured limit.

Example overriding selected limits:

```json
"modelTools": {
  "limits": {
    "readSnapshotMaxBytes": 134217728,
    "lookAtImageMaxBytes": 33554432,
    "lookAtTotalMaxBytes": 67108864,
    "lookAtMaxImages": 32,
    "webFetchTransportMaxBytes": 4194304,
    "channelAttachmentMaxBytes": 52428800
  }
}
```

`modelTools` is **restart-required**. The shared pool and tool schemas are created from the boot-time config snapshot, so `reload` reports the change but the old limits remain active until the operator runs `typeclaw restart` on the host stage.

## Mounts

Each entry in `mounts` is an object with:

| Field         | Required | Type    | Notes                                                                                                                                                                            |
| ------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | yes      | string  | Lowercase alphanumeric with `-` or `_`, must start with a letter or digit. Becomes the directory name under `mounts/` inside your agent folder. Must be unique within the array. |
| `path`        | yes      | string  | Host path to expose. Absolute (`/Users/foo/proj`), `~`-prefixed (`~/proj` — expands on the host, not in the container), or relative to the agent folder. Must be non-empty.      |
| `readOnly`    | no       | boolean | Defaults to `false` (read-write). Set `true` to bind-mount with the `:ro` Docker flag so you cannot accidentally write to it.                                                    |
| `description` | no       | string  | Free text for human and agent context. Surfaced nowhere by the runtime today; useful as a comment for future you.                                                                |

Example with mounts:

```json
{
  "$schema": "./node_modules/typeclaw/typeclaw.schema.json",
  "model": "<provider>/<model-id>",
  "mounts": [
    { "name": "typeclaw", "path": "~/workspace/typeclaw", "description": "the typeclaw source repo" },
    { "name": "notes", "path": "~/notes", "readOnly": true, "description": "personal notes (read-only)" }
  ]
}
```

After `typeclaw restart`, the agent folder gains:

- `mounts/typeclaw/` → bind-mounted to `~/workspace/typeclaw` on the host (read-write)
- `mounts/notes/` → bind-mounted to `~/notes` on the host (read-only)

You access these like any other directory under your cwd: `read mounts/typeclaw/src/foo.ts`, `bash cd mounts/typeclaw && bun test`, etc. **Writes to `:ro` mounts will fail with EROFS — do not promise the user you can edit a read-only mount.**

The `mounts/` directory itself is **gitignored** in your agent folder. The mount _contents_ live on the host (and likely have their own VCS); your agent folder commits do not capture them. If a user asks "did you commit my changes to `mounts/x/...`", the answer is: those changes are inside `mounts/x` which is the host repo, not your agent folder. Suggest they commit there.

### When the user asks you to mount a host path

1. **Read `typeclaw.json`** (the entire file, not just `mounts`).
2. **Check the existing `mounts` array** for name collisions. Names must be unique.
3. **Pick a `name`** that follows the regex `^[a-z0-9][a-z0-9-_]*$`. If the user gave you one, validate it; if not, derive a sensible kebab-case name from the path's last segment.
4. **Decide `readOnly`**. If the user says "let me show you my notes" or anything sounding read-only, set `readOnly: true`. If they say "let me code on X", leave it default (false). When unsure, ask.
5. **Append the entry** to `mounts`. Preserve existing entries.
6. **Write the file back** (pretty-printed, 2-space indent, trailing newline).
7. **Commit** with a message explaining which mount was added and why (`typeclaw-git` skill).
8. **Tell the user to restart**: "Added mount `<name>` → `<path>`. Run `typeclaw restart` (host stage). The mount will appear at `mounts/<name>/` after the next start."

### When the user asks "what can you see / what's mounted"

1. **Read `typeclaw.json`**, list each mount: `name`, `path`, `readOnly`, `description`.
2. Optionally `ls mounts/` to confirm what is actually present right now (a mount won't appear until the next `typeclaw start` after it was added).

### Common host paths to recommend

When the user describes a use case rather than naming a path — "transcribe my voice memos", "triage my mail", "look at my screenshots", "search my notes" — consult `references/recommended-mounts.md` for the canonical path per macOS/Linux/WSL, the `readOnly` default, and the macOS TCC / Full-Disk-Access gotchas (Mail, Messages, Calendars, Contacts, Safari all need FDA granted to Docker Desktop / OrbStack on the host). The reference also covers anti-patterns specific to host paths (don't mount `~` or `~/.ssh/` wholesale, `/Volumes/` is fragile under ejection, iCloud Drive paths lazy-load and may surface as 0-byte stubs). These complement the schema/correctness anti-patterns in `## Things you must not do` below.

The reference is **a lookup table, not a wishlist** — recommending a path there is not a license to add the mount silently. The user still has to ask, you still follow the standard procedure (read file, check collisions, pick name, append, write, commit, restart-required), and you still surface the TCC/FDA requirement before promising the agent can read FDA-gated data.

## Channels and Alias

`channels` configures which external adapters (`discord-bot`, `slack-bot`, `telegram-bot`, `line`, `kakaotalk`, and `github`) are enabled and how the engagement layer behaves on each; `alias` lists plain-text names the agent answers to. Both are **live-reloadable** — edits take effect on the next `reload`, no container restart.

This skill owns only the **schema and edit mechanics** of these two fields (see the schema table above): `channels: { "<adapter-id>": { engagement, history, enabled } }` and `alias: [...]`. The **behavioral contract** for the messenger adapters — when the agent wakes to reply vs. observes, engagement triggers (mention/reply/dm), reply stickiness, the non-configurable solo-human fallback, alias substring-match semantics, and peer-name suppressors — lives in the **`typeclaw-channels`** skill. **Load `typeclaw-channels` before answering any "why did/didn't the agent respond", "make it quieter", "answer to this nickname", or engagement/alias-behavior question.** Editing the fields here still follows the standard safe-edit workflow (read whole file, validate, write back, commit); since both are live-reloadable, tell the user the change takes effect on the next `reload` — no container restart.

`github` is **not a messenger** — it is a webhook-driven channel that watches repositories and reviews pull requests. It has its own fields (`repos`, `review`, …) on top of the common `engagement`/`history`/`enabled` shape, and depends on a tunnel to receive webhooks. Its configuration is documented in the **GitHub channel** section below.

**Access control is separate again**: whether an inbound is admitted at all lives in `roles`, not `channels`. By default an adapter with no `roles` block matching the speaker resolves to `guest` and the router drops every inbound. See the `typeclaw-permissions` skill.

## GitHub channel

The `github` adapter is a **webhook-driven inbound channel**, not a messenger. GitHub posts events (PR opened, review requested, issue/PR comments, discussion comments) to a webhook URL; the runtime turns each event into a channel inbound and the agent engages on it directly — reviewing the PR, answering the comment, etc. There is **no "forward to a Slack channel" step**: the GitHub channel _is_ the destination. If a user asks you to "set up a GitHub webhook to send to a channel", they are describing a flow that does not exist — clarify that the GitHub channel reviews PRs in place, and ask which repos they want it to watch.

Its config block adds these fields on top of the common `engagement`/`history`/`enabled` shape:

| Field            | Required | Type     | Notes                                                                                                                                                                                                                                  |
| ---------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repos`          | no       | string[] | Repositories the adapter watches, as `owner/name` slugs. Default `[]` (watches nothing). On start the adapter registers (or updates/claims) a managed webhook on each repo; on stop it deletes the hooks it managed during that start. |
| `review`         | no       | object   | Code-review policy: `{ on, approve }`. See below. Default `{ on: "review_requested", approve: true }`.                                                                                                                                 |
| `webhookPort`    | no       | number   | Container port the webhook server binds to. Default `8975`. Rarely changed.                                                                                                                                                            |
| `webhookUrl`     | no       | string   | Explicit public webhook URL. **Usually omit** — when a `tunnels[]` entry targets the github channel, the URL is resolved from the tunnel automatically (see below).                                                                    |
| `eventAllowlist` | no       | string[] | Which webhook events are accepted. Has a sane default; leave it unless the user has a specific reason.                                                                                                                                 |

**`review.on`** — which `pull_request` action triggers an automatic code review:

- `"review_requested"` (default) — review only when the bot is added as a reviewer.
- `"opened"` — review every non-draft PR as soon as it opens (a draft is reviewed once it turns ready, or the bot is requested).
- `"off"` — disable automatic code review entirely (the channel still receives comment events).

**`review.approve`** — when `true` (default) the agent may submit a formal approving review; when `false` it downgrades an approve verdict to a plain `COMMENT` (findings still posted, no formal approval).

Engagement, stickiness, and the solo-human fallback behave the same as for messenger adapters — see the `typeclaw-channels` skill for that behavioral model; this section covers only the github-specific config.

### Adding or removing watched repos

This is the most common request ("review repo X too", "stop watching repo Y"). It is a `channels.github.repos` edit — **non-secret**, but read the reload caveat carefully:

1. Read `typeclaw.json`, find `channels.github.repos`, add/remove the `owner/name` slug, write the whole file back.
2. **Webhook registration is restart-required, not reload.** The adapter registers GitHub webhooks only when it `start()`s, and `reload` does not re-run start for an already-running adapter (it only handles enable/disable and credential rotation). So although `channels` is broadly "live-reloadable", a `repos` change does **not** create the new repo's webhook on `reload` — the operator must run `typeclaw restart` (host stage) for the adapter to register the hook on the added repo and remove the hook it created for a removed one.
3. Tell the user accurately: "Added `owner/name` to `channels.github.repos`. This needs `typeclaw restart` (not just `reload`) for the webhook to be registered on that repo." Do not claim it took effect on `reload`.

> Why restart and not reload: GitHub webhooks are created/removed only in the adapter's `start()`/`stop()`. `reload` does not restart a running adapter for a `repos` change (it only handles enable/disable and credential rotation), so the new repo's webhook simply isn't created until the container restarts. `typeclaw restart` is the honest answer for "start reviewing repo X".

**Webhook delivery requires a public URL.** GitHub must be able to reach the container. That URL comes from one of two places; without one the repo can be listed in config, but the adapter **skips webhook registration entirely** (it logs the skip) and no events arrive until a tunnel or `webhookUrl` is in place:

- A **tunnel** entry: `tunnels: [{ name: "github-webhook", provider: "cloudflare-quick", for: { kind: "channel", name: "github" } }]`. The adapter pulls its URL from the tunnel manager automatically — leave `webhookUrl` unset. This is the normal setup. Adding/removing a tunnel is **restart-required** (`tunnels` is not live-reloadable) — see the `typeclaw-tunnels` skill.
- An explicit `channels.github.webhookUrl` the operator manages by hand.

If neither exists, say so plainly: the repo is configured but events won't arrive until a tunnel (or `webhookUrl`) is in place.

### Initial setup and auth — this is a host-stage step, not yours

The **first-time** GitHub channel setup (creating the `channels.github` block, supplying the GitHub auth — a PAT or App private key — and the webhook secret, and optionally provisioning the tunnel) is done by the operator on the host with `typeclaw channel add github`. You cannot run that: it is a host-stage CLI, and the credentials live in `secrets.json` / `.env`, which you must never write. So:

- If there is **no `channels.github` block yet**, do not try to bootstrap it by hand. Tell the operator to run `typeclaw channel add github` from the agent folder, which collects the auth + webhook secret and wires the tunnel.
- Once the block exists, **repo and review changes are yours** — they are plain `typeclaw.json` edits (above), no secrets involved.

## portForward

`portForward` is the policy for the **host-stage portbroker** — the in-`_hostd` userland TCP proxy that forwards ports your container LISTENs on to the same port number on `127.0.0.1` of the host. It exists because Docker fundamentally cannot publish new ports on a running container (`HostConfig.PortBindings` is create-time-only) and because dev servers that bind `127.0.0.1` inside the container's netns are unreachable through `docker run -p` even if the port had been published up front. The broker solves both: when you `bun run dev` and Vite LISTENs on `5173`, the broker auto-opens `127.0.0.1:5173` on the host and pumps bytes to your in-container `127.0.0.1:5173` — the user can hit `http://localhost:5173/` from their host browser without any flag, no Dockerfile change, no `docker stop && docker run -p` dance.

| Field   | Required | Type                              | Notes                                                                                                                                                                               |
| ------- | -------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allow` | yes      | `"*"` _or_ array of port integers | The discriminator. `"*"` = forward every container LISTEN. `[]` = the off switch (broker still constructed, but no WS opened). `[5173, 3000]` = strict allowlist, only those ports. |
| `deny`  | no       | array of port integers            | Only meaningful when `allow: "*"`. Subtracts ports from the firehose. **Schema rejects** `deny` combined with a number-array `allow` — that combo is almost always a typo.          |

The runtime quietly enforces three additional rules regardless of policy:

- **`port` (the websocket server, default 8973) is always implicitly excluded.** The host port mapping for `8973` is owned by `docker run -p ${hostPort}:8973`; forwarding it again would fight the published port and break the TUI connection. Don't list `8973` in `allow` or `deny` — it's dropped either way, but listing it is misleading.
- **Host port equals container port for forwarded ports.** Always, no exceptions. There is no random-port fallback for forwarded ports. If `5173` is already bound on the host (another dev server, a previous typeclaw container that didn't clean up), the forward fails; it is logged and the port is just not forwarded. Suggest the user free the port or change the in-container LISTEN port.
- **`portForward` is `restart-required`.** The broker captures the policy at register time on `typeclaw start`. Editing `portForward` and running `reload` will land in `restartRequired`; the live broker keeps the old policy until the next `typeclaw start`.

### Examples

Default (no `portForward` field at all): forward every LISTEN.

```json
{
  "$schema": "./node_modules/typeclaw/typeclaw.schema.json",
  "model": "<provider>/<model-id>"
}
```

Forward everything except a couple of ports the user wants to keep private:

```json
"portForward": {
  "allow": "*",
  "deny": [5432, 6379]
}
```

Strict allowlist — only these ports get auto-forwarded, nothing else:

```json
"portForward": {
  "allow": [5173, 3000]
}
```

Off switch — the broker is constructed but never opens a WS, no LISTEN gets forwarded:

```json
"portForward": {
  "allow": []
}
```

### When the user asks "expose port <N>" or "forward port <N> to the host"

1. **Read `typeclaw.json`.**
2. **Check the current `portForward`.** If absent, the default is already `{ "allow": "*" }` — every LISTEN is already forwarded. Tell them the port will appear on `127.0.0.1:<N>` of the host **as soon as something inside the container starts LISTENing on it** (the broker polls `/proc/net/tcp` every 500 ms). No config edit needed.
3. **If `portForward.allow` is a number array**, append `<N>` to it.
4. **If `portForward.allow` is `"*"` and `<N>` is in `deny`**, remove `<N>` from `deny`.
5. **Write the file back, commit, and tell the user**: "Edited `portForward` — restart-required. Run `typeclaw restart` (host stage) so the broker picks up the new policy."

### When the user asks "stop forwarding port <N>" or "don't expose <N> to the host"

1. **Read `typeclaw.json`.**
2. **Identify the right narrowing:**
   - `allow: "*"` → add `<N>` to `deny` (preserve existing entries).
   - `allow: [..., <N>, ...]` → remove `<N>` from the allow array.
   - `allow: []` → already off; nothing to do.
3. **Write, commit, restart-required.**

### When the user asks "what ports are forwarded right now"

1. **Read `typeclaw.json`** and report the policy.
2. **You cannot enumerate the live forwarded set from inside the container.** That state lives in the `_hostd` daemon on the host and isn't surfaced through any tool you have. Say so honestly: "Per `typeclaw.json` the policy is `<...>`; for the live list of forwards the user should check `~/.typeclaw/log/hostd.log` or run a host-stage tool that queries the daemon."

## Dockerfile

`typeclaw start` rewrites the agent folder's `Dockerfile` from a template baked into the typeclaw CLI on **every** invocation — not just on `init`. The Dockerfile is in the truly-ignored `.gitignore` category specifically because it's regenerated; the source of truth for the template is `src/init/dockerfile.ts` in the typeclaw repo, not the agent folder. This means: editing the Dockerfile by hand inside the agent folder is pointless (the next `typeclaw start` overwrites it), and a clean clone of an agent folder onto a fresh machine works only because `start` materializes the Dockerfile before `docker build` reads it.

The `docker.file` block has two layers of customization:

1. **Toggles** for opinionated package installs typeclaw knows how to layer correctly (`tmux`, `gh`, `python`, `ffmpeg`, `cjkFonts`, `cloudflared`, `xvfb`, `claudeCode`, `codexCli`). Most are apt packages — boolean for on/off, version string for an apt pin — and benefit from BuildKit cache mounts. Use a toggle whenever it covers what the user wants over a hand-rolled `append` entry.
2. **`append`** is the escape hatch for everything the toggles don't cover. An array of single-line Dockerfile instructions spliced in right before `ENTRYPOINT`, prefixed with a `# Custom lines from typeclaw.json#docker.file.append.` comment.

For the full toggle catalog (per-toggle defaults, types, version-pin rules, what each installs and why), the `append` single-line constraint, where things land in the build, and the restart/rebuild semantics, consult `references/dockerfile.md`. The playbooks below are the entry point; open the reference when you need the specifics of a toggle or the build-layer details. **`docker.file` is restart-required** — the next `typeclaw start` rewrites the Dockerfile and rebuilds the image automatically (no `--build` flag needed).

### When the user asks "install <package> in the container" / "add a Dockerfile line"

1. **Read `typeclaw.json`.**
2. **Check if a toggle covers it.** If the package is `tmux`, `gh`, `python`, `ffmpeg`, `cjkFonts` (CJK glyph rendering for `agent-browser` screenshots), `cloudflared` (Cloudflare Quick tunnels), Anthropic's Claude Code CLI (`claudeCode`), or OpenAI's Codex CLI (`codexCli`), prefer the toggle: `"docker": { "file": { "ffmpeg": true } }`. For a pinned version of an apt toggle, pass the version string: `"gh": "2.40.0"`. This is faster (BuildKit cache mount) and clearer than `append`. `cjkFonts`, `cloudflared`, `claudeCode`, and `codexCli` are boolean-only — no version-pin variant.
3. **Otherwise, use `append`.** Decide on a single-line entry — for apt installs, prefer one `RUN apt-get update && apt-get install -y --no-install-recommends <pkg> && rm -rf /var/lib/apt/lists/*` line. For env vars, one `ENV` line per variable.
4. **Validate no embedded newlines** (`append` only). Multi-step logic must be `&&`-chained on one line, not split across array entries unless those entries are independent Dockerfile instructions.
5. **Append to `docker.file.append`** (creating the field if it doesn't exist). Preserve existing entries.
6. **Write, commit, restart-required**: "Edited `docker.file` — restart-required. The next `typeclaw start` will rewrite the Dockerfile and rebuild the image. The new layer will be at the end of the build, so unrelated cache layers stay valid."

### When the user asks "uninstall <package>" / "make the image smaller"

1. **Read `typeclaw.json`.**
2. **If the package is one of the toggles**, set it to `false`: `"docker": { "file": { "tmux": false } }`. Don't try to remove it via `append` — the toggle is the only way to omit a baseline package from the apt install line.
3. **If it's an `append` entry**, remove that entry from the array.
4. **Write, commit, restart-required.** Same rebuild story.

### When the user asks "show me the Dockerfile" or "what's in the image"

1. **Read `Dockerfile` directly** (it lives at the agent folder root, autogenerated). It's the full materialized template with toggles applied plus any `append` lines.
2. **Don't promise stability.** The template can change between typeclaw releases; the `Dockerfile` you read today may differ after the next `typeclaw start` even with no `typeclaw.json` change.
3. For the abstract template (without per-agent customizations), the source of truth is `src/init/dockerfile.ts` in the typeclaw repo — pointing the user there is fine if they want to understand the layer strategy.

### When the user asks "remove that custom Dockerfile line"

1. **Read `typeclaw.json`.**
2. **Remove the entry from `docker.file.append`.** If the resulting array is empty AND no toggles are overridden, you may either leave it as `"append": []` or drop the whole `docker` block — both are equivalent. Dropping it keeps the file minimal and matches the scaffold convention.
3. **Write, commit, restart-required.** Same restart story as adding: next `typeclaw start` rebuilds.

## Gitignore

`typeclaw start` rewrites the agent folder's `.gitignore` from a template baked into the typeclaw CLI on **every** invocation, then auto-commits it when the agent folder is a git repo and the file changed. The template protects two categories: truly-ignored paths (`secrets.json`, `.env`, `.env.local`, `auth.json`, `node_modules/`, `workspace/`, `mounts/`, `channels/`, `Dockerfile`, `.DS_Store`) and system-managed runtime state (`sessions/`, `memory/`) that TypeClaw, not the agent, commits on its own schedule. Editing `.gitignore` by hand is temporary; the next `typeclaw start` overwrites it.

The `git.ignore.append` field is the supported escape hatch for additional local ignore patterns. It is an array of strings, each treated as a single `.gitignore` line. The CLI splices them into the autogenerated `.gitignore` before TypeClaw's protected rules, prefixed with a `# Custom entries from typeclaw.json#git.ignore.append.` comment.

### Field

| Field    | Required | Type             | Notes                                                                                                                                                                                                                           |
| -------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append` | yes      | array of strings | Each entry is a single `.gitignore` line — schema **rejects** entries containing `\n` or `\r`. Defaults to `[]`. Splice happens before TypeClaw-owned ignore rules so custom negation patterns cannot unignore protected paths. |

### Ordering and protected paths

`.gitignore` is order-sensitive: later `!` negation rules can unignore earlier ignore rules. TypeClaw therefore renders `git.ignore.append` **before** its own truly-ignored and system-managed entries, so even a custom `!sessions/`, `!secrets.json`, or `!.env` cannot override TypeClaw's protections. Custom ordinary ignore patterns still work because they add additional ignores; they just do not get the final word over TypeClaw-owned paths.

Materialized shape when `append` is non-empty:

```gitignore
# Custom entries from typeclaw.json#git.ignore.append.
scratch/
*.local.log

# Truly ignored: ...
secrets.json
.env
Dockerfile

# System-managed: ...
sessions/
memory/
channels/
```

### Restart semantics

- **Restart-required.** `git.ignore` is in `FIELD_EFFECTS` as restart-required. `reload` reports the change as `restartRequired`; the already-materialized `.gitignore` on disk remains unchanged until the next host-stage start.
- **The next `typeclaw start` refreshes and auto-commits `.gitignore`.** Tell the user: "Edited `git.ignore.append` — restart-required. The next `typeclaw start` will rewrite `.gitignore` and TypeClaw will auto-commit it if the file changes."

### When the user asks "ignore this path" / "add a gitignore entry"

1. **Read `typeclaw.json`.**
2. **Decide on single-line patterns.** Use one array entry per `.gitignore` pattern. Do not embed newlines.
3. **Append to `git.ignore.append`** (creating the field if it doesn't exist). Preserve existing entries.
4. **Do not edit `.gitignore` directly.** It is managed and will be overwritten on `typeclaw start`.
5. **Write, commit, restart-required**: "Edited `git.ignore.append` — restart-required. The next `typeclaw start` will rewrite and auto-commit `.gitignore`."

### When the user asks "remove that custom ignore entry"

1. **Read `typeclaw.json`.**
2. **Remove the entry from `git.ignore.append`.** If the resulting array is empty, you may either leave it as `"append": []` or drop the whole `git` block — both are equivalent. Dropping it keeps the file minimal and matches the scaffold convention.
3. **Write, commit, restart-required.** Same refresh story as adding: next `typeclaw start` rewrites and auto-commits `.gitignore` if content changed.

## Legacy migration

The only migration step that still runs is dropping a seeded `channels.github.eventAllowlist` field — if present, it is removed and the file is rewritten with a descriptive commit subject.

All other legacy shapes are no longer migrated:

- **Top-level `dockerfile` and `gitignore` keys** are silently ignored on parse. Use `docker.file` and `git.ignore` directly. If a file still carries these keys, update it by hand.
- **`channels.<adapter>.allow[]`** is silently ignored on parse and NOT translated to `roles.member.match[]`. Define `roles.member.match[]` directly.

What this means for you:

- **Do not write top-level `dockerfile` or `gitignore` keys** when editing `typeclaw.json`. They are ignored; the intended fields are `docker.file` and `git.ignore`.
- **Old documentation or examples that still mention `typeclaw.json#dockerfile.append` are stale.** The current path is `typeclaw.json#docker.file.append`. Same for `git.ignore.append`.

## Plugin config blocks

Top-level keys in `typeclaw.json` that are **not** in the well-known ten (`$schema`, `port`, `models`, `mounts`, `plugins`, `alias`, `channels`, `portForward`, `docker`, `git`) are treated as plugin config blocks. The schema preserves them via `catchall(z.unknown())`, and `extractPluginConfigs` hands each block to the owning plugin's `configSchema` for validation at boot.

This skill does **not** document individual plugin blocks. For schema, defaults, and reload semantics of a specific plugin's config, defer to that plugin's own skill:

- `memory` (idle/dreaming subagent settings) → `typeclaw-memory` skill.
- Plugin authoring patterns (name derivation, config-block keying, `restart-required` semantics for plugin code and per-plugin config) → `typeclaw-plugins` skill.

Three rules apply to every plugin block, regardless of which plugin owns it:

1. **The block key is the plugin's derived name** (scope-stripped, `typeclaw-plugin-` prefix stripped). Getting the key wrong means the plugin sees an empty config and silently uses defaults.
2. **The plugin reads its config once at factory time**, so plugin block edits are effectively `restart-required` even though core's `FIELD_EFFECTS` table doesn't classify them — the well-known ten are the only entries `reloadConfig` diffs against.
3. **Inventing a plugin block for a plugin that isn't loaded is silent.** `extractPluginConfigs` will preserve it across reloads; the runtime will never validate it; nothing happens.

Do **not** invent plugin blocks; their existence is determined by the plugins listed in `plugins[]` (plus bundled plugins like `memory`), not by the user or by you.

## Allowed models

The model registry currently has these entries:

| `model` value                                          | Display name    | Provider     | Auth                | Notes                                                                                                                              |
| ------------------------------------------------------ | --------------- | ------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `openai/gpt-5.4-nano`                                  | GPT-5.4 nano    | OpenAI       | API key             | Default. API key in `secrets.json#providers.openai.key.value` (or `OPENAI_API_KEY` env override). Reasoning model, 400K context.   |
| `openai/gpt-5.4-mini`                                  | GPT-5.4 mini    | OpenAI       | API key             | API key in `secrets.json#providers.openai.key.value` (or `OPENAI_API_KEY` env override). Reasoning model, 400K context.            |
| `openai/gpt-5.4`                                       | GPT-5.4         | OpenAI       | API key             | API key in `secrets.json#providers.openai.key.value` (or `OPENAI_API_KEY` env override). Reasoning model, 1.05M context.           |
| `openai/gpt-5.5`                                       | GPT-5.5         | OpenAI       | API key             | Flagship. API key in `secrets.json#providers.openai.key.value` (or `OPENAI_API_KEY` env override). Reasoning model, 1.05M context. |
| `openai-codex/gpt-5.4-mini`                            | GPT-5.4 mini    | OpenAI Codex | OAuth (ChatGPT P/P) | Cheaper Codex tier. Requires OAuth login at init. Persisted to `secrets.json`. 272K ctx.                                           |
| `openai-codex/gpt-5.4`                                 | GPT-5.4         | OpenAI Codex | OAuth (ChatGPT P/P) | Codex mid-tier. Requires OAuth login at init. Persisted to `secrets.json`. 272K context.                                           |
| `openai-codex/gpt-5.5`                                 | GPT-5.5         | OpenAI Codex | OAuth (ChatGPT P/P) | Flagship Codex. Requires OAuth login at init. Persisted to `secrets.json`. 272K context.                                           |
| `fireworks/accounts/fireworks/routers/kimi-k2p6-turbo` | Kimi K2.6 Turbo | Fireworks    | API key             | API key in `secrets.json#providers.fireworks.key.value` (or `FIREWORKS_API_KEY` env override). Reasoning model, 256K context.      |

**Do not write any other value into `model`.** The schema enum will reject the file at load, and the runtime will refuse to boot the agent process. If the user names a model that isn't in this table — "use Claude", "switch to o3" — be honest:

> "My registry has OpenAI's GPT-5.4 / 5.5 family (API key), the same family via ChatGPT subscription (OAuth Codex), and Fireworks' Kimi K2.6 Turbo. Other providers (Anthropic, etc.) aren't wired up yet — that needs a typeclaw release, not a config edit."

Do **not** edit `typeclaw.json` to a model the registry doesn't know, even if the user insists. That bricks the agent on next restart.

## Provider credentials

`typeclaw.json` does **not** hold API keys or OAuth tokens. Credentials live in two gitignored files, with `secrets.json` as the canonical store and `.env` retained for env-var overrides and parity with non-typeclaw tooling that reads from the environment:

**Model boundary:** this section documents operator-owned state; it is not an editing runbook for the agent. Model-driven tools must never read, create, modify, validate, or delete `.env`, `secrets.json`, or `auth.json`, even when the user supplies a value or an acknowledgement flag. Tell the operator to use the TypeClaw host-stage init/provider/channel commands and restart the container. Do not ask them to paste credentials into chat.

- **`./secrets.json`** (canonical structured store): a `v2` envelope managed by `SecretsBackend` (wraps `pi-coding-agent`'s `AuthStorage`). Written by `typeclaw init`, the OAuth refresh path, and explicit user-driven rotation. Two top-level slices:
  - `providers.*` — per-provider credentials. API-key providers store `{ type: 'api_key', key: <Secret> }`. OAuth providers store the `pi-coding-agent` token blob `{ type: 'oauth', access_token, refresh_token, expires_at, ... }`. The container auto-refreshes OAuth tokens with file locking; api-key writes only happen on explicit user-driven rotation.
  - `channels.*` — per-adapter credentials, with named fields per adapter:
    - `discord-bot: { token: <Secret> }`
    - `slack-bot: { botToken: <Secret>, appToken: <Secret> }`
    - `telegram-bot: { token: <Secret> }`

  (Only the `v2` envelope is accepted. Pre-v2 shapes and `auth.json` are no longer auto-upgraded — they are rejected with an error. `auth.json` stays gitignored as a safety net for old folders, but it is not read.)

- **`./.env`** (env-var overrides): plain `KEY=value` lines, loaded by Docker via `--env-file` at container start. When set, an env var **wins** over the file value (see resolution rules below). Useful for CI, transient rotations, or any tooling outside typeclaw that reads from the environment. The canonical env-var names per provider:
  - `OPENAI_API_KEY` — for any `openai/...` model.
  - `FIREWORKS_API_KEY` — for any `fireworks/...` model.
  - `ANTHROPIC_API_KEY` — for any `anthropic/...` model when using API-key auth.

  New TypeClaw secrets should be provisioned by the operator through host-stage TypeClaw setup. A model must not perform a "structured edit" of either secret store.

### The `Secret` shape and env-wins resolution

Every secret-bearing field in `secrets.json` is a **`Secret`**: either a plain string or an object `{ value?, env? }`.

```json
{
  "version": 2,
  "providers": {
    "openai": { "type": "api_key", "key": "sk-xxx" },
    "openai-codex": { "type": "oauth", "access_token": "...", "refresh_token": "...", "expires_at": 99 }
  },
  "channels": {
    "slack-bot": {
      "botToken": "xoxb-...",
      "appToken": { "value": "xapp-...", "env": "MY_CUSTOM_SLACK_APP_TOKEN" }
    }
  }
}
```

**Resolution at boot, in order:**

1. `process.env[secret.env]` — explicit binding wins (the `env` field on the object form).
2. `process.env[<canonical env name>]` — canonical-env fallback (`SLACK_BOT_TOKEN`, `OPENAI_API_KEY`, etc.).
3. `secret.value` — the on-disk value.
4. Otherwise the field is treated as missing.

**Env wins, the file is never auto-mutated.** When the env var is set, that value is used in-memory via `setRuntimeApiKey` (api-keys) or `process.env` injection (channels) — `secrets.json` is **not** rewritten to capture the env value. The user's file stays user-owned.

**Custom env-var binding** — the optional `env` field on the object form lets the user route a credential through an env var of their choosing (e.g., a CI system that exposes `MY_PROD_SLACK_TOKEN` instead of `SLACK_BOT_TOKEN`).

### Switching credentials

Credential switching and rotation are direct-operator host actions. Tell the operator to use the host-stage TypeClaw provider/init flow appropriate to the provider, then run `typeclaw restart`. The model must not delete provider entries, rewrite `Secret` values, remove env overrides, or verify the result by reading either file.

Never request, echo, log, or commit values from `secrets.json` or `.env`. Gitignore is not an authorization boundary; both files remain inaccessible to model-driven tools.

## Editing `typeclaw.json` safely

`typeclaw.json` is a single canonical file at the agent folder root. It is committed to git (not gitignored). Treat it like a config file you own.

### Workflow

1. **Read the whole file first** with the `read` tool. Don't assume what's in it — the user may have customized it.
2. **Modify in memory.** Change only the field(s) the user asked about. Leave `$schema` alone.
3. **Write the whole file back** with the `write` tool. Always pretty-printed (2-space indent), trailing newline, fields in stable order: `$schema` first, then alphabetical for the rest (`alias`, `channels`, `docker`, `git`, `model`, `mounts`, `plugins`, `port`, `portForward`, then any plugin config blocks like `memory`).
4. **Validate before declaring done.** A malformed `typeclaw.json` will refuse to boot the agent on next restart, and a malformed reload-time edit will be rejected by `reload`. Sanity-check your JSON manually or with `bash` (`cat typeclaw.json | jq .`) before considering the edit done.
5. **Commit the change.** See the `typeclaw-git` skill for the commit-message rule (decision context required). `typeclaw.json` is not gitignored, so an uncommitted edit will pollute your next commit.
6. **Tell the user the right next step.** Match the field's effect class:
   - `model`, `alias`, `channels` → "Live-reloadable, takes effect on the next `reload`."
   - `port`, `mounts`, `plugins`, `portForward` → "Restart-required. Run `typeclaw restart` (host stage) to pick up the change."
   - `docker.file` → "Restart-required, and the next `typeclaw start` will rebuild the image automatically (no `--build` flag needed)."
   - `git.ignore` → "Restart-required, and the next `typeclaw start` will rewrite and auto-commit `.gitignore` if content changed."
   - Plugin config blocks (e.g. `memory`) → restart-required by convention because plugins read their config once at boot. Defer to the plugin's own skill for the exact semantics.
   - Mixed edits in one go → spell out which is which; do not collapse to "restart" if part of the change is live.

### Required-shape checklist (catch this before writing)

- The file parses as JSON
- Top-level is an object (not an array, not a string)
- If `mounts` is present, it is an array (omit it or use `[]` if no host paths are exposed)
- Each `mounts[].name` matches `^[a-z0-9][a-z0-9-_]*$` and is unique within the array
- Each `mounts[].path` is a non-empty string
- If `port` is set: integer, 1–65535
- If `model` is set: exactly one of the values in **Allowed models** above
- If `plugins` is set: array of non-empty strings
- If `alias` is set: array of strings, each non-empty after trimming surrounding whitespace
- If `channels.<adapter>.engagement.trigger` is set: array of `"mention"`, `"reply"`, `"dm"` (any subset, including empty)
- If `channels.<adapter>.engagement.stickiness` is set: either the literal `"off"` or `{ "perReply": { "window": <int 1..86400000> } }`
- `channels.<adapter>.allow` (legacy) is silently ignored on parse and NOT translated to `roles.member.match`. Define `roles.member.match[]` directly. See the `typeclaw-permissions` skill.
- If `portForward` is set: `allow` is either `"*"` or an array of integers (1–65535); `deny`, if present, is an array of integers and **only valid when `allow` is `"*"`** (the schema rejects `deny` paired with a number-array `allow`)
- If `docker.file.append` is set: array of strings, each with no embedded `\n` or `\r` (multi-step shell logic goes in a single `&&`-chained `RUN` entry)
- If any `docker.file` toggle is set: `tmux`/`gh`/`ffmpeg` are boolean or version string (no whitespace, no `=`); `cjkFonts` is boolean or `"auto"`; `python`, `cloudflared`, `claudeCode`, and `codexCli` are boolean only
- No unknown top-level keys you invented — keys outside the well-known ten are interpreted as **plugin config blocks** and only do something if a plugin owns them. Inventing one means the user thinks it took effect and it did not.

## Things you must not do

- **Do not invent fields the schema doesn't support** (no `provider`, `apiKey`, `temperature`, `maxTokens`, `systemPrompt`, `tools`, `timeout`, `retry`, etc.). They will be silently dropped or, worse, mistaken for a plugin config block. Lying to the user that "I added a temperature field" when the runtime ignores it is a worse failure than refusing.
- **Do not move secrets into `typeclaw.json`.** It is committed to git. API keys and channel tokens belong in `secrets.json` (or, for env-override use cases, `.env`).
- **Do not change `port` casually.** The host-stage `typeclaw start` launcher publishes a port mapping it learned at `start` time. Changing the port in `typeclaw.json` without re-running `typeclaw start` (which re-reads it) means the TUI will connect to the wrong port and silently fail. If you change `port`, tell the user explicitly that the next `typeclaw start` will pick the new mapping.
- **Do not change `model` to something not in the registry.** The schema enum will reject the file at load, and the runtime will refuse to boot the agent process. If the user wants a model that isn't there, this is a typeclaw-side change, not a config edit.
- **Do not edit `typeclaw.json` from inside an `exec` cron job's `command`.** That mutates the file behind the runtime's back. Live-reloadable fields still won't update until something triggers a `reload`, and restart-required fields are guaranteed wrong.
- **Do not delete `$schema`.** It powers editor autocompletion for the user. Leaving it in costs nothing.
- **Do not re-add `"mounts": []` "for clarity" if the user has none.** The scaffold deliberately omits it; defaults live in `configSchema`. Re-emitting it adds maintenance noise (the user has to keep two sources of truth in sync) without changing behavior.
- **Do not promise to write to a `readOnly: true` mount.** Docker enforces it via `:ro`; writes will fail with EROFS. If the user wants you to edit a read-only mount, the fix is to flip `readOnly` to `false` in `typeclaw.json` and restart, not to retry the write.
- **Do not invent mount entries the user did not request.** Mounts expose host paths to your container; adding them silently is a security surprise.
- **Do not add `roles.<role>.match` entries the user did not request, especially `*` or platform-wildcards (`discord:*`, `slack:*`).** Match-rules grant the agent visibility (and, for outbound, posting permission) on real channels with real people in them. Widening them silently is the same class of security surprise as adding a mount. See the `typeclaw-permissions` skill.
- **Do not conflate the two `roles` edit effects.** `roles.<role>.match[]` edits are **live-reloadable** — `typeclaw reload` rebuilds the live role table (the classifier marks `roles.match` as `applied`). `roles.<role>.permissions[]` edits are **restart-required** — `reload` returns them under `restartRequired` and the live runtime keeps the old permissions until `typeclaw restart`. Don't promise a `permissions` change took effect on `reload`, and don't tell the user to restart for a pure `match` change.
- **Do not promise to post to a channel the speaker's role does not cover.** The router drops every inbound where the speaking author resolves to a role without `channel.respond`. If the user wants you to post somewhere new, the prerequisite is a `roles` edit + restart, not a retry.
- **Do not conflate "stop replying" with "remove the role's match-rule".** Removing the match-rule cuts off both inbound visibility and outbound posting. If the user just wants quieter behavior, edit `engagement` instead.
- **Do not edit the `Dockerfile` directly.** It is autogenerated and rewritten on every `typeclaw start` from `src/init/dockerfile.ts` in the typeclaw repo. Manual edits will be silently overwritten (and auto-committed away if the working tree is dirty). Customizations belong in the `docker.file` block (toggles or `append`).
- **Do not reach for `docker.file.append` when a toggle covers it.** If the user wants tmux, gh, python, ffmpeg, fonts-noto-cjk (cjkFonts), cloudflared, Anthropic's Claude Code CLI (claudeCode), or OpenAI's Codex CLI (codexCli) installed (or removed, or pinned), use the toggle. The apt toggles are the cache-mounted path; `cloudflared`, `claudeCode`, and `codexCli` are non-apt boolean toggles, and the `claudeCode`/`codexCli` toggles pair with the `typeclaw-claude-code`/`typeclaw-codex-cli` skills that document auth + usage. `append` for any of these is slower and harder to read.
- **Do not use `docker.file.append` for things that belong in the template.** If the user wants a system package _every_ typeclaw user should have, that's a typeclaw release, not a per-agent `append`. Suggest filing an issue.
- **Do not put multiline strings in `docker.file.append`.** The schema rejects entries with embedded `\n`/`\r`. Use one entry per Dockerfile instruction; chain shell logic with `&&` on one line.
- **Do not pass `pkg=ver` as a toggle version string.** The schema rejects `=` in version strings. Pass just the version (`"gh": "2.40.0"`); the renderer prepends `pkg=` itself. Same for whitespace — version strings cannot contain spaces.
- **Do not list `8973` (or whatever `port` is set to) in `portForward.allow`/`deny`.** That port is owned by `docker run -p`; the broker quietly excludes it regardless. Listing it is misleading.
- **Do not combine `portForward.deny` with a number-array `allow`.** The schema rejects this; the deny rule would have no effect even if the schema allowed it. `deny` is only meaningful with `allow: "*"`.
- **Do not promise "live forwarding will start the moment you set `portForward`".** `portForward` is restart-required; the broker captures the policy at register time. Until the next `typeclaw start`, the live broker keeps the old policy.

## When the user says "what model are you running"

1. **Read `typeclaw.json`.** Don't guess from prior conversation — the user may have changed it since you last looked.
2. Report the `model` field verbatim, plus the human-readable name from the **Allowed models** table.
3. If `model` is missing from the file, say so and report the registry default — the entry marked **Default** in the **Allowed models** table.

## When the user says "switch to <model>"

1. **Check the Allowed models table.** Is the requested model in it?
2. **If yes:** read `typeclaw.json`, change `model`, write it back, commit, and tell the user: "Edited `model` — live-reloadable, takes effect on the next `reload`. New sessions will use it; the current in-flight prompt (if any) finishes on the old model."
3. **If no:** do not edit anything. Tell the user the registry doesn't have it yet, and that adding a model is a typeclaw release, not a config change.

## When the user says "change the port"

1. Confirm the new port is 1–65535 and not in the privileged range (<1024) unless the user explicitly knows they need it.
2. Read `typeclaw.json`, set `port`, write it back, commit.
3. Tell the user: "The next `typeclaw start` (host stage) will publish the new port mapping. The current container will keep running on the old port until then."

## What this skill does _not_ cover

- **Cron jobs** (`cron.json`) — see the `typeclaw-cron` skill.
- **Plugin authoring** (`definePlugin`, hooks, contributions, name derivation) — see the `typeclaw-plugins` skill.
- **The `memory` plugin config block** (`idleMs`, `dreaming.schedule`, what the memory-logger and dreaming subagents do) — see the `typeclaw-memory` skill.
- **Identity files** (`IDENTITY.md`, `SOUL.md`, `USER.md`, `AGENTS.md`) — these are not runtime config; they are _you_. Edit them directly when relevant; no skill needed.
- **`MEMORY.md` and `memory/`** — explicit exception to the line above. `MEMORY.md` is **dreaming-owned** and you must not write to it directly; the `memory/` directory holds runtime-managed daily streams and muscle-memory skills. See the `typeclaw-memory` skill before touching anything memory-shaped.
- **Skills directories** (`.agents/skills/`, `memory/skills/`, the bundled `src/skills/`) — these are loaded from disk by the runtime; they are not driven by `typeclaw.json`. See the `typeclaw-skills` skill for the three layers, the `bunx skills` CLI, and the lockfile-based "downloaded vs hand-authored" rule.
- **The Dockerfile template itself** (the autogenerated layers in `Dockerfile`: bun base image, apt setup, GitHub CLI, `agent-browser`, Chrome for Testing) — that is host-stage, controlled by `src/init/dockerfile.ts` in the typeclaw repo, not by `typeclaw.json`. `typeclaw.json#docker.file.append` (covered above) is the only piece of the build customizable per-agent; everything else requires a typeclaw release.
- **The host-stage launcher's invocation flags** (`docker run` arguments synthesized by `typeclaw start`, the `_hostd` daemon's lifecycle, the host port allocation that maps to `port` inside the container) — those are host-stage code, not config. The pieces of that flow that **are** user-configurable through `typeclaw.json` (`port`, `mounts`, `portForward`) are documented above; the rest is not.
