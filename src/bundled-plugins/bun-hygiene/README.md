# typeclaw-plugin-bun-hygiene

The bundled bun-hygiene policy contributes three runtime-internal guards for `bash` commands:

1. **Global package installs** — `npm install -g`, `pnpm add -g`, `yarn global add`, `bun add -g`, and their `--global` / bundled-flag variants.
2. **Non-bun install managers** — any `npm`, `pnpm`, or `yarn` invocation.
3. **Non-bun package runners** — `npx` or `pnpx` at a command boundary. Use `bunx` for one-off package binaries; the runner guard remains separately bypassable for genuine exceptions.

This plugin is **auto-loaded** by every TypeClaw agent. There is no `plugins[]` entry to add. All three guards carry an `acknowledgeGuards` escape hatch (below) for the cases where the agent genuinely needs the blocked command.

## Why it exists

**Global installs don't persist.** The agent folder is bind-mounted at `/agent`; everything else in the container — including `~/.bun`, `~/.npm`, and the global `node_modules` a global install writes to — is ephemeral and wiped on every `typeclaw restart`. An agent that runs `npm install -g some-cli` gets a tool that works for the rest of the session and silently vanishes on the next boot, leading to confusing "command not found" failures that look like regressions. The fix is to either add the dependency to `package.json` (`bun add <pkg>`, which lives in the bind-mounted folder and survives) or run it once without installing (`bunx <pkg>`).

**The container standardizes on bun for package execution.** TypeClaw is Bun-native end to end (see the root README). Mixing in `npm`/`pnpm`/`yarn` installs produces competing lockfiles and install trees, so those are steered to bun. For one-off package binaries, `bunx` is the Bun-native equivalent and the only package runner the default image ships: the `oven/bun` slim base provides `bun`, the `bunx` symlink, and a `node` fallback shim, but no `npm`, `npx`, `pnpm`, or `pnpx`. Reaching for one of those either fails outright or, in a custom image that supplies them, runs with npm/pnpm semantics rather than bun's — so the guard steers them to `bunx` instead of treating them as equivalent spellings.

All three guards **block with guidance** rather than silently rewriting the command — the agent sees exactly why the command was rejected and what to run instead, the same UX as the bundled `security` and `guard` policies.

## Guards

| Guard                  | Triggers on                                                                                       | Guidance in the block reason                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `globalInstall`        | `npm`/`pnpm` install/add with `-g`/`--global`, `yarn global add`, `bun add -g` / `bun install -g` | Use `bun add <pkg>` (persists) or `bunx <pkg>` (ephemeral run). |
| `nonBunPackageManager` | `npm`, `pnpm`, `yarn` at a command boundary                                                       | Use `bun install` / `bun add <pkg>`; use `bunx` for one-offs.   |
| `nonBunPackageRunner`  | `npx`, `pnpx` at a command boundary                                                               | Use `bunx <pkg>` for one-off package binaries.                  |

A global install (e.g. `npm install -g x`) trips **only** `globalInstall`, not both — the global install is the more specific violation, so acknowledging `globalInstall` lets that install through without a second acknowledgement for `nonBunPackageManager`. That subsumption is scoped to the segment the global install appears in: in `bun add -g foo && npx tsc`, acknowledging `globalInstall` still leaves the `npx` segment blocked on `nonBunPackageRunner`.

## Bypass

All three guards follow the plugin-nested `acknowledgeGuards` convention. To run a blocked command intentionally, pass the matching flag in the `bash` tool arguments:

```jsonc
// bash tool args
{ "command": "npm install", "acknowledgeGuards": { "bun-hygiene": { "nonBunPackageManager": true } } }
{ "command": "npm install -g some-cli", "acknowledgeGuards": { "bun-hygiene": { "globalInstall": true } } }
{ "command": "npx tsc", "acknowledgeGuards": { "bun-hygiene": { "nonBunPackageRunner": true } } }
```

## How it works

`checkBunHygieneGuard` in `policy.ts` does not regex the raw command. It runs a small single-pass tokenizer (`splitSegments`) that turns the command into a list of **segments**, each a list of **words**:

