---
name: typeclaw-config
description: "Read or edit typeclaw.json: model, port, mounts, plugins, alias (names you answer to), channels (Discord allow rules + engagement), portForward (auto port forwarding policy), dockerfile (tmux/gh/python/ffmpeg toggles + append), gitignore.append. Also: any question about a default value or whether a behavior is already on by default — port forwarding, channel visibility, model choice, container packages (tmux/gh/python on by default; ffmpeg off), anything ending in 'by default', 'automatically', 'out of the box', 'do I need to configure', 'is X on', 'what does X default to', '기본값', '기본적으로', '자동으로', '디폴트'. MUST load whenever the user asks you to change a fact about yourself — your name, alias, nickname, what they should call you, your model, your schedule. Trigger phrases include 'register an alias', 'add an alias', 'call you X', 'answer to X', 'respond to X', 'change your name', 'rename you', 'add this nickname', 'set your alias to', '별칭', '별명', '닉네임', '이름 추가', '이름 등록', '이름 바꿔', '~라고 불러', '~라고 부르면', '~로 불러줘', '~으로 불러줘', '나한테는 X로', 'aliases', 'nicknames'. Self-config questions almost always resolve to typeclaw.json — never deflect to platform-side settings (Slack profile display name, Discord nickname, OS keychain, etc.). MUST load before saying you do not know what X defaults to, or proposing to add a field whose default the user is asking about — most fields already default to the behavior the user expects (portForward defaults to forwarding every container LISTEN; tmux/gh/python are pre-installed in the container; no edit needed). Read it before touching typeclaw.json — strict schema, mix of live-reloadable and restart-required fields."
---

# typeclaw-config

You have a runtime config file at `./typeclaw.json` in your agent folder. It tells the typeclaw runtime which model powers you, which port the websocket server listens on, which host directories are bind-mounted into your container, which plugins to load, and which external messenger channels you can read from and post to. This skill exists so you do not corrupt the file, do not promise behavior the runtime cannot deliver, and do not surprise the user.

This file is **not** about who you are — that is `IDENTITY.md`, `SOUL.md`, etc. This file is about the machine you run on. The one identity-adjacent setting that **does** live here is `alias` — the names you answer to in chat. See **Self-config requests** below.

## Self-config requests (read this first when the user asks you to change a fact about yourself)

When a user asks you to change something about yourself — your name, what they should call you, your nickname, your model, your schedule — the answer is almost always `typeclaw.json` in the agent folder. **Edit the file. Do not deflect to platform-side settings.**

The most common failure mode is mistaking a typeclaw config request for a Slack/Discord/OS-level setting:

- ❌ "I don't have permission to register a Slack alias — please edit your Slack profile display name."
- ❌ "Set your Discord server nickname under server settings."
- ❌ "Ask your workspace admin to add an alias for you."
- ✅ "On it — adding `Foo` and `푸` to my `alias` array in `typeclaw.json` and reloading."

If the user uses the word "alias", "별칭", "별명", "닉네임", "nickname", "이름 등록", or any phrase asking you to **answer to** a name, **respond to** a name, or **be called** something, this is `typeclaw.json#alias`. Period. Slack display names and Discord server nicknames are entirely separate and irrelevant to whether you wake up when someone writes that name.

### Anti-fabrication rule for `alias`

The `alias` schema is exactly this — a flat top-level array of strings:

```json
{ "alias": ["Foo", "푸"] }
```

**Negative examples — every one of these is wrong and the runtime will silently ignore them:**

```yaml
# ❌ WRONG: typeclaw.json is JSON, not YAML
aliases:
  slack-bot:
    <USER_ID>: ['Foo', '푸']
```

```json
// ❌ WRONG: field name is singular `alias`, not plural `aliases`
{ "aliases": ["Foo", "푸"] }
```

```json
// ❌ WRONG: not nested under any adapter — `alias` is top-level and applies to every channel
{ "channels": { "slack-bot": { "alias": ["Foo", "푸"] } } }
```

```json
// ❌ WRONG: not keyed by user ID — `alias` is the names YOU answer to, not a per-user mapping
{ "alias": { "<USER_ID>": ["Foo", "푸"] } }
```

If you find yourself about to render any of those shapes, stop. **Read `typeclaw.json` first.** Confirm the actual current shape. Then write the flat `alias: string[]` form.

### Do the write before claiming completion

Never say "등록 완료", "registered", "added", "saved", "done", or any past-tense confirmation for a self-config edit until **after** you have:

1. Actually called the `read` tool on `typeclaw.json` (so you saw its real current shape).
2. Actually called the `write` tool with the new contents.
3. Actually committed the change (`typeclaw-git` skill).

Showing the user a code block of "what you would write" is **not** writing. Telling the user the new aliases work without having edited the file is a lie they will discover the moment they try to use the alias and you don't engage. If you ran out of room to do the write in this turn, say so explicitly: "I haven't actually edited `typeclaw.json` yet — doing it now."

## What `typeclaw.json` actually controls

The runtime reads `typeclaw.json` at container startup. Some fields are picked up live on `reload`; others require a restart. It controls:

