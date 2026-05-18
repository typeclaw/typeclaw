# TypeClaw

> A TypeScript-native, Bun-powered, Docker-friendly general-purpose agent runtime.

## Why?

There are great agents out there. None of them were quite the shape I wanted:

- **OpenClaw** — feature-rich, but heavy
- **NanoClaw** — simple, but no plugin system
- **PicoClaw** — fast, but Go (so plugins live outside the runtime)
- **ZeroClaw** — light, but Rust (same problem, different ecosystem)
- **Hermes Agent** — awesome, but Python

None of that matters to most people. It matters to me. If you're like me, TypeClaw is the right choice.

TypeClaw is the agent I wanted to use:

- **TypeScript end to end** — agent core, plugins, channel adapters, CLI, TUI all in one language
- **Bun-native plugins** — plugins are just TS modules; no IPC, no FFI, hot-reloadable config
- **Docker-friendly by default** — every agent runs in its own container; the host CLI is purely a launcher
- **Multi-channel out of the box** — Slack, Discord, TUI, websocket — all routed through one in-process stream
- **Self-improving** — the agent observes its own work, distills it into long-term memory and reusable skills, and gets sharper over time without you writing prompts for it

## Features

- 🐳 **Sandboxed by default** — every agent runs in its own Docker container, with an `.env` and bind-mounted host folders
- 🔌 **Plugin system** — plain TypeScript modules contribute tools, skills, subagents, channels, and typed config
- 💬 **Multi-channel** — Slack, Discord, and a websocket TUI out of the box; one agent, many inboxes
- 👥 **Group chat awareness** — knows who's in the room, distinguishes humans from bots, and stays engaged after a reply without re-mentioning
- ⏰ **Cron** — schedule prompts or shell commands; prompts can pipe a shell command's output into the LLM (`exec → llm`); per-job coalescing so slow jobs don't pile up
- 📚 **Skills on demand** — markdown procedures the agent loads only when relevant; zero token cost until used
- 🌱 **Self-improving** — bundled memory plugin observes the agent's work and consolidates it into long-term memory (see below)
- 🧠 **Muscle memory** — repeated procedures get distilled into reusable skills that the agent writes for itself
- 🔄 **Hot reload** — change `typeclaw.json`, `typeclaw reload` — no restart for most fields
- 🔁 **Self-restart** — the agent can bounce its own container when it updates itself
- 🌐 **Auto port-forward** — dev servers inside the container appear on `localhost`, even loopback-only ones
- 🎼 **Compose** — orchestrate multiple agents across multiple folders

### 🌱 Self-improving, in detail

The bundled `memory` plugin turns lived experience into reusable knowledge. No manual prompt engineering. No curated example library.

1. **Observe.** After every idle turn, a `memory-logger` subagent reads the transcript and appends notable fragments to `memory/yyyy-MM-dd.md`. Cheap, frequent, lossy by design.
2. **Dream.** On a cron schedule (default 4am), a `dreaming` subagent consolidates daily streams into `MEMORY.md`, and — when it spots a procedure worth remembering — writes it as **muscle memory**: a new skill at `memory/skills/<name>/SKILL.md`.
3. **Apply.** Tomorrow's prompt sees the updated `MEMORY.md`. Muscle-memory skills sit alongside bundled and user-installed ones, loaded on demand. Every dream is committed with a one-line summary — e.g. `dream: 3 fragments + new skill 'pr-review' 🔮` — so growth is auditable.

See [`src/bundled-plugins/memory/README.md`](./src/bundled-plugins/memory/README.md) for the full contract.

## Install

```sh
bun add -g typeclaw
```

Requires Bun ≥ 1.1 and Docker (or OrbStack) on the host.

## Quickstart

```sh
mkdir my-agent && cd my-agent
typeclaw init        # scaffold typeclaw.json, .env, Dockerfile, package.json
typeclaw start       # build + run the container
typeclaw tui         # attach a terminal UI to the running agent
```

That's it. The agent is now alive, listening on a websocket, ready to receive prompts from the TUI or any wired channel.

## CLI

| Command                             | Purpose                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| `typeclaw init`                     | Scaffold a new agent folder                                                        |
| `typeclaw start`                    | Build and run the container                                                        |
| `typeclaw stop`                     | Stop the container                                                                 |
| `typeclaw restart`                  | `stop` then `start`                                                                |
| `typeclaw status`                   | Show container + daemon registration state                                         |
| `typeclaw logs`                     | Stream container stdout/stderr with local timestamps; `-f` to follow               |
| `typeclaw tui`                      | Attach a terminal UI over the agent's websocket                                    |
| `typeclaw shell`                    | Open a shell inside the running container                                          |
| `typeclaw reload`                   | Push a live config reload to the running agent                                     |
| `typeclaw compose`                  | Orchestrate multiple agents                                                        |
| `typeclaw channel add <kind>`       | Wire a new channel adapter (Slack, Discord, Telegram, KakaoTalk)                   |
| `typeclaw channel reauth kakaotalk` | Re-authenticate KakaoTalk after a stale-token 401 or to rotate the stored password |

## Configuration

Agent folder layout after `init`:

```
my-agent/
├── typeclaw.json     # main config (schema-validated)
├── cron.json         # scheduled jobs (optional)
├── .env              # secrets, injected via --env-file
├── Dockerfile        # auto-managed by typeclaw, refreshed every `start`
├── package.json      # `typeclaw` as a dependency
├── .gitignore        # auto-managed
├── workspace/        # agent's free-write zone (gitignored)
├── sessions/         # JSONL session logs (gitignored, force-committed by auto-backup)
└── memory/           # MEMORY.md + muscle-memory skills (gitignored, force-committed by dreaming)
```

`typeclaw.json` is JSON Schema–validated (see `typeclaw.schema.json`). Highlights:

- `port` — preferred host port (CLI falls back to ephemeral on conflict)
- `mounts` — host directories to expose inside the container
- `plugins` — list of plugin module specifiers
- `channels` — `slack-bot` / `discord-bot` config
- `portForward` — allow/deny list for auto port forwarding (default: `*`)
- `dockerfile` — toggles for `gh`, `python`, `tmux`, `ffmpeg`, plus `append` lines
- `memory` — idle window and dreaming schedule for the memory plugin

`Dockerfile` and `.gitignore` are owned by TypeClaw and rewritten on every `start` — edit `src/init/dockerfile.ts` and re-run `start --build` to ship template changes.

### Secrets

Credentials live in two gitignored files: `.env` (plain `KEY=value` lines, injected into the container via `--env-file`) and `secrets.json` (a structured store managed by TypeClaw). **Env-wins**: when a credential's canonical env var (e.g. `FIREWORKS_API_KEY`, `SLACK_BOT_TOKEN`) is set, that value is used at runtime — `secrets.json` is never auto-mutated to capture it. Every secret-bearing field in `secrets.json` is a `Secret` (`string | { value?, env? }`), so the file can rebind a credential to a custom env-var name on demand. See [AGENTS.md § Secrets](./AGENTS.md#secrets) for the full contract.

## Development

```sh
git clone https://github.com/typeclaw/typeclaw
cd typeclaw
bun install
bun test
```

Pre-commit checks (must all pass — no exceptions):

```sh
bun run typecheck
bun run lint
bun run format
```

See [AGENTS.md](./AGENTS.md) for the long-form architecture notes — stages, hostd internals, message stream, plugin contracts, and the testing philosophy.

## License

MIT
