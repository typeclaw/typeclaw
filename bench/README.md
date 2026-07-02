# bench

Local benchmarks for measuring **typeclaw's** intelligence — the agent (harness + memory + tools), not the underlying model. Self-contained sibling project: its own `package.json` and `tsconfig.json`, excluded from the root typecheck and the published package (same isolation as `docs/`).

Design + rationale: [issue #1128](https://github.com/typeclaw/typeclaw/issues/1128).

## Host footprint

Docker + Bun only — both already required by typeclaw. All Python lives inside the bench container; datasets and cloned suites stay in gitignored dirs, never `$HOME`. Teardown: `docker compose down` + `rm -rf datasets suites`.

## `coding/` — Seam A: drive the running agent over its TUI websocket

Benchmarks the **whole real agent** by connecting to `typeclaw tui`'s websocket exactly as the TUI does — send a task prompt, read the event stream to `{ type: 'done' }`. No server changes, no harness reconstruction. Comparable to Hermes / opencode / Goose / Claude Code on the same tasks.

### Run against a live agent

Start a typeclaw agent (so its container is up), then:

```sh
bun install
bun run coding/run.ts --container <container-name> --prompt "Fix the failing test in foo.ts"
```

The runner discovers the host port (`docker port <c> 8973/tcp`) and TUI token (`docker inspect` label) itself, connects, and prints the agent's text, tool calls, and token/cost usage as JSON.

### Test

```sh
bun test          # adapter contract: connect → prompt → done, against a real ws server
bun run typecheck
bun run lint
bun run format
```

## Layout

```
bench/
├── coding/
│   ├── client.ts             # connect → prompt → collect → first done
│   ├── docker-discovery.ts   # host port + TUI token from docker
│   ├── protocol.ts           # local mirror of the TUI wire subset
│   ├── run.ts                # CLI entry
│   └── *.test.ts
├── Dockerfile                # oven/bun:1-slim + in-image python venv
├── compose.yml
├── datasets/                 # gitignored — downloaded task sets
├── suites/                   # gitignored — third-party suites, pinned commits
└── results/                  # tracked — the scores
```

## Roadmap

- **`coding/`** _(this slice)_ — websocket adapter, done. Next: wire Terminal-Bench-2 tasks + programmatic verifier via Harbor.
- **`memory/`** — LongMemEval / LoCoMo with dreaming ON vs OFF. Answerer = Fireworks; judge = OpenAI (separate family).
- **`ablation/`** _(optional)_ — bare pi + one typeclaw component toggled, for per-component deltas.