- `port` — the TCP port the websocket server binds to inside the container. The TUI on the host stage connects to this. Default `8973`. **Restart-required.**
- `model` — a fully-qualified `<provider>/<model-id>` string. The runtime resolves this against the built-in provider registry to decide which API to call for every turn. **Live-reloadable.**
- `mounts` — additional host directories the user has chosen to expose to you. Each entry produces a `docker run -v <hostPath>:/agent/mounts/<name>` flag at `typeclaw start` time, so the directory shows up at `mounts/<name>` inside your agent folder. **The launcher reads this; the running container does not.** Editing `mounts` only takes effect on the next `typeclaw start`. **Restart-required.**
- `plugins` — array of plugin package names loaded at server boot. **Restart-required.**
- `alias` — additional names the agent answers to when a channel message contains its name in plain text (no `<@id>` mention). The agent folder's directory name (`basename(agentDir)`) is always implicit; `alias` adds further forms (Latin transliteration, nicknames, Korean particles, etc.). Used by the channel engagement layer alongside the structural mention/reply/dm triggers. **Live-reloadable.**
- `channels` — per-adapter allow rules and engagement triggers that gate which external messenger channels (today: Discord) you can read from and post to. **Live-reloadable** — edits take effect on the next `reload` without a container restart.
- `dockerfile` — controls what ships in the autogenerated container image. Two layers: (1) **toggles** for opinionated apt packages (`tmux`, `gh`, `python` default `true`; `ffmpeg` defaults `false`) — set the toggle to `false` to omit, or to a version string like `"2.40.0"` to apt-pin (`python` is boolean-only). (2) **`append`** — extra Dockerfile lines spliced in right before `ENTRYPOINT` for anything the toggles don't cover. The whole Dockerfile is rewritten on every `start` from the typeclaw template. **Restart-required** (next `typeclaw start` rebuilds the image).
- `gitignore.append` — extra `.gitignore` patterns `typeclaw start` splices into the TypeClaw-owned `.gitignore` before the protected TypeClaw rules. The whole `.gitignore` is rewritten and auto-committed on every `start` when it changes; `append` is the supported escape hatch for local ignore patterns without editing the managed file by hand. **Restart-required** (next `typeclaw start` refreshes and commits `.gitignore`).
- `portForward` — allow/deny policy for the auto port-forwarder (the host-stage `_hostd` daemon's portbroker). When the agent runs a server inside the container that LISTENs on a TCP port, the broker proxies it to the same port number on `127.0.0.1` of the host so the user can hit it directly. `portForward` decides which ports are allowed through. **Restart-required** — the broker captures the policy at register time on `typeclaw start`.

### Reload vs. restart

There is no file watcher, but there is a `reload` mechanism. When `typeclaw.json` changes:

- **Live-reloadable fields** (`model`, `alias`, `channels`) take effect on the next `reload` — no container restart.
- **Restart-required fields** (`port`, `mounts`, `plugins`, `portForward`, `dockerfile`, `gitignore`) are reported as "reload landed but change won't apply until restart". The diff returns success; the runtime still has the old value in memory. Tell the user explicitly which one they're hitting. `dockerfile` additionally requires an image rebuild — that happens automatically on the next `typeclaw start`, no extra flag needed. `gitignore` refreshes the managed `.gitignore` and auto-commits it on the next `typeclaw start` if content changed.
- **`$schema`** changes are ignored.

When you edit `typeclaw.json`, name the effect: "Edited `channels` — live-reloadable, takes effect on the next `reload`." vs. "Edited `port` — restart-required, run `typeclaw restart` (host stage) to pick up the change." Conflating the two misleads the user into restarting unnecessarily, or worse, into believing a restart-required edit took effect when it did not.

You yourself cannot run `typeclaw restart` — that is a host-stage command and you live inside the container. Only the user can restart you. Do not try.

## The schema (this is the whole thing today)

`typeclaw.json` is a single JSON object with these fields:

| Field         | Required | Type             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | -------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$schema`     | no       | string           | Path to `typeclaw.schema.json` for editor autocompletion. Scaffolded as `./node_modules/typeclaw/typeclaw.schema.json`. Leave it alone unless the user moves it.                                                                                                                                                                                                                                                                   |
| `port`        | no       | integer          | 1–65535. Defaults to `8973` (T9 spelling of "TYPE"). Change only if the default collides with something on the user's host. **Restart-required.**                                                                                                                                                                                                                                                                                  |
| `model`       | no       | string           | Must be one of the values listed in the **Allowed models** section below. Defaults to `fireworks/accounts/fireworks/routers/kimi-k2p5-turbo`. **Live-reloadable.**                                                                                                                                                                                                                                                                 |
| `mounts`      | no       | array of objects | Host directories bind-mounted into your container. Defaults to `[]` (no host paths exposed). Omitted from scaffolded `typeclaw.json` — add it only when the user wants host paths exposed. See **Mounts** section below. **Restart-required.**                                                                                                                                                                                     |
| `plugins`     | no       | array of strings | Plugin package names loaded at server boot. Defaults to `[]`. **Restart-required.** Plugin-owned config blocks live alongside as additional top-level keys; see **Plugin config blocks**.                                                                                                                                                                                                                                          |
| `alias`       | no       | array of strings | Additional names the agent answers to in channel engagement, on top of the implicit `basename(agentDir)`. Each entry is a non-empty trimmed string matched case-insensitively as a substring of the inbound text. Defaults to `[]`. Hatching populates this with the agent's chosen name. See **Alias** section below. **Live-reloadable.**                                                                                        |
| `channels`    | no       | object           | Per-adapter allow rules and engagement triggers for external messengers. Defaults to `{}` (no adapters configured). `typeclaw init` scaffolds a `discord-bot` block only if the user said yes to "Wire a Discord bot?" during the wizard and supplied a token. **Live-reloadable.** See **Channels** section below.                                                                                                                |
| `portForward` | no       | object           | Allow/deny policy for the host-stage portbroker that auto-forwards container LISTEN ports to `127.0.0.1` on the host. Defaults to `{ "allow": "*" }` (forward everything). Omitted from scaffolded `typeclaw.json`. **Restart-required.** See **portForward** section below.                                                                                                                                                       |
| `dockerfile`  | no       | object           | Customizations for the autogenerated container image build. Toggles (`tmux`, `gh`, `python`, `ffmpeg`) gate opinionated apt packages; `append` adds custom Dockerfile lines just before `ENTRYPOINT`. Defaults to `{ ffmpeg: false, gh: true, python: true, tmux: true, append: [] }`. Omitted from scaffolded `typeclaw.json`. **Restart-required** (next `typeclaw start` rebuilds the image). See **Dockerfile** section below. |
| `gitignore`   | no       | object           | Customizations for the autogenerated `.gitignore`. Today the only field is `append` — extra patterns spliced in before TypeClaw's protected ignore rules. Defaults to `{ "append": [] }`. Omitted from scaffolded `typeclaw.json`. **Restart-required** (next `typeclaw start` refreshes `.gitignore`). See **Gitignore** section below.                                                                                           |

> **Top-level keys not in this table are not "ignored unknowns" anymore** — they are reserved for **plugin config blocks**. The schema's `catchall(z.unknown())` preserves them, and the plugin loader hands each block to its owning plugin's `configSchema` for validation. The bundled memory plugin owns `memory` at the top level — see the `typeclaw-memory` skill for that block's semantics. Do not write a top-level key unless you know which plugin owns it.

Within the well-known ten (`$schema`, `port`, `model`, `mounts`, `plugins`, `alias`, `channels`, `portForward`, `dockerfile`, `gitignore`), **fields the schema doesn't predeclare are silently dropped**. Do not invent runtime fields like `provider`, `apiKey`, `temperature`, `maxTokens`, `systemPrompt`, `tools`, `timeout`, etc. — those are not plugin blocks, they are imaginary. If the user asks for one, say it is not yet supported and (if it makes sense) suggest they file a request.

A scaffolded `typeclaw.json` looks like:

```json
{
  "$schema": "./node_modules/typeclaw/typeclaw.schema.json",
  "model": "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo"
}
```

The runtime fills in defaults for any omitted field: `port` → `8973`, `mounts` → `[]` (no host paths exposed), `plugins` → `[]`, `channels` → `{}` (no adapters configured), `portForward` → `{ "allow": "*" }` (forward every container LISTEN port), `dockerfile` → `{ "ffmpeg": false, "gh": true, "python": true, "tmux": true, "append": [] }` (tmux/gh/python pre-installed, ffmpeg off, no custom build steps), `gitignore` → `{ "append": [] }` (no custom ignore patterns). `typeclaw init` deliberately omits any field whose default is owned elsewhere — `mounts`, `portForward`, `dockerfile`, and `gitignore` default via `configSchema`, and the bundled memory plugin owns its own `memory` defaults — so the scaffolded file stays minimal and the user sees only fields they actually need to think about. Add a `memory` block (a **plugin config block** owned by the bundled memory plugin) only when overriding its defaults; see the `typeclaw-memory` skill for the schema.

If the user said yes to "Wire a Discord bot?" during `typeclaw init`, the scaffold also includes:

```json
"channels": {
  "discord-bot": { "allow": ["*"] }
}
```

`allow: ["*"]` means "every guild channel and every DM" — appropriate for a single-user dev setup. The wizard asks the user to confirm `["*"]` and warns them when they decline, but the current scaffold writes `["*"]` either way and expects the user to narrow it by hand afterwards. **If the user said they wanted a narrower allow list during init, do not assume the scaffold honored that — read `typeclaw.json` first.** For shared servers, narrow the allow list before joining (see **Channels** below).

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
  "model": "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
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

## Channels

`channels` configures which external messenger channels you can read from and post to. **Today the only adapter is `discord-bot`.** The shape is `channels: { "<adapter-id>": { allow, engagement, enabled } }`.

The channels block is **live-reloadable** — edits take effect on the next `reload`, no container restart. This is intentional: allow-rule changes need to feel immediate, otherwise the user has to restart you every time they want to add a channel.

### Adapter block

Each entry in `channels` is keyed by adapter id and has this shape:

| Field        | Required | Type             | Notes                                                                                                                                                        |
| ------------ | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `allow`      | no       | array of strings | List of allow rules. Defaults to `[]`, which means **the agent cannot post anywhere and the inbound bridge gates every message**. See **Allow rules** below. |
| `engagement` | no       | object           | When the agent should auto-reply vs. stay silent. Defaults to mention/reply/dm with 5-minute reply stickiness. See **Engagement** below.                     |
| `enabled`    | no       | boolean          | Defaults to `true`. Set `false` to disable the adapter entirely without removing its config.                                                                 |

`allow: []` is **not** the same as "deny everything from being delivered to the agent" — the inbound side may still hand you events for processing depending on engagement, but the `channel_send` tool will refuse to post anywhere. Conversely, `allow: ["*"]` does not turn engagement off; engagement and allow are independent gates.

### Allow rules

Each entry in `allow` is a string matching one of the patterns below. Workspace `@dm` is the literal placeholder for direct messages (Discord doesn't expose a guild id for DMs).

| Rule                   | Matches                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `*`                    | Every guild channel **and** every DM (full firehose).                  |
| `guild:*`              | Every channel in every guild. Does **not** include DMs.                |
| `guild:<id>`           | Every channel in guild `<id>`.                                         |
| `guild:<id>/<channel>` | Channel `<channel>` in guild `<id>` only.                              |
| `channel:<id>`         | Channel `<id>` in any guild (Discord channel IDs are globally unique). |
| `dm:*`                 | Every DM channel. Does **not** include guild channels.                 |
| `dm:<id>`              | DM channel `<id>` only.                                                |

The schema validates each rule string at load. **Bad rule = config load fails**, the runtime refuses to boot or refuses the reload. Don't fudge this; the regex is strict (numeric IDs only).

`channel:<id>` is the most surgical option and the right default when the user says "let me talk to you in #the-channel-i'm-pointing-at" — channel IDs are globally unique so you don't need the guild id. `guild:<id>` is convenient on a server you fully trust. `*` and `guild:*` are firehose patterns; only set them in single-user setups.

### Engagement

`engagement` controls when the agent's loop wakes up to reply on an inbound message it has permission to read. Two fields:

```json
"engagement": {
  "trigger": ["mention", "reply", "dm"],
  "stickiness": { "perReply": { "window": 300000 } }
}
```

- **`trigger`** — array of one or more of `"mention"`, `"reply"`, `"dm"`. Default: all three.
  - `mention` — explicit `@bot` mentions.
  - `reply` — message is a Discord reply pointed at the agent's own message.
  - `dm` — any message in a DM channel.
- **`stickiness`** — either the literal string `"off"`, or `{ perReply: { window: <ms> } }`. Default: 5-minute reply stickiness (`window: 300000`).
  - `perReply` means: after the agent replies to a user, follow-up messages from that same user in that same channel within the window also wake the loop, even without a mention. The window is bounded server-side (`1` to `86_400_000` ms — 1 ms to 24 hours).
  - `"off"` disables stickiness — the agent only wakes on explicit triggers.

There is also a **solo-human fallback** built into the runtime that is **not configurable** through `engagement`: in any allow-listed channel where the participants cache currently holds at most one distinct human author, every admitted inbound wakes the loop, regardless of `trigger` or `stickiness`. The fallback turns off the moment a second distinct human posts in that channel. This makes "private dev channel with one human and the bot" work without forcing an `@mention` on every message; clearing `trigger` to `[]` does **not** override it. If a user wants strict mention-only behavior in a one-human channel today, the answer is "wait for the post-v0.3 engagement-config work" — not a config edit.

**Engagement does not gate posting.** It gates whether you wake up. If you decide to call `channel_send` to a channel that isn't in `allow`, the tool returns `{ ok: false, error }` regardless of engagement.

To make the agent silent in a channel without removing it from `allow`, the right move is usually `engagement: { trigger: [], stickiness: "off" }`, **not** removing the allow rule — removing the allow rule cuts off both inbound visibility and outbound posting, which is rarely what the user means by "stop replying". Caveat: in a one-human channel the solo-human fallback overrides `trigger: []` and the agent will still wake; the only way to silence the bot in that case is to remove the allow rule (or add a second human to the channel).

### Example

```json
"channels": {
  "discord-bot": {
    "allow": [
      "guild:123456789012345678/987654321098765432",
      "dm:*"
    ],
    "engagement": {
      "trigger": ["mention", "reply", "dm"],
      "stickiness": { "perReply": { "window": 300000 } }
    },
    "enabled": true
  }
}
```

This says: only one specific channel in one specific guild plus all DMs are visible/postable; auto-reply on mentions, replies, or DMs; sticky for 5 minutes after replying to a user.

### When the user asks "let me talk to you in this channel"

1. **Read `typeclaw.json`.**
2. **Identify the adapter.** Today this is always `discord-bot`. If `channels["discord-bot"]` is missing, create it: `{ "allow": [], "engagement": { ... defaults ... }, "enabled": true }`.
3. **Get the channel ID from the user.** Discord channel IDs are 17–20 digit numbers. If they only gave a `#channel-name`, ask for the ID — names aren't unique and the schema needs IDs.
4. **Pick the rule shape:**
   - DM: `dm:<channelId>` (or `dm:*` if they want all DMs).
   - Guild channel they fully trust: `guild:<guildId>/<channelId>` is most explicit; `channel:<channelId>` is shorter and equivalent.
   - Whole guild: `guild:<guildId>` — confirm explicitly that they want every channel.
5. **Append to `allow`.** Preserve existing entries.
6. **Write the file back** (pretty-printed, 2-space indent, trailing newline).
7. **Commit** with a message naming the rule and why (`typeclaw-git` skill).
8. **Tell the user the effect:** "Added `<rule>` to `channels.discord-bot.allow`. This is live-reloadable — it takes effect on the next `reload`, no restart needed."

### When the user asks "stop replying in this channel"

Two interpretations — ask if unclear:

- **"Stop everything"** — remove the matching allow rule. The agent loses both inbound visibility and outbound `channel_send` permission for that channel.
- **"Just stop auto-replying"** — leave the allow rule, but adjust `engagement` (set `trigger: []` and/or `stickiness: "off"`). The agent can still see the channel and can still post if you tell it to. Caveat: this approach does NOT silence the agent in a channel that currently has only one human posting — the solo-human fallback (see Engagement) overrides `trigger: []`. In that case the only way to go silent today is to remove the allow rule.

The second is usually what people mean by "be quieter".

### When the user asks "what channels can you see / are you in"

1. **Read `typeclaw.json`**, list each adapter under `channels`: which is enabled, the full `allow` list, the engagement triggers and stickiness window.
2. Note that the live runtime may have a different view if `typeclaw.json` was edited but `reload` hasn't run yet — say so when relevant.

## Alias

`alias` is an array of plain-text names the agent answers to when a channel message contains the name without using the platform's `<@id>` mention syntax. It is independent from `channels.<adapter>.engagement.trigger`: the structural triggers (`mention`, `reply`, `dm`) gate engagement on platform-rendered events; `alias` gates engagement on the message text itself.

The agent folder's directory name (`basename(agentDir)`) is **always** an implicit alias — the runtime adds it automatically. `alias` adds further forms on top: Latin transliteration of a Korean nickname, casual short forms, alternative spellings, etc. **You only need to add the dir-name explicitly when you want a variation of it** (different casing, a different word entirely, or extra forms beyond the dir name).

### Match semantics

- **Substring** match against the inbound text. `"봉봉"` matches `"봉봉아 cron"`, `"봉봉씨 안녕"`, `"누가 봉봉을 불러"`, all of them. Korean particles aren't stripped — substring is enough because the bot name appears at the start of every particled form.
- **Case-insensitive** via `toLocaleLowerCase()` on both sides. `"Bongbong"` in the alias list matches `"BONGBONG"`, `"bongbong"`, `"BongBong"`.
- **No word-boundary detection.** A short or generic alias like `"bot"` will match every message containing `"robot"` or `"bottom"`. Pick distinctive names — the operator owns curation.

### Engagement priority

The alias path runs **after** explicit triggers (mention/reply/dm) and the sticky check. So a message with both an `<@id>` mention and an alias substring engages once, normally. A message with only the alias substring engages on the alias path. The alias path is **NOT suppressed by `mentionsOthers`**: addressing two bots in one message (`"봉봉아 펭펭아 둘 다 봐"`) engages both bots — each on their own alias.

There's also a symmetric **peer-name suppressor**: if the message contains a peer bot's observed display name (from `participants[]`, populated as peers speak in the channel) and **does not** contain any of this agent's aliases, the solo-human fallback is suppressed and the agent observes. This is what makes `"펭펭아 cron 좀"` in a 1-human-multi-bot channel correctly observe instead of all bots replying. First-time addressing of a never-seen peer slips through; the suppressor catches it after the peer's first message.

### Example

```json
{
  "alias": ["bongbong", "봉봉"]
}
```

The agent in folder `봉봉/` already answers to `"봉봉"` from the dir name. This adds the Latin transliteration so users can also write `"Hey bongbong, deploy?"`.

### When the user asks "respond to my casual nickname for you" / "I want to call you X" / "register an alias" / "별칭 등록해줘" / "X라고 불러줘"

This is **always** `typeclaw.json#alias`. Not a Slack profile setting, not a Discord nickname, not a workspace admin task. See **Self-config requests** at the top of this skill — especially the anti-fabrication rule (the field is singular `alias`, top-level, flat `string[]`; not `aliases`, not nested under an adapter, not keyed by user ID) and the write-before-claim rule (no past-tense confirmation until the `write` and commit actually happened).

1. **Read `typeclaw.json` first** with the `read` tool. Do not guess the current shape; the user may have customized it. If `alias` is present, you need to see the existing entries to dedupe.
2. **If `alias` exists**, append the new name(s) (preserve existing entries; dedupe trivially — the runtime also dedupes).
3. **If `alias` is absent**, create it as `["<new name>"]` (or `["<name1>", "<name2>"]` for multiple).
4. **You don't need to add the dir name** unless the new name IS a variation of the dir name itself (e.g. dir is `bongbong` and the user wants `Bongbong` casing — the implicit dir alias matches case-insensitively, so this isn't needed either).
5. **Trim whitespace** before adding. The schema rejects empty/whitespace-only entries; the runtime trims surrounding whitespace from valid entries.
6. **Write the file back** with the `write` tool — pretty-printed (2-space indent), trailing newline, alphabetical field order. The shape is `{ "alias": ["X", "Y"] }` at the top level. **Do not nest under `channels`, do not pluralize to `aliases`, do not key by user ID.** See the negative examples in **Self-config requests**.
7. **Commit** the change (`typeclaw-git` skill).
8. **Only now** tell the user: "Added `<X>`, `<Y>` to `alias` — live-reloadable. Run `reload` to pick up the change without restart." If you skipped step 6 or 7, say so honestly instead of claiming completion.