- Segments break on real command separators — `;`, `&&`, `||`, `|`, `&`, newline, `\r` — and on subshell / command-substitution openers (`(`, `$(`, backtick), **including `$(`/backtick inside double quotes** (Bash executes those, e.g. `echo "$(npm install -g x)"`; the outer double-quote mode resumes when the substitution closes so a trailing command isn't swallowed). Single-quoted bodies stay literal, matching Bash.
- The tokenizer is quote-aware (a separator inside `"..."`/`'...'` is literal) and escape-aware (`\x` is a literal `x`, so `\npm` resolves to `npm` and `\;` is not a separator). A `\<newline>` is a POSIX line continuation — it is removed and the surrounding text joined, so `npm install \⏎-g x` is one command (a global install), while a bare newline separates commands.

For each segment, the guard strips leading **preamble wrappers** (`sudo`, `env`, `command`, `exec`, `nice`, `nohup`, `stdbuf`, `setsid`, `time`, `xargs`, and any `VAR=val` assignment) — including their options, and the argument a flag consumes (`sudo -u nobody`, `nice -n 10`, `env -i`) — to find the real command word, then classifies:

1. command word is `npm`/`pnpm`/`yarn` (or `bun`) **and** the segment has an install subcommand **and** a global flag → `globalInstall` (for `yarn`, the `global add` sequence must appear adjacent and in command position, so `yarn add global foo` — a local install of a package named `global` — is not misflagged);
2. command word is a non-bun install manager `npm`/`pnpm`/`yarn` (not via global) → `nonBunPackageManager`;
3. command word is a non-bun package runner `npx`/`pnpx` → `nonBunPackageRunner`;
4. otherwise (including `bunx` and `bun x`) → allowed.

Every segment is classified and the verdicts are returned in precedence order — `globalInstall`, then `nonBunPackageManager`, then `nonBunPackageRunner` — with the guard blocking on the first one that is not acknowledged. A global install suppresses the manager verdict for **its own segment only**, so acknowledging one verdict surfaces the next rather than clearing violations elsewhere in the command. This is a command-position detector, not a full shell parser — it doesn't interpret redirections or expansions beyond boundary marking — but it is linear-time and closes the structural gaps a single regex left open.

## Scope: not a security boundary

This guard is a **hygiene nudge**, not an isolation mechanism. It deliberately does not chase manager or runner invocations hidden inside a wrapper's code payload — `sh -c 'npm install'`, `bash -lc "pnpm add foo"`, `python -c '...os.system("npx tsc")'`, `node -e`, `eval`, `base64 | sh`, etc. That set is unbounded (any interpreter can reach any binary), and inspecting arbitrary `-c`/`-e` payloads is an arms race with diminishing returns and rising false-positive risk. An agent that genuinely needs another package command can still reach one through the acknowledgement escape hatch; the guard's job is to steer common, direct invocations toward bun and to stop accidental global installs. The real isolation boundary is the per-tool **bwrap sandbox** (see `/docs/internals/sandbox`), not this policy. Optioned preamble _wrappers_ (`env -i`, `sudo -u`, `nice -n`) are handled because they prefix a real command word that the tokenizer can still see; code-payload wrappers are not, by design.

## Why a tokenizer, not a regex

The earlier implementation matched boundary-anchored regexes against an escape/quote-normalized copy of the command. Review surfaced three structural gaps that are awkward to close with one regex but fall out naturally from the segment model:

- **Escaped / quoted command words.** `\npm install`, `"npm" install`, `'npm' install`, `n\px …` all run the real binary; the tokenizer collapses escapes and quotes at the word level, so each resolves to its bare command word.
- **Leading assignments.** `FOO=bar npm install` runs npm with `FOO` set. Stripping `VAR=val` (and `sudo`/`env`/`command`/`exec`/`nice`) preamble words finds the manager behind them.
- **Newline = separate command.** `npm install\n-g typescript` is two commands; the `-g` does not make the install global. Per-segment scoping means a flag in one segment never combines with an install in another, so this classifies as `nonBunPackageManager` (the `npm install` line), not `globalInstall`.

It also recognizes an explicit falsy global flag (`--global=false|0|no|off`) as **not** a global install, and detects managers inside subshells / command substitutions.

## Option placement in global installs

Because classification scans a segment's words as a set (after preamble stripping), options may sit anywhere relative to the subcommand and the global flag, in either order: `npm --prefix /tmp install -g x`, `npm install --foo bar -g x`, `npm -g install x`, `pnpm add --reporter silent -g foo`, and `bun --cwd /x add -g foo` all attribute to `globalInstall`.

## What is NOT blocked

- `bun`, `bunx`, `bun run`, `bun add`, `bun install` (local) — the intended package commands. (`bun add -g` / `bun install -g` are still blocked as global installs: bun globals live in `~/.bun`, outside `/agent`, and are wiped on restart.)
- A non-bun manager or runner name appearing as a substring or argument: `my-npm-wrapper`, `./npm`, `cat npm-debug.log`, `git commit -m "drop npm"`, `grep -rn npx src/`, `echo "npm install -g foo"`. Only the **command word** of a segment is classified, so a package command name inside an argument, path, quoted string, or longer token never trips the guard.

## Ordering against other bundled plugins

Registered after `guard` in `src/run/bundled-plugins.ts`. It guards a disjoint surface (package-manager bash commands), so its position only matters for precedence: keeping it after `security` and `guard` means any of their blocks wins first.

## Tests

- `policy.test.ts` — pure-function unit tests for the detection logic: every global-install form, every non-bun install manager, `npx`/`pnpx` runner blocking (including behind preamble wrappers), the allowed-command set (`bunx`, `bun x`, substrings, paths, quoted text), all bypasses, guard precedence, escaped/quoted evasions, leading-assignment preambles, newline-as-separator scoping, falsy `--global=`, option placement, and subshell/substitution detection.
- `index.test.ts` — composition tests: the plugin registers guards and wires them to the policy (block on global install, `npm install`, and `npx`; allow `bunx`; honor the bypass).