### When the user asks "stop responding to <name>"

1. **Read `typeclaw.json`.**
2. **Remove the entry** from `alias`. If the entry IS the dir name, removing it from `alias` does nothing — the dir name is implicit and can't be turned off this way. The right answer there is "to stop responding to your dir name, rename the agent folder, which is a host-stage operation outside this container."
3. **Write, commit, reload-required.**

### When the user asks "what names do you respond to"

1. **Read `typeclaw.json`** and report `alias`.
2. **Always also report `basename(agentDir)`** (the implicit dir-name alias) — the user might not realize it's automatic.
3. Mention that channel addressing also engages on `<@id>` mentions and replies regardless of alias config (those are separate triggers in `channels.<adapter>.engagement`).

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
  "model": "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo"
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

The `dockerfile` block has two layers of customization:

1. **Toggles** for opinionated apt packages typeclaw knows how to install with proper layer caching (`tmux`, `gh`, `python`, `ffmpeg`). Boolean for on/off, version string for an apt pin (e.g. `"gh": "2.40.0"` → `gh=2.40.0`). Use these whenever they cover what the user wants — they get BuildKit cache-mount benefits and, for `gh`, automatic keyring layer gating.
2. **`append`** is the escape hatch for everything the toggles don't cover. An array of single-line Dockerfile instructions spliced in right before `ENTRYPOINT`, prefixed with a `# Custom lines from typeclaw.json#dockerfile.append.` comment.

### Fields

| Field    | Required | Type              | Notes                                                                                                                                                                                                                                                                             |
| -------- | -------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tmux`   | no       | boolean \| string | Default `true`. `false` omits tmux from the apt install. String pins the Debian package version (e.g. `"3.3a-3"` → `tmux=3.3a-3`).                                                                                                                                                |
| `gh`     | no       | boolean \| string | Default `true`. `false` omits **both** the `gh` package and the GitHub CLI keyring bootstrap layer (skipping the network roundtrip on cold builds). String pins the version.                                                                                                      |
| `python` | no       | boolean           | Default `true`. Fans out to `python3 python3-pip python3-venv python-is-python3` (the bundle that makes `python` and `pip` resolve correctly inside the container). Boolean-only — no version pin, because Debian's `python3` is a meta-package that doesn't accept a useful pin. |
| `ffmpeg` | no       | boolean \| string | Default `false`. `true` apt-installs ffmpeg (~80 MB of codecs). String pins the version.                                                                                                                                                                                          |
| `append` | no       | array of strings  | Each entry is a single Dockerfile line — schema **rejects** entries containing `\n` or `\r`. Defaults to `[]`. Splice happens just before `ENTRYPOINT`, after `ENV NODE_ENV=production`.                                                                                          |

Toggle version strings reject whitespace and `=` (apt-injection guard) — pass just the version, not `pkg=ver`.

### The single-line constraint (`append` only)

Each entry of `append` must be one Dockerfile instruction's worth of source — a `RUN`, `ENV`, `COPY`, `ARG`, etc. The schema enforces "no embedded newlines" because a multiline string in the JSON would silently break Dockerfile syntax (Dockerfile line continuations require backslashes at end-of-line, and a JSON multiline doesn't carry those). If the user wants a logically multi-step instruction, give them two entries:

```json
"dockerfile": {
  "append": [
    "RUN apt-get update && apt-get install -y --no-install-recommends ripgrep fd-find",
    "ENV CUSTOM_TOOL=1"
  ]
}
```

A single `RUN` with `&&`-chained shell commands is fine and idiomatic — that's still a single Dockerfile line. What's rejected is a literal newline inside the JSON string.

### Where things land in the build

The template's last layers are roughly:

```
RUN apt-get install ... <baseline + enabled toggle packages>   ← toggles fan out into this line
...
ENV NODE_ENV=production
# Custom lines from typeclaw.json#dockerfile.append.   ← only emitted when append is non-empty
<your appended lines>
ENTRYPOINT ["bun", "run", "typeclaw"]
CMD ["run"]
```

The toggle-driven apt install benefits from BuildKit `--mount=type=cache` on `/var/cache/apt` and `/var/lib/apt/lists`, so toggling `ffmpeg: true` (or pinning `gh: "2.40.0"`) only re-fetches what changed. The `gh` keyring bootstrap is in its own earlier layer that's gated on `gh` being enabled — turning `gh: false` saves the network roundtrip even on cold builds.

`append` runs after every cache-friendly base layer (apt setup, the toggle-driven apt install, `agent-browser`, Chrome for Testing on amd64), so changing `append` invalidates only the final layer. Conversely, putting `apt-get install` in `append` is **slower than using a toggle** (no BuildKit cache mount) — and if the package you want is `tmux/gh/python/ffmpeg`, just use the toggle.

### Restart and rebuild semantics

- **Restart-required.** `dockerfile` is in `FIELD_EFFECTS` as restart-required. `reload` reports the change as `restartRequired` and the live container keeps running on the old image.
- **The next `typeclaw start` rebuilds the image automatically.** No `--build` flag is needed; the CLI re-runs `docker build` whenever the Dockerfile content has changed (it rewrites the file from the current template + current `dockerfile` block every start). Tell the user: "Edited `dockerfile` — restart-required. The next `typeclaw start` will rewrite the Dockerfile and rebuild the image."
- **Pre-existing host-side edits to the Dockerfile are clobbered.** If the user manually edited the Dockerfile before, the next `start` overwrites it and (if the working tree was dirty) auto-commits the cleanup. This is by design; don't try to preserve manual edits.

### When the user asks "install <package> in the container" / "add a Dockerfile line"

1. **Read `typeclaw.json`.**
2. **Check if a toggle covers it.** If the package is `tmux`, `gh`, `python`, or `ffmpeg`, prefer the toggle: `"dockerfile": { "ffmpeg": true }`. For a pinned version, pass the version string: `"gh": "2.40.0"`. This is faster (BuildKit cache mount) and clearer than `append`.
3. **Otherwise, use `append`.** Decide on a single-line entry — for apt installs, prefer one `RUN apt-get update && apt-get install -y --no-install-recommends <pkg> && rm -rf /var/lib/apt/lists/*` line. For env vars, one `ENV` line per variable.
4. **Validate no embedded newlines** (`append` only). Multi-step logic must be `&&`-chained on one line, not split across array entries unless those entries are independent Dockerfile instructions.
5. **Append to `dockerfile.append`** (creating the field if it doesn't exist). Preserve existing entries.
6. **Write, commit, restart-required**: "Edited `dockerfile` — restart-required. The next `typeclaw start` will rewrite the Dockerfile and rebuild the image. The new layer will be at the end of the build, so unrelated cache layers stay valid."

### When the user asks "uninstall <package>" / "make the image smaller"

1. **Read `typeclaw.json`.**
2. **If the package is one of the toggles**, set it to `false`: `"dockerfile": { "tmux": false }`. Don't try to remove it via `append` — the toggle is the only way to omit a baseline package from the apt install line.
3. **If it's an `append` entry**, remove that entry from the array.
4. **Write, commit, restart-required.** Same rebuild story.

### When the user asks "show me the Dockerfile" or "what's in the image"

1. **Read `Dockerfile` directly** (it lives at the agent folder root, autogenerated). It's the full materialized template with toggles applied plus any `append` lines.
2. **Don't promise stability.** The template can change between typeclaw releases; the `Dockerfile` you read today may differ after the next `typeclaw start` even with no `typeclaw.json` change.
3. For the abstract template (without per-agent customizations), the source of truth is `src/init/dockerfile.ts` in the typeclaw repo — pointing the user there is fine if they want to understand the layer strategy.

### When the user asks "remove that custom Dockerfile line"

1. **Read `typeclaw.json`.**
2. **Remove the entry from `dockerfile.append`.** If the resulting array is empty AND no toggles are overridden, you may either leave it as `"append": []` or drop the whole `dockerfile` block — both are equivalent. Dropping it keeps the file minimal and matches the scaffold convention.
3. **Write, commit, restart-required.** Same restart story as adding: next `typeclaw start` rebuilds.

## Gitignore

`typeclaw start` rewrites the agent folder's `.gitignore` from a template baked into the typeclaw CLI on **every** invocation, then auto-commits it when the agent folder is a git repo and the file changed. The template protects two categories: truly-ignored paths (`.env`, `node_modules/`, `workspace/`, `mounts/`, `Dockerfile`, `.DS_Store`) and system-managed runtime state (`sessions/`, `memory/`, `channels/`) that TypeClaw, not the agent, commits on its own schedule. Editing `.gitignore` by hand is temporary; the next `typeclaw start` overwrites it.

The `gitignore.append` field is the supported escape hatch for additional local ignore patterns. It is an array of strings, each treated as a single `.gitignore` line. The CLI splices them into the autogenerated `.gitignore` before TypeClaw's protected rules, prefixed with a `# Custom entries from typeclaw.json#gitignore.append.` comment.

### Field

| Field    | Required | Type             | Notes                                                                                                                                                                                                                           |
| -------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `append` | yes      | array of strings | Each entry is a single `.gitignore` line — schema **rejects** entries containing `\n` or `\r`. Defaults to `[]`. Splice happens before TypeClaw-owned ignore rules so custom negation patterns cannot unignore protected paths. |

### Ordering and protected paths

`.gitignore` is order-sensitive: later `!` negation rules can unignore earlier ignore rules. TypeClaw therefore renders `gitignore.append` **before** its own truly-ignored and system-managed entries, so even a custom `!sessions/` or `!.env` cannot override TypeClaw's protections. Custom ordinary ignore patterns still work because they add additional ignores; they just do not get the final word over TypeClaw-owned paths.

Materialized shape when `append` is non-empty:

```gitignore
# Custom entries from typeclaw.json#gitignore.append.
scratch/
*.local.log

# Truly ignored: ...
.env
Dockerfile

# System-managed: ...
sessions/
memory/
channels/
```

### Restart semantics

- **Restart-required.** `gitignore` is in `FIELD_EFFECTS` as restart-required. `reload` reports the change as `restartRequired`; the already-materialized `.gitignore` on disk remains unchanged until the next host-stage start.
- **The next `typeclaw start` refreshes and auto-commits `.gitignore`.** Tell the user: "Edited `gitignore.append` — restart-required. The next `typeclaw start` will rewrite `.gitignore` and TypeClaw will auto-commit it if the file changes."

### When the user asks "ignore this path" / "add a gitignore entry"

1. **Read `typeclaw.json`.**
2. **Decide on single-line patterns.** Use one array entry per `.gitignore` pattern. Do not embed newlines.
3. **Append to `gitignore.append`** (creating the field if it doesn't exist). Preserve existing entries.
4. **Do not edit `.gitignore` directly.** It is managed and will be overwritten on `typeclaw start`.
5. **Write, commit, restart-required**: "Edited `gitignore.append` — restart-required. The next `typeclaw start` will rewrite and auto-commit `.gitignore`."

### When the user asks "remove that custom ignore entry"

1. **Read `typeclaw.json`.**
2. **Remove the entry from `gitignore.append`.** If the resulting array is empty, you may either leave it as `"append": []` or drop the whole `gitignore` block — both are equivalent. Dropping it keeps the file minimal and matches the scaffold convention.
3. **Write, commit, restart-required.** Same refresh story as adding: next `typeclaw start` rewrites and auto-commits `.gitignore` if content changed.

## Plugin config blocks

Top-level keys in `typeclaw.json` that are **not** in the well-known ten (`$schema`, `port`, `model`, `mounts`, `plugins`, `alias`, `channels`, `portForward`, `dockerfile`, `gitignore`) are treated as plugin config blocks. The schema preserves them via `catchall(z.unknown())`, and `extractPluginConfigs` hands each block to the owning plugin's `configSchema` for validation at boot.

This skill does **not** document individual plugin blocks. For schema, defaults, and reload semantics of a specific plugin's config, defer to that plugin's own skill:

- `memory` (idle/dreaming subagent settings) → `typeclaw-memory` skill.
- Plugin authoring patterns (name derivation, config-block keying, `restart-required` semantics for plugin code and per-plugin config) → `typeclaw-plugins` skill.

Three rules apply to every plugin block, regardless of which plugin owns it:

1. **The block key is the plugin's derived name** (scope-stripped, `typeclaw-plugin-` prefix stripped). Getting the key wrong means the plugin sees an empty config and silently uses defaults.
2. **The plugin reads its config once at factory time**, so plugin block edits are effectively `restart-required` even though core's `FIELD_EFFECTS` table doesn't classify them — the well-known ten are the only entries `reloadConfig` diffs against.
3. **Inventing a plugin block for a plugin that isn't loaded is silent.** `extractPluginConfigs` will preserve it across reloads; the runtime will never validate it; nothing happens.

Do **not** invent plugin blocks; their existence is determined by the plugins listed in `plugins[]` (plus bundled plugins like `memory`), not by the user or by you.

## Allowed models

Today, the model registry contains exactly **one** entry:

| `model` value                                          | Display name    | Provider  | Notes                                                                  |
| ------------------------------------------------------ | --------------- | --------- | ---------------------------------------------------------------------- |
| `fireworks/accounts/fireworks/routers/kimi-k2p5-turbo` | Kimi K2.5 Turbo | Fireworks | Requires `FIREWORKS_API_KEY` in `.env`. Reasoning model, 256K context. |

**Do not write any other value into `model`.** The schema enum will reject the file at load, and the runtime will refuse to boot the agent process. If the user names a model that isn't in this table — "switch me to GPT-5", "use Claude" — be honest:

> "Right now my registry only has Kimi K2.5 Turbo on Fireworks. More providers are planned but not wired up yet. If you want a different model, that needs a typeclaw release, not a config edit."

Do **not** edit `typeclaw.json` to a model the registry doesn't know, even if the user insists. That bricks the agent on next restart.

## Provider credentials

`typeclaw.json` does **not** hold API keys. Credentials live in `./.env` (gitignored). For the only currently-supported model:

- `FIREWORKS_API_KEY` — required for any `fireworks/...` model.

If the user wants to rotate or change the key, edit `.env`, not `typeclaw.json`. After editing `.env`, the same restart rule applies: `typeclaw restart` on the host stage.

Never echo, log, or commit values from `.env`. `.env` is gitignored by default — keep it that way.

## Editing `typeclaw.json` safely

`typeclaw.json` is a single canonical file at the agent folder root. It is committed to git (not gitignored). Treat it like a config file you own.

### Workflow

1. **Read the whole file first** with the `read` tool. Don't assume what's in it — the user may have customized it.
2. **Modify in memory.** Change only the field(s) the user asked about. Leave `$schema` alone.
3. **Write the whole file back** with the `write` tool. Always pretty-printed (2-space indent), trailing newline, fields in stable order: `$schema` first, then alphabetical for the rest (`alias`, `channels`, `dockerfile`, `gitignore`, `model`, `mounts`, `plugins`, `port`, `portForward`, then any plugin config blocks like `memory`).
4. **Validate before declaring done.** A malformed `typeclaw.json` will refuse to boot the agent on next restart, and a malformed reload-time edit will be rejected by `reload`. Sanity-check your JSON manually or with `bash` (`cat typeclaw.json | jq .`) before considering the edit done.
5. **Commit the change.** See the `typeclaw-git` skill for the commit-message rule (decision context required). `typeclaw.json` is not gitignored, so an uncommitted edit will pollute your next commit.
6. **Tell the user the right next step.** Match the field's effect class:
   - `model`, `alias`, `channels` → "Live-reloadable, takes effect on the next `reload`."
   - `port`, `mounts`, `plugins`, `portForward` → "Restart-required. Run `typeclaw restart` (host stage) to pick up the change."
   - `dockerfile` → "Restart-required, and the next `typeclaw start` will rebuild the image automatically (no `--build` flag needed)."
   - `gitignore` → "Restart-required, and the next `typeclaw start` will rewrite and auto-commit `.gitignore` if content changed."
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
- If `channels.discord-bot.allow` is set: every entry matches one of the **Allow rules** patterns above (numeric IDs only)
- If `channels.discord-bot.engagement.trigger` is set: array of `"mention"`, `"reply"`, `"dm"` (any subset, including empty)
- If `channels.discord-bot.engagement.stickiness` is set: either the literal `"off"` or `{ "perReply": { "window": <int 1..86400000> } }`
- If `portForward` is set: `allow` is either `"*"` or an array of integers (1–65535); `deny`, if present, is an array of integers and **only valid when `allow` is `"*"`** (the schema rejects `deny` paired with a number-array `allow`)
- If `dockerfile.append` is set: array of strings, each with no embedded `\n` or `\r` (multi-step shell logic goes in a single `&&`-chained `RUN` entry)
- If any `dockerfile` toggle is set: `tmux`/`gh`/`ffmpeg` are boolean or version string (no whitespace, no `=`); `python` is boolean only
- No unknown top-level keys you invented — keys outside the well-known ten are interpreted as **plugin config blocks** and only do something if a plugin owns them. Inventing one means the user thinks it took effect and it did not.

## Things you must not do

- **Do not invent fields the schema doesn't support** (no `provider`, `apiKey`, `temperature`, `maxTokens`, `systemPrompt`, `tools`, `timeout`, `retry`, etc.). They will be silently dropped or, worse, mistaken for a plugin config block. Lying to the user that "I added a temperature field" when the runtime ignores it is a worse failure than refusing.
- **Do not invent the shape of an existing field.** The `alias` field in particular has a single correct shape — top-level, singular `alias`, flat array of strings. Plural `aliases`, nesting under `channels.<adapter>`, keying by user ID, or rendering it as YAML are all wrong; the runtime ignores them and the user gets a silent failure. If you are not sure of a field's shape, **read `typeclaw.json` first** and consult the schema table above.
- **Do not deflect a self-config request to platform settings.** When the user asks you to register an alias, change your nickname, or otherwise change a fact about yourself, the answer is `typeclaw.json` in the agent folder — not the Slack profile display name, not the Discord server nickname, not the OS keychain, not the workspace admin. See **Self-config requests** at the top of this skill.
- **Do not say "registered" / "등록 완료" / "added" / "saved" / "done" before the `write` and commit actually ran.** Showing the user a code block of "what you would write" is not writing. If the edit didn't happen this turn, say so honestly.
- **Do not move secrets into `typeclaw.json`.** It is committed to git. API keys belong in `.env`.
- **Do not change `port` casually.** The host-stage `typeclaw start` launcher publishes a port mapping it learned at `start` time. Changing the port in `typeclaw.json` without re-running `typeclaw start` (which re-reads it) means the TUI will connect to the wrong port and silently fail. If you change `port`, tell the user explicitly that the next `typeclaw start` will pick the new mapping.
- **Do not change `model` to something not in the registry.** The schema enum will reject the file at load, and the runtime will refuse to boot the agent process. If the user wants a model that isn't there, this is a typeclaw-side change, not a config edit.
- **Do not edit `typeclaw.json` from inside an `exec` cron job's `command`.** That mutates the file behind the runtime's back. Live-reloadable fields still won't update until something triggers a `reload`, and restart-required fields are guaranteed wrong.
- **Do not delete `$schema`.** It powers editor autocompletion for the user. Leaving it in costs nothing.
- **Do not re-add `"mounts": []` "for clarity" if the user has none.** The scaffold deliberately omits it; defaults live in `configSchema`. Re-emitting it adds maintenance noise (the user has to keep two sources of truth in sync) without changing behavior.
- **Do not promise to write to a `readOnly: true` mount.** Docker enforces it via `:ro`; writes will fail with EROFS. If the user wants you to edit a read-only mount, the fix is to flip `readOnly` to `false` in `typeclaw.json` and restart, not to retry the write.
- **Do not invent mount entries the user did not request.** Mounts expose host paths to your container; adding them silently is a security surprise.
- **Do not add channel allow rules the user did not request, especially `*` or `guild:*`.** Allow rules grant the agent visibility (and, for outbound, posting permission) on real Discord channels with real people in them. Widening the allow list silently is the same class of security surprise as adding a mount.
- **Do not promise the user that an allow-rule edit took effect immediately just because you wrote the file.** Live-reloadable means "applied on the next `reload`", not "applied the instant the file changes". Until `reload` runs (or the container restarts), the runtime is still using the old `channels` config.
- **Do not promise to post to a channel that isn't in `allow`.** `channel_send` will refuse with `{ ok: false, error }` regardless of what you tell the user. If they want you to post somewhere new, the prerequisite is an allow-rule edit, not a retry.
- **Do not conflate "stop replying" with "remove allow rule".** Removing the allow rule cuts off both inbound visibility and outbound posting. If the user just wants quieter behavior, edit `engagement` instead.
- **Do not edit the `Dockerfile` directly.** It is autogenerated and rewritten on every `typeclaw start` from `src/init/dockerfile.ts` in the typeclaw repo. Manual edits will be silently overwritten (and auto-committed away if the working tree is dirty). Customizations belong in the `dockerfile` block (toggles or `append`).
- **Do not reach for `dockerfile.append` when a toggle covers it.** If the user wants tmux, gh, python, or ffmpeg installed (or removed, or pinned), use the toggle — it's the cache-mounted path. `append` for these is slower and harder to read.
- **Do not use `dockerfile.append` for things that belong in the template.** If the user wants a system package _every_ typeclaw user should have, that's a typeclaw release, not a per-agent `append`. Suggest filing an issue.
- **Do not put multiline strings in `dockerfile.append`.** The schema rejects entries with embedded `\n`/`\r`. Use one entry per Dockerfile instruction; chain shell logic with `&&` on one line.
- **Do not pass `pkg=ver` as a toggle version string.** The schema rejects `=` in version strings. Pass just the version (`"gh": "2.40.0"`); the renderer prepends `pkg=` itself. Same for whitespace — version strings cannot contain spaces.
- **Do not list `8973` (or whatever `port` is set to) in `portForward.allow`/`deny`.** That port is owned by `docker run -p`; the broker quietly excludes it regardless. Listing it is misleading.
- **Do not combine `portForward.deny` with a number-array `allow`.** The schema rejects this; the deny rule would have no effect even if the schema allowed it. `deny` is only meaningful with `allow: "*"`.
- **Do not promise "live forwarding will start the moment you set `portForward`".** `portForward` is restart-required; the broker captures the policy at register time. Until the next `typeclaw start`, the live broker keeps the old policy.

## When the user says "what model are you running"

1. **Read `typeclaw.json`.** Don't guess from prior conversation — the user may have changed it since you last looked.
2. Report the `model` field verbatim, plus the human-readable name from the **Allowed models** table.
3. If `model` is missing from the file, say so and report the default (`fireworks/accounts/fireworks/routers/kimi-k2p5-turbo` → Kimi K2.5 Turbo).

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
- **The Dockerfile template itself** (the autogenerated layers in `Dockerfile`: bun base image, apt setup, GitHub CLI, `agent-browser`, Chrome for Testing) — that is host-stage, controlled by `src/init/dockerfile.ts` in the typeclaw repo, not by `typeclaw.json`. `typeclaw.json#dockerfile.append` (covered above) is the only piece of the build customizable per-agent; everything else requires a typeclaw release.
- **The host-stage launcher's invocation flags** (`docker run` arguments synthesized by `typeclaw start`, the `_hostd` daemon's lifecycle, the host port allocation that maps to `port` inside the container) — those are host-stage code, not config. The pieces of that flow that **are** user-configurable through `typeclaw.json` (`port`, `mounts`, `portForward`) are documented above; the rest is not.
